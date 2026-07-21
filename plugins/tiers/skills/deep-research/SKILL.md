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
| exactly `setup` | Read `${CLAUDE_PLUGIN_ROOT}/skills/deep-research/references/setup.md` and follow it — do NOT run the workflow |
| non-empty | Run IMMEDIATELY, no questions: `Workflow({scriptPath: <engine.js path>, args: {question: <arguments>, ...config}})`. CRITICAL: `args` must be an actual JSON object in the tool call — NEVER a JSON-encoded string (a quoted string turns the whole JSON into the question and silently drops every tier). Arguments present = the user chose the saved defaults. Sole exception: leading `model=` / `effort=` / `judge=` / `brain=` tokens are one-off overrides — apply them over config and strip them from the question. |
| empty | ① Determine the research question: use it if the conversation clearly implies one; otherwise ask for it in plain text (mention the saved tiers in one short parenthetical so the user can object). ② Invoke the workflow with the question + saved config — same as the non-empty path. |

Before launching the workflow, state the resolved tiers in one short line (e.g. "티어: worker opus/high · judge opus · brain inherit") so the user can interrupt if they're wrong.

After the run, the workflow's return includes a `tiers` field — synthesize the report for the user and state in one line which tiers it actually ran on.
