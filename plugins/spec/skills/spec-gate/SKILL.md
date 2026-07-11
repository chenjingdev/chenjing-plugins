---
name: spec-gate
description: "A gate that measures a spec by having N independent execution-model readers (default 3, one with adversarial framing) cold-read it in parallel and surface what an implementer cannot decide on their own (blocking), plus what is best answered by experiment rather than by authorial fiat (experimental). It loops the interview back until zero confirmed blocking issues remain — confirmed = raised by 2 or more readers. Measures decidability, not desirability. Fires automatically as /spec's final step for contract modes (exploration briefs are not gated); also invoke it directly whenever the user wants to validate or harden an existing spec before implementation. Usage: /spec-gate <path to SPEC.md> [--reader <model>] [--readers <N>]"
---

# /spec-gate — Cold-read measurement gate

Judge document quality not by the author's self-check but by **parallel cold
reads from several independent readers plus agreement of 2 or more** of them.
The gate itself is read-only: it never edits the SPEC.md body (G-5).

**Language**: Run the gate's user-facing interaction — the AskUserQuestion
feedback and the report to the user — in the user's conversation language.
Everything written into the documents (`.spec/gate-report.md`, and any edits
the writing session makes to SPEC.md) is in English, as a machine-facing contract
consumed by cold readers and implementers.

**First principle (제1원칙)**: the invoking session orchestrates only. Its
three jobs here: launch the measurement workflow, transcribe the returned
round result into `.spec/gate-report.md`, and run the user feedback loop. Counting
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
- If the file is an exploration brief — frontmatter contains `**Mode**:
  explore` or the title starts with "Exploration Brief" — refuse to run:
  briefs are deliberately open documents, and gating one would demand answers
  the exploration exists to produce. Point the user at /spec explore mode's
  optional single-reader check instead. Stop here.
- If the file exceeds 30,000 words: reject and recommend shrinking the
  document. Stop here.
- Read `.spec/gate-report.md` in the target project (the `.spec/` directory
  sits at the project root, beside the SPEC.md the path argument points at) to
  determine the round number: last round number + 1 (or 1 if there is no
  report). **There is
  no round cap** — since every round ends with user feedback, judging
  divergence and deciding to stop is the user's call at that point (G-8 · D-9).

### 0.5 Machine lint (floor check before cold reading, G-11)
Before cold reading, run a reproducible floor check. The required sections are
**those whose headings carry the `*(mandatory)*` tag in the target document
itself** — the templates stamp these tags, so the document self-describes its
own floor and the lint needs no template lookup (feature and system templates
mandate different sections; reading the tag from the document is what keeps
one lint correct for both). If the document carries no `*(mandatory)*` tags at
all (a hand-written spec), the empty-section hard-fail cannot apply — record
that as a warning and proceed.
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
finished round result. This step requires the Claude Code Workflow tool
(schema-enforced agents + code tally + no-tool isolation in one place); in an
environment without it, do not hand-simulate the measurement — report that
the gate cannot run and stop.

- Read `references/reader-prompt.md` and substitute `{{SPEC_BODY}}` with the
  entire spec body. Drop the prompt's "## Output format" section — the output
  shape is enforced by the workflow schema instead; append one sentence
  telling readers to return findings via the structured output tool.
- Launch the Workflow tool with a script that:
  1. Extracts the spec's clause-ID vocabulary in JS (regex over rule IDs and
     headings: `FR-\d+`, `SC-\d+`, `M\d+`, `C\d+`, `S\d+`, `AC-?\d+`, `D-\d+`,
     `I-\d+`, `§[\d.]+`, `^#{1,3} ` heading lines) — the closed anchor list.
     The list must cover every ID family the templates actually emit (the
     feature template's normative IDs are `FR-\d+`/`SC-\d+`) — a vocabulary
     that misses a family flags every correct anchor as unknown, and worse,
     readers anchoring the same issue in scattered forms defeats the ≥2-vote
     merge (observed live: an M1↔AC1 contradiction raised as `(M1, decision)`,
     `(M1, question)`, and `(AC1, criteria)` counts as one confirmed + two
     solos, not three votes). The reader prompt's bare-clause-ID instruction
     is the other half of this defense.
  2. Fires N readers in parallel via
     `agent(readerPrompt, {agentType: 'spec:cold-reader', model: READER, schema: FINDINGS})`,
     where FINDINGS forces
     `{blocking: [{anchor, category, title, ambiguous, why, proposals: [string]}], discretionary: [{anchor, category, title, resolution}], experimental: [{anchor, category, title, question, how_to_answer}], out_of_scope: [string], verdict: string}`
     and `category` ∈ {question, decision, term, criteria}. The body is
     embedded in the prompt — no file path, no tool access (G-2).
  3. **Framing rotation (G-14)**: reader index 0 gets an adversarial preamble
     prepended to the same prompt: *"Assume this document contains at least
     one undecidable fork its author missed — one that would make two
     reasonable implementers build different systems. Your job is to find it.
     If after honest effort you find none, say so."* Same schema, same tally.
     Why: same-family readers share an agreement-leaning prior, so unanimity
     can mean shared blind spot rather than clarity; rotating one reader's
     stance breaks that prior at zero infra cost, and the ≥2-vote rule already
     guards against the adversarial reader's false positives (its solo
     findings stay informational).
  4. Requires all N to succeed — if any `agent()` returns null, the script
     returns a failure object and records no partial results (Edge Case).
     On such a failure the session reports it, relaunches the workflow once,
     and if it fails again stops and asks the user; a failed launch appends
     nothing to the report and does not consume a round number (round numbers
     count only rounds transcribed into `.spec/gate-report.md`).
  5. Tallies in JS — code, not judgment: **confirmed blocking = the same
     `(anchor, category)` pair raised as blocking by ≥ 2 readers**; the same
     rule applied to experimental items yields **confirmed experimental**;
     votes are integer counts; anchors are validated against the extracted
     vocabulary (an anchor outside it is flagged, never silently dropped or
     rewritten). Only confirmed *blocking* drives the pass verdict —
     experimental items never block (G-13).
  6. Returns the round object: `confirmed[]` (each with every contributing
     reader's write-up verbatim), `solo[]`, `discretionary[]`,
     `confirmedExperimental[]`, `soloExperimental[]`, `out_of_scope[]`,
     `verdicts[]`, `flags[]`.
- A round can take 5+ minutes; wait for the workflow to complete.

### 2. Transcribe the report (the gate's only write, G-12)
- The invoking session **transcribes** the returned round object into
  `.spec/gate-report.md` at the project root: append a round block in the
  `references/gate-report-template.md` format (preserving existing rounds),
  with a "votes" column and issue IDs `R{round}-{index}`. Transcription, not
  aggregation — every number comes from the script. If `.spec/` does not exist
  yet (a direct /spec-gate run on a hand-written spec, without /spec having run
  first), create it and write `.spec/.gitignore` containing exactly `*` (one
  line) so the directory ignores itself before appending.
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
  - Question = the issue's "what is ambiguous", options = the **union of all
    contributing readers' proposals**, deduplicated by substance; if more than
    3 remain, keep the 3 most distinct (label them explicitly as
    "implementer's guess") + the automatically provided free-form input.
  - **Calibrate to the user's domain-knowledge level** (inherit the /spec
    calibration probe if it ran this session; otherwise infer from the
    conversation): for concepts the user is not comfortable with, explain with
    a concrete example before presenting the options. An answer to a question
    the user did not understand becomes a wrong decision baked into the spec.
  - If the user answers "leave it to the implementer's discretion": add the
    item + reason to the spec's `## Deferred to Implementer` section (G-7 — a
    waiver is the act of stating it explicitly in the spec body, so that next
    round's cold readers do not re-raise it).
  - If the user answers "decide it by experiment" — or adopts a reader's
    experimental framing: add the item to the spec's `## Resolved by
    Experiment` section with the question and how it will be answered
    (G-13 — the experiment record works like a waiver: the answer's *location*
    is now stated in the document, so next round's cold readers do not
    re-raise it). This is the right resolution when pre-deciding would just
    bake in a guess that candidates or runtime observation would answer.
  - Any other answer: reflect the content into the spec body (the relevant
    section). The reflection is an edit by the writing session, grounded only
    in the user's answer — do not silently adopt a reader's guess (G-6).
- **Confirmed experimental items** (≥2 readers tagged the same anchor+category
  experimental) do not block, but surface them in the same feedback pass as a
  suggestion: "N readers judged this is best answered by experiment — record
  it in Resolved by Experiment, or decide it now?" The user may still decide
  on the spot; the readers' judgment is advice, not a verdict. Solo
  experimental items are display-only.
- Once reflection is done, **start the next round yourself** — announce it in
  one line ("게이트: N라운드 시작") so the user can interrupt. The loop ends
  only at zero confirmed blocking, or when the user says stop (there is no
  round cap — divergence is the user's call, G-8 · D-9).
- If a dashboard exists at `.spec/dashboard.html` in the project (created by
  /spec), update its Progress and Decision-log sections with this round's
  result — the user watches that page for live state.

## What this gate measures — and what it does not (G-15)

The gate measures **decidability**: can an implementer, from this document
alone, make every direction-setting decision without guessing the author's
intent? It does NOT measure:

- **Desirability** — whether this is the right product to build. A precisely
  specified wrong product passes with zero blocking. Desirability is settled
  upstream (the /spec interview, explore-mode candidate comparison, the
  user's own judgment), never by this gate.
- **Completeness against unstated intent** — readers can only flag what the
  document makes visible. Requirements the author never voiced don't exist
  for a cold reader.
- **Reader-invisible ambiguity** — the N readers run on the same model family
  and share its blind spots; ≥2-vote agreement measures *shared salience*,
  and unanimity can mean a shared blind spot as well as clarity. The framing
  rotation (G-14) narrows this, it does not close it.

So read `passed` as: "no ambiguity visible to N cold readers of this family
remains" — a floor, not a certificate. Report the verdict in those terms and
never let "gate passed" stand in for "the spec is right."

## What keeps the measurement honest
- The verdict is read off the workflow's tally — zero confirmed blocking is
  the only pass condition, so report exactly what the script returned.
- Discretionary, solo, and experimental items are information for the
  implementer; the spec body grows only from the user's answers to confirmed
  blocking and the user's explicit experiment-routing choices (G-4 · G-13 —
  "values" are the implementer's job, and a spec inflated to appease every
  informational note stops being an axes contract).
- Reader isolation (embedded body, no tools) and the code tally are what make
  a round a measurement rather than an opinion poll. The workflow is the one
  place both are enforced at once, which is why every round runs through it
  (G-2 · D-10).
