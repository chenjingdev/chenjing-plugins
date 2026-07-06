---
name: deep-research
description: Use when the user runs /tiers:deep-research — dispatches the tier-pinned deep-research workflow (bundled engine.js) using saved tier config.
argument-hint: "<리서치 질문> — 저장된 티어로 즉시 실행 | setup"
disable-model-invocation: true
---

# deep-research — tier-pinned dispatcher

Wraps the workflow engine bundled with this skill: `${CLAUDE_PLUGIN_ROOT}/skills/deep-research/engine.js` (tier-pinned deep research: workers=search/fetch, judge=~75 verify voters, brain=scope+synthesize). Invoking this skill is the user's explicit opt-in to run that workflow via `Workflow({scriptPath, args})` — pass the engine.js path above (already resolved to an absolute path) as `scriptPath`. Fallback: if that path still shows a literal `${CLAUDE_PLUGIN_ROOT}`, use `<this skill's base directory>/engine.js` instead — the harness states the base directory when this skill loads.

## Config

Read `${CLAUDE_PLUGIN_DATA}/deep-research.json` → `{model, effort, judge, brain}`.
If the file is missing or unreadable, use: `{"model":"opus","effort":"high","judge":"opus","brain":"inherit"}`.

## Dispatch — decide by arguments

Arguments: $ARGUMENTS

| Arguments | Action |
|---|---|
| exactly `setup` | Setup mode (below) — do NOT run the workflow |
| non-empty | Run IMMEDIATELY, no questions: `Workflow({scriptPath: <engine.js path>, args: {question: <arguments>, ...config}})`. CRITICAL: `args` must be an actual JSON object in the tool call — NEVER a JSON-encoded string (a quoted string turns the whole JSON into the question and silently drops every tier). Arguments present = the user chose the saved defaults. Sole exception: leading `model=` / `effort=` / `judge=` / `brain=` tokens are one-off overrides — apply them over config and strip them from the question. |
| empty | ① Determine the research question: use it if the conversation clearly implies one; otherwise ask for it in plain text (mention the saved tiers in one short parenthetical so the user can object). ② Invoke the workflow with the question + saved config — same as the non-empty path. No tier-selection UI. |

Before launching the workflow, state the resolved tiers in one short line (e.g. "티어: worker opus/high · judge opus · brain inherit") so the user can interrupt if they're wrong.

## Setup mode (`/tiers:deep-research setup`)

One AskUserQuestion call with all four questions (each offers "그대로 유지" reflecting the current config value):

1. worker model — opus (Recommended) / sonnet / haiku / fable
2. effort — 그대로 유지(현재값, Recommended) + 나머지 티어를 깊이 내림차순(xhigh, max, high, medium, low)으로 3개 — 4칸에 못 실린 티어는 Other로 입력 가능하다고 질문 문구에 명시
3. judge (verify 투표관 ~75개) — worker와 동일 (Recommended) / opus / fable — warn in the fable option description that ~75 voters make it expensive
4. brain (scope+synthesize 2개) — inherit·세션 모델 (Recommended) / fable / worker와 동일

Then: ① Write the result to `${CLAUDE_PLUGIN_DATA}/deep-research.json` (create the directory first if needed). ② Show the saved JSON. Do not run the workflow. (Do NOT edit this SKILL.md — the plugin directory is a read-only cache that updates clobber.)

## After the run

The workflow's return includes a `tiers` field — synthesize the report for the user and state in one line which tiers it actually ran on.
