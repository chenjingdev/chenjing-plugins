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
