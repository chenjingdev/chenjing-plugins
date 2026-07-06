---
name: ultracode
description: Use when the user runs /tiers:ultracode — ultracode-style multi-agent Workflow orchestration where EVERY sub-agent runs on one pinned model/effort tier (saved in config) instead of inheriting the session model.
argument-hint: "<작업> — 저장된 티어로 즉시 실행 | setup"
disable-model-invocation: true
---

# ultracode — one pinned tier

Invoking this skill is the user's explicit opt-in to Workflow multi-agent orchestration (equivalent to the "ultracode" keyword). Orchestrate exactly like ultracode — same quality patterns, same scaling — with ONE difference: EVERY sub-agent runs on one pinned tier, never the session model and never your own cost judgment. There are no per-role tiers in this skill: workers, verifiers, synthesizers — all identical. If the generic ultracode-keyword guidance also fires this turn, THIS contract wins on tier choice.

## Tier

Read `${CLAUDE_PLUGIN_DATA}/ultracode.json` → `{model, effort}`.
If the file is missing or unreadable, use: `{"model":"opus","effort":"xhigh"}`.

## Dispatch — decide by arguments

Arguments: $ARGUMENTS

| Arguments | Action |
|---|---|
| exactly `setup` | Setup mode (below) — do NOT orchestrate |
| non-empty | Resolve the tier from config, then apply leading override tokens if present: bare `opus\|sonnet\|haiku\|fable` → MODEL · bare `low\|medium\|high\|xhigh\|max` → EFFORT. Strip them; the remainder is the TASK. Orchestrate IMMEDIATELY — no questions. |
| empty | ① TASK = the user's most recent request in this conversation; if ambiguous, ask for it in plain text (mention the saved tier in one short parenthetical so the user can object). ② Orchestrate with the saved config — same as the non-empty path. No tier-selection UI. |

Before launching the workflow, state the resolved tier in one short line (e.g. "티어: opus/xhigh") so the user can interrupt if it's wrong.

## The contract — every agent() call

- EVERY `agent()` call MUST carry exactly `{model: MODEL, effort: EFFORT}` — both keys, no exceptions. A call missing `model` silently inherits the expensive session model — the exact failure this skill exists to prevent.
- Uniformity is the feature: do NOT downgrade "mechanical" stages, upgrade "hard" stages, or invent per-stage tiering. One tier for every agent, period.
- Mirror the tier in the `meta.phases` entries (`model: "<MODEL>"`) so the progress UI shows it.

## Standard Workflow rules still apply

- Pick patterns and scale by the task as usual (pipeline-first, adversarial verify, loop-until-dry…).
- `return` the final result object — `log()` output is not the return value.
- No silent caps: `log()` whatever you drop.
- `isolation` is only ever the string `'worktree'`, and only when parallel agents mutate files.

## Setup mode (`/tiers:ultracode setup`)

One AskUserQuestion call with both questions (each offers "그대로 유지" reflecting the current config value):

1. model — opus (Recommended) / sonnet / haiku / fable
2. effort — 그대로 유지(현재값, Recommended) + 나머지 티어를 깊이 내림차순(xhigh, max, high, medium, low)으로 3개 — 4칸에 못 실린 티어는 Other로 입력 가능하다고 질문 문구에 명시

Then: ① Write the result to `${CLAUDE_PLUGIN_DATA}/ultracode.json` (create the directory first if needed). ② Show the saved JSON. Do not orchestrate. (Do NOT edit this SKILL.md — the plugin directory is a read-only cache that updates clobber.)

## Examples

```
/tiers:ultracode 이 diff 리뷰해줘                → 저장된 티어로 즉시 실행
/tiers:ultracode sonnet low quick sanity check   → 이번만 sonnet/low
/tiers:ultracode                                 → 직전 대화의 작업으로 즉시 실행 (모호하면 물어봄)
/tiers:ultracode setup                           → 기본 티어 변경
```

After the workflow returns, synthesize the result for the user in the main loop as usual, and state in one line which tier it ran on.
