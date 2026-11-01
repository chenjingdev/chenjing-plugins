# recall

쌓인 기억에서 예전 시도와 그 끝, 실패와 원인, 미룬 아이디어, 지키라는 규칙을 뽑아 준다. 같은 실패를 되풀이하거나 이미 미뤄 둔 아이디어를 처음 떠올린 것처럼 다시 꺼내는 일을 줄이려는 플러그인이다. pact가 명세를 쓰기 전에 부르고, pact 밖에서도 말로 부를 수 있다.

## 설치

```
/plugin install recall --marketplace chenjingdev/chenjing-plugins
```

node 18 이상이 깔려 있어야 한다. 외부 패키지는 없다.

## 켜는 법

따로 외울 명령이 없다. "이거 전에 어떻게 됐더라", "예전에 해 봤던가", "기록 찾아봐", "지난번에 왜 실패했지"처럼 말하면 켜진다. 다른 스킬은 `recall:recall`로 부른다. 직접 돌리려면:

```
node plugins/recall/scripts/recall.mjs <주제 낱말…> --project <프로젝트 절대 경로> [--json]
```

## 출처 셋

- **기억 서버(Honcho)의 대화:** 서버에 HTTP로 직접 묻는다(MCP가 아니다). 사용자가 한 말 두 번과 AI의 보고 한 번, 모두 세 번 찾아 `사용자 말`·`AI 보고`로 보인다. 시스템이 끼워 넣은 글(`<system-reminder>` 등)과 2,000자가 넘는 사용자 메시지는 뺀다.
- **pact 기록:** `RECALL_ROOTS`(기본 `~/dev`) 아래의 `.pact/*/spec.md`와 옛 `docs/pact/*.md`, 같은 폴더의 `summary.json`·`results.json`. worktree·testbed·tmp 복사본은 뺀다.
- **Claude 메모리 파일:** `~/.claude/projects/<프로젝트>/memory/*.md` 중 `feedback`·`user`는 규칙으로, `project`는 예전 시도로 읽는다.

주제 낱말이 겹친 수가 점수이고, 지금 프로젝트의 기록은 가산한다. 다른 저장소의 기록은 낱말이 하나만 겹치면 `비슷한 기록`으로, 줄 끝에는 `다른 저장소`로 표시한다. 한 묶음은 많아야 8줄, 한 줄은 120자까지만 싣는다.

## 환경 변수

모두 선택이다. 기억 서버 변수가 세션 환경에 없으면 `HONCHO_ENV_FILE`을 `KEY=VALUE` 줄로 읽어 채우고, 환경 변수가 있으면 그것이 먼저다.

| 이름 | 기본 | 뜻 |
|---|---|---|
| `HONCHO_BASE_URL` | `http://127.0.0.1:8001` | 기억 서버 주소 |
| `HONCHO_WORKSPACE_ID` | `memory` | workspace |
| `HONCHO_USER_NAME` | `user` | 사용자 peer 이름 |
| `HONCHO_API_BEARER_TOKEN` | 없음 | 있으면 `Authorization: Bearer`로 보낸다. 출력 어디에도 싣지 않는다 |
| `HONCHO_ENV_FILE` | `~/.config/codex-honcho-sync/.env` | 위 변수를 채울 파일 |
| `RECALL_ROOTS` | `~/dev` | pact 기록을 찾을 폴더들(`:`로 나눔). 대화의 저장소 이름도 이 아래 폴더로 알아낸다 |
| `RECALL_BUDGET_MS` | `60000` | 기억 서버 출처 전체 예산(ms) |
| `RECALL_REQUEST_MS` | `2500` | 기억 서버 요청 하나의 제한(ms) |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | 메모리 파일이 있는 폴더 |

## 출력

머리줄에 읽은 출처 수가 나오고, 못 읽은 출처는 한 줄씩 까닭과 함께 적힌다. 기억 서버에 닿지 않거나 시간이 넘어도 종료 코드는 0이고 나머지 출처의 결과만 나온다.

```
recall: pact 선택지 질문 — 출처 2/3 · 121ms
- 못 읽음: 기억 서버 (연결 거부 127.0.0.1:8001)

## 예전 시도와 그 끝
- (10/29 · pact 기록 chenjing-plugins) pact를 지시 대신 코드와 기록으로 지키기 — 완료 · 결정 87건 · …
- (10/18 · 사용자 말) pact 다른세션에서 쓰인거 보면 선택지 여러개 주는데 의미없는 선택지가 너무 많네; — 다른 저장소
- 비슷한 기록 · (10/18 · pact 기록 unified-login) 화면 정리 — 완료 · … — 다른 저장소

## 실패와 원인
- (10/29 · pact 기록 chenjing-plugins) 남은 할 일: …

## 미룬 아이디어
- (11/1 · pact 기록 chenjing-plugins) 팀원 기억

## 지키라는 규칙
- (10/20 · 메모리 파일) 막연한 질문엔 빈칸 대신 진짜 갈리는 방향과 추천을 내밀어 고르게 한다 …
```

`--json`은 같은 내용을 `{ topic, elapsed_ms, sources, buckets }`로 낸다.

## 파일을 만들지 않는다

결과는 표준 출력으로만 나온다. 기억 서버에는 읽기 요청만 보내고, 어떤 파일도 쓰지 않는다. 사람이 확인한 줄만 명세에 옮겨 git에 남는다.
