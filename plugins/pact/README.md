# pact

RFP를 받은 수행사처럼 일하는 바이브 코딩 플러그인. 사용자는 발주처, AI는 수행사다. 무엇을 만들지는 함께 정해 짧은 명세로 계약하고(probe), 어떻게 만들지는 AI가 정해서 이행하고(build), 다 만든 것을 AI가 직접 써 보며 모든 시나리오를 스크린샷으로 남겨 검수한다(verify).

수정 기준은 하나다. 명세의 모든 항목에 누가 정했는지 태그가 붙는다. 사용자가 말한 `[사용자]` 항목은 바꾸기 전에 묻고, AI가 채운 `[AI 가정]` 항목은 알아서 바꾸고 기록한다. 데이터 삭제, 외부 공개, 비용처럼 되돌리기 어려운 일은 누가 정했든 묻는다.

## 설치

```
/plugin install pact --marketplace chenjingdev/chenjing-plugins
```

명세 검사, 기능 체크리스트 페이지, 검수 보고서 같은 도우미 스크립트를 node로 돌린다. node 18 이상이 깔려 있어야 한다.

## 켜는 법

따로 외울 명령이 없다. "○○ 만들어 줘", "이거 고쳐 줘"처럼 말하면 켜진다. 직접 부르려면 `/pact:pact`.

켜지면 먼저 크기를 가늠한다. 필요한 것이 다 들어 있는 일은 바로 하고, 작은 변경은 가벼운 길(직접 고치고 확인 하나, 결과는 채팅)로 처리한다. 프로젝트급만 아래 흐름을 탄다.

```
"…만들어 줘 / 고쳐 줘" 또는 /pact:pact
 ├─ 0. 크기 가늠 ─ 작은 일 → 가벼운 길 (직접 고침 + 확인 하나)
 ├─ probe
 │   1. 넓게 펼치기   기능 지도(갈래 5~8개)를 먼저 펼치고, 어디부터 볼지 하나만 묻는다
 │   2. 타고 내려가기  고른 갈래부터 넓혔다가, 진짜 갈림길만 걸러 낸 안 + 추천으로 묻는다
 │                  (들러리 안은 빼고, 하나만 남으면 정해서 알림)
 │   3. 좁히기       지도 전체를 갈래별 체크리스트 한 장으로 (AI 제안은 체크 해제 + 이유)
 │   4. 구조 고르기   화면이 있으면 스케치 2~3장 → 판정 하나, 최대 2라운드
 │                  ("알아서"로 맡기면 3·4는 AI가 정하고 채팅에 알림)
 │   5. 명세 작성
 │   6. 명세 검수    다른 에이전트가 빌더 입장 + 요구 대조 → 사용자 몫만 한 번에 질문
 │   ── 사용자 승인 (유일한 승인) ──
 ├─ build    worker 구현 → reviewer 대조, 결정은 Ruling으로 기록
 └─ verify   시나리오 → 브라우저 실행 + 스크린샷 → 보고서. 실패하면 build로 되돌림
            고친 뒤엔 실패·의심·미검증과 고친 파일이 닿는 시나리오만 다시 검수
            완료 검사 통과 → 로컬 커밋·합치기 → 보고서로 알림 (push만 물음)
```

중간에 멈춰도 명세의 `status`(draft → approved → building → verifying → done)를 보고 이어 한다.

## 남는 것

| 위치 | 내용 |
|---|---|
| `docs/pact/<날짜>-<주제>.md` | 명세. 한 화면 분량, 항목마다 `[사용자]`/`[AI 가정]`, 결정 기록 |
| `.pact/<날짜>-<주제>/report.html` | 검수 보고서. 맨 위에 결론과 할 일, 그다음 실패·의심·미검증과 명세와 다른 것. 통과·작업 기록·결정 기록은 접힘 |
| `.pact/<날짜>-<주제>/` | 실행 폴더. 명세 파일명(날짜 포함)으로 구분한다. 체크리스트, 스케치, 작업 보고, 검수 기록(`verification.json`)이 들어가고 스스로 git에서 빠진다 |
| `.pact/<날짜>-<주제>/log/subagents.jsonl` | 하위 에이전트가 끝날 때마다 훅이 마지막 답을 한 줄씩 덧붙인 기록 |

화면 검수에는 Codex CUA를 쓴다. 브라우저에서 결과물을 직접 써 보고 단계마다 스크린샷(JPEG)을 남긴다. 도구 이름은 호스트마다 달라 pact가 찾아 쓴다. 메인 세션이 검수 전에 한 번 확인해서, 쓸 수 없으면 오류를 바로 알리고 명령과 HTTP 요청으로 볼 수 있는 것만 확인한다. 화면으로만 볼 수 있는 단계는 `미검증`으로 남고, 미검증이 있으면 완료가 되지 않는다.

## 완료 검사

검수를 시작할 때 명세와 코드의 내용을 `.pact/<run-id>/verification.json`에 기록하고(`snapshot`), 결과 전체와 시나리오마다 그때의 `verification_id`를 적는다. 완료 전에 기능·케이스·처음 쓰는 사람 시나리오가 다 있는지, 단계마다 증거(스크린샷 또는 명령 출력과 종료 코드)가 있는지, 검수한 코드가 그대로 합쳐졌는지 본다. 스크린샷이 없거나 빈 파일이거나 실행 폴더 밖이면 그 시나리오는 미검증이다.

```
node <pact>/scripts/verification.mjs snapshot <명세> <worktree> <ui|command>   # 검수 시작 때
node <pact>/scripts/report.mjs <run-dir>                                         # 보고서 + 완료 검사 결과
node <pact>/scripts/verification.mjs finish <명세> <프로젝트>                     # 합친 뒤, 원래 프로젝트 폴더에서
```

`finish`가 통과할 때만 명세가 `done`이 된다. `spec.mjs set-status done`은 막혀 있다. 이 검사는 기록이 빠졌는지만 본다. 실제로 써 봤는지는 verifier의 일이다.

고친 뒤에는 `snapshot`을 다시 만든다. 새 ID가 나오고 출력의 `changed_files`에 고친 파일이 든다. 실패·의심·미검증이었던 시나리오와 고친 파일이 닿는 시나리오만 다시 돌리고, 나머지는 앞 판의 결과를 그대로 둔다. 완료 검사는 같은 검수의 앞 판 ID를 인정한다.

예전 방식의 `.pact/<주제>/` 폴더는 건드리지 않는다. 그 안에 `wt`가 남아 있으면 `run-dir`이 멈추고 사람이 정리한다.

## 훅

`hooks/hooks.json`이 PreToolUse와 SubagentStop에 훅 하나(`hooks/guard.mjs`)를 건다. 플러그인 훅은 pact를 쓰지 않는 대화에서도 도는 터라, `.pact/`·`docs/pact/`를 만지지도 않고 pact 에이전트나 스크립트도 아닌 호출은 아무것도 읽지 않고 바로 통과시킨다.

- PreToolUse: 지금은 아무것도 막지 않는다.
- SubagentStop: `pact:spec-checker`·`pact:reviewer`·`pact:worker`·`pact:verifier`가 끝나면 마지막 답을 그 판의 `<run-dir>/log/subagents.jsonl`에 한 줄 덧붙인다. 실행 폴더는 하위 에이전트의 첫 지시에 든 경로로 찾고, 없으면 그 프로젝트에서 가장 최근에 바뀐 진행 중 명세로 찾는다. `pact:verifier`가 끝날 때는 그 순간의 `results.json` sha256도 같은 줄에 적는다.
- 훅이 고장나도 대화를 막지 않는다. 오류는 플러그인 데이터 폴더(`${CLAUDE_PLUGIN_DATA}`, 없으면 `~/.claude/plugins/data/pact-chenjing-plugins`)의 `hook-error.log`에 한 줄 남는다.

## 시험

```
cd plugins/pact
node --test tests/                          # 스크립트와 지침 파일 정적 검사
node tests/behavior/run.mjs all --runs 5    # 실패 장면 행동 시험 (pact vs 대조군)
node tests/behavior/board.mjs               # 결과판만 다시 만들기 → tests/behavior/out/board.html
```

행동 시험은 깨끗한 프로필(`PACT_TEST_PROFILE`, 기본 `~/.bench/_claude`)에서 `claude -p`로 돌린다. 처음이면 `CLAUDE_CONFIG_DIR=~/.bench/_claude claude`로 한 번 `/login` 한다. 결과 transcript는 `tests/behavior/out/`에 남고, 돌릴 때마다 판정 결과가 판(`out/runs/`)으로 쌓인다. 시험이 끝나면(사용 한도로 끝나도) `out/board.html` 결과판이 새로 만들어지고 stderr에 `결과판: <경로>`가 나온다. 서버 없이 브라우저로 파일을 열면 된다: 장면·검사별 통과율 표, 칸을 누르면 실패한 회차의 대화.

실행 캐시는 시나리오, fixture 파일, 요청한 모델, CLI 실행 파일과 설정, runner 코드를 묶은 fingerprint로 구분한다. 판정 기준(`checks`)만 바뀌면 같은 실행을 다시 판정만 한다. 실행 조건을 알 수 없는 옛 transcript는 결과판에 남지만 새 캐시로는 쓰지 않는다.

설계와 근거는 `docs/superpowers/specs/2026-10-10-pact-design.md`에 있다.
