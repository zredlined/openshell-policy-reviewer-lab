import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendJsonl, connect, delay, json, redactUntrusted, required, status, writeJson } from './common.js'
import { reviewWithNvidia, type ReviewerState } from './reviewer-model.js'

async function main(): Promise<void> {
  const sandbox = required('LAB_SANDBOX')
  const owner = required('LAB_GITHUB_OWNER')
  const repo = required('LAB_GITHUB_REPO')
  const runDir = required('LAB_RUN_DIR')
  const workspace = process.env.LAB_WORKSPACE ?? 'default'
  const deadlineMs = Number(process.env.LAB_DEADLINE_MS ?? Date.now() + 30 * 60_000)
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const baseInstructions = await readFile(path.join(root, 'prompts', 'reviewer.md'), 'utf8')
  await writeFile(path.join(runDir, 'reviewer-prompt.md'), baseInstructions)
  const client = await connect()
  const processed = new Set<string>()
  const state: ReviewerState = { history: [] }
  let decisionNumber = 0

  await appendJsonl(path.join(runDir, 'reviewer-process.jsonl'), { event: 'reviewer_ready', sandbox })
  await writeJson(path.join(runDir, 'reviewer-ready.json'), { sandbox, readyAt: new Date().toISOString() })
  status('reviewer.ready', { sandbox, deadlineMs })

  while (Date.now() < deadlineMs) {
      const inbox = await client.raw.getDraftPolicy({ name: sandbox, statusFilter: 'pending', workspace })
      const chunks = inbox.chunks.filter((chunk) => !processed.has(chunk.id)).sort((a, b) => Number(a.createdAtMs - b.createdAtMs))
      if (chunks.length === 0) {
        await delay(750)
        continue
      }

      for (const chunk of chunks) {
        if (Date.now() >= deadlineMs) break
        processed.add(chunk.id)
        decisionNumber += 1
        const current = await client.sandbox.getConfig(sandbox)
        const packet = redactUntrusted({
          sandbox,
          protectedRepository: `${owner}/${repo}`,
          proposal: chunk,
          currentPolicy: current.policy,
        })
        status('reviewer.proposal', { sandbox, decisionNumber, ruleName: chunk.ruleName, stage: chunk.stage })
        await writeJson(path.join(runDir, `proposal-${String(decisionNumber).padStart(3, '0')}.json`), packet)

        let decision: { decision: 'approve' | 'reject'; reason: string }
        try {
          decision = await reviewWithNvidia(
            runDir,
            state,
            baseInstructions,
            `Protected repository: ${owner}/${repo}\n\nReview this pending request:\n${json(packet)}`,
            decisionNumber,
            Math.max(1, deadlineMs - Date.now()),
          )
        } catch (error) {
          decision = { decision: 'reject', reason: `Reviewer failed closed: ${error instanceof Error ? error.message : String(error)}` }
        }

        await appendJsonl(path.join(runDir, 'decisions.jsonl'), { chunkId: chunk.id, ...decision })
        status('reviewer.decision', { sandbox, decisionNumber, decision: decision.decision, reason: decision.reason })
        if (decision.decision === 'approve') {
          await client.raw.approveDraftChunk({ name: sandbox, chunkId: chunk.id, workspace })
        } else {
          await client.raw.rejectDraftChunk({ name: sandbox, chunkId: chunk.id, workspace, reason: decision.reason })
        }
      }
    }

  await appendJsonl(path.join(runDir, 'reviewer-process.jsonl'), {
    event: 'reviewer_stopped',
    decisions: decisionNumber,
    reason: 'deadline',
  })
  status('reviewer.stopped', { sandbox, decisions: decisionNumber, reason: 'deadline' })
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
