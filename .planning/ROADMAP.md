# Roadmap: Resume Panel Interview Enhancement

## Overview

기존 9-에이전트 패널 인터뷰 시스템에 6개 신규 기능을 추가하여 숨은 에피소드와 비즈니스 임팩트 발굴 능력을 근본적으로 강화한다. AskUserQuestion UX 교체부터 시작하여, 프로파일러 트리거 강화 -> So What 체인 -> 프로파일러 분석(타임라인 + 패턴) -> 관점 전환 -> 모순 탐지 순서로 진행한다. 모든 기능은 프롬프트 엔지니어링 + 오케스트레이터 로직 변경으로 구현되며 새로운 의존성이나 에이전트는 추가하지 않는다.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: AskUserQuestion UX** - 텍스트 번호 선택을 셀렉트 박스 UI로 교체
- [ ] **Phase 2: Profiler Frequency Enhancement** - 이벤트 가중치 기반 프로파일러 트리거 시스템 구축
- [ ] **Phase 3: So What Chain** - 에피소드 저장 시 비즈니스 임팩트 심화 후속 질문 자동 트리거
- [ ] **Phase 4: Profiler Analysis (Timeline + Pattern)** - 타임라인 갭 탐지와 크로스 컴퍼니 패턴 발견
- [ ] **Phase 5: Perspective Shifting** - 타인 시점 관점 전환 질문으로 숨은 기여 발굴
- [ ] **Phase 6: Contradiction Detection** - 역할 축소 모순 탐지 및 신뢰 유지 톤 전달

## Phase Details

### Phase 1: AskUserQuestion UX
**Goal**: 유저가 인터뷰 중 모든 질문에 클릭 가능한 셀렉트 박스로 응답할 수 있다
**Depends on**: Nothing (first phase)
**Requirements**: UX-01, UX-02, UX-03
**Success Criteria** (what must be TRUE):
  1. 유저가 인터뷰 중 에이전트 질문에 대해 셀렉트 박스를 클릭하여 답변을 선택할 수 있다
  2. 각 질문에 에이전트가 구성한 2-5개 옵션이 셀렉트 박스로 표시된다
  3. 유저가 옵션 대신 직접 텍스트를 입력하여 자유롭게 답변할 수 있다
  4. AskUserQuestion 실패 시 기존 텍스트 번호 방식으로 폴백이 작동한다
**Plans:** 2 plans

Plans:
- [x] 01-01-PLAN.md — SKILL.md 오케스트레이터 AskUserQuestion 변환 + 폴백 + findings 래핑
- [x] 01-02-PLAN.md — 5개 프론트스테이지 에이전트 선택지 가이드라인 + 예시 업데이트

**UI hint**: yes

### Phase 2: Profiler Frequency Enhancement
**Goal**: 프로파일러가 단순 에피소드 카운트 대신 이벤트 가중치 기반으로 전략적 타이밍에 호출된다
**Depends on**: Phase 1
**Requirements**: PROF-01, PROF-02, PROF-03
**Success Criteria** (what must be TRUE):
  1. 에피소드 저장, 새 회사 추가, result 미비, 역할 축소 신호 등 이벤트마다 각기 다른 가중치가 누적된다
  2. 누적 점수가 임계값(5점)에 도달하면 프로파일러가 자동 호출된다
  3. 프로파일러 호출 후 점수가 리셋되어 다음 사이클이 시작된다
**Plans:** 1 plan

Plans:
- [x] 02-01-PLAN.md — episode-watcher.mjs 이벤트 가중치 스코어링 시스템 구현 (TDD)

### Phase 3: So What Chain
**Goal**: 에피소드 저장 시 비즈니스 임팩트가 부족하면 자동으로 심화 질문이 트리거되어 에피소드 품질이 올라간다
**Depends on**: Phase 1, Phase 2
**Requirements**: IMPACT-01, IMPACT-02, IMPACT-03
**Success Criteria** (what must be TRUE):
  1. 에피소드 저장 직후, result 필드에 구체적 임팩트가 없으면 후속 심화 질문이 자동으로 생성된다
  2. 심화 질문이 최대 3단계(액션 -> 직접 결과 -> 비즈니스 임팩트)로 점진적으로 깊어진다
  3. 이미 수치나 비즈니스 임팩트가 포함된 에피소드는 So What 체인이 자동으로 건너뛰어진다
  4. 심화된 결과가 resume-source.json의 해당 에피소드 result 필드에 반영된다
**Plans:** 2 plans

Plans:
- [x] 03-01-PLAN.md — hasQuantifiedImpact() + SO-WHAT 트리거 로직 (TDD)
- [ ] 03-02-PLAN.md — C-Level So What 체인 모드 + SKILL.md 오케스트레이션 규칙

**UI hint**: yes

### Phase 4: Profiler Analysis (Timeline + Pattern)
**Goal**: 프로파일러가 경력 타임라인 갭을 자동 탐지하고 크로스 컴퍼니 행동 패턴을 발견하여 숨은 에피소드 발굴을 유도한다
**Depends on**: Phase 2, Phase 3
**Requirements**: TIME-01, TIME-02, TIME-03, PTRN-01, PTRN-02, PTRN-03
**Success Criteria** (what must be TRUE):
  1. resume-source.json의 회사/프로젝트 기간 데이터로 전체 타임라인이 구성되고, 3개월 이상 빈 구간이 자동 탐지된다
  2. 탐지된 갭에 대해 프로빙 질문이 생성되며, 민감한 공백기에는 "건너뛰기" 옵션이 제공된다
  3. 에피소드 3개 이상 수집 시 크로스 컴퍼니 패턴 분석이 실행되어 반복 행동 패턴이 가설로 제시된다
  4. 패턴 및 타임라인 분석 결과가 findings-inbox.jsonl을 통해 Conversation Briefing에 포함되어 후속 에이전트에 전달된다
**Plans**: TBD

Plans:
- [ ] 04-01: TBD
- [ ] 04-02: TBD
- [ ] 04-03: TBD

### Phase 5: Perspective Shifting
**Goal**: 리더십/협업 에피소드에서 타인 시점 질문이 전략적으로 생성되어 유저가 축소했던 기여를 재발견한다
**Depends on**: Phase 4
**Requirements**: PERSP-01, PERSP-02, PERSP-03
**Success Criteria** (what must be TRUE):
  1. 리더십/협업 에피소드에서 타인 시점(PM, 주니어, 상사, 외부) 질문이 프론트스테이지 에이전트에 의해 자동 생성된다
  2. 관점 전환 질문이 추상적이지 않고 구체적 장면 묘사를 포함한다 (예: "팀 회식 자리에서 상사가..." 형태)
  3. 프로파일러 패턴 데이터(과소평가 신호, 행동 패턴)와 연동되어 전략적 타이밍에 트리거된다
**Plans**: TBD

Plans:
- [ ] 05-01: TBD
- [ ] 05-02: TBD

### Phase 6: Contradiction Detection
**Goal**: 인터뷰 전체에서 역할/기여도 모순이 탐지되어 축소된 역할이 복원되며, 유저 신뢰가 유지된다
**Depends on**: Phase 4, Phase 5
**Requirements**: CONTR-01, CONTR-02, CONTR-03
**Success Criteria** (what must be TRUE):
  1. 인터뷰 전체에 걸쳐 역할/기여도 관련 클레임이 추적되고, 모순 발견 시 유저에게 제시된다
  2. 모순 제시 톤이 "아까 이야기랑 연결해보면..." 형태의 연결 톤이며, 비난이나 지적 톤이 아니다
  3. 컨텍스트(회사/프로젝트/기간) 기반 스코핑으로 false positive가 최소화되어, 한국 문화적 겸양과 실제 모순이 구별된다
  4. 모순 해결 후 해당 에피소드의 STAR 필드가 정정된 정보로 업데이트된다
**Plans**: TBD

Plans:
- [ ] 06-01: TBD
- [ ] 06-02: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. AskUserQuestion UX | 2/2 | Complete | 2026-04-07 |
| 2. Profiler Frequency Enhancement | 0/1 | Not started | - |
| 3. So What Chain | 0/2 | Not started | - |
| 4. Profiler Analysis (Timeline + Pattern) | 0/3 | Not started | - |
| 5. Perspective Shifting | 0/2 | Not started | - |
| 6. Contradiction Detection | 0/2 | Not started | - |
