import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)),
  '../skills/salvo/scripts/extract_anchors.mjs')

function run(content, args) {
  const dir = mkdtempSync(path.join(tmpdir(), 'salvo-anchors-'))
  const file = path.join(dir, 'target.md')
  writeFileSync(file, content)
  try {
    const out = execFileSync('node', [SCRIPT, file, ...args], { encoding: 'utf8' })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

test('headings mode extracts markdown headings in order, deduped', () => {
  const r = run('# Title\n\n## One\ntext\n## Two\n### Two.1\n## One\n', ['--mode', 'headings'])
  assert.equal(r.code, 0)
  assert.deepEqual(JSON.parse(r.out), ['Title', 'One', 'Two', 'Two.1'])
})

test('regex mode extracts unique whole matches in order', () => {
  const r = run('M1 guards counting. M2 starves shooters. M1 again.',
    ['--mode', 'regex', '--pattern', 'M\\d+'])
  assert.equal(r.code, 0)
  assert.deepEqual(JSON.parse(r.out), ['M1', 'M2'])
})

test('empty vocabulary exits 2', () => {
  const r = run('no headings here, just prose', ['--mode', 'headings'])
  assert.equal(r.code, 2)
})

test('regex mode without --pattern exits 2', () => {
  const r = run('anything', ['--mode', 'regex'])
  assert.equal(r.code, 2)
})

test('invalid regex pattern exits 2 without a stack trace', () => {
  const r = run('anything', ['--mode', 'regex', '--pattern', '('])
  assert.equal(r.code, 2)
  assert.match(r.out, /invalid --pattern/)
  assert.doesNotMatch(r.out, /at .+:\d+:\d+/)
})

test('missing target file exits 2 without a stack trace', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'salvo-anchors-'))
  const missing = path.join(dir, 'does-not-exist.md')
  let code, out
  try {
    out = execFileSync('node', [SCRIPT, missing, '--mode', 'headings'], { encoding: 'utf8' })
    code = 0
  } catch (e) {
    code = e.status
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
  assert.equal(code, 2)
  assert.match(out, /cannot read target/)
  assert.doesNotMatch(out, /at .+:\d+:\d+/)
})

test('unknown mode exits 2', () => {
  const r = run('# Title\n', ['--mode', 'bogus'])
  assert.equal(r.code, 2)
  assert.match(r.out, /unknown mode/)
})
