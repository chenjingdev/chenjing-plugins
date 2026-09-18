# 하네스별 플래그·어휘·트랜스크립트

2026-09-05 기준. 모델 ID는 바뀌니 실행 전에 확인 명령을 한 번 돌린다.

## 워크스페이스 이름 → 명령

| 이름에 보이는 것 | 하네스 | 명령 | 확인 방법 |
|---|---|---|---|
| fable, opus, sonnet | claude | `ariabench claude --model fable --effort E` | `claude --help`의 `--model` 별칭 |
| sol | codex | `ariabench codex --model gpt-5.6-sol --effort E` | 이전 벤치 rollout의 `"model":"…"` |
| astra | codex | `ariabench codex --model gpt-6-astra --effort E` | `~/.codex/config.toml`의 `model =` |
| grok | grok | `ariabench grok --effort E` (기본 grok-4.6) | `grok models` |
| agy 3.8, gemini | agy | `ariabench agy --model gemini-3.8-flash-high --effort high` | `agy models` (모델 ID에 high/medium/low가 붙어 있다) |
| gpt-oss-120b | agy | `ariabench agy --model gpt-oss-120b-medium --effort medium` | `agy models` |

effort 어휘는 하네스마다 다르다. claude `low|medium|high|xhigh|max`, codex `low|medium|high|xhigh`, grok `none|minimal|low|medium|high|xhigh|max`, agy `low|medium|high`. 같은 이름끼리 비교할 때 각주가 필요하다.

## 트랜스크립트 위치와 도구 호출 형식

`extract_calls.py`가 아래를 안다. 새 하네스를 붙이면 이 표와 스크립트를 같이 갱신한다.

| 하네스 | 위치 | 도구 호출이 기록된 자리 | 시각 |
|---|---|---|---|
| Claude Code | `~/.bench/_claude/projects/<cwd 인코딩>/<session>.jsonl` | `message.content[].type=="tool_use"`, `name`은 `mcp__<server>__<tool>` | 줄의 `timestamp`(ISO) |
| Codex | `~/.bench/<app>/codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `payload.item.type=="McpToolCall"`, `tool`, `arguments`(`set_song`은 `song_json` 문자열), `result.isError` | 줄의 `timestamp` |
| Grok | `~/.bench/<app>/grok/sessions/<cwd 인코딩>/<session>/updates.jsonl` | `params.update.sessionUpdate=="tool_call"`, `title=="use_tool"`, `rawInput.tool_name`은 `<server>__<tool>`, `rawInput.tool_input` | `timestamp`(epoch 초) |
| agy | `~/.bench/<app>/agy/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl` | `PLANNER_RESPONSE` 단계의 `tool_calls[]`. MCP 호출은 `name=="call_mcp_tool"`, `args.ToolName`(따옴표 포함 문자열), `args.Arguments`(JSON 문자열, **잘려 있을 수 있음**) | `created_at` |

어느 세션이 어느 런인지는 프롬프트에 박은 런 태그(곡 제목)로 찾는다. 같은 태그의 세션이 여럿이면(재실행) 앱 도구 호출이 가장 많은 것, 또는 `export`가 있는 것을 고른다.

## 하네스가 도구를 다루는 방식 차이 (비교할 때 각주)

- Grok은 MCP 도구를 `search_tool`/`use_tool` 메타 도구로 부른다. 호출 수에 메타 호출이 섞이고, 결과는 20,000바이트에서 잘린다.
- agy는 도구 스키마 JSON 파일을 하나씩 읽고, 모델이 셸에서 앱의 HTTP API를 직접 칠 수도 있다(Gemini가 aria `/api/rpc`를 curl로 쳤다). MCP 호출 수가 실제 조작 수보다 적어진다.
- Codex는 exec 모드에서 도구별 승인 테이블이 필요하다(러너가 만든다). 출력 끝에 `tokens used`가 찍힌다.
- Claude `-p`는 끝날 때까지 아무것도 출력하지 않는다. 화면이 비어 있어도 정상이다.
- Grok·Gemini·Claude(xhigh)는 셸에서 Python으로 노트를 생성하는 경우가 있다. 공유 작업 디렉터리에 스크립트가 남는 이유다.
