# Phase 3: So What Chain - Context

**Gathered:** 2026-04-07
**Status:** Ready for planning

<domain>
## Phase Boundary

에피소드 저장 시 비즈니스 임팩트가 부족하면 자동으로 So What 체인이 트리거되어 최대 3단계(직접 결과 → 팀/조직 영향 → 비즈니스 지표) 심화 질문을 통해 에피소드 result 필드 품질을 높인다. episode-watcher.mjs에서 즉시 감지하고, C-Level 에이전트가 심화 질문을 담당한다.

</domain>

<decisions>
## Implementation Decisions

### Trigger Mechanism & Detection
- episode-watcher.mjs에서 에피소드 저장 시 result 필드를 즉시 검사하여 임팩트 부족 감지
- 임팩트 부족 판단: 정규식으로 수치+단위 패턴 (%, 원, 명, 건, 배, 시간 등) 검사 — 없으면 부족
- 수치 패턴이 이미 있는 에피소드는 자동 스킵 (결정론적 체크, LLM 불필요)
- additionalContext 메시지로 `[resume-panel:SO-WHAT] 에피소드 "{title}" 임팩트 부족` 전송 — 기존 hook→오케스트레이터 파이프라인 활용

### Chain Flow & UX
- C-Level 에이전트가 심화 질문 담당 (비즈니스 임팩트 전문, CLAUDE.md에서 지정)
- 3단계 구조: Level 1 "직접적으로 뭐가 바뀌었어?" → Level 2 "팀/조직에 어떤 영향?" → Level 3 "비즈니스 지표로는?"
- 매 레벨마다 "거기까지였음" 선택지를 포함하여 유저가 언제든 체인 탈출 가능
- 에피소드 저장 직후 즉시 트리거 — 현재 질문-답변 사이클 완료 후 끼워넣기 (HIGH 우선순위와 동일 패턴)

### Result Storage & Data Structure
- 심화된 결과를 해당 에피소드의 result 필드에 직접 업데이트 — 별도 필드/스키마 변경 없음
- .resume-panel/meta.json에 `so_what_active` 플래그 + 대상 에피소드 정보 저장 — 체인 진행 중 추가 트리거 방지
- 중간 탈출 시 (거기까지였음) 현재 레벨까지의 답변을 result에 반영 — 부분 결과도 가치 있음

### Claude's Discretion
- C-Level 에이전트 프롬프트에 So What 체인 모드 섹션 추가 방식
- 각 레벨별 구체적 선택지 텍스트 구성
- so_what_active 플래그의 JSON 구조 세부사항

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `plugins/resume/scripts/episode-watcher.mjs` — 이벤트 가중치 시스템이 이미 구현됨, So What 감지 로직 추가 위치
- `plugins/resume/.claude/agents/c-level.md` — 비즈니스 임팩트/스케일 질문 패턴 보유, So What 체인 모드 추가 대상
- `plugins/resume/skills/resume-panel/SKILL.md` — 오케스트레이터, [resume-panel:SO-WHAT] 메시지 처리 규칙 추가 대상
- `.resume-panel/meta.json` — profiler_score 이미 저장, so_what_active 플래그 추가 위치

### Established Patterns
- PostToolUse hook → additionalContext 메시지 → 오케스트레이터 처리 (프로파일러 호출과 동일 패턴)
- [resume-panel:HIGH/MEDIUM] 우선순위 메시지 라우팅 체계
- AskUserQuestion 셀렉트 박스 변환 (Phase 1에서 확립)
- 에이전트 리턴 → 오케스트레이터 파싱 → AskUserQuestion 호출 파이프라인

### Integration Points
- episode-watcher.mjs의 `isResumeSourceChange` 블록 — 가중치 계산 이후에 So What 감지 로직 추가
- SKILL.md의 "자율 오케스트레이션 — Hook 메시지 처리" 섹션 — [resume-panel:SO-WHAT] 처리 규칙 추가
- c-level.md — So What 체인 모드 질문 생성 섹션 추가
- meta.json — so_what_active 상태 관리

</code_context>

<specifics>
## Specific Ideas

- episode-watcher에서 `countStarGaps()`는 STAR 필드 존재 여부만 체크하므로, result 필드 "내용의 질"을 별도로 검사하는 `hasQuantifiedImpact()` 함수 필요
- C-Level에게 So What 체인 모드로 호출할 때 현재 레벨 정보와 이전 레벨 답변을 컨텍스트로 전달
- SKILL.md에서 So What 체인 진행 시 일반 인터뷰 플로우를 일시 중단하고, 체인 완료 후 복귀

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>
