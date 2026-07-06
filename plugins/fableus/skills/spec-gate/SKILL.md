---
name: spec-gate
description: "spec 문서를 실행 모델이 콜드 리드해 '스스로 정할 수 없는 것(blocking)'을 실측하는 게이트. blocking 0건까지 인터뷰 환류. 사용: /spec-gate <spec.md 경로> [--reader <model>]"
---

# /spec-gate — 콜드 리드 실측 게이트

문서 품질을 작성자의 자가 점검이 아니라 **실행자의 콜드 리드**로 판정한다.
게이트 자체는 읽기 전용이다: spec.md 본문은 절대 수정하지 않는다 (G-5).

## 절차

### 0. 입력 검증
- 인자에서 spec 경로와 `--reader <model>`(기본 `opus`)을 파싱한다.
- env `CLAUDE_CODE_SUBAGENT_MODEL`이 설정돼 있으면 경고한다 — 이 env는
  per-call model 지정을 덮어써서 `--reader`를 무력화한다 (모델 우선순위:
  env > per-call > frontmatter > 세션).
- 파일이 없거나 비어 있으면: 실행을 거부하고 이유를 보고한다. 여기서 종료.
- 파일이 30,000단어를 넘으면: 거부하고 문서 축소를 권고한다. 여기서 종료.
- spec과 같은 디렉터리의 `gate-report.md`를 읽어 현재 라운드 번호를 정한다
  (없으면 Round 1). 직전 라운드가 Round 3이었고 blocking이 남아 있으면:
  "3라운드 상한 도달 — waive(스펙에 재량 위임 명시) 또는 보강 후 재시작"을
  안내하고 종료 (G-8).

### 1. 콜드 리드 (완전 격리, G-2)
- `references/reader-prompt.md`를 읽어 `{{SPEC_BODY}}`를 spec 본문 전체로
  치환한다.
- Agent tool로 `fableus:cold-reader` 타입 서브에이전트를 스폰한다:
  model = --reader 값, 프롬프트 = 치환된 리더 프롬프트 전문.
  파일 경로를 넘기지 말 것 — 본문을 프롬프트에 직접 포함한다(격리 보장).
- 라운드가 5분 이상 걸릴 수 있다. 백그라운드로 돌리고 완료 알림을 기다린다.
- 스폰 실패 시: 실패 사실만 보고하고 부분 결과를 기록하지 않는다. 종료.

### 2. 리포트 기록 (게이트의 유일한 쓰기)
- 리더 출력을 파싱해 `references/gate-report-template.md` 형식으로
  `gate-report.md`에 라운드 블록을 **추가**한다(기존 라운드 보존).
- 이슈 ID는 `R{라운드}-{순번}`.

### 3. 판정과 환류
- **blocking 0건** → 판정 `passed`. 사용자에게 보고하고, spec frontmatter의
  `**Gate**:` 라인을 `passed`(waive가 있으면 `passed-with-waivers`)로
  갱신한다. 이 갱신은 게이트가 아니라 작성 세션(현재 세션)의 쓰기다 (G-5).
- **blocking N건** → frontmatter를 `round-N-blocked`로 갱신하고, 각 blocking
  이슈를 AskUserQuestion으로 환류한다:
  - 질문 = 이슈의 "무엇이 모호한가", 선택지 = 리더의 제안 A/B/C
    (라벨에 "실행자 추측" 명시) + 자동 제공되는 직접 입력.
  - 사용자가 "구현자 재량으로 남긴다"고 답하면: spec의
    `## Deferred to Implementer` 섹션에 항목+사유를 추가한다 (G-7 — waive는
    spec 본문에 명시하는 행위다. 그래야 다음 라운드 콜드 리더가 재제기하지
    않는다).
  - 그 외 답변: 해당 내용을 spec 본문(관련 섹션)에 반영한다. 반영은 작성
    세션의 편집이며, 사용자 답변을 근거로만 한다 — 리더의 추측을 무단
    채택하지 않는다 (G-6).
- 반영이 끝나면 재실행을 제안한다(다음 라운드).

## 하지 말 것
- 게이트 판정을 건너뛰고 "대충 통과"를 선언하는 것 — blocking 판정은
  리더 출력이 정본이다.
- discretionary 이슈를 해소하려고 spec을 부풀리는 것 — 정보성 표시로 둔다
  (G-4). "값"은 구현자 몫이다.
- 리더에게 파일 경로·저장소 접근을 주는 것 (G-2).
