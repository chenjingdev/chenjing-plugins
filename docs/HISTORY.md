# chenjing-plugins 작업 히스토리

## Phase 1: 플러그인 초기 구조 (2026-04-01)

마켓플레이스 + resume 플러그인 초기 세팅.

- `53d8e6a` init chenjing-plugins marketplace with resume:resume-source skill
- `ceeceef` fix: add plugin.json for resume plugin
- `e2a676e` fix: skills path should be relative to plugin source directory

## Phase 2: resume-source 스킬 (2026-04-01)

첫 버전은 단순 인터뷰 기반 이력서 소스 수집 스킬.

- `8d183ee` overhaul resume-source skill with recognition-based interview
- `7e3abd7` fix: 인터뷰 질문 방식 개선 — 선택지 제시, 응원 제거, 중복질문 금지

## Phase 3: resume-panel 설계 (2026-04-02)

12개 전문가 에이전트 패널 구조로 전면 재설계.

- `7056703` docs: add resume-panel design spec
- `273e116` docs: update spec with profiler, project-researcher, question rules
- `e29ede7` docs: add resume-panel implementation plan
- `16d8d3f` chore: remove old resume-source, create resume-panel directory structure

## Phase 4: 에이전트 구현 (2026-04-02 ~ 04-03)

백스테이지(리서처, 프로파일러) + 프론트스테이지(시니어개발자, CTO, 채용담당자, HR, 커피챗봇) 에이전트 12개 구현.

- `101d807` add researcher agent (회사/JD 외부 웹 조사)
- `2908bff` add project-researcher agent (로컬 채팅 이력 Map-Reduce)
- `c531f8d` add profiler agent (시그널 종합 → 유저 프로파일)
- `e8ebfe8` add senior-dev agent (기술 깊이 발굴)
- `ff3990f` add CTO agent (아키텍처/임팩트 발굴)
- `dfb4dd8` add recruiter agent (JD 매칭/갭 분석)
- `f5e208e` add HR agent (소프트스킬/리더십 발굴)
- `a523fea` add 5 coffee chat bot personas (놓친 에피소드 발굴)
- `de02c7d` add orchestrator SKILL.md (라운드 진행 규칙)

## Phase 5: 자율 오케스트레이션 구현 (2026-04-03)

PostToolUse hook 기반 자율 에이전트 트리거 시스템. 메인 오케스트레이터가 인터뷰에 집중하는 동안 뒷단에서 에이전트들이 자동 조사/분석/피드백.

설계문서: `docs/superpowers/resume-panel-orchestration-design.md`
구현계획: `docs/superpowers/plans/2026-04-03-resume-panel-orchestration.md`

### 아키텍처

```
유저 ↔ 오케스트레이터(메인)
        │ resume-source.json 저장
        ▼
   [PostToolUse hook — episode-watcher.mjs]
        │
        ├─ 역할 1: delta 감지 → 프로파일러 호출 메시지
        │   (에피소드 +3, 새 프로젝트, meta 변경, 쿨다운 초과)
        │
        └─ 역할 2: findings-inbox.jsonl → 긴급도별 라우팅
            HIGH → 즉시 additionalContext로 전달
            MEDIUM → 프로젝트 전환 시 전달
            LOW → 보관 (요청 시 전달)
```

### 커밋 내역

- `edf6a0e` hooks.json 생성 (PostToolUse → Write|Bash|Edit)
- `67b1f84` episode-watcher.mjs 뼈대 + self-trigger 방지
- `e75bb73` delta 감지 로직 구현
- `ef8d8ac` findings 라우팅 로직 구현
- `bee3133` SKILL.md에 hook 메시지 처리 규칙 추가
- `4ff89ed` profiler.md에 자율 오케스트레이션 모드 추가
- `f062427` SKILL.md 라운드 0에 .resume-panel/ 초기화 추가
- `c8db53c` 코드 리뷰 반영

## Phase 6: 실제 데이터 검증 + 버그 수정 (2026-04-06)

실제 resume-source.json 데이터로 E2E 테스트 실행. 설계문서와 실제 데이터의 스키마 불일치 발견 및 수정.

### 발견한 버그들

1. **스키마 불일치**: episode-watcher가 `source.companies[].projects[].episodes[]` (설계문서)를 기대했으나 실제 데이터는 `source.projects[].episodes[]` (flat). STAR 필드도 `ep.situation` 대신 `ep.star.situation`.

2. **서브에이전트 hook self-trigger**: 프로파일러(백그라운드 Agent)가 Bash로 `.resume-panel/findings-inbox.jsonl`에 쓸 때 hook이 발동하여 inbox를 소비 → 메인 오케스트레이터에 전달 안 됨.

3. **프로파일러가 findings.json 직접 수정**: 설계상 inbox에만 append해야 하는데 findings.json을 직접 읽고 수정.

### 수정 커밋

- `10fc5db` fix: episode-watcher를 실제 resume-source.json 스키마에 맞춤
- `282cdd2` fix: Bash .resume-panel/ self-trigger 방지 + profiler.md 금지 강화

### 라이브 테스트 결과

| 단계 | 결과 |
|------|------|
| Hook 발동 (PostToolUse) | PASS |
| Delta 감지 (+3 에피소드) → additionalContext | PASS |
| 프로파일러 백그라운드 실행 → findings 생성 | PASS |
| findings-inbox HIGH → additionalContext 라우팅 | PASS |
| findings-inbox LOW → skip | PASS |
| self-trigger 방지 | PASS |
| 유닛 테스트 | 17/17 PASS |
| E2E 테스트 (실제 24개 에피소드) | 5/5 Phase PASS |

### 알려진 제약

- 플러그인 캐시가 GitHub에서 가져오므로 push 후 Claude Code 재시작 필요
- 서브에이전트의 hook additionalContext는 메인에 전달 안 됨 → 메인의 다음 도구 호출 시 inbox 처리 (1턴 지연)
