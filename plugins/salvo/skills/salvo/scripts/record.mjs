#!/usr/bin/env node
// Run record I/O (SPEC 003 §2.4). ONE JSON shape everywhere (M10):
// {routing?, form?, started_at, digest, outcome} — a preset's intake-form.json
// is the same `form` shape, so promotion is a file copy plus a skill wrapper.
// The optional `routing` block (route-workflow's return object) makes routing
// recountable (AC8, D-14).
//   new     --form <form.json> --digest "<sentence>" [--routing <route.json>] [--root <dir>]
//   new     --routing <route.json> --digest "<sentence>" --outcome routed [--root <dir>]   (sub-skill handoff, no form)
//   outcome <record.json> <merged|void|delegated>
// The outcome update is the only permitted mutation of a run record (A3); a
// routed handoff writes `outcome: routed` at write time and is never mutated.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

// D-6: user-level data directory — survives plugin updates, accumulates
// promotion evidence across projects.
const DEFAULT_ROOT = path.join(homedir(), '.claude/plugins/data/salvo-chenjing-plugins/records')

const [cmd, ...rest] = process.argv.slice(2)
const opt = name => {
  const i = rest.indexOf(name)
  return i === -1 ? null : rest[i + 1]
}

if (cmd === 'new') {
  const formPath = opt('--form')
  const digest = opt('--digest')
  const routingPath = opt('--routing')
  const outcomeArg = opt('--outcome')
  // --outcome is only legal as `routed` (the sub-skill handoff); everything
  // else defaults to `pending` and is updated after dispatch (§2.4/A3).
  if (outcomeArg !== null && outcomeArg !== 'routed') {
    console.error('usage: --outcome is only legal with the value "routed" (default: pending)')
    process.exit(2)
  }
  const routed = outcomeArg === 'routed'
  // A routed handoff carries the routing block but no form; an engine dispatch
  // carries a form (routing optional for backward compatibility).
  if (!digest || (routed ? !routingPath : !formPath)) {
    console.error('usage: record.mjs new --form <form.json> --digest "<sentence>" [--routing <route.json>] [--root <dir>]')
    console.error('   or: record.mjs new --routing <route.json> --digest "<sentence>" --outcome routed [--root <dir>]')
    process.exit(2)
  }
  const root = opt('--root') ?? DEFAULT_ROOT
  const started_at = new Date().toISOString()
  const stamp = started_at.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') // sortable (S3)
  const slug = digest.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '').slice(0, 40)
  const file = path.join(root, `${stamp}-${slug}.json`)
  mkdirSync(root, { recursive: true })
  if (existsSync(file)) {
    console.error(`refusing to overwrite ${file}`)
    process.exit(1)
  }
  const record = {}
  if (routingPath) record.routing = JSON.parse(readFileSync(routingPath, 'utf8'))
  if (!routed) record.form = JSON.parse(readFileSync(formPath, 'utf8'))
  record.started_at = started_at
  record.digest = digest
  record.outcome = routed ? 'routed' : 'pending'
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n')
  console.log(file)
} else if (cmd === 'outcome') {
  const [file, value] = rest
  if (!file || !['merged', 'void', 'delegated'].includes(value)) {
    console.error('usage: record.mjs outcome <record.json> <merged|void|delegated>')
    process.exit(2)
  }
  const record = JSON.parse(readFileSync(file, 'utf8'))
  if (record.outcome !== 'pending') {
    console.error(`outcome already ${record.outcome} — a run record permits exactly one mutation (A3)`)
    process.exit(1)
  }
  record.outcome = value
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n')
  console.log(`outcome: ${value}`)
} else {
  console.error('usage: record.mjs new|outcome …')
  process.exit(2)
}
