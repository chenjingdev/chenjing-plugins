---
name: ultracode
description: Use when the user runs /tiers:ultracode — ultracode-style multi-agent Workflow orchestration where EVERY sub-agent runs on one pinned model/effort tier (saved in config) instead of inheriting the session model.
argument-hint: "<작업> — 저장된 티어로 즉시 실행 | setup"
disable-model-invocation: true
---

# ultracode — one pinned tier

Invoking this skill is the user's explicit opt-in to Workflow multi-agent orchestration (equivalent to the "ultracode" keyword). Orchestrate exactly like ultracode — same quality patterns, same scaling, standard Workflow rules — with ONE difference: EVERY sub-agent runs on one pinned tier, never the session model and never your own cost judgment. No per-role or per-stage exceptions: every agent gets the same tier. If the generic ultracode-keyword guidance also fires this turn, THIS contract wins on tier choice.

## Tier

Read `${CLAUDE_PLUGIN_DATA}/ultracode.json` → `{model, effort}`.
If the file is missing or unreadable, use: `{"model":"opus","effort":"xhigh"}`.

## Dispatch — decide by arguments

Arguments: $ARGUMENTS

| Arguments | Action |
|---|---|
| exactly `setup` | Read `references/setup.md` (relative to this skill's base directory) and follow it — do NOT orchestrate |
| non-empty | Resolve the tier from config, then apply leading override tokens if present: bare `opus\|sonnet\|haiku\|fable` → MODEL · bare `low\|medium\|high\|xhigh\|max` → EFFORT. Strip them; the remainder is the TASK. Orchestrate IMMEDIATELY — no questions. |
| empty | TASK = the user's most recent request in this conversation; if ambiguous, ask for it in plain text (mention the saved tier in one short parenthetical so the user can object). Then orchestrate with the saved config — same as the non-empty path. |

Before launching the workflow, state the resolved tier in one short line (e.g. "티어: opus/xhigh") so the user can interrupt if it's wrong.

## The contract — every agent() call

- EVERY `agent()` call MUST carry exactly `{model: MODEL, effort: EFFORT}` — both keys, no exceptions. A call missing `model` silently inherits the expensive session model — the exact failure this skill exists to prevent.
- Uniformity is the feature: do NOT downgrade "mechanical" stages, upgrade "hard" stages, or invent per-stage tiering.
- Mirror the tier in the `meta.phases` entries (`model: "<MODEL>"`) so the progress UI shows it.

After the workflow returns, synthesize the result for the user in the main loop as usual, and state in one line which tier it ran on.
