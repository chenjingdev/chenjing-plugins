# Phase 6: Contradiction Detection - Context

**Gathered:** 2026-04-08
**Status:** Ready for planning

<domain>
## Phase Boundary

인터뷰 전체에서 역할/기여도 모순이 탐지되어 축소된 역할이 복원되며, 유저 신뢰가 유지된다. profiler.md에 claim 추적 + NLI 스타일 모순 탐지 섹션을 추가하고, SKILL.md에 contradiction_detected 핸들러와 STAR 필드 업데이트 로직을 추가한다.

</domain>

<decisions>
## Implementation Decisions

### Claim Extraction & Comparison
- profiler.md 자율 오케스트레이션에 claim 추적 섹션 추가 — 프로파일러 사이클마다 역할/기여도 claim을 구조화 추출
- 4개 카테고리: role_scope, time, scale, contribution — 같은 카테고리 내에서만 pairwise 비교 (N^2 방지)
- NLI-스타일 프롬프트로 pairwise claim 비교 — Claude 내장 NLI 능력 활용, 외부 API/모델 금지 (CLAUDE.md)
- role_scope 모순 → HIGH urgency (즉시), time/scale/contribution 모순 → MEDIUM urgency (Conversation Briefing)

### Contradiction Presentation & Resolution
- 연결 톤 — "아까 이야기랑 연결해보면..." 형태, 비난/지적 톤 금지 (CLAUDE.md)
- "likely cause: 겸손에 의한 축소" 태그 — role_scope 모순은 기본적으로 과소보고로 추정 (한국 문화 특성)
- AskUserQuestion으로 "실제로 어디까지 했어?" 형태 복원 질문 → 유저 응답에 따라 STAR 필드 업데이트
- 세션당 최대 2개 모순 제시 — 과도한 모순 지적은 신뢰 손상, 역효과

### Integration Architecture
- profiler.md에 claim 추적 + 모순 탐지 섹션 추가 + SKILL.md에 contradiction_detected 핸들러 추가 (2개 파일)
- type: contradiction_detected, context에 claim_a, claim_b, contradiction_type, likely_cause, restoration_question 포함
- SKILL.md 오케스트레이터가 직접 AskUserQuestion으로 변환하여 유저에게 제시 — 별도 에이전트 호출 불필요
- 유저 응답 기반으로 오케스트레이터가 resume-source.json 해당 에피소드 STAR 필드 직접 업데이트

### Claude's Discretion
- profiler.md claim 추출 프롬프트의 구체적 구조와 출력 형식
- NLI comparison 프롬프트의 세부 판단 기준
- contradiction_detected finding의 JSON 스키마 세부사항
- STAR 필드 업데이트 시 어떤 필드를 수정할지 (action, result, situation 등)

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- profiler.md: 자율 오케스트레이션 + 패턴 분석 + 관점 전환 탐지 + findings-inbox.jsonl 기록
- SKILL.md: 8개 메시지 핸들러 (SO-WHAT, findings, gap probing, pattern routing, perspective shift) + AskUserQuestion 변환 시스템
- findings-inbox.jsonl → hook 처리 → SKILL.md 라우팅 파이프라인
- meta.json 상태 추적 패턴 (session counters, analysis flags)

### Established Patterns
- profiler 분석 → finding 생성 → Conversation Briefing 삽입 (MEDIUM) 또는 즉시 전달 (HIGH)
- SKILL.md 핸들러에서 AskUserQuestion으로 유저에게 직접 질문
- 유저 응답 처리 후 resume-source.json 업데이트

### Integration Points
- profiler.md에 claim 추적 + 모순 탐지 섹션 추가
- SKILL.md에 contradiction_detected 핸들링 규칙 추가 (item 9)

</code_context>

<specifics>
## Specific Ideas

- CLAUDE.md: "raw conversation text 비교 금지 — 먼저 구조화된 claim을 추출해야 함" 명시
- CLAUDE.md: claim 추출 전에 비교하면 ~17% false positive (연구 인용)
- CLAUDE.md: "accusatory framing 금지 — curious framing 사용" 명시
- 컨텍스트(회사/프로젝트/기간) 기반 스코핑으로 false positive 최소화

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>
