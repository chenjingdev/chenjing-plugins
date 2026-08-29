# 벤치 프로필 함정과 해결 이력

2026-08-26~27, aria 를 첫 앱으로 등록하면서 실제로 겪은 것들. 러너(`scripts/bench.mjs`)에 이미 반영된 항목은 "러너 처리"로 표시.
새 앱을 등록하다 이상한 현상이 나오면 먼저 여기서 같은 증상을 찾는다.

## 공통

- **격리의 정의**: 제거 대상은 사용자가 얹은 것 — 다른 MCP, 사용자 스킬(`~/.agents/skills` 포함), 플러그인, hooks(Honcho·orca 등 기억·관측 훅), 전역 CLAUDE.md/AGENTS.md, Codex apps. 남기는 것은 벤더가 배포하는 상태 — 각 CLI 내장 스킬(Codex: imagegen·openai-docs·plugin-creator·skill-creator·skill-installer·plugin-management, agy: agy-customizations·antigravity-guide), 시스템 프롬프트, Codex 의 `<recommended_plugins>` 주입. 이것까지 지우려 하면 "순정"이 아니게 된다.
- **기억 훅이 없으므로 벤치 런은 Honcho 에 기록되지 않는다** — 의도된 동작. 대신 각 프로필이 자기 트랜스크립트를 남긴다: Claude `_claude/projects/*/<session>.jsonl`, Codex `<app>/codex-*/sessions/YYYY/MM/DD/rollout-*.jsonl`(도구 호출·시간·토큰 포함), agy `<app>/agy-*/.gemini/antigravity-cli/conversations/`. 프로세스 지표는 여기서 뽑는다.
- **서버 프로세스의 HOME**: HOME 오버라이드 하네스(codex·agy) 아래에서 MCP 서버가 `os.homedir()`/`~` 를 쓰면 가짜 HOME 밑에 데이터·엔진을 새로 만들어 버린다(aria 는 `~/.aria` 에 팩·엔진·라이브러리가 있어 두 번째 GUI 인스턴스가 뜰 상황이었다). 러너 처리 — 서버 env 에 항상 `HOME=<실제 홈>` 을 넣는다. 벤치 전용 데이터 디렉터리를 따로 주고 싶으면 앱 JSON 의 `env` 에 그 앱의 데이터 디렉터리 변수(예: `ARIA_DATA_DIR`)를 넣는다.
- **격리는 설정까지, 파일시스템은 공유** — 벤치 모델도 셸로 `~/.claude/skills`, `~/dev/<app>` 등 실제 홈을 읽을 수 있다. 그래서 *찾을 이유*를 주면 안 된다. aria 2026-08-27: MCP 안내문에 "작곡 지침은 aria-compose 스킬에 있다"는 중립 포인터 한 줄이 남아 있었는데, raw 실행의 Claude가 첫 행동으로 `ls ~/.claude/skills/; find ~/.claude -iname "*aria*"`를 돌려 실제 스킬과 references 전부를 `cat`으로 읽었다(`Skill(aria-compose)` 는 "Unknown skill"로 실패했으나 셸이 우회). raw 결과가 사실상 skill 결과였다. 러너 처리 — `init`이 instructions·도구 설명에서 스킬 이름/"스킬"/"skill"을 찾으면 경고. 해결은 서버 문구 삭제(aria `src/mcp.js` INSTRUCTIONS에서 제거). 이런 누출은 트랜스크립트(`_claude/projects/-…-work/<session>.jsonl`)의 첫 Bash 호출을 보면 바로 보인다.
- **effort 이름이 같아도 뜻이 다르다**: Claude Code `low|medium|high|xhigh|max`, Codex `model_reasoning_effort` `low|medium|high|xhigh`, agy `--effort low|medium|high`. 하네스 간 "high 끼리" 비교는 이름만 같은 것이니 결과에 각주로 남긴다.
- **도구 스키마가 크면 토큰이 많이 든다**: aria 45개 도구는 `get_song` 한 번에 Codex 4만 토큰대. 벤치 비용 추정 시 감안.

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

## Claude Code

- **로그인이 프로필별이다**: 키체인 항목이 `Claude Code-credentials-<CLAUDE_CONFIG_DIR 해시>` 라 새 `CLAUDE_CONFIG_DIR` 은 "Not logged in". 러너는 `_claude/` 를 앱 공유 프로필로 두어 **전체에서 1회** `/login` 만 필요(`bench run <app> claude` 로 열어 `/login`). 대안 `--bare` 는 훅·플러그인·CLAUDE.md 를 생략하지만 API 키가 필수라 구독 사용자에겐 부적합.
- **MCP 격리**: `--strict-mcp-config --mcp-config <파일>` 이 다른 모든 MCP 설정을 무시한다(러너 처리). 사용자 범위 MCP 는 `~/.claude.json` 의 `mcpServers` 에 있다(settings.json 아님) — find-mcp 가 이걸 읽는다.
- **스킬 설치 위치**: Claude 는 프로필이 아니라 **작업 디렉터리의 `.claude/skills/`**(프로젝트 스킬, probe 로 검증됨), Codex 는 `$CODEX_HOME/skills/`, agy 는 `.gemini/config/skills/`. `bench skill <app> on|off` 가 세 곳을 함께 바꾼다. 0.1.x 의 `--skill` 실행 옵션(raw/skill 프로필 이중화)은 "매 실행마다 환경이 바뀌는 숨은 스위치" 라는 이유로 설치 상태로 대체됐다.
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
