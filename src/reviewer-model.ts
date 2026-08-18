import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { copyFile, mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { appendJsonl } from './common.js'

export interface ReviewDecision {
  decision: 'approve' | 'reject'
  reason: string
}

interface ReviewerState {
  threadId?: string
  codexHome?: string
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const schema = path.join(root, 'schemas', 'review-decision.json')

function codexEnvironment(codexHome: string): NodeJS.ProcessEnv {
  const allowed = [
    'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'TMP', 'TEMP',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'no_proxy',
  ]
  return {
    ...Object.fromEntries(allowed.flatMap((key) => process.env[key] ? [[key, process.env[key]]] : [])),
    CODEX_HOME: codexHome,
  }
}

async function prepareCodexHome(state: ReviewerState): Promise<string> {
  if (state.codexHome) return state.codexHome
  const home = await mkdtemp(path.join(os.tmpdir(), 'openshell-reviewer-codex-'))
  const authSource = process.env.LAB_CODEX_AUTH_FILE
  if (!authSource) throw new Error('LAB_CODEX_AUTH_FILE is required for the reviewer')
  await copyFile(authSource, path.join(home, 'auth.json'))
  state.codexHome = home
  return home
}

export async function reviewWithCodex(
  runDir: string,
  state: ReviewerState,
  prompt: string,
  decisionNumber: number,
): Promise<ReviewDecision> {
  const codexHome = await prepareCodexHome(state)
  const trace = path.join(runDir, `reviewer-${String(decisionNumber).padStart(3, '0')}.jsonl`)
  const stderrFile = path.join(runDir, `reviewer-${String(decisionNumber).padStart(3, '0')}.stderr.log`)
  const decisionFile = path.join(runDir, `reviewer-${String(decisionNumber).padStart(3, '0')}.decision.json`)
  const codex = process.env.LAB_CODEX_BIN ?? 'codex'
  const common = [
    '--json',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    '--output-schema',
    schema,
    '--output-last-message',
    decisionFile,
  ]
  const model = process.env.LAB_REVIEWER_MODEL
  if (model) common.push('--model', model)
  const args = state.threadId
    ? ['--ask-for-approval', 'never', 'exec', 'resume', ...common, state.threadId, prompt]
    : ['--ask-for-approval', 'never', 'exec', '--sandbox', 'read-only', ...common, prompt]

  await appendJsonl(path.join(runDir, 'reviewer-process.jsonl'), {
    event: 'review_started',
    decisionNumber,
    resumedThread: state.threadId ?? null,
  })

  await new Promise<void>((resolve, reject) => {
    const traceStream = createWriteStream(trace, { flags: 'a' })
    const stderrStream = createWriteStream(stderrFile, { flags: 'a' })
    const child = spawn(codex, args, {
      cwd: runDir,
      env: codexEnvironment(codexHome),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.pipe(traceStream)
    child.stderr.pipe(stderrStream)
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      if (!line.trim()) return
      try {
        const event = JSON.parse(line) as Record<string, unknown>
        const threadId = event.thread_id ?? event.threadId
        if (event.type === 'thread.started' && typeof threadId === 'string') state.threadId = threadId
      } catch {
        // Preserve malformed/non-JSON output in the trace; the decision file is authoritative.
      }
    })
    child.once('error', reject)
    child.once('close', async (code) => {
      try {
        await Promise.all([finished(traceStream), finished(stderrStream)])
        if (code === 0) resolve()
        else reject(new Error(`reviewer Codex exited ${code}`))
      } catch (error) {
        reject(error)
      }
    })
  })

  const parsed = JSON.parse(await readFile(decisionFile, 'utf8')) as Partial<ReviewDecision>
  if ((parsed.decision !== 'approve' && parsed.decision !== 'reject') || typeof parsed.reason !== 'string') {
    throw new Error(`invalid reviewer decision: ${JSON.stringify(parsed)}`)
  }
  return { decision: parsed.decision, reason: parsed.reason }
}

export type { ReviewerState }
