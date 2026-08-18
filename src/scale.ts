import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { integer, writeJson } from './common.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

interface CampaignResult {
  runId: string
  exitCode: number | null
  runDir?: string
  compromised?: boolean
  error?: string
}

async function runCampaign(index: number): Promise<CampaignResult> {
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${String(index + 1).padStart(4, '0')}`
  const tsx = path.join(root, 'node_modules', '.bin', 'tsx')
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(tsx, [path.join(root, 'src', 'campaign.ts')], {
      cwd: root,
      env: { ...process.env, LAB_RUN_ID: runId },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      process.stdout.write(chunk)
    })
    child.stderr.on('data', (chunk: string) => (stderr += chunk))
    child.once('error', (error) => resolve({ runId, exitCode: null, error: error.message }))
    child.once('close', async (exitCode) => {
      const runDir = stdout.trim().split('\n').at(-1)
      if (exitCode !== 0 || !runDir) {
        resolve({ runId, exitCode, error: stderr.trim() || 'campaign did not report a run directory' })
        return
      }
      try {
        const outcome = JSON.parse(await readFile(path.join(runDir, 'outcome.json'), 'utf8')) as { compromised?: boolean }
        resolve({ runId, exitCode, runDir, compromised: outcome.compromised === true })
      } catch (error) {
        resolve({ runId, exitCode, runDir, error: error instanceof Error ? error.message : String(error) })
      }
    })
  })
}

async function main(): Promise<void> {
  const runs = integer('LAB_RUNS', 10)
  const concurrency = Math.min(integer('LAB_CONCURRENCY', 2), runs)
  const results: CampaignResult[] = new Array(runs)
  let next = 0

  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = next++
      if (index >= runs) return
      process.stdout.write(`starting ${index + 1}/${runs}\n`)
      results[index] = await runCampaign(index)
      process.stdout.write(`finished ${index + 1}/${runs}: ${JSON.stringify(results[index])}\n`)
    }
  }))

  const summary = {
    startedAt: new Date().toISOString(),
    runs,
    concurrency,
    compromises: results.filter((result) => result.compromised).length,
    failures: results.filter((result) => result.error).length,
    results,
  }
  const summaryDir = path.resolve(process.env.LAB_RUNS_DIR ?? path.join(root, 'runs'))
  await mkdir(summaryDir, { recursive: true })
  const file = path.join(summaryDir, `scale-${Date.now()}.json`)
  await writeJson(file, summary)
  process.stdout.write(`${file}\n`)
  if (summary.failures > 0) process.exitCode = 1
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
