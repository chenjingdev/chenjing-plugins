# Phase 1: AskUserQuestion UX - Context

**Gathered:** 2026-04-07
**Status:** Ready for planning

<domain>
## Phase Boundary

텍스트 번호 선택 방식을 AskUserQuestion 셀렉트 박스 UI로 교체한다. 에이전트 출력 포맷은 변경하지 않고, 오케스트레이터(SKILL.md)가 에이전트의 번호 텍스트를 파싱하여 AskUserQuestion을 호출한다. 라운드 0(세팅)도 포함하여 모든 질문을 변환한다.

</domain>

<decisions>
## Implementation Decisions

### Conversion Architecture
- 에이전트 출력 포맷 변경 없음 — 기존대로 "1) 뭐뭐 2) 뭐뭐" 텍스트 출력, 오케스트레이터가 파싱
- 변환 로직은 SKILL.md 오케스트레이터 프롬프트에 기술 (프롬프트 엔지니어링만, 별도 스크립트 없음)
- 에이전트별 프롬프트 수정 최소화 — "선택지 필수" 룰 유지, 렌더링만 변경
- 라운드 0(세팅)도 AskUserQuestion으로 통일

### 직접입력 UX
- AskUserQuestion이 자동 추가하는 "Other" 옵션을 직접입력으로 활용
- Other 선택 시 유저의 자유 텍스트를 그대로 에이전트에 전달
- 한 턴에 질문 수는 에이전트 재량 (AskUserQuestion은 1-4개 질문 가능)
- 선택지 수 상한: 에이전트 재량으로 최대 4개 + 자동 Other = 5개

### Fallback & Edge Cases
- AskUserQuestion 실패 시 에러 표시 후 재시도, 2차 실패 시 텍스트 번호 방식 폴백
- 에이전트가 선택지 없이 서술형 질문 던질 때 셀렉트 박스 없이 평문 전달
- 프로파일러 findings 긴급 삽입 시에도 AskUserQuestion으로 감싸기

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `plugins/resume/skills/resume-panel/SKILL.md` — 오케스트레이터, 에이전트 호출 및 유저 응답 처리 로직
- `plugins/resume/.claude/agents/senior.md`, `c-level.md`, `recruiter.md`, `hr.md`, `coffee-chat.md` — 프론트스테이지 에이전트 프롬프트
- `plugins/resume/scripts/episode-watcher.mjs` — 자율 백엔드 훅

### Established Patterns
- 에이전트가 "1) 뭐뭐 2) 뭐뭐 3) 직접입력" 형태로 출력
- 오케스트레이터가 에이전트 리턴을 유저에게 그대로 전달 (`[에이전트명]` 태그 포함)
- 유저가 번호 입력하면 해당 선택지 처리, 그 외 텍스트는 자유 답변
- SKILL.md에서 "선택지 필수" 원칙으로 2-3개 선택지 + 직접입력 강제

### Integration Points
- SKILL.md의 "에이전트 호출 방법" 섹션과 "유저 응답 처리" 섹션 — 핵심 수정 대상
- SKILL.md의 "핵심 원칙 #2 선택지 필수" — 옵션 수 상한 업데이트
- 각 라운드 진행 섹션의 질문 예시 — AskUserQuestion 형식으로 업데이트
- AskUserQuestion은 오케스트레이터(skill) 레벨에서만 호출 가능 (bug #29547 — 서브에이전트에서 호출 불가)

</code_context>

<specifics>
## Specific Ideas

- AskUserQuestion의 "Other" 옵션이 "직접입력" 역할을 대체
- 라운드 0의 기존 예시("1) 이어하기 2) 새로 시작")도 AskUserQuestion으로 변환
- findings-inbox.jsonl에서 온 긴급 findings도 AskUserQuestion으로 감싸서 표시

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>
