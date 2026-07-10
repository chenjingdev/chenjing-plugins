import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)),
  '../skills/psepha/scripts/record.mjs')

const FORM = {
  definition: 'Enumerates contradictions in plan.md, one finding per section.',
  merge: 'union',
  runs: 3,
  isolation: 'sealed',
  invention: 'forbidden',
  criteria_from: 'request',
  anchors: { kind: 'closed_list', values: ['One', 'Two'], source: 'headings' },
  notes: '',
}

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'psepha-record-'))
  const formFile = path.join(dir, 'form.json')
  writeFileSync(formFile, JSON.stringify(FORM))
  const root = path.join(dir, 'records')
  return { formFile, root }
}

function run(args) {
  try {
    const out = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

test('new writes a pending record with a sortable filename and prints the path', () => {
  const { formFile, root } = setup()
  const r = run(['new', '--form', formFile, '--digest', 'Find contradictions in plan.md', '--root', root])
  assert.equal(r.code, 0)
  const file = r.out.trim()
  assert.ok(file.startsWith(root))
  assert.match(path.basename(file), /^\d{8}T\d{6}Z-find-contradictions-in-plan-md\.json$/)
  const record = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(record.form, FORM)
  assert.equal(record.outcome, 'pending')
  assert.equal(record.digest, 'Find contradictions in plan.md')
  assert.ok(!Number.isNaN(Date.parse(record.started_at)))
  assert.equal(readdirSync(root).length, 1)
})

test('outcome updates pending -> merged and changes nothing else', () => {
  const { formFile, root } = setup()
  const file = run(['new', '--form', formFile, '--digest', 'd', '--root', root]).out.trim()
  const before = JSON.parse(readFileSync(file, 'utf8'))
  const r = run(['outcome', file, 'merged'])
  assert.equal(r.code, 0)
  const after = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(after.outcome, 'merged')
  assert.deepEqual({ ...after, outcome: 'pending' }, before)
})

test('outcome refuses a second update (A3: single mutation)', () => {
  const { formFile, root } = setup()
  const file = run(['new', '--form', formFile, '--digest', 'd', '--root', root]).out.trim()
  run(['outcome', file, 'void'])
  const r = run(['outcome', file, 'merged'])
  assert.equal(r.code, 1)
})

test('outcome rejects an unknown value', () => {
  const { formFile, root } = setup()
  const file = run(['new', '--form', formFile, '--digest', 'd', '--root', root]).out.trim()
  const r = run(['outcome', file, 'great'])
  assert.equal(r.code, 2)
})
