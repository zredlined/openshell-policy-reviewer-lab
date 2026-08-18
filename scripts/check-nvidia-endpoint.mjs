#!/usr/bin/env node

import { readFile } from 'node:fs/promises'

function parseEnv(text) {
  const values = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    values[match[1]] = value
  }
  return values
}

function outputText(body) {
  return (body.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === 'output_text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n')
}

const envFile = process.argv[2] ?? process.env.NVIDIA_ENV_FILE
const fileEnv = envFile ? parseEnv(await readFile(envFile, 'utf8')) : {}
const apiKey = process.env.NVIDIA_API_KEY ?? process.env.OPENAI_API_KEY ?? fileEnv.NVIDIA_API_KEY ?? fileEnv.OPENAI_API_KEY
if (!apiKey) throw new Error('Set NVIDIA_API_KEY/OPENAI_API_KEY or pass an env file containing one')

const url = process.env.NVIDIA_RESPONSES_URL ?? 'https://inference-api.nvidia.com/v1/responses'
const model = process.env.LAB_MODEL ?? 'openai/openai/gpt-5.6-sol'
const reviewerContract = process.argv.includes('--reviewer-contract')
const request = reviewerContract
  ? {
      model,
      input: [{ role: 'user', content: 'A request asks for read-only access to public documentation. Return an approval decision.' }],
      reasoning: { effort: 'high', summary: 'detailed' },
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
              reason: { type: 'string' },
            },
          },
        },
      },
      max_output_tokens: 512,
    }
  : {
      model,
      input: [{ role: 'user', content: 'Reply with exactly: endpoint-ok' }],
      max_output_tokens: 128,
    }
const started = Date.now()
const response = await fetch(url, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(request),
})

const body = await response.json().catch(() => ({}))
const summary = {
  ok: response.ok,
  httpStatus: response.status,
  elapsedMs: Date.now() - started,
  requestedModel: model,
  returnedModel: body.model ?? null,
  responseStatus: body.status ?? null,
  outputTypes: Array.isArray(body.output) ? body.output.map((item) => item.type) : [],
  text: outputText(body) || null,
  reasoningSummaries: (body.output ?? [])
    .filter((item) => item.type === 'reasoning')
    .flatMap((item) => item.summary ?? [])
    .map((item) => item.text)
    .filter(Boolean),
  usage: body.usage ?? null,
  error: body.error ? { type: body.error.type ?? null, code: body.error.code ?? null, message: body.error.message ?? null } : null,
}
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
if (!response.ok || (!reviewerContract && summary.text !== 'endpoint-ok')) process.exitCode = 1
