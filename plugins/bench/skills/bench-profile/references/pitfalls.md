# 벤치 프로필 함정과 해결 이력

2026-08-26~27, aria 를 첫 앱으로 등록하면서 실제로 겪은 것들. 러너(`scripts/bench.mjs`)에 이미 반영된 항목은 "러너 처리"로 표시.
새 앱을 등록하다 이상한 현상이 나오면 먼저 여기서 같은 증상을 찾는다.

## 공통

- **격리의 정의**: 제거 대상은 사용자가 얹은 것 — 다른 MCP, 사용자 스킬(`~/.agents/skills` 포함), 플러그인, hooks(Honcho·orca 등 기억·관측 훅), 전역 CLAUDE.md/AGENTS.md, Codex apps. 남기는 것은 벤더가 배포하는 상태 — 각 CLI 내장 스킬(Codex: imagegen·openai-docs·plugin-creator·skill-creator·skill-installer·plugin-management, agy: agy-customizations·antigravity-guide), 시스템 프롬프트, Codex 의 `<recommended_plugins>` 주입. 이것까지 지우려 하면 "순정"이 아니게 된다.
- **기억 훅이 없으므로 벤치 런은 Honcho 에 기록되지 않는다** — 의도된 동작. 대신 각 프로필이 자기 트랜스크립트를 남긴다: Claude `_claude/projects/*/<session>.jsonl`, Codex `<app>/codex-*/sessions/YYYY/MM/DD/rollout-*.jsonl`(도구 호출·시간·토큰 포함), agy `<app>/agy-*/.gemini/antigravity-cli/conversations/`, Grok `<app>/grok/sessions/<URL 인코딩된 cwd>/<session>/updates.jsonl`. 프로세스 지표는 여기서 뽑는다.
- **서버 프로세스의 HOME**: HOME 오버라이드 하네스(codex·agy·grok) 아래에서 MCP 서버가 `os.homedir()`/`~` 를 쓰면 가짜 HOME 밑에 데이터·엔진을 새로 만들어 버린다(aria 는 `~/.aria` 에 팩·엔진·라이브러리가 있어 두 번째 GUI 인스턴스가 뜰 상황이었다). 러너 처리 — 서버 env 에 항상 `HOME=<실제 홈>` 을 넣는다. 벤치 전용 데이터 디렉터리를 따로 주고 싶으면 앱 JSON 의 `env` 에 그 앱의 데이터 디렉터리 변수(예: `ARIA_DATA_DIR`)를 넣는다.
- **격리는 설정까지, 파일시스템은 공유** — 벤치 모델도 셸로 `~/.claude/skills`, `~/dev/<app>` 등 실제 홈을 읽을 수 있다. 그래서 *찾을 이유*를 주면 안 된다. aria 2026-08-27: MCP 안내문에 "작곡 지침은 aria-compose 스킬에 있다"는 중립 포인터 한 줄이 남아 있었는데, raw 실행의 Claude가 첫 행동으로 `ls ~/.claude/skills/; find ~/.claude -iname "*aria*"`를 돌려 실제 스킬과 references 전부를 `cat`으로 읽었다(`Skill(aria-compose)` 는 "Unknown skill"로 실패했으나 셸이 우회). raw 결과가 사실상 skill 결과였다. 러너 처리 — `init`이 instructions·도구 설명에서 스킬 이름/"스킬"/"skill"을 찾으면 경고. 해결은 서버 문구 삭제(aria `src/mcp.js` INSTRUCTIONS에서 제거). 이런 누출은 트랜스크립트(`_claude/projects/-…-work/<session>.jsonl`)의 첫 Bash 호출을 보면 바로 보인다.
- **effort 이름이 같아도 뜻이 다르다**: Claude Code `low|medium|high|xhigh|max`, Codex `model_reasoning_effort` `low|medium|high|xhigh`, agy `--effort low|medium|high`, Grok `--effort none|minimal|low|medium|high|xhigh|max`(모델별 메뉴에 있는 단계만). 하네스 간 "high 끼리" 비교는 이름만 같은 것이니 결과에 각주로 남긴다.
- **도구 스키마가 크면 토큰이 많이 든다**: aria 45개 도구는 `get_song` 한 번에 Codex 4만 토큰대. 벤치 비용 추정 시 감안.
- **동시 실행은 앱 인스턴스를 공유한다**(2026-09-05): 네 프로필의 서버 env 가 같으면 브리지가 같은 데이터 디렉터리의 runtime.json 을 읽어 한 인스턴스에 붙고, 두 모델이 곡 하나를 함께 편집한다(동시에 시작해도 시작 잠금으로 인스턴스는 하나). 러너 처리 — env 값의 `{harness}` 자리표시자를 프로필별 하네스 이름으로 치환. aria 는 `ARIA_DATA_DIR=…/data-{harness}` 로 하네스별 인스턴스가 뜨고 포트는 7799 부터 빈 곳으로 이동한다. 같은 하네스 둘을 동시에 돌리려면 앱 쪽 세션 분리가 필요하다(아래 '아직 안 되는 것').

## Codex

- **MCP 도구 호출이 0초 만에 "user cancelled MCP tool call"**: `approval_policy=never`(exec 기본, 대화형 `-a never`)에서 MCP 도구는 승인 대상이라 즉시 취소된다. 서버 단위 `approval_mode` 키는 **무시된다**. 해결은 도구별 `[mcp_servers.<서버>.tools.<도구>] approval_mode = "approve"`. 러너 처리 — `bench init` 이 서버를 띄워 `tools/list` 로 이름을 받아 전부 선언한다. 서버에 도구가 추가되면 `bench init <app> --refresh-tools`.
- **사용자 스킬이 딸려온다**: Codex 는 `$CODEX_HOME/skills` 외에 실제 HOME 의 `~/.agents/skills` 도 읽는다. `CODEX_HOME` 만 바꾸면 aria-compose·html 등 사용자 스킬 12개가 그대로 보였다. 러너 처리 — `HOME` 도 프로필 디렉터리로 바꾼다.
- **`codex_apps` MCP 가 붙는다**: `features.apps`(stable, 기본 true). 러너 처리 — config.toml 에 `[features] apps = false`.
- **`codex exec` 가 멈춘다**: stdin 이 TTY 가 아니면 "Reading additional input from stdin..." 하고 입력을 기다린다. 러너 처리 — 프롬프트 모드에서 stdin 을 닫는다. 손으로 돌릴 땐 `< /dev/null`.
- 비 git 디렉터리에서는 `--skip-git-repo-check` 필요(러너 처리).
- 인증은 `$CODEX_HOME/auth.json` 하나 — 실제 것을 심볼릭링크하면 재로그인 없음(러너 처리).

## agy (Antigravity CLI, Gemini)

- **설정 위치를 바꾸는 환경변수가 없다**: 전역 MCP 는 `~/.gemini/config/mcp_config.json`, 스킬은 `~/.gemini/config/skills`, hooks 는 `~/.gemini/settings.json`. 유일한 격리 수단이 `HOME` 오버라이드(러너 처리). 셸 함수 `agy` 가 `$HOME/.local/bin/agy` 를 가리키므로 HOME 을 바꾼 뒤엔 **절대 경로**로 실행해야 한다(러너는 `AGY_BIN`, 기본 `~/.local/bin/agy`).
- **`antigravity-cli/` 디렉터리 전체를 링크하면 플러그인이 딸려온다**: 그 안의 `mcp/` 캐시에서 nanobanana 같은 플러그인을 `config/plugins/` 로 되살린다. 인증에 필요한 건 `oauth_creds.json`, `google_accounts.json`, `installation_id`, `antigravity-cli/antigravity-oauth-token` 네 파일뿐(러너 처리).
- `settings.json` 은 `mcpServers`·`hooks` 만 뺀 사본을 둔다 — 모델·보안 설정은 유지(러너 처리).
- 스키마 JSON 을 도구별로 전부 읽는 경향(`~/.gemini/antigravity-cli/mcp/<서버>/*.json`)이 있어 준비 시간이 길다. 이건 하네스 특성이지 오류가 아니다 — 벤치에선 그대로 측정 대상.
- **print 모드는 5분에 끊긴다**: `agy -p` 의 `--print-timeout` 기본값이 5m0s 라 그 안에 답이 안 나오면 `Error: timeout waiting for response` 로 종료되고 앱에는 미완성 곡만 남는다(aria 2026-09-05: 두 런이 8마디 시험곡 단계에서 끊김). 러너 처리 — 프롬프트 모드에 `--print-timeout 2h`.

## grok (Grok Build CLI, xAI) — 2026-09-05 추가

- **`GROK_HOME` 만 바꾸면 격리가 안 된다**: Claude·Cursor 호환 스캔이 기본 on 이라 빈 GROK_HOME 에서도 `grok inspect` 에 실제 `~/.claude/Claude.md` 지침, `~/.claude/settings.json` 훅 9개(Honcho 포함), 사용자 스킬 8개(aria-compose 포함), 플러그인 5개, `~/.claude.json` 의 MCP 3개가 `[claude]` 꼬리표로 그대로 붙었다. 러너 처리 — 프로필 `config.toml` 에 `[compat.claude]`·`[compat.cursor]` 의 `skills·rules·agents·mcps·hooks·sessions` 전부 false, 그리고 `HOME` 도 프로필로(`~/.agents/skills` 같은 홈 기준 스캔 차단). 확인은 `GROK_HOME=<프로필> HOME=<프로필> grok inspect` — LLM 호출 없이 출처별 목록이 나온다(정상: Skills 0, Plugins 0, Hooks 0, MCP 는 앱 것만 `config` 출처).
- 인증은 `$GROK_HOME/auth.json` 하나 — 실제 것을 링크하면 재로그인 없음(러너 처리). 로그인 상태·모델 목록은 `grok models`(2026-09 기준 grok-4.6 기본, grok-4.5).
- **자동 업데이트**: 러너가 `GROK_DISABLE_AUTOUPDATER=1` 을 넣는다. 관리 설치(`~/.grok/bin`)가 아닌 GROK_HOME 에서 업데이터가 돌거나 버전이 런 중간에 바뀌지 않게.
- **MCP 접근이 다른 하네스와 다르다**: 모델에 주어지는 도구는 `search_tool`/`use_tool` 둘뿐이고(스모크 세션 `chat_history.jsonl` 로 확인), MCP 도구는 `search_tool({query})` 로 찾은 뒤 `use_tool({tool_name: "aria__get_song", tool_input})` 로 부른다. aria 스모크에서 get_song 한 번에 search_tool 3회·use_tool 1회가 들었다. 스키마 전체가 시스템 프롬프트에 들어가는 Claude·Codex 와 토큰 구조가 다르다 — 하네스 특성이지 오류가 아니고, 벤치에선 그대로 측정 대상. 같은 스모크에서 모델이 작업 디렉터리의 `.agents/skills` 를 `list_dir` 로 뒤졌다(위 "파일시스템은 공유" 항목 — 빈 디렉터리라 문제는 없었다).
- **MCP 결과 20,000바이트 상한**(`GROK_MAX_MCP_OUTPUT_BYTES`, 기본값): 큰 결과는 잘리고 전체는 세션 `mcp/` 폴더에 저장된다. aria `get_song` 처럼 곡 전체 JSON 을 돌려주는 도구는 3분짜리 곡에서 잘릴 수 있다. 순정 값을 그대로 두고 결과 각주로 남긴다.
- 권한은 `--permission-mode bypassPermissions` 하나로 MCP 도구까지 자동 승인 — Codex 식 도구별 approve 테이블이 필요 없다(러너 처리).
- cross-session memory 는 기본 off(실험 기능). 프로필에서 건드리지 않는다 — 켜져 있으면 런 사이에 기억이 이어져 N-of-1 벤치가 오염되니, `GROK_MEMORY` 나 `[memory] enabled` 가 환경·프로필에 없는지만 확인.
- 세션은 `$GROK_HOME/sessions/<URL 인코딩된 cwd>/<session-id>/` — `updates.jsonl`(도구 호출 포함 대화), `chat_history.jsonl`(모델에 보낸 원문), `signals.json`(토큰·도구·턴 수).

## Claude Code

- **로그인이 프로필별이다**: 키체인 항목이 `Claude Code-credentials-<CLAUDE_CONFIG_DIR 해시>` 라 새 `CLAUDE_CONFIG_DIR` 은 "Not logged in". 러너는 `_claude/` 를 앱 공유 프로필로 두어 **전체에서 1회** `/login` 만 필요(`bench run <app> claude` 로 열어 `/login`). 대안 `--bare` 는 훅·플러그인·CLAUDE.md 를 생략하지만 API 키가 필수라 구독 사용자에겐 부적합.
- **MCP 격리**: `--strict-mcp-config --mcp-config <파일>` 이 다른 모든 MCP 설정을 무시한다(러너 처리). 사용자 범위 MCP 는 `~/.claude.json` 의 `mcpServers` 에 있다(settings.json 아님) — find-mcp 가 이걸 읽는다.
- **스킬 설치 위치**: Claude 는 프로필이 아니라 **작업 디렉터리의 `.claude/skills/`**(프로젝트 스킬, probe 로 검증됨), Codex 는 `$CODEX_HOME/skills/`, agy 는 `.gemini/config/skills/`, Grok 은 `$GROK_HOME/skills/`. `bench skill <app> on|off` 가 네 곳을 함께 바꾼다. 0.1.x 의 `--skill` 실행 옵션(raw/skill 프로필 이중화)은 "매 실행마다 환경이 바뀌는 숨은 스위치" 라는 이유로 설치 상태로 대체됐다.
- **`--disable-slash-commands` 를 raw 에 붙이지 않는다**: 스킬만 아니라 `/mcp`·`/model` 같은 내장 명령까지 사라져 대화형에서 쓸 수 없다. 확인 결과 새 `CLAUDE_CONFIG_DIR` 프로필에는 `~/.agents/skills` 가 새어 들어오지 않아 플래그 없이도 사용자 스킬은 보이지 않는다(내장 스킬만 남음).
- **HOME 오버라이드는 Claude 에 쓸 수 없다**: 키체인 항목 조회가 HOME 에 묶여 있어 `HOME` 을 바꾸면 "Not logged in" 이 된다. Claude 격리는 `CLAUDE_CONFIG_DIR` + `--strict-mcp-config` 로만.
- `-p` 모드는 stdin 을 3초 기다린 뒤 진행한다(러너는 stdin 을 닫아 대기 없음).
- **`tmpclaude` 같은 "폴더만 바꾸는" 래퍼는 격리가 아니다**: 실제 프로필의 훅·MCP·스킬·CLAUDE.md 가 그대로 붙고 Honcho 에도 기록된다.

## honcho (local-mcp-bridge) — 2026-08-27 등록

- **Claude·Codex 정의가 `url` 형(HTTP 8766)이라 그대로는 미지원**: 같은 `server.py` 가 `HONCHO_MCP_TRANSPORT=stdio` 로도 뜨고 agy 프로필이 그 stdio 정의를 갖고 있어 그걸 옮겼다(find-mcp 가 세 프로필을 다 보여 주는 이유). 정의에 `cwd` 가 있으니 `/bin/sh -c "cd … && exec …/.venv/bin/python server.py"` 로 감쌌다. stdio 모드는 bearer 인증을 건너뛰므로 토큰이 프로필에 들어가지 않는다.
- **세 프로필의 assistant 이름이 다르다**(`assistant_claude`/`assistant_codex`/`assistant_agy`, HTTP 는 헤더로 넘김). 러너 env 는 하네스 공통이라 하나만 고른다. **없는 이름을 쓰면 안 된다** — `get_peer_context`·`get_representation`·`chat`·`get_peer_card` 가 그 이름을 기본 observer 로 써서 Honcho 가 `Peer … not found` 404 를 내고, 브리지는 peer 를 자동 생성하지 않으며 `create_peer` 도 tool-config 로 꺼져 있다. 기존 peer 중 하나를 쓴다(등록 시 `assistant_agy`).
- 도구 15개는 tool-config.json 의 `disabled_tools` 가 걸러낸 뒤의 읽기 도구만이다(쓰기 도구 16개 제외). 실제 Codex 프로필은 그중 7개만 approve 해 뒀지만 벤치는 `init` 이 받아온 15개를 전부 approve 한다 — 벤치는 "무엇이 가능한가"를 재므로 의도.
- 외부 의존: Honcho API `127.0.0.1:8001` 이 떠 있어야 도구가 값을 돌려준다(`tools/list` 는 API 없이도 된다). 훅이 없고 쓰기 도구가 꺼져 있어 벤치 런이 memory 워크스페이스에 남기는 것은 없다.

## 아직 안 되는 것

- `url` 형 HTTP MCP 서버. 러너가 stdio 만 만든다. honcho 는 같은 서버의 stdio 모드로 우회했다(위 항목). 필요해지면 Claude `type:"http"`, Codex `url =`, agy 는 키 이름 확인 후 추가.
- 런마다 앱 상태를 초기화하는 훅(예: aria 빈 곡으로 리셋). 지금은 앱의 현재 상태가 그대로 보인다.
- pi 같은 추가 하네스. 러너의 `run()` 에 분기 하나 추가하면 된다.
- 같은 하네스의 병렬 실행(예 codex low 와 high 동시)은 러너 차원에서는 못 가른다 — 프로필 파일이 하네스당 하나라서. 앱이 브리지 세션별 데이터 디렉터리를 지원하면 env 한 줄로 해결된다(aria: `ARIA_DATA_DIR_PER_SESSION=1` → `<ARIA_DATA_DIR>/sessions/<시각>-<pid>` 마다 인스턴스. 런이 끝나도 인스턴스는 남으니 `sessions/*/runtime.json` 의 pid 로 거둔다).
