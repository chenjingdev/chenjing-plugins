# 작업 5 보고 — 행동 시험에 recall 싣기와 "기록이 있는 장면"

상태: BLOCKED (코드·단위 테스트·커밋은 끝남. 실제 `claude -p` 한 번 돌리기만 못 함 — 깨끗한 프로필 로그인이 만료됨)

## 바꾼 것 (커밋 5aa42a1, worktree 안)
- `plugins/pact/tests/behavior/run.mjs`
  - `RECALL = <PACT>/../recall`. `runTurn`이 pact 변형에 `--plugin-dir <pact>` 뒤에 `--plugin-dir <recall>`도 붙인다(폴더가 있을 때만). 대조군은 둘 다 안 붙는다.
  - `runOnce` env: `RECALL_ROOTS=realpathSync(cwd)`, `HONCHO_BASE_URL=http://127.0.0.1:9`, `CLAUDE_PROJECTS_DIR=<회차마다 새 빈 임시 폴더>`.
- `plugins/pact/tests/behavior/runs.mjs` — `guidelineFiles`에 recall의 `skills/recall/SKILL.md`와 `scripts/**/*.mjs`를 넣었다. `fingerprint`(pact 변형만)와 `guidelineHash` 둘 다 따라 바뀐다. 대조군 지문은 그대로.
- `plugins/pact/tests/behavior/scenarios/recall-first-message.json`(새) — 지시한 7개 검사 그대로.
- `plugins/pact/tests/behavior/scenarios/first-message.json` — `replyMatch turn 0 "기록 없음"` 추가.
- `plugins/pact/tests/behavior/fixtures/recall-idea/`(새) — `메모.md`, `.pact/2026-10-20-회의-일정-앱/{spec.md,summary.json}`.
- `plugins/pact/tests/behavior-run.test.mjs` — 기록하는 가짜 claude로 실제 `run.mjs`를 돌려 인자·env를 확인하는 테스트 2개.
- `plugins/pact/tests/runs.test.mjs` — recall 파일 변경이 pact 지문·지침 지문을 바꾸고 대조군은 안 바꾸는지 보는 테스트 1개.

## recall 스크립트를 fixture로 돌린 출력
명령: `RECALL_ROOTS=<fixture> HONCHO_BASE_URL=http://127.0.0.1:9 CLAUDE_PROJECTS_DIR=<빈 폴더> node plugins/recall/scripts/recall.mjs 회의 일정 웹앱 --project <fixture 절대 경로>`

```
recall: 회의 일정 웹앱 — 출처 2/3 · 7ms
- 못 읽음: 기억 서버 (연결 거부 127.0.0.1:9)

## 예전 시도와 그 끝
- (10/20 · pact 기록 recall-idea) 회의 일정 앱 — 멈춘 채 남음(status building) · 달력 보기까지 만들고 알림 보내기에서 멈췄다 — 팀 회의 일정을 잡는 웹앱

## 실패와 원인
- (10/20 · pact 기록 recall-idea) 확인 필요: 알림을 메일로 보낼지 정하지 못함
- (10/20 · pact 기록 recall-idea) 남은 할 일: 알림을 메일로 보낼지 정하기

## 미룬 아이디어
- (10/20 · pact 기록 recall-idea) 참석자 투표
- (10/20 · pact 기록 recall-idea) 시간대 바꿔 보기

## 지키라는 규칙
- 없음
```
세 묶음(예전 시도와 그 끝 · 실패와 원인 · 미룬 아이디어 둘)이 심은 대로 나오고, 닿지 않는 서버는 `못 읽음` 한 줄로 나온다. (처음엔 `## 목적`을 `- ` 글머리로 써서 출력에 `— - 팀 회의…`가 끼었다. 실제 명세처럼 평문으로 고쳤다.)

## 확인
- `cd wt/plugins/pact && node --test tests/` → 552개 중 통과 552, 실패 0 (커밋 전 마지막 실행). 처음 실행 때도 552/552. 새 테스트 3개 포함.
- 변이 확인: `RECALL_ROOTS`를 realpath 없이 `cwd`로, recall `--plugin-dir` 줄 삭제, `HONCHO_BASE_URL` 삭제, `CLAUDE_PROJECTS_DIR` 삭제 — 각각 넣으면 `behavior-run.test.mjs`에서 실패 1개씩 나왔고(나머지 5 통과), 원복 후 모두 통과.
- 실제 시험: `node tests/behavior/run.mjs recall-first-message --runs 1 --variant pact --concurrency 1` → 끝까지 돌았으나 **claude가 3초 만에 `Failed to authenticate: OAuth session expired and could not be refreshed`로 끝남**. 표는 `XXXXXOO`(skillInvoked·알림·멈춤·기록 10/20·서버 알림 실패, 질문 수·worker 통과)인데, 모델이 한 번도 답하지 않은 결과라 검사 판정으로 읽으면 안 된다. 같은 시도에서 `init` 이벤트로 확인된 것: 플러그인 `pact 0.8.0`과 `recall 0.1.0`이 둘 다 `inline`으로 실리고, 스킬 목록에 `pact:pact`와 `recall:recall`이 있다. 즉 `--plugin-dir` 둘은 실제 claude에서 먹는다.
- 직접 확인: `CLAUDE_CONFIG_DIR=~/.bench/_claude claude -p "한 단어로 답해: 안녕" --max-turns 1` → 같은 인증 실패 메시지. 일시 오류가 아니라 이 프로필 로그인 만료다.
- 이 실패 시도가 만든 `tests/behavior/out/`(worktree 쪽, git ignore됨)은 오염 기록이라 지웠다.

## 다시 돌리려면
`CLAUDE_CONFIG_DIR=~/.bench/_claude claude`로 한 번 `/login` 한 뒤 같은 명령을 다시 돌린다. 그때 표와 첫 답의 recall 관련 줄(지난 판의 끝, `(기록 10/20)`, 서버 못 읽음)을 이 보고서에 옮기고, 실패가 있으면 패턴 문제인지 지침 문제인지 가려야 한다. 아직 첫 답을 본 적이 없어 패턴을 맞춰 본 적이 없다.

## 정한 것
- Ruling: `RECALL_ROOTS`를 `cwd` 그대로가 아니라 `realpathSync(cwd)`로 줬다 — macOS에서 `mkdtempSync(tmpdir())`는 `/var/folders/…`인데 claude는 작업 폴더를 `/private/var/folders/…`로 보고(이전 시험 기록 init `cwd`로 확인), 모델이 `--project`로 넘기는 경로가 그쪽이다. recall의 `inside()`는 글자 접두사로 같은 저장소를 가려서 둘이 다르면 심은 판이 "다른 저장소"로 찍힌다 — 틀리면 첫 메시지가 지난 판을 다른 저장소 기록으로 전한다(그리고 같은 저장소 가산점을 잃는다). 단위 테스트가 이 모양을 지킨다.
- Ruling: 지문은 `guidelineFiles`에 recall 파일을 넣는 한 곳으로 처리했다(`guidelineHash`와 `fingerprint`가 같이 바뀐다) — 둘을 따로 갈라 둘 이유가 없고 지시도 "또는"이었다 — 틀리면 `guidelineHash`가 recall 스크립트 변경에도 "지침 바뀜"으로 읽힌다(무해한 쪽).
- Ruling: 단위 테스트는 `run.mjs`를 export하지 않고 기록하는 가짜 claude로 실제 `run.mjs`를 돌려 인자·env를 읽는다 — `run.mjs`는 import하면 `main()`이 돌아서 export만 붙이면 부작용이 생기고, 기존 `behavior-run.test.mjs`도 같은 방식이다 — 틀리면 잃을 것 없음(검증 강도는 더 높음).
- Ruling: `CLAUDE_PROJECTS_DIR` 임시 폴더는 회차마다 하나씩 만들고 따로 지우지 않는다 — 기존 `pact-work-*` 작업 폴더도 안 지운다 — 틀리면 `$TMPDIR`에 빈 폴더가 쌓인다.

## 걱정·위험
- 실제 시험을 못 돌렸다. 로그인 만료라 모델 첫 답을 한 번도 못 봤고, 검사 패턴(`알림`, `멈췄|…|이어`, `기록[^)\n]{0,6}10/20`, `기억 서버|못 읽음`)이 실제 답에 맞는지는 미확인이다.
- `run.mjs`의 로그인 만료 감지(`/\/login|Invalid API key|Not logged in/`)가 `Failed to authenticate: OAuth session expired`를 못 잡는다. 그래서 이번처럼 인증이 죽어도 "시험이 끝났다"며 가짜 실패(`XXXXXOO`)를 판으로 저장하고 종료 코드 0으로 끝난다. 범위 안 파일이지만 요청 밖이라 고치지 않았다. 고치면 정규식에 `OAuth session expired|Failed to authenticate`를 더하면 된다.
- 검사 `replyMatch 알림`은 약하다. 지난 판이 멈춘 곳이 아니어도 기능 지도에 "알림" 갈래만 있으면 통과한다. 지시대로 뒀지만 가려내는 힘이 필요하면 `알림.*(멈|못|남)`처럼 좁히는 편이 낫다.
- worktree를 다른 작업이 동시에 고치고 있었다(내가 건드리지 않은 `README.md`, `agents/*`, `skills/pact/probe.md`, `tests/prose.test.mjs`, `plugins/recall/scripts/*`가 커밋 전부터 수정 상태였고, 내 작업 중 HEAD도 `d644d53`로 한 번 움직였다). 내 커밋은 내 파일 경로만 지정해 만들었고, 그 다른 변경은 건드리지 않았다. 다만 실제 시험의 지문과 `init`에 실린 recall 코드가 시험하는 순간의 작업 트리 상태에 달려 있다.
- `first-message`의 "기록 없음" 검사도 실제로는 한 번도 돌려 보지 못했다. 이 장면은 pact 지침이 recall 결과가 없을 때 "기록 없음" 한 줄을 쓰라고 한 것(probe.md §1)에 기대는데, tiny-web에는 기록이 없고 서버는 닿지 않으니 `기록 없음`과 `못 읽음`이 같이 나올 수 있다.

---

# 작업 5 보정 (검토 결과 반영, 커밋 4047d5e)

실제 `claude -p` 실행은 verify에서 사용자가 로그인한 뒤 하기로 했다. 이번엔 아래만 고치고 단위 테스트를 돌렸다.

## 바꾼 것
1. fixture `recall-idea` — `spec.md`를 `status: done`으로 바꾸고 `## 공통 규칙`(`- R1 시간은 한국 시간으로 보인다 — 팀이 한곳에 있다 [AI 가정]`)을 더했다. `summary.json`은 headline "달력 보기까지 넘기고 알림 보내기는 남은 할 일로 남겼다", todo "알림을 메일로 보낼지 정하기" 그대로.
2. `recall-first-message.json` 검사 패턴 둘.
   - `알림` → `(메일로 보낼지|알림[^\n]{0,30}(남긴|남은|못 정))`
   - `(멈췄|멈춘|하다가|남은 할 일|이어)` → `(남긴 할 일|남은 할 일|달력 보기까지|넘기고)`
3. `run.mjs` 로그인 만료 감지 정규식에 `Failed to authenticate|OAuth session expired`를 더했다. `behavior-run.test.mjs`에 테스트 하나(세 문구 각각: 종료 코드 2, `/login 하세요` 안내, 판 저장 없음, transcript 파일 없음).
4. `first-message.json`에 `replyNotMatch turn 0 "\(기록 \d{1,2}/\d{1,2}"` 추가.
5. `runs.mjs` recall 지문에 `.claude-plugin/plugin.json` 추가. 지문 테스트에 plugin.json 변경 경우를 더했다.

## 확인
- `cd wt/plugins/pact && node --test tests/` → 553개 중 통과 553, 실패 0 (552에서 로그인 테스트 1개 늘어남).
- 변이 확인: 로그인 정규식에서 새 문구를 빼면 `behavior-run.test.mjs` 실패 1개, 지문에서 recall `plugin.json`을 빼면 `runs.test.mjs` 실패 1개. 원복 후 모두 통과.
- fixture 명세 lint: `node plugins/pact/scripts/spec.mjs lint <fixture>/.pact/2026-10-20-회의-일정-앱/spec.md` → 종료 코드 0 (이전엔 "공통 규칙 섹션이 없습니다"로 1).
- recall 출력(`RECALL_ROOTS=<fixture> HONCHO_BASE_URL=http://127.0.0.1:9 node plugins/recall/scripts/recall.mjs 회의 일정 웹앱 --project <fixture>`):

```
recall: 회의 일정 웹앱 — 출처 2/3 · 7ms
- 못 읽음: 기억 서버 (연결 거부 127.0.0.1:9)

## 예전 시도와 그 끝
- (10/20 · pact 기록 recall-idea) 회의 일정 앱 — 완료 · 달력 보기까지 넘기고 알림 보내기는 남은 할 일로 남겼다 — 팀 회의 일정을 잡는 웹앱

## 실패와 원인
- (10/20 · pact 기록 recall-idea) 확인 필요: 알림을 메일로 보낼지 정하지 못함
- (10/20 · pact 기록 recall-idea) 남은 할 일: 알림을 메일로 보낼지 정하기

## 미룬 아이디어
- (10/20 · pact 기록 recall-idea) 참석자 투표
- (10/20 · pact 기록 recall-idea) 시간대 바꿔 보기

## 지키라는 규칙
- 없음
```
  `완료`와 남은 할 일이 나온다.

## 정한 것
- Ruling: fixture 공통 규칙 R1 내용을 "시간은 한국 시간으로 보인다"로 정했다 — lint가 통과하는 데 필요한 칸일 뿐이고 `[AI 가정]` 태그만 맞으면 된다 — 틀려도 recall은 기능(F)·목적·주제만 읽어서 영향 없음.
- Ruling: 로그인 만료 테스트는 문구 세 개(전체 메시지, 앞부분만, 뒷부분만)를 각각 돌린다 — 정규식 두 갈래를 따로 지키려고 — 잃을 것 없음.

## 걱정·위험
- 실제 첫 답은 아직 한 번도 못 봤다. 새 패턴(`메일로 보낼지`, `남긴 할 일`, `달력 보기까지`, `넘기고`)도 모델이 recall 결과를 얼마나 그대로 옮기느냐에 달렸다. 요지를 다른 말로 풀어 쓰면 통과율이 낮게 나올 수 있고, 그건 패턴을 넓힐지 지침을 볼지 verify에서 가려야 한다.
- 로그인 만료 감지는 `result.result`와 stderr에서 문구를 찾는다. 모델이 일반 답에서 `Failed to authenticate`라는 영어 문구를 그대로 쓰면 로그인 만료로 오인해 종료 코드 2로 끝난다(이 시험 장면에서는 일어날 일이 거의 없음).
- 지문 변경(recall `plugin.json` 추가)으로 pact 변형 옛 기록은 다시 돈다. 지시대로 알고 넘어간다.
