# 러너(bench.mjs) 레퍼런스 — 에이전트용

플러그인 루트의 `scripts/bench.mjs`. 사용자 설정과 분리된 순정 프로필에서 앱(MCP 서버 묶음)을 실행한다.
사람은 `<app>bench <harness>`만 쓰고, 여기 있는 스키마·배치는 등록·진단을 맡은 에이전트가 안다.

`BENCH_PLUGIN_ROOT`는 절대 경로로 정한다. Claude Code에서 `CLAUDE_PLUGIN_ROOT`가 있으면 그 값을 쓰고, 그렇지 않으면 현재 로드된
`SKILL.md`의 실제 디렉터리에서 두 단계 위(`skills/bench-profile/../..`)를 `pwd -P`로 해석한다. 현재 작업 디렉터리나 특정 사용자의
저장소 위치를 가정하지 않는다.

## 명령

```bash
node "$BENCH_PLUGIN_ROOT/scripts/bench.mjs" init <app> [--refresh-tools]   # 프로필 생성·갱신(멱등). 서버를 띄워 tools/list 캐시. 안내문·도구 설명이 스킬을 언급하면 경고(pitfalls "파일시스템은 공유")
node "$BENCH_PLUGIN_ROOT/scripts/bench.mjs" run <app> <claude|codex|agy|grok> [--effort E] [--model M] [--dry-run] [-- 프롬프트…]
node "$BENCH_PLUGIN_ROOT/scripts/bench.mjs" skill <app> on|off       # 앱 스킬을 네 하네스 프로필에 설치/제거. 기본 미설치(raw)
node "$BENCH_PLUGIN_ROOT/scripts/bench.mjs" status [app]             # 스킬 설치 상태도 여기 보인다
node "$BENCH_PLUGIN_ROOT/scripts/bench.mjs" apps
```

사용자 셸에는 `bench`(같은 인자)와 앱별 `<app>bench <harness> …`(= `bench run <app> <harness> …`)가 있다. `<app>bench skill on|off`도 된다.

**스킬은 실행 옵션이 아니라 프로필의 설치 상태다.** 매 실행에 숨은 환경 차이를 만들지 않고, 켜고 끄는 행위가 명시적으로 남게 하려는 설계다.
`init` 직후는 미설치(= raw 트랙). 사용자가 원할 때 `skill on`으로 설치하면 이후 모든 실행이 스킬을 본다. 상태는 링크 존재로 정의되며 `status`에 표시된다.
`<app>bench` 함수는 `~/.zshrc`가 `~/.bench/apps/*.json`을 읽어 **새 셸이 뜰 때** 생성한다 — 등록 직후엔 `source ~/.zshrc`가 필요하다고 알린다.

effort 값은 하네스마다 다르다: claude `low|medium|high|xhigh|max`, codex `low|medium|high|xhigh`, agy `low|medium|high`, grok `none|minimal|low|medium|high|xhigh|max`(모델이 광고하는 단계만 받는다).
프롬프트를 주면 비대화형 1회(claude `-p`, codex `exec`, agy `-p`, grok `-p`), 없으면 대화형.

## 앱 정의 `~/.bench/apps/<app>.json`

```json
{
  "repo": "~/dev/aria",                                   // 선택. status 에 git 커밋 표시
  "mcp": {
    "aria": { "command": "/opt/homebrew/bin/node", "args": ["/Users/chenjing/dev/aria/src/mcp-bridge.js"], "env": {} }
  },
  "skills": ["~/dev/aria/skills/aria-compose"],           // 이 앱이 소유한 스킬 디렉터리(SKILL.md 포함)만. 없으면 []. 설치는 `skill on`으로 별도
  "tools": { "aria": ["new_song", "…"] }                  // init 이 tools/list 로 채움 — 손으로 쓰지 않음
}
```

- **stdio 서버만** 지원(`command`/`args`/`env`). `url`형 HTTP 서버는 `loadApp`이 거부한다.
- `cwd` 필드는 없다. cwd에 기대는 서버는 `"command": "/bin/sh", "args": ["-c", "cd /path && exec /path/.venv/bin/python server.py"]`로 감싼다.
- `command`는 절대 경로로 쓴다(`/opt/homebrew/bin/node` 등). codex·agy·grok 프로필은 HOME을 바꿔 실행하므로 PATH 의존 한 단어 명령은 깨질 수 있다.
- 서버 프로세스 env에는 러너가 항상 `HOME=<실제 홈>`을 넣는다(HOME 오버라이드 하네스 아래에서도 `~/.<app>` 데이터·엔진을 그대로 쓰게). 벤치 전용 데이터로 분리하려면 그 앱의 데이터 디렉터리 변수(예 `ARIA_DATA_DIR`, `--data-dir` 인자)를 정의에 넣는다.
- env 값의 `{harness}`는 프로필을 만들 때 그 하네스 이름(`claude`·`codex`·`agy`·`grok`)으로 바뀐다. `ARIA_DATA_DIR=…/data-{harness}`처럼 쓰면 하네스마다 데이터 디렉터리와 앱 인스턴스가 갈라져 **서로 다른 하네스를 동시에** 돌릴 수 있다(포트는 선호 포트에서 빈 곳으로 자동 이동, 각자 runtime.json에 기록). 같은 하네스 두 개를 동시에 돌리는 것까지 가르려면 앱이 브리지 세션별 데이터 디렉터리를 지원해야 한다(aria `ARIA_DATA_DIR_PER_SESSION=1`). `init`의 tools/list 프로브에서는 `init`으로 바뀐다.
- `tools`는 Codex용. Codex는 MCP 도구를 **도구별로** 승인해야 하고(서버 단위 키는 무시됨), 승인이 없으면 호출이 0초 만에 "user cancelled"로 취소된다. 서버에 도구가 늘면 `init <app> --refresh-tools`.
- `~`는 `repo`·`skills`에서만 확장된다. `mcp.*.command/args`는 절대 경로.

## 프로필 배치 (`BENCH_HOME`, 기본 `~/.bench`)

```
apps/<app>.json          앱 정의
_claude/                 CLAUDE_CONFIG_DIR — 앱 공유. 키체인 로그인이 프로필별이라 전체에서 1회만 /login
<app>/claude-mcp.json    Claude 에 --strict-mcp-config --mcp-config 로 주는 앱별 MCP
<app>/codex/             CODEX_HOME 이자 HOME (HOME 도 바꿔야 ~/.agents/skills 가 안 보인다). auth.json 은 실제 것의 심볼릭링크. 스킬 설치 시 skills/<스킬> 링크
<app>/agy/               HOME (.gemini 에 인증 파일 4개만 링크, settings.json 은 mcpServers·hooks 뺀 사본). 스킬 설치 시 .gemini/config/skills/<스킬> 링크
<app>/grok/              GROK_HOME 이자 HOME. auth.json 은 실제 것의 링크, config.toml 은 [compat.claude]·[compat.cursor] 전부 false + 앱 MCP. 스킬 설치 시 skills/<스킬> 링크. 세션은 sessions/ 아래
<app>/work/              빈 작업 디렉터리. Claude 스킬 설치 시 .claude/skills/<스킬> 링크(프로젝트 스킬로 인식)
```

하네스별 격리 수단: Claude `CLAUDE_CONFIG_DIR` + `--strict-mcp-config`(사용자 스킬은 이 프로필에 없어 보이지 않음); Codex `CODEX_HOME`+`HOME` + `features.apps=false` + 도구별 approve; agy `HOME`(설정 위치 환경변수가 없어 이것뿐); Grok `GROK_HOME`+`HOME` + config `[compat.claude]`·`[compat.cursor]` 전부 false(호환 스캔이 실제 `~/.claude.json` MCP·`~/.claude/skills`·settings.json 훅·Claude.md 를 끌어오므로) + `GROK_DISABLE_AUTOUPDATER=1`.
권한은 전부 자동 승인(claude `bypassPermissions`, codex exec 기본 / 대화형 `-a never`, agy `--dangerously-skip-permissions`(+ 프롬프트 모드 `--print-timeout 2h`), grok `--permission-mode bypassPermissions` — MCP 도구까지 포함, 도구별 승인 테이블 불필요).

## 순정에 남는 것 (제거 대상 아님)

각 CLI 내장 스킬(Claude Code: dataviz·code-review·simplify·loop·schedule·claude-api·run·init·security-review 등, Codex: imagegen·openai-docs·plugin-creator·skill-creator·skill-installer·plugin-management, agy: agy-customizations·antigravity-guide, Grok: 빈 프로필에서 스킬 0개), 시스템 프롬프트, Codex의 `<recommended_plugins>` 주입, Grok의 MCP 접근 방식(`search_tool`/`use_tool` 메타 도구, 도구 이름은 `<서버>__<도구>`)과 MCP 결과 20,000바이트 상한(`GROK_MAX_MCP_OUTPUT_BYTES`, 넘치면 잘라서 세션 `mcp/` 폴더에 저장). 벤더가 배포하는 상태라 "순정 스택"에 포함된다. 이것까지 지우려 하면 순정이 아니다.

제거되는 것: 사용자 MCP, 사용자 스킬(`~/.agents/skills` 포함), 플러그인, hooks(Honcho·orca 등 기억·관측 훅 → **벤치 런은 기억에 기록되지 않는다**), 전역 CLAUDE.md/AGENTS.md, Codex apps.

## 런 기록

훅이 없어 외부 기억엔 안 남지만 프로필이 자기 트랜스크립트를 남긴다 — 프로세스 지표(도구 호출 수·오류·시간·토큰)는 여기서 뽑는다:
Claude `_claude/projects/*/<session>.jsonl`, Codex `<app>/codex-*/sessions/YYYY/MM/DD/rollout-*.jsonl`, agy `<app>/agy-*/.gemini/antigravity-cli/conversations/`, Grok `<app>/grok/sessions/<URL 인코딩된 cwd>/<session>/updates.jsonl`(도구 호출 포함)·`chat_history.jsonl`·`signals.json`(토큰·도구·턴 수).

## 환경변수

`BENCH_HOME`(기본 `~/.bench`), `BENCH_APPS_DIR`(기본 `$BENCH_HOME/apps`), `AGY_BIN`(기본 `~/.local/bin/agy`), `GROK_BIN`(기본 `~/.grok/bin/grok`), `BENCH_MJS`(셸 함수가 쓸 러너 경로 강제 — 개발 중 리포 버전을 쓸 때).
