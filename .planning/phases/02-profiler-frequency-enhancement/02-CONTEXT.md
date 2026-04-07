# Phase 2: Profiler Frequency Enhancement - Context

**Gathered:** 2026-04-07
**Status:** Ready for planning

<domain>
## Phase Boundary

episode-watcher.mjs의 현재 단순 delta 기반 프로파일러 트리거 로직을 이벤트별 가중치 점수 기반 시스템으로 교체한다. 점수가 임계값(5)에 도달하면 프로파일러를 호출하고 점수를 리셋한다.

</domain>

<decisions>
## Implementation Decisions

### 가중치 테이블 (유저 확정)
- 에피소드 저장: +1
- 새 회사 추가: +3
- result 필드 비어있음: +2
- 역할 축소 신호: +2
- 메타 변경 (타겟 JD, 프로필): +2

### 트리거 메커니즘
- 임계값: 5점 도달 시 프로파일러 호출
- 호출 후 점수 리셋 (0으로 초기화)
- 점수는 .resume-panel/meta.json에 누적 저장

### Claude's Discretion
- 역할 축소 신호 감지 방법 (에피소드 텍스트 분석 로직)
- score 필드명, JSON 구조
- 기존 delta 로직 제거 vs 공존 결정

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `plugins/resume/scripts/episode-watcher.mjs` — 현재 delta 기반 트리거 (수정 대상)
- `.resume-panel/meta.json` — 기존 메타 상태 저장 (score 필드 추가 대상)
- `.resume-panel/snapshot.json` — 에피소드 카운트, 프로젝트명, 메타 해시 스냅샷

### Established Patterns
- PostToolUse hook → stdin JSON 파싱 → resume-source.json 변경 감지 → delta 계산 → 메시지 출력
- `countEpisodes()`, `getProjectNames()`, `hashMeta()`, `countStarGaps()` 헬퍼 함수
- findings-inbox.jsonl → findings.json 라우팅 (역할 2, 변경 불필요)

### Integration Points
- `plugins/resume/hooks/hooks.json` — PostToolUse hook 등록 (변경 불필요)
- 프로파일러 호출은 오케스트레이터(SKILL.md)가 additionalContext 메시지를 보고 판단

</code_context>

<specifics>
## Specific Ideas

- 현재 `episodeDelta >= 3` 조건을 점수 시스템으로 완전 교체
- `hasNewProject` → +3, `metaHash 변경` → +2 등으로 매핑
- result 필드 비어있음 감지: `countStarGaps()` 함수 활용 가능
- 역할 축소 신호: 에피소드의 action/result에서 "도움", "참여", "지원" 같은 축소 표현 탐지

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>
