---
name: spec
description: "Turn a raw idea into the right-weight planning document via a structured interview. Use this when the user wants a design or spec document, needs a durable shared contract (public APIs, persistence/schema, cross-component contracts, security boundaries, high-risk changes), or describes a product/feature direction worth pinning down before coding. Three modes by how settled the direction is: exploration that is still deciding WHAT to build (candidate fan-out planned, UI experiments, MVP probes) gets a lightweight exploration brief (BRIEF.md) — no full spec, no gate; a change to an existing codebase gets a feature spec; a new system whose direction is already chosen gets a system-level implementation contract. Do NOT run the contract interview for throwaway prototypes or simple local changes — a trivial change needs no planning document at all, and exploratory work belongs in explore mode. Usage: /spec <idea description>. Contract-mode drafts end with /spec-gate firing automatically."
---

# /spec — Interview-driven spec authoring

Goal: **a document matched to how settled the work is.** For settled work
(feature/system — the *contract modes*), that is an implementation contract:
the executor gets **all the intent, boundaries, and completion criteria from
this document alone**, then **re-inspects the live repository itself** and
**chooses the implementation approach autonomously**. The division of labor:
intent lives in the document (code inspection can never recover what the
author wanted), world-state lives in the code (a document's copy of it ages
from the moment it is written), and the how belongs to the implementer. A
spec is NOT a document that lets the executor skip looking at the code — it
is the document that makes every *intent* decision decidable without asking
the author. The final quality verdict comes from /spec-gate, so here you
focus on filling in the *axes* rather than over-detailing. Axes = scope,
state, boundaries, contracts, error taxonomy. Values (naming, format,
algorithm details) are left to the implementer's discretion. For unsettled
work (*explore mode*), the goal inverts: fix only the boundaries and the
evaluation criteria and deliberately leave the rest open — a full spec
written before any candidate exists collapses the diversity the exploration
is for, and bakes in introspected guesses that seeing real candidates would
have overturned.

**Intent vs. world-state**: a spec is the single source of *intent,
boundaries, and completion criteria*. Facts about the *current implementation
state* (what the code looks like today) belong in the non-normative Context
Snapshot and are re-verified from code and tests at execution time — recorded
code facts start aging the moment they are written, and a stale "fact"
presented as contract is worse than none.

**Language**: Conduct the interview — questions, AskUserQuestion options, and
reports — in the user's conversation language. Write the spec document itself
(SPEC.md, produced from the templates) in English: it is a machine-facing
contract consumed by cold readers and implementers.

**First principle (제1원칙)**: the main session converses and orchestrates.
This skill is conversation by design — the interview is a back-and-forth with
the user, so research, questioning, and authoring stay in the main session.
The measurement that follows (/spec-gate) is orchestration: one Workflow call
whose script does the reading fan-out and the counting, launched and relayed
by the session.

## Procedure

### 1. Mode selection
- If WHAT to build is still being discovered — the user plans to compare
  multiple candidates, run UI/UX experiments, probe an MVP direction, or says
  things like "여러 방향으로 만들어보고 고르자" → **explore mode**
  (`references/brief-template.md`; §1.5 below replaces §2–§5 entirely)
- If the current directory is an existing codebase (source files present) and
  the request is a change to it → **feature mode**
  (`references/spec-template.md`)
- If it is a new system/app idea whose direction is already chosen →
  **system mode** (`references/spec-template-system.md`)
- If the mode is ambiguous, ask once with AskUserQuestion — this covers both
  frontiers. Explore vs contract, the cue: *"구현 결과를 보고 결정할 것이
  많은가?"* — if most decisions should wait for real candidates, it is
  explore. Feature vs system (e.g., a new app inside an existing monorepo),
  the cue: does the work *change* existing behavior/contracts (feature), or
  does it stand up a new system that merely lives beside existing code
  (system)?

### 1.5 Explore mode (replaces §2–§5)

Exploration needs a launchpad, not a contract. Pre-deciding data models, state
machines, and error taxonomies makes every candidate converge on the same
design — the opposite of what a fan-out is for.

- **Interview: 1–3 questions total.** Only what the brief cannot proceed
  without: the value hypothesis (intent), the hard constraints (boundaries no
  candidate may cross), and how candidates will be compared (evaluation
  criteria). Propose Diversity Axes and Open Questions yourself and confirm
  them in the same breath — they are your design contribution, not interview
  material.
- **Write `BRIEF.md`** at the project root from `references/brief-template.md`
  (in English, like SPEC.md — machine-facing). A BRIEF and a SPEC can coexist:
  the brief drives the exploration phase; the spec, if one exists, describes
  the settled system around it.
- **No gate.** BRIEF.md is never sent to /spec-gate (the gate rejects it).
  Optionally offer ONE lightweight adversarial check — a single cold reader
  (no context, no tools) asked: "Which of these Open Questions actually must
  be decided *before* building candidates, because getting it wrong invalidates
  the comparison?" Surface its answer as information, not as a gate.
- **Promotion path.** After candidates are built and selected, run /spec again
  → contract mode. The brief's Hard Constraints carry over verbatim; the
  selected candidate's traits become interview material; Open Questions arrive
  *answered by evidence* and land in the spec's Decision Ledger (rationale =
  the experiment result) — the spec is written as codification of what
  survived, not as prediction.

### 2. Pre-research (before the interview)
- **Feature mode**: investigate the relevant code yourself — find the existing
  patterns to follow, the files you will touch, and the constraints, and
  capture them as `file:line` citations. Record the findings in the spec's
  **Context Snapshot** section (non-normative), NOT in the requirements body:
  they are a head start for the implementation session, not part of the
  contract. The implementer re-verifies them against the live code — a
  mismatch between snapshot and code means the snapshot aged, never that the
  code violates the spec. Constraints that ARE intent ("must follow the
  existing auth flow") go in Requirements; the snapshot only carries where
  that flow lives today.
- **Assumption-freshness rule**: before inheriting a past decision or document,
  verify its rationale still holds today. Cross-check against memory (Honcho)
  and recent commits.
- **System mode**: gather as much as you know about similar tools and prior art
  to use as interview material (the user's intent, not your research, is
  authoritative).

### 2.5 Calibration + live dashboard

Interview answers become Decision Ledger entries — ground truth for the spec —
so the user has to actually understand each question before answering it. Two
tools carry that: a ten-second probe that tells you which terms need
introducing, and a live dashboard the user can open in a browser whenever a
term or the current state is unclear. Neither constrains what you write in the
spec; they exist so the user never answers a question they only half
understood.

**Probe (once, before the first design question)**
- Check memory (Honcho) and the conversation first — if the user's level in
  this domain is already evident, tell them in one line ("Calibration:
  skipping the probe — your level here is already established") and move on.
- Otherwise pick 4-6 domain terms the interview will lean on (mixed
  difficulty) and ask one AskUserQuestion (multiSelect): "Which of these are
  you comfortable with? (This calibrates my explanations — it is not a test.)"
- The probe sets a prior; conversation evidence keeps updating it. A "what
  does X mean?" lowers the level for that area, fluent jargon raises it.
- If the probe's natural slot has already passed (resumed session, interview
  already underway), run it at the next pause — late calibration still beats
  none.

**Dashboard (create at interview start, keep current as you go)**
- Copy `assets/dashboard-template.html` (bundled with this skill) to
  `.spec/dashboard.html` at the project root and open it for the user
  (`open <path>`). Create the `.spec/` directory first if it does not exist,
  and write `.spec/.gitignore` containing exactly `*` (one line) so the
  directory ignores itself — nothing under `.spec/` is ever committed. The
  template auto-refreshes every 3 seconds, so rewriting the file is all that
  "live" takes.
- Fill the placeholders in the user's conversation language and keep three
  sections current:
  - **Progress**: the pipeline steps (research → calibration → interview →
    drafting → self-check → gate rounds), current step marked.
  - **Decision log**: each I-n decision as it lands, newest first.
  - **Glossary**: every domain term the interview leans on — one-line meaning
    plus a concrete example, newest first, added the moment the term first
    appears. Mark probe-familiar terms per the template comments.
- The glossary is the user's safety net. When you introduce a term the user
  did not check as familiar, lead with its example in the conversation, and
  add it to the dashboard — then even when an inline explanation slips (over
  a long interview, some will), the user always has a place to look it up.
- Update the dashboard after each interview answer and each gate round; the
  user trusts what it shows, so a stale dashboard misleads more than none.

### 3. Interview (superpowers brainstorming UX)
- **One question per message.** AskUserQuestion with 2-4 options + free-form
  input.
- **Blocking test before every question.** A question earns its interruption
  only if the decision (a) changes a user-observable outcome or a
  safety/data/compatibility boundary, (b) cannot be safely made by the
  implementer after inspecting the code, (c) is better fixed now than by a
  candidate experiment, and (d) is expensive to change later. Mostly-no →
  don't ask: route it to a declared default (Assumptions), delegate it
  (Deferred to Implementer), or mark it experimental (Resolved by
  Experiment). Every question you don't ask is interview time the user keeps
  and a guess you don't bake in.
- Order: purpose/success criteria → scope (explicit out-of-scope) → state/data
  axes → failure modes → acceptance criteria.
- Quantification discipline, conditionally: quantify when the number does
  real work — acceptance judgment, safety, cost, a performance floor ("fast"
  → "p95 how many ms?"). Do NOT force numbers onto exploratory UX or product
  taste ("clean UI" → not a number; a candidate-comparison criterion or an
  experimental item). False precision reads as contract and gets built.
- Record decisions in the **Decision Ledger** with rationale and rejected
  alternatives — but apply an admission bar, because a ledger that records
  everything becomes sediment nobody reads and nobody dares delete. Record a
  decision when it is expensive to reverse, is an external contract (API,
  schema, protocol), touches security/data handling, had genuinely competing
  alternatives, or a future session might plausibly re-litigate it. Cheap,
  obvious, easily-reversed choices (a button label, an internal name) are not
  ledger material — the diff records them well enough.
- If the user does not know the answer: propose a reasonable default and, if
  adopted, declare it in **Assumptions**. No unstated assumptions.
- Only where the judgment genuinely forks and you could not get an answer, mark
  it inline in the body as `[NEEDS CLARIFICATION: specific question]`.
  **At most 3** — priority: scope > security > UX > technical detail. Handle
  the rest with defaults + Assumptions.

### 4. Writing and self-verification
- The spec is the project's own document, so it lands in the project: write
  `SPEC.md` at the project root (the directory the session is working in; for a
  monorepo sub-project, the subdirectory you ran /spec from). It is the single,
  visible source of truth and the only committed artifact — there are no
  numbered `specs/NNN-slug/` directories. (Contrast: plugin-owned data would
  live in a plugin data dir; this document belongs to the user's project.)
- **A pre-existing `SPEC.md` is input, not a collision.** If the project root
  already has a SPEC.md when /spec starts, ask ONE AskUserQuestion before
  writing anything — there is no silent overwrite path:
  - **Revise it** ("이 문서를 기반으로 개정") — read it, treat its content as the
    draft, fill the missing axes through the interview, then gate.
  - **Start fresh** ("무시하고 새로 작성") — write the new document only after the
    user's explicit confirmation in that same answer; the old content is
    replaced only on this explicitly chosen path.
- **One living spec per project.** A project has a single SPEC.md; later /spec
  runs on the same project revise it in place (new Decision Ledger rows + body
  edits), never create SPEC-2.md or numbered siblings.
- Write it while keeping the template structure. Frontmatter `**Gate**: not-run`.
- Self-verify (up to 3 revision passes): any vague adjectives left in
  *normative* clauses (requirements, invariants, acceptance criteria)? — a
  deliberately-open item belongs in Resolved by Experiment, not as a fuzzy
  requirement. Are acceptance criteria observable? Does every ledger-worthy
  decision sit in the Ledger? Zero markers remaining? Is the Implementation
  Authority & Escalation block present? (During drafting the cap is 3, but
  the /spec-gate lint rejects on ≥1 remaining marker.)
- If any markers remain, resolve each one with AskUserQuestion (proposed
  answers A/B/C + free-form input) and reflect it into the body.

### 5. Gate (automatic)
- After reporting completion, **invoke /spec-gate yourself** via the Skill tool
  (skill `spec:spec-gate`, args = the new SPEC.md path). Announce it in one
  line first ("게이트: /spec-gate 1라운드 시작") — the announcement is what
  gives the user their chance to interrupt, so it stands in for asking
  permission.
- The gate owns its round loop (feedback → reflect → next round) until it
  passes; follow its procedure. Implementation starts from a passed spec.
- If the user asked to stop after drafting (e.g. "게이트는 나중에"), honor
  that and hand the spec over as-is.
