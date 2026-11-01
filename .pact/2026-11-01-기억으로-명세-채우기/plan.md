# plan — 기억으로 명세 채우기

- 명세: /Users/chenjing/dev/chenjing-plugins/.pact/2026-11-01-기억으로-명세-채우기/spec.md
- 브랜치: pact/2026-11-01-기억으로-명세-채우기
- 시작 HEAD: 546cd40416723ff896271572051c88788fcf8151
- worktree: /Users/chenjing/dev/chenjing-plugins/.pact/2026-11-01-기억으로-명세-채우기/wt

## 어떻게 만드나 (명세가 적지 않은 것)

- 새 플러그인 `plugins/recall/`: `.claude-plugin/plugin.json`, `skills/recall/SKILL.md`, `scripts/recall.mjs`, `tests/*.test.mjs`, `README.md`. 마켓플레이스(`.claude-plugin/marketplace.json`)에 등록.
- `node <recall>/scripts/recall.mjs <주제 낱말…> [--project <dir>] [--json]`가 세 출처를 뒤져 네 묶음을 표준 출력으로 낸다. 파일은 쓰지 않는다. 늘 종료 코드 0(실패해도 열려 있음), 못 닿은 출처는 머리줄에 적는다.
  - 출처 1 기억 서버: `HONCHO_BASE_URL`(기본 http://127.0.0.1:8001) `/v3/workspaces/<HONCHO_WORKSPACE_ID|memory>/search`에 POST. 사용자 말은 `filters.peer_id = HONCHO_USER_NAME|user_chen`, AI 보고는 peer 제한 없이 찾고 `direct_user:false`인 assistant 메시지만. `<system-reminder>`·`<command-message>`·`<local-command`·`<task-notification>`로 시작하는 메시지와 2,000자 넘는 사용자 메시지는 뺀다. 요청마다 2.5초, 전체 예산 `RECALL_BUDGET_MS`(기본 60000). 토큰은 `HONCHO_API_BEARER_TOKEN`이 있으면 Bearer로.
  - 출처 2 pact 기록: `RECALL_ROOTS`(기본 `~/dev`) 아래 깊이 4까지 `.pact/*/spec.md`와 옛 `docs/pact/*.md`. `/wt/`, `/scratch/`, `node_modules`, `testbed`, `/tmp/`, `-wt-` 폴더는 뺀다. 같은 주제 슬러그는 날짜 있는 `.pact/<날짜>-<슬러그>/spec.md`를 남기고 하나로 친다. 읽는 것: frontmatter(topic·status·created), `## 목적` 첫 줄, `## 하지 않는 것`의 `다음 판 후보` 줄, `## 확인 필요`, `## 결정 기록` Ruling 수, 같은 폴더의 `summary.json`(headline·todo), `results.json`(fail·doubt 시나리오 title·decision).
  - 출처 3 Claude 메모리 파일: `~/.claude/projects/<프로젝트 경로의 /를 -로 바꾼 이름>/memory/*.md`. frontmatter `type`이 feedback·user면 규칙 묶음, project면 예전 시도 묶음.
  - 같은 주제 판정(R3): 주제 낱말과 topic·목적·F 줄의 낱말 겹침 점수. 같은 저장소 가산. 점수가 낮지만 0이 아니면 `비슷한 기록` 표시.
  - 출력 줄 꼴: `- (M/D · <출처>) <요지 120자 안>`. 출처는 `사용자 말`, `AI 보고`, `pact 기록 <저장소>`, `메모리 파일`. 지금 해가 아니면 `YYYY/M/D`. 원문 전체는 싣지 않는다(F6). 저장소가 `--project`와 다르면 `다른 저장소` 표시.
- pact가 recall을 찾는 법: Skill 도구 목록의 `recall:recall`. 없으면 "기록 없음"(F2 케이스). 행동 시험은 run.mjs가 pact 변형에 `--plugin-dir <repo>/plugins/recall`을 같이 싣고, `RECALL_ROOTS`를 작업 폴더로, `HONCHO_BASE_URL`을 닿지 않는 주소(http://127.0.0.1:9)로 준다(A3·A4). 심은 기록은 fixture 안 `.pact/<날짜>-<주제>/spec.md`(status building)와 `summary.json`.
- 출처 태그(R2): 이번 저장소 대화면 `[사용자: 10/18]`, 다른 저장소면 `[사용자: 10/18 alibaba]`처럼 저장소 이름을 뒤에 붙인다. AI 결론은 `[AI 가정: 기록 10/11]`·`[AI 가정: 기록 10/11 alibaba]`. lint는 콜론 뒤 글을 이미 받는다. HTML 보기는 콜론 뒤에 날짜가 있으면 "기록" 표시, 저장소 이름이 더 있으면 "다른 저장소" 표시를 단다(F9).
- `spec.mjs html <명세>`: `<run-dir>/spec.html`을 만들고 경로를 출력. 스타일은 checklist.mjs와 같은 계열(system-ui, 720px). 태그는 칩으로(사용자=파랑, AI 가정=회색, 위험=빨강, 기록=주황 테두리, 다른 저장소=주황 채움). `<details>`는 접힌 채로. `*/spec.html`은 `.pact/.gitignore`에 더한다(만들어 내는 파일이라 git에 두지 않는다).
- 명세 변경: probe.md 1(recall 부르기, 묶음을 첫 메시지 2에 쓰기), 1-3(`(기록 M/D)` 갈래), 3-2(체크리스트 `suggested`로), 5(출처 태그, 실패→A 항목, `- 기록에서 뺌:` 줄), 6-1(spec-checker에 `(기록 M/D 사용자 원문)` 출처와 실패 묶음), 6-4(`spec.mjs html` 열고 채팅으로 알림, 기록·다른 저장소 줄 따로 보이기). spec-checker.md 입력·(b)·새 (e). verifier.md: 기록에서 온 A 항목은 그 장면을 재현, 못 하면 unverified와 까닭. SKILL.md "남기는 파일"에 spec.html. README 0.8.0, plugin.json 0.8.0.
- 검수 기준 재는 법: A1·A2는 verifier가 실제 저장소(기록 있는 주제, 예: `pact 선택지`)로 probe 첫 메시지와 명세를 돌려 확인. A3는 `node tests/behavior/run.mjs recall-first-message --runs 5 --variant pact`와 `first-message --runs 5 --variant pact`(기록 없는 장면 대조). A4는 행동 시험 환경 자체가 닿지 않는 주소라 같은 실행의 "서버 안 닿음" 한 줄로 확인.

## 작업

1. recall 스크립트 — pact 기록·메모리 파일 출처와 출력 꼴 (F1 일부, R3, F6 요지만) · 완료: `node --test plugins/recall/tests/` 통과, 실제 `~/dev`로 돌려 네 묶음이 나옴
2. recall 스크립트 — 기억 서버 출처, 예산·실패 열림, 플러그인 뼈대(plugin.json·SKILL.md·README·마켓플레이스) (F1, F1 케이스, A4) · 완료: 가짜 HTTP 서버 테스트 통과, 닿지 않는 주소로 돌려도 종료 0과 머리줄 알림
3. pact `spec.mjs html` + gitignore (F9) · 완료: `node --test plugins/pact/tests/spec.test.mjs` 통과, 이번 명세로 spec.html이 나옴
4. pact 지침 — probe·SKILL·spec-checker·verifier·README·plugin.json (F2~F6, F8, R1, R2) · 완료: `node --test plugins/pact/tests/prose.test.mjs` 통과(새 문구 고정 포함), 전체 테스트 통과
5. 행동 시험 — 장면 `recall-first-message`, fixture, run.mjs의 recall 싣기·환경 변수 (A3, A4) · 완료: `node --test plugins/pact/tests/` 통과, `run.mjs recall-first-message --runs 1 --variant pact`가 돌아 판정이 나옴
