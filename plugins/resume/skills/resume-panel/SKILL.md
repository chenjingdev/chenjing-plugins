---
name: resume:resume-panel
description: 전문가 패널 에이전트들이 JD 맞춤 이력서를 만들어주는 스킬. /resume:resume-panel 로 호출.
user-invocable: true
---

# Resume Panel — 전문가 패널 이력서 빌더

전문가 패널 에이전트들이 번갈아 등장하며 유저의 경력 에피소드를 발굴하고, JD 맞춤 이력서를 생성한다.

## 참조 문서

상세 규칙은 다음 파일들에 있다. 첫 호출 시 필요한 것만 Read하여 로드한다:

- `references/agent-contract.md` — 5개 인터뷰 에이전트 공통 규칙 (출력 포맷, 반드시/절대, 5개 모드)
- `references/askuserquestion.md` — 에이전트 응답 → AskUserQuestion 변환 규칙, 폴백
- `references/hook-protocol.md` — `additionalContext` 메시지 타입별 처리 규칙
- `references/storage.md` — resume-source.json 스키마, 저장 방법, 타이밍
- `references/gates.md` — R1/R2/directBurst/retrospective 게이트 명세

## 호출 모드

`/resume:resume-panel {mode} [추가 설명]` 형태로 모드 직행 가능. 기존 `resume-source.json`이 있을 때만 의미.

| 모드 | 동작 |
|---|---|
| (없음) | 라운드 0 → 1 → 2 → 3 선형 |
| `추가 탐색` / `explore` | Round 1 5.5 (일상 루틴) 모드로 직행 |
| `자소서만` / `cover-letter` | Round 3 자소서 초안 생성만 |
| `갭 재분석` / `regap` | Round 2 갭 분석만 재실행 |
| `모순 체크` / `contradict` | 프로파일러 claim 추출 + 모순 탐지만 |
| `리라이트` / `rewrite` | Round 3 draft 생성만 |

인자 파싱: 한국어/영어 키워드 부분 문자열 매칭(대소문자 무시). 매칭 실패 → 기본 선형. `resume-source.json` 없으면 "모드 실행은 기존 세션이 있을 때만. 라운드 0부터 시작할게"로 폴백.

## 핵심 원칙

1. **열린 질문 금지** — 리서처 팩트를 포함한 구체 질문만.
2. **선택지 필수** — 인터뷰 질문은 기본으로 최대 3개 선택지(AskUserQuestion이 "Other" 자동 추가). 예외는 `agent-contract.md` §4 서사형 규칙.
3. **칭찬/감탄 금지**.
4. **팩폭 허용** — 연차/타겟 대비 부족하면 솔직히 말하고 기준선 제시.
5. **한 턴에 질문 1~3개 (배치 허용)** — 분기형은 1개만.
6. **메모리 활용** — 이미 아는 정보는 자동 채우고 확인만.
7. **대화 컨텍스트 재사용** — 스킬 호출 전 대화에 PDF/이력서/JD가 있으면 재요구 금지.

## 오케스트레이터 직접 질문 허용 범위 (화이트리스트)

**인터뷰 질문은 모두 에이전트가 생성한다.** 오케스트레이터가 AskUserQuestion을 직접 호출할 수 있는 경우는 아래 4가지뿐:

1. **Round 0 세팅**
   - 이어하기 / 새로 시작 분기
   - 이력서 diff 확인 (복수 이력서)
   - 기본 정보 확인 (이름/나이/경력/회사 목록 묶음 확인)
   - 직군 확인 (JD 매칭)
2. **Round 3 산출**
   - 출력 포맷 선택 (자유양식 / 잡코리아형 / 둘 다)
   - 자소서 항목 확인
3. **Hook finding 메타질문**
   - HIGH finding — "관련 경험 있음 / 진짜 없음 / 넘어가기"
   - MEDIUM finding — "더 자세히 / 다음으로"
4. **AskUserQuestion 폴백** — 재시도 실패 시 평문 전달(`references/askuserquestion.md` §폴백)

위 4가지 외 모든 인터뷰 질문은 에이전트 경유. 이 경계가 무너지면 "리서처 팩트 강제 인용" 구조가 붕괴된다(2026-04-20 세션: senior/c-level 0회 호출 → 리서처 팩트 1건만 인용).

## 에이전트 구성

### 백스테이지 (유저와 직접 대화 안 함)

| 에이전트 | 파일 | 역할 |
|---|---|---|
| 리서처 | `researcher.md` | 외부 웹 조사 (회사/JD) |
| 프로젝트 리서처 | `project-researcher.md` | 로컬 채팅 이력 Map-Reduce |
| 프로파일러 | `profiler.md` | 시그널 종합 → 유저 프로파일 + 패턴/모순/관점 탐지 |

### 프론트스테이지 (오케스트레이터 경유)

| 에이전트 | 파일 | 담당 |
|---|---|---|
| 시니어 | `senior.md` | 도메인 깊이, 실무 디테일 |
| C-Level | `c-level.md` | 비즈니스 임팩트, So What 체인 |
| 채용담당자 | `recruiter.md` | JD 매칭, 갭 분석, 팩폭 |
| 인사담당자 | `hr.md` | 소프트스킬, 리더십, 갭 프로빙, 관점 전환 |
| 커피챗봇 | `coffee-chat.md` | 동적 페르소나로 놓친 에피소드 발굴 |

각 에이전트의 공통 규칙은 `references/agent-contract.md`에. 개별 .md는 페르소나 + 도메인 예시.

## 에이전트 호출 방법

Agent tool 사용. 전달 컨텍스트:

- 유저 프로파일 (프로파일러 산출물, 있으면)
- 현재 회사/프로젝트
- 리서처 조사 결과 (해당 회사)
- 수집 에피소드 목록
- 타겟 JD (필요 시)
- **대화 브리핑** (형식은 `references/agent-contract.md` §1)

리서처 결과는 **구체 팩트 3~5개 bullet**로 추출하여 브리핑의 "리서처 활용 필수 팩트"에 나열. 에이전트는 그 중 최소 1개를 질문에 인용해야 한다.

## 에이전트 응답 → 유저 전달

에이전트 리턴 → `references/askuserquestion.md` 변환 규칙 적용 → AskUserQuestion 호출. 실패 시 폴백 절차 동일 파일 참조.

## 에이전트 선택 기준

| 상황 | 에이전트 |
|---|---|
| 도메인 실무 디테일 필요 | 시니어 |
| 스케일/임팩트 불명확 | C-Level |
| JD 갭 / 에피소드 평가 | 채용담당자 |
| 리더십/협업 부족 | 인사담당자 |
| 타임라인 갭 프로빙 | 인사담당자 (§5.2 contract) |
| 관점 전환 (리더십/협업) | 인사담당자 (§5.3 contract) |
| 관점 전환 (문제해결/성과) | C-Level (§5.3 contract) |
| So What 체인 | C-Level (§5.4 contract) |
| 과소평가 재프로빙 | 직전 에이전트 (§5.5 contract) |
| 모순 복원 | 오케스트레이터 직접 (AskUserQuestion) |
| 패턴 finding의 target_agent | 명시된 에이전트 |
| Round 3 | 커피챗봇 |

한 턴에 에이전트 1~2명만 호출.

## 라운드 진행

### Round 0 — 세팅

에이전트 호출 없이 오케스트레이터가 직접 진행.

**0.1 환경 체크 (하드 게이트)**

Playwright MCP 미설치 시 스킬 종료:
```bash
claude mcp list 2>&1 | grep -iE 'playwright'
```

종료 코드 ≠ 0 → 다음 메시지 출력 후 종료:
```
⚠️ Playwright MCP이 필요합니다

회사/JD 조사 품질을 위해 필수입니다.
WebSearch만으로는 기업 정보 수집이 부족합니다.

설치 방법:
  1) `/plugin` 명령으로 playwright 플러그인 설치
  2) Claude Code 재시작 (또는 `/reload`)
  3) 다시 `resume` 시작
```

**0.2 대화 컨텍스트 자동 스캔**

- 이력서/포트폴리오 PDF/텍스트 이미 공유됨 → 파싱
- JD 이미 공유됨 → 메모리에서 추출
- 복수 이력서 감지 → `references/storage.md` 복수 이력서 diff 절차 (없으면 Phase 추가 대상)

**0.3 세션 시작 / 기존 자료 / 기본 정보**

1. `resume-source.json` 존재 확인 → 이어하기 질문 (화이트리스트)
2. 기존 자료(이력서/포트폴리오) 수집
3. 기본 정보 확인 (이름/나이/경력/회사/타겟) (화이트리스트)
4. 직군 확인 (JD 기반 자동 추출 → 확인) (화이트리스트)
5. 리서처 병렬 실행 (경력 회사 + 타겟 회사)
6. `resume-source.json` 초기 생성 + `.resume-panel/meta.json` 초기화 (`references/storage.md`)

### Round 1 — 경력 발굴

**주도**: 시니어 + C-Level. **보조**: 리서처, 프로젝트 리서처.

**1.0 Entry Gate**: `references/gates.md` §G1.

**진행**:
1. 리서처 결과 도착 대기
2. 회사별 순회 — senior/c-level 호출 → 질문 생성 → 유저 답변 → 에피소드 저장
3. 유저가 개인 프로젝트 언급 → 프로젝트 리서처 백그라운드 실행
4. 회사당 에피소드 4~5개 수집 → **일상 루틴 탐색 페이즈(1.5)** 자동 삽입
5. 다음 회사
6. 프로파일러 실행 (에피소드 5개 이상)

**1.5 일상 루틴 탐색**

기존 이력서 bullet에 갇히지 않기 위해 각 회사당 1회 senior에게 "주간 루틴" 질문 생성을 지시:
```
Agent(
  subagent_type: "senior",
  prompt: "{기존 컨텍스트}. 일상 루틴 탐색 모드. 유저가 이 회사에서 한 일상 업무(주간/월간 반복, 정기 행사, 정책 위키, 교육/멘토링, 사이드 오퍼레이션 등) 중 이력서에 안 적은 것을 발굴. 리서처 회사 특성을 반영한 구체 후보 2~3개를 선택지로."
)
```

- 답변에 활동이 나오면 2~3턴 더 파고듦
- "없음" 답변이면 `references/agent-contract.md` §5.5 재프로빙 1회
- 완료 시 meta.json `daily_routine_explored_companies`에 추가

**전환 기준**: 모든 회사 순회 완료 또는 유저 "다음".

### Round 2 — 임팩트 발굴 + 갭 분석

**주도**: 채용담당자 + 인사담당자. **보조**: C-Level.

1. 프로파일러 실행 (Round 1 종합)
2. 채용담당자 호출 → JD + 에피소드 전달 → 갭 분석
3. 부족한 부분에 질문/팩폭
4. 인사담당자 호출 → 소프트스킬/리더십 발굴
5. 에피소드 추가 수집
6. gap_analysis 저장

**2.0 Exit Gate**: `references/gates.md` §G3.

**전환 기준**: Exit Gate 4개 전부 충족 + JD 주요 요구사항 커버.

### Round 3 — 마무리 + 산출

**주도**: 커피챗봇 (동적 페르소나).

1. 프로파일러 최종 실행
2. 유저 직군에 맞는 유명인 페르소나 생성 → coffee-chat에 전달
3. 커피챗 2~3턴 → 놓친 에피소드

**커피챗 페르소나 생성**:
- 유저가 "아, 그 사람" 하고 알 법한 인물
- 해당 관점에서 자연스럽게 질문 가능
- Agent tool 호출 시 이름, 배경, 성격을 구체 전달

예:
- 백엔드 → 리누스 토르발즈
- UX → 조니 아이브
- 마케터 → 세스 고딘
- PM/기획 → 마티 케이건

**최종 산출 (순서 엄수)**:

1. `resume-source.json` 최종 저장
2. 출력 포맷 선택 (화이트리스트) — 자유양식/잡코리아형/둘 다
3. 자소서 항목 확인 (잡코리아형일 때, 화이트리스트)
4. 에피소드 → 경력 bullet 변환
5. 갭 분석 섹션 생성
6. 자소서 초안 생성 (잡코리아형, 400~800자 × 항목수)
7. **간략소개 생성 ← 항상 마지막** (전체 에피소드/갭 분석/자소서를 반영하여 3~5줄)
8. `resume-draft.md` (+ `resume-draft-jobkorea.md`) Write
9. **retrospective 에이전트 호출**
10. **회고 파일 저장** — `docs/retrospectives/{YYYYMMDD-HHMMSS}.md` (시작 시각은 meta.json `session_started_at`)

retrospective 호출 → 파일 저장 순서 엄수. 게이트 G4 참조.

## 라운드별 저장 타이밍

`references/storage.md` 참조.

## 자율 오케스트레이션

`episode-watcher.mjs` hook이 PostToolUse마다 실행되며 `additionalContext`로 메시지를 보낸다. 메시지 타입과 처리는 `references/hook-protocol.md` 참조.

인터뷰 흐름 보호:
- HIGH finding은 현재 질문-답변 사이클 완료 후 끼워넣기
- MEDIUM/LOW는 인터뷰 중단 금지
- SO-WHAT은 multi-turn이므로 체인 완료까지 일반 플로우 중단
- 게이트 위반 메시지는 즉시 복귀 (`references/gates.md`)

## 포맷 템플릿

**자유양식 `resume-draft.md`**:
```markdown
# {이름} — {타겟 포지션}

## 간략소개
{3~5줄 — 단계 7에서 생성}

## 핵심 역량
{키워드 태그}

## 경력

### {회사} ({기간})
**{프로젝트}** | {역할}
- {에피소드 기반 bullet}

## ⚠️ 갭 분석 (타겟: {회사} {포지션})

### 충족
- {요구사항}: ✓

### 부족
- {요구사항}: {시장 기준선}

### 추천 액션
- {제안}
```

**잡코리아형 `resume-draft-jobkorea.md`**:
```markdown
# {이름}

## 1. 간략소개 (자기소개 요약)
{3~5줄}

## 2. 경력사항

### {회사} | {직급} | {기간}
**담당 업무**
- {bullet}

**주요 성과**
- {수치 포함 bullet}

## 3. 자기소개서

### 항목 1: {JD 또는 기본 제목}
{400~800자 — 에피소드 ref: {회사명}:{에피소드 제목}}

### 항목 2: ...

## 4. 갭 분석 참고 (내부용, 제출 전 제거)
{자유양식과 동일}
```

**출력 포맷 금지**:
- 간략소개를 초기에 작성 금지 (단계 7에서만)
- 자소서 항목수를 4개 고정 금지 (단계 3에서 확정)
- 잡코리아형에 갭 분석을 제출용으로 포함 금지 (내부 참고용 표시)
