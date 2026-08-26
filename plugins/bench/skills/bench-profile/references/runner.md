# 러너(bench.mjs) 레퍼런스 — 에이전트용

`${CLAUDE_PLUGIN_ROOT}/scripts/bench.mjs`. 사용자 설정과 분리된 순정 프로필에서 앱(MCP 서버 묶음)을 실행한다.
사람은 `<app>bench <harness>`만 쓰고, 여기 있는 스키마·배치는 등록·진단을 맡은 에이전트가 안다.

## 명령

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bench.mjs" init <app> [--refresh-tools]   # 프로필 생성·갱신(멱등). 서버를 띄워 tools/list 캐시
node "${CLAUDE_PLUGIN_ROOT}/scripts/bench.mjs" run <app> <claude|codex|agy> [--skill] [--effort E] [--model M] [--dry-run] [-- 프롬프트…]
node "${CLAUDE_PLUGIN_ROOT}/scripts/bench.mjs" status [app]
node "${CLAUDE_PLUGIN_ROOT}/scripts/bench.mjs" apps
```

사용자 셸에는 `bench`(같은 인자)와 앱별 `<app>bench <harness> …`(= `bench run <app> <harness> …`)가 있다.
`<app>bench` 함수는 `~/.zshrc`가 `~/.bench/apps/*.json`을 읽어 **새 셸이 뜰 때** 생성한다 — 등록 직후엔 `source ~/.zshrc`가 필요하다고 알린다.

effort 값은 하네스마다 다르다: claude `low|medium|high|xhigh|max`, codex `low|medium|high|xhigh`, agy `low|medium|high`.
프롬프트를 주면 비대화형 1회(claude `-p`, codex `exec`, agy `-p`), 없으면 대화형.

## 앱 정의 `~/.bench/apps/<app>.json`

```json
{
  "repo": "~/dev/aria",                                   // 선택. status 에 git 커밋 표시
  "mcp": {
    "aria": { "command": "/opt/homebrew/bin/node", "args": ["/Users/chenjing/dev/aria/src/mcp-bridge.js"], "env": {} }
  },
  "skills": ["~/dev/aria/skills/aria-compose"],           // 이 앱이 소유한 스킬 디렉터리(SKILL.md 포함)만. 없으면 []
  "tools": { "aria": ["new_song", "…"] }                  // init 이 tools/list 로 채움 — 손으로 쓰지 않음
}
```

- **stdio 서버만** 지원(`command`/`args`/`env`). `url`형 HTTP 서버는 `loadApp`이 거부한다.
- `cwd` 필드는 없다. cwd에 기대는 서버는 `"command": "/bin/sh", "args": ["-c", "cd /path && exec /path/.venv/bin/python server.py"]`로 감싼다.
- `command`는 절대 경로로 쓴다(`/opt/homebrew/bin/node` 등). codex·agy 프로필은 HOME을 바꿔 실행하므로 PATH 의존 한 단어 명령은 깨질 수 있다.
- 서버 프로세스 env에는 러너가 항상 `HOME=<실제 홈>`을 넣는다(HOME 오버라이드 하네스 아래에서도 `~/.<app>` 데이터·엔진을 그대로 쓰게). 벤치 전용 데이터로 분리하려면 그 앱의 데이터 디렉터리 변수(예 `ARIA_DATA_DIR`, `--data-dir` 인자)를 정의에 넣는다.
- `tools`는 Codex용. Codex는 MCP 도구를 **도구별로** 승인해야 하고(서버 단위 키는 무시됨), 승인이 없으면 호출이 0초 만에 "user cancelled"로 취소된다. 서버에 도구가 늘면 `init <app> --refresh-tools`.
- `~`는 `repo`·`skills`에서만 확장된다. `mcp.*.command/args`는 절대 경로.

## 프로필 배치 (`BENCH_HOME`, 기본 `~/.bench`)

```
apps/<app>.json          앱 정의
_claude/                 CLAUDE_CONFIG_DIR — 앱 공유. 키체인 로그인이 프로필별이라 전체에서 1회만 /login
<app>/claude-mcp.json    Claude 에 --strict-mcp-config --mcp-config 로 주는 앱별 MCP
<app>/codex-raw|skill/   CODEX_HOME 이자 HOME (HOME 도 바꿔야 ~/.agents/skills 가 안 보인다). auth.json 은 실제 것의 심볼릭링크
<app>/agy-raw|skill/     HOME (.gemini 에 인증 파일 4개만 링크, settings.json 은 mcpServers·hooks 뺀 사본)
<app>/work/raw|skill/    빈 작업 디렉터리 / Claude 스킬용 .claude/skills 링크
```

하네스별 격리 수단: Claude `CLAUDE_CONFIG_DIR` + `--strict-mcp-config` + raw엔 `--disable-slash-commands`; Codex `CODEX_HOME`+`HOME` + `features.apps=false` + 도구별 approve; agy `HOME`(설정 위치 환경변수가 없어 이것뿐).
권한은 전부 자동 승인(claude `bypassPermissions`, codex exec 기본 / 대화형 `-a never`, agy `--dangerously-skip-permissions`).

## 순정에 남는 것 (제거 대상 아님)

각 CLI 내장 스킬(Codex: imagegen·openai-docs·plugin-creator·skill-creator·skill-installer·plugin-management, agy: agy-customizations·antigravity-guide), 시스템 프롬프트, Codex의 `<recommended_plugins>` 주입. 벤더가 배포하는 상태라 "순정 스택"에 포함된다. 이것까지 지우려 하면 순정이 아니다.

제거되는 것: 사용자 MCP, 사용자 스킬(`~/.agents/skills` 포함), 플러그인, hooks(Honcho·orca 등 기억·관측 훅 → **벤치 런은 기억에 기록되지 않는다**), 전역 CLAUDE.md/AGENTS.md, Codex apps.

## 런 기록

훅이 없어 외부 기억엔 안 남지만 프로필이 자기 트랜스크립트를 남긴다 — 프로세스 지표(도구 호출 수·오류·시간·토큰)는 여기서 뽑는다:
Claude `_claude/projects/*/<session>.jsonl`, Codex `<app>/codex-*/sessions/YYYY/MM/DD/rollout-*.jsonl`, agy `<app>/agy-*/.gemini/antigravity-cli/conversations/`.

## 환경변수

`BENCH_HOME`(기본 `~/.bench`), `BENCH_APPS_DIR`(기본 `$BENCH_HOME/apps`), `AGY_BIN`(기본 `~/.local/bin/agy`), `BENCH_MJS`(셸 함수가 쓸 러너 경로 강제 — 개발 중 리포 버전을 쓸 때).
