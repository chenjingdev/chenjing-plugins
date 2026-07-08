---
name: spec
description: "Turn a raw idea into a spec an execution model can implement from the document alone, via a structured interview. Use this whenever the user describes a feature idea, wants a design or spec document, says 'I want to build X', or asks to scope or plan a system before coding. For a brand-new system it produces a system-level implementation contract (architecture, state, boundaries, contracts, error taxonomy); for a change to an existing codebase it produces a feature spec. Usage: /spec <idea description>. After drafting, /spec-gate fires automatically as the final step."
---

# /spec — Interview-driven spec authoring

Goal: **a spec the execution model (Opus) can implement by reading this
document alone.** The final quality verdict comes from /spec-gate, so here you
focus on filling in the *axes* rather than over-detailing. Axes = scope, state,
boundaries, contracts, error taxonomy. Values (naming, format, algorithm
details) are left to the implementer's discretion.

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
- If the current directory is an existing codebase (source files present) and
  the request is a change to it → **feature mode**
  (`references/spec-template.md`)
- If it is a new system/app idea → **system mode**
  (`references/spec-template-system.md`)
- If ambiguous, ask once with AskUserQuestion.

### 2. Pre-research (before the interview)
- **Feature mode**: investigate the relevant code yourself — find the existing
  patterns to follow, the files you will touch, and the constraints, and
  capture them as `file:line` citations. Bake the findings into the spec body
  (so the implementation session does not have to dig again).
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
  `specs/NNN-slug/dashboard.html` and open it for the user (`open <path>`).
  The template auto-refreshes every 3 seconds, so rewriting the file is all
  that "live" takes.
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
- Order: purpose/success criteria → scope (explicit out-of-scope) → state/data
  axes → failure modes → acceptance criteria.
- Quantification discipline: "fast" → "how many ms?", "several" → an exact
  number. Do not carry vague adjectives into the spec.
- Record every directional decision you make in the **Decision Ledger**, along
  with its rationale and the rejected alternatives.
- If the user does not know the answer: propose a reasonable default and, if
  adopted, declare it in **Assumptions**. No unstated assumptions.
- Only where the judgment genuinely forks and you could not get an answer, mark
  it inline in the body as `[NEEDS CLARIFICATION: specific question]`.
  **At most 3** — priority: scope > security > UX > technical detail. Handle
  the rest with defaults + Assumptions.

### 4. Writing and self-verification
- Create `specs/NNN-slug/SPEC.md` as the next entry under `specs/`
  (NNN = the next 3-digit number after scanning existing directories,
  slug = 2-4 word kebab-case).
- Write it while keeping the template structure. Frontmatter `**Gate**: not-run`.
- Self-verify (up to 3 revision passes): any vague adjectives left? are
  acceptance criteria observable? is every decision in the Ledger? zero markers
  remaining? (During drafting the cap is 3, but the /spec-gate lint rejects on
  ≥1 remaining marker.)
- If any markers remain, resolve each one with AskUserQuestion (proposed
  answers A/B/C + free-form input) and reflect it into the body.

### 5. Gate (automatic)
- After reporting completion, **invoke /spec-gate yourself** via the Skill tool
  (skill `salvo:spec-gate`, args = the new SPEC.md path). Announce it in one
  line first ("게이트: /spec-gate 1라운드 시작") — the announcement is what
  gives the user their chance to interrupt, so it stands in for asking
  permission.
- The gate owns its round loop (feedback → reflect → next round) until it
  passes; follow its procedure. Implementation starts from a passed spec.
- If the user asked to stop after drafting (e.g. "게이트는 나중에"), honor
  that and hand the spec over as-is.
