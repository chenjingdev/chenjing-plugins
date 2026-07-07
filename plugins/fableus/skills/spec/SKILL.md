---
name: spec
description: "Turn a raw idea into a spec an execution model can implement from the document alone, via a structured interview. Use this whenever the user describes a feature idea, wants a design or spec document, says 'I want to build X', or asks to scope or plan a system before coding. For a brand-new system it produces a system-level implementation contract (architecture, state, boundaries, contracts, error taxonomy); for a change to an existing codebase it produces a feature spec. Usage: /spec <idea description>. After drafting, validate with /spec-gate."
---

# /spec — Interview-driven spec authoring

Goal: **a spec the execution model (Opus) can implement by reading this
document alone.** The final quality verdict comes from /spec-gate, so here you
focus on filling in the *axes* rather than over-detailing. Axes = scope, state,
boundaries, contracts, error taxonomy. Values (naming, format, algorithm
details) are left to the implementer's discretion.

**Language**: Conduct the interview — questions, AskUserQuestion options, and
reports — in the user's conversation language. Write the spec document itself
(spec.md, produced from the templates) in English: it is a machine-facing
contract consumed by cold readers and implementers.

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

### 2.5 Domain-knowledge calibration (one probe)
Interview answers become Decision Ledger entries — ground truth for the spec.
A question the user did not actually understand produces a wrong decision
recorded as fact, which is far more expensive than the ten seconds this probe
costs. So calibrate before asking design questions:

- From the product description, pick 4-6 domain terms the interview will lean
  on (mix difficulty: a couple basic, a couple intermediate, a couple
  advanced).
- Before probing, check memory (Honcho) and the current conversation for
  existing evidence of the user's level in this domain; drop terms that are
  already settled and probe only what is genuinely uncertain. Memory is the
  persistent store for calibration — do not create separate glossary or
  profile files (they go stale and drift from what the conversation shows).
- Ask **one** AskUserQuestion (multiSelect): "Which of these terms are you
  comfortable with? (This calibrates my explanations — it is not a test.)"
- Unchecked terms become your explain-first list: for those concepts, give a
  concrete example **before** presenting options. For checked terms, stay
  terse and technical.
- State that list out loud right after the probe ("Explain-first terms: X, Y")
  and honor it for the entire interview — the discipline decays after a few
  turns when the list lives only in your head, and a list posted in the
  conversation is one you keep seeing. A parenthetical translation next to the
  term (e.g., "코드 실측(as-built)") is NOT an explanation — lead with the
  example, then use the term.
- The probe sets a prior, not a verdict. Recalibrate on evidence as the
  conversation unfolds: if the user asks "what does X mean?" or answers beside
  the point, lower the level for that area; if they use domain jargon fluently,
  raise it. Never re-quiz.
- If you skip the probe because every term is already settled (e.g., the user
  authored this domain), say so in one sentence ("Calibration: skipping the
  probe — your level here is already established"). A silent skip is
  indistinguishable from a broken skill.
- If you notice mid-interview that calibration never ran (resumed session,
  interview already underway when the skill loaded), run the probe at the next
  natural pause instead of skipping it — a missed slot is not a reason to fly
  uncalibrated for the rest of the interview.
- Calibration changes the conversation only — never the spec document content.

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
- Create `specs/NNN-slug/spec.md` as the next entry under `specs/`
  (NNN = the next 3-digit number after scanning existing directories,
  slug = 2-4 word kebab-case).
- Write it while keeping the template structure. Frontmatter `**Gate**: not-run`.
- Self-verify (up to 3 revision passes): any vague adjectives left? are
  acceptance criteria observable? is every decision in the Ledger? zero markers
  remaining? (During drafting the cap is 3, but the /spec-gate lint rejects on
  ≥1 remaining marker.)
- If any markers remain, resolve each one with AskUserQuestion (proposed
  answers A/B/C + free-form input) and reflect it into the body.

### 5. Handoff
- After reporting completion, **propose running /spec-gate**. Do not move on to
  the implementation phase before the gate passes.
