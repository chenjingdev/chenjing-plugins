# verify — 검수하고 넘기기

다 만든 것을 사용자 대신 써 보고, 모든 시나리오를 스크린샷과 함께 보고서로 남긴다. 명세에 없는 "처음 써 보는 사람" 시나리오도 돌린다. 다 만든 뒤에야 보이는 문제를 여기서 잡는다.

## 1. 준비

1. `node <pact>/scripts/spec.mjs set-status <명세> verifying`
2. 화면이 있는 결과물은 verifier가 Codex CUA로 사용자의 Chrome에서 직접 써 보고 스크린샷을 남긴다. 따로 설치할 것은 없다. Codex CUA 도구가 없거나 Chrome이 연결되지 않으면 verifier가 화면 없이(명령과 HTTP 요청으로) 검수하고 보고서에 그 이유를 적는다. 그 경우 사용자에게도 한 줄 알린다.
3. 대상을 실행한다. 개발 서버라면 worktree에서 백그라운드로 띄우고 URL을 확인한다. 화면이 없으면 실행 명령을 정한다.

## 2. 검수

1. `pact:verifier`에 명세 경로, run-dir, 실행 방법(URL 또는 명령)을 넘긴다.
2. verifier가 `<run-dir>/results.json`을 쓰면 명세 `## 결정 기록`의 Ruling 줄들을 `rulings` 배열에 넣는다.
3. `node <pact>/scripts/report.mjs <run-dir>`로 보고서를 만든다. 첫 줄이 요약(`통과 n · 실패 n · 의심 n`), 둘째 줄이 `report.html` 경로다. 보고서를 `open`으로 연다.
4. 띄운 개발 서버를 멈춘다.

## 3. 실패나 의심이 있으면

verify에서는 고치지 않는다. build로 되돌린다.
- 무엇을 고칠지는 수정 기준 표를 따른다. `[AI 가정]` 범위면 고치고 Ruling을 남긴다. `[사용자]` 항목을 바꿔야 하면 보고서를 보여 주고 묻는다.
- `set-status <명세> building`으로 돌리고 `build.md`로 간다. worktree가 이미 있으니 build는 0의 이어 하기로 들어가 3(작업마다)부터 고친다. 그다음 verify를 처음부터 다시 돌린다.
- 같은 시나리오가 두 번 실패하면 멈추고, 보고서 경로와 함께 무엇이 막혔는지 사용자에게 알린다.

## 4. 모두 통과하면

묻지 않고 로컬에서 마무리한다. git으로 되돌릴 수 있는 일이다.

1. worktree에 남은 변경이 있으면 커밋한다.
2. 메인 작업 트리의 명세 파일(status, 결정 기록)을 먼저 커밋한다(`docs(pact): <주제> 진행 기록`).
3. `node <pact>/scripts/git-state.mjs <프로젝트>`로 확인한다. 그래도 `changed`가 남아 있으면 사용자의 작업이니 목록을 알리고 멈춘다. `untracked`는 상관없다.
4. 메인 작업 트리에서 `git merge --no-ff --no-edit -m "merge(pact): <주제>" pact/<slug>`로 합친다. 충돌이 나면 `git merge --abort`로 되돌리고 멈춰서 알린다.
5. `git worktree remove <run-dir>/wt`, 그리고 `git branch -d pact/<slug>`. worktree에 커밋하지 않은 파일이 있어 지우기가 거부되어도 `--force`는 쓰지 않는다. `git -C <run-dir>/wt status --porcelain`으로 남은 파일을 보고, 빌드 산출물이나 임시 파일이면 `<run-dir>/leftover/`로 옮긴 뒤 다시 지운다. 소스로 보이는 파일이면 목록을 알리고 멈춘다.
6. `node <pact>/scripts/spec.mjs set-status <명세> done`, 명세 파일을 커밋한다(`docs(pact): <주제> 완료`).

## 5. 알리기

완료라고 말하기 전에 보고서의 요약 줄을 실제로 다시 읽고 그 숫자를 그대로 인용한다. 기억이나 짐작으로 숫자를 적지 않는다.

채팅으로 보낸다:
- 요약 한 줄(`통과 n · 실패 n · 의심 n`)과 무엇이 합쳐졌는지
- 보고서 경로
- "push할까요?" — push는 외부 공개라 묻고 한다.

다음: 끝 — 사용자에게 보고서를 보여 준다
