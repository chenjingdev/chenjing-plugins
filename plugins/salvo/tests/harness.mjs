// Runs the REAL run-workflow.js file under node:test with mocked globals,
// so the merge logic is tested exactly as it ships to the Workflow sandbox.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)),
  '../skills/salvo/references/run-workflow.js')

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

// agentImpl(prompt, opts, callIndex) -> mock output object/string, or null for
// a failed run. Returns { result, calls } where calls = [{prompt, opts}].
export async function runWorkflow(args, agentImpl) {
  const src = readFileSync(SCRIPT, 'utf8').replace(/^export /m, '')
  const calls = []
  const agent = async (prompt, opts = {}) => {
    calls.push({ prompt, opts })
    return agentImpl(prompt, opts, calls.length - 1)
  }
  const parallel = async thunks => Promise.all(thunks.map(t => t().catch(() => null)))
  const pipeline = async () => { throw new Error('pipeline is not used by run-workflow') }
  const log = () => {}
  const phase = () => {}
  const budget = { total: null, spent: () => 0, remaining: () => Infinity }
  const fn = new AsyncFunction('agent', 'parallel', 'pipeline', 'log', 'phase', 'args', 'budget', src)
  const result = await fn(agent, parallel, pipeline, log, phase, args, budget)
  return { result, calls }
}
