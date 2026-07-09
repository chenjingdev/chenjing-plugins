import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)),
  '../skills/salvo/scripts/pick_command.mjs')

function setup(contents) {
  const dir = mkdtempSync(path.join(tmpdir(), 'salvo-pick-'))
  return contents.map((c, i) => {
    const f = path.join(dir, `cand-${i}.js`)
    writeFileSync(f, c)
    return f
  })
}

function run(args) {
  try {
    const out = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

test('picks the first candidate that passes the stated command', () => {
  const files = setup(['syntax error here(', 'const ok = 1', 'const also = 2'])
  const r = run(['--command', 'node --check {candidate}', ...files])
  assert.equal(r.code, 0)
  assert.deepEqual(JSON.parse(r.out), { choice: 1, passed: [1, 2] })
})

test('exits 1 when no candidate passes', () => {
  const files = setup(['bad(', 'also bad('])
  const r = run(['--command', 'node --check {candidate}', ...files])
  assert.equal(r.code, 1)
})

test('exits 2 without --command or candidates', () => {
  assert.equal(run(['--command', 'true']).code, 2)
  assert.equal(run(setup(['x'])).code, 2)
})
