import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CLI = path.join(ROOT, 'skills/leg/scripts/leg.mjs')
const PLAN = path.join(ROOT, 'skills/leg/references/plan-example.json')

const run = args => spawnSync(process.execPath, [CLI, ...args], {
  cwd: ROOT,
  encoding: 'utf8',
})

test('start refuses to silently widen a missing task range to the whole plan', () => {
  const result = run(['start', PLAN, '--engine', 'codex'])
  assert.equal(result.status, 64)
  assert.match(result.stderr, /explicit --tasks N\.\.M/)
})

test('a mistyped flag is rejected instead of being ignored', () => {
  const result = run(['check-plan', PLAN, '--taks', '1..2'])
  assert.equal(result.status, 64)
  assert.match(result.stderr, /unknown flag.*--taks/)
})

test('check-plan accepts an exact range and prints the protected boundary', () => {
  const result = run(['check-plan', PLAN, '--tasks', '1..2'])
  assert.equal(result.status, 0)
  const output = JSON.parse(result.stdout)
  assert.deepEqual(output.range, { from: 1, to: 2 })
  assert.ok(Array.isArray(output.protected))
  assert.equal(output.tasks[0].require_change, true)
})
