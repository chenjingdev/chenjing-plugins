---
name: spec-gate
description: "A gate that measures a spec by having N independent execution-model readers (default 3) cold-read it in parallel and surface what an implementer cannot decide on their own (blocking). It loops the interview back until zero confirmed blocking issues remain — confirmed = raised by 2 or more readers. Use this after /spec produces a SPEC.md, or whenever the user wants to validate or harden a spec before implementation. Usage: /spec-gate <path to SPEC.md> [--reader <model>] [--readers <N>]"
---

# /spec-gate — Cold-read measurement gate

Judge document quality not by the author's self-check but by **parallel cold
reads from several independent readers plus agreement of 2 or more** of them.
The gate itself is read-only: it never edits the SPEC.md body (G-5).

**Language**: Run the gate's user-facing interaction — the AskUserQuestion
feedback and the report to the user — in the user's conversation language.
Everything written into the documents (gate-report.md, and any edits the
writing session makes to SPEC.md) is in English, as a machine-facing contract
consumed by cold readers and implementers.

## Procedure

### 0. Input validation
- Parse the spec path, `--reader <model>` (default `opus`), and
  `--readers <N>` (default 3) from the arguments. If `N < 2`, reject and stop —
  a consensus vote is structurally impossible (G-10).
- If the env var `CLAUDE_CODE_SUBAGENT_MODEL` is set, warn — this env var
  overrides the per-call model and nullifies `--reader` (model priority:
  env > per-call > frontmatter > session).
- If the file is missing or empty: refuse to run and report the reason. Stop
  here.
- If the file exceeds 30,000 words: reject and recommend shrinking the
  document. Stop here.
- Read `gate-report.md` in the same directory as the spec to determine the
  round number: last round number + 1 (or 1 if there is no report). **There is
  no round cap** — since every round ends with user feedback, judging
  divergence and deciding to stop is the user's call at that point (G-8 · D-9).

### 0.5 Machine lint (floor check before cold reading, G-11)
Before cold reading, run a reproducible floor check. The assumed template is
the salvo spec template, and the required sections are those tagged
`*(mandatory)*`.
- **There are exactly two hard-fail (reject) conditions**:
  1. A required section is empty — comments/whitespace only still count as
     empty.
  2. One or more `[NEEDS CLARIFICATION:` markers remain (matched on the
     bracket+colon form).
  If either triggers, reject without cold reading, report the reason, and stop.
- **Warnings (informational only)**: leftover vague adjectives, SC items
  missing a number or a verification predicate. Record these as warnings in the
  report but do not reject on them — a threshold-free style check would reject
  even sound documents (D-11).
- The lint is only a reproducible pre-filter; it does not substitute for the
  pass verdict — passing is always zero confirmed blocking.

### 1. Cold read (full isolation, G-2 · N in parallel)
- Read `references/reader-prompt.md` and substitute `{{SPEC_BODY}}` with the
  entire spec body.
- With the Agent tool, spawn `salvo:cold-reader`-type subagents **N in
  parallel**: each reader's model = the --reader value, prompt = the full
  substituted reader prompt. Do not pass a file path — embed the body directly
  in the prompt (this guarantees isolation, G-2). Do not give readers tool or
  repository access.
- A round can take 5+ minutes. Run it in the background and wait for all of
  them to finish.
- **Require all to succeed** — if even one fails to spawn, abort the round,
  report only the failure, and record no partial results (Edge Case). Stop.

### 2. Aggregate + write the report (the gate's only write, G-12)
- Aggregate reader outputs **by anchor** (D-10 · D-12):
  - Readers tag each issue with an anchor (the target FR number or section
    name). Blocking issues raised against the same anchor are summed
    mechanically.
  - **"Same point" = anchor match AND thesis match**. Even on the same anchor,
    if the thesis differs, count them as separate issues and record the basis
    for the split in the report.
  - Only issues where the anchors differ but the thesis is the same may the
    writing session merge on a semantic basis, recording the basis for the
    merge in the report.
  - Do not put a separate LLM judge in the aggregation — the subjectivity we
    rejected would creep back into the aggregation step (D-10).
- **Confirmed blocking = the same point raised by 2 or more readers.** A solo
  (single-reader) blocking and discretionary issues are shown as informational
  only and do not block passing.
- **Append** a round block to `gate-report.md` in the
  `references/gate-report-template.md` format (preserving existing rounds).
  Include a "votes" (e.g., 2/3) column in the issue table. Issue IDs are
  `R{round}-{index}`.

### 3. Verdict and feedback loop
- **Zero confirmed blocking** → verdict `passed`. Report to the user and update
  the spec frontmatter's `**Gate**:` line to `passed` (or
  `passed-with-waivers` if there are waivers). This update is a write by the
  writing session (the current session), not by the gate (G-5).
- **N confirmed blocking** → update the frontmatter to `round-N-blocked` and
  loop **only the confirmed blocking** back via AskUserQuestion (solo and
  discretionary are display-only):
  - Question = the issue's "what is ambiguous", options = the reader's
    proposals A/B/C (label them explicitly as "implementer's guess") + the
    automatically provided free-form input.
  - **Calibrate to the user's domain-knowledge level** (inherit the /spec
    calibration probe if it ran this session; otherwise infer from the
    conversation): for concepts the user is not comfortable with, explain with
    a concrete example before presenting the options. An answer to a question
    the user did not understand becomes a wrong decision baked into the spec.
  - If the user answers "leave it to the implementer's discretion": add the
    item + reason to the spec's `## Deferred to Implementer` section (G-7 — a
    waiver is the act of stating it explicitly in the spec body, so that next
    round's cold readers do not re-raise it).
  - Any other answer: reflect the content into the spec body (the relevant
    section). The reflection is an edit by the writing session, grounded only
    in the user's answer — do not silently adopt a reader's guess (G-6).
- Once reflection is done, propose re-running (the next round).
- If a `dashboard.html` exists next to the spec (created by /spec), update its
  Progress and Decision-log sections with this round's result — the user
  watches that page for live state.

## Do NOT
- Skip the gate verdict and declare a "rough pass" — for the confirmed-blocking
  verdict, the reader outputs are authoritative.
- Inflate the spec to resolve discretionary issues — leave them as
  informational display (G-4). "Values" are the implementer's job.
- Give readers file paths or repository access (G-2).
- Hand aggregation to a separate LLM judge — the subjectivity we rejected would
  creep back into the aggregation step (D-10).
