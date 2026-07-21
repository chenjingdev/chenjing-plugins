# /tiers:deep-research setup

One AskUserQuestion call with all four questions (each offers "그대로 유지" reflecting the current config value in `${CLAUDE_PLUGIN_DATA}/deep-research.json`):

1. worker model — opus (Recommended) / sonnet / haiku / fable
2. effort — 그대로 유지(현재값, Recommended) + 나머지 티어를 깊이 내림차순(xhigh, max, high, medium, low)으로 3개 — 4칸에 못 실린 티어는 Other로 입력 가능하다고 질문 문구에 명시
3. judge (verify 투표관 ~75개) — worker와 동일 (Recommended) / opus / fable — warn in the fable option description that ~75 voters make it expensive
4. brain (scope+synthesize 2개) — inherit·세션 모델 (Recommended) / fable / worker와 동일

Then:

1. Write the result to `${CLAUDE_PLUGIN_DATA}/deep-research.json` (create the directory first if needed).
2. Show the saved JSON. Do not run the workflow.

(Do NOT edit plugin files — the plugin directory is a read-only cache that updates clobber.)
