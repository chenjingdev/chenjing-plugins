// Runs the REAL workflow files under node:test with mocked globals, so their
// code (merge tally, routing table) is tested exactly as it ships to the
// Workflow sandbox.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RUN_SCRIPT = path.join(HERE, '../skills/psepha/references/run-workflow.js')
const ROUTE_SCRIPT = path.join(HERE, '../skills/psepha/references/route-workflow.js')

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

// agentImpl(prompt, opts, callIndex) -> mock output object/string, or null for
// a failed run. Returns { result, calls } where calls = [{prompt, opts}].
async function runScript(scriptPath, args, agentImpl, owner) {
  const src = readFileSync(scriptPath, 'utf8').replace(/^export /m, '')
  const calls = []
  const agent = async (prompt, opts = {}) => {
    calls.push({ prompt, opts })
    return agentImpl(prompt, opts, calls.length - 1)
  }
  const parallel = async thunks => Promise.all(thunks.map(t => t().catch(() => null)))
  const pipeline = async () => { throw new Error(`pipeline is not used by ${owner}`) }
  const log = () => {}
  const phase = () => {}
  const budget = { total: null, spent: () => 0, remaining: () => Infinity }
  const fn = new AsyncFunction('agent', 'parallel', 'pipeline', 'log', 'phase', 'args', 'budget', src)
  const result = await fn(agent, parallel, pipeline, log, phase, args, budget)
  return { result, calls }
}

export const runWorkflow = (args, agentImpl) => runScript(RUN_SCRIPT, args, agentImpl, 'run-workflow')
export const runRoute = (args, agentImpl) => runScript(ROUTE_SCRIPT, args, agentImpl, 'route-workflow')
