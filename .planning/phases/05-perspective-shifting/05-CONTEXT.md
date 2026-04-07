# Phase 5: Perspective Shifting - Context

**Gathered:** 2026-04-08
**Status:** Ready for planning

<domain>
## Phase Boundary

리더십/협업 에피소드에서 타인 시점 질문이 전략적으로 생성되어 유저가 축소했던 기여를 재발견한다. profiler.md에 관점 전환 탐지 섹션을 추가하고, HR.md와 C-Level.md에 관점 전환 모드를 추가하며, SKILL.md에 perspective_shift 라우팅 규칙을 추가한다.

</domain>

<decisions>
## Implementation Decisions

### Trigger & Selection Strategy
- 프로파일러 finding 기반 트리거 — profiler가 과소평가 에피소드 플래그하면 findings-inbox를 통해 에이전트에 라우팅 (Phase 4 패턴 동일)
- profiler의 기존 패턴 분석이 STAR result가 회사 규모 대비 약한 에피소드를 탐지하여 관점 전환 대상으로 지정
- 리더십/협업 타입 에피소드만 대상 + profiler가 과소평가 감지한 에피소드 (모든 에피소드 대상 아님)
- 세션당 관점 전환 질문 최대 2개 — 관점 질문은 집중도가 높으므로 피로 방지

### Perspective Assignment & Question Quality
- CLAUDE.md 매핑 테이블 적용: 리더십→주니어(HR), 협업→PM(HR/시니어), 문제해결→상사(C-Level), 성과→고객(C-Level)
- 구체적 장면 묘사 필수 — "팀 회식 자리에서 상사가 이 프로젝트 성과를 어떻게 설명할까?" 형태, 추상적 질문 금지
- profiler.md에서 perspective_shift finding 생성 → SKILL.md에서 해당 에이전트에 perspective context와 함께 라우팅 (Phase 4 findings 파이프라인 재활용)
- 호기심 + 인정 톤 — "주니어 입장에서 보면, 네가 한 게 더 대단해 보일 수 있거든" — 유저의 자기 축소 필터 우회

### Integration Architecture
- profiler.md에 관점 전환 분석 섹션 추가 — 과소평가 신호 탐지 시 perspective_shift finding 생성
- type: perspective_shift, urgency: MEDIUM — Conversation Briefing 통해 자연스럽게 전달
- HR.md + C-Level.md에 관점 전환 모드 섹션 추가 + profiler.md에 탐지 섹션 + SKILL.md에 라우팅 규칙 — no new agents
- Finding context에 target_perspective, target_agent, episode_ref, scene_hint 포함 → SKILL.md가 해당 agent에 라우팅

### Claude's Discretion
- profiler.md 과소평가 탐지 프롬프트의 구체적 판단 기준과 출력 형식
- HR.md / C-Level.md 관점 전환 모드의 질문 생성 프롬프트 세부 구조
- scene_hint 생성 방식 (에피소드 STAR 데이터 기반 자동 추론)
- perspective_shift finding의 JSON 스키마 세부사항

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- profiler.md: 자율 오케스트레이션 모드 + findings-inbox.jsonl 기록 + 패턴 분석 프레임워크 (Phase 4에서 추가)
- SKILL.md: timeline_gap_found + pattern_detected 핸들러 + Conversation Briefing 시스템 + 갭 프로빙 오케스트레이션 (Phase 3, 4에서 추가)
- HR.md: 갭 프로빙 모드 (Phase 4에서 추가) — 관점 전환 모드도 유사 패턴
- C-Level.md: So What 체인 모드 (Phase 3에서 추가) — 관점 전환 모드도 유사 패턴
- episode-watcher.mjs: scoring + profiler trigger + findings 라우팅 시스템

### Established Patterns
- findings-inbox.jsonl → hook 처리 → SKILL.md 오케스트레이터 라우팅 → 에이전트 호출
- profiler 자율 분석 → finding 생성 → Conversation Briefing 삽입
- 에이전트 모드 섹션 (갭 프로빙, So What) → 오케스트레이터가 모드 context와 함께 호출
- meta.json에 상태 추적 (session counters, analysis flags)

### Integration Points
- profiler.md에 관점 전환 탐지 섹션 추가 (패턴 분석 섹션 아래)
- HR.md에 관점 전환 모드 섹션 추가 (갭 프로빙 모드 아래)
- C-Level.md에 관점 전환 모드 섹션 추가 (So What 모드 아래)
- SKILL.md에 perspective_shift 핸들링 규칙 추가 (item 8)

</code_context>

<specifics>
## Specific Ideas

- CLAUDE.md에서 관점 전환은 Round 2 (Impact & Gaps)에 자연스럽게 배치 명시
- "유저가 직접 말한 것보다 더 큰 역할을 선택지에 포함한다" — 선택지에 업그레이드된 역할 포함
- "유저가 말한 수준"과 "타인이 볼 수준" 사이의 갭을 드러내는 것이 핵심 목적
- 유저가 재구성할 수 없는 관점 사용 금지 (인턴 에피소드에 CEO 관점 등)

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>
