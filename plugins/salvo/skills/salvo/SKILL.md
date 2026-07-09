---
name: salvo
description: "Routing door over sub-skills bundled with the plugin — state work in plain language and it routes to the right sub-skill via a live routing-card scan; the routing decision is mechanical (an isolated classifier reduces the request to a switch vector, a code table picks the destination — not the model); you never need to know what sub-skills exist. When no card matches, the built-in engine handles it: it fills a standard intake form, runs N independent isolated agents in ONE Workflow call, and merges their outputs with code so every count is recountable — it also delegates single-run work to another session. Use this whenever the user invokes /salvo, wants work routed to the right bundled sub-skill, wants work fanned out to several independent agents and merged, wants a measured (recountable) result instead of one model's opinion, or wants work done outside the current session. Usage: /salvo <request>"
---

# /salvo — a routing door over bundled sub-skills

/salvo is a routing door: state work in plain language and it routes to the
sub-skill whose routing card matches, discovered live from disk at request
time. You never need to know what sub-skills ship — no matter how many there
are, the only thing standing in session context is this door's own description;
the inventory is never loaded wholesale (M12).

Behind the door sits the built-in engine, and its founding claim: one pass is a
guess; several independent passes merged by code are a measurement — that is
the salvo. When no routing card matches, the door fills an intake form and the
engine runs it — filling that form is itself the routing decision (measurement,
delegation, or reject). This session only routes, announces, transcribes, and
archives; the runs happen in one Workflow call and every count comes out of
code — the workflow script and the bundled scripts — which is what keeps each
number recountable and this session's context clean enough to stay a fair
courier.

The numbered codes below (M1…, S1…, C1…, A6, D-6…) cite invariants in the
platform spec at `plugins/salvo/SPEC.md` (plugin repo). They are
traceability tags — this skill is executable without reading the spec.

**Language**: announcement and report in the user's conversation language;
the form and run records in English (machine-facing, A6).

Paths: `<base>` = this skill's base directory. Run records live at
`~/.claude/plugins/data/salvo-chenjing-plugins/records/` (D-6; the default of
`record.mjs`).

## 1. Route

Routing is mechanical (D-14/M15): an isolated classifier reduces the request to
a schema-enforced switch vector, and a code table over that vector — not this
session's judgment — picks the destination. This session only gathers the
conditions, calls the workflow, and transcribes what it returns.

1. **Collect conditions.** List every sibling sub-skill's routing card:
   `ls <base>/../*/card.md`. Build one condition object per sub-skill directory:
   - `name` = the directory name (this is the destination the table returns).
   - `requires` = read that dir's `condition.json` — the machine condition
     `{ "requires": { "<switch>": <value>, … } }` that sits beside the card's
     human prose.
   - `kind` = `preset` if the dir carries `intake-form.json`, `procedural` if it
     carries `instructions.md`.
   Collect these into an array. A sub-skill directory is therefore `card.md`
   (human "route here when …" prose) + `condition.json` (the machine condition
   the table evaluates) + `intake-form.json` (run preset) | `instructions.md`
   (procedural sub-skill). Sub-skills are bundled-only (M13) — this session
   never creates one; the only things it writes are ad-hoc forms and run
   records. (v1 ships zero sub-skills, so the array is empty — still run the
   workflow: the classifier's vector is both the form-filling prior (S6) and the
   record's routing block even with nothing to match.)

2. **Call the routing workflow.** Call the Workflow tool with:
   - `scriptPath`: `<base>/references/route-workflow.js`
   - `args`: `{ "request": "<the user's request text>", "conditions": <the
     array>, "model": null }`
   The classifier only flips switches inside a schema; the code table picks the
   destination (M15) — never choose it yourself. Write the returned object to a
   temp file (same temp-dir rule as §2): it is the routing block every record
   below carries (`--routing`), which is what makes routing recountable (AC8).

3. **Act on the returned `destination`** — transcribe the object, do not
   second-guess it:
   - **a run preset's name** (`destination_kind: "preset"`) → read that dir's
     `intake-form.json` and continue at §4 (record) with its form as-is, no new
     form drafted; pass `--routing` (step 2's file); the announcement (§5) names
     the sub-skill — that is how the user sees routing (AC5).
   - **a procedural sub-skill's name** (`destination_kind: "procedural"`) →
     write the routed record first (M5):
     `node <base>/scripts/record.mjs new --routing <routing.json> --digest
     "<one-sentence digest>" --outcome routed`; print one announcement line
     naming the sub-skill; then read and follow its `instructions.md`. This
     door's own flow ends here (ROUTED). If those instructions dispatch runs,
     they do so through the engine below.
   - **`engine`** → **fill the form (§2), starting from the switch prior (S6)**:
     `candidate_selection` ⇒ `pick`; `enumerable_findings` + `wants_confidence`
     ⇒ `vote`; `enumerable_findings` alone ⇒ `union`; `unattended_ok: false` ⇒
     probe the reject branch (the work likely needs the user mid-execution);
     `touches_environment` ⇒ `tooled`; `target_kind` hints criteria/embedding (a
     `document`/`repository` target is embedded or searched; `none` is pure
     generation). The prior is a default, not a cage — diverge where the request
     contradicts it; the vector and the final form land in one record, so the
     divergence is visible evidence.
   - **`fallback: true`** (the classifier failed — `routing_fallback`,
     non-fatal) → take the `engine` path, and the announcement (§5) additionally
     notes "라우팅 분류 실패 — 엔진 기본 경로" (meaning-fixed, rendered in the
     user's language).

A request for a spec or design document is not special-cased (D-10): it flows
through the form like any other work — typically a `pick` run over N candidate
drafts, or a single-run delegation. This skill never invokes or names another
plugin's skill.

`target_kind: conversation` has no sealed-embedding channel: when the target is
this session's own discussion, fold the relevant conversation text into the
request/target content yourself before classification (`criteria_from` stays
`request`) — a runner is never handed conversation history (M2).

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

Run (an engine dispatch always carries the §1 routing block too):

```
node <base>/scripts/record.mjs new --form <form.json> --routing <routing.json> --digest "<one-sentence digest of the request>"
```

`<routing.json>` is §1 step 2's file (the route-workflow return object), so the
record stores the switch vector, destination, and matched condition (D-14) and
routing is recountable (AC8). It prints the record path — keep it for the
outcome update (§7). The record is on disk before any run exists, so even an
interrupted dispatch leaves its trace.

## 5. Announce, then run (M7)

Print exactly one line in the user's language — definition digest, run count,
merge rule; name the sub-skill if one matched. Then start immediately: the
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
