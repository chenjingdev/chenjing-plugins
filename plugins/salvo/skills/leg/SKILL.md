---
name: leg
description: Execute a frozen numbered task range through Codex or Claude Code with an external evidence gate. Use when the user asks to carry out several TODOs, plan steps, checkpoints, or tasks N through M autonomously; when a long-running goal has been checking items too early; or when every step must produce real file changes and pass explicit commands before the next step opens. Also use to resume or inspect an existing Salvo leg run.
---

# Salvo Leg

Use the external runner instead of trusting the current model's TODO checkboxes. The worker may submit only a candidate; the Node controller alone can mark a task passed after inspecting declared artifacts and rerunning verifiers with `shell:false`.

The explicit host surfaces are `$leg` in Codex and `/salvo:leg` in Claude Code. Both must invoke the same scripts in this skill; do not substitute a native goal, workflow, or TODO loop.

## Core contract

- Freeze the original task numbers and selected `N..M` range before work starts.
- Give one task to one headless Codex or Claude Code session at a time.
- Require at least one exact artifact path and one external verifier per task.
- Resume the same worker session with real failure output when verification fails; use a fresh context after repeated identical failures.
- Challenge a worker's first blocker claim with a fresh context; stop only when the same concrete user-only need is independently confirmed or the attempt budget is exhausted.
- Re-run every selected task's verifier plus the range regression checks at the end.
- Treat `goal`, native TODOs, worker summaries, and exit code 0 from the model process as progress signals only. None is completion evidence.

## 1. Build the plan

Use the user's existing numbered plan when one exists. Do not silently renumber, merge, insert, or skip tasks in the requested range. If no executable plan exists, write `.salvo/leg.plan.json` in the project using the shape in [plan-example.json](references/plan-example.json).

Each selected task must contain:

- `id`, `title`, and concrete `instructions`;
- user-readable `acceptance` criteria;
- exact `artifacts` paths, without globs;
- one or more `verify` entries whose `argv` is a string array, never a shell command string;
- `require_change` and `max_attempts`.

The plan must also contain at least one `final_verify` regression command. Put acceptance tests, verifier programs, lockfiles, or other files workers must not weaken in the top-level `protected` array whenever they live inside the workspace. A protected path is hashed when the run starts; any change blocks completion. Prefer a verifier independent from the artifact it judges.

Verifier commands are executable trusted input. Inspect them before starting. Do not encode them as `bash -c`, `sh -c`, pipes, redirects, or interpolated strings. If a task has no honest machine-checkable proof, stop and say that the plan is missing a verifier; do not invent a cosmetic check.

## 2. Check and announce the frozen range

Resolve this skill's directory as `<skill-root>`, then run:

```sh
node <skill-root>/scripts/leg.mjs check-plan .salvo/leg.plan.json --tasks N..M
```

Read the normalized output. Confirm that the selected IDs, artifact paths, verifier argv arrays, project root, and final gate match the request. Announce one short line naming the range, engine, and number of tasks, then start immediately when the user's request already authorized execution.

## 3. Start the external run

Use the current host unless the user named another engine:

```sh
node <skill-root>/scripts/leg.mjs start .salvo/leg.plan.json \
  --tasks N..M \
  --engine codex
```

or:

```sh
node <skill-root>/scripts/leg.mjs start .salvo/leg.plan.json \
  --tasks N..M \
  --engine claude
```

Codex defaults to the compatibility floor `gpt-5.4` at high reasoning effort; override it with `--model MODEL` or `SALVO_CODEX_MODEL` when the user chooses another model. Claude Code uses its host default unless `--model MODEL` or `SALVO_CLAUDE_MODEL` is set. Wait for the process: it deliberately owns several model calls and may take minutes.

The controller stores its authoritative state outside the workspace. It uses `$PLUGIN_DATA/legs/<run-id>/` when the plugin host provides that directory, otherwise `~/.local/state/salvo/legs/<run-id>/`. A state root inside the project is rejected. Do not edit the ledger directory. The source plan is copied into state by value and hashed, so later plan edits cannot change the active range.

## 4. Handle the outcome

`complete` means every selected task passed its own verifier and the final regression gate. Report:

- tasks passed and attempt count;
- the final evidence receipt path;
- a plain-language result, not the workers' raw self-reports.

`blocked` is an honest terminal result, not partial success. Inspect it with:

```sh
node <skill-root>/scripts/leg.mjs status <run-id> --json
```

After the user supplies a missing decision or deliberately authorizes one more attempt:

```sh
node <skill-root>/scripts/leg.mjs resume <run-id> \
  --retry-blocked \
  --note "the user's new decision or recovery instruction"
```

Without `--retry-blocked`, `resume` never clears a blocked state.

If a verifier changed an artifact or protected path, the run is tainted and resume remains blocked until the exact pre-check snapshot is restored. Fix or replace the mutating verifier before retrying. A non-mutating final regression failure reopens the implicated task (or the last task when no owner can be inferred), passes the final receipt back as recovery context, and reruns the whole final gate afterward.

## Boundaries

- Use one writer per workspace. Parallel write workers require separate worktrees and are not part of this version.
- This prevents accidental shallow completion, not a malicious model with unrestricted access to the user's account. Claude Code's allowed Bash tools are not an OS sandbox.
- A weak verifier still proves little. Only declared artifacts and protected paths are tracked; omitted tests, transitive scripts, and a verifier that mutates then restores within one process remain part of the trusted boundary. Strengthen and protect the acceptance test instead of adding more prompt pressure.
- For subjective artifacts, use a separate review command or reviewer program whose output is itself checkable. Never label unverified taste as mechanically passed.
- There is no multi-controller file lock or orphan cleanup yet. Keep one controller and one writer per workspace, and inspect state after a parent crash.
- `/goal` may keep the parent session alive, but the leg receipt remains the only completion authority.
