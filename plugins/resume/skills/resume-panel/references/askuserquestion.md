# AskUserQuestion — JSON 변환, 폴백

## 변환 절차

에이전트 응답 = JSON 문자열 (`agent-contract.md §2` 참조). 오케스트레이터는:

1. **파싱**: `JSON.parse(response)`
2. **에러 응답 처리**: `{ "error": "cannot_generate", ... }` 인 경우 오케스트레이터가 컨텍스트 보강 후 에이전트 재호출. 유저에게 전달 안 함.
3. **`questions` 배열 순회**:
   - 각 원소가 `free_form: true`면 → AskUserQuestion 생략, `question` 필드를 평문으로 출력.
   - `free_form: false`면 → AskUserQuestion question 배열에 그대로 변환.
4. **AskUserQuestion 호출 파라미터**:
   - `questions`: `free_form: false` 원소들의 `{ question, header, options, multiSelect: false }` 배열 (최대 3개)
5. **답변 처리**:
   - 유저가 선택지 클릭 → 해당 옵션의 `description` 텍스트를 에이전트 답변으로 사용
   - 유저가 "Other" 선택 + 자유 입력 → 입력 텍스트를 에이전트 답변으로 사용
   - `free_form: true` 평문 응답 → 유저 입력 전체를 답변으로 사용

## multiSelect

항상 `false`. 인터뷰 질문은 단일 선택.

## allowed-tools 금지

**AskUserQuestion을 SKILL.md frontmatter의 `allowed-tools`에 절대 추가하지 않는다** (bug #29547 — 빈 응답 자동 완성).

## 폴백

AskUserQuestion 호출이 실패하는 경우 (빈 응답, 에러, 타임아웃, **유저가 reject/dismiss/취소**):

1. **reject 감지**: "취소", "아니 다시", "잘못 눌렀어", "다시 띄워줘" 또는 빈 문자열/null/"interrupted" 응답 → reject로 간주
2. 즉시 "셀렉트 박스 로딩에 문제가 생겼어요. 다시 시도할게요." 메시지 표시
3. 동일 파라미터로 1회 자동 재시도
4. 재시도도 실패하면 텍스트 모드 폴백:
   - "텍스트로 답변해주세요." 메시지
   - 원래 JSON의 `questions[i].question` 및 `options[j].description`을 번호 리스트로 렌더:
     ```
     [{header}] {question}
       1) {option 1 description}
       2) {option 2 description}
       3) {option 3 description}
     번호를 입력하거나 자유롭게 답변해주세요.
     ```
   - 유저가 번호 입력 → 해당 옵션 선택
   - 자유 텍스트 → `free_form` 답변으로 처리

**재시도 상한**: 자동 재시도는 1회. 2번 연속 실패하면 텍스트 폴백. 3회 이상 반복 호출하지 않는다 (무한 재시도 방지).

## JSON 파싱 실패 시

에이전트 응답이 유효 JSON이 아니면 (Phase 2 초기 드문 케이스):

1. 오케스트레이터는 "JSON 응답 포맷이 아니야. 다시 생성해줘" 메시지와 함께 에이전트 재호출 (1회)
2. 재호출도 실패하면 해당 에이전트 응답을 평문으로 유저에게 표시 (레거시 우회). 회고에 `json_parse_failure` 이벤트 기록.
