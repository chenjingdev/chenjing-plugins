---
name: salvo
description: "Parallel-run platform — state work in plain language and the skill routes it: it fills a standard intake form, runs N independent isolated agents in ONE Workflow call, and merges their outputs with code so every count is recountable. It also delegates single-run work to another session. Use this whenever the user invokes /salvo, wants work fanned out to several independent agents and merged, wants a measured (recountable) result instead of one model's opinion, or wants work done outside the current session. Usage: /salvo <request>"
---

# /salvo — N independent runs, merged by code

One pass is a guess; several independent passes merged by code are a
measurement — that is the salvo. This skill is the single door: every request
becomes an intake form, and filling that form is itself the routing decision.

This session only routes, announces, transcribes, and archives. The runs
happen in one Workflow call and every count comes out of code — the workflow
script and the bundled scripts — which is what keeps each number recountable
and this session's context clean enough to stay a fair courier.

The numbered codes below (M1…, S1…, C1…, A6, D-6…) cite invariants in the
platform spec at `plugins/salvo/SPEC.md` (plugin repo). They are
traceability tags — this skill is executable without reading the spec.

**Language**: announcement and report in the user's conversation language;
the form and run records in English (machine-facing, A6).

Paths: `<base>` = this skill's base directory. Run records live at
`~/.claude/plugins/data/salvo-chenjing-plugins/records/` (D-6; the default of
`record.mjs`).

## 1. Route

Decide in this order:

1. **Preset scan** — list sibling skills carrying a form:
   `ls <base>/../*/intake-form.json`. Read each file's `.form.definition` and
   compare it against the request (this comparison is routing judgment — the
   code-only rule M1 binds the merge, not routing). On a match, use that form
   as-is and continue at §4; the announcement names the preset — that is how
   the user sees preset priority. The scan is live (not a hard-coded list) so
   the first promoted preset changes routing without editing this skill. (v1
   ships zero presets, so today this falls through.)
2. Otherwise — **fill the form** for an ad-hoc run (§2).

A request for a spec or design document is not special-cased (D-10): it flows
through the form like any other work — typically a `pick` run over N candidate
drafts, or a single-run delegation. This skill never invokes or names another
plugin's skill.

## 2. Fill the form

Filling the form is itself the routing decision: whether this request is a
measurement, a delegation, or unfillable is discovered by trying to fill the
fields, in this order.

1. **definition** — 1–2 sentences naming the input target and the output
   shape.
2. **merge** — ask what the runner outputs can be merged on:
   - Findings matchable on an identity key → `union` (enumerate everything
     found) or `vote` (keep what ≥ threshold runs independently agree on —
     choose vote when the user asks for confidence over coverage; default
     `vote_threshold` = majority, floor(runs/2) + 1, S1).
   - N complete artifacts of which one should survive → `pick`, plus
     `pick.criterion` and its route: `mechanical` when the criterion maps to
     a program — set `pick.program` to `{"kind":"shortest"}`,
     `{"kind":"longest"}`, or `{"kind":"command","command":"<cmd with
     {candidate}>"}` (a stated test command). A criterion that maps to no
     program routes `judged` — an isolated judge selects and the report says
     so.
   - No merge, but the work runs unattended in another session → delegation:
     `runs: 1`, `merge: "none"`.
   - The work needs the user mid-execution (co-editing, mid-course decisions
     only the user can make) → **reject**: name the unfillable aspect in one
     line, suggest a plain session, stop. No dispatch, no record.
3. **runs** — default 3; above 5 only when the user explicitly asked for that
   scale. Why 3: it is the smallest count where agreement separates a majority
   from unanimity. Cost grows linearly with the count, so a larger run set is
   the user's call, not a silent default.
4. **isolation** — `sealed` whenever the target content fits in the runner
   prompt (embed it — sealing is what guarantees independence, S5); `tooled`
   only when the work must touch the repository or environment (search, edits,
   running tests).
5. **invention** — `forbidden` for inspection runs (runners report only what
   is in the target); `allowed` for generation and delegation.
6. **criteria_from** — `request` (embed the user's request text), `document`
   (+ `criteria_ref` path — the document must exist, C5), or `runner` (the
   runner's own judgment).
7. **anchors** (only for `union`/`vote`) — declare a code-checkable
   vocabulary (C6):
   - closed list:
     `node <base>/scripts/extract_anchors.mjs <target> --mode headings`
     (or `--mode regex --pattern '<re>'`); put the printed array into
     `anchors.values` with `"kind": "closed_list"` and note the extraction in
     `anchors.source`. The values land in the runner output schema as the
     allowed anchors.
   - or `"kind": "quote"` — runners anchor by verbatim quotation and the
     workflow validates every quote as a substring of the target.
8. **notes** — any constraint no field above carries, or `""`. It rides into
   the runner prompt's Rules block and stays in the run record as the
   form-evolution signal.

Write the finished form as JSON to a temp file in the session temp dir
(`$CLAUDE_JOB_DIR/tmp` when set, else the OS temp dir — never inside the
skill directory, which is a read-only cache) (shape below — the same shape
`check_form.mjs` validates):

```json
{
  "definition": "…", "merge": "union|vote|pick|none",
  "vote_threshold": 2, "pick": { "criterion": "…", "route": "…", "program": { "kind": "…" } },
  "runs": 3, "isolation": "sealed|tooled", "invention": "forbidden|allowed",
  "criteria_from": "request|document|runner", "criteria_ref": "…",
  "anchors": { "kind": "closed_list|quote", "values": ["…"], "source": "…" },
  "notes": ""
}
```

(Conditional fields appear only where their condition holds — `check_form.mjs`
rejects both missing-when-required and present-when-forbidden.)

**Worked example.** Request: "check the deployment plan for internal
contradictions" → an inspection with a matchable identity key (a section per
finding), target embeddable → sealed, report-only → invention forbidden:

```json
{
  "definition": "Enumerates internal contradictions in deploy-plan.md, one finding per section.",
  "merge": "union",
  "runs": 3,
  "isolation": "sealed",
  "invention": "forbidden",
  "criteria_from": "document",
  "criteria_ref": "deploy-plan.md",
  "anchors": { "kind": "closed_list", "values": ["## Rollout", "## Rollback", "## Approvals"], "source": "extract_anchors.mjs --mode headings" },
  "notes": ""
}
```

## 3. Coherence — run the code, not your judgment

`node <base>/scripts/check_form.mjs <form.json>` — prints `OK` or the violated
rules. On a violation: re-draft the form once, silently, and re-run. On a
second violation: reject — report the violated rule to the user
(`rejected_incoherent`) and stop. A missing `criteria_ref` document is C5
(`rejected_missing_target`).

Why one silent redraft, then reject: a first violation is usually this skill's
own form-filling slip, fixable without bothering the user; a second means the
request itself does not cohere, which only the user can resolve.

## 4. Record before dispatch (M5)

Run:

```
node <base>/scripts/record.mjs new --form <form.json> --digest "<one-sentence digest of the request>"
```

It prints the record path — keep it for the outcome update (§7). The record is
on disk before any run exists, so even an interrupted dispatch leaves its
trace.

## 5. Announce, then run (M7)

Print exactly one line in the user's language — definition digest, run count,
merge rule; name the preset if one matched. Then start immediately: the
announcement is the user's chance to interrupt, so it stands in for asking
permission.

- `실행: "plan.md의 모순 열거" — 3회 독립 실행, union 병합`
- `Run: "enumerate contradictions in plan.md" — 3 independent runs, union merge`

## 6. Run — a single Workflow call (M4)

Everything below happens in exactly one Workflow call.

1. Build the runner prompt from
   `<base>/references/runner-prompt-template.md`: replace the placeholders
   per its comments, then delete the comments. Sealed forms embed the full
   target content — the finished prompt is everything a runner will ever see
   (M2).
2. Call the Workflow tool with:
   - `scriptPath`: `<base>/references/run-workflow.js`
   - `args`: `{ "form": <the form>, "runnerPrompt": "<the prompt>",
     "target": <target text when anchors.kind is "quote", else null>,
     "model": <tier name only when the user named one, else null> }`
   The script runs N runners in parallel (sealed → the no-tools `salvo:runner`
   agent; tooled → the default agent), enforces the output schema at the
   dispatch layer (closed-list anchors as a schema enum; quote anchors
   substring-validated with up to 2 conformance re-requests), requires all N
   to succeed, and merges by code (M1/M11). A run set can take minutes — wait
   for it.
3. Act on the returned object's `kind`:
   - `merged` / `single` / `picked` → report (§7).
   - `candidates` (mechanical pick, command program) → write each candidate to
     a temp file (same temp-dir rule as §2) and run
     `node <base>/scripts/pick_command.mjs --command '<the stated command, from form.pick.program.command>' <files…>`;
     the printed `choice` names the winner. Report as a mechanical pick.
   - `void` → report the failure only (§7).

## 7. Report, then close the record

Transcribe the returned object — every number in the report comes from the
script, none from your own recount. Write the report in the user's
conversation language; the three claim labels below are fixed in meaning and
always shown.

- **merged**: header `독립 실행 N회, {union|vote} 병합` / `N independent runs,
  {union|vote} merge` (for vote add the threshold and how many groups fell
  below it), then each item as its anchor, its count, and the contributing
  contents. Echo the announcement's definition digest so the user can match
  report to record (S4).
- **picked**: show the selected candidate with the criterion text, labeled
  `기계 선택` / "mechanical pick" (name the program) or `판단 선택` / "judged
  pick" (quote the judge's grounds) (M6).
- **single**: the raw result plus the label `단일 실행 — 교차 검증 없음` /
  "single run — no cross-check" (M6).
- **void**: state which run failed and that no partial merge exists; re-running
  is the user's explicit choice (M8).

Then close the record:

```
node <base>/scripts/record.mjs outcome <record-path> <merged|void|delegated>
```

`merged` for measurements and picks, `delegated` for runs-1 dispatches, `void`
for failures.

## What keeps the platform honest

- Runners and the judge see only their own prompt (M2): isolating them is what
  makes N runs N independent measurements instead of one opinion echoed N
  times.
- A failed run voids the whole set (M8): a partial merge would report a
  denominator that never ran.
- Every dispatch passes through the same form (M9) and leaves a record before
  running (M5) — the pile of records, not design taste, decides which forms
  earn promotion to presets.
