# OptiView

지금 보고 있는 터미널의 Claude Code 답을 옆의 작은 읽기 창에 보여 주는 플러그인이다. **Claude Code 전용.** 앞부분은 설치와 쓰는 법, `## 방향`부터는 동작 흐름과 개발 방법을 적는다.

## 설치

```
/plugin marketplace add chenjingdev/chenjing-plugins
/plugin install optiview@chenjing-plugins
```

Node.js 20 이상이 필요하다. 설치하고 Claude Code를 다시 시작하면 세션을 열 때 읽기 창이 저절로 뜬다. `claude --plugin-dir`로 이 폴더를 붙여 쓰는 중이면 설치본과 같이 쓰지 않는다(훅이 두 번 돈다).

예전에 유비온 마켓플레이스에서 `optiview@ubion`으로 설치했다면 `/plugin uninstall optiview@ubion`으로 지우고 위처럼 다시 설치한다.

## 쓰는 법

- 문장은 한 글자도 바꾸지 않는다. 긴 답은 첫 결론만 펼치고, 제목 달린 섹션은 접어서 제목만 보인다.
- 끝에서 Claude가 묻는 말은 접지 않고 강조한다. 답은 터미널에서 한다. 읽기 창은 입력을 받지 않는다.
- 한 번에 한 턴을 보인다. `‹ ›` 버튼이나 방향키로 앞뒤 턴을 보고, 5턴 넘게 뒤로 가면 **최신 답** 버튼이 나온다. 새 질문을 하거나 다른 터미널로 옮기면 최신 답으로 돌아간다.
- **cmux**: 분할이나 워크스페이스를 옮기면 그 칸의 대화로 바뀐다. Claude가 없는 칸(셸 등)을 누르면 마지막 대화를 그대로 둔다. `/optiview:open --dock`으로 읽기 창을 오른쪽 Dock에 붙일 수 있다(시험 중).
- **그 밖의 터미널**(Orca 포함): 마지막으로 질문한 세션을 따라간다. 창 위 제목을 눌러 세션을 직접 고를 수도 있다(고르면 고정된다).

| 명령 | 하는 일 |
|---|---|
| `/optiview:open` | 읽기 창 열기 (`--dock`: cmux 오른쪽 Dock, `--browser`: 기본 브라우저) |
| `/optiview:status` | 서버, 포커스 연동, 지금 보이는 대화 보기 |

- 답을 따로 저장하지 않고 Claude Code의 대화 기록 파일을 읽는다. 서버는 `127.0.0.1:4780`에만 뜨고, 세션 목록만 `~/.optiview`에 둔다. 밖으로 보내는 데이터는 없다.
- 창 형태는 `~/.optiview/config.json`의 `"window"`로 바꾼다: `auto`(작은 창), `dock`(cmux 오른쪽 Dock), `browser`, `off`.
- `claude -p`·SDK 실행과 백그라운드 작업은 읽기 창에 나오지 않는다.
- 선택: cmux(클릭한 분할 따라가기), Chrome·Edge·Brave(주소창 없는 작은 창).

## 방향

2026-09-30 회의에서 정한 것을 따른다.

- 포커스한 터미널의 대화만 보인다. 대시보드·감시·게이지는 넣지 않는다.
- 문장은 가공하지 않고 구조만 가공한다. 결과는 먼저 보이고 상세는 접는다.
- 한 번에 한 턴을 보인다. 앞뒤로 넘기고, 5턴 넘게 뒤로 가면 최신 답 버튼을 보인다. 세션을 바꾸거나 새 질문을 하면 최신으로 간다.
- 채팅·입력은 없다. 질문과 선택은 터미널에서 한다.

0.7까지의 보고서 작성·감시 기능은 git 기록(`4e63f74`, 0.6.0)에 남아 있다.

## 흐름

```
Claude Code 훅(async) ──▶ 로컬 서버(127.0.0.1:4780) ──SSE──▶ 읽기 창
  세션 ID, 기록 파일, 터미널 칸        │
                                      ├─ Claude Code 기록 파일(JSONL)을 이어 읽어 턴을 만든다
                                      └─ 앱 연동이 알린 포커스로 보일 세션을 정한다
```

- **훅**(`lib/hook.mjs`): SessionStart, UserPromptSubmit, Stop, StopFailure, SessionEnd. 세션 ID, 기록 파일 경로, 작업 폴더, 터미널 칸(`lib/terminal.mjs`)만 서버에 알린다. 모두 `async`라 Claude를 기다리게 하지 않는다. 서버가 없거나 판이 다르면 새로 띄운다. `claude -p`·SDK 실행과 백그라운드 작업(`CLAUDE_JOB_DIR`)은 등록하지 않는다.
- **기록 읽기**(`lib/transcript.mjs`): 답을 따로 저장하지 않는다. 기록 파일을 처음 한 번 읽고 늘어난 부분만 이어 읽는다. 도구 결과 줄은 JSON으로 읽기 전에 거른다(84MB 기록 약 0.2초).
  - 턴 = 사람의 질문 + 답. 답은 도구 호출로 나뉜 글 덩어리 중 **마지막으로 길게(600자 이상) 쓴 덩어리부터 끝까지**다. 긴 답을 쓴 뒤 도구를 한 번 더 부르고 짧게 끝나도 본문이 사라지지 않는다.
  - 로컬 명령(`/effort` 등), 메타 줄, 압축 요약, 곁가지는 턴이 아니다. 답이 있는 명령과 작업 알림은 턴이다. 작업 중에 친 말(대기열)은 그 턴에 붙는다.
  - 끝남은 `end_turn` 또는 `turn_duration`으로, 중단은 `[Request interrupted`로, 오류는 `isApiErrorMessage`로 안다.
- **서버**(`lib/server.mjs`): 세션 목록은 `~/.optiview/sessions.json`에 둔다(14일, 300개). 최근 6시간 안에 움직인 세션의 기록 파일을 `fs.watch`로 지켜본다. 토큰, Host, Origin을 검사한다.
- **읽기 창**(`web/`): `markdown.js`(모든 글자를 이스케이프), `structure.js`(구조 규칙), `app.js`(넘기기·세션 고르기·테마). 기본 테마는 Ghostty 설정(cmux·Orca도 읽는 파일)의 배경·글자 색을 따른다.

## 구조 규칙(`web/structure.js`)

- 1,300자 또는 28줄이 넘고 제목 달린 섹션이 있으면 접는다. 제목 앞 글(결론)은 펼치고 섹션은 제목과 힌트("3항목", "표 2행")만 보인다. 제목으로 시작하는 답은 첫 섹션을 펼친다.
- 굵은 글씨만 있는 줄(`**남은 일**`)도 섹션 제목으로 본다.
- 끝 문단이 질문이면(바로 앞 선택지 목록까지) 접지 않고 "답이 필요해요"로 강조한다.
- 긴 코드(18줄 초과)는 앞부분만 보이고 펼칠 수 있다.
- 기준값은 Claude Code 답 651개를 재서 정했다: 중간값 843자, 상위 25%가 1,300자를 넘고, 긴 답의 96%가 제목 달린 섹션을 갖는다.
- 검사(`test/render.test.mjs`)가 원문의 모든 글자가 보이는 글에 순서대로 남는지 확인한다.

## 포커스

보일 세션은 `lib/focus.mjs`가 정한다.

1. 앱 연동이 알린 포커스 칸에 Claude 세션이 있으면 그 세션.
2. 칸은 모르고 보이는 워크스페이스만 알면 그 안의 Claude 세션.
3. 보이는 워크스페이스에서 질문이 들어오면 그 칸(사람은 보이는 칸에만 칠 수 있다). 보이지 않는 워크스페이스에서 온 질문(자동화)은 무시한다.
4. 포커스 칸에 Claude가 없으면 마지막 대화를 두고 "Claude가 없는 칸"을 표시한다.
5. 앱 연동이 없는 터미널은 마지막으로 질문한 세션.
6. 창에서 세션을 고르면 고정한다. "따라가기"로 푼다.

| 앱 | 세션과 칸 잇기 | 포커스 알기 |
|---|---|---|
| cmux | `CMUX_SURFACE_ID`, `CMUX_WORKSPACE_ID` | `~/.cmuxterm/events.jsonl`을 따라 읽는다(`lib/hosts/cmux.mjs`). `workspace.selected`, `window.keyed`, `surface.focused`. 소켓 권한이 필요 없고 새 줄만 읽는다 |
| Orca | `ORCA_PANE_KEY`의 칸 UUID(재시작해도 유지), `ORCA_WORKTREE_ID` | 아직 없음. Orca에는 포커스 API가 없어 런타임 소켓 폴링(`worktree.ps` → `session.tabs.list`)이 필요하다. TODO 참고 |
| 그 밖 | 없음 | 마지막으로 질문한 세션. `optiview focus --host <앱> --id <칸>`으로 스크립트가 알려 줄 수 있다 |

## 창

`lib/window.mjs`. 기본(`auto`)은 Chrome 계열 `--app` 창(480×860, 전용 프로필)이고 없으면 기본 브라우저다. `dock`을 고르면 cmux 오른쪽 Dock에 브라우저 탭을 붙인다(`cmux new-surface --type browser --placement dock`). 이미 있으면 새로 만들지 않는다. 이 탭이 워크스페이스별 Dock에 붙는지 창 전체 Dock에 붙는지 확인 전이라 기본값이 아니다.

## 개발

```bash
npm install          # Playwright(E2E만)
npm test             # 단위: 기록 읽기, 마크다운·구조, 포커스·cmux, 서버
npm run e2e          # 읽기 창을 실제 브라우저로 조작
claude plugin validate --strict plugin
```

실제 Claude Code에 붙여 보기(설치본과 따로 두려면 데이터 폴더와 포트를 바꾼다):

```bash
OPTIVIEW_HOME=/tmp/optiview-dev OPTIVIEW_PORT=4791 claude --plugin-dir <이 저장소>/plugins/optiview/plugin
```

- `OPTIVIEW_WINDOW=app|browser|dock|off`: 창 형태
- `OPTIVIEW_AUTO_OPEN=0`: 세션 시작 때 창을 열지 않음
- `OPTIVIEW_INCLUDE_SDK=1`: `claude -p`로 훅을 검사할 때만
- 서버 기록: `$OPTIVIEW_HOME/server.log`, 훅 오류: `$OPTIVIEW_HOME/hook.log`

버전은 세 곳을 같이 올린다: `plugin/.claude-plugin/plugin.json`, `plugin/lib/config.mjs`의 `VERSION`, `package.json`.
