# salvo Weapon Platform (/salvo door) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `/salvo` single door per the gate-passed spec `plugins/salvo/specs/003-weapon-platform/SPEC.md`: routing + forge (intake form) + one-Workflow volley dispatch + code-only folds + residue archiving.

**Architecture:** One user-facing skill (`skills/salvo/SKILL.md`) orchestrates; all deterministic work lives in bundled Node scripts (`scripts/*.mjs`) and one static Workflow script (`references/volley-workflow.js`) that fires N starved shooters and folds their schema-enforced outputs in pure JS. The invoking session never counts, never aggregates (제1원칙 / M1, M4).

**Tech Stack:** Node ≥ 24 (v24.7.0 installed) built-ins only, ESM `.mjs`, `node:test` runner; Claude Code Workflow tool (scriptPath + args); plugin agent definition for sealed shooters.

## Global Constraints

Copied verbatim from SPEC 003 unless noted; every task's requirements implicitly include this section.

- **M1**: for `union`/`vote`, anchor matching, dedup, tally, thresholding are performed by a deterministic program — never by an LLM. `pick` follows its declared route (`mechanical` = code, `judged` = starved judge agent).
- **M2**: a shooter receives only its shooter prompt — no conversation history, no sibling outputs. The pick judge receives only the candidate artifacts + criterion text.
- **M4**: all shooters (including volley-1 delegations) run outside the invoking session — here: inside ONE Workflow call per firing.
- **M5**: the ResidueRecord is written before any shooter is spawned.
- **M6**: verbatim honesty labels — copy exactly: `한 발은 짐작` (volley 1), `기계 선택` (mechanical pick), `판단 선택` (judged pick). Union/vote reports state N and the fold rule.
- **M7**: exactly one announcement line precedes dispatch; never wait for confirmation, never fire silently.
- **M8**: no auto-repeat/auto-retry of a volley or a failed shooter. Dispatch-layer conformance re-requests (M11) cap at 2 per shooter and are not retries.
- **M10**: ONE serialization everywhere: JSON envelope `{form, fired_at, digest, outcome}`. A preset weapon's `intake-form.json` is byte-format-identical to a ResidueRecord (promotion = file copy + skill wrapper).
- **M11**: shooter output conformance (structure and anchor vocabulary) is enforced at the dispatch layer (schema + re-request). Never repaired downstream by an LLM.
- **Residue root** (D-6, user decision 2026-07-09): `~/.claude/plugins/data/salvo-chenjing-plugins/residue/` — NOT inside the plugin tree (the install cache is read-only and replaced on update).
- **Language** (A6): machine-facing content (forms, residue, SKILL.md, scripts, comments) in English; user-facing lines (announcement, report) in the user's conversation language.
- **Defaults** (S1/S2/S5): volley 3; vote_threshold = majority; volley > 5 only on explicit user request; prefer `isolation: sealed`.
- Nothing at runtime writes inside the plugin directory (it ships to a read-only cache).
- Test command (run from repo root, must stay green after every task): `node --test 'plugins/salvo/tests/*.test.mjs'`
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## File Map

```
plugins/salvo/
├── skills/salvo/
│   ├── SKILL.md                             (Task 7 — the door)
│   ├── scripts/
│   │   ├── check_form.mjs                   (Task 2 — field + C1–C6 validation)
│   │   ├── extract_anchors.mjs              (Task 3 — closed anchor vocabulary)
│   │   ├── residue.mjs                      (Task 4 — residue new/outcome)
│   │   └── pick_command.mjs                 (Task 6 — mechanical pick, command kind)
│   └── references/
│       ├── volley-workflow.js               (Tasks 5+6 — the ONE static workflow script)
│       └── shooter-prompt-template.md       (Task 7)
├── agents/shooter.md                        (Task 7 — sealed shooter/judge, tools: [])
├── tests/
│   ├── harness.mjs                          (Task 5 — runs volley-workflow.js with mocked agent())
│   ├── check_form.test.mjs                  (Task 2)
│   ├── extract_anchors.test.mjs             (Task 3)
│   ├── residue.test.mjs                     (Task 4)
│   ├── volley_fold.test.mjs                 (Task 5)
│   ├── volley_pick.test.mjs                 (Task 6)
│   └── pick_command.test.mjs                (Task 6)
├── specs/003-weapon-platform/SPEC.md        (Task 1 — residue-path amendment, D-6)
├── .claude-plugin/plugin.json               (Task 8 — v0.6.0)
└── README.md                                (Task 8)
.claude-plugin/marketplace.json              (Task 8 — register ./skills/salvo)
```

## Canonical Data Shapes (used by every task)

**IntakeForm JSON** (the `form` object; unknown keys are M3 violations):

```json
{
  "definition": "Enumerates contradictions in a given document, one finding per section.",
  "fold": "union",
  "vote_threshold": 2,
  "pick": { "criterion": "…", "route": "mechanical", "program": { "kind": "command", "command": "node --check {candidate}" } },
  "volley": 3,
  "isolation": "sealed",
  "invention": "forbidden",
  "criteria_from": "request",
  "criteria_ref": "docs/plan.md",
  "anchors": { "kind": "closed_list", "values": ["…"], "source": "headings" },
  "residual": ""
}
```

Presence rules (enforced by `check_form.mjs`): `vote_threshold` iff `fold=vote`; `pick` iff `fold=pick` (`pick.program` iff `route=mechanical`); `criteria_ref` iff `criteria_from=document`; `anchors` iff `fold∈{union,vote}` — `anchors.kind` ∈ `closed_list|quote`, `values` required non-empty iff `closed_list`, `source` optional provenance string.

**ResidueRecord / preset intake-form.json** (M10 — identical shape):

```json
{ "form": { …IntakeForm… }, "fired_at": "2026-07-09T03:12:45.123Z", "digest": "one-sentence request digest", "outcome": "pending" }
```

`outcome` ∈ `pending → folded | void | delegated` (the update is the only permitted mutation, A3).

**volley-workflow.js args** (built by the door):

```js
{ form: IntakeForm, shooterPrompt: string, target: string|null /* required when anchors.kind==='quote' */, model: string|null }
```

**volley-workflow.js return** (exactly one of):

```js
{ kind: 'single',    result: string }                                   // fold none
{ kind: 'folded',    fold: 'union'|'vote', volley: N, threshold?, dropped?,
  items: [{ anchor, count, entries: [{ shooter, anchor, content }] }] }
{ kind: 'picked',    route: 'mechanical'|'judged', program?, choice, grounds?, candidates: [string] }
{ kind: 'candidates', route: 'mechanical', program: 'command', candidates: [string] }  // command runs outside the sandbox
{ kind: 'void',      reason: string }
```

---

### Task 1: Spec amendment — residue root (D-6)

The gate-passed spec pins `plugins/salvo/residue/`, but the installed plugin runs from a read-only cache replaced wholesale on update — residue kept there would be erased, and it must accumulate across projects to serve as promotion evidence. The user decided (2026-07-09) to move it to the user-level data directory. Record the amendment, don't silently drift.

**Files:**
- Modify: `plugins/salvo/specs/003-weapon-platform/SPEC.md` (3 path mentions + 1 new ledger row)

**Interfaces:**
- Produces: the amended residue root `~/.claude/plugins/data/salvo-chenjing-plugins/residue/` that Tasks 4 and 7 hard-code as the default.

- [ ] **Step 1: Locate the three path mentions**

Run: `grep -n 'plugins/salvo/residue' plugins/salvo/specs/003-weapon-platform/SPEC.md`
Expected: 3 hits — §2.4 (ResidueRecord), I-5 ledger row, AC1.

- [ ] **Step 2: Apply the three edits**

§2.4 — replace:
> Persistent. One file per firing under `plugins/salvo/residue/`, written when

with:
> Persistent. One file per firing under the salvo data directory
> `~/.claude/plugins/data/salvo-chenjing-plugins/residue/` (user-level, outside
> the plugin install — the install cache is read-only and replaced wholesale on
> every update; residue must survive updates and accumulate across projects,
> D-6), written when

AC1 — replace `a residue file exists under\n  \`plugins/salvo/residue/\` before any shooter starts` (keep surrounding text) with `a residue file exists under the salvo residue data directory (§2.4) before any shooter starts`.

I-5 row — replace `residue at \`plugins/salvo/residue/\`` with `residue at the salvo data directory (path amended by D-6)`.

- [ ] **Step 3: Append the D-6 ledger row**

Add directly below the D-5 row (keep the table contiguous — no blank line):

```markdown
| D-6 | Residue root amended post-gate to the user-level data directory `~/.claude/plugins/data/salvo-chenjing-plugins/residue/` | The installed plugin executes from a read-only cache that updates clobber, so in-tree residue would be erased; residue must accumulate across projects as promotion evidence. User decision at implementation start (2026-07-09) | Literal `plugins/salvo/residue/` (evidence erased on update; dead path outside the dev repo); per-project `.salvo/residue/` (promotion evidence scattered) |
```

- [ ] **Step 4: Verify and commit**

Run: `grep -c 'salvo-chenjing-plugins/residue' plugins/salvo/specs/003-weapon-platform/SPEC.md`
Expected: `2` (§2.4 + D-6 row).

```bash
git add plugins/salvo/specs/003-weapon-platform/SPEC.md
git commit -m "docs(salvo): 003 스펙 수정 — 잔해 경로를 사용자 데이터 디렉토리로 (D-6)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `check_form.mjs` — mechanical form validation (C1–C6 + M3)

**Files:**
- Create: `plugins/salvo/skills/salvo/scripts/check_form.mjs`
- Test: `plugins/salvo/tests/check_form.test.mjs`

**Interfaces:**
- Consumes: a JSON file containing either a bare IntakeForm or a `{form, …}` envelope.
- Produces: CLI contract used by SKILL.md §3 — `node check_form.mjs <form.json>`; prints `OK` + exit 0, or one violation per line (`C1: …` / `C4: …` / `F: …` / `M3: …`) + exit 1; exit 2 on usage/unreadable JSON.

- [ ] **Step 1: Write the failing tests**

Create `plugins/salvo/tests/check_form.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)),
  '../skills/salvo/scripts/check_form.mjs')

function run(doc) {
  const dir = mkdtempSync(path.join(tmpdir(), 'salvo-form-'))
  const file = path.join(dir, 'form.json')
  writeFileSync(file, JSON.stringify(doc))
  try {
    const out = execFileSync('node', [SCRIPT, file], { encoding: 'utf8' })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

const base = () => ({
  definition: 'Enumerates contradictions in a given document, one finding per section.',
  fold: 'union',
  volley: 3,
  isolation: 'sealed',
  invention: 'forbidden',
  criteria_from: 'request',
  anchors: { kind: 'closed_list', values: ['## A', '## B'], source: 'headings' },
  residual: '',
})

test('valid union form passes', () => {
  const r = run(base())
  assert.equal(r.code, 0)
  assert.match(r.out, /OK/)
})

test('envelope with .form is unwrapped', () => {
  const r = run({ form: base(), fired_at: 'x', digest: 'd', outcome: 'pending' })
  assert.equal(r.code, 0)
})

test('C1: volley 1 with fold union fails', () => {
  const r = run({ ...base(), volley: 1 })
  assert.equal(r.code, 1)
  assert.match(r.out, /C1/)
})

test('C1: fold none with volley 3 fails', () => {
  const f = base(); delete f.anchors
  const r = run({ ...f, fold: 'none' })
  assert.equal(r.code, 1)
  assert.match(r.out, /C1/)
})

test('delegation form (volley 1, fold none, tooled) passes', () => {
  const f = base(); delete f.anchors
  const r = run({ ...f, fold: 'none', volley: 1, isolation: 'tooled', invention: 'allowed' })
  assert.equal(r.code, 0)
})

test('C2: union without anchors fails', () => {
  const f = base(); delete f.anchors
  const r = run(f)
  assert.equal(r.code, 1)
  assert.match(r.out, /C2/)
})

test('C2: anchors present on a pick fold fails', () => {
  const r = run({ ...base(), fold: 'pick', pick: { criterion: 'clearest intro', route: 'judged' } })
  assert.equal(r.code, 1)
  assert.match(r.out, /C2/)
})

test('C3: vote threshold above volley fails', () => {
  const r = run({ ...base(), fold: 'vote', vote_threshold: 4 })
  assert.equal(r.code, 1)
  assert.match(r.out, /C3/)
})

test('C3: valid vote form passes', () => {
  const r = run({ ...base(), fold: 'vote', vote_threshold: 2 })
  assert.equal(r.code, 0)
})

test('C3: vote_threshold outside vote fold fails', () => {
  const r = run({ ...base(), vote_threshold: 2 })
  assert.equal(r.code, 1)
  assert.match(r.out, /C3/)
})

test('C4: pick without route fails', () => {
  const f = base(); delete f.anchors
  const r = run({ ...f, fold: 'pick', pick: { criterion: 'clearest' } })
  assert.equal(r.code, 1)
  assert.match(r.out, /C4/)
})

test('C4: mechanical pick with command program passes', () => {
  const f = base(); delete f.anchors
  const r = run({ ...f, fold: 'pick', pick: { criterion: 'passes the check', route: 'mechanical', program: { kind: 'command', command: 'node --check {candidate}' } } })
  assert.equal(r.code, 0)
})

test('C4: mechanical pick without program fails', () => {
  const f = base(); delete f.anchors
  const r = run({ ...f, fold: 'pick', pick: { criterion: 'shortest', route: 'mechanical' } })
  assert.equal(r.code, 1)
  assert.match(r.out, /C4/)
})

test('C5: criteria_from document with missing file fails', () => {
  const r = run({ ...base(), criteria_from: 'document', criteria_ref: '/nonexistent/doc.md' })
  assert.equal(r.code, 1)
  assert.match(r.out, /C5/)
})

test('C5: criteria_from document with existing file passes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'salvo-doc-'))
  const doc = path.join(dir, 'doc.md')
  writeFileSync(doc, '# hi')
  const r = run({ ...base(), criteria_from: 'document', criteria_ref: doc })
  assert.equal(r.code, 0)
})

test('C6: free-form anchors kind fails', () => {
  const r = run({ ...base(), anchors: { kind: 'freeform', values: [] } })
  assert.equal(r.code, 1)
  assert.match(r.out, /C6/)
})

test('C6: closed_list with empty values fails', () => {
  const r = run({ ...base(), anchors: { kind: 'closed_list', values: [] } })
  assert.equal(r.code, 1)
  assert.match(r.out, /C6/)
})

test('M3: unknown field is rejected (no reader-less fields)', () => {
  const r = run({ ...base(), color: 'red' })
  assert.equal(r.code, 1)
  assert.match(r.out, /M3/)
})

test('F: missing residual key fails', () => {
  const f = base(); delete f.residual
  const r = run(f)
  assert.equal(r.code, 1)
  assert.match(r.out, /F/)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test plugins/salvo/tests/check_form.test.mjs`
Expected: every test FAILS (script file does not exist — execFileSync throws with status null/1).

- [ ] **Step 3: Write the implementation**

Create `plugins/salvo/skills/salvo/scripts/check_form.mjs`:

```js
#!/usr/bin/env node
// Mechanical validation of a salvo IntakeForm (SPEC 003 §2.1): field types,
// enums, required-iff presence, and coherence rules C1-C6 — checkable without
// an LLM by design. Accepts a bare form or a residue envelope ({form, ...}).
// Prints one violation per line as "<rule>: <message>"; exit 1 on any.
import { readFileSync, existsSync } from 'node:fs'

const file = process.argv[2]
if (!file) {
  console.error('usage: check_form.mjs <form.json>')
  process.exit(2)
}

let doc
try {
  doc = JSON.parse(readFileSync(file, 'utf8'))
} catch (e) {
  console.error(`F: unreadable JSON — ${e.message}`)
  process.exit(2)
}

const form = doc && typeof doc.form === 'object' && doc.form !== null ? doc.form : doc
const errors = []
const err = (rule, msg) => errors.push(`${rule}: ${msg}`)

// M3: every field has a reader — an unknown field has none.
const KNOWN = ['definition', 'fold', 'vote_threshold', 'pick', 'volley',
  'isolation', 'invention', 'criteria_from', 'criteria_ref', 'anchors', 'residual']
for (const k of Object.keys(form)) {
  if (!KNOWN.includes(k)) err('M3', `unknown field "${k}" has no reader`)
}

const FOLDS = ['union', 'vote', 'pick', 'none']
if (typeof form.definition !== 'string' || form.definition.trim() === '')
  err('F', 'definition must be a non-empty string')
if (!FOLDS.includes(form.fold)) err('F', `fold must be one of ${FOLDS.join('|')}`)
if (!Number.isInteger(form.volley) || form.volley < 1)
  err('F', 'volley must be an integer >= 1')
if (!['sealed', 'tooled'].includes(form.isolation)) err('F', 'isolation must be sealed|tooled')
if (!['forbidden', 'allowed'].includes(form.invention)) err('F', 'invention must be forbidden|allowed')
if (!['request', 'document', 'shooter'].includes(form.criteria_from))
  err('F', 'criteria_from must be request|document|shooter')
if (typeof form.residual !== 'string')
  err('F', 'residual must be present as a string (may be empty)')

// C1: volley = 1 <=> fold = none (both directions).
if ((form.volley === 1) !== (form.fold === 'none'))
  err('C1', 'volley = 1 iff fold = none (both directions)')

// C2 + C6: anchors required for union/vote, absent otherwise, vocabulary code-checkable.
const needsAnchors = form.fold === 'union' || form.fold === 'vote'
if (needsAnchors) {
  if (form.anchors == null || typeof form.anchors !== 'object') {
    err('C2', `fold = ${form.fold} requires anchors`)
  } else if (!['closed_list', 'quote'].includes(form.anchors.kind)) {
    err('C6', 'anchors.kind must be closed_list|quote (free-form vocabularies are not permitted)')
  } else if (form.anchors.kind === 'closed_list' &&
    (!Array.isArray(form.anchors.values) || form.anchors.values.length === 0 ||
      !form.anchors.values.every(v => typeof v === 'string' && v.length > 0))) {
    err('C6', 'closed_list anchors require a non-empty string array in anchors.values')
  }
} else if ('anchors' in form) {
  err('C2', `anchors must be absent when fold = ${form.fold}`)
}

// C3: vote threshold present, sane, and only for vote.
if (form.fold === 'vote') {
  if (!Number.isInteger(form.vote_threshold) || form.vote_threshold < 2 ||
    form.vote_threshold > form.volley)
    err('C3', 'vote requires an integer vote_threshold with 2 <= threshold <= volley')
} else if ('vote_threshold' in form) {
  err('C3', 'vote_threshold must be absent unless fold = vote')
}

// C4: pick criterion + declared route; mechanical route needs a program.
if (form.fold === 'pick') {
  const p = form.pick
  if (p == null || typeof p !== 'object' || typeof p.criterion !== 'string' ||
    p.criterion.trim() === '' || !['mechanical', 'judged'].includes(p.route)) {
    err('C4', 'pick requires pick.criterion (non-empty) and pick.route = mechanical|judged')
  } else if (p.route === 'mechanical') {
    const prog = p.program
    if (prog == null || !['shortest', 'longest', 'command'].includes(prog.kind)) {
      err('C4', 'mechanical pick requires pick.program.kind = shortest|longest|command')
    } else if (prog.kind === 'command' &&
      (typeof prog.command !== 'string' || prog.command.trim() === '')) {
      err('C4', 'pick.program.kind = command requires pick.program.command')
    }
  } else if ('program' in p) {
    err('C4', 'pick.program must be absent when route = judged')
  }
} else if ('pick' in form) {
  err('C4', 'pick must be absent unless fold = pick')
}

// C5: referenced document must exist at form completion time.
if (form.criteria_from === 'document') {
  if (typeof form.criteria_ref !== 'string' || form.criteria_ref.trim() === '') {
    err('C5', 'criteria_from = document requires criteria_ref')
  } else if (!existsSync(form.criteria_ref)) {
    err('C5', `referenced document does not exist: ${form.criteria_ref}`)
  }
} else if ('criteria_ref' in form) {
  err('C5', 'criteria_ref must be absent unless criteria_from = document')
}

if (errors.length > 0) {
  console.log(errors.join('\n'))
  process.exit(1)
}
console.log('OK')
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test plugins/salvo/tests/check_form.test.mjs`
Expected: all 19 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/salvo/skills/salvo/scripts/check_form.mjs plugins/salvo/tests/check_form.test.mjs
git commit -m "feat(salvo): check_form.mjs — 신고서 필드·C1–C6 기계 검사

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `extract_anchors.mjs` — closed anchor vocabulary (C6-a)

**Files:**
- Create: `plugins/salvo/skills/salvo/scripts/extract_anchors.mjs`
- Test: `plugins/salvo/tests/extract_anchors.test.mjs`

**Interfaces:**
- Produces: CLI used by SKILL.md §2.7 — `node extract_anchors.mjs <target> --mode headings` or `--mode regex --pattern '<re>'`; prints a JSON array (unique values, document order) to stdout; exit 2 when the vocabulary is empty (forge must pick another vocabulary).

- [ ] **Step 1: Write the failing tests**

Create `plugins/salvo/tests/extract_anchors.test.mjs`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test plugins/salvo/tests/extract_anchors.test.mjs`
Expected: all 4 FAIL (script missing).

- [ ] **Step 3: Write the implementation**

Create `plugins/salvo/skills/salvo/scripts/extract_anchors.mjs`:

```js
#!/usr/bin/env node
// Extracts a closed anchor vocabulary from a target file at form time
// (SPEC 003 §2.1 anchors, kind closed_list). The printed array is embedded in
// the shooter output schema as the allowed anchor values, which is what makes
// fold matching pure code (C6, I-6).
// usage: extract_anchors.mjs <target> --mode headings|regex [--pattern <re>]
// Prints a JSON array (unique, document order); exit 2 on an empty vocabulary.
import { readFileSync } from 'node:fs'

const [file, ...rest] = process.argv.slice(2)
const opt = name => {
  const i = rest.indexOf(name)
  return i === -1 ? null : rest[i + 1]
}
const mode = opt('--mode')
if (!file || !mode) {
  console.error('usage: extract_anchors.mjs <target> --mode headings|regex [--pattern <re>]')
  process.exit(2)
}

const text = readFileSync(file, 'utf8')
let matches = []
if (mode === 'headings') {
  matches = [...text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map(m => m[1])
} else if (mode === 'regex') {
  const pattern = opt('--pattern')
  if (!pattern) {
    console.error('regex mode requires --pattern')
    process.exit(2)
  }
  matches = [...text.matchAll(new RegExp(pattern, 'gm'))].map(m => m[0])
} else {
  console.error(`unknown mode: ${mode}`)
  process.exit(2)
}

const values = [...new Set(matches)]
if (values.length === 0) {
  console.error('empty vocabulary — choose another extraction or a quote vocabulary')
  process.exit(2)
}
console.log(JSON.stringify(values))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test plugins/salvo/tests/extract_anchors.test.mjs`
Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/salvo/skills/salvo/scripts/extract_anchors.mjs plugins/salvo/tests/extract_anchors.test.mjs
git commit -m "feat(salvo): extract_anchors.mjs — 폐쇄 앵커 어휘 추출 (C6-a)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `residue.mjs` — residue lifecycle (M5, M10, S3, A3)

**Files:**
- Create: `plugins/salvo/skills/salvo/scripts/residue.mjs`
- Test: `plugins/salvo/tests/residue.test.mjs`

**Interfaces:**
- Consumes: a bare IntakeForm JSON file (Task 2's shape).
- Produces: CLI used by SKILL.md §4/§7 —
  `node residue.mjs new --form <form.json> --digest "<sentence>" [--root <dir>]` → writes `{form, fired_at, digest, outcome:"pending"}` as `<stamp>-<slug>.json`, prints the absolute path;
  `node residue.mjs outcome <record.json> <folded|void|delegated>` → single permitted mutation.
- Default root: `~/.claude/plugins/data/salvo-chenjing-plugins/residue` (D-6). Tests always pass `--root`.

- [ ] **Step 1: Write the failing tests**

Create `plugins/salvo/tests/residue.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)),
  '../skills/salvo/scripts/residue.mjs')

const FORM = {
  definition: 'Enumerates contradictions in plan.md, one finding per section.',
  fold: 'union',
  volley: 3,
  isolation: 'sealed',
  invention: 'forbidden',
  criteria_from: 'request',
  anchors: { kind: 'closed_list', values: ['One', 'Two'], source: 'headings' },
  residual: '',
}

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'salvo-residue-'))
  const formFile = path.join(dir, 'form.json')
  writeFileSync(formFile, JSON.stringify(FORM))
  const root = path.join(dir, 'residue')
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
  assert.ok(!Number.isNaN(Date.parse(record.fired_at)))
  assert.equal(readdirSync(root).length, 1)
})

test('outcome updates pending -> folded and changes nothing else', () => {
  const { formFile, root } = setup()
  const file = run(['new', '--form', formFile, '--digest', 'd', '--root', root]).out.trim()
  const before = JSON.parse(readFileSync(file, 'utf8'))
  const r = run(['outcome', file, 'folded'])
  assert.equal(r.code, 0)
  const after = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(after.outcome, 'folded')
  assert.deepEqual({ ...after, outcome: 'pending' }, before)
})

test('outcome refuses a second update (A3: single mutation)', () => {
  const { formFile, root } = setup()
  const file = run(['new', '--form', formFile, '--digest', 'd', '--root', root]).out.trim()
  run(['outcome', file, 'void'])
  const r = run(['outcome', file, 'folded'])
  assert.equal(r.code, 1)
})

test('outcome rejects an unknown value', () => {
  const { formFile, root } = setup()
  const file = run(['new', '--form', formFile, '--digest', 'd', '--root', root]).out.trim()
  const r = run(['outcome', file, 'great'])
  assert.equal(r.code, 2)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test plugins/salvo/tests/residue.test.mjs`
Expected: all 4 FAIL.

- [ ] **Step 3: Write the implementation**

Create `plugins/salvo/skills/salvo/scripts/residue.mjs`:

```js
#!/usr/bin/env node
// ResidueRecord I/O (SPEC 003 §2.4). ONE JSON shape everywhere (M10):
// {form, fired_at, digest, outcome} — a preset weapon's intake-form.json is
// the same shape, so promotion is a file copy plus a skill wrapper.
//   new     --form <form.json> --digest "<sentence>" [--root <dir>]
//   outcome <record.json> <folded|void|delegated>
// The outcome update is the only permitted mutation of a residue file (A3).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

// D-6: user-level data directory — survives plugin updates, accumulates
// promotion evidence across projects.
const DEFAULT_ROOT = path.join(homedir(), '.claude/plugins/data/salvo-chenjing-plugins/residue')

const [cmd, ...rest] = process.argv.slice(2)
const opt = name => {
  const i = rest.indexOf(name)
  return i === -1 ? null : rest[i + 1]
}

if (cmd === 'new') {
  const formPath = opt('--form')
  const digest = opt('--digest')
  if (!formPath || !digest) {
    console.error('usage: residue.mjs new --form <form.json> --digest "<sentence>" [--root <dir>]')
    process.exit(2)
  }
  const form = JSON.parse(readFileSync(formPath, 'utf8'))
  const root = opt('--root') ?? DEFAULT_ROOT
  const fired_at = new Date().toISOString()
  const stamp = fired_at.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') // sortable (S3)
  const slug = digest.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '').slice(0, 40)
  const file = path.join(root, `${stamp}-${slug}.json`)
  mkdirSync(root, { recursive: true })
  if (existsSync(file)) {
    console.error(`refusing to overwrite ${file}`)
    process.exit(1)
  }
  writeFileSync(file, JSON.stringify({ form, fired_at, digest, outcome: 'pending' }, null, 2) + '\n')
  console.log(file)
} else if (cmd === 'outcome') {
  const [file, value] = rest
  if (!file || !['folded', 'void', 'delegated'].includes(value)) {
    console.error('usage: residue.mjs outcome <record.json> <folded|void|delegated>')
    process.exit(2)
  }
  const record = JSON.parse(readFileSync(file, 'utf8'))
  if (record.outcome !== 'pending') {
    console.error(`outcome already ${record.outcome} — a residue file permits exactly one mutation (A3)`)
    process.exit(1)
  }
  record.outcome = value
  writeFileSync(file, JSON.stringify(record, null, 2) + '\n')
  console.log(`outcome: ${value}`)
} else {
  console.error('usage: residue.mjs new|outcome …')
  process.exit(2)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test plugins/salvo/tests/residue.test.mjs`
Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/salvo/skills/salvo/scripts/residue.mjs plugins/salvo/tests/residue.test.mjs
git commit -m "feat(salvo): residue.mjs — 잔해 기록 생성·outcome 단일 변이 (M5·M10·S3·A3)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `volley-workflow.js` — fire + validate + fold for `none`/`union`/`vote`

The heart of the platform: one static Workflow script (invoked via `scriptPath` + `args`), so the session authors no code per firing. A test harness runs the real script file under `node:test` with a mocked `agent()` — the fold logic is tested exactly as it ships.

**Files:**
- Create: `plugins/salvo/tests/harness.mjs`
- Create: `plugins/salvo/skills/salvo/references/volley-workflow.js`
- Test: `plugins/salvo/tests/volley_fold.test.mjs`

**Interfaces:**
- Consumes: args `{form, shooterPrompt, target, model}` (Canonical Data Shapes).
- Produces: return kinds `single` / `folded` / `void` (Canonical Data Shapes). Task 6 extends this same file with the `pick` paths; until then the pick branch throws `new Error('pick: implemented in the next commit')` as an explicit boundary.
- Workflow sandbox rules apply: no `Date.now`/`Math.random`/`new Date()`, no fs/Node APIs, `meta` is a pure literal, globals `agent`/`parallel`/`log`/`phase`/`args`/`budget`.

- [ ] **Step 1: Write the test harness**

Create `plugins/salvo/tests/harness.mjs`:

```js
// Runs the REAL volley-workflow.js file under node:test with mocked globals,
// so the fold logic is tested exactly as it ships to the Workflow sandbox.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)),
  '../skills/salvo/references/volley-workflow.js')

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

// agentImpl(prompt, opts, callIndex) -> mock output object/string, or null for
// a failed shooter. Returns { result, calls } where calls = [{prompt, opts}].
export async function runVolley(args, agentImpl) {
  const src = readFileSync(SCRIPT, 'utf8').replace(/^export /m, '')
  const calls = []
  const agent = async (prompt, opts = {}) => {
    calls.push({ prompt, opts })
    return agentImpl(prompt, opts, calls.length - 1)
  }
  const parallel = async thunks => Promise.all(thunks.map(t => t().catch(() => null)))
  const pipeline = async () => { throw new Error('pipeline is not used by volley-workflow') }
  const log = () => {}
  const phase = () => {}
  const budget = { total: null, spent: () => 0, remaining: () => Infinity }
  const fn = new AsyncFunction('agent', 'parallel', 'pipeline', 'log', 'phase', 'args', 'budget', src)
  const result = await fn(agent, parallel, pipeline, log, phase, args, budget)
  return { result, calls }
}
```

- [ ] **Step 2: Write the failing tests**

Create `plugins/salvo/tests/volley_fold.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runVolley } from './harness.mjs'

const unionForm = (over = {}) => ({
  definition: 'Enumerates contradictions, one finding per section.',
  fold: 'union',
  volley: 3,
  isolation: 'sealed',
  invention: 'forbidden',
  criteria_from: 'request',
  anchors: { kind: 'closed_list', values: ['A', 'B', 'C'], source: 'test' },
  residual: '',
  ...over,
})

test('fold none (volley 1) passes the single result through, schema-free', async () => {
  const form = {
    definition: 'Renames a function across the repo.',
    fold: 'none', volley: 1, isolation: 'tooled', invention: 'allowed',
    criteria_from: 'request', residual: '',
  }
  const { result, calls } = await runVolley(
    { form, shooterPrompt: 'DO THE WORK', target: null, model: null },
    () => 'work done, 12 files changed')
  assert.equal(result.kind, 'single')
  assert.equal(result.result, 'work done, 12 files changed')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].opts.schema, undefined)
  assert.equal(calls[0].opts.agentType, undefined) // tooled -> default agent
})

test('union: dedup by closed-list anchor, counts distinct shooters, sealed agentType, enum in schema', async () => {
  const byShot = {
    'shot:1': { findings: [{ anchor: 'A', content: 'x1' }, { anchor: 'B', content: 'y1' }] },
    'shot:2': { findings: [{ anchor: 'A', content: 'x2' }] },
    'shot:3': { findings: [{ anchor: 'C', content: 'z3' }, { anchor: 'A', content: 'x3' }] },
  }
  const { result, calls } = await runVolley(
    { form: unionForm(), shooterPrompt: 'P', target: null, model: null },
    (prompt, opts) => byShot[opts.label])
  assert.equal(result.kind, 'folded')
  assert.equal(result.fold, 'union')
  assert.equal(result.volley, 3)
  assert.equal(result.items.length, 3)
  const a = result.items[0]
  assert.equal(a.anchor, 'A')
  assert.equal(a.count, 3)
  assert.equal(a.entries.length, 3)
  assert.equal(calls.length, 3)
  for (const c of calls) {
    assert.equal(c.opts.agentType, 'salvo:shooter') // sealed -> starved no-tools agent
    assert.deepEqual(c.opts.schema.properties.findings.items.properties.anchor.enum, ['A', 'B', 'C'])
  }
})

test('vote: keeps items with count >= threshold, reports dropped groups', async () => {
  const byShot = {
    'shot:1': { findings: [{ anchor: 'A', content: 'x1' }, { anchor: 'B', content: 'y1' }] },
    'shot:2': { findings: [{ anchor: 'A', content: 'x2' }, { anchor: 'B', content: 'y2' }] },
    'shot:3': { findings: [{ anchor: 'A', content: 'x3' }, { anchor: 'C', content: 'z3' }] },
  }
  const { result } = await runVolley(
    { form: unionForm({ fold: 'vote', vote_threshold: 2 }), shooterPrompt: 'P', target: null, model: null },
    (prompt, opts) => byShot[opts.label])
  assert.equal(result.kind, 'folded')
  assert.equal(result.fold, 'vote')
  assert.equal(result.threshold, 2)
  assert.deepEqual(result.items.map(i => [i.anchor, i.count]), [['A', 3], ['B', 2]])
  assert.equal(result.dropped, 1)
})

test('void: one failed shooter voids the volley with no partial items (M8/AC6)', async () => {
  const { result } = await runVolley(
    { form: unionForm(), shooterPrompt: 'P', target: null, model: null },
    (prompt, opts) => (opts.label === 'shot:2' ? null
      : { findings: [{ anchor: 'A', content: 'x' }] }))
  assert.equal(result.kind, 'void')
  assert.match(result.reason, /2/)
  assert.equal(result.items, undefined)
})

const TARGET = 'The quick brown fox jumps over the lazy dog'
const quoteForm = () => unionForm({ anchors: { kind: 'quote' } })

test('quote anchors: non-verbatim anchor triggers a corrective re-request (M11), spans overlap-merge', async () => {
  let shot2Calls = 0
  const impl = (prompt, opts) => {
    if (opts.label === 'shot:2') {
      shot2Calls++
      if (shot2Calls === 1) return { findings: [{ anchor: 'purple cow', content: 'bad' }] }
      return { findings: [{ anchor: 'brown fox', content: 'good' }] }
    }
    if (opts.label === 'shot:1') return { findings: [{ anchor: 'quick brown fox', content: 'c1' }] }
    return { findings: [{ anchor: 'lazy dog', content: 'c3' }] }
  }
  const { result, calls } = await runVolley(
    { form: quoteForm(), shooterPrompt: 'P', target: TARGET, model: null }, impl)
  assert.equal(calls.length, 4) // 3 shots + 1 re-request
  const reRequest = calls.filter(c => c.opts.label === 'shot:2')[1]
  assert.match(reRequest.prompt, /purple cow/) // corrective prompt names the bad anchor
  assert.equal(result.kind, 'folded')
  assert.equal(result.items.length, 2) // 'quick brown fox' + 'brown fox' overlap-merged
  assert.equal(result.items[0].anchor, 'quick brown fox') // longer member represents the group
  assert.equal(result.items[0].count, 2)
})

test('quote anchors: persistently non-conforming shooter voids the volley after 2 re-requests', async () => {
  const impl = (prompt, opts) =>
    opts.label === 'shot:2'
      ? { findings: [{ anchor: 'purple cow', content: 'bad' }] }
      : { findings: [{ anchor: 'lazy dog', content: 'ok' }] }
  const { result, calls } = await runVolley(
    { form: quoteForm(), shooterPrompt: 'P', target: TARGET, model: null }, impl)
  assert.equal(result.kind, 'void')
  assert.equal(calls.filter(c => c.opts.label === 'shot:2').length, 3) // initial + 2 re-requests
})

test('model override rides through to every agent call (A5)', async () => {
  const { calls } = await runVolley(
    { form: unionForm(), shooterPrompt: 'P', target: null, model: 'haiku' },
    () => ({ findings: [{ anchor: 'A', content: 'x' }] }))
  for (const c of calls) assert.equal(c.opts.model, 'haiku')
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test plugins/salvo/tests/volley_fold.test.mjs`
Expected: all FAIL (`volley-workflow.js` missing → harness readFileSync throws).

- [ ] **Step 4: Write the workflow script**

Create `plugins/salvo/skills/salvo/references/volley-workflow.js`:

```js
export const meta = {
  name: 'salvo-volley',
  description: 'Fire N starved shooters in parallel and fold their outputs by code',
  phases: [
    { title: 'Fire', detail: 'N starved shooters in parallel' },
    { title: 'Fold', detail: 'code tally / judge pick' },
  ],
}

// args (built by the /salvo door from the intake form):
//   form: IntakeForm            — the completed form, verbatim
//   shooterPrompt: string       — the ONLY thing a shooter ever sees (M2)
//   target: string|null         — target text; required when anchors.kind === 'quote'
//   model: string|null          — tier override only when the user named one (A5)
//
// Returns exactly one of (see SKILL.md §6):
//   {kind:'single', result} | {kind:'folded', ...} | {kind:'picked', ...}
//   | {kind:'candidates', ...} | {kind:'void', reason}

const form = args.form
const N = form.volley
const sealed = form.isolation === 'sealed'

// Sealed shooters run as the no-tools salvo:shooter agent; tooled shooters use
// the default workflow agent. Both are starved of conversation history by
// construction — the prompt is all they get (M2).
const agentOpts = () => {
  const o = {}
  if (sealed) o.agentType = 'salvo:shooter'
  if (args.model) o.model = args.model
  return o
}

// Dispatch-layer conformance re-requests (M11). Never a retry of a *failed*
// shooter (M8) — only a rejection of non-conforming output at the source.
const RE_REQUESTS = 2

phase('Fire')

// ---- fold: none (volley 1 — delegation / single shot) ----------------------
if (form.fold === 'none') {
  const result = await agent(args.shooterPrompt, { ...agentOpts(), label: 'shot:1', phase: 'Fire' })
  if (result === null) return { kind: 'void', reason: 'the single shooter failed to complete' }
  return { kind: 'single', result }
}

// ---- fold: union / vote (counting — pure code, M1) --------------------------
if (form.fold === 'union' || form.fold === 'vote') {
  const FINDINGS = {
    type: 'object',
    additionalProperties: false,
    required: ['findings'],
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['anchor', 'content'],
          properties: {
            // Closed-list vocabularies are enforced INSIDE the schema (I-6);
            // quote vocabularies are substring-validated below.
            anchor: form.anchors.kind === 'closed_list'
              ? { type: 'string', enum: form.anchors.values }
              : { type: 'string', minLength: 1 },
            content: { type: 'string', minLength: 1 },
          },
        },
      },
    },
  }

  const quoteInvalid = findings =>
    findings.filter(f => !args.target.includes(f.anchor)).map(f => f.anchor)

  const fireOne = async i => {
    let prompt = args.shooterPrompt
    for (let attempt = 0; attempt <= RE_REQUESTS; attempt++) {
      const out = await agent(prompt, { ...agentOpts(), schema: FINDINGS, label: `shot:${i + 1}`, phase: 'Fire' })
      if (out === null) return null // shooter failed — no retry (M8)
      if (form.anchors.kind === 'closed_list') return out.findings
      const bad = quoteInvalid(out.findings)
      if (bad.length === 0) return out.findings
      log(`shot:${i + 1} returned ${bad.length} non-verbatim anchor(s); re-requesting (${attempt + 1}/${RE_REQUESTS})`)
      prompt = args.shooterPrompt +
        `\n\nYour previous output was rejected: these anchor values are not verbatim substrings of the target: ${JSON.stringify(bad)}. Every anchor must be copied character-for-character from the target text.`
    }
    return null // still non-conforming after re-requests → counts as failed (M11)
  }

  const perShooter = await parallel(Array.from({ length: N }, (_, i) => () => fireOne(i)))
  const failed = perShooter.map((r, i) => (r === null ? i + 1 : null)).filter(x => x !== null)
  if (failed.length > 0) {
    return { kind: 'void', reason: `shooter(s) ${failed.join(', ')} failed or stayed non-conforming — no partial fold` }
  }

  phase('Fold')
  // Anchor identity: exact equality for closed lists; exact equality or span
  // overlap for quotes (both anchors are verified substrings by now).
  const span = anchor => {
    const start = args.target.indexOf(anchor)
    return [start, start + anchor.length]
  }
  const sameAnchor = (a, b) => {
    if (form.anchors.kind === 'closed_list') return a === b
    if (a === b) return true
    const [s1, e1] = span(a)
    const [s2, e2] = span(b)
    return s1 < e2 && s2 < e1
  }
  const groups = []
  perShooter.forEach((findings, shooter) => {
    for (const f of findings) {
      const g = groups.find(g => sameAnchor(g.anchor, f.anchor))
      if (g) {
        if (f.anchor.length > g.anchor.length) g.anchor = f.anchor // longest member represents the group
        g.entries.push({ shooter: shooter + 1, anchor: f.anchor, content: f.content })
      } else {
        groups.push({ anchor: f.anchor, entries: [{ shooter: shooter + 1, anchor: f.anchor, content: f.content }] })
      }
    }
  })
  for (const g of groups) g.count = new Set(g.entries.map(e => e.shooter)).size

  if (form.fold === 'union') {
    return {
      kind: 'folded', fold: 'union', volley: N,
      items: groups.map(g => ({ anchor: g.anchor, count: g.count, entries: g.entries })),
    }
  }
  const kept = groups.filter(g => g.count >= form.vote_threshold)
  return {
    kind: 'folded', fold: 'vote', volley: N, threshold: form.vote_threshold,
    items: kept.map(g => ({ anchor: g.anchor, count: g.count, entries: g.entries })),
    dropped: groups.length - kept.length,
  }
}

// ---- fold: pick -------------------------------------------------------------
throw new Error('pick: implemented in the next commit')
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test plugins/salvo/tests/volley_fold.test.mjs`
Expected: all 7 PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/salvo/tests/harness.mjs plugins/salvo/tests/volley_fold.test.mjs plugins/salvo/skills/salvo/references/volley-workflow.js
git commit -m "feat(salvo): volley-workflow.js — none/union/vote 발사·스키마 검증·코드 접기 (M1·M2·M8·M11)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: pick paths — judged (in-workflow judge) + mechanical (`pick_command.mjs`)

**Files:**
- Modify: `plugins/salvo/skills/salvo/references/volley-workflow.js` (replace the trailing `throw` with the pick section)
- Create: `plugins/salvo/skills/salvo/scripts/pick_command.mjs`
- Test: `plugins/salvo/tests/volley_pick.test.mjs`, `plugins/salvo/tests/pick_command.test.mjs`

**Interfaces:**
- Consumes: harness (Task 5), pick form shape (Task 2).
- Produces: return kinds `picked` / `candidates` (Canonical Data Shapes); CLI `node pick_command.mjs --command "<cmd with {candidate}>" <file…>` → prints `{"choice": <index>, "passed": [indices]}`; exit 1 when nothing passes. Deterministic tie-break: first passing candidate in argument order.

- [ ] **Step 1: Write the failing workflow tests**

Create `plugins/salvo/tests/volley_pick.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runVolley } from './harness.mjs'

const pickForm = (pick) => ({
  definition: 'Drafts a README intro and keeps the best of N.',
  fold: 'pick',
  pick,
  volley: 3,
  isolation: 'sealed',
  invention: 'allowed',
  criteria_from: 'request',
  residual: '',
})

test('judged pick: one starved judge sees only candidates + criterion, selection labeled by route', async () => {
  const impl = (prompt, opts) => {
    if (opts.label === 'judge') return { choice: 2, grounds: 'plainest wording' }
    return { candidate: `intro ${opts.label}` }
  }
  const { result, calls } = await runVolley(
    { form: pickForm({ criterion: 'the clearest intro', route: 'judged' }), shooterPrompt: 'WRITE', target: null, model: null },
    impl)
  assert.equal(result.kind, 'picked')
  assert.equal(result.route, 'judged')
  assert.equal(result.choice, 1) // 1-based judge answer -> 0-based index
  assert.equal(result.grounds, 'plainest wording')
  assert.equal(result.candidates.length, 3)
  assert.equal(calls.length, 4)
  const judge = calls.find(c => c.opts.label === 'judge')
  assert.equal(judge.opts.agentType, 'salvo:shooter') // starved judge (M2)
  assert.match(judge.prompt, /the clearest intro/)
  assert.match(judge.prompt, /CANDIDATE 2/)
  assert.ok(!judge.prompt.includes('WRITE')) // judge never sees the shooter prompt
})

test('judged pick: judge failure voids the volley', async () => {
  const impl = (prompt, opts) => (opts.label === 'judge' ? null : { candidate: 'c' })
  const { result } = await runVolley(
    { form: pickForm({ criterion: 'clearest', route: 'judged' }), shooterPrompt: 'W', target: null, model: null },
    impl)
  assert.equal(result.kind, 'void')
})

test('mechanical pick, shortest program: pure JS selection, no judge call', async () => {
  const byShot = { 'shot:1': 'bbb', 'shot:2': 'a', 'shot:3': 'cc' }
  const { result, calls } = await runVolley(
    { form: pickForm({ criterion: 'shortest draft', route: 'mechanical', program: { kind: 'shortest' } }), shooterPrompt: 'W', target: null, model: null },
    (prompt, opts) => ({ candidate: byShot[opts.label] }))
  assert.equal(result.kind, 'picked')
  assert.equal(result.route, 'mechanical')
  assert.equal(result.program, 'shortest')
  assert.equal(result.choice, 1)
  assert.equal(calls.length, 3) // no judge
})

test('mechanical pick, command program: returns candidates for outside evaluation', async () => {
  const { result, calls } = await runVolley(
    { form: pickForm({ criterion: 'passes the check', route: 'mechanical', program: { kind: 'command', command: 'node --check {candidate}' } }), shooterPrompt: 'W', target: null, model: null },
    (prompt, opts) => ({ candidate: `code ${opts.label}` }))
  assert.equal(result.kind, 'candidates')
  assert.equal(result.program, 'command')
  assert.equal(result.candidates.length, 3)
  assert.equal(calls.length, 3)
})

test('pick: a failed shooter voids before any selection', async () => {
  const { result } = await runVolley(
    { form: pickForm({ criterion: 'clearest', route: 'judged' }), shooterPrompt: 'W', target: null, model: null },
    (prompt, opts) => (opts.label === 'shot:3' ? null : { candidate: 'c' }))
  assert.equal(result.kind, 'void')
  assert.match(result.reason, /3/)
})
```

Create `plugins/salvo/tests/pick_command.test.mjs`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test plugins/salvo/tests/volley_pick.test.mjs plugins/salvo/tests/pick_command.test.mjs`
Expected: volley_pick tests FAIL on the `throw` boundary; pick_command tests FAIL (script missing).

- [ ] **Step 3: Implement the pick section**

In `plugins/salvo/skills/salvo/references/volley-workflow.js`, replace the final line

```js
throw new Error('pick: implemented in the next commit')
```

with:

```js
// Each shooter returns one complete candidate artifact (§2.3).
const CANDIDATE = {
  type: 'object',
  additionalProperties: false,
  required: ['candidate'],
  properties: { candidate: { type: 'string', minLength: 1 } },
}
const shots = await parallel(Array.from({ length: N }, (_, i) => () =>
  agent(args.shooterPrompt, { ...agentOpts(), schema: CANDIDATE, label: `shot:${i + 1}`, phase: 'Fire' })))
const failedShots = shots.map((r, i) => (r === null ? i + 1 : null)).filter(x => x !== null)
if (failedShots.length > 0) {
  return { kind: 'void', reason: `shooter(s) ${failedShots.join(', ')} failed — no partial fold` }
}
const candidates = shots.map(s => s.candidate)

phase('Fold')
const pick = form.pick
if (pick.route === 'mechanical') {
  if (pick.program.kind === 'shortest' || pick.program.kind === 'longest') {
    let choice = 0
    for (let i = 1; i < candidates.length; i++) {
      const better = pick.program.kind === 'shortest'
        ? candidates[i].length < candidates[choice].length
        : candidates[i].length > candidates[choice].length
      if (better) choice = i
    }
    return { kind: 'picked', route: 'mechanical', program: pick.program.kind, choice, candidates }
  }
  // kind === 'command': the stated test command must run outside this sandbox —
  // hand the conforming candidates back for scripts/pick_command.mjs.
  return { kind: 'candidates', route: 'mechanical', program: 'command', candidates }
}

// route === 'judged': ONE starved judge — candidates + criterion text only (M2).
// A judge failure voids the volley like a shooter failure (§4 step 10).
const judgePrompt = [
  'You are the judge of a salvo pick. Select exactly one candidate by this criterion:',
  pick.criterion,
  '',
  ...candidates.map((c, i) => `--- CANDIDATE ${i + 1} ---\n${c}`),
  '',
  `Return the chosen candidate's number (1-${N}) and one sentence of grounds.`,
].join('\n')
const judgeOpts = { agentType: 'salvo:shooter', label: 'judge', phase: 'Fold' }
if (args.model) judgeOpts.model = args.model
const verdict = await agent(judgePrompt, {
  ...judgeOpts,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['choice', 'grounds'],
    properties: {
      choice: { type: 'integer', minimum: 1, maximum: N },
      grounds: { type: 'string' },
    },
  },
})
if (verdict === null) return { kind: 'void', reason: 'the pick judge failed — no selection' }
return { kind: 'picked', route: 'judged', choice: verdict.choice - 1, grounds: verdict.grounds, candidates }
```

- [ ] **Step 4: Implement `pick_command.mjs`**

Create `plugins/salvo/skills/salvo/scripts/pick_command.mjs`:

```js
#!/usr/bin/env node
// Mechanical pick, command kind (SPEC 003 §2.1 pick_criterion, I-7): runs the
// stated test command once per candidate file ({candidate} placeholder) and
// deterministically picks the FIRST passing candidate in argument order.
// usage: pick_command.mjs --command "<cmd with {candidate}>" <file…>
// Prints {"choice": <index>, "passed": [indices]}; exit 1 if nothing passes.
import { execSync } from 'node:child_process'

const argv = process.argv.slice(2)
const i = argv.indexOf('--command')
const command = i === -1 ? null : argv[i + 1]
const files = argv.filter((_, j) => j !== i && j !== i + 1)
if (!command || files.length === 0) {
  console.error('usage: pick_command.mjs --command "<cmd with {candidate}>" <file…>')
  process.exit(2)
}

const passed = []
for (let j = 0; j < files.length; j++) {
  try {
    execSync(command.replaceAll('{candidate}', files[j]), { stdio: 'pipe', timeout: 120000 })
    passed.push(j)
  } catch {
    // non-zero exit = this candidate fails the criterion
  }
}
if (passed.length === 0) {
  console.error('no candidate passed the stated command')
  process.exit(1)
}
console.log(JSON.stringify({ choice: passed[0], passed }))
```

- [ ] **Step 5: Run the full suite**

Run: `node --test 'plugins/salvo/tests/*.test.mjs'`
Expected: every test from Tasks 2–6 PASSES.

- [ ] **Step 6: Commit**

```bash
git add plugins/salvo/skills/salvo/references/volley-workflow.js plugins/salvo/skills/salvo/scripts/pick_command.mjs plugins/salvo/tests/volley_pick.test.mjs plugins/salvo/tests/pick_command.test.mjs
git commit -m "feat(salvo): pick 경로 — 판단 선택 심판 + 기계 선택 pick_command.mjs (I-7)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: the door — `SKILL.md`, sealed shooter agent, shooter prompt template

Prose task (no unit tests): the acceptance gate is the coverage checklist in Step 5.

**Files:**
- Create: `plugins/salvo/agents/shooter.md`
- Create: `plugins/salvo/skills/salvo/references/shooter-prompt-template.md`
- Create: `plugins/salvo/skills/salvo/SKILL.md`

**Interfaces:**
- Consumes: every CLI and shape from Tasks 2–6 (paths as written below — they are exact).
- Produces: agent type `salvo:shooter` (referenced by volley-workflow.js — the name MUST stay `shooter.md` / `name: shooter`).

- [ ] **Step 1: Create the sealed shooter agent**

Create `plugins/salvo/agents/shooter.md`:

```markdown
---
name: shooter
description: A starved shooter for /salvo sealed volleys — receives only its shooter prompt (target content embedded), no conversation context and no tools, and returns machine-parseable output. Also serves as the starved judge for judged picks. Spawned by the salvo volley workflow.
tools: []
---

You are one shooter in a salvo volley. The single prompt you receive contains
everything you may use: the task definition, the criteria, and the target
content. You have no conversation context and no tools — work only from what
the prompt contains. Your output is machine-processed: return exactly what the
prompt's output instruction asks for (via the structured output tool when one
is provided), with no greetings or commentary.
```

Note: no `model:` line — shooters follow harness defaults unless the user names a tier (A5).

- [ ] **Step 2: Create the shooter prompt template**

Create `plugins/salvo/skills/salvo/references/shooter-prompt-template.md`:

```markdown
<!-- Shooter prompt template. The door replaces each {{PLACEHOLDER}} and
     deletes every HTML comment before dispatch. The finished prompt is the
     ONLY thing a shooter sees (M2) — anything not written here does not
     exist for the shooter. -->

# Task

{{DEFINITION}}
<!-- the form's definition, verbatim -->

## Criteria

{{CRITERIA}}
<!-- criteria_from = request  : the user's request text, quoted.
     criteria_from = document : sealed → the document content, embedded here;
                                tooled → the document's path.
     criteria_from = shooter  : "Judge by your own reading; state the grounds
                                 for each item." -->

## Target

{{TARGET}}
<!-- sealed : the full target content, embedded (this is all the shooter gets).
     tooled : the repository path(s) plus exactly what the shooter may touch
              (read, edit, run tests…). -->

## Rules

{{RULES}}
<!-- Compose from the form, one line each, dropping lines that do not apply:
     invention = forbidden → "Report only what is present in the target. Point
       at it with an anchor; add nothing the target does not contain."
     fold = union/vote + closed_list → "Anchor every finding to exactly one of
       the allowed anchor values (they appear in your output schema)."
     fold = union/vote + quote → "Anchor every finding with a verbatim quote
       from the target, copied character-for-character."
     residual non-empty → the residual text, verbatim. -->

## Output

{{OUTPUT}}
<!-- fold = union/vote : "Return your findings via the structured output tool:
       a list of {anchor, content} records — one record per finding."
     fold = pick       : "Return one complete candidate via the structured
       output tool."
     fold = none       : describe the deliverable and where to leave it
       (files edited in place, a summary as your final text, …). -->
```

- [ ] **Step 3: Create the door SKILL.md**

Create `plugins/salvo/skills/salvo/SKILL.md`:

````markdown
---
name: salvo
description: "The salvo door — state work in plain language and the platform routes it: fires a preset weapon, forges an improvised weapon (N independent starved shooters + a declared fold, counted by code), dispatches a single-shot delegation, refers spec work to /spec, or names why it cannot fire. Use this whenever the user invokes /salvo, wants work fanned out to several independent agents and merged, wants a measured (recountable) result instead of one model's opinion, or wants work done outside the current session. Usage: /salvo <request>"
---

# /salvo — the weapon-platform door

One shot is a guess; a salvo — N independent passes folded by pure code — is a
measurement. This skill is the single door: every request becomes an intake
form (신고서), and the form itself is the routing decision.

**First principle (제1원칙)**: this session routes, announces, transcribes,
and archives. The shots run in ONE Workflow call and every count comes out of
code — the workflow script and the bundled scripts — which is what keeps each
number recountable and this session's context clean enough to stay a fair
courier.

**Language**: announcement and report in the user's conversation language;
forms and residue in English (machine-facing, A6).

Paths: `<base>` = this skill's base directory. Residue lives at
`~/.claude/plugins/data/salvo-chenjing-plugins/residue/` (D-6; the default of
`residue.mjs`).

## 1. Route

Decide in this order:

1. **Spec-shaped request** — the asked-for deliverable is a design or spec
   document → point the user to `/salvo:spec` and stop. No form, no residue.
2. **Preset scan** — list sibling skills carrying a form:
   `ls <base>/../*/intake-form.json`. Read each file's `.form.definition` and
   compare it against the request (this comparison is routing judgment — the
   code-only rule M1 binds the fold, not routing). On a match, use that form
   as-is and continue at §4; the announcement names the preset — that is how
   the user sees preset priority. (v1 ships zero presets, so today this falls
   through.)
3. Otherwise — **forge** an improvised weapon (§2).

## 2. Forge

The routing decision IS the form: whether this request is a measurement, a
delegation, or unfillable is discovered by trying to fill the fields, in this
order.

1. **definition** — 1–2 sentences naming the input target and the output
   shape.
2. **fold** — ask what the shooter outputs can be merged on:
   - Findings matchable on an identity key → `union` (enumerate everything
     found) or `vote` (keep what ≥ threshold shooters independently agree
     on — choose vote when the user asks for confidence over coverage;
     default `vote_threshold` = majority, floor(volley/2) + 1, S1).
   - N complete artifacts of which one should survive → `pick`, plus
     `pick.criterion` and its route: `mechanical` when the criterion maps to
     a program — set `pick.program` to `{"kind":"shortest"}`,
     `{"kind":"longest"}`, or `{"kind":"command","command":"<cmd with
     {candidate}>"}` (a stated test command). A criterion that maps to no
     program routes `judged` — a starved judge selects and the report says
     so.
   - No fold, but the work runs unattended in another session → delegation:
     `volley: 1`, `fold: "none"`.
   - The work needs the user mid-execution (co-editing, mid-course decisions
     only the user can make) → **reject**: name the unfillable aspect in one
     line, suggest a plain session, stop. No dispatch, no residue.
3. **volley** — default 3; above 5 only when the user explicitly asked for
   that scale.
4. **isolation** — `sealed` whenever the target content fits in the shooter
   prompt (embed it — sealing is what guarantees independence, S5); `tooled`
   only when the work must touch the repository or environment (search,
   edits, running tests).
5. **invention** — `forbidden` for inspection weapons (shooters report only
   what is in the target); `allowed` for generation and delegation.
6. **criteria_from** — `request` (embed the user's request text), `document`
   (+ `criteria_ref` path — the document must exist, C5), or `shooter` (the
   shooter's own judgment).
7. **anchors** (only for `union`/`vote`) — declare a code-checkable
   vocabulary (C6):
   - closed list:
     `node <base>/scripts/extract_anchors.mjs <target> --mode headings`
     (or `--mode regex --pattern '<re>'`); put the printed array into
     `anchors.values` with `"kind": "closed_list"` and note the extraction in
     `anchors.source`. The values land in the shooter output schema as the
     allowed anchors.
   - or `"kind": "quote"` — shooters anchor by verbatim quotation and the
     workflow validates every quote as a substring of the target.
8. **residual** — any constraint no field above carries, or `""`. It rides
   into the shooter prompt's Rules block and stays in the residue as the
   form-evolution signal.

Write the finished form as JSON to a temp file (shape below — the same shape
`check_form.mjs` validates):

```json
{
  "definition": "…", "fold": "union|vote|pick|none",
  "vote_threshold": 2, "pick": { "criterion": "…", "route": "…", "program": { "kind": "…" } },
  "volley": 3, "isolation": "sealed|tooled", "invention": "forbidden|allowed",
  "criteria_from": "request|document|shooter", "criteria_ref": "…",
  "anchors": { "kind": "closed_list|quote", "values": ["…"], "source": "…" },
  "residual": ""
}
```

(Conditional fields appear only where their condition holds — `check_form.mjs`
rejects both missing-when-required and present-when-forbidden.)

## 3. Coherence — run the code, not your judgment

`node <base>/scripts/check_form.mjs <form.json>` — prints `OK` or the violated
rules. On a violation: re-draft the form once, silently, and re-run. On a
second violation: reject — report the violated rule to the user
(`rejected_incoherent`) and stop. A missing `criteria_ref` document is C5
(`rejected_missing_target`).

## 4. Residue before dispatch (M5)

```
node <base>/scripts/residue.mjs new --form <form.json> --digest "<one-sentence digest of the request>"
```

It prints the record path — keep it for the outcome update (§7). The record
is on disk before any shooter exists, so even an interrupted firing leaves
its trace.

## 5. Announce, then fire (M7)

Print exactly one line in the user's language — definition digest, volley
count, fold rule; name the preset if one matched. Then fire immediately: the
announcement is the user's chance to interrupt, so it stands in for asking
permission. Example: `발사: "plan.md의 모순 열거" — 3발, union 접기`.

## 6. Fire — one Workflow call (M4)

1. Build the shooter prompt from
   `<base>/references/shooter-prompt-template.md`: replace the placeholders
   per its comments, then delete the comments. Sealed forms embed the full
   target content — the finished prompt is everything a shooter will ever
   see (M2).
2. Call the Workflow tool with:
   - `scriptPath`: `<base>/references/volley-workflow.js`
   - `args`: `{ "form": <the form>, "shooterPrompt": "<the prompt>",
     "target": <target text when anchors.kind is "quote", else null>,
     "model": <tier name only when the user named one, else null> }`
   The script fires N shooters in parallel (sealed → the no-tools
   `salvo:shooter` agent; tooled → the default agent), enforces the output
   schema at the dispatch layer (closed-list anchors as a schema enum; quote
   anchors substring-validated with up to 2 conformance re-requests), requires
   all N to succeed, and folds by code (M1/M11). A volley can take minutes —
   wait for it.
3. Act on the returned object's `kind`:
   - `folded` / `single` / `picked` → report (§7).
   - `candidates` (mechanical pick, command program) → write each candidate to
     a temp file and run
     `node <base>/scripts/pick_command.mjs --command '<the stated command>' <files…>`;
     the printed `choice` names the winner. Report as a mechanical pick.
   - `void` → report the failure only (§7).

## 7. Report, then close the residue

Transcribe the returned object — every number in the report comes from the
script, none from your own recount:

- **folded**: header `N발 일제사격, {union|vote} 접기` (for vote add the
  threshold and how many groups fell below it), then each item as its anchor,
  its count, and the contributing contents. Echo the announcement's
  definition digest so the user can match report to residue (S4).
- **picked**: show the selected candidate with the criterion text, labeled
  `기계 선택` (mechanical — name the program) or `판단 선택` (judged — quote
  the judge's grounds) (M6).
- **single**: the raw result plus the literal label `한 발은 짐작` (M6).
- **void**: state which shooter failed and that no partial fold exists;
  re-firing is the user's explicit choice (M8).

Then close the record:

```
node <base>/scripts/residue.mjs outcome <record-path> <folded|void|delegated>
```

`folded` for measurements and picks, `delegated` for volley-1 dispatches,
`void` for failures.

## What keeps the platform honest

- Counting lives in code (`volley-workflow.js`, `scripts/`) — the overlap
  count is the platform's only added information over a single pass, and it
  stays recountable because no LLM touches it (M1).
- Shooters and the judge see only their own prompt (M2): starving them is
  what makes N shots N independent measurements instead of one opinion echoed
  N times.
- A failed shooter voids the whole volley (M8): a partial fold would report a
  denominator that never fired.
- Every dispatch passes through the same form (M9) and leaves residue before
  firing (M5) — the residue pile, not design taste, decides which weapons
  earn promotion to presets.
````

- [ ] **Step 4: Run the full suite (regression)**

Run: `node --test 'plugins/salvo/tests/*.test.mjs'`
Expected: all tests still PASS (this task adds no code the tests touch, but the volley tests reference `salvo:shooter`, which now exists as `agents/shooter.md` — name match is what matters).

- [ ] **Step 5: Coverage checklist (self-verify against the spec)**

Confirm each row has its implementing artifact; fix in place if not:

| Spec clause | Artifact |
|---|---|
| §2.1 fields + C1–C6, M3 | `check_form.mjs` + SKILL.md §2/§3 |
| §2.2 preset = skill with intake-form file | SKILL.md §1 step 2 |
| §2.3 shooter contract, all-or-nothing, M11 | `volley-workflow.js` (schema, re-requests, void) |
| §2.4 residue + M5, M10, S3, A3, D-6 | `residue.mjs` + SKILL.md §4/§7 |
| §3 state model / §4 event flow order | SKILL.md §1→§7 procedure order |
| §5 errors (referral, unfillable, incoherent, missing target, void) | SKILL.md §1.1, §2.2-reject, §3, §6.3-void |
| M1/I-6 counting is code | fold section of `volley-workflow.js` |
| M2 starved shooters + judge | `agents/shooter.md`, embedded-prompt dispatch, judge prompt |
| M4 work outside / 제1원칙 | SKILL.md first-principle block + §6 one Workflow call |
| M6 labels verbatim | SKILL.md §7 (`한 발은 짐작`, `기계 선택`, `판단 선택`) |
| M7 announce-then-fire | SKILL.md §5 |
| M8 single-fire | SKILL.md §7-void + `volley-workflow.js` (no shooter retry) |
| M9 one form for everything | SKILL.md §2 (delegation fills the same form) |
| I-7 pick routes | Task 6 code + SKILL.md §2.2 |
| S1/S2/S5 defaults | SKILL.md §2.3/§2.4 |
| A5 model | args.model plumbing |
| A6 language | SKILL.md Language block |

- [ ] **Step 6: Commit**

```bash
git add plugins/salvo/agents/shooter.md plugins/salvo/skills/salvo/SKILL.md plugins/salvo/skills/salvo/references/shooter-prompt-template.md
git commit -m "feat(salvo): /salvo 문 — SKILL.md·사수 에이전트·사수 프롬프트 템플릿

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: wiring + deploy (v0.6.0)

**Files:**
- Modify: `plugins/salvo/.claude-plugin/plugin.json`
- Modify: `plugins/salvo/README.md`
- Modify: `.claude-plugin/marketplace.json`

**Interfaces:**
- Consumes: everything above.
- Produces: installed plugin v0.6.0 with the `salvo` skill registered.

- [ ] **Step 1: plugin.json → 0.6.0**

Replace the full contents of `plugins/salvo/.claude-plugin/plugin.json` with:

```json
{
  "name": "salvo",
  "description": "한 발은 짐작, 일제사격은 측정. /salvo:salvo — 단일 문: 요청을 신고서로 라우팅(즉석 무기 대장간 · 위임 · 반려 · /spec 회부), 사수 N명을 워크플로우 하나로 발사, union/vote 접기는 코드가 셈, 잔해는 데이터 디렉토리에 축적. /salvo:spec + /salvo:spec-gate 포함. 제1원칙: 메인 세션은 오케스트레이션만 한다.",
  "version": "0.6.0"
}
```

- [ ] **Step 2: README — add the door row, update the header**

In `plugins/salvo/README.md`: change the title line to `# salvo (v0.6.0)`, drop `— 재조립 중` and the "재조립 중이다" paragraph opener (the platform now exists; legacy weapons are still pending re-registration), and add this row as the FIRST row of the weapons table:

```markdown
| `/salvo:salvo` | 단일 문. 요청을 신고서(intake form)로 라우팅 — 즉석 무기 대장간(union/vote/pick 접기, 표 세기는 코드), 위임(1발 = "한 발은 짐작"), 스펙 요청은 /spec 회부, 못 채우면 반려. 잔해는 ~/.claude/plugins/data/salvo-chenjing-plugins/residue/에 축적 (승격 증거) |
```

Update the closing bullet about 이전 무기 re-registration to say they will be re-registered **as presets on the 003 platform** (intake-form.json + skill wrapper).

- [ ] **Step 3: marketplace.json — register the skill**

In `.claude-plugin/marketplace.json`, replace the salvo entry with:

```json
{
  "name": "salvo",
  "description": "한 발은 짐작, 일제사격은 측정. /salvo:salvo (무기 플랫폼 단일 문 — 라우팅·대장간·코드 접기·잔해) + /salvo:spec (인터뷰 명세) + /salvo:spec-gate (콜드 리더 관문).",
  "source": "./plugins/salvo",
  "skills": [
    "./skills/salvo",
    "./skills/spec",
    "./skills/spec-gate"
  ]
}
```

- [ ] **Step 4: Full suite + commit + push**

Run: `node --test 'plugins/salvo/tests/*.test.mjs'`
Expected: all PASS.

```bash
git add plugins/salvo/.claude-plugin/plugin.json plugins/salvo/README.md .claude-plugin/marketplace.json
git commit -m "feat(salvo): v0.6.0 — /salvo 무기 플랫폼 (라우팅·대장간·워크플로우 발사·코드 접기·잔해)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push
```

- [ ] **Step 5: Deploy the plugin**

```bash
claude plugin marketplace update chenjing-plugins
claude plugin update salvo@chenjing-plugins
```

Expected: `Plugin 'salvo' updated from 0.5.3 to 0.6.0 for scope user. Restart to apply changes.`

- [ ] **Step 6: Live smoke (MAIN SESSION ONLY — requires the Workflow tool)**

This step is executed by the orchestrating session after the task subagent finishes, not by a subagent. AC1-shaped end-to-end:

1. Write a small fixture doc with 2 planted contradictions across `##` sections to `$CLAUDE_JOB_DIR/tmp/smoke-target.md`.
2. Walk SKILL.md §2–§7 manually from the repo copy (`plugins/salvo/skills/salvo/`): extract anchors (headings), forge a union/3/sealed/forbidden form, `check_form.mjs` → OK, `residue.mjs new`, announce, fire the real Workflow (`scriptPath` = repo path of `volley-workflow.js`), report, `residue.mjs outcome folded`.
3. Verify: residue file existed before dispatch (`outcome: pending`), the report lists anchor-deduped findings with counts, and the planted contradictions were found; then check the residue file ends at `outcome: folded`.

---

## Coverage: Acceptance Criteria → where they are exercised

| AC | Exercised by |
|---|---|
| AC1 improvised measurement | Task 8 Step 6 live smoke (real volley) + Task 5 union tests (mechanics) |
| AC2 delegation | Task 5 `fold none` test (volley 1, tooled, pass-through) + SKILL.md §7 `한 발은 짐작` |
| AC3 rejection | SKILL.md §2.2 reject branch (procedure; no code path exists to spawn without a form) |
| AC4 referral | SKILL.md §1.1 (stop before form/residue) |
| AC5 preset priority | SKILL.md §1.2 contract (v1 has zero presets — no live test possible) |
| AC6 void volley | Task 5 void tests (no partial items) + SKILL.md §7 void report |
| AC7 judged pick | Task 6 judged-pick tests (starved judge, 판단 선택 label path) |
