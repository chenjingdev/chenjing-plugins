# Resume Panel Interview Enhancement

## What This Is

이력서 쓸 줄 모르는 사람들을 위한 Claude 플러그인의 인터뷰 프로세스 강화 프로젝트. 기존 9개 에이전트 패널 인터뷰 시스템에 임팩트 심화, 패턴 탐지, 타임라인 분석, 관점 전환, 모순 탐지 기능을 추가하고, 텍스트 기반 선택 UI를 AskUserQuestion 셀렉트 박스로 교체한다.

## Core Value

인터뷰를 통해 유저 본인도 몰랐던 숨은 에피소드와 비즈니스 임팩트를 발굴하여, 이력서 품질을 근본적으로 높인다.

## Requirements

### Validated

- ✓ 9개 에이전트 패널 인터뷰 시스템 (Senior, C-Level, Recruiter, HR, Coffee Chat, Researcher, Profiler, Project Researcher) — existing
- ✓ 4라운드 인터뷰 프로세스 (Setup → Career Discovery → Impact & Gaps → Final Polish) — existing
- ✓ 선택지 기반 질문 (모든 질문에 2-3개 옵션 + 직접입력) — existing
- ✓ 자율 백엔드 처리 (episode-watcher hook → profiler auto-call → findings routing) — existing
- ✓ STAR 포맷 에피소드 수집 (resume-source.json) — existing
- ✓ JD 맞춤 이력서 생성 (resume-draft.md) — existing
- ✓ 멀티 직종 지원 (개발자, UX 디자이너, 마케터, PM 등) — existing
- ✓ Conversation Briefing 시스템 — existing

### Active

- [ ] So What 체인 — 에피소드 저장 시 비즈니스 임팩트까지 파는 후속 질문 트리거
- [ ] 패턴 발견 — 크로스 컴퍼니 패턴 탐지로 숨은 에피소드 발굴
- [ ] 타임라인 갭 탐지 — 경력 빈 구간 자동 찾기 및 프로빙
- [ ] 관점 전환 질문 — 타인 시점(PM, 주니어, 상사)으로 에피소드 재질문
- [ ] 모순 탐지 — 앞뒤 안 맞는 답변 캐치로 축소된 역할 복원
- [ ] AskUserQuestion 기반 선택형 UX — 텍스트 번호 타이핑을 셀렉트 박스 UI로 교체

### Out of Scope

- 에피소드 뱅크 + 멀티 JD 생성 — v2 확장 기능
- 모의 면접 모드 — v2 확장 기능
- 커리어 내러티브 요약 자동 생성 — 패턴 발견 이후에 추가 가능
- 새로운 에이전트 추가 — 기존 에이전트에 기능을 통합

## Context

- 기존 시스템은 `plugins/resume/` 디렉토리에 있으며, SKILL.md가 오케스트레이터 역할
- 에이전트 프롬프트는 `plugins/resume/.claude/agents/` 에 위치
- episode-watcher.mjs 훅이 자율 백엔드 처리 담당 (PostToolUse → resume-source.json 변경 감지 → profiler 자동 호출)
- 인터뷰 중 에피소드는 resume-source.json에 STAR 포맷으로 누적
- 현재 선택지는 에이전트가 텍스트로 "1) 뭐뭐 2) 뭐뭐" 출력하고 유저가 번호 타이핑
- GSD 스타일 AskUserQuestion은 실제 UI 셀렉트 박스를 렌더링하여 클릭으로 선택 가능
- 한국인 유저 특성: 본인 역할을 축소하는 경향 → 모순 탐지의 핵심 동기

## Constraints

- **플랫폼**: Claude Code 플러그인 시스템 (SKILL.md + agents + hooks)
- **도구 제약**: AskUserQuestion은 질문당 2-4개 옵션, 1-4개 질문 동시 가능
- **기존 구조 유지**: 4라운드 구조와 에이전트 역할 분담은 유지하면서 기능 추가
- **프로파일러 의존**: So What 체인, 패턴 발견, 타임라인 갭은 profiler 에이전트 강화 필요

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| 기존 에이전트에 기능 통합 (새 에이전트 추가 안 함) | 에이전트 수가 이미 9개로 복잡도 충분 | — Pending |
| AskUserQuestion으로 UX 교체 | 유저가 번호 타이핑 대신 셀렉트 박스 클릭으로 편의성 대폭 개선 | — Pending |
| 6개 기능 전부 v1 | 유저가 전부 중요하다고 판단, 우선순위 동일 | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-07 after initialization*
