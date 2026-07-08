---
name: spec-gate
description: "A gate that measures a spec by having N independent execution-model readers (default 3) cold-read it in parallel and surface what an implementer cannot decide on their own (blocking). It loops the interview back until zero confirmed blocking issues remain — confirmed = raised by 2 or more readers. Fires automatically as /spec's final step; also invoke it directly whenever the user wants to validate or harden an existing spec before implementation. Usage: /spec-gate <path to SPEC.md> [--reader <model>] [--readers <N>]"
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

**First principle (제1원칙)**: the invoking session orchestrates only. Its
three jobs here: launch the measurement workflow, transcribe the returned
round result into gate-report.md, and run the user feedback loop. Counting
lives in the workflow script's code — that division is what keeps the tally
recountable and the session's context clean enough to stay a fair courier.

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

### 1. Cold read + mechanical tally (ONE Workflow, G-2 · D-10)

The whole measurement — N parallel cold reads AND the vote tally — runs as a
single Workflow call. The invoking session launches it and receives a
finished round result.

- Read `references/reader-prompt.md` and substitute `{{SPEC_BODY}}` with the
  entire spec body. Drop the prompt's "## Output format" section — the output
  shape is enforced by the workflow schema instead; append one sentence
  telling readers to return findings via the structured output tool.
- Launch the Workflow tool with a script that:
  1. Extracts the spec's clause-ID vocabulary in JS (regex over rule IDs and
     headings: `M\d+`, `C\d+`, `S\d+`, `AC\d+`, `D-\d+`, `I-\d+`, `§[\d.]+`,
     `^#{1,3} ` heading lines) — the closed anchor list.
  2. Fires N readers in parallel via
     `agent(readerPrompt, {agentType: 'salvo:cold-reader', model: READER, schema: FINDINGS})`,
     where FINDINGS forces
     `{blocking: [{anchor, category, title, ambiguous, why, proposals: [string]}], discretionary: [{anchor, category, title, resolution}], out_of_scope: [string], verdict: string}`
     and `category` ∈ {question, decision, term, criteria}. The body is
     embedded in the prompt — no file path, no tool access (G-2).
  3. Requires all N to succeed — if any `agent()` returns null, the script
     returns a failure object and records no partial results (Edge Case).
  4. Tallies in JS — code, not judgment: **confirmed blocking = the same
     `(anchor, category)` pair raised as blocking by ≥ 2 readers**; votes are
     integer counts; anchors are validated against the extracted vocabulary
     (an anchor outside it is flagged, never silently dropped or rewritten).
  5. Returns the round object: `confirmed[]` (each with every contributing
     reader's write-up verbatim), `solo[]`, `discretionary[]`,
     `out_of_scope[]`, `verdicts[]`, `flags[]`.
- A round can take 5+ minutes; wait for the workflow to complete.

### 2. Transcribe the report (the gate's only write, G-12)
- The invoking session **transcribes** the returned round object into
  `gate-report.md`: append a round block in the
  `references/gate-report-template.md` format (preserving existing rounds),
  with a "votes" column and issue IDs `R{round}-{index}`. Transcription, not
  aggregation — every number comes from the script.
- Matching is mechanical `(anchor, category)` equality (D-10 · D-12). The old
  "thesis match" sub-rule required semantic judgment and is retired; a coarse
  merge (same clause, same category, different theses) stays visible because
  each confirmed item reproduces every contributing reader's write-up
  verbatim.
- No LLM judge anywhere in the tally — the workflow script's code is the only
  counter (D-10).

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
- Once reflection is done, **start the next round yourself** — announce it in
  one line ("게이트: N라운드 시작") so the user can interrupt. The loop ends
  only at zero confirmed blocking, or when the user says stop (there is no
  round cap — divergence is the user's call, G-8 · D-9).
- If a `dashboard.html` exists next to the spec (created by /spec), update its
  Progress and Decision-log sections with this round's result — the user
  watches that page for live state.

## What keeps the measurement honest
- The verdict is read off the workflow's tally — zero confirmed blocking is
  the only pass condition, so report exactly what the script returned.
- Discretionary and solo items are information for the implementer; the spec
  body grows only from the user's answers to confirmed blocking (G-4 —
  "values" are the implementer's job, and a spec inflated to appease every
  informational note stops being an axes contract).
- Reader isolation (embedded body, no tools) and the code tally are what make
  a round a measurement rather than an opinion poll. The workflow is the one
  place both are enforced at once, which is why every round runs through it
  (G-2 · D-10).
