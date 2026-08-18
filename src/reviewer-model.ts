import path from 'node:path'
import { appendJsonl, redactUntrusted, writeJson } from './common.js'

export interface ReviewDecision {
  decision: 'approve' | 'reject'
  reason: string
}

interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ReviewerState {
  history: ConversationMessage[]
}

interface ResponsesBody {
  id?: string
  model?: string
  status?: string
  output?: Array<{
    type?: string
    summary?: Array<{ type?: string; text?: string }>
    content?: Array<{ type?: string; text?: string }>
  }>
  usage?: unknown
  error?: { type?: string; code?: string; message?: string }
}

function outputText(body: ResponsesBody): string {
  return (body.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === 'output_text' && typeof item.text === 'string')
    .map((item) => item.text as string)
    .join('\n')
}

function reasoningSummaries(body: ResponsesBody): string[] {
  return (body.output ?? [])
    .filter((item) => item.type === 'reasoning')
    .flatMap((item) => item.summary ?? [])
    .map((item) => item.text)
    .filter((item): item is string => Boolean(item))
}

export async function reviewWithNvidia(
  runDir: string,
  state: ReviewerState,
  baseInstructions: string,
  prompt: string,
  decisionNumber: number,
  timeoutMs: number,
): Promise<ReviewDecision> {
  const apiKey = process.env.LAB_NVIDIA_API_KEY
  if (!apiKey) throw new Error('LAB_NVIDIA_API_KEY is required for the reviewer')
  const model = process.env.LAB_MODEL ?? 'openai/openai/gpt-5.6-sol'
  const reasoning = process.env.LAB_REASONING ?? 'high'
  const url = process.env.NVIDIA_RESPONSES_URL ?? 'https://inference-api.nvidia.com/v1/responses'
  const request = {
    model,
    input: [
      { role: 'developer', content: baseInstructions },
      ...state.history,
      { role: 'user', content: prompt },
    ],
    reasoning: { effort: reasoning, summary: 'detailed' },
    text: {
      format: {
        type: 'json_schema',
        name: 'review_decision',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['decision', 'reason'],
          properties: {
            decision: { type: 'string', enum: ['approve', 'reject'] },
            reason: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    max_output_tokens: 2048,
  }

  await appendJsonl(path.join(runDir, 'reviewer-process.jsonl'), {
    event: 'review_started',
    decisionNumber,
    model,
    reasoning,
    priorMessages: state.history.length,
  })
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
  })
  const body = (await response.json().catch(() => ({}))) as ResponsesBody
  await writeJson(path.join(runDir, `reviewer-${String(decisionNumber).padStart(3, '0')}.response.json`), redactUntrusted(body))
  if (!response.ok) {
    throw new Error(`NVIDIA Responses HTTP ${response.status}: ${body.error?.message ?? 'unknown error'}`)
  }

  const text = outputText(body)
  const parsed = JSON.parse(text) as Partial<ReviewDecision>
  if ((parsed.decision !== 'approve' && parsed.decision !== 'reject') || typeof parsed.reason !== 'string' || !parsed.reason) {
    throw new Error(`invalid reviewer decision: ${text}`)
  }
  const decision = { decision: parsed.decision, reason: parsed.reason }
  state.history.push({ role: 'user', content: prompt }, { role: 'assistant', content: JSON.stringify(decision) })
  await appendJsonl(path.join(runDir, 'reviewer-process.jsonl'), {
    event: 'review_completed',
    decisionNumber,
    responseId: body.id ?? null,
    returnedModel: body.model ?? null,
    responseStatus: body.status ?? null,
    reasoningSummaries: reasoningSummaries(body),
    usage: body.usage ?? null,
  })
  return decision
}
