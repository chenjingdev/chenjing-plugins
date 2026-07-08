# Gate Report: salvo Weapon Platform (/salvo door)

> spec: ./SPEC.md
> Pass rule: zero confirmed blocking = passed (G-4) · no round cap (stopping is the user's call) (G-8)

## Round 1 — 2026-07-08T16:47:16Z — reader: opus ×3

**Verdict: blocked (1 confirmed blocking)**

| # | Severity | Category | Title (anchor) | Votes | Status |
|---|---|---|---|---|---|
| R1-1 | confirmed blocking | decision | Fold execution substrate: literal executed code over structured shooter outputs vs a deterministic LLM recipe — the M1 "pure code" pipeline and the shooter-output schema it consumes are unspecified (M1 / §4 step 10) | 2/3 | open |
| R1-2 | informational (discretionary) | decision | Target/reference slot & embedding responsibility: the form has no explicit target field; `isolation` prose vs reader-table vs `criteria_from` leave "who embeds what" implied (§2.1 isolation / criteria_from / C5) | 3/3 | display-only |
| R1-3 | informational (discretionary) | criteria | "Shooter fails to complete" undefined (error? timeout? malformed output?) — gates AC6 testability (§5 volley_void / AC6) | 3/3 | display-only |
| R1-4 | informational (discretionary) | decision | AC5 requires the announcement to name the preset, but the announcement contract (definition/volley/fold) omits preset identity (AC5 / §3 ANNOUNCED) | 3/3 | display-only |
| R1-5 | informational (discretionary) | decision | Shooter-output structure that fold consumes is undefined as a separate discretionary item (§2.3 / M1) | 2/3 | subsumed by R1-1 |
| R1-6 | informational (discretionary) | term | Preset intake-form-file marker, filename, and scan path undefined (§2.2 / §4 step 3) | 2/3 | display-only |
| R1-7 | informational (discretionary) | decision | Report language not pinned (A6 covers announcement and form only) (§2.3 Report / A6) | 2/3 | display-only |
| R1-8 | informational (discretionary) | decision | `pick_criterion` involving a test command vs M4's "never executes the work" (§2.1 pick_criterion / M4) | 1/3 | display-only |
| R1-9 | informational (discretionary) | decision | Which fold modes v1 must implement (all four vs AC-tested two) (I-1 / §2.1 fold) | 1/3 | display-only |
| R1-10 | informational (discretionary) | decision | `union` same-anchor different-content tie-break (§2.1 fold=union) | 1/3 | display-only |

Aggregation notes (mechanical, by anchor + thesis):

- R1-1: reader #2 blocking (anchor M1/§2.1 Fold/§4-10) + reader #3 blocking
  (anchor M1/§4-10/§2.3) — same anchor set, same thesis (is "pure code" an
  actually executed script over machine-parseable shooter outputs, or the
  invoking LLM following a fixed deterministic recipe; either way the shooter
  output schema is missing). Summed to 2/3. Reader #1 raised the schema facet
  at discretionary severity — not counted toward the blocking tally.
- R1-2 merge basis: reader #1 disc-1 ("who embeds target"), reader #2 disc-2
  ("enum has no slot for the attached path"), reader #3 disc-1/disc-5
  ("criteria_from doubles as target source; sealed embed vs M4") share one
  thesis — the form lacks an explicit target/reference slot and the embedding
  responsibility is implied, not stated. Anchors identical (§2.1).
- R1-3, R1-4: raised by all three readers with matching anchors and theses.
- Discretionary items do not block passing (G-4); they are displayed for the
  implementer and left out of the feedback loop.

## Round 2 — 2026-07-08T17:53:36Z — reader: opus ×3

**Verdict: blocked (1 confirmed blocking)**

| # | Severity | Category | Title (anchor) | Votes | Status |
|---|---|---|---|---|---|
| R2-1 | confirmed blocking | decision | `pick` fold: a free-string `pick_criterion` cannot be evaluated by deterministic code without an LLM or an undefined grammar; command-execution capability unscoped; unclear whether `pick` ships functional in v1 (§2.1 pick_criterion / M1 / §4 step 10 / I-1) | 2/3 | open |
| R2-2 | solo blocking (informational) | decision | Anchor granularity: several distinct findings sharing one anchor — literal "dedup by anchor" collapses them; vote counts section-agreement, not finding-agreement (§2.1 fold/anchors / AC1) | 1/3 | display-only |
| R2-3 | solo blocking (informational) | decision | Fold/extractor execution substrate: fixed scripts shipped with the plugin vs LLM-generated code per firing — both "deterministic" but different fidelity to M1 (M1 / §4 steps 5,8,10 / I-6) | 1/3 | display-only |
| R2-4 | solo blocking (informational) | decision | The shooter target / criteria-document reference has no home field in the IntakeForm, though C5 checks its existence at form-completion time (§2.1 / C5 / §5) | 1/3 | display-only |
| R2-5 | informational (discretionary) | decision | Re-request bound before "never conforms" (e.g. 2) + timeout definition (M11 / §5) | 3/3 | display-only |
| R2-6 | informational (discretionary) | decision | Preset scan root + fixed intake-form filename (§2.2 / AC5) | 3/3 | display-only |
| R2-7 | informational (discretionary) | decision | Fold/extractor/validator as fixed scripts under the plugin's lib, invoked via shell (M1) | 2/3 | resolution matching R2-3 offered at discretionary severity |
| R2-8 | informational (discretionary) | criteria | AC1's exact forged field values vs a non-deterministic forge — treat as canonical-run targets (AC1 / §4 step 4) | 2/3 | display-only |
| R2-9 | informational (discretionary) | decision | Report language: user's conversation language, guess label verbatim (A6 / §2.3) | 1/3 | display-only |
| R2-10 | informational (discretionary) | decision | vote tally = distinct shooters per anchor, within-shooter duplicates collapsed; union lists all distinct contents per anchor (§2.1 / §4 step 11) | 1/3 | resolution matching R2-2 offered at discretionary severity |

Aggregation notes (mechanical, by anchor + thesis):

- R2-1: reader #1 blocking (anchor §2.1 pick_criterion / M1 / step 10 / I-1) +
  reader #3 blocking (anchor §2.1 pick_criterion / M1 / §4 step 10) — same
  anchors, same thesis (free-form criterion vs code-only evaluation; test-command
  execution unscoped; v1 scope of `pick` undecided). Summed to 2/3.
- R2-2 (reader #1), R2-3 (reader #2), R2-4 (reader #2): solo blockings — no
  second reader raised the same thesis at blocking severity. Displayed only.
- R2-5, R2-6: same thesis raised by 3 and 3 readers respectively at
  discretionary severity.
- Discretionary items do not block passing (G-4).

## Round 3 — 2026-07-08T18:10:26Z — reader: opus ×3

**Verdict: passed (0 confirmed blocking)**

| # | Severity | Category | Title (anchor) | Votes | Status |
|---|---|---|---|---|---|
| R3-1 | solo blocking (informational) | decision | `mechanical` pick: no specified encoding lets code turn a free-text criterion into a deterministic evaluation without an LLM interpreting it; readers #1/#2 treated the same ground as discretionary (route free-text to `judged`, keep `mechanical` for criteria that map to a small built-in evaluator set) (§2.1 pick_criterion / M1 / I-7) | 1/3 | display-only |
| R3-2 | informational (discretionary) | criteria | Re-request cap before "never conforms" (readers propose 1–2) (§2.3 / M11) | 3/3 | display-only |
| R3-3 | informational (discretionary) | decision | Anchor-extractor directive + shipped extractor set; fall back to verbatim-quote when no extractor fits (§2.1 anchors / C6) | 3/3 | display-only |
| R3-4 | informational (discretionary) | decision | Preset intake-form filename + scan scope (§2.2 / I-3 / AC5) | 3/3 | display-only |
| R3-5 | informational (discretionary) | decision | Per-anchor content representative when shooters share an anchor (counting unaffected) (§2.1 fold / §4 step 11) | 2/3 | display-only |
| R3-6 | informational (discretionary) | decision | Report prose in user's language, honesty labels verbatim (M6 / A6) | 2/3 | display-only |
| R3-7 | informational (discretionary) | term | "Target" defined as the content embedded per `criteria_from` / the repository for `tooled` (§2.1) | 2/3 | display-only |

Aggregation notes (mechanical, by anchor + thesis):

- Reader #1: 0 blocking (explicitly notes the round-2 anchor-granularity
  concern is resolved by the document: anchor = sole identity, tally =
  distinct shooters; and R2-1 is closed by I-7). Verdict: implementable.
- Reader #2: 0 blocking. Verdict: implementable.
- Reader #3: 1 blocking (R3-1). No second reader raised it at blocking
  severity → 1/3, not confirmed.
- Zero confirmed blocking → **passed** (G-4). Frontmatter updated to `passed`
  by the writing session (G-5). No waivers.

### Details (Round 3)

#### Reader 1 (opus) — verdict: implementable
(0 blocking. Notes: anchor-granularity settled by `definition` example + AC1 +
M1/I-6 — one item per anchor, tally = distinct shooters; pick fork closed by
I-7. Discretionary: dispatch validate→re-request loop with cap ≈2; re-request
within the same shooter session; fold as a fixed shipped script invoked via
Bash — not per-firing generated code; per-anchor content listing; AC5
announcement carries preset name; scan/marker/serialization details; per-type
anchor extractors; criteria_from=document doubles as sealed target embed;
honesty labels verbatim; routing-boundary terms calibrated to AC2/AC3/AC4.)

#### Reader 2 (opus) — verdict: implementable
(0 blocking. Discretionary: one serialization format for form/residue; fold as
a real script under the plugin lib; "target" := content embedded per
`criteria_from` (repository for `tooled`); minimal extractor set, forge picks
union/vote only when an extractor supports the target; re-request budget ≈1;
fixed intake-form filename as registry marker; report in user's language with
verbatim labels; forge defaults (union/vote ⇒ invention=forbidden;
pick/delegation ⇒ allowed); residue outcome as second write. Out-of-scope:
harness schema-enforcement capability; sandboxing of stated test commands.)

#### Reader 3 (opus) — verdict: 1 blocking issue to resolve
(BLOCKING R3-1: free-text `mechanical` pick criterion vs deterministic
evaluation — proposals: (A) small built-in evaluator set, forge routes
unmappable criteria to `judged`; (B) forge authors a machine-executable
descriptor at form time — LLM authors the check, never selects; (C) defer
mechanical pick (contradicts I-7). Discretionary: per-anchor content
representative; re-request cap ≈2; extractor kind directive + registry with
quote fallback; preset filename/scan; clamp forge volley to 5; digest in
English by the forge; tooled tool set without sub-delegation.)

### Details (Round 2)

#### Reader 1 (opus) — verdict: 2 blocking issues to resolve

(BLOCKING: anchor granularity §2.1/AC1; pick_criterion evaluability + command
execution + v1 scope §2.1/M1/step 10/I-1. DISCRETIONARY: anchors field
re-typing to a structured declaration; fixed extractor library with
quote-anchor fallback; fold as a fixed parametrized program invoked via Bash;
re-request bound (validation + one in-shot re-request); preset scan
location/marker; rejection-vs-delegation boundary reading; AC1 field values as
canonical-run targets. OUT-OF-SCOPE: harness schema-enforcement capability;
command/test execution environment; slash-command registration.)

#### Reader 2 (opus) — verdict: 2 blocking issues to resolve

(BLOCKING: fold/extraction/coherence execution substrate — shipped fixed
scripts vs per-firing LLM-generated code (M1/§4/I-6); target and
criteria-document reference has no home in the form contract (§2.1/C5/§5).
DISCRETIONARY: re-request bound ≈2; "dispatch layer" defined as invoking-
session wrapper validating in code then re-prompting within the shot;
rejected_missing_target bypasses the silent re-draft; clamp forge volley to 5;
residue = form fields + metadata keys ignored on promotion copy; skill scan
root + fixed filename. OUT-OF-SCOPE: native per-call schema enforcement in the
harness.)

#### Reader 3 (opus) — verdict: 1 blocking issue to resolve

(BLOCKING: `pick` — functional v1 mode or reserved? how does pure code
evaluate a free-form criterion (§2.1/M1/step 10). DISCRETIONARY: preset scan
root + filename (AC5 needs a test preset); report in user's language with
verbatim guess label; re-request bound + timeout; vote counts distinct
shooters, union lists distinct contents per anchor; fold/extractor/validator
as scripts under the plugin lib invoked via shell; forge prompt engineered so
the canonical AC1 request reliably yields the specified form. OUT-OF-SCOPE:
harness parallel-spawn / isolation / schema-enforcement capabilities.)

Full reader outputs for round 2 are preserved in the session transcript; the
tables above are the mechanical aggregation record.

### Details (Round 1)

#### Reader 1 (opus) — verdict: implementable

### BLOCKING

none

### DISCRETIONARY

- **[decision] Responsibility for embedding the target content is split/ambiguous between `isolation` and `criteria_from` (anchor: §2.1 isolation/criteria_from)** — how I would decide: §2.1 prose says `sealed` "target content is embedded in the shooter prompt," but the reader table lists `isolation` as *tool/repository access only*, and `criteria_from` = `shooter` embeds nothing — so a `sealed` + `criteria_from=shooter` measurement has no field carrying the target. I would treat `sealed` isolation as the trigger for the dispatch step to embed the target content (identified from `definition`/request), and `criteria_from` as an *additional* judgment-basis embed (request text / named document / none), letting them coincide (as in AC1's `sealed` + `criteria_from=document`).
- **[decision] No shooter-output schema is defined, yet fold is "pure code" keyed on anchors (anchor: §2.3 / M1)** — how I would decide: define a single structured shooter output (a list of `{anchor, item}` records) mandated by the shooter prompt for `union`/`vote`; `none`/delegation passes the raw result through. This is the only direction consistent with M1 ("no LLM judgment in fold").
- **[decision] `pick` fold running a stated test command vs M4 (anchor: §2.1 pick_criterion / M4)** — how I would decide: M4 explicitly lists "folds" as an invoking-session responsibility and forbids only executing *the work* (the measurement/generation); so a `pick_criterion` like "shortest output that passes the provided test command" is evaluated by the folding session running that command. Fold mechanics (including running a provided check) are permitted.
- **[decision] Which fold modes v1 must actually implement (anchor: I-1 / §2.1 fold)** — how I would decide: I-1's "forge skeleton" is ambiguous, but the contract defines all four modes with full mechanics; I would implement `union`/`vote`/`pick`/`none`, not just the AC-tested `union`/`none`.
- **[term] Preset intake-form-file location and recognition rule are undefined (anchor: §2.2 / in-scope item 7 / AC5)** — how I would decide: scan the plugin's skills directory (e.g. `plugins/salvo/skills/*/`) for a fixed-name form file in the single serialization format, and load its `definition` for router matching. v1 finds none; the mechanism still runs and falls through.
- **[criteria] "Shooter fails to complete" is not defined (anchor: §2.3 / §5 volley_void / AC6)** — how I would decide: a shooter "fails" when its dispatch errors, times out, or returns no result; a well-formed but empty finding-set is a *success* and folds normally. This makes AC6 testable.
- **[criteria] AC5 requires the announcement to "name the preset," but the announcement spec (definition/volley/fold) omits preset identity (anchor: AC5 / M7 / S4)** — how I would decide: when a preset is used, the single announcement line additionally names the preset's skill; the forged path names no preset.
- **[decision] `union` dedup tie-break when two shooters share an anchor but differ in content (anchor: §2.1 fold=union)** — how I would decide: keep the first-seen (or longest) item per anchor; this is anchor-normalization detail explicitly delegated under MAY.

### OUT-OF-SCOPE
- How the `/salvo` command and its shooter subagents are wired into the plugin/skill harness (dispatch API, model/effort tier) — explicitly delegated (A1, A5, MAY) and is harness infrastructure, not spec logic.
- Promotion procedure, legacy weapon re-registration, cost/token accounting, and the `/spec` door/gate — all named in §1 "Out of scope."

### VERDICT
implementable. Over-detailed on axes: the state model, error taxonomy, coherence rules C1–C5, MUST/SHOULD/MAY invariants, and a full Decision Ledger + Assumptions pre-settle every major fork (single-fire, one form, mechanical fold, residue-before-dispatch). Under-detailed on three contract seams that each have only one workable resolution: the shooter→fold output schema, the target-content embedding responsibility (`isolation` vs `criteria_from`), and the concrete preset-file discovery (scan path + filename) — all safely decidable at implementer discretion without diverging from author intent.

#### Reader 2 (opus) — verdict: 1 blocking issue to resolve

### BLOCKING

- **[decision] Fold execution substrate: literal executable code vs mechanically-constrained LLM steps (anchor: M1 / §2.1 Fold / §4 step 10)**
  - What is ambiguous: The founding claim and M1 demand that the fold "performs no LLM judgment" and is "pure-code aggregation." But the fold runs *inside the invoking session*, which is an LLM agent (§1: "the invoking session only routes, announces, folds, reports, and archives"). The spec never says whether "pure code" means the session must write and execute a real deterministic script (e.g. shell out to a dedup/tally program) or whether it means the LLM applies a fixed rule "mechanically" from prompt instructions with no code artifact.
  - Why I cannot decide it at my discretion: This forks the deliverable itself (a `lib/` of executable fold routines + orchestration vs. a prompt-only skill) and it forks whether M1's "no LLM judgment" guarantee is actually honored. A prompt-only "mechanical" fold is still LLM-produced and cannot be proven judgment-free, which would break the platform's entire "measurement, not guess" value proposition. Picking wrong risks either over-building infrastructure the author didn't intend or shipping a fold that violates the core invariant.
  - Proposals (these are the implementer's guesses):
    - A. The session persists each shooter's structured output to files and invokes an actual deterministic script (union-dedup / vote-tally / pick) whose result the session only relays — true pure code, strongest M1 fidelity.
    - B. The `/salvo` skill is prompt-only; the session applies the fold rule by following strict deterministic instructions, no executable artifact (matches a skill-only substrate but weakens the no-judgment guarantee).
    - C. Hybrid: session normalizes anchors via prompt, but the merge/tally/pick decision is delegated to a small embedded script for the parts that must be provably mechanical.

### DISCRETIONARY

- **[decision] Shooter output structure that fold consumes (anchor: §2.3 Shooter / §4 step 10)** — how I would decide it: MAY delegates "shooter prompt wording," but anchor-keyed union-dedup and vote-tally require a defined structure, not just wording. I would require every shooter to emit a list of `(anchor, content)` items in a fixed machine-parseable shape, and treat that as the fold input contract.
- **[decision] Where the document path/reference lives when `criteria_from` = `document` (anchor: §2.1 `criteria_from` / C5)** — how I would decide it: The field is an enum with no slot for the attached path, yet C5 must check existence and the reader must embed content. I would serialize `criteria_from` as a tagged value carrying the ref (or add a `criteria_ref` field whose reader is shooter-prompt construction), keeping it inside the one serialized form so M10 format-identity holds.
- **[criteria] What counts as a shooter "failing to complete" (anchor: §5 `volley_void` / §2.3 Volley / AC6)** — how I would decide it: The spec only says "fails to complete." I would count non-return, hard tool/agent error, *and* output that does not conform to the required structure (unparseable for fold) all as failures that void the whole volley, since a mechanical fold cannot repair malformed input.
- **[decision] Report language and exact fold-summary wording (anchor: §2.3 Report / AC1 / A6)** — how I would decide it: A6 fixes announcement language (user's) and form/residue language (English) but is silent on the report. I would render the report in the user's conversation language, echo the same definition digest (S4), treat AC1's "3 shots, union fold" as illustrative, and keep the `volley` = 1 label verbatim Korean per M6.
- **[decision] Announcement must also name the preset (anchor: §3 ANNOUNCED / AC5)** — how I would decide it: §3/S4 define the announcement as definition+volley+fold, but AC5 requires it to name the source preset. I would append the preset skill's name to the announcement whenever the form came from a preset rather than the forge.

### OUT-OF-SCOPE
- The harness's capability to execute deterministic code within the `/salvo` session (and to spawn starved parallel subagents) is an environment/tooling matter the spec does not address; it is the substrate that determines whether the blocking fold issue can be resolved via option A/C.

### VERDICT
1 blocking issue to resolve. The spec is over-detailed on scaffolding (an 11-state machine, a full error taxonomy, 10 MUST invariants, a reader table) but under-detailed on the one mechanism its entire "measurement" claim rests on: how the fold is actually executed (code vs. disciplined LLM) and the structured shooter-output schema that fold must consume.

#### Reader 3 (opus) — verdict: 1 blocking issue to resolve

### BLOCKING

- **[decision] How the "pure code" mechanical fold is actually executed — the M1 pipeline is unspecified (anchor: M1 / §4 step 10 / §2.3 Report)**
  - What is ambiguous: The founding claim is "folded by pure code," and M1 requires the fold to perform "no LLM judgment," operating "on anchors, counts, and stated mechanical criteria only." But the `/salvo` door is an LLM session; the dispatch API is delegated (MAY) and in practice returns unstructured subagent text; and no step in §4 captures shooter output into a machine-parseable structure or runs an actual fold program. The spec never states whether "pure code" means (a) a real script executed over captured structured outputs, or (b) the invoking LLM following a strictly deterministic recipe (exact-string anchor equality + counting) in-context. It also never defines the shooter output schema that a code fold would need to extract `anchors` and items from.
  - Why I cannot decide it at my discretion: The two readings produce materially different architectures and different M1-compliance guarantees, and this is the platform's entire value proposition ("a salvo is a measurement"). Reading (b) risks silently violating the founding claim, since LLM anchor-matching/dedup is fuzzy and non-deterministic — i.e. exactly the "guess" the spec exists to eliminate. Reading (a) forces a shooter-output-to-file contract plus a code-execution step that reshape the dispatch and collection stages (§4 steps 8–11) and gate whether AC1's "anchor-deduped findings" is even verifiable. Guessing wrong diverges from author intent at the core.
  - Proposals (these are the implementer's guesses):
    - A. Shooters emit a machine-parseable structure (e.g. JSON items `{anchor, content}`) written to known files; the invoking session runs an actual fold script (union-dedup / vote-tally / pick) over them — literal M1.
    - B. Shooters return inline structured text; the invoking session folds via a fixed deterministic recipe treated as "code" (exact-string anchor equality, integer counts) with no script.
    - C. Hybrid: inline structured output captured to a temp file, then a small script performs the fold.

### DISCRETIONARY
- **[term] `criteria_from` doubles as the target-content source, yet there is no `target` field (anchor: §2.1 `criteria_from` / `isolation`)** — how I would decide it: read the field per the reader table ("embeds request text or document content"), i.e. treat it as "what content to embed" for sealed shooters — `document`→embed the referenced file, `request`→embed the request text, `shooter`→embed nothing (generation/tooled work). Follow AC1's precedent: when the target is a file, `criteria_from` = `document`.
- **[decision] What marks a file as an "intake form file," and where skills are scanned (anchor: §2.2 / §4 step 3 / in-scope item 7)** — how I would decide it: define a single conventional filename (e.g. `salvo.form.<ext>`) in a skill's root as the registry marker, and scan the plugin's skills directory; with zero presets in v1 this always falls through to the forge.
- **[decision] A preset has no name/identity field for AC5's "announcement names the preset" (anchor: AC5 / §2.2)** — how I would decide it: use the enclosing skill directory name as the preset's announced identity.
- **[criteria] "Shooter fails to complete" is undefined for `volley_void` (anchor: §5 `volley_void` / AC6)** — how I would decide it: treat a subagent error, timeout, or output that fails schema validation as a failure; any such case voids the volley (M8, no retry).
- **[decision] Who reads/embeds the target for sealed isolation, given M4 restricts the invoking session (anchor: §2.1 `isolation` / M4)** — how I would decide it: the forge (invoking session) reads the target during form construction and embeds it; this is form-building, not "executing the work," so M4 is preserved.
- **[decision] Report language (anchor: §2.3 Report / A6)** — how I would decide it: A6 pins only the announcement to the user's language; since the report is user-facing, render it in the user's conversation language while keeping the verbatim label "한 발은 짐작" for `volley` = 1.

### OUT-OF-SCOPE
- Whether the target harness exposes a code-execution surface (Bash/script/tool) usable over shooter outputs — an environment capability that determines whether the blocking issue's proposal A is even available. This is deployment/infra, outside the document's scope, but it constrains the blocking resolution.

### VERDICT
1 blocking issue to resolve. The spec is over-detailed on its axes — the state model, error taxonomy, readers table, coherence rules (C1–C5), and invariants (M1–M10) are exhaustively and cleanly nailed. It is under-detailed on the one thing the whole claim rests on: the concrete fold-execution pipeline and the shooter-output contract that make M1's "pure code, no LLM judgment" actually realizable and AC1/AC6 verifiable; preset-discovery mechanics are also thin (acceptable only because v1 ships zero presets).
