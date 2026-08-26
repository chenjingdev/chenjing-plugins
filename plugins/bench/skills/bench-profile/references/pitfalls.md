# 벤치 프로필 함정과 해결 이력

2026-08-26~27, aria 를 첫 앱으로 등록하면서 실제로 겪은 것들. 러너(`scripts/bench.mjs`)에 이미 반영된 항목은 "러너 처리"로 표시.
새 앱을 등록하다 이상한 현상이 나오면 먼저 여기서 같은 증상을 찾는다.

## 공통

- **격리의 정의**: 제거 대상은 사용자가 얹은 것 — 다른 MCP, 사용자 스킬(`~/.agents/skills` 포함), 플러그인, hooks(Honcho·orca 등 기억·관측 훅), 전역 CLAUDE.md/AGENTS.md, Codex apps. 남기는 것은 벤더가 배포하는 상태 — 각 CLI 내장 스킬(Codex: imagegen·openai-docs·plugin-creator·skill-creator·skill-installer·plugin-management, agy: agy-customizations·antigravity-guide), 시스템 프롬프트, Codex 의 `<recommended_plugins>` 주입. 이것까지 지우려 하면 "순정"이 아니게 된다.
- **기억 훅이 없으므로 벤치 런은 Honcho 에 기록되지 않는다** — 의도된 동작. 대신 각 프로필이 자기 트랜스크립트를 남긴다: Claude `_claude/projects/*/<session>.jsonl`, Codex `<app>/codex-*/sessions/YYYY/MM/DD/rollout-*.jsonl`(도구 호출·시간·토큰 포함), agy `<app>/agy-*/.gemini/antigravity-cli/conversations/`. 프로세스 지표는 여기서 뽑는다.
- **서버 프로세스의 HOME**: HOME 오버라이드 하네스(codex·agy) 아래에서 MCP 서버가 `os.homedir()`/`~` 를 쓰면 가짜 HOME 밑에 데이터·엔진을 새로 만들어 버린다(aria 는 `~/.aria` 에 팩·엔진·라이브러리가 있어 두 번째 GUI 인스턴스가 뜰 상황이었다). 러너 처리 — 서버 env 에 항상 `HOME=<실제 홈>` 을 넣는다. 벤치 전용 데이터 디렉터리를 따로 주고 싶으면 앱 JSON 의 `env` 에 그 앱의 데이터 디렉터리 변수(예: `ARIA_DATA_DIR`)를 넣는다.
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
- **스킬 ON/OFF**: 프로필이 아니라 **작업 디렉터리의 `.claude/skills/`** 로 나눈다(프로젝트 스킬 인식은 probe 스킬로 검증됨). 그래야 로그인 하나로 두 상태를 쓸 수 있다. raw 에는 `--disable-slash-commands` 도 함께 준다(러너 처리).
- `-p` 모드는 stdin 을 3초 기다린 뒤 진행한다(러너는 stdin 을 닫아 대기 없음).
- **`tmpclaude` 같은 "폴더만 바꾸는" 래퍼는 격리가 아니다**: 실제 프로필의 훅·MCP·스킬·CLAUDE.md 가 그대로 붙고 Honcho 에도 기록된다.

## honcho (local-mcp-bridge) — 2026-08-27 등록

- **Claude·Codex 정의가 `url` 형(HTTP 8766)이라 그대로는 미지원**: 같은 `server.py` 가 `HONCHO_MCP_TRANSPORT=stdio` 로도 뜨고 agy 프로필이 그 stdio 정의를 갖고 있어 그걸 옮겼다(find-mcp 가 세 프로필을 다 보여 주는 이유). 정의에 `cwd` 가 있으니 `/bin/sh -c "cd … && exec …/.venv/bin/python server.py"` 로 감쌌다. stdio 모드는 bearer 인증을 건너뛰므로 토큰이 프로필에 들어가지 않는다.
- **세 프로필의 assistant 이름이 다르다**(`assistant_claude`/`assistant_codex`/`assistant_agy`, HTTP 는 헤더로 넘김). 러너 env 는 하네스 공통이라 하나만 고른다. **없는 이름을 쓰면 안 된다** — `get_peer_context`·`get_representation`·`chat`·`get_peer_card` 가 그 이름을 기본 observer 로 써서 Honcho 가 `Peer … not found` 404 를 내고, 브리지는 peer 를 자동 생성하지 않으며 `create_peer` 도 tool-config 로 꺼져 있다. 기존 peer 중 하나를 쓴다(등록 시 `assistant_agy`).
- 도구 15개는 tool-config.json 의 `disabled_tools` 가 걸러낸 뒤의 읽기 도구만이다(쓰기 도구 16개 제외). 실제 Codex 프로필은 그중 7개만 approve 해 뒀지만 벤치는 `init` 이 받아온 15개를 전부 approve 한다 — 벤치는 "무엇이 가능한가"를 재므로 의도.
- 외부 의존: Honcho API `127.0.0.1:8001` 이 떠 있어야 도구가 값을 돌려준다(`tools/list` 는 API 없이도 된다). 훅이 없고 쓰기 도구가 꺼져 있어 벤치 런이 memory 워크스페이스에 남기는 것은 없다.

## neuromem — 2026-08-27 등록

- **Claude 정의는 죽은 정의였다**: `~/.claude.json` 의 `neuromem` 은 Rust 바이너리 `target/debug/neuromem … serve --mcp stdio` 인데 리포는 이미 Python(`uv run neuromem … mcp`)으로 바뀌어 바이너리·Cargo.toml 이 없다. find-mcp 가 보여 주는 정의라도 command 경로가 실제로 있는지 `ls` 로 먼저 확인한다. Codex 의 `neuromem_personal` 정의를 기준으로 삼았다.
- **데이터 디렉터리 이름 충돌**: 벤치 전용으로 `~/.neuromem-bench` 를 골랐는데 그 이름은 사용자의 neuromem 자체 벤치마크 작업 공간(1GB 이상, 7월~8월 산출물)이었다. 서버가 그 안에 `neuromem.sqlite3`·`blobs/`·`runtime/` 을 새로 만들어 버렸다(birth time 으로 확인해 그 세 개 + `-shm/-wal` 만 지웠다). 새 데이터 디렉터리를 정할 때는 `ls -d ~/.<app>*` 로 이미 있는 이름을 먼저 본다. 최종 이름은 `~/.neuromem-benchprofile`.
- **빈 데이터 디렉터리로는 MCP 가 뜨지 않는다**: `RuntimeError: MCP requires exactly one classified Project; found none`. `bench init` 에서는 "MCP 서버가 응답 전에 종료됐습니다" 로만 보이니 서버를 손으로 띄워 stderr 를 봐야 한다. 세팅용 CLI 명령이 없고 `POST /v1/setup/memory-scope` 또는 `Neuromem(Settings.from_env(dir)).setup_memory_scope(...)` 만 있다. 스키마가 `default` 네임스페이스 워크스페이스를 미리 만들어 두므로 `namespace="default"` 는 `memory scope target already exists` 로 실패한다 — 다른 네임스페이스(`bench`)를 쓴다. 한 번 만들면 재사용된다.
- **개인 메모리 스토어를 벤치 대상으로 쓰지 않았다**: Codex 정의의 `--data-dir ~/.neuromem-personal-month-20260814`(730MB, 매일 쓰는 개인 기억)를 그대로 쓰면 벤치 ingest 가 사용자 기억을 오염시키고 사용자의 실제 Codex 세션과 SQLite 잠금을 다툰다 — Honcho 훅을 떼는 것과 같은 이유로 분리. 개인 데이터로 recall 을 재고 싶으면 앱 JSON 의 `--data-dir` 만 바꾸고 `bench init neuromem` 을 다시 돌린다.
- 외부 의존: Ollama `127.0.0.1:11434`(임베딩 `qwen3-embedding-honcho-8192:latest`; `NEUROMEM_LLM_BASE_URL` 미지정 시 기본값이 11434)과 `NEUROMEM_LLM_PROVIDER=codex` 가 부르는 `codex` 바이너리. neuromem 이 내부적으로 띄우는 codex 는 실제 HOME 을 보므로 사용자 `~/.codex/config.toml` 을 읽는다(앱 내부 동작이라 벤치 격리 대상이 아님). `NEUROMEM_WORKER_MODE=off` 이므로 백그라운드 워커는 돌지 않는다.
- 앱 소유 스킬이 없다(`~/.agents|.claude|.codex|.gemini` 스킬 디렉터리·리포 모두). `skills: []` — `--skill` 은 raw 와 같다.

## 아직 안 되는 것

- `url` 형 HTTP MCP 서버. 러너가 stdio 만 만든다. honcho 는 같은 서버의 stdio 모드로 우회했다(위 항목). 필요해지면 Claude `type:"http"`, Codex `url =`, agy 는 키 이름 확인 후 추가.
- 런마다 앱 상태를 초기화하는 훅(예: aria 빈 곡으로 리셋). 지금은 앱의 현재 상태가 그대로 보인다.
- pi 같은 추가 하네스. 러너의 `run()` 에 분기 하나 추가하면 된다.
