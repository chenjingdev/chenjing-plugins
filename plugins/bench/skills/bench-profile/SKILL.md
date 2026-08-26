---
name: bench-profile
description: Register an app (its MCP servers and the skills that belong to it) as a bench app so it runs inside clean "stock" harness profiles via `<app>bench claude|codex|agy`, then verify the isolation actually holds. Use this whenever the user asks to make, create, register, or add a bench / bench profile / 벤치 for an app or MCP server ("○○ 벤치 만들어줘", "벤치에 추가해줘", "순정 프로필로 돌려보고 싶어", "깨끗한 하네스에서 테스트"), wants to compare Claude Code, Codex, and agy on their own app without personal MCPs/skills/hooks interfering, or reports a bench profile problem (MCP tool call cancelled, a skill visible when it should not be, plugins leaking in, login prompt, Honcho recording bench runs). Also use it when the user asks which of their MCP servers are registered where, or how bench runs relate to memory hooks.
---

# bench-profile — 앱을 순정 하네스 벤치에 등록하기

## 이게 무엇인가

`${CLAUDE_PLUGIN_ROOT}/scripts/bench.mjs`는 사용자 설정(다른 MCP·사용자 스킬·플러그인·훅·CLAUDE.md/AGENTS.md)이 하나도 없는
**깨끗한 프로필**에서 Claude Code / Codex / agy를 실행하는 러너다. 프로필에는 벤치 대상 앱의 MCP 서버만 들어가고,
그 앱의 스킬은 `--skill`일 때만 보인다. 훅이 없으니 벤치 런은 Honcho 같은 기억 시스템에 기록되지 않는다 — 벤치 잡음이
사용자 기억을 오염시키지 않게 하려는 의도다.

사용자는 실행만 외운다: `ariabench codex --effort low -- "…"`. `<app>bench` 함수는 `~/.zshrc`가 `~/.bench/apps/*.json`을 읽어
자동으로 만든다. **등록**은 판단이 들어가는 일(어느 MCP가 이 앱 것인가, 어떤 스킬을 붙이나, 서버가 HOME·cwd·외부 서비스에 기대나)이라
사람이 옵션을 외우는 CLI 대신 이 스킬이 맡는다. 러너에는 `add` 명령이 없다 — 앱 JSON은 네가 직접 쓴다.

러너 명령·앱 JSON 스키마·프로필 배치·"순정"의 정의는 `references/runner.md`에 있다. **등록 전에 읽어라** — 사용자에게 보이는
README는 다섯 줄짜리 사용법뿐이고, 스키마는 여기에만 있다.

아래에서 `bench …`는 `node "${CLAUDE_PLUGIN_ROOT}/scripts/bench.mjs" …`를 뜻한다(사용자 셸에는 같은 이름의 함수가 있지만 네 셸엔 없을 수 있다).

## 절차

### 1. 앱 이름과 MCP 정의 찾기

앱 이름은 짧은 소문자 식별자로 정한다(`neuromem` → `neuromembench`). 사용자가 부른 이름을 따르되 셸 함수 이름이 되므로
공백은 피한다(하이픈은 zsh 함수 이름에 허용된다).

정의는 손으로 옮겨 쓰지 말고 실제 프로필에서 가져온다:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/find-mcp.mjs" <이름 일부>     # 인자 없으면 전부
```

`~/.claude.json`(mcpServers) · `~/.codex/config.toml`([mcp_servers.*]) · `~/.gemini/config/mcp_config.json` 세 곳을 뒤져
`source, name, type, command, args, env, cwd, url`로 정규화해 준다. 개발 중인 앱은 거의 항상 이 중 한 곳엔 등록돼 있다.

결과를 읽을 때:
- **세 프로필의 정의가 다르면** 그대로 하나를 고르지 말고 차이를 사용자에게 보여 준다. 이름이 다르거나(`neuromem` vs
  `neuromem_personal`), 데이터 디렉터리·모델·실행 방식이 다른 경우가 흔하다. 벤치는 "어떤 상태의 앱을 재는가"가 결과에
  직접 들어가므로 이 선택은 사용자 몫이다. 물을 수 없는 상황이면 합리적으로 정하고 이유를 보고에 남긴다.
- **정의가 살아 있는지 확인한다.** `command` 경로가 존재하는가, 리포가 그 실행 방식을 아직 쓰는가(Rust 바이너리 → Python으로
  바뀐 뒤 옛 정의가 남아 있던 사례). 죽은 정의를 그대로 옮기면 `init`이 "서버가 응답 전에 종료" 하나로만 실패한다.
- `type: "http"`(`url`만 있는 서버)는 러너가 지원하지 않는다. 같은 서버의 stdio 모드나 stdio 브리지가 다른 프로필에 있으면
  그걸 쓰고, 없으면 미지원이라고 분명히 말하고 멈춘다. 되는 척 등록하지 않는다.
- `cwd`가 있는 서버는 `sh -c "cd … && exec …"`로 감싼다(runner.md).
- `env`에 URL·키·토큰이 있으면 그대로 옮기되, 프로필 파일 여러 개에 **평문**으로 복제된다는 점을 사용자에게 한 줄 알려 준다
  (실제 설정도 평문이라 노출 수준이 나빠지진 않지만, 프로필 디렉터리를 공유·커밋하면 안 된다).
- Codex 정의의 `enabled = false`는 사용자가 꺼 둔 서버다. 벤치 대상으로 맞는지 확인한다.

### 2. 스킬 고르기

이 앱이 **소유한** 스킬만 붙인다 — 에이전트에게 이 앱 쓰는 법을 가르치는 스킬. 후보는
`~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.gemini/config/skills`, 앱 리포의 `skills/`에서 찾고,
같은 스킬이 여러 곳에 링크돼 있으면 **리포 안의 원본**을 가리킨다(벤치가 항상 최신 스킬을 보게).

관련 없는 스킬은 넣지 않는다. raw 트랙은 "스킬 없이 모델이 스스로 해내는가", skill 트랙은 "이 앱의 스킬이 얼마나 도움이 되나"를
재는데, 다른 스킬이 섞이면 둘 다 흐려진다. 앱 리포의 `.claude/skills/*`가 개발용(디버깅·마이그레이션)이면 그것도 아니다.
없으면 `skills: []`로 두고 `--skill`이 raw와 같다고 알려 준다.

### 3. 서버의 습성 확인

앱 JSON을 쓰기 전에 잠깐 서버 소스나 실행 방식을 본다:
- `os.homedir()`/`~`에 데이터·엔진을 두는가 → 러너가 서버 env에 실제 `HOME`을 항상 넣으므로 보통 그대로 된다.
- **벤치가 개인 데이터를 건드리는가** → 서버가 사용자의 실사용 스토어(기억·라이브러리)에 쓰기를 하면, 벤치 런이 그 데이터를
  오염시키고 사용자의 실제 세션과 잠금을 다툰다. Honcho 훅을 떼는 것과 같은 이유로 **벤치 전용 데이터 디렉터리**를 정의에
  넣는다(`--data-dir`, `ARIA_DATA_DIR` 같은 그 앱의 수단). 반대로 회상·검색 벤치처럼 실데이터가 있어야 의미 있는 앱은 읽기
  전용인지 확인하고 실데이터를 쓴다 — 어느 쪽이든 이유를 보고에 적는다.
- **새 이름을 지을 때는 먼저 존재 여부를 확인한다.** 데이터 디렉터리·peer·네임스페이스처럼 "벤치용으로 하나 새로" 정하는
  이름은 `ls`·API 조회로 비어 있는지 확인한 뒤 쓴다. `~/.neuromem-bench`가 이미 사용자의 1GB 작업 공간이어서 그 안에 파일을
  만들어 버린 사례가 있고, 존재하지 않는 peer 이름을 기본값으로 넣어 관련 도구가 전부 깨질 상황도 있었다.
- 첫 호출에 GUI·데몬을 자동 기동하거나 포트를 잡는가 → 정상이면 그대로 두고 "벤치 중 앱 GUI가 뜬다"고 알린다.
- 외부 서비스(로컬 LLM, DB, API)에 기대는가 → 꺼져 있으면 `tools/list`는 되더라도 도구 호출이 실패한다. 실행 전 확인 항목으로 적는다.
- 빈 데이터 디렉터리로 기동을 거부하는 서버(프로젝트·워크스페이스가 먼저 있어야 하는 류)는 부트스트랩이 필요하다. 그 앱의
  공식 경로(CLI·API)로 최소 상태를 만들고, 만든 것을 보고에 적는다.

### 4. 앱 JSON 쓰고 초기화

`~/.bench/apps/<app>.json`(스키마는 runner.md). `tools`는 쓰지 않는다 — `init`이 채운다.

```bash
bench init <app>
```

`init`은 각 MCP 서버를 실제로 한 번 띄워 `tools/list`를 받아 도구 이름을 JSON에 캐시하고, 세 하네스의 프로필을 만든다.
**여기서 실패하면 서버가 그 정의로 단독 실행되지 않는 것이다.** 러너는 "MCP 서버가 응답 전에 종료됐습니다"까지만 말하므로,
같은 command/args/env로 서버를 **손으로 띄워 stderr를 읽는다** — 죽은 바이너리, 스키마 버전 불일치, 필수 상태 없음 같은
진짜 원인은 거기 있다. 정의를 고친 뒤 다시 `init`. `references/pitfalls.md`에 증상별 원인이 있다.

Codex는 MCP 도구를 **도구별로** 승인해야 하고 승인이 없으면 호출이 0초 만에 취소된다. `init`이 받아온 도구 목록이 그 승인
테이블이 된다. 서버에 도구가 추가되면 `init <app> --refresh-tools`.

### 5. 격리가 실제로 됐는지 확인 — 실제로 돌린다

`bench status <app>`으로 준비 상태를 보고, **무해한 읽기 도구 하나**로 스모크를 실제 LLM으로 돌린다. dry-run은 명령이
맞는지만 보여 주고 격리는 증명하지 못한다 — 사용자 스킬이 `~/.agents/skills`에서 딸려 들어오거나 플러그인이 캐시에서
되살아나는 문제는 모델이 "보이는 목록"을 답해 줘야 드러났다. effort low 한 번이면 비용은 몇 만 토큰이다.
프롬프트는 도구 호출 결과와 "보이는 MCP 서버·스킬 목록"을 함께 묻는다:

```bash
bench run <app> codex --effort low -- "1) Call the <서버> MCP tool <읽기도구> and report the result in one line. 2) List every MCP server and every skill available to you. Be brief."
bench run <app> agy --skill --effort low -- "1) Is a skill named <스킬> available? YES/NO. 2) List every MCP server available to you. 3) Call <서버>/<읽기도구> and report one line."
```

기대값:
- MCP 서버는 **이 앱의 것만**. 다른 이름이 보이면 오염 — pitfalls에서 그 하네스 항목을 본다.
- raw에서 스킬은 CLI 내장만(Claude: dataviz·code-review·loop 등, Codex: imagegen·openai-docs·skill-creator 등, agy: antigravity-guide 등). 사용자 스킬 이름(html·design-artifact·aria-compose 등)이 보이면 오염.
- `--skill`에서는 이 앱의 스킬이 보여야 한다.
- 도구 호출이 실제 값을 돌려줘야 한다. "cancelled"·"unavailable"이면 Codex 승인 테이블 또는 서버 실행 문제.

Claude Code는 공유 벤치 프로필 `~/.bench/_claude/`에 첫 1회 `/login`이 필요하다. `bench status`가 미로그인이라 하면 사용자에게
`bench run <app> claude`를 열어 `/login` 하라고 안내하고, 그 뒤 같은 스모크를 Claude로도 돌린다. 로그인은 앱이 늘어도 다시 필요하지 않다.

### 6. 보고

사용자에게 알릴 것만 짧게:
- 등록된 서버와 스킬, 어느 프로필 정의를 기준으로 했는지(다른 프로필과 달랐던 점, 죽은 정의였다면 그 사실)
- 벤치 전용으로 새로 만든 것(데이터 디렉터리·부트스트랩 상태)과 그 이유
- 실행 명령: `<app>bench claude|codex|agy [--skill] [--effort E] [-- "…"]` — 새 함수는 `source ~/.zshrc` 뒤에 생긴다
- 스모크 결과(무엇이 보였고 무엇이 안 보였는지, 도구가 실제 값을 냈는지)
- 남은 일: Claude `/login` 여부, 서버가 기대는 외부 서비스, 미지원 사항, 평문으로 복제된 비밀값

`~/.zshrc`는 건드리지 않는다 — 앱 JSON이 생기면 함수는 자동으로 따라온다. 실제 CLI 설정 파일(`~/.claude.json`, `~/.codex/config.toml`,
`~/.gemini/*`)은 읽기만 한다.

## 문제가 생기면

`references/pitfalls.md`에 하네스별 함정과 해결이 정리돼 있다(Codex 도구 승인·`~/.agents/skills` 유출·`codex_apps`·stdin 대기,
agy 플러그인 유출·HOME 오버라이드, Claude 프로필별 로그인·스킬 위치, 앱별 등록 이력). 새 함정을 만나면 그 파일에
증상 → 원인 → 해결을 한 항목으로 추가해 다음 등록이 반복하지 않게 한다. 러너 자체를 고쳐야 하는 문제면 `scripts/bench.mjs`를
고치고 `bench init <app>`으로 프로필을 다시 생성한다 — 프로필은 언제든 버리고 다시 만들 수 있는 산출물이다.
