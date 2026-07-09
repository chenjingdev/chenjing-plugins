// route-workflow.js — a Workflow-tool sandbox script, NOT a node module.
// It runs inside the Workflow tool's sandbox and relies on sandbox features a
// plain `node` run does not provide: top-level `return`, the injected globals
// (agent / parallel / log / phase / args / budget), and a pure-literal
// `export const meta`. Like run-workflow.js it lives under references/ (not
// scripts/) because `node` cannot execute it directly; the test harness reads
// this exact file, strips the `export ` keyword, and wraps the body in an
// AsyncFunction so the routing table is tested exactly as it ships.

export const meta = {
  name: 'salvo-route',
  description: 'Classify a request into a switch vector, then pick the destination by a code table (D-14)',
  phases: [
    { title: 'Classify', detail: 'one isolated classifier → schema-enforced switch vector' },
    { title: 'Route', detail: 'code table over the vector picks the destination' },
  ],
}

// args (built by the /salvo door):
//   request: string            — the user's request text; the ONLY thing the classifier sees (M2)
//   conditions: Array<{        — one per bundled sub-skill (empty in v1)
//     name: string,            — sub-skill directory name (the destination)
//     kind: 'preset'|'procedural',   — preset carries intake-form.json; procedural carries instructions.md
//     requires: { [switch]: value }  — the machine condition (condition.json)
//   }>
//   model: string|null         — classifier tier override (defaults to haiku)
//
// Returns exactly one object (see SKILL.md §1):
//   {kind:'routed', destination:'engine', destination_kind:null, matched:null, switches:null, fallback:true}
//       — classifier failed (routing_fallback, §5): non-fatal, engine default.
//   {kind:'routed', destination:<name>|'engine', destination_kind, matched, switches, fallback:false}
//       — the code table's pick over the switch vector.

// args may arrive as a JSON string depending on the caller's serialization
// path — normalize before reading anything (same guard as run-workflow.js).
const input = typeof args === 'string' ? JSON.parse(args) : args

// The switch vector (§2.5): six features restating the intake form's own axes.
// All six required, no extras — the schema IS the routing contract.
const SWITCHES = {
  type: 'object',
  additionalProperties: false,
  required: [
    'enumerable_findings', 'wants_confidence', 'candidate_selection',
    'unattended_ok', 'touches_environment', 'target_kind',
  ],
  properties: {
    enumerable_findings: { type: 'boolean' },
    wants_confidence: { type: 'boolean' },
    candidate_selection: { type: 'boolean' },
    unattended_ok: { type: 'boolean' },
    touches_environment: { type: 'boolean' },
    target_kind: { type: 'string', enum: ['document', 'repository', 'conversation', 'none'] },
  },
}

// The classifier prompt is versioned WITH the code — these definitions ARE the
// routing quality. The classifier is the isolated salvo:runner: it sees the
// request text and this schema, nothing else — no conversation context, no
// tools (M2).
const classifierPrompt = [
  'You classify a work request into boolean/enum switches. Judge only from the request text below — you have no other context, no tools, no conversation history. Return exactly the six switches via the structured output tool.',
  '',
  'Switch definitions:',
  '- enumerable_findings (bool): true when the request asks for a list of discrete findings, each tied to a spot in the target (a section, a line, a file), rather than one holistic answer or a single artifact.',
  '- wants_confidence (bool): true when the request prizes agreement/confidence — keep only what independent passes concur on — over exhaustive coverage of everything found.',
  '- candidate_selection (bool): true when the request wants the single best of several complete alternative artifacts (a draft, version, or option): produce N, keep one.',
  '- unattended_ok (bool): true when the work can run to completion with no user input part-way; false when it needs the user in the loop (interactive co-editing, mid-course decisions only the user can make).',
  '- touches_environment (bool): true when the work must read or change the repository/filesystem or run tools (code search, file edits, running commands); false when the target content can be embedded and inspected in isolation.',
  "- target_kind (enum document|repository|conversation|none): what the work operates on — a specific document's content, the repository/codebase as a whole, this session's own conversation, or none (pure generation with no concrete target).",
  '',
  'Request:',
  input.request,
].join('\n')

phase('Classify')

const classifyOpts = { agentType: 'salvo:runner', schema: SWITCHES, label: 'classify', phase: 'Classify' }
classifyOpts.model = input.model || 'haiku'
const switches = await agent(classifierPrompt, classifyOpts)

// Fallback (routing_fallback, §5): a classifier failure is non-fatal — the
// destination defaults to the engine; the record and announcement note it.
if (switches === null) {
  return { kind: 'routed', destination: 'engine', destination_kind: null, matched: null, switches: null, fallback: true }
}

phase('Route')

// A condition is satisfied iff EVERY clause in its `requires` equals the
// vector's value for that switch. Winner = the satisfied condition with the
// most clauses (most specific); ties break lexicographically by name; no
// satisfied condition ⇒ engine. Pure code — no LLM picks the destination (M15).
const conditions = input.conditions || []
const satisfied = conditions.filter(c =>
  Object.entries(c.requires).every(([k, v]) => switches[k] === v))

let winner = null
for (const c of satisfied) {
  if (winner === null) { winner = c; continue }
  const clauses = Object.keys(c.requires).length
  const best = Object.keys(winner.requires).length
  if (clauses > best || (clauses === best && c.name < winner.name)) winner = c
}

if (winner === null) {
  return { kind: 'routed', destination: 'engine', destination_kind: null, matched: null, switches, fallback: false }
}
return {
  kind: 'routed',
  destination: winner.name,
  destination_kind: winner.kind,
  matched: { name: winner.name, requires: winner.requires },
  switches,
  fallback: false,
}
