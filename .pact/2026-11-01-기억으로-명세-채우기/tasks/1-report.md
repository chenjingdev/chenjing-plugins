# 작업 1 보고 — recall 스크립트: pact 기록·메모리 파일 출처와 출력 꼴

커밋: wt 브랜치 `pact/2026-11-01-기억으로-명세-채우기`의 8848384 (push 안 함)

## 바꾼 파일 (모두 wt/plugins/recall/ 아래, 새 파일)
- scripts/recall.mjs — 인자 읽기, 출처 모으기(Promise.allSettled), 점수·비슷한 기록·8줄·120자 처리, 사람용/`--json` 출력. 출처 모듈 약속은 머리 주석에 있다.
- scripts/sources/pact-records.mjs — `.pact/*/spec.md`·`docs/pact/*.md` 찾기, 슬러그 겹침 하나로, 명세·summary.json·results.json 읽어 attempts/failures/ideas 항목 만들기
- scripts/sources/memory-files.mjs — `~/.claude/projects/<이름>/memory/*.md` 읽어 rules(feedback·user)/attempts(project) 항목 만들기
- tests/pact-records.test.mjs(15), tests/memory-files.test.mjs(5), tests/recall.test.mjs(11)

## 확인
- 먼저 테스트를 쓰고 `node --test plugins/recall/tests/`가 ERR_MODULE_NOT_FOUND로 실패하는 것을 확인한 뒤 구현했다.
- `cd wt && node --test plugins/recall/tests/` → tests 31, pass 31, fail 0, skipped 0, 종료 0
- 변이 확인(scratch에서 복사본 고쳐 돌림, 뒤에 지움): 제외 경로 끄기, 겹침 하나로 끄기, 심볼릭 따라가기, 점수 0 제외 끄기, 비슷한 기록 끄기, 괄호 밖 쉼표 규칙 끄기, 8줄 자르기 끄기 → 일곱 번 모두 테스트가 실패(fail 1~2)
- `node plugins/recall/scripts/recall.mjs pact 선택지 질문 --project /Users/chenjing/dev/chenjing-plugins` → 종료 0, 103ms, 머리줄 `recall: pact 선택지 질문 — 출처 2/2 · 103ms`, 네 묶음 제목 모두 있음. "예전 시도와 그 끝" 6줄 중 chenjing-plugins 판 3줄:
  - `- (11/1 · pact 기록 chenjing-plugins) 기억으로 명세 채우기 — 멈춘 채 남음(status building) · 결정 6건 — 기억 서버(Honcho)의 대화와 …`
  - `- (10/29 · pact 기록 chenjing-plugins) pact를 지시 대신 코드와 기록으로 지키기 — 완료 · 결정 87건 · pact 0.6.0을 다 만들었고 …`
  - `- (10/11 · pact 기록 chenjing-plugins) 행동 시험 결과판 — 완료 · 결정 7건 — …`
  - 그 사이에 메모리 파일 2줄, 끝에 `비슷한 기록 · (10/18 · pact 기록 unified-login) 화면 정리 — 완료 … — 다른 저장소`
  - 실패와 원인 7줄, 미룬 아이디어 8줄(예: `팀원 기억`, `판이 끝날 때 기억에 따로 적기`), 지키라는 규칙 5줄
- 안 맞는 낱말(`전혀없는낱말xyz`)은 네 묶음 모두 `- 없음`, 종료 0. `RECALL_ROOTS=/nope`는 종료 0에 `- 못 읽음: pact 기록 (RECALL_ROOTS를 읽을 수 없음: /nope)`.
- 실제 `~/dev`(깊이 4) 훑기는 약 100ms.

## 정한 것
- Ruling: 출처 모듈은 `{ bucket, overlap, same_repo, date, source, repo, text, path }`를 내고 점수(overlap + 같은 저장소 2)·비슷한 기록·other_repo·8줄·120자 자르기는 recall.mjs 한 곳에서 한다 — R3 규칙이 출처마다 갈라지지 않게, 작업 2의 honcho 모듈이 같은 규칙을 공짜로 받게 — 틀리면 출처가 점수를 달리 주고 싶을 때 recall.mjs를 고쳐야 한다
- Ruling: 점수 0 제외는 "겹친 낱말 수(overlap) 0"이고 같은 저장소 +2는 순위용이다. 모듈은 overlap 0인 기록을 읽지도 내지도 않는다 — +2를 먼저 더하면 같은 저장소 판이 주제와 상관없이 전부 나온다. 비슷한 기록은 "점수 1" = 겹침 1 + 다른 저장소 — 틀리면 같은 저장소의 겹침 1짜리가 비슷한 기록 표시 없이 섞인다(점수 3)
- Ruling: `비슷한 기록 · `은 줄 맨 앞의 `- ` 바로 뒤에 붙인다(`- 비슷한 기록 · (10/18 · …) …`) — 목록 줄 꼴(`- `)을 깨지 않으려고 — 틀리면 pact가 읽는 쪽이 위치를 다르게 기대한다
- Ruling: 메모리 파일 폴더 이름은 프로젝트 경로의 영숫자가 아닌 글자를 모두 `-`로 바꾼 것이다('/'만이 아니다) — 실제 ~/.claude/projects 폴더가 그렇게 지어져 있다(`.pact`→`-pact`, 한글→`-`) — 틀리면 일반 경로에서는 똑같고 점·밑줄·한글 경로만 달라진다(내가 맞춘 쪽이 실제와 같다)
- Ruling: 옛 `docs/pact/<이름>.md`의 summary.json·results.json은 `.pact/<이름>/`, 없으면 `.pact/<날짜 뗀 슬러그>/`에서 찾는다. 날짜 있는 `.pact/<이름>/`에 결과가 없을 때도 같은 두 곳을 본다 — 옛 꼴 판은 같은 폴더가 없고 실제 저장소(alibaba, unified-login, worklog-effect)에서 결과 폴더가 그렇게 있다 — 틀리면 같은 슬러그의 이전 라운드 결과가 섞여 읽힌다
- Ruling: headline·todo는 summary.json을 먼저, 없으면 results.json 맨 위의 같은 칸을 쓴다 — 실제 results.json에도 headline·todo가 있다(지시는 headline만 언급) — 틀리면 summary.json 없는 판의 할 일이 안 나온다
- Ruling: 판 하나의 끝 줄은 `<topic> — <완료|멈춘 채 남음(status X)>[ · 결정 N건][ · <headline | 확인 필요: 첫 항목>] — <목적 첫 줄>`이고 실패 묶음 줄은 `실패: <title> — <summary|decision>`, `의심: …`, `확인 필요: …`, `남은 할 일: …`이다. `확인함`으로 시작하는 확인 필요 항목은 이미 풀린 것이라 뺀다 — 지시가 형식을 정하지 않은 부분 — 틀리면 pact가 줄 머리 낱말로 가르려 할 때 어긋난다
- Ruling: "깊이 4"는 root의 자식이 깊이 1일 때 `.pact`·`docs/pact` 폴더가 깊이 4 이내(점 폴더·`.git`·`node_modules`는 들어가지 않음) — `find -maxdepth 4`와 같은 느낌으로 저장소가 root 아래 3단계까지 — 틀리면 더 깊은 저장소 기록을 놓친다
- Ruling: 제외 글(`/wt/` 등)은 RECALL_ROOTS 기준 상대 경로에 대해 검사한다 — 시험 폴더나 root 자신이 `/tmp/`·`/scratch/` 아래에 있어도 전부 사라지지 않게 — 틀리면 root 위쪽 경로에 `wt`가 있는 사용자는 영향이 없다(상대 경로만 보므로 오히려 안전)
- Ruling: 모든 RECALL_ROOTS를 읽지 못할 때만 pact 출처가 던진다(머리줄 `못 읽음`). 일부 root나 하위 폴더, 깨진 summary/results.json은 조용히 건너뛴다. 메모리 폴더가 없는 프로젝트는 오류가 아니라 빈 결과다 — 대부분의 프로젝트에 메모리가 없어 머리줄이 늘 못 읽음으로 차면 안 됨 — 틀리면 root 하나가 오타여도 알리지 않는다
- Ruling: 주제 낱말이 없으면 머리줄 주제를 `(주제 없음)`으로 쓰고 네 묶음은 비어 나온다(종료 0) — 지시에 없는 경우 — 틀리면 사용법 안내를 기대한 쪽이 빈 출력을 본다

## 걱정·위험
- 한 판의 항목은 모두 그 판의 점수를 물려받는다. 실제 실행에서 다른 저장소 한 판(unified-login 화면 정리)의 "의심" 줄 5개가 실패 묶음 7줄 중 5줄을 채웠다. 판당 상한(예: 묶음마다 3줄)은 지시에 없어 넣지 않았다. pact 쪽이 첫 메시지에 쓸 때 걸러야 한다면 작업 4에서 정해야 한다.
- 주제 낱말이 한 개면 다른 저장소 기록은 겹침이 최대 1이라 전부 `비슷한 기록`이 된다. 지시 그대로지만 한 낱말 주제가 많으면 표시가 변별력이 없다.
- 겹침은 부분 문자열 일치다(`pact`가 `impact`에도 맞음, 조사 붙은 `선택지를`에는 맞음). 형태소 처리는 하지 않았다.
- 현재 실행 중인 판 자신(`기억으로 명세 채우기`, status building)도 같은 주제로 잡혀 "예전 시도"에 나온다. pact가 이 결과를 쓸 때 자기 판을 어떻게 다룰지는 작업 4의 몫이다.
- 작업 2가 honcho 모듈을 `scripts/recall.mjs`의 `SOURCES` 배열에 넣고, `whereOf`에 `사용자 말`·`AI 보고` 이름을 더해야 한다(지금은 알 수 없는 source면 `item.source` 글자를 그대로 쓴다).
- 테스트는 임시 폴더 fixture만 쓴다. 실제 `~/dev`와의 일치는 위 CLI 한 번으로만 확인했다.

---

# 덧붙임 — 검토 뒤 고침 (커밋 아래 해시는 `git log`로 확인)

## 고친 것
- 겹침 판정(pact-records.mjs): 목적 첫 줄·기능 줄·topic에서 백틱 조각(`` `…` ``)을 지운 뒤 맞춘다. 영문·숫자로 시작하거나 끝나는 낱말은 그쪽에 앞뒤 낱말 경계(영숫자가 이어 붙지 않음)를 둔다 — `impact`는 `pact`에 안 맞고 `pact를`·`Pact`는 맞는다. 한글은 부분 일치 그대로. `cua-bar`처럼 하이픈이 든 낱말은 `cua-bar2`에 안 맞는다(영숫자 끝이라 경계 적용).
- 설명 주석 제거: recall.mjs 머리 블록(2–12행)과 42·46·84행, pact-records.mjs 1–3·10·12·39·65·103·151행, memory-files.mjs 1–2·14행, 두 테스트 파일의 주석 한 줄씩(pact-records.test 126행, memory-files.test 23행). 남긴 것은 recall.mjs의 심볼릭 링크 비교 주석과 memory-files.mjs의 영숫자 아닌 글자 → `-` 주석 둘. pact-records.mjs 134행은 빈 `catch {}`로.
- 사소: 이미 `isFile`로 확인한 명세를 다시 try/catch로 읽던 곳을 뺐다(읽을 수 없는 파일이면 출처가 던져 `못 읽음`이 된다). `recall.mjs`의 `[...items]` 복사를 뺐다(출처가 `items`를 안 주면 run이 던진다 — 출처의 버그로 본다). 깨진 JSON으로 "읽지 않는다"를 시험하던 테스트는 주장을 "아무것도 내지 않는다"로 줄이고, 새어 나오면 실패 묶음에 보이도록 유효한 fail 시나리오를 둔 results.json으로 바꿨다.

## 확인
- 먼저 새 테스트 두 개(백틱 안 낱말, 영문 경계/한글 부분 일치)를 추가해 fail 2를 확인한 뒤 구현했다.
- `node --test plugins/recall/tests/` → tests 33, pass 33, fail 0, 종료 0.
- 변이 확인: 백틱 지우기 끄기, 왼쪽 경계 끄기, 오른쪽 경계 끄기 → 각각 fail 1.
- `recall.mjs pact 선택지 질문 --project /Users/chenjing/dev/chenjing-plugins` → 종료 0, 105ms. unified-login `화면 정리` 판이 사라져 실패 묶음이 7줄에서 2줄(chenjing-plugins의 남은 할 일 둘)이 됐고, "비슷한 기록" 줄은 더 이상 나오지 않는다. 예전 시도 5줄(chenjing-plugins 판 3 + 메모리 2), 아이디어 8줄, 규칙 5줄.

## 걱정·위험
- memory-files.mjs는 아직 단순 부분 문자열 일치다(백틱 지우기·영문 경계 없음). 지시가 pact-records만 짚었고 모듈 사이에 공용 파일을 새로 둘 수 없어 같은 규칙을 옮기지 않았다. 메모리 본문 전체를 haystack으로 쓰므로 `impact`류 오탐이 생길 수 있다.
- 백틱을 지우면 기능 줄에 `` `recall` ``처럼 이름을 백틱으로 감싼 주제는 그 이름으로 못 찾는다(지시에 따른 결과).
