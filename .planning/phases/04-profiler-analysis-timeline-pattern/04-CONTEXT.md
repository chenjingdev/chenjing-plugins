# Phase 4: Profiler Analysis (Timeline + Pattern) - Context

**Gathered:** 2026-04-08
**Status:** Ready for planning

<domain>
## Phase Boundary

프로파일러가 경력 타임라인 갭을 자동 탐지하고 크로스 컴퍼니 행동 패턴을 발견하여 숨은 에피소드 발굴을 유도한다. episode-watcher.mjs에 결정론적 날짜 파싱을 추가하고, profiler.md에 패턴 분석 프롬프트를 추가하며, SKILL.md에 갭 프로빙 오케스트레이션 규칙을 추가한다.

</domain>

<decisions>
## Implementation Decisions

### Timeline Gap Detection
- episode-watcher.mjs에서 결정론적 날짜 파싱으로 갭 감지 — 기존 SO-WHAT, scoring과 동일 위치
- YYYY.MM 정규식으로 resume-source.json의 period 필드 ("2023.03 - 2024.06") 파싱
- 갭 감지 결과는 findings-inbox.jsonl에 type: timeline_gap_found로 전달 — 기존 findings 시스템 재활용
- 프로파일러 트리거 사이클 (기존 scoring 임계값) 시 타임라인 분석 함께 실행
- 회사간 갭 > 6개월, 회사내 갭 > 3개월만 프로빙 대상 (CLAUDE.md)
- 3개월 미만 갭은 무시 (CLAUDE.md)

### Cross-Company Pattern Detection
- 4개 행동 카테고리: 역할 반복, 기술 선택 패턴, 성장/전환 패턴, 문제해결 스타일
- 패턴 최소 근거: 2+ 에피소드, 2+ 다른 회사에서 발견되어야 진정한 크로스 컴퍼니 패턴
- 패턴 결과에 에이전트 지정 질문 포함 ("시니어가 물어야 함: {구체적 질문}")
- 프로파일러 사이클 + 3개 이상 신규 에피소드 축적 시에만 패턴 분석 실행
- 패턴 분석은 profiler.md 프롬프트에 구조화된 비교 프레임워크로 구현 (CLAUDE.md)
- 임베딩/벡터 사용 금지 — LLM 시맨틱 비교로 충분 (CLAUDE.md)

### Gap Probing & UX
- HR 에이전트가 갭 프로빙 담당 — 커리어 전환, 민감한 공백기 대응에 적합
- AskUserQuestion으로 "이 기간은 건너뛰기" 옵션 제공 — intentional_gap으로 기록, 재질문 방지
- 실질 내용이 있는 갭 → 새 에피소드로 수집, 스킵한 갭 → intentional_gap 마킹
- 패턴 발견은 MEDIUM urgency — Conversation Briefing에 포함되어 자연스럽게 전달
- 타임라인 갭은 MEDIUM urgency (CLAUDE.md findings 테이블)

### Claude's Discretion
- 타임라인 파싱 함수의 구체적 구현 (정규식 세부사항)
- profiler.md 패턴 분석 섹션의 프롬프트 구조와 출력 포맷
- intentional_gap 마킹의 JSON 스키마 세부사항
- findings-inbox.jsonl 타임라인/패턴 엔트리의 필드 구조

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- episode-watcher.mjs: 이벤트 감지 + 스코어링 + SO-WHAT 트리거 + findings 라우팅 로직 이미 구현
- profiler.md: 자율 오케스트레이션 모드 + findings-inbox.jsonl 기록 + meta.json 갱신 로직 있음
- SKILL.md: SO-WHAT 핸들러, findings 래핑, Conversation Briefing 시스템 구축됨
- resume-source.json 스키마: companies[].projects[].period 필드 ("YYYY.MM - YYYY.MM" 형태)

### Established Patterns
- Hook → additionalContext 메시지 → SKILL.md 오케스트레이터 처리
- findings-inbox.jsonl append → hook 처리 → findings.json 갱신 → Conversation Briefing 삽입
- meta.json에 상태 플래그 저장 (profiler_score, so_what_active 등)
- TDD 패턴: test-episode-watcher.mjs에서 함수 단위 테스트

### Integration Points
- episode-watcher.mjs에 타임라인 파싱 함수 추가
- profiler.md에 패턴 분석 섹션 추가
- SKILL.md에 timeline_gap_found / pattern_detected 핸들링 규칙 추가
- HR 에이전트 프롬프트에 갭 프로빙 모드 추가

</code_context>

<specifics>
## Specific Ideas

- CLAUDE.md에서 타임라인 갭 탐지는 "결정론적 date arithmetic + LLM probing" 명시
- 패턴 탐지 출력: 패턴 이름(3-5단어), 근거 에피소드 목록, 미탐색 회사 추정, 구체적 질문 제안
- 갭 해결 결과는 에피소드로 피드백하거나 intentional gap으로 마킹

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>
