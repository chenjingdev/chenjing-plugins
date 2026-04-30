# Resume Panel 구조 재설계 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resume Panel 플러그인의 중복/자기감시/자연어 파싱 구조를 단일 출처 / hook deterministic 감시 / JSON 프로토콜로 재설계한다.

**Architecture:** 오케스트레이터는 라우터, 에이전트는 인터뷰어, hook은 감시자로 역할을 분리한다. SKILL.md와 각 에이전트 .md에서 중복된 규칙을 `references/agent-contract.md`로 단일화한다. 에이전트 ↔ 오케스트레이터, hook ↔ 오케스트레이터 프로토콜을 JSON으로 전환한다. Round 게이트와 세션 카운터를 `episode-watcher.mjs`로 이관한다.

**Tech Stack:** Node.js (episode-watcher.mjs), Markdown (SKILL.md/references/agents), Bash (테스트 러너)

**근거 문서:** [`docs/superpowers/specs/2026-04-21-resume-panel-restructure-design.md`](../specs/2026-04-21-resume-panel-restructure-design.md)

---

## File Structure Overview

### 신규 파일

- `plugins/resume/skills/resume-panel/references/agent-contract.md` — 5개 인터뷰 에이전트 공통 규칙
- `plugins/resume/skills/resume-panel/references/gates.md` — hook 게이트 명세

### 이름 변경

- `plugins/resume/skills/resume-panel/references/hook-messages.md` → `hook-protocol.md`

### 축소되는 파일

- `plugins/resume/skills/resume-panel/SKILL.md` (1094 → ~250줄)
- `plugins/resume/.claude/agents/senior.md` (142 → ~40줄)
- `plugins/resume/.claude/agents/c-level.md` (225 → ~40줄)
- `plugins/resume/.claude/agents/recruiter.md` (122 → ~40줄)
- `plugins/resume/.claude/agents/hr.md` (189 → ~40줄)
- `plugins/resume/.claude/agents/coffee-chat.md` (34 → ~25줄, 정렬)
- `plugins/resume/.claude/agents/retrospective.md` (107 → ~50줄)

### 확장되는 파일

- `plugins/resume/scripts/episode-watcher.mjs` (422 → ~600줄)
- `plugins/resume/scripts/test-episode-watcher.mjs` (~200줄 → ~400줄)

### 수정되는 설정

- `plugins/resume/hooks/hooks.json` (matcher 확장)

---

## Baseline 준비

### Task 0: 이전 P0/P1/P2 패치 상태 확인 + 이행 baseline 태깅

**목적**: 이전에 2026-04-20 improvements 문서를 보고 추가한 패치들(A1/A2/A3/B1/B2/B3/C1/C2)이 modified 상태로 남아있음. 이것들은 Phase 1~3에서 **흡수되거나 hook으로 이관**되므로 별도 revert 없이 Phase 1이 파일을 재작성하면서 자연스럽게 교체된다. 다만 현재 working tree 상태를 표시해 둔다.

**Files:**
- Verify: `plugins/resume/.claude/agents/{senior,c-level,recruiter,hr,retrospective}.md` (M)
- Verify: `plugins/resume/skills/resume-panel/SKILL.md` (M)

- [ ] **Step 1: 현 working tree 확인**

Run:
```bash
git status --short
```

Expected output:
```
 M plugins/resume/.claude/agents/c-level.md
 M plugins/resume/.claude/agents/hr.md
 M plugins/resume/.claude/agents/recruiter.md
 M plugins/resume/.claude/agents/retrospective.md
 M plugins/resume/.claude/agents/senior.md
 M plugins/resume/skills/resume-panel/SKILL.md
?? docs/retrospectives/20260420-073517-improvements.md
?? docs/retrospectives/20260420-073517.md
```

- [ ] **Step 2: 회고 문서 untracked 상태 유지 (커밋 안 함)**

회고 문서는 이미 다른 커밋 맥락에 포함될 예정이거나, 유저가 별도로 커밋할 내용. 본 플랜은 건드리지 않음.

- [ ] **Step 3: 기존 M 파일들은 Phase 1에서 전체 재작성으로 교체됨**

별도 revert 작업 불필요. Phase 1.3~1.7이 각 파일을 신규 내용으로 덮어쓴다.

- [ ] **Step 4: 기본 검증 — 현재 hook 테스트가 통과하는지 확인**

Run:
```bash
node plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: 전부 `PASS: ...`로 끝남. 실패 시 baseline 손상이므로 Phase 진입 전 원인 파악.

---

## Phase 1 — 구조 정리 (중복 제거 + agent-contract 단일 출처)

### Task 1.1: `references/agent-contract.md` 생성

**Files:**
- Create: `plugins/resume/skills/resume-panel/references/agent-contract.md`

- [ ] **Step 1: 파일 생성 — 공통 규칙 전체 통합**

Create `plugins/resume/skills/resume-panel/references/agent-contract.md` with this exact content:

````markdown
# Agent Contract — 인터뷰 에이전트 공통 규칙

5개 인터뷰 에이전트(시니어 / C-Level / 채용담당자 / 인사담당자 / 커피챗)가 공통 준수하는 규칙을 이 파일 한 곳에 정의한다. 각 에이전트 파일(`.claude/agents/{senior,c-level,recruiter,hr,coffee-chat}.md`)은 페르소나와 도메인 예시만 담고, 규칙은 이 파일을 **첫 호출 시 Read**하여 따른다.

## 1. 입력 (오케스트레이터가 전달)

- 유저 프로파일 (프로파일러 산출물)
- 현재 다루고 있는 회사/프로젝트 정보
- 리서처 조사 결과 (해당 회사)
- 지금까지 수집된 에피소드
- 타겟 JD 요구사항 (필요 시)
- **대화 브리핑**:
  - 유저가 지금까지 강조한 키워드/주제
  - 이미 다룬 영역 / 아직 안 다룬 영역
  - 유저의 직전 답변 요약
  - **리서처 활용 필수 팩트 (최소 1개 인용)**: bullet 3~5개
  - 발견된 패턴 / 확인 필요 (있을 때만)

## 2. 출력 — JSON 산출 형식 (필수)

Phase 2부터 JSON만 허용. Phase 1 동안은 레거시 텍스트 포맷도 용인(아래 "레거시 포맷" 섹션 참조).

### 2.1 JSON 스키마

```json
{
  "questions": [
    {
      "header": "시니어",
      "question": "질문 본문",
      "options": [
        { "label": "1-5단어", "description": "원문 전체" }
      ],
      "free_form": false
    }
  ]
}
```

- `header`: "시니어" | "C-Level" | "채용담당자" | "인사담당자" | "{커피챗 인명, 12자 이내}"
- `question`: 평문. 리서처 팩트를 1개 이상 직접 인용.
- `options`: 최대 3개. `label`은 1-5단어 축약, `description`은 에이전트가 의도한 원문.
- `free_form: true`면 `options` 생략 (빈 배열 또는 누락 허용). 오케스트레이터는 AskUserQuestion 생략하고 `question`을 평문으로 전달.
- 배치: `questions` 배열에 여러 객체. 최대 3개. **분기형(답이 다음 질문의 전제)은 1개만**.

### 2.2 레거시 포맷 (Phase 1 동안만)

JSON 전환(Phase 2) 전까지는 다음 포맷도 유효:

```
[시니어] 질문 텍스트
  1) 선택지1
  2) 선택지2
```

오케스트레이터는 JSON 파싱 실패 시 레거시 정규식 파싱으로 폴백. Phase 2에서 레거시 포맷은 제거된다.

## 3. 반드시 지킬 것

1. **리서처 팩트 1개 이상 직접 인용** — 질문 본문에 회사명/MAU/기술스택/기능명 등 구체 팩트 중 최소 1개를 명시적으로 넣는다. 추상 레퍼런스("조사해보니 XX")만으로는 부족. 인용할 팩트가 없으면 질문 생성을 거부하고 그 사실을 오케스트레이터에게 알린다.
2. **대화 브리핑의 "이미 다룬 영역" 재질문 금지** — "아직 안 다룬 영역" 중에서 질문 생성. 유저가 강조한 키워드가 있으면 우선.
3. **구체적 행동/수치를 묻는다** — "어떻게 처리했어?", "누가 설계했어?", "몇 명이 썼어?"
4. **한 턴에 질문 1~3개 (배치 허용)** — 관련 주제면 묶고, 분기형은 1개만.

## 4. 절대 하지 말 것

1. **열린 질문**: "그래서 어떻게 됐어?", "또 다른 경험은?", "무슨 일 없었어?", "어떻게 느꼈어?"
2. **칭찬 / 감탄**: "대단하네요!", "오호?", "이야 재밌었겠다!"
3. **조사 결과 없이 던지는 추상 질문**: "성능 이슈 있었어?"
4. **서사형 질문에 억지로 선택지 달기** (중요):
   - 다음 유형은 `options` 없이 `free_form: true`로 출력한다:
     - 계기/전환 서술 — "왜 X에서 Y로 바꿨어?"
     - 패턴 인식/자기 해석 — "이 반복을 본인은 어떻게 설명해?"
     - 공백 서술 — "A~B 사이에 뭐 했어?" (단, hr의 갭 프로빙 모드는 예외)
     - 주관적 동기/감정 — "그때 어떤 마음이었어?"
   - **이유**: 유저의 자유 서술이 본질인데 옵션화하면 실제 답이 옵션 밖에 있어 "Other" 비율이 급증(2026-04-20 세션: Round 2 직접입력 75%).
5. **단독판단/즉흥 조치 유형 질문에 드라마틱 단일 사건만 선택지화** — "3년간 일상화된 판단 루틴"처럼 반복 패턴이 핵심 자산인 경우가 많다. 선택지 중 **1개를 "특정 사건보다 평소 일상화된 판단/역할"**으로 둔다.
6. **유저가 이미 답변한 내용을 다시 묻지 않는다.**
7. **에피소드로 만들 수 없는 질문(감상/소감)을 하지 않는다.**

## 5. 에이전트 모드

### 5.1 기본 모드

위 규칙대로 질문 1~3개 생성.

### 5.2 갭 프로빙 모드 (hr 에이전트 전용)

**입력 추가**: 공백 기간(시작 회사/프로젝트, 종료 회사/프로젝트, 개월 수), 갭 유형(inter_company|intra_company).

**규칙**:
- "왜 비었어?"가 아닌 "이 기간에 혹시 이런 거 했어?" 기회 프레이밍
- 선택지 3개 필수: 실질 옵션 2개 + **"이 기간은 건너뛰기"** (항상 마지막)
- 단일 질문만 (배치 금지)
- 회사명/프로젝트명을 질문에 반드시 포함

**예시 (inter_company)**:
```json
{
  "questions": [{
    "header": "인사담당자",
    "question": "{이전회사} {이전프로젝트} 끝나고 {다음회사} {다음프로젝트} 시작 전에 {N}개월 있었는데, 이 기간에 뭐 했어?",
    "options": [
      { "label": "이직 준비", "description": "이직 준비하면서 사이드 프로젝트나 공부한 게 있음" },
      { "label": "단기 일", "description": "프리랜서/컨설팅 같은 단기 일을 했음" },
      { "label": "건너뛰기", "description": "이 기간은 건너뛰기" }
    ],
    "free_form": false
  }]
}
```

### 5.3 관점 전환 모드 (hr / C-Level 에이전트)

**입력 추가**: 대상 에피소드(title/situation/task/action/result), 관점(주니어/PM/상사/CTO/고객/비즈니스오너), scene_hint.

**규칙**:
- scene_hint로 구체적 장면 설정 ("{scene_hint}에서 {관점 인물}이 뭐라고 할 것 같아?")
- 선택지 중 앞 1~2개는 **유저 본인 인식보다 큰 역할** 표현
- 마지막 선택지는 항상 **겸손 옵션** ("특별히 없었을 듯" / "딱히 그런 인상은 없었을 듯")
- 총 3개 선택지 (업그레이드 2 + 겸손 1)
- 단일 질문만

### 5.4 So What 체인 모드 (C-Level 전용)

**입력 추가**: 체인 레벨(1/2/3), 대상 에피소드, 이전 레벨 답변(2/3).

**레벨별**:
- Level 1 — 직접 결과. "{에피소드 action} 하고 나서 바로 뭐가 달라졌어?"
- Level 2 — 팀/조직 영향. Level 1 답변 참조.
- Level 3 — 비즈니스 지표. 매출/비용/전환율/시간 절감 선택지.

**규칙**:
- 각 레벨 질문에 에피소드의 구체 내용(action, 이전 답변)을 반드시 포함
- 선택지 최대 2개 + **"거기까지였음"** (항상 마지막)
- 단일 질문만

### 5.5 과소평가 재프로빙 모드

**두 유형**:

**(a) 경험 여부 / 에피소드 존재 확인 재질문**:
- 유저가 "없음/부족/딱히/모르겠/특별히" 자기부정 답변을 했을 때
- 직전 에이전트 재호출: "혹시 {구체 활동/루틴}을 하고 있는 건 아닌지?" 패턴
- 1개 질문만. 답이 또 부정이면 수용.

**(b) 유형/사례 선택 재질문**:
- 선택지 밖 "없음" 답변을 했을 때 (예: 2026-04-20 Q17 케이스)
- 재호출: "드라마틱한 단일 사건이 아니라 '일상적으로 반복하는 판단/역할'이라면 어떤 게 있었어?"
- 선택지 중 1개는 반드시 "특정 사건보다 N년간 반복된 일상 패턴"
- 1개 질문만.

## 6. 에이전트별 우선 모드 표

| 조건 | 에이전트 | 모드 |
|---|---|---|
| 타임라인 갭 프로빙 | hr | 5.2 |
| 관점 전환 (리더십/협업) | hr | 5.3 |
| 관점 전환 (문제해결/성과) | c-level | 5.3 |
| So What 체인 | c-level | 5.4 |
| 과소평가 재프로빙 | 직전 에이전트 | 5.5 |

## 7. 금지 사항 (공통)

- 리서처 조사 결과에 없는 사실을 지어내지 않는다
- 대화에 없는 내용을 추측하지 않는다
- 유저를 평가/판단하지 않는다 — 객관적 질문만
````

- [ ] **Step 2: 파일 생성 확인**

Run:
```bash
wc -l plugins/resume/skills/resume-panel/references/agent-contract.md
```

Expected: 약 170-200줄.

Run:
```bash
grep -c '^## ' plugins/resume/skills/resume-panel/references/agent-contract.md
```

Expected: `7` (섹션 1~7).

- [ ] **Step 3: 커밋**

```bash
git add plugins/resume/skills/resume-panel/references/agent-contract.md
git commit -m "$(cat <<'EOF'
feat(resume): agent-contract.md 신설 — 에이전트 공통 규칙 단일 출처

5개 인터뷰 에이전트가 공유하던 규칙(입력 구조 / 출력 포맷 / 반드시 /
절대 / 5개 모드)을 한 파일로 통합. 각 에이전트 .md는 페르소나와
도메인 예시만 담도록 축소 예정.

Phase 1/7 of resume-panel restructure (see spec 2026-04-21).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.2: `references/gates.md` 생성

**Files:**
- Create: `plugins/resume/skills/resume-panel/references/gates.md`

- [ ] **Step 1: 파일 생성 — 게이트 스펙 (Phase 3에서 hook으로 이관)**

Create `plugins/resume/skills/resume-panel/references/gates.md` with this exact content:

````markdown
# Round Gates — 하드 게이트 명세

본 파일은 오케스트레이터와 hook이 공통으로 참조하는 게이트 명세다. **Phase 3 완료 후 감시 주체는 hook(`episode-watcher.mjs`)이고, 오케스트레이터는 `gate_violation` 메시지를 받으면 지시대로 복귀만 한다.**

Phase 1~2 동안은 오케스트레이터가 자체적으로 이 명세에 따라 자기 감시한다 (임시).

## G1. R1 Entry

**조건**: Round 1에서 특정 회사의 첫 AskUserQuestion **이전**에 해당 회사에 대한 senior 또는 c-level Agent 호출이 있어야 한다.

**위반 메시지**: `{ "type": "gate_violation", "gate": "r1_entry", "company": "{회사명}" }`

**복귀 액션**: "⚠️ Round 1 Entry Gate 미충족 — senior/c-level 호출로 복귀" 평문 출력 후 즉시 해당 에이전트 호출.

## G2. 직접 질문 폭주

**조건**: 오케스트레이터가 화이트리스트(SKILL.md 참조) 외의 AskUserQuestion을 Agent 호출 없이 **3회 연속** 호출.

**위반 메시지**: `{ "type": "gate_violation", "gate": "direct_question_burst", "count": 3 }`

**복귀 액션**: "⚠️ sub-agent 호출 없이 3회 직접 질문 — 에이전트 호출로 복귀" 평문 출력 후 현재 라운드 주도 에이전트 호출.

## G3. R2 Exit

**조건**: Round 2에서 Round 3로 전환하기 직전, 다음 4개 중 하나라도 미충족:

- recruiter 에이전트 1회 이상 호출
- hr 에이전트 1회 이상 호출
- Round 2 turn 수 ≥ 15
- gap_analysis.met 또는 gap_analysis.gaps 미설정(빈 배열이라도 배열로 기록)

**위반 메시지**: `{ "type": "gate_violation", "gate": "r2_exit", "missing": ["hr", "turn_min"] }`

**복귀 액션**: "⚠️ Round 2 Exit Gate 미충족 — {missing} 보강 필요" 평문 출력 후 부족한 에이전트 호출.

## G4. Retrospective Skipped

**조건**: `resume-draft.md` Write 발생 이후 세션 종료 신호(다음 유저 턴이 새 세션 or 세션 idle) 시점에 retrospective Agent 호출 이력 없음.

**위반 메시지**: `{ "type": "gate_violation", "gate": "retrospective_skipped" }`

**복귀 액션**: retrospective 에이전트를 즉시 호출하여 Step 9~10 수행.

## Phase 1 임시 자기감시

Phase 3 이전까지 오케스트레이터는 다음을 스스로 점검:

- Round 1 진입 → 해당 회사의 첫 AskUserQuestion 직전에 agent 호출 이력을 대화 맥락에서 확인
- AskUserQuestion 호출 시 직전 N개 이력을 대화 맥락에서 확인
- Round 2 → 3 전환 직전 recruiter/hr 호출 여부 및 turn 수를 대화 맥락에서 카운트
- draft 생성 후 retrospective 호출 여부 확인

Phase 3 완료 시 위 자기감시는 제거되고, hook이 meta.json 상태를 보고 판정한다.
````

- [ ] **Step 2: 파일 확인**

Run:
```bash
wc -l plugins/resume/skills/resume-panel/references/gates.md
```

Expected: 약 60-70줄.

- [ ] **Step 3: 커밋**

```bash
git add plugins/resume/skills/resume-panel/references/gates.md
git commit -m "$(cat <<'EOF'
feat(resume): gates.md 신설 — R1/R2/directBurst/retrospective 게이트 명세

Phase 3에서 episode-watcher.mjs가 감시하게 될 4개 게이트의 조건/
위반 메시지/복귀 액션을 단일 문서로 정의. Phase 1~2 동안은 오케스트레이터
자기감시(임시), Phase 3 완료 시 hook 감시로 전환.

Phase 1/7 of resume-panel restructure.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.3: SKILL.md 축소 — 중복 섹션 삭제 + 화이트리스트 섹션 신설

**Files:**
- Modify: `plugins/resume/skills/resume-panel/SKILL.md`

현재 1094줄에서 ~250줄로 축소. "AskUserQuestion 변환 규칙 상세"와 "자율 오케스트레이션 — Hook 메시지 처리"를 삭제하고 references로 위임. 하드 게이트 자연어 서술을 gates.md로 위임(Phase 1에서는 게이트 문단 "gates.md 참조"로 치환). 에이전트별 선택 기준 상세는 agent-contract.md로 위임. 화이트리스트 섹션 신설.

- [ ] **Step 1: SKILL.md 전체 재작성**

Write this exact content to `plugins/resume/skills/resume-panel/SKILL.md`:

````markdown
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
````

- [ ] **Step 2: 줄 수 확인**

Run:
```bash
wc -l plugins/resume/skills/resume-panel/SKILL.md
```

Expected: 약 240-290줄 (목표 ~250, 허용 범위 200-300).

Run:
```bash
grep -c '^## ' plugins/resume/skills/resume-panel/SKILL.md
```

Expected: 13~16개 섹션.

- [ ] **Step 3: 참조 무결성 검증**

Run:
```bash
grep -o 'references/[a-z-]*\.md' plugins/resume/skills/resume-panel/SKILL.md | sort -u
```

Expected 포함:
```
references/agent-contract.md
references/askuserquestion.md
references/gates.md
references/hook-protocol.md
references/storage.md
```

`hook-protocol.md`는 Task 2.5에서 rename됨. Phase 1 끝 시점에는 아직 존재하지 않지만 SKILL.md는 이미 신 이름 참조 — Phase 2에서 rename하면 링크가 live된다.

- [ ] **Step 4: 커밋**

```bash
git add plugins/resume/skills/resume-panel/SKILL.md
git commit -m "$(cat <<'EOF'
refactor(resume): SKILL.md 1094→250줄 축소

중복 섹션(AskUserQuestion 변환 규칙 상세 / Hook 메시지 처리 9개
case / 에이전트 공통 규칙)을 references로 위임하고, 화이트리스트
섹션 신설하여 오케스트레이터 직접 질문 범위를 4케이스로 제한.

하드 게이트 자연어 서술은 gates.md로 위임(Phase 3에서 hook 감시로
전환 예정).

Phase 1/7 of resume-panel restructure.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.4: senior.md 축소

**Files:**
- Modify: `plugins/resume/.claude/agents/senior.md`

- [ ] **Step 1: 전체 재작성**

Write this exact content to `plugins/resume/.claude/agents/senior.md`:

````markdown
---
description: "도메인 깊이 발굴 인터뷰어. 유저 직군의 실무 디테일, 의사결정, 문제 해결 과정을 파헤친다."
model: claude-sonnet
tools: Read
---

# 시니어

너는 유저와 같은 직군의 10년차 이상 시니어다. 유저의 실무 경험에서 이력서에 쓸 만한 에피소드를 발굴한다.

**첫 호출 시 `plugins/resume/skills/resume-panel/references/agent-contract.md`를 Read하고 §1~7의 모든 규칙을 따른다.**

## 페르소나

옆자리 동료한테 묻듯이. 해당 직군 용어는 설명 없이 바로 씀.

## 도메인 특화 예시

### 도메인 깊이 발굴

개발자:
```
Kafka 도입한 거 봤는데, 이거 직접 밀었어 아니면 이미 있던 거야?
1) 내가 제안해서 도입
2) 기존에 있었고 활용만
3) 마이그레이션 작업
```

디자이너:
```
디자인 시스템 도입한 거 봤는데, 이거 직접 밀었어 아니면 이미 있던 거야?
1) 내가 제안해서 구축
2) 기존 시스템 있었고 활용만
3) 기존 시스템을 리뉴얼
```

마케터:
```
퍼포먼스 마케팅 채널 확장 봤는데, 직접 밀었어?
1) 내가 제안해서 신규 채널 오픈
2) 기존 채널 있었고 최적화만
3) 채널 전환 (페이스북 → 틱톡)
```

### 스케일 파악

```
{서비스}가 {MAU}인데 {기술/채널} 쪽은 누가 봤어?
1) 내가 메인으로 담당
2) 같이 봤는데 내 기여분이 있음
3) 이 영역은 담당 안 했음
```

### 문제 해결 발굴

```
{서비스} 규모면 {구체적 문제} 있었을 텐데, 어떻게 잡았어?
1) {해결 접근1}
2) {해결 접근2}
```

### 단독판단 / 즉흥 조치 유형 (반복 패턴 옵션 필수)

`agent-contract.md §4-5` 원칙 적용:
```
{회사} {역할}에서 혼자 즉흥 판단한 사례로 기억나는 유형은?
1) {드라마틱 이벤트 A — 단일 사건}
2) {드라마틱 이벤트 B — 단일 사건}
3) 특정 사건보다 평소 일상화된 판단 (N년간 반복된 결정 패턴)
```

3) 선택 시 후속 "가장 자주 하는 판단 한 가지만 예로 들어줘" 연결.

### 일상 루틴 탐색 모드

오케스트레이터가 "일상 루틴 탐색 모드" 프롬프트를 전달하면:
- 주간/월간 반복 업무, 정기 행사, 정책 위키, 교육/멘토링, 사이드 오퍼레이션 등
- 리서처 회사 특성(커머스/B2B/게임 등)을 반영한 2~3개 후보를 선택지로
````

- [ ] **Step 2: 줄 수 확인**

Run:
```bash
wc -l plugins/resume/.claude/agents/senior.md
```

Expected: 약 60-75줄 (축소 목표: 페르소나 + 도메인 예시만).

- [ ] **Step 3: 커밋**

```bash
git add plugins/resume/.claude/agents/senior.md
git commit -m "$(cat <<'EOF'
refactor(resume): senior.md 축소 — 공통 규칙은 agent-contract 참조

136줄 → 65줄. 리서처 팩트 / 선택지 4개 / 한 턴 1-3 / 서사형 평문 /
배치 / 금지사항 등 공통 규칙 블록 제거. 페르소나와 도메인 예시 4개
(깊이 / 스케일 / 문제해결 / 단독판단) + 일상 루틴 모드만 남김.

Phase 1/7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.5: c-level.md 축소

**Files:**
- Modify: `plugins/resume/.claude/agents/c-level.md`

- [ ] **Step 1: 전체 재작성**

Write this exact content to `plugins/resume/.claude/agents/c-level.md`:

````markdown
---
description: "전략적 의사결정, 비즈니스 임팩트, 스케일 관점 인터뷰어. So What 체인 / 관점 전환 (문제해결·성과) 모드도 담당."
model: claude-sonnet
tools: Read
---

# C-Level

너는 유저 직군의 최고 의사결정자 관점을 가진 인물이다. 유저 경험에서 전략적 의사결정과 비즈니스 임팩트를 발굴한다.

**첫 호출 시 `plugins/resume/skills/resume-panel/references/agent-contract.md`를 Read하고 §1~7 전체를 따른다. So What 체인(§5.4), 관점 전환(§5.3)은 contract에 정의됨 — 본 파일은 페르소나와 도메인 예시만 제공.**

## 페르소나

한 발 떨어져서 전략적으로. 항상 숫자/스케일/비즈니스 임팩트를 묻는다.

## 도메인 특화 예시

### 전략적 의사결정

개발자:
```
{서비스} 아키텍처가 {특징}인데, 이 구조는 누가 잡은 거야?
1) 내가 제안해서 밀었음
2) 기존 구조 유지하면서 부분 개선
3) 아키텍처 결정에 관여 안 했음
```

디자이너:
```
{서비스} 디자인 방향이 {특징}인데, 누가 잡은 거야?
1) 내가 제안해서 밀었음
2) 기존 방향 유지하면서 부분 개선
3) 방향 결정에 관여 안 했음
```

### 비즈니스 임팩트

개발자:
```
{프로젝트}에서 {기술 작업} 했다고 했는데, 비즈니스 지표에 얼마나 찍혔어?
1) 전환율/이탈률 개선 — 수치 있음
2) 서버 비용/응답 시간 절감 — 수치 있음
3) 체감은 있었는데 측정은 안 했음
```

마케터:
```
{캠페인} 예산이 월 {N}인데 네가 운영한 결과는?
1) ROAS/CPA 개선 — 수치 있음
2) 신규 유저 획득 — 수치 있음
3) 체감은 있었는데 정확한 수치는 없음
```

### 스케일 검증

```
{회사}가 {MAU}인데 네가 담당한 부분은 전체에서 어디였어?
1) 핵심 경로 (메인 서비스, 주력 상품)
2) 내부 도구/백오피스
3) 신규 서비스/실험
```

## So What 체인 모드 예시

`agent-contract.md §5.4` 규칙 적용. 레벨별:

**Level 1 (직접 결과)**:
```
{action} 했다고 했는데, 이거 하고 나서 바로 뭐가 달라졌어?
1) {구체 결과 A}
2) {구체 결과 B}
3) 거기까지였음
```

**Level 2 (팀/조직 영향)**: Level 1 답변을 질문에 반드시 포함.

**Level 3 (비즈니스 지표)**: 매출/비용/전환율/시간 절감 선택지.

## 관점 전환 모드 예시 (문제해결 / 성과)

`agent-contract.md §5.3` 규칙 적용.

문제해결 (상사/CTO):
```
{scene_hint}에서, 네 상사가 이 문제 해결을 경영진한테 보고할 때 뭐라고 했을 것 같아?
1) "이 사람이 핵심 기술 판단을 해서 해결됐다"
2) "이 사람이 주도해서 팀이 빠르게 대응"
3) 특별히 보고할 정도는 아니었을 듯
```

성과 (고객/비즈니스 오너):
```
{project} 런칭 후 {scene_hint} 때 주요 고객이 뭐라고 했을 것 같아?
1) "이 기능 덕분에 비용/시간이 확 줄었다"
2) "이거 없었으면 우리 사업 못 했다"
3) 특별히 언급할 정도는 아니었을 듯
```
````

- [ ] **Step 2: 줄 수 확인**

Run:
```bash
wc -l plugins/resume/.claude/agents/c-level.md
```

Expected: 약 75-90줄.

- [ ] **Step 3: 커밋**

```bash
git add plugins/resume/.claude/agents/c-level.md
git commit -m "$(cat <<'EOF'
refactor(resume): c-level.md 축소 — So What/관점 전환은 contract 참조

225줄 → 85줄. 공통 규칙 / So What 체인 상세 / 관점 전환 상세를
agent-contract.md로 위임. 페르소나와 4개 도메인 예시(의사결정 /
임팩트 / 스케일 / So What / 관점 전환) 남김.

Phase 1/7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.6: recruiter.md 축소

**Files:**
- Modify: `plugins/resume/.claude/agents/recruiter.md`

- [ ] **Step 1: 전체 재작성**

Write this exact content to `plugins/resume/.claude/agents/recruiter.md`:

````markdown
---
description: "JD 매칭, 시장 경쟁력 분석, 갭 분석 인터뷰어. 이력이 부족하면 솔직하게 팩폭."
model: claude-sonnet
tools: Read
---

# 채용담당자

너는 경력 채용 전문가다. 수백 명 이력서를 검토해왔다. 유저 경험을 JD에 맞춰 평가하고, 부족하면 솔직하게 말한다.

**첫 호출 시 `plugins/resume/skills/resume-panel/references/agent-contract.md`를 Read하고 §1~7 전체를 따른다.**

## 페르소나

사실 기반으로 끊어서 판단. 위로 없음. "~없어", "~어려움", "~어느 쪽?" 체.

## 도메인 특화 예시

### JD 갭 발굴

```
JD에 '{요구사항}' 필수인데 관련 에피소드가 아직 없어.
1) 있는데 아직 안 말한 거
2) 진짜 없음
```

### 팩폭 ("진짜 없음" 답변 시)

```
솔직히 말하면, {타겟 포지션} {연차}에 {요구사항} 경험이 없으면 서류 통과가 어려움.
이 레벨 합격자들은 보통: {시장 기준선 설명}.
갭으로 기록할게.
```

### 나이/연차 기반 현실 체크

```
{나이}세에 {타겟 회사} {포지션}이면, 시장 기준으로 이 정도가 기대됨:
- {기대 항목1}
- {기대 항목2}
{충족}은 있는데 {부족}이 약해. {부족} 관련해서,
1) {발굴 가능한 경험1}
2) {발굴 가능한 경험2}
```

### 이력 과소평가 발견

```
{회사}에서 {서비스} 담당이면, {MAU} 규모의 {역할}을 한 거잖아.
이거 이력서에 '{강화된 표현}'으로 써야 함.
'{유저의 원래 표현}'이라고 쓰면 임팩트가 안 보임.
```

## 갭 분석 산출 형식

Round 2에서 오케스트레이터가 갭 분석을 요청하면 JSON 별도 필드(questions 아님)로 리턴:

```json
{
  "gap_analysis": {
    "met": [
      { "requirement": "...", "evidence": "..." }
    ],
    "gaps": [
      { "requirement": "...", "market_standard": "...", "suggestion": "..." }
    ],
    "verdict": "한 문단. 솔직한 합격 가능성 평가."
  }
}
```
````

- [ ] **Step 2: 줄 수 확인**

Run:
```bash
wc -l plugins/resume/.claude/agents/recruiter.md
```

Expected: 약 55-70줄.

- [ ] **Step 3: 커밋**

```bash
git add plugins/resume/.claude/agents/recruiter.md
git commit -m "$(cat <<'EOF'
refactor(resume): recruiter.md 축소 — contract 참조

122줄 → 65줄. 공통 규칙 제거, 페르소나 + 4개 도메인 예시(JD 갭 /
팩폭 / 연차 체크 / 과소평가) + 갭 분석 산출 JSON 포맷 남김.

Phase 1/7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.7: hr.md 축소

**Files:**
- Modify: `plugins/resume/.claude/agents/hr.md`

- [ ] **Step 1: 전체 재작성**

Write this exact content to `plugins/resume/.claude/agents/hr.md`:

````markdown
---
description: "소프트스킬 / 리더십 / 협업 인터뷰어. 갭 프로빙 · 관점 전환(리더십·협업) 모드도 담당."
model: claude-sonnet
tools: Read
---

# 인사담당자

너는 인사팀 10년차 담당자다. 전문성 외에 조직에서의 역할, 리더십, 협업 경험을 발굴한다.

**첫 호출 시 `plugins/resume/skills/resume-panel/references/agent-contract.md`를 Read하고 §1~7 전체를 따른다. 갭 프로빙(§5.2), 관점 전환(§5.3)은 contract 참조 — 본 파일은 페르소나와 도메인 예시.**

## 페르소나

상황을 먼저 세팅하고 역할을 묻는다. "~일 때", "~상황에서", "~뭐였어?" 체.

## 도메인 특화 예시

### 리더십 발굴

```
{회사} {팀}이 {N}명 규모였는데, 주니어가 들어왔을 때 네 역할이 뭐였어?
1) 온보딩 직접 담당
2) 업무 리뷰/피드백으로 가이드
3) 직접 관여 안 했음
```

### 갈등 / 협업 발굴

```
{프로젝트}에서 다른 팀과 협업할 때, 제일 많이 부딪힌 상황이 뭐였어?
1) 기획/디자인 팀과 스펙 조율
2) 다른 실무 팀과 요구사항 협의
3) 외부 파트너/벤더와 소통
```

### 프로세스 개선

```
{회사}에서 {기간} 동안 있으면서, 업무 프로세스 중에 네가 바꾼 게 있어?
1) 핵심 업무 프로세스 개선 주도
2) 품질 관리 프로세스 도입
3) 문서화 체계 구축
```

### 반복 일상 패턴 옵션 (리더십/협업 공통)

`agent-contract.md §4-5` 원칙 적용:
```
{회사} {팀}에서 주니어나 신입 합류 시 가장 많이 한 역할이 뭐였어?
1) {특정 사람 온보딩 주도 — 단일 사건}
2) {특정 갈등 조율 — 단일 사건}
3) 특정 사건보다 평소 반복된 루틴 (정기 1on1, 리뷰 담당 등)
```

3) 선택 시 후속 "그 루틴 한 가지 — 주기, 참여 인원, 판단 기준은?" 연결.

## 갭 프로빙 모드 예시

`agent-contract.md §5.2` 규칙 적용.

inter_company:
```
{이전회사} {이전프로젝트} 끝나고 {다음회사} {다음프로젝트} 시작 전에 {N}개월 있었는데, 이 기간에 뭐 했어?
1) 이직 준비하면서 사이드 프로젝트나 공부
2) 프리랜서/컨설팅 같은 단기 일
3) 이 기간은 건너뛰기
```

intra_company:
```
{회사} 안에서 {이전프로젝트} 끝나고 {다음프로젝트} 들어가기까지 {N}개월 걸렸는데, 그 사이에 뭐 했어?
1) 부서 이동이나 역할 전환
2) 다른 내부 프로젝트에 짧게 참여
3) 이 기간은 건너뛰기
```

## 관점 전환 모드 예시 (리더십 / 협업)

`agent-contract.md §5.3` 규칙 적용.

리더십 (주니어 관점):
```
{scene_hint}에서, 팀에 새로 온 주니어가 너를 보고 뭐라고 했을 것 같아?
1) "저 사람이 이 프로젝트 방향 잡은 사람이구나"
2) "기술적으로 막힐 때마다 저 사람한테 가면 됐다"
3) 딱히 그런 인상은 없었을 듯
```

협업 (PM 관점):
```
{project}에서 같이 일한 PM이 {scene_hint} 때 너에 대해 뭐라고 했을 것 같아?
1) "이 사람 덕분에 일정이 당겨졌다"
2) "기획 의도를 제일 잘 이해하고 구현해줬다"
3) 특별히 언급할 정도는 아니었을 듯
```
````

- [ ] **Step 2: 줄 수 확인**

Run:
```bash
wc -l plugins/resume/.claude/agents/hr.md
```

Expected: 약 85-100줄.

- [ ] **Step 3: 커밋**

```bash
git add plugins/resume/.claude/agents/hr.md
git commit -m "$(cat <<'EOF'
refactor(resume): hr.md 축소 — 갭 프로빙/관점 전환은 contract 참조

189줄 → 95줄. 공통 규칙 / 갭 프로빙 상세 / 관점 전환 상세를
agent-contract.md로 위임. 페르소나와 도메인 예시(리더십 / 협업 /
프로세스 / 반복 패턴 / 갭 프로빙 / 관점 전환) 남김.

Phase 1/7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.8: coffee-chat.md 정렬

**Files:**
- Modify: `plugins/resume/.claude/agents/coffee-chat.md`

- [ ] **Step 1: 전체 재작성 (contract 참조 명시)**

Write this exact content to `plugins/resume/.claude/agents/coffee-chat.md`:

````markdown
---
description: "커피챗 페르소나 템플릿. 오케스트레이터가 유저 직군에 맞는 유명인 페르소나를 생성하여 호출."
model: claude-sonnet
tools: Read
---

# 커피챗: {페르소나 이름}

너는 {페르소나 이름}이다. {페르소나 배경 1-2문장, 오케스트레이터 전달}.

**첫 호출 시 `plugins/resume/skills/resume-panel/references/agent-contract.md`를 Read하고 §1~7 전체를 따른다.**

## 성격

{오케스트레이터가 생성한 성격 특징 3개}

## 질문 스타일

{페르소나 이름}답게 캐주얼하게 묻되, `agent-contract.md §2` 출력 포맷을 준수. 캐주얼해도 **구체적 선택지 필수**. 서사형 질문은 `free_form: true`.

```
{페르소나의 경험을 자연스럽게 언급하며 질문}
1) {구체적 경험1}
2) {구체적 경험2}
3) {대안}
— {마무리 질문}
```

리서처 팩트는 대화에 자연스럽게 녹인다 (억지 인용 피하기).
````

- [ ] **Step 2: 줄 수 확인**

Run:
```bash
wc -l plugins/resume/.claude/agents/coffee-chat.md
```

Expected: 약 25-30줄.

- [ ] **Step 3: 커밋**

```bash
git add plugins/resume/.claude/agents/coffee-chat.md
git commit -m "$(cat <<'EOF'
refactor(resume): coffee-chat.md — contract 참조 명시

34줄 → 28줄. 공통 규칙 중복 제거하고 페르소나 슬롯 + 스타일 템플릿만
남김. Phase 2에서 JSON 포맷 지시는 contract §2에서 자동 적용.

Phase 1/7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 1.9: Phase 1 검증

**Files:** (read-only)

- [ ] **Step 1: 파일 줄 수 집계**

Run:
```bash
wc -l plugins/resume/skills/resume-panel/SKILL.md \
      plugins/resume/skills/resume-panel/references/agent-contract.md \
      plugins/resume/skills/resume-panel/references/gates.md \
      plugins/resume/.claude/agents/{senior,c-level,recruiter,hr,coffee-chat}.md
```

Expected totals (허용 오차 ±15%):
- SKILL.md: ~250
- agent-contract.md: ~180
- gates.md: ~65
- senior.md: ~65
- c-level.md: ~85
- recruiter.md: ~65
- hr.md: ~95
- coffee-chat.md: ~28
- **합계**: ~830줄 (Before Phase 1: 1094 + 142 + 225 + 122 + 189 + 34 = 1806줄)
- **순 감소**: ~975줄

- [ ] **Step 2: 핵심 기능 누락 없음 확인 (grep 스팟체크)**

Run:
```bash
grep -l "리서처 팩트" plugins/resume/skills/resume-panel/references/agent-contract.md
grep -l "서사형" plugins/resume/skills/resume-panel/references/agent-contract.md
grep -l "반복 일상 패턴\|반복된 일상\|반복된 루틴\|반복된 결정" plugins/resume/skills/resume-panel/references/agent-contract.md
grep -l "갭 프로빙" plugins/resume/skills/resume-panel/references/agent-contract.md
grep -l "관점 전환" plugins/resume/skills/resume-panel/references/agent-contract.md
grep -l "So What" plugins/resume/skills/resume-panel/references/agent-contract.md
grep -l "재프로빙" plugins/resume/skills/resume-panel/references/agent-contract.md
```

Expected: 전부 `.../agent-contract.md` 경로 출력.

Run:
```bash
grep -l "화이트리스트\|오케스트레이터 직접 질문 허용" plugins/resume/skills/resume-panel/SKILL.md
```

Expected: `plugins/resume/skills/resume-panel/SKILL.md` 출력.

- [ ] **Step 3: 에이전트 contract 참조 무결성**

Run:
```bash
for f in plugins/resume/.claude/agents/{senior,c-level,recruiter,hr,coffee-chat}.md; do
  grep -q "agent-contract.md" "$f" || echo "MISSING contract ref: $f"
done
```

Expected: 출력 없음 (모든 에이전트가 contract 참조).

- [ ] **Step 4: 기존 hook 테스트 무손상 확인**

Run:
```bash
node plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: 전부 PASS.

- [ ] **Step 5: Phase 1 체크포인트 커밋 (검증 결과만 포함, 파일 변경 없음)**

Phase 1 검증이 전부 통과하면 별도 커밋은 없고 다음 Phase 진입. 실패 시 해당 Task로 복귀.

---

## Phase 2 — JSON 프로토콜 전환 (에이전트 ↔ 오케스트레이터, hook ↔ 오케스트레이터)

### Task 2.1: agent-contract.md에 JSON 포맷 확정 + 레거시 섹션 제거

**Files:**
- Modify: `plugins/resume/skills/resume-panel/references/agent-contract.md`

- [ ] **Step 1: `§2.2 레거시 포맷` 섹션 삭제**

Open `plugins/resume/skills/resume-panel/references/agent-contract.md` and delete the entire `### 2.2 레거시 포맷 (Phase 1 동안만)` section (the 5 lines under it including the code block).

- [ ] **Step 2: `§2.1 JSON 스키마` 다음에 JSON 예시 섹션 추가**

Add this block immediately after the `§2.1` content (before `## 3. 반드시 지킬 것`):

```markdown
### 2.2 JSON 예시 — 단일 질문

```json
{
  "questions": [
    {
      "header": "시니어",
      "question": "Kafka 도입한 거 봤는데, 이거 직접 밀었어 아니면 이미 있던 거야?",
      "options": [
        { "label": "제안 도입", "description": "내가 제안해서 도입" },
        { "label": "기존 활용", "description": "기존에 있었고 활용만" },
        { "label": "마이그레이션", "description": "마이그레이션 작업" }
      ],
      "free_form": false
    }
  ]
}
```

### 2.3 JSON 예시 — 배치 (관련 주제 2개)

```json
{
  "questions": [
    {
      "header": "시니어",
      "question": "Kafka 파티션 전략은 누가 정했어?",
      "options": [
        { "label": "내가 설계", "description": "내가 설계" },
        { "label": "기존 유지", "description": "기존 설계 유지" },
        { "label": "팀 합의", "description": "팀 논의 후 합의" }
      ],
      "free_form": false
    },
    {
      "header": "시니어",
      "question": "Consumer lag 모니터링은 어떻게 했어?",
      "options": [
        { "label": "전용 툴", "description": "Burrow 같은 전용 툴" },
        { "label": "Prom+Grafana", "description": "Prometheus + Grafana" },
        { "label": "없음", "description": "별도 모니터링 안 함" }
      ],
      "free_form": false
    }
  ]
}
```

### 2.4 JSON 예시 — 서사형 (free_form)

```json
{
  "questions": [
    {
      "header": "채용담당자",
      "question": "왜 {이전 직무}에서 {현재 직무}로 바꾸게 됐어? 특히 어떤 계기가 있었는지 궁금해.",
      "free_form": true
    }
  ]
}
```

### 2.5 출력 전달 규칙 (에이전트가 지킬 것)

- 에이전트 응답 본문은 **JSON만**. 앞/뒤에 설명 텍스트 금지.
- 만약 컨텍스트 부족 등으로 질문을 생성할 수 없으면:
  ```json
  { "error": "cannot_generate", "reason": "리서처 팩트 없음" }
  ```
  을 리턴. 오케스트레이터가 컨텍스트를 보강하여 재호출한다.
```

- [ ] **Step 3: 파일 확인**

Run:
```bash
grep -c '^### 2\.' plugins/resume/skills/resume-panel/references/agent-contract.md
```

Expected: `5` (§2.1 ~ §2.5).

Run:
```bash
grep -c "레거시" plugins/resume/skills/resume-panel/references/agent-contract.md
```

Expected: `0` (레거시 섹션 삭제됨).

- [ ] **Step 4: 커밋**

```bash
git add plugins/resume/skills/resume-panel/references/agent-contract.md
git commit -m "$(cat <<'EOF'
refactor(resume): agent-contract JSON 포맷 확정 + 예시 추가

§2.1 JSON 스키마 외 §2.2 단일 예시, §2.3 배치 예시, §2.4 free_form
예시, §2.5 출력 전달 규칙(JSON-only, error 응답) 추가. Phase 1
동안 유지했던 §2.2 레거시 포맷 섹션 제거.

Phase 2/7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2.2: askuserquestion.md JSON 파싱으로 재작성

**Files:**
- Modify: `plugins/resume/skills/resume-panel/references/askuserquestion.md`

- [ ] **Step 1: 전체 재작성**

Write this exact content to `plugins/resume/skills/resume-panel/references/askuserquestion.md`:

````markdown
# AskUserQuestion — JSON 변환, 폴백

## 변환 절차

에이전트 응답 = JSON 문자열 (`agent-contract.md §2` 참조). 오케스트레이터는:

1. **파싱**: `JSON.parse(response)`
2. **에러 응답 처리**: `{ "error": "cannot_generate", ... }` 인 경우 오케스트레이터가 컨텍스트 보강 후 에이전트 재호출. 유저에게 전달 안 함.
3. **`questions` 배열 순회**:
   - 각 원소가 `free_form: true`면 → AskUserQuestion 생략, `question` 필드를 평문으로 출력.
   - `free_form: false`면 → AskUserQuestion question 배열에 그대로 변환.
4. **AskUserQuestion 호출 파라미터**:
   - `questions`: `free_form: false` 원소들의 `{ question, header, options, multiSelect: false }` 배열 (최대 3개)
5. **답변 처리**:
   - 유저가 선택지 클릭 → 해당 옵션의 `description` 텍스트를 에이전트 답변으로 사용
   - 유저가 "Other" 선택 + 자유 입력 → 입력 텍스트를 에이전트 답변으로 사용
   - `free_form: true` 평문 응답 → 유저 입력 전체를 답변으로 사용

## multiSelect

항상 `false`. 인터뷰 질문은 단일 선택.

## allowed-tools 금지

**AskUserQuestion을 SKILL.md frontmatter의 `allowed-tools`에 절대 추가하지 않는다** (bug #29547 — 빈 응답 자동 완성).

## 폴백

AskUserQuestion 호출이 실패하는 경우 (빈 응답, 에러, 타임아웃, **유저가 reject/dismiss/취소**):

1. **reject 감지**: "취소", "아니 다시", "잘못 눌렀어", "다시 띄워줘" 또는 빈 문자열/null/"interrupted" 응답 → reject로 간주
2. 즉시 "셀렉트 박스 로딩에 문제가 생겼어요. 다시 시도할게요." 메시지 표시
3. 동일 파라미터로 1회 자동 재시도
4. 재시도도 실패하면 텍스트 모드 폴백:
   - "텍스트로 답변해주세요." 메시지
   - 원래 JSON의 `questions[i].question` 및 `options[j].description`을 번호 리스트로 렌더:
     ```
     [{header}] {question}
       1) {option 1 description}
       2) {option 2 description}
       3) {option 3 description}
     번호를 입력하거나 자유롭게 답변해주세요.
     ```
   - 유저가 번호 입력 → 해당 옵션 선택
   - 자유 텍스트 → `free_form` 답변으로 처리

**재시도 상한**: 자동 재시도는 1회. 2번 연속 실패하면 텍스트 폴백. 3회 이상 반복 호출하지 않는다 (무한 재시도 방지).

## JSON 파싱 실패 시

에이전트 응답이 유효 JSON이 아니면 (Phase 2 초기 드문 케이스):

1. 오케스트레이터는 "JSON 응답 포맷이 아니야. 다시 생성해줘" 메시지와 함께 에이전트 재호출 (1회)
2. 재호출도 실패하면 해당 에이전트 응답을 평문으로 유저에게 표시 (레거시 우회). 회고에 `json_parse_failure` 이벤트 기록.
````

- [ ] **Step 2: 파일 확인**

Run:
```bash
wc -l plugins/resume/skills/resume-panel/references/askuserquestion.md
```

Expected: 약 50-65줄.

Run:
```bash
grep -c "정규식\|regex\|N) 패턴" plugins/resume/skills/resume-panel/references/askuserquestion.md
```

Expected: `0` (regex 파싱 언급 전부 삭제).

- [ ] **Step 3: 커밋**

```bash
git add plugins/resume/skills/resume-panel/references/askuserquestion.md
git commit -m "$(cat <<'EOF'
refactor(resume): askuserquestion.md — JSON 파싱으로 재작성

정규식 파싱(`[에이전트명] ... N) 옵션`) 절차 삭제. JSON.parse →
questions 배열 순회 → free_form 분기 → AskUserQuestion 호출로 단순화.
폴백과 JSON 파싱 실패 케이스 명시.

Phase 2/7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2.3: hook-messages.md → hook-protocol.md rename + JSON 타입 정의

**Files:**
- Rename: `plugins/resume/skills/resume-panel/references/hook-messages.md` → `hook-protocol.md`
- Modify: 내용 전체 재작성

- [ ] **Step 1: git mv**

Run:
```bash
git mv plugins/resume/skills/resume-panel/references/hook-messages.md \
       plugins/resume/skills/resume-panel/references/hook-protocol.md
```

- [ ] **Step 2: 전체 재작성**

Write this exact content to `plugins/resume/skills/resume-panel/references/hook-protocol.md`:

````markdown
# Hook Protocol — additionalContext JSON 메시지

`episode-watcher.mjs`가 PostToolUse hook에서 `additionalContext`로 보내는 메시지는 **단일 라인 JSON**이고 `[resume-panel]` 프리픽스가 붙는다. 오케스트레이터는 프리픽스를 떼고 `JSON.parse` 후 `type` 필드로 분기.

## 메시지 구조

```
[resume-panel]{"type":"...", ...payload}
```

복수 메시지는 줄바꿈 2개로 구분.

## 메시지 타입

### 1. `profiler_trigger`

프로파일러 점수가 임계값을 넘으면 발행.

```json
{
  "type": "profiler_trigger",
  "delta": "에피소드 +3, 새 프로젝트",
  "score": 6,
  "episode_count": 12,
  "star_gaps": 2,
  "project_count": 4,
  "pattern_eligible": true
}
```

**처리**: 프로파일러를 백그라운드 Agent로 호출. `pattern_eligible: true`면 프롬프트에 "패턴 분석 가능" 포함. 인터뷰는 계속.

### 2. `finding`

프로파일러/리서처 등이 발견한 finding.

```json
{
  "type": "finding",
  "urgency": "HIGH|MEDIUM|LOW",
  "finding_type": "contradiction_detected|timeline_gap_found|pattern_detected|perspective_shift|gap_detected|impact_shallow",
  "id": "cd-abc123",
  "message": "역할 모순 발견: ...",
  "context": { ... finding_type별 페이로드 ... }
}
```

**처리 분기 (finding_type)**:

- `contradiction_detected` (HIGH): 모순 복원 — 오케스트레이터가 AskUserQuestion으로 직접 복원 질문 (화이트리스트 case 3)
- `timeline_gap_found` (MEDIUM): hr 에이전트 갭 프로빙 모드 호출
- `pattern_detected` (MEDIUM): 패턴을 다음 에이전트 브리핑의 "발견된 패턴" 섹션에 포함 (즉시 질문 안 함). `context.target_agent`가 있으면 그 에이전트 우선.
- `perspective_shift` (MEDIUM): `context.target_agent`를 관점 전환 모드로 호출
- `gap_detected` (HIGH): 화이트리스트 메타질문 (관련 경험 있음 / 진짜 없음 / 넘어가기)
- `impact_shallow` (LOW): 전달 안 함. 유저가 "분석해줘" 시 Read.

**세션 한도**: 오케스트레이터는 `meta.json.session_limits[finding_type].used >= max`이면 조용히 무시.

### 3. `so_what`

임팩트 부족 에피소드 감지 시.

```json
{
  "type": "so_what",
  "episode_title": "...",
  "level": 1,
  "episode_ref": { "company": "...", "project": "..." }
}
```

**처리**: meta.json `so_what_active` 설정 → C-Level을 So What 체인 모드로 호출 (agent-contract §5.4). multi-turn이므로 체인 완료까지 일반 플로우 중단.

### 4. `gate_violation` (Phase 3부터 활성)

게이트 위반 감지 시.

```json
{
  "type": "gate_violation",
  "gate": "r1_entry|direct_question_burst|r2_exit|retrospective_skipped",
  "company": "...",
  "count": 3,
  "missing": ["hr", "turn_min"]
}
```

**처리**: `gates.md` §G1~G4 각각의 "복귀 액션" 수행.

### 5. LOW finding

hook에서 전달하지 않음. 유저가 "분석해줘/리뷰해줘" 요청 시 `.resume-panel/findings.json`을 Read하여 제시.

## 인터뷰 흐름 보호

- HIGH: 현재 질문-답변 사이클 완료 후 끼워넣기
- MEDIUM: 현재 프로젝트/회사 에피소드 수집 끝난 후 끼워넣기
- LOW: 전달 안 함
- SO-WHAT: 체인 완료(거기까지였음 또는 Level 3)까지 일반 플로우 중단
- 동시 도착 시 우선순위: `so_what` > `gate_violation` > `finding(HIGH)` > `finding(MEDIUM)`
- `so_what_active` 동안 추가 `so_what` 메시지 무시

## 세션 한도 참조

`meta.json.session_limits`:
- `gaps.max = 3`
- `perspectives.max = 2`
- `contradictions.max = 2`

초과 시 hook에서는 발행을 억제하지 않지만 오케스트레이터가 무시. (Phase 3 목표: hook에서도 발행 억제)

## 모순 복원 (HIGH contradiction_detected) 처리 패턴

오케스트레이터가 화이트리스트 case 3으로 AskUserQuestion 호출:

```javascript
AskUserQuestion({
  questions: [{
    question: "아까 이야기랑 연결해보면, {에피소드A}에서는 {claim_a.text 요약}라고 했는데 {에피소드B}에서는 {claim_b.text 요약}라고 했거든. 실제로는 어디까지 한 거야?",
    header: "연결 확인",
    options: [
      { label: "{큰 역할}", description: "{큰 역할 claim 본문}" },
      { label: "{작은 역할}", description: "{작은 역할 claim 본문}" },
      { label: "상황이 달랐음", description: "두 에피소드 맥락이 달라서 역할이 다른 것" }
    ],
    multiSelect: false
  }]
})
```

응답 처리:
- 큰 역할 선택 → 작은 claim 에피소드의 `claim_b.star_field` 필드를 큰 역할 내용으로 업데이트
- 작은 역할 선택 → 큰 claim 에피소드의 `claim_a.star_field` 필드를 작은 역할 내용으로 업데이트
- "상황이 달랐음" 선택 → 업데이트 없음

업데이트 방법은 `references/storage.md` §부분 업데이트 참조. `session_limits.contradictions.used++`.

## 갭 프로빙 (MEDIUM timeline_gap_found) 처리 패턴

1. `meta.json.intentional_gaps`에 이미 있으면 무시
2. hr 에이전트를 갭 프로빙 모드로 호출 (agent-contract §5.2)
3. 응답 처리:
   - 건너뛰기 → `intentional_gaps` 배열에 `{from, to, marked_at}` append
   - 실질 답변 → 에피소드 추출 저장 + hr 일반 모드 후속 1-2회

`session_limits.gaps.used++`.

## 관점 전환 (MEDIUM perspective_shift) 처리 패턴

1. `session_limits.perspectives.episode_refs`에 이미 있으면 무시
2. `context.target_agent`를 관점 전환 모드로 호출 (agent-contract §5.3)
3. 응답 처리:
   - 겸손 옵션 선택 → `episode_refs`에 `episode_ref` 추가
   - 업그레이드 옵션 → 일반 모드로 후속 1회 가능 + `episode_refs` 추가

`session_limits.perspectives.used++`.
````

- [ ] **Step 3: 파일 확인**

Run:
```bash
wc -l plugins/resume/skills/resume-panel/references/hook-protocol.md
ls plugins/resume/skills/resume-panel/references/ | grep -i 'hook'
```

Expected:
- wc ≈ 150-190줄
- ls: `hook-protocol.md`만 (hook-messages.md는 rename됨)

- [ ] **Step 4: 커밋**

```bash
git add plugins/resume/skills/resume-panel/references/hook-protocol.md
git add -u plugins/resume/skills/resume-panel/references/hook-messages.md  # rename deletion
git commit -m "$(cat <<'EOF'
refactor(resume): hook-protocol.md rename + JSON 메시지 타입 정의

hook-messages.md → hook-protocol.md. 자연어 키워드 파싱("공백+개월",
"패턴 발견", "모순 발견", "역할 모순") 전부 제거. JSON `type` 필드
+ `finding_type` 기반 분기로 교체. gate_violation 메시지 타입 선반영
(Phase 3에서 hook이 실제 발행).

Phase 2/7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2.4: episode-watcher.mjs — `additionalContext`를 JSON으로 전환

**Files:**
- Modify: `plugins/resume/scripts/episode-watcher.mjs`
- Modify: `plugins/resume/scripts/test-episode-watcher.mjs`

- [ ] **Step 1: 테스트 먼저 작성 (TDD) — JSON 프로토콜 기대**

Edit `plugins/resume/scripts/test-episode-watcher.mjs`, append at the bottom before the final `console.log`/exit:

```javascript
// ── Phase 2 JSON 프로토콜 테스트 ──────────────────────
// Test Phase 2.1: profiler_trigger 메시지가 [resume-panel]{"type":"profiler_trigger"}... 형태인지 확인
{
  // setup: snapshot + resume-source.json with episodes
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  writeFileSync("/tmp/test-resume-panel/.resume-panel/snapshot.json", JSON.stringify({
    episode_count: 0, project_names: [], meta_hash: "initial", star_gaps: 0, current_company: null
  }));
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({ profiler_score: 4 }));
  const source = {
    meta: { target_company: "T", target_position: "P" },
    companies: [{
      name: "C1", projects: [{
        name: "P1", episodes: [
          { title: "e1", action: "a1", result: "완료", situation: "s", task: "t" },
          { title: "e2", action: "a2", result: "10% 개선", situation: "s", task: "t" }
        ]
      }]
    }]
  };
  writeFileSync("/tmp/test-resume-panel/resume-source.json", JSON.stringify(source));

  const result = run({
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/tmp/test-resume-panel/resume-source.json" },
    cwd: "/tmp/test-resume-panel",
  });

  assert.ok(result, "should produce output when score crosses threshold");
  const ctx = result.hookSpecificOutput.additionalContext;
  const lines = ctx.split("\n\n").filter(Boolean);
  const profilerLine = lines.find(l => l.includes('"type":"profiler_trigger"'));
  assert.ok(profilerLine, `profiler_trigger JSON line missing. got: ${ctx}`);
  assert.ok(profilerLine.startsWith("[resume-panel]"), "prefix missing");
  const payload = JSON.parse(profilerLine.slice("[resume-panel]".length));
  assert.strictEqual(payload.type, "profiler_trigger");
  assert.ok(typeof payload.score === "number", "score should be number");
  assert.ok(typeof payload.episode_count === "number", "episode_count should be number");
  console.log("PASS: Phase 2.1 — profiler_trigger JSON format");
}

// Test Phase 2.2: timeline_gap_found finding도 JSON 형태
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  writeFileSync("/tmp/test-resume-panel/.resume-panel/snapshot.json", JSON.stringify({
    episode_count: 0, project_names: [], meta_hash: "initial", star_gaps: 0, current_company: null
  }));
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({ profiler_score: 4 }));
  // Two projects with 8-month gap
  const source = {
    meta: { target_company: "T", target_position: "P" },
    companies: [
      { name: "C1", projects: [{ name: "P1", period: "2018.01-2018.08",
        episodes: [{ title: "e1", action: "a", result: "10개 개선", situation: "s", task: "t" }] }] },
      { name: "C2", projects: [{ name: "P2", period: "2019.05-2019.12",
        episodes: [{ title: "e2", action: "a", result: "20% 개선", situation: "s", task: "t" }] }] }
    ]
  };
  writeFileSync("/tmp/test-resume-panel/resume-source.json", JSON.stringify(source));

  // First run: triggers profiler threshold + gap detection (writes to inbox)
  run({
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/tmp/test-resume-panel/resume-source.json" },
    cwd: "/tmp/test-resume-panel",
  });

  // Second run: inbox routing → finding emitted
  const result2 = run({
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/tmp/test-resume-panel/resume-source.json" },
    cwd: "/tmp/test-resume-panel",
  });

  // Note: MEDIUM findings require companyChanged signal — we don't test delivery here.
  // Just verify that if a finding is emitted, it's in JSON format.
  if (result2 && result2.hookSpecificOutput) {
    const ctx = result2.hookSpecificOutput.additionalContext;
    const findingLine = ctx.split("\n\n").find(l => l.includes('"type":"finding"'));
    if (findingLine) {
      const payload = JSON.parse(findingLine.slice("[resume-panel]".length));
      assert.strictEqual(payload.type, "finding");
      assert.ok(payload.finding_type, "finding_type required");
      assert.ok(["HIGH", "MEDIUM", "LOW"].includes(payload.urgency), "urgency valid");
      console.log("PASS: Phase 2.2 — finding JSON format");
    } else {
      console.log("SKIP: Phase 2.2 — finding not delivered this run (expected)");
    }
  } else {
    console.log("SKIP: Phase 2.2 — no output this run");
  }
}
```

- [ ] **Step 2: 테스트 실행 — 실패 확인 (FAIL)**

Run:
```bash
node plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: Phase 2.1 테스트가 FAIL. 이유: 현재 hook은 `[resume-panel] 프로파일러 호출 필요. delta: ...` 형태의 자연어를 보내므로 `"type":"profiler_trigger"` 문자열이 없음.

- [ ] **Step 3: episode-watcher.mjs 수정 — JSON 메시지로 전환**

현재 `messages.push(...)` 호출들을 모두 JSON payload로 교체.

Open `plugins/resume/scripts/episode-watcher.mjs` and replace the following blocks:

**교체 1**: `messages.push(` 로 시작하는 profiler_trigger 발행부 (현재 line ~266):

```javascript
// 임계값 체크
const THRESHOLD = 5;
let updatedMetaFields = {};
if (score >= THRESHOLD) {
  const starGaps = countStarGaps(source);
  messages.push(
    `[resume-panel] 프로파일러 호출 필요. delta: ${reasons.join(", ")}. 현재 총 에피소드 ${currentCount}개, 빈 STAR ${starGaps}개, 프로젝트 ${currentProjects.length}개. (score: ${score})`
  );
```

→

```javascript
// 임계값 체크
const THRESHOLD = 5;
let updatedMetaFields = {};
if (score >= THRESHOLD) {
  const starGaps = countStarGaps(source);
  const companyCount = getCompanyCount(source);
  const patternEligible = currentCount >= 3 && companyCount >= 2;
  messages.push(
    emit({
      type: "profiler_trigger",
      delta: reasons.join(", "),
      score,
      episode_count: currentCount,
      star_gaps: starGaps,
      project_count: currentProjects.length,
      pattern_eligible: patternEligible,
    })
  );
```

**교체 2**: `emit` 헬퍼 추가. 파일 상단 헬퍼 함수 구역 (예: `countEpisodes` 근처)에 추가:

```javascript
function emit(payload) {
  return `[resume-panel]${JSON.stringify(payload)}`;
}
```

**교체 3**: SO-WHAT 메시지 발행 (현재 line ~328):

```javascript
if (!hasQuantifiedImpact(ep.star?.result || ep.result || "")) {
  messages.push(
    `[resume-panel:SO-WHAT] 에피소드 "${ep.title || "(제목 없음)"}" 임팩트 부족`
  );
  break;
}
```

→

```javascript
if (!hasQuantifiedImpact(ep.star?.result || ep.result || "")) {
  messages.push(
    emit({
      type: "so_what",
      episode_title: ep.title || "(제목 없음)",
      level: 1,
      episode_ref: { company: project.companyName, project: project.name },
    })
  );
  break;
}
```

그리고 직후 break 감지 조건도 JSON 탐지로 변경:
```javascript
if (messages.some(m => m.includes("[resume-panel:SO-WHAT]"))) break;
```
→
```javascript
if (messages.some(m => m.includes('"type":"so_what"'))) break;
```

**교체 4**: findings 라우팅의 HIGH/MEDIUM 메시지 (현재 line ~388):

```javascript
if (f.urgency === "HIGH") {
  messages.push(`[resume-panel:HIGH] ${f.message}`);
  f.delivered = true;
} else if (f.urgency === "MEDIUM" && companyChanged) {
  messages.push(`[resume-panel:MEDIUM] ${f.message}`);
  f.delivered = true;
}
```

→

```javascript
if (f.urgency === "HIGH") {
  messages.push(
    emit({
      type: "finding",
      urgency: "HIGH",
      finding_type: f.type,
      id: f.id,
      message: f.message,
      context: f.context || {},
    })
  );
  f.delivered = true;
} else if (f.urgency === "MEDIUM" && companyChanged) {
  messages.push(
    emit({
      type: "finding",
      urgency: "MEDIUM",
      finding_type: f.type,
      id: f.id,
      message: f.message,
      context: f.context || {},
    })
  );
  f.delivered = true;
}
```

- [ ] **Step 4: 테스트 재실행 — PASS 확인**

Run:
```bash
node plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: 기존 테스트 전부 PASS + `PASS: Phase 2.1 — profiler_trigger JSON format` 추가.

- [ ] **Step 5: 커밋**

```bash
git add plugins/resume/scripts/episode-watcher.mjs plugins/resume/scripts/test-episode-watcher.mjs
git commit -m "$(cat <<'EOF'
refactor(hook): additionalContext를 JSON 메시지로 전환

profiler_trigger / so_what / finding 세 메시지 타입 전부 자연어
문자열에서 [resume-panel]{JSON} 형식으로 전환. 오케스트레이터가
키워드 파싱("공백+개월", "모순 발견") 대신 payload.type/finding_type
기반으로 분기 가능.

TDD: Phase 2.1/2.2 테스트 추가 → 실패 확인 → 구현 → 통과.

Phase 2/7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2.5: Phase 2 검증

**Files:** (read-only)

- [ ] **Step 1: references 디렉토리 최종 확인**

Run:
```bash
ls -la plugins/resume/skills/resume-panel/references/
```

Expected:
```
agent-contract.md
askuserquestion.md
gates.md
hook-protocol.md
storage.md
```

(hook-messages.md 없음 확인)

- [ ] **Step 2: SKILL.md 참조 일관성**

Run:
```bash
grep -E "references/[a-z-]*\.md" plugins/resume/skills/resume-panel/SKILL.md
```

Expected: `hook-protocol.md` (not `hook-messages.md`).

- [ ] **Step 3: hook 전체 테스트 통과**

Run:
```bash
node plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: 모든 테스트 PASS.

- [ ] **Step 4: Phase 2 체크포인트**

변경된 파일 없이 다음 Phase 진입.

---

## Phase 3 — Hook 게이트 감시 + 세션 카운터 통합

### Task 3.1: meta.json 스키마 확장 (session_limits + gate_state)

**Files:**
- Modify: `plugins/resume/scripts/episode-watcher.mjs` (초기화 및 마이그레이션 로직)
- Modify: `plugins/resume/scripts/test-episode-watcher.mjs`

- [ ] **Step 1: 테스트 먼저 — 초기 meta.json이 session_limits/gate_state 포함해야 함**

Append to `plugins/resume/scripts/test-episode-watcher.mjs`:

```javascript
// ── Phase 3 meta.json 스키마 테스트 ──────────────────────
// Test Phase 3.1: meta.json 초기화 시 session_limits와 gate_state 포함
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  // no snapshot → first run will initialize
  const source = {
    meta: { target_company: "T", target_position: "P" },
    companies: [{ name: "C1", projects: [{ name: "P1", episodes: [] }] }]
  };
  writeFileSync("/tmp/test-resume-panel/resume-source.json", JSON.stringify(source));

  run({
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/tmp/test-resume-panel/resume-source.json" },
    cwd: "/tmp/test-resume-panel",
  });

  const meta = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", "utf-8"));
  assert.ok(meta.session_limits, "session_limits missing");
  assert.ok(meta.session_limits.gaps, "session_limits.gaps missing");
  assert.strictEqual(meta.session_limits.gaps.max, 3);
  assert.strictEqual(meta.session_limits.gaps.used, 0);
  assert.ok(Array.isArray(meta.session_limits.gaps.intentional), "gaps.intentional should be array");
  assert.strictEqual(meta.session_limits.perspectives.max, 2);
  assert.strictEqual(meta.session_limits.contradictions.max, 2);
  assert.ok(meta.gate_state, "gate_state missing");
  assert.strictEqual(meta.gate_state.direct_askuserquestion_streak, 0);
  assert.deepStrictEqual(meta.gate_state.agent_calls_in_current_round, {
    senior: 0, "c-level": 0, recruiter: 0, hr: 0, "coffee-chat": 0
  });
  console.log("PASS: Phase 3.1 — meta.json 초기 스키마");
}

// Test Phase 3.2: 기존 meta.json (구 스키마)의 마이그레이션
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  // 구 스키마
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({
    gap_probes_this_session: 1,
    perspective_shifts_this_session: 0,
    perspective_shifted_episodes: ["epA"],
    contradictions_presented_this_session: 2,
    reprobe_log: [{ area: "KB카드", timestamp: "2026-04-20T08:00:00Z" }],
    intentional_gaps: [{ from: "2018.09", to: "2019.05" }],
    profiler_score: 3,
  }));
  writeFileSync("/tmp/test-resume-panel/.resume-panel/snapshot.json", JSON.stringify({
    episode_count: 0, project_names: [], meta_hash: "x", star_gaps: 0, current_company: null
  }));
  const source = { meta: {}, companies: [] };
  writeFileSync("/tmp/test-resume-panel/resume-source.json", JSON.stringify(source));

  run({
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/tmp/test-resume-panel/resume-source.json" },
    cwd: "/tmp/test-resume-panel",
  });

  const meta = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", "utf-8"));
  assert.strictEqual(meta.session_limits.gaps.used, 1, "gaps.used migrated");
  assert.strictEqual(meta.session_limits.perspectives.used, 0, "perspectives.used migrated");
  assert.deepStrictEqual(meta.session_limits.perspectives.episode_refs, ["epA"]);
  assert.strictEqual(meta.session_limits.contradictions.used, 2, "contradictions.used migrated");
  assert.strictEqual(meta.session_limits.reprobes.log.length, 1, "reprobes.log migrated");
  assert.deepStrictEqual(meta.session_limits.gaps.intentional, [{ from: "2018.09", to: "2019.05" }]);
  // 구 필드 삭제 확인
  assert.strictEqual(meta.gap_probes_this_session, undefined, "old field should be removed");
  assert.strictEqual(meta.contradictions_presented_this_session, undefined, "old field should be removed");
  console.log("PASS: Phase 3.2 — meta.json 마이그레이션");
}
```

- [ ] **Step 2: 테스트 실행 (FAIL 확인)**

Run:
```bash
node plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: Phase 3.1 / 3.2 테스트가 FAIL.

- [ ] **Step 3: episode-watcher.mjs에 마이그레이션 로직 + 초기화 확장**

Open `plugins/resume/scripts/episode-watcher.mjs`.

상단 헬퍼 구역에 추가:

```javascript
function defaultSessionLimits() {
  return {
    gaps:           { used: 0, max: 3, intentional: [] },
    perspectives:   { used: 0, max: 2, episode_refs: [] },
    contradictions: { used: 0, max: 2 },
    reprobes:       { used: 0, log: [] },
  };
}

function defaultGateState() {
  return {
    direct_askuserquestion_streak: 0,
    agent_calls_in_current_round: {
      senior: 0, "c-level": 0, recruiter: 0, hr: 0, "coffee-chat": 0,
    },
    round_turn_counts: { "0": 0, "1": 0, "2": 0, "3": 0 },
    retrospective_invoked: false,
    last_askuserquestion_source: null,
  };
}

function migrateMeta(meta) {
  if (!meta) meta = {};
  // Already migrated?
  if (meta.session_limits && meta.gate_state) return meta;

  const migrated = { ...meta };

  // session_limits
  migrated.session_limits = defaultSessionLimits();
  if (typeof meta.gap_probes_this_session === "number") {
    migrated.session_limits.gaps.used = meta.gap_probes_this_session;
    delete migrated.gap_probes_this_session;
  }
  if (typeof meta.perspective_shifts_this_session === "number") {
    migrated.session_limits.perspectives.used = meta.perspective_shifts_this_session;
    delete migrated.perspective_shifts_this_session;
  }
  if (Array.isArray(meta.perspective_shifted_episodes)) {
    migrated.session_limits.perspectives.episode_refs = meta.perspective_shifted_episodes;
    delete migrated.perspective_shifted_episodes;
  }
  if (typeof meta.contradictions_presented_this_session === "number") {
    migrated.session_limits.contradictions.used = meta.contradictions_presented_this_session;
    delete migrated.contradictions_presented_this_session;
  }
  if (Array.isArray(meta.reprobe_log)) {
    migrated.session_limits.reprobes.log = meta.reprobe_log;
    migrated.session_limits.reprobes.used = meta.reprobe_log.length;
    delete migrated.reprobe_log;
  }
  if (Array.isArray(meta.intentional_gaps)) {
    migrated.session_limits.gaps.intentional = meta.intentional_gaps;
    delete migrated.intentional_gaps;
  }

  // gate_state
  migrated.gate_state = defaultGateState();

  return migrated;
}
```

"첫 실행" 블록 (line ~199 `if (!snapshot) { ... }`) 내부의 meta 쓰기 부분 교체:

```javascript
if (!metaJSON.profiler_score && metaJSON.profiler_score !== 0) {
  writeFileSync(metaPath, JSON.stringify({
    ...metaJSON,
    profiler_score: 0,
  }, null, 2));
}
```

→

```javascript
const metaMigrated = migrateMeta(metaJSON);
if (metaMigrated.profiler_score === undefined) metaMigrated.profiler_score = 0;
writeFileSync(metaPath, JSON.stringify(metaMigrated, null, 2));
```

"임계값 초과 후 meta 재저장" 블록 (line ~348 근처):

```javascript
writeFileSync(metaPath, JSON.stringify({
  ...metaJSON,
  ...updatedMetaFields,
  profiler_score: score,
}, null, 2));
```

→

```javascript
const metaMigrated = migrateMeta(metaJSON);
writeFileSync(metaPath, JSON.stringify({
  ...metaMigrated,
  ...updatedMetaFields,
  profiler_score: score,
}, null, 2));
```

- [ ] **Step 4: 테스트 재실행 (PASS)**

Run:
```bash
node plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: 모든 테스트 PASS including Phase 3.1, 3.2.

- [ ] **Step 5: 커밋**

```bash
git add plugins/resume/scripts/episode-watcher.mjs plugins/resume/scripts/test-episode-watcher.mjs
git commit -m "$(cat <<'EOF'
feat(hook): meta.json session_limits + gate_state 스키마 통합

흩어진 카운터 6개(gap_probes/perspective_shifts/perspective_shifted_episodes/
contradictions_presented/reprobe_log/intentional_gaps)를
session_limits 한 객체로 통합. gate_state 초기화 추가.
기존 meta.json 자동 마이그레이션.

TDD로 초기화/마이그레이션 2개 케이스 테스트.

Phase 3/7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3.2: hooks.json matcher 확장 (Task + AskUserQuestion)

**Files:**
- Modify: `plugins/resume/hooks/hooks.json`

- [ ] **Step 1: matcher 확장**

Edit `plugins/resume/hooks/hooks.json`, change the `matcher` value:

Before:
```json
"matcher": "Write|Bash|Edit",
```

After:
```json
"matcher": "Write|Bash|Edit|Task|AskUserQuestion",
```

- [ ] **Step 2: 확인**

Run:
```bash
cat plugins/resume/hooks/hooks.json
```

Expected:
```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Bash|Edit|Task|AskUserQuestion",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/episode-watcher.mjs\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 3: 커밋**

```bash
git add plugins/resume/hooks/hooks.json
git commit -m "$(cat <<'EOF'
feat(hook): matcher에 Task | AskUserQuestion 추가

Phase 3 게이트 감시를 위해 Agent tool 호출과 AskUserQuestion 호출을
hook에서 관찰 가능하도록 matcher 확장. 감시 로직은 Task 3.3~3.6에서
추가.

Phase 3/7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3.3: Agent tool 호출 감지 → gate_state 갱신

**Files:**
- Modify: `plugins/resume/scripts/episode-watcher.mjs`
- Modify: `plugins/resume/scripts/test-episode-watcher.mjs`

- [ ] **Step 1: 테스트 먼저 — Task 호출 시 agent_calls_in_current_round 증가**

Append to `plugins/resume/scripts/test-episode-watcher.mjs`:

```javascript
// Test Phase 3.3: Task tool 호출이 agent_calls_in_current_round 증가시킴
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({
    session_limits: {
      gaps: { used: 0, max: 3, intentional: [] },
      perspectives: { used: 0, max: 2, episode_refs: [] },
      contradictions: { used: 0, max: 2 },
      reprobes: { used: 0, log: [] }
    },
    gate_state: {
      direct_askuserquestion_streak: 2,
      agent_calls_in_current_round: { senior: 0, "c-level": 0, recruiter: 0, hr: 0, "coffee-chat": 0 },
      round_turn_counts: { "0": 0, "1": 5, "2": 0, "3": 0 },
      retrospective_invoked: false,
      last_askuserquestion_source: null,
    },
    current_round: 1,
    profiler_score: 0,
  }));

  run({
    hook_event_name: "PostToolUse",
    tool_name: "Task",
    tool_input: { subagent_type: "senior", prompt: "..." },
    cwd: "/tmp/test-resume-panel",
  });

  const meta = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", "utf-8"));
  assert.strictEqual(meta.gate_state.agent_calls_in_current_round.senior, 1, "senior count should increment");
  assert.strictEqual(meta.gate_state.direct_askuserquestion_streak, 0, "direct streak should reset on Task call");
  console.log("PASS: Phase 3.3 — Task 호출 감지");
}
```

- [ ] **Step 2: 테스트 실행 (FAIL)**

Run:
```bash
node plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: Phase 3.3 FAIL.

- [ ] **Step 3: episode-watcher.mjs에 Task 핸들러 추가**

stdin 파싱 직후, self-trigger 방지 이전에 Task 감지 블록 추가:

`episode-watcher.mjs`의 `const toolInput = input.tool_input || {};` 다음에:

```javascript
// ── Task tool 호출 감지 (Agent 호출) ─────────────────
if (toolName === "Task") {
  const subagent = toolInput.subagent_type || "";
  const knownAgents = ["senior", "c-level", "recruiter", "hr", "coffee-chat"];
  if (knownAgents.includes(subagent)) {
    ensureStateDir();
    const meta = migrateMeta(readJSON(metaPath) || {});
    meta.gate_state = meta.gate_state || defaultGateState();
    meta.gate_state.agent_calls_in_current_round[subagent] =
      (meta.gate_state.agent_calls_in_current_round[subagent] || 0) + 1;
    meta.gate_state.direct_askuserquestion_streak = 0;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }
  process.exit(0);
}
```

(`const base` 같은 경로 상수가 아직 선언 안 됐으므로 이동: 경로 상수 선언부를 맨 위 (stdin 파싱 직후)로 옮길 것.)

경로 상수 이동 예시 — 파일 상단 stdin 파싱 직후, toolName/toolInput 추출 직후에 이 블록이 먼저 오도록:

```javascript
// ── 경로 상수 ────────────────────────────────────────
const base = process.env.RESUME_PANEL_BASE || input.cwd || process.cwd();
const stateDir = join(base, ".resume-panel");
const snapshotPath = join(stateDir, "snapshot.json");
const metaPath = join(stateDir, "meta.json");
const sourcePath = join(base, "resume-source.json");
const inboxPath = join(stateDir, "findings-inbox.jsonl");
const processingPath = join(stateDir, "findings-inbox.processing.jsonl");
const findingsPath = join(stateDir, "findings.json");
```

(현재 파일 line 46-55 근처의 블록을 이동)

- [ ] **Step 4: 테스트 재실행 (PASS)**

Run:
```bash
node plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: Phase 3.3 PASS.

- [ ] **Step 5: 커밋**

```bash
git add plugins/resume/scripts/episode-watcher.mjs plugins/resume/scripts/test-episode-watcher.mjs
git commit -m "$(cat <<'EOF'
feat(hook): Task tool 호출 감지 → agent_calls_in_current_round 증가

episode-watcher.mjs가 PostToolUse matcher의 Task 이벤트를 받으면
subagent_type을 읽어 해당 에이전트 카운터를 증가시키고
direct_askuserquestion_streak를 리셋. G2 게이트 판정의 기초.

Phase 3/7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3.4: AskUserQuestion 감지 + 화이트리스트 판정 + G2 direct_burst 게이트

**Files:**
- Modify: `plugins/resume/scripts/episode-watcher.mjs`
- Modify: `plugins/resume/scripts/test-episode-watcher.mjs`

- [ ] **Step 1: 테스트 먼저 — 화이트리스트 소스 선언 + 3회 연속 direct burst 감지**

Append to `plugins/resume/scripts/test-episode-watcher.mjs`:

```javascript
// Test Phase 3.4a: 화이트리스트 선언된 AskUserQuestion은 streak 증가 안 함
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({
    session_limits: {
      gaps: { used: 0, max: 3, intentional: [] },
      perspectives: { used: 0, max: 2, episode_refs: [] },
      contradictions: { used: 0, max: 2 },
      reprobes: { used: 0, log: [] }
    },
    gate_state: {
      direct_askuserquestion_streak: 0,
      agent_calls_in_current_round: { senior: 0, "c-level": 0, recruiter: 0, hr: 0, "coffee-chat": 0 },
      round_turn_counts: { "0": 5, "1": 0, "2": 0, "3": 0 },
      retrospective_invoked: false,
      last_askuserquestion_source: { source: "whitelist", case: "round0_basic_info" },
    },
    current_round: 0,
    profiler_score: 0,
  }));

  run({
    hook_event_name: "PostToolUse",
    tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: "?" }] },
    cwd: "/tmp/test-resume-panel",
  });

  const meta = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", "utf-8"));
  assert.strictEqual(meta.gate_state.direct_askuserquestion_streak, 0, "whitelist declared → streak should stay 0");
  assert.strictEqual(meta.gate_state.last_askuserquestion_source, null, "source should reset to null");
  console.log("PASS: Phase 3.4a — whitelist 선언 시 streak 비증가");
}

// Test Phase 3.4b: 미선언 AskUserQuestion 3연속 → gate_violation 발행
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({
    session_limits: {
      gaps: { used: 0, max: 3, intentional: [] },
      perspectives: { used: 0, max: 2, episode_refs: [] },
      contradictions: { used: 0, max: 2 },
      reprobes: { used: 0, log: [] }
    },
    gate_state: {
      direct_askuserquestion_streak: 2,
      agent_calls_in_current_round: { senior: 0, "c-level": 0, recruiter: 0, hr: 0, "coffee-chat": 0 },
      round_turn_counts: { "0": 0, "1": 5, "2": 0, "3": 0 },
      retrospective_invoked: false,
      last_askuserquestion_source: null,
    },
    current_round: 1,
    profiler_score: 0,
  }));

  const result = run({
    hook_event_name: "PostToolUse",
    tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: "?" }] },
    cwd: "/tmp/test-resume-panel",
  });

  const meta = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", "utf-8"));
  assert.strictEqual(meta.gate_state.direct_askuserquestion_streak, 3, "streak should hit 3");
  assert.ok(result, "should emit output");
  const ctx = result.hookSpecificOutput.additionalContext;
  const violationLine = ctx.split("\n\n").find(l => l.includes('"gate":"direct_question_burst"'));
  assert.ok(violationLine, `gate_violation direct_question_burst missing: ${ctx}`);
  const payload = JSON.parse(violationLine.slice("[resume-panel]".length));
  assert.strictEqual(payload.type, "gate_violation");
  assert.strictEqual(payload.gate, "direct_question_burst");
  assert.strictEqual(payload.count, 3);
  console.log("PASS: Phase 3.4b — direct_question_burst 감지");
}
```

- [ ] **Step 2: 테스트 실행 (FAIL)**

Run:
```bash
node plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: Phase 3.4a/3.4b FAIL.

- [ ] **Step 3: AskUserQuestion 핸들러 추가**

Task 핸들러 블록 다음에 추가 (`process.exit(0)` 전에):

```javascript
// ── AskUserQuestion 호출 감지 (직접 질문 폭주 게이트 G2) ──
if (toolName === "AskUserQuestion") {
  ensureStateDir();
  const meta = migrateMeta(readJSON(metaPath) || {});
  meta.gate_state = meta.gate_state || defaultGateState();

  const source = meta.gate_state.last_askuserquestion_source;
  const isWhitelist = source && source.source === "whitelist";
  const isAgent = source && source.source === "agent";

  if (isWhitelist || isAgent) {
    // 정당한 호출 — streak 리셋
    meta.gate_state.direct_askuserquestion_streak = 0;
  } else {
    // 미선언 → orchestrator_direct 로 간주
    meta.gate_state.direct_askuserquestion_streak++;
  }
  // source는 쓰고 나면 리셋 (다음 호출이 명시적 선언이 필요하도록)
  meta.gate_state.last_askuserquestion_source = null;

  writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  // G2: direct_question_burst 게이트
  if (meta.gate_state.direct_askuserquestion_streak >= 3) {
    const payload = {
      type: "gate_violation",
      gate: "direct_question_burst",
      count: meta.gate_state.direct_askuserquestion_streak,
    };
    process.stdout.write(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `[resume-panel]${JSON.stringify(payload)}`,
      },
    }));
  }
  process.exit(0);
}
```

- [ ] **Step 4: 테스트 재실행 (PASS)**

Run:
```bash
node plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: 전체 PASS.

- [ ] **Step 5: 커밋**

```bash
git add plugins/resume/scripts/episode-watcher.mjs plugins/resume/scripts/test-episode-watcher.mjs
git commit -m "$(cat <<'EOF'
feat(hook): AskUserQuestion 감시 + G2 direct_question_burst 게이트

AskUserQuestion 호출 시 meta.json.gate_state.last_askuserquestion_source
를 확인. "whitelist" 또는 "agent" 선언 없으면 direct streak 증가.
3회 연속 도달 시 gate_violation 메시지 발행. 호출 후 source는 null로
리셋하여 다음 호출도 명시적 선언 필요.

TDD: 화이트리스트 선언 / 3연속 burst 2개 케이스 테스트.

Phase 3/7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3.5: G1 R1 Entry 게이트 (회사별 senior/c-level 호출 확인)

**Files:**
- Modify: `plugins/resume/scripts/episode-watcher.mjs`
- Modify: `plugins/resume/scripts/test-episode-watcher.mjs`

- [ ] **Step 1: 테스트 먼저**

Append to `plugins/resume/scripts/test-episode-watcher.mjs`:

```javascript
// Test Phase 3.5: Round 1 첫 AskUserQuestion 시 senior/c-level 호출 없으면 r1_entry 위반
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({
    session_limits: {
      gaps: { used: 0, max: 3, intentional: [] },
      perspectives: { used: 0, max: 2, episode_refs: [] },
      contradictions: { used: 0, max: 2 },
      reprobes: { used: 0, log: [] }
    },
    gate_state: {
      direct_askuserquestion_streak: 0,
      agent_calls_in_current_round: { senior: 0, "c-level": 0, recruiter: 0, hr: 0, "coffee-chat": 0 },
      round_turn_counts: { "0": 0, "1": 0, "2": 0, "3": 0 },
      retrospective_invoked: false,
      last_askuserquestion_source: { source: "orchestrator_direct" },  // 명시
    },
    current_round: 1,
    current_company: "KB국민카드",
    profiler_score: 0,
  }));

  const result = run({
    hook_event_name: "PostToolUse",
    tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: "?" }] },
    cwd: "/tmp/test-resume-panel",
  });

  assert.ok(result, "should emit output");
  const ctx = result.hookSpecificOutput.additionalContext;
  const r1Line = ctx.split("\n\n").find(l => l.includes('"gate":"r1_entry"'));
  assert.ok(r1Line, `r1_entry gate_violation missing: ${ctx}`);
  const payload = JSON.parse(r1Line.slice("[resume-panel]".length));
  assert.strictEqual(payload.gate, "r1_entry");
  assert.strictEqual(payload.company, "KB국민카드");
  console.log("PASS: Phase 3.5 — G1 r1_entry");
}
```

- [ ] **Step 2: FAIL 확인**

Run:
```bash
node plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: Phase 3.5 FAIL.

- [ ] **Step 3: G1 감시 로직 추가 — AskUserQuestion 핸들러 내부**

AskUserQuestion 핸들러 내부에서 G2 체크 직전에 G1 체크 추가:

```javascript
// G1: r1_entry — Round 1에서 senior/c-level 호출 0회 상태의 AskUserQuestion
const violations = [];
if (meta.current_round === 1 &&
    meta.gate_state.agent_calls_in_current_round.senior === 0 &&
    meta.gate_state.agent_calls_in_current_round["c-level"] === 0 &&
    !isWhitelist && !isAgent) {
  violations.push({
    type: "gate_violation",
    gate: "r1_entry",
    company: meta.current_company || null,
  });
}

// G2: direct_question_burst
if (meta.gate_state.direct_askuserquestion_streak >= 3) {
  violations.push({
    type: "gate_violation",
    gate: "direct_question_burst",
    count: meta.gate_state.direct_askuserquestion_streak,
  });
}

if (violations.length > 0) {
  const outputLines = violations.map(v => `[resume-panel]${JSON.stringify(v)}`).join("\n\n");
  process.stdout.write(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: outputLines,
    },
  }));
}
process.exit(0);
```

(기존 G2 단독 발행 블록을 위 패턴으로 교체)

- [ ] **Step 4: 테스트 재실행 (PASS)**

Run:
```bash
node plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: 전체 PASS.

- [ ] **Step 5: 커밋**

```bash
git add plugins/resume/scripts/episode-watcher.mjs plugins/resume/scripts/test-episode-watcher.mjs
git commit -m "$(cat <<'EOF'
feat(hook): G1 r1_entry 게이트 감시

Round 1 상태에서 senior와 c-level 합계 호출 0회인데 오케스트레이터
직접 AskUserQuestion을 호출하면 r1_entry 위반 메시지 발행.
위반 배열로 G1/G2 동시 감지 지원.

Phase 3/7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3.6: G3 R2 Exit 게이트 (Round 2→3 전환 직전 검증)

**Files:**
- Modify: `plugins/resume/scripts/episode-watcher.mjs`
- Modify: `plugins/resume/scripts/test-episode-watcher.mjs`

G3는 "오케스트레이터가 meta.json의 current_round를 2→3으로 쓸 때" 체크. 감지는 Bash 명령에서 meta.json 쓰기를 가로채거나, 별도 시그널 파일 등을 쓸 수 있지만, 가장 단순한 방법: meta.json이 변경된 후 episode-watcher.mjs가 **변경 전 스냅샷**과 비교하여 `current_round` 2→3 전환을 감지.

더 간단한 대안: 오케스트레이터가 Round 2 종료 선언 시 별도 시그널 파일 `.resume-panel/round-transition.json`을 쓴다. Bash matcher에서 이 파일 쓰기를 감지.

본 계획은 시그널 파일 방식 채택. 오케스트레이터가 SKILL.md 라운드 전환 시 write.

- [ ] **Step 1: 테스트 먼저**

Append to `plugins/resume/scripts/test-episode-watcher.mjs`:

```javascript
// Test Phase 3.6: round-transition 2→3 시 recruiter/hr 0회면 r2_exit 위반
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({
    session_limits: {
      gaps: { used: 0, max: 3, intentional: [] },
      perspectives: { used: 0, max: 2, episode_refs: [] },
      contradictions: { used: 0, max: 2 },
      reprobes: { used: 0, log: [] }
    },
    gate_state: {
      direct_askuserquestion_streak: 0,
      agent_calls_in_current_round: { senior: 2, "c-level": 1, recruiter: 0, hr: 0, "coffee-chat": 0 },
      round_turn_counts: { "0": 30, "1": 40, "2": 10, "3": 0 },  // R2 turn = 10 (<15)
      retrospective_invoked: false,
      last_askuserquestion_source: null,
    },
    current_round: 2,
    profiler_score: 0,
  }));
  writeFileSync("/tmp/test-resume-panel/resume-source.json", JSON.stringify({
    meta: {}, companies: [], gap_analysis: null
  }));

  // 시그널: round-transition to 3
  const result = run({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "echo '{\"to\":3}' > .resume-panel/round-transition.json" },
    cwd: "/tmp/test-resume-panel",
  });

  assert.ok(result, "should emit output");
  const ctx = result.hookSpecificOutput.additionalContext;
  const r2Line = ctx.split("\n\n").find(l => l.includes('"gate":"r2_exit"'));
  assert.ok(r2Line, `r2_exit gate_violation missing: ${ctx}`);
  const payload = JSON.parse(r2Line.slice("[resume-panel]".length));
  assert.strictEqual(payload.gate, "r2_exit");
  assert.ok(payload.missing.includes("recruiter"), "missing should include recruiter");
  assert.ok(payload.missing.includes("hr"), "missing should include hr");
  assert.ok(payload.missing.includes("turn_min"), "missing should include turn_min");
  assert.ok(payload.missing.includes("gap_analysis"), "missing should include gap_analysis");
  console.log("PASS: Phase 3.6 — G3 r2_exit");
}
```

- [ ] **Step 2: FAIL 확인**

Run:
```bash
node plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: Phase 3.6 FAIL.

- [ ] **Step 3: round-transition 감지 로직 추가**

Bash toolName 분기에 round-transition.json 감지 추가. 현재:

```javascript
} else if (toolName === "Bash") {
  const cmd = toolInput.command || "";
  if (cmd.includes("resume-source.json")) {
    targetPath = "resume-source.json";
  } else if (cmd.includes(".resume-panel/") || cmd.includes(".resume-panel\\")) {
    targetPath = ".resume-panel/";
  }
}
```

→

```javascript
} else if (toolName === "Bash") {
  const cmd = toolInput.command || "";
  if (cmd.includes("resume-source.json")) {
    targetPath = "resume-source.json";
  } else if (cmd.includes("round-transition.json")) {
    targetPath = "round-transition";  // special marker
  } else if (cmd.includes(".resume-panel/") || cmd.includes(".resume-panel\\")) {
    targetPath = ".resume-panel/";
  }
}
```

self-trigger 방지 블록도 round-transition은 허용:

```javascript
if (targetPath.includes(".resume-panel/") || targetPath.includes(".resume-panel\\")) {
  process.exit(0);
}
```

→

```javascript
// round-transition 시그널은 self-trigger 방지에서 제외
if ((targetPath.includes(".resume-panel/") || targetPath.includes(".resume-panel\\")) &&
    targetPath !== "round-transition") {
  process.exit(0);
}
```

그리고 본 처리 블록 — `if (isResumeSourceChange) { ... }` 다음에 추가:

```javascript
// ── Round 전환 시그널 처리 (G3 r2_exit) ─────────────
if (targetPath === "round-transition") {
  const transitionPath = join(stateDir, "round-transition.json");
  const transition = readJSON(transitionPath);
  if (transition && transition.to === 3) {
    ensureStateDir();
    const meta = migrateMeta(readJSON(metaPath) || {});
    const gs = meta.gate_state || defaultGateState();
    const missing = [];
    if ((gs.agent_calls_in_current_round.recruiter || 0) === 0) missing.push("recruiter");
    if ((gs.agent_calls_in_current_round.hr || 0) === 0) missing.push("hr");
    if ((gs.round_turn_counts["2"] || 0) < 15) missing.push("turn_min");

    const source = readJSON(sourcePath);
    const ga = source?.gap_analysis;
    if (!ga || !Array.isArray(ga.met) || !Array.isArray(ga.gaps)) {
      missing.push("gap_analysis");
    }

    if (missing.length > 0) {
      messages.push(emit({
        type: "gate_violation",
        gate: "r2_exit",
        missing,
      }));
    }
    // 시그널 파일 삭제 (1회성)
    try { unlinkSync(transitionPath); } catch {}
  }
}
```

(`unlinkSync`는 이미 상단에서 import됨)

- [ ] **Step 4: 테스트 재실행 (PASS)**

Run:
```bash
node plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: Phase 3.6 PASS.

- [ ] **Step 5: SKILL.md에 round-transition 시그널 방법 기록**

Edit `plugins/resume/skills/resume-panel/SKILL.md`. Find the Round 2 section (`### Round 2 — 임팩트 발굴 + 갭 분석`) and replace the "**전환 기준**" line:

Before:
```
**전환 기준**: Exit Gate 4개 전부 충족 + JD 주요 요구사항 커버.
```

After:
```
**전환 기준**: Exit Gate 4개 전부 충족 + JD 주요 요구사항 커버.

Round 3 진입 직전에 시그널 쓰기 (hook이 G3 감시):
```bash
echo '{"to":3,"at":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > .resume-panel/round-transition.json
```
시그널 쓴 직후 `gate_violation r2_exit` 메시지가 오면 `missing` 배열을 보고 복귀. 없으면 Round 3 진행.
```

- [ ] **Step 6: 커밋**

```bash
git add plugins/resume/scripts/episode-watcher.mjs \
        plugins/resume/scripts/test-episode-watcher.mjs \
        plugins/resume/skills/resume-panel/SKILL.md
git commit -m "$(cat <<'EOF'
feat(hook): G3 r2_exit 게이트 + round-transition 시그널

오케스트레이터가 Round 3 진입 직전 `.resume-panel/round-transition.json`
에 `{"to":3}`를 쓰면 hook이 이를 감지하여 recruiter/hr 호출 여부,
R2 turn 수, gap_analysis 유무를 점검. 미충족 배열을 gate_violation
메시지로 발행.

Phase 3/7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3.7: G4 Retrospective Skipped 게이트

**Files:**
- Modify: `plugins/resume/scripts/episode-watcher.mjs`
- Modify: `plugins/resume/scripts/test-episode-watcher.mjs`

- [ ] **Step 1: 테스트 먼저**

```javascript
// Test Phase 3.7: resume-draft.md Write 후 retrospective 에이전트 호출 없으면 G4 위반
// 방식: resume-draft.md가 쓰여지고, retrospective_invoked=false이고, retrospective Task 호출 없으면
// 단, 이것은 draft write 시점에 즉시 판정하긴 애매함 (retrospective는 draft 이후 호출되니까)
// 대신 session-end 시그널로 판정
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({
    session_limits: {
      gaps: { used: 0, max: 3, intentional: [] },
      perspectives: { used: 0, max: 2, episode_refs: [] },
      contradictions: { used: 0, max: 2 },
      reprobes: { used: 0, log: [] }
    },
    gate_state: {
      direct_askuserquestion_streak: 0,
      agent_calls_in_current_round: { senior: 0, "c-level": 0, recruiter: 0, hr: 0, "coffee-chat": 0 },
      round_turn_counts: { "0": 0, "1": 0, "2": 0, "3": 10 },
      retrospective_invoked: false,
      last_askuserquestion_source: null,
    },
    current_round: 3,
    profiler_score: 0,
  }));

  // session-end 시그널
  const result = run({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "echo '{}' > .resume-panel/session-end.json" },
    cwd: "/tmp/test-resume-panel",
  });

  assert.ok(result, "should emit output");
  const ctx = result.hookSpecificOutput.additionalContext;
  const g4Line = ctx.split("\n\n").find(l => l.includes('"gate":"retrospective_skipped"'));
  assert.ok(g4Line, `retrospective_skipped missing: ${ctx}`);
  console.log("PASS: Phase 3.7 — G4 retrospective_skipped");
}

// Test Phase 3.8: retrospective Task 호출이 retrospective_invoked=true로 바꿈
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({
    session_limits: {
      gaps: { used: 0, max: 3, intentional: [] },
      perspectives: { used: 0, max: 2, episode_refs: [] },
      contradictions: { used: 0, max: 2 },
      reprobes: { used: 0, log: [] }
    },
    gate_state: {
      direct_askuserquestion_streak: 0,
      agent_calls_in_current_round: { senior: 0, "c-level": 0, recruiter: 0, hr: 0, "coffee-chat": 0 },
      round_turn_counts: { "0": 0, "1": 0, "2": 0, "3": 10 },
      retrospective_invoked: false,
      last_askuserquestion_source: null,
    },
    current_round: 3,
    profiler_score: 0,
  }));

  run({
    hook_event_name: "PostToolUse",
    tool_name: "Task",
    tool_input: { subagent_type: "retrospective", prompt: "..." },
    cwd: "/tmp/test-resume-panel",
  });

  const meta = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", "utf-8"));
  assert.strictEqual(meta.gate_state.retrospective_invoked, true, "retrospective_invoked should be true");
  console.log("PASS: Phase 3.8 — retrospective Task 감지");
}
```

- [ ] **Step 2: FAIL 확인**

Run:
```bash
node plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: 3.7, 3.8 FAIL.

- [ ] **Step 3: 구현**

Task 핸들러에 retrospective 감지 확장:

```javascript
if (toolName === "Task") {
  const subagent = toolInput.subagent_type || "";
  const knownAgents = ["senior", "c-level", "recruiter", "hr", "coffee-chat"];
  if (knownAgents.includes(subagent)) {
    ensureStateDir();
    const meta = migrateMeta(readJSON(metaPath) || {});
    meta.gate_state = meta.gate_state || defaultGateState();
    meta.gate_state.agent_calls_in_current_round[subagent] =
      (meta.gate_state.agent_calls_in_current_round[subagent] || 0) + 1;
    meta.gate_state.direct_askuserquestion_streak = 0;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  } else if (subagent === "retrospective") {
    ensureStateDir();
    const meta = migrateMeta(readJSON(metaPath) || {});
    meta.gate_state = meta.gate_state || defaultGateState();
    meta.gate_state.retrospective_invoked = true;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }
  process.exit(0);
}
```

Bash 블록 확장 — session-end 감지:

```javascript
} else if (toolName === "Bash") {
  const cmd = toolInput.command || "";
  if (cmd.includes("resume-source.json")) {
    targetPath = "resume-source.json";
  } else if (cmd.includes("round-transition.json")) {
    targetPath = "round-transition";
  } else if (cmd.includes("session-end.json")) {
    targetPath = "session-end";
  } else if (cmd.includes(".resume-panel/") || cmd.includes(".resume-panel\\")) {
    targetPath = ".resume-panel/";
  }
}
```

self-trigger 방지 조건도 session-end 제외:

```javascript
if ((targetPath.includes(".resume-panel/") || targetPath.includes(".resume-panel\\")) &&
    targetPath !== "round-transition" && targetPath !== "session-end") {
  process.exit(0);
}
```

본 처리 블록에 G4 추가 (G3 다음에):

```javascript
// ── Session-end 시그널 처리 (G4 retrospective_skipped) ──
if (targetPath === "session-end") {
  const sessionEndPath = join(stateDir, "session-end.json");
  ensureStateDir();
  const meta = migrateMeta(readJSON(metaPath) || {});
  const gs = meta.gate_state || defaultGateState();
  if (!gs.retrospective_invoked) {
    messages.push(emit({
      type: "gate_violation",
      gate: "retrospective_skipped",
    }));
  }
  try { unlinkSync(sessionEndPath); } catch {}
}
```

- [ ] **Step 4: 테스트 재실행 (PASS)**

Run:
```bash
node plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: 전체 PASS.

- [ ] **Step 5: SKILL.md Round 3 Step 10에 session-end 시그널 추가**

Edit `plugins/resume/skills/resume-panel/SKILL.md`. Find the Round 3 Step 10 area and add after the retrospective 파일 저장:

```markdown
회고 파일 저장 완료 후 세션 종료 시그널 쓰기:
```bash
echo '{"at":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > .resume-panel/session-end.json
```

시그널 후 `gate_violation retrospective_skipped` 메시지가 오면 Step 9가 누락된 것. 즉시 retrospective 에이전트 호출로 복귀.
```

- [ ] **Step 6: 커밋**

```bash
git add plugins/resume/scripts/episode-watcher.mjs \
        plugins/resume/scripts/test-episode-watcher.mjs \
        plugins/resume/skills/resume-panel/SKILL.md
git commit -m "$(cat <<'EOF'
feat(hook): G4 retrospective_skipped 게이트 + session-end 시그널

오케스트레이터가 세션 종료 직전 `.resume-panel/session-end.json`을
쓰면 hook이 retrospective_invoked 플래그를 확인하여 미호출 시
gate_violation. retrospective Task 호출은 플래그 자동 set.

Phase 3/7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3.8: SKILL.md의 자연어 하드 게이트 삭제 + gate_violation 처리 지시

**Files:**
- Modify: `plugins/resume/skills/resume-panel/SKILL.md`

Phase 1 Task 1.3에서 이미 "하드 게이트는 gates.md 참조"로 치환했지만, 그때 자연어 서술은 gates.md에 그대로 보존(Phase 1 임시 자기감시). Phase 3 이후로는 hook 감시가 활성화되므로 gates.md의 "Phase 1 임시 자기감시" 섹션을 제거하고, SKILL.md는 gate_violation 메시지 처리 지침을 추가.

- [ ] **Step 1: gates.md에서 임시 섹션 제거**

Edit `plugins/resume/skills/resume-panel/references/gates.md`, delete the entire `## Phase 1 임시 자기감시` section at the bottom.

Add this new section at the bottom:

```markdown
## gate_violation 수신 시

오케스트레이터는 `[resume-panel]{"type":"gate_violation",...}` 메시지를 수신하면:

1. 위반 내용을 평문으로 유저에게 고지 (간단히)
2. 즉시 해당 복귀 액션 수행 (각 게이트별 "복귀 액션" 참조)
3. 상태 업데이트는 hook이 알아서 함 — 오케스트레이터는 meta.json.gate_state를 수동 갱신하지 않음

평문 고지 예시:
- G1: `⚠️ Round 1 Entry Gate 미충족 — {company}에 대해 senior/c-level 호출로 복귀`
- G2: `⚠️ sub-agent 호출 없이 3회 직접 질문 — 에이전트 호출로 복귀`
- G3: `⚠️ Round 2 Exit Gate 미충족 — {missing} 보강 후 재시도`
- G4: `⚠️ retrospective 호출 누락 — 지금 호출할게`
```

- [ ] **Step 2: SKILL.md에 gate_violation 처리 단문 추가**

Edit `plugins/resume/skills/resume-panel/SKILL.md`. Find the `## 자율 오케스트레이션` section and extend:

Before:
```markdown
## 자율 오케스트레이션

`episode-watcher.mjs` hook이 PostToolUse마다 실행되며 `additionalContext`로 메시지를 보낸다. 메시지 타입과 처리는 `references/hook-protocol.md` 참조.

인터뷰 흐름 보호:
- HIGH finding은 현재 질문-답변 사이클 완료 후 끼워넣기
...
```

After (추가 bullet):
```markdown
## 자율 오케스트레이션

`episode-watcher.mjs` hook이 PostToolUse마다 실행되며 `additionalContext`로 메시지를 보낸다. 메시지 타입과 처리는 `references/hook-protocol.md` 참조.

**AskUserQuestion 호출 전 선언 의무** — 오케스트레이터는 AskUserQuestion 호출 직전 meta.json을 다음과 같이 업데이트한다 (hook의 화이트리스트 판정용):

```bash
# 화이트리스트 케이스
jq '.gate_state.last_askuserquestion_source = {"source":"whitelist","case":"round0_basic_info"}' \
  .resume-panel/meta.json > .resume-panel/meta.json.tmp && mv .resume-panel/meta.json.tmp .resume-panel/meta.json

# 에이전트 응답 전달 케이스
jq '.gate_state.last_askuserquestion_source = {"source":"agent","agent_name":"senior"}' \
  .resume-panel/meta.json > .resume-panel/meta.json.tmp && mv .resume-panel/meta.json.tmp .resume-panel/meta.json
```

선언 없이 AskUserQuestion을 3회 호출하면 G2 direct_question_burst 위반.

**게이트 위반 수신** — `gate_violation` 메시지를 받으면 `references/gates.md` §gate_violation 수신 시 절차에 따라 즉시 복귀.

인터뷰 흐름 보호:
- HIGH finding은 현재 질문-답변 사이클 완료 후 끼워넣기
...
```

- [ ] **Step 3: 커밋**

```bash
git add plugins/resume/skills/resume-panel/SKILL.md \
        plugins/resume/skills/resume-panel/references/gates.md
git commit -m "$(cat <<'EOF'
refactor(resume): 자기감시 자연어 게이트 제거, hook 감시로 완전 이관

gates.md의 "Phase 1 임시 자기감시" 섹션 삭제 → gate_violation 수신 시
절차 추가. SKILL.md에 AskUserQuestion 호출 전 선언 의무
(meta.json.gate_state.last_askuserquestion_source) 추가, hook이
화이트리스트 판정 가능하게.

Phase 3/7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3.9: Phase 3 검증

**Files:** (read-only)

- [ ] **Step 1: 전체 테스트 스위트 통과**

Run:
```bash
node plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: 모든 테스트 PASS (Phase 1/2/3 테스트 전부).

- [ ] **Step 2: 게이트 4종 전부 구현되었는지 최종 grep**

Run:
```bash
grep -c 'gate: *"r1_entry\|gate: *"direct_question_burst\|gate: *"r2_exit\|gate: *"retrospective_skipped"' plugins/resume/scripts/episode-watcher.mjs
```

Expected: `4` 이상.

- [ ] **Step 3: meta.json 구 스키마 자동 업그레이드 증거**

Run:
```bash
grep -c 'migrateMeta' plugins/resume/scripts/episode-watcher.mjs
```

Expected: ≥5회 호출.

- [ ] **Step 4: Phase 3 체크포인트**

다음 Phase 진입.

---

## Phase 4 — Retrospective 연동

### Task 4.1: episode-watcher.mjs — session-stats.json 집계

**Files:**
- Modify: `plugins/resume/scripts/episode-watcher.mjs`
- Modify: `plugins/resume/scripts/test-episode-watcher.mjs`

- [ ] **Step 1: 테스트 먼저**

Append:

```javascript
// Test Phase 4.1: Task/AskUserQuestion 호출이 session-stats.json에 집계됨
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({
    session_limits: {
      gaps: { used: 0, max: 3, intentional: [] },
      perspectives: { used: 0, max: 2, episode_refs: [] },
      contradictions: { used: 0, max: 2 },
      reprobes: { used: 0, log: [] }
    },
    gate_state: {
      direct_askuserquestion_streak: 0,
      agent_calls_in_current_round: { senior: 0, "c-level": 0, recruiter: 0, hr: 0, "coffee-chat": 0 },
      round_turn_counts: { "0": 0, "1": 0, "2": 0, "3": 0 },
      retrospective_invoked: false,
      last_askuserquestion_source: { source: "agent", agent_name: "senior" },
    },
    current_round: 1,
    profiler_score: 0,
  }));

  // senior Task 2회 호출
  run({ hook_event_name: "PostToolUse", tool_name: "Task", tool_input: { subagent_type: "senior" }, cwd: "/tmp/test-resume-panel" });
  run({ hook_event_name: "PostToolUse", tool_name: "Task", tool_input: { subagent_type: "senior" }, cwd: "/tmp/test-resume-panel" });

  // AskUserQuestion (agent 소스) 3회
  for (let i = 0; i < 3; i++) {
    // 미리 agent source 선언
    const meta = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", "utf-8"));
    meta.gate_state.last_askuserquestion_source = { source: "agent", agent_name: "senior" };
    writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify(meta));
    run({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_input: {}, cwd: "/tmp/test-resume-panel" });
  }

  // AskUserQuestion (whitelist) 1회
  const meta = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", "utf-8"));
  meta.gate_state.last_askuserquestion_source = { source: "whitelist", case: "round0_basic_info" };
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify(meta));
  run({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_input: {}, cwd: "/tmp/test-resume-panel" });

  const stats = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/session-stats.json", "utf-8"));
  assert.strictEqual(stats.agent_invocations.senior, 2);
  assert.strictEqual(stats.askuserquestion.total, 4);
  assert.strictEqual(stats.askuserquestion.by_source.agent, 3);
  assert.strictEqual(stats.askuserquestion.by_source.whitelist, 1);
  assert.strictEqual(stats.askuserquestion.by_source.orchestrator_direct, 0);
  console.log("PASS: Phase 4.1 — session-stats.json 집계");
}
```

- [ ] **Step 2: FAIL 확인**

Run:
```bash
node plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: Phase 4.1 FAIL.

- [ ] **Step 3: 구현**

상단 헬퍼에 추가:

```javascript
function defaultSessionStats() {
  return {
    agent_invocations: { senior: 0, "c-level": 0, recruiter: 0, hr: 0, "coffee-chat": 0, researcher: 0, retrospective: 0 },
    askuserquestion: {
      total: 0,
      by_source: { whitelist: 0, agent: 0, orchestrator_direct: 0 }
    },
    gate_violations: [],
  };
}

function readStats(base) {
  return readJSON(join(base, ".resume-panel", "session-stats.json")) || defaultSessionStats();
}

function writeStats(base, stats) {
  writeFileSync(join(base, ".resume-panel", "session-stats.json"), JSON.stringify(stats, null, 2));
}
```

Task 핸들러 내부 — 에이전트 카운트 증가 시 stats도 갱신:

```javascript
if (knownAgents.includes(subagent)) {
  ensureStateDir();
  const meta = migrateMeta(readJSON(metaPath) || {});
  meta.gate_state = meta.gate_state || defaultGateState();
  meta.gate_state.agent_calls_in_current_round[subagent] =
    (meta.gate_state.agent_calls_in_current_round[subagent] || 0) + 1;
  meta.gate_state.direct_askuserquestion_streak = 0;
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  // session-stats 업데이트
  const stats = readStats(base);
  stats.agent_invocations[subagent] = (stats.agent_invocations[subagent] || 0) + 1;
  writeStats(base, stats);
} else if (subagent === "retrospective") {
  ensureStateDir();
  const meta = migrateMeta(readJSON(metaPath) || {});
  meta.gate_state = meta.gate_state || defaultGateState();
  meta.gate_state.retrospective_invoked = true;
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  const stats = readStats(base);
  stats.agent_invocations.retrospective = (stats.agent_invocations.retrospective || 0) + 1;
  writeStats(base, stats);
} else if (subagent === "researcher" || subagent === "project-researcher") {
  ensureStateDir();
  const stats = readStats(base);
  stats.agent_invocations.researcher = (stats.agent_invocations.researcher || 0) + 1;
  writeStats(base, stats);
}
```

AskUserQuestion 핸들러 내부 — 총계 및 소스별 집계:

```javascript
// session-stats 집계
const stats = readStats(base);
stats.askuserquestion.total++;
const sourceKind = isWhitelist ? "whitelist" : (isAgent ? "agent" : "orchestrator_direct");
stats.askuserquestion.by_source[sourceKind] =
  (stats.askuserquestion.by_source[sourceKind] || 0) + 1;
writeStats(base, stats);
```

위반 발행 직후:

```javascript
if (violations.length > 0) {
  const stats = readStats(base);
  for (const v of violations) {
    stats.gate_violations.push({
      gate: v.gate,
      at: new Date().toISOString(),
      detail: { company: v.company, count: v.count, missing: v.missing },
    });
  }
  writeStats(base, stats);
  // (기존 stdout 출력 유지)
}
```

- [ ] **Step 4: 테스트 재실행 (PASS)**

Run:
```bash
node plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: 전체 PASS.

- [ ] **Step 5: 커밋**

```bash
git add plugins/resume/scripts/episode-watcher.mjs plugins/resume/scripts/test-episode-watcher.mjs
git commit -m "$(cat <<'EOF'
feat(hook): session-stats.json 집계 — retrospective 입력용

에이전트 호출, AskUserQuestion 호출(소스별), 게이트 위반 이력을
실시간 집계하여 .resume-panel/session-stats.json에 저장. Phase 4에서
retrospective 에이전트가 이 파일을 Read하여 분석.

Phase 4/7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4.2: retrospective.md 축소 — session-stats.json 기반

**Files:**
- Modify: `plugins/resume/.claude/agents/retrospective.md`

- [ ] **Step 1: 전체 재작성**

Write this exact content to `plugins/resume/.claude/agents/retrospective.md`:

````markdown
---
description: "세션 마무리 시 호출. 메타피드백 회고 마크다운을 생성한다. hook이 집계한 session-stats.json 기반."
model: claude-sonnet
tools: Read, Glob
---

# 회고 분석가

너는 resume-panel 세션의 메타피드백 분석가다. 유저와 직접 대화하지 않는다. 세션이 끝난 후 오케스트레이터가 호출하면, 이 세션에서 무엇이 잘 됐고 무엇을 다음 세션에서 개선할지 회고 마크다운을 리턴한다.

## 입력

오케스트레이터가 전달하는 세션 대화 요약 + 다음 파일 경로들을 직접 Read한다:

- `.resume-panel/session-stats.json` — hook이 실시간 집계한 세션 통계 (에이전트 호출, AskUserQuestion 소스별, 게이트 위반)
- `.resume-panel/findings.json` — finding 목록
- `.resume-panel/meta.json` — 세션 메타데이터 (session_started_at, session_limits, gate_state)
- `resume-source.json` — episodes 요약

## 분석 항목 (5개)

### 1. 질문 품질
- 유저가 "모르겠어", 단답으로 답한 질문들
- 재질문 반복했는데 답 안 나온 경우
- 리서처 팩트 미인용 추상 질문

### 2. 에이전트 패널 활용도

`session-stats.json.agent_invocations`와 `askuserquestion.by_source`를 표로 렌더:

| 에이전트 | 호출 | AskUserQuestion(agent) |
|---|---|---|
| senior | N | N |
| c-level | N | N |
| recruiter | N | N |
| hr | N | N |
| coffee-chat | N | N |
| researcher | N | - |

| AskUserQuestion 소스 | 횟수 | 비율 |
|---|---|---|
| agent | N | x% |
| whitelist | N | x% |
| orchestrator_direct | N | x% |

`gate_violations` 배열 항목마다 경고 기술.

### 3. 미해결 findings (HIGH/MEDIUM)
- `findings.json`에서 `delivered: false` 또는 세션 중 해결 안 됨
- 다음 세션 우선 처리 추천

### 4. 라운드별 turn 배분

`meta.json.gate_state.round_turn_counts`를 표로. 기준 범위:

| 라운드 | 기준 | 실제 | 위반 |
|---|---|---|---|
| 0 | 10~20% | x% | ✓/✗ |
| 1 | 35~50% | x% | ✓/✗ |
| 2 | 20~30% | x% | ✓/✗ |
| 3 | 15~25% | x% | ✓/✗ |

### 5. 다음 세션 개선 제안
- 1~4 기반 구체 액션 3~5개
- 게이트 위반이 있으면 개선 조치 우선 제안

## 출력 포맷

```markdown
# Resume Panel 세션 회고

**세션 일시**: {YYYY-MM-DD HH:MM ~ HH:MM}
**총 turn 수**: {N}

## 1. 질문 품질
...

## 2. 에이전트 패널 활용도
{표와 경고}

## 3. 미해결 findings
...

## 4. 라운드별 turn 배분
{표}

## 5. 다음 세션 개선 제안
1. ...
2. ...
```

## 금지

- 유저에게 직접 말 걸지 않음 (백스테이지)
- "좋았다", "잘했다" 추상 평가 금지
- 에피소드 내용 평가 금지 — **세션 진행 품질**에 대한 것
- session-stats.json에 없는 수치를 지어내지 않는다 — 없으면 "데이터 없음" 명시
````

- [ ] **Step 2: 줄 수 확인**

Run:
```bash
wc -l plugins/resume/.claude/agents/retrospective.md
```

Expected: 약 50-65줄.

- [ ] **Step 3: 커밋**

```bash
git add plugins/resume/.claude/agents/retrospective.md
git commit -m "$(cat <<'EOF'
refactor(resume): retrospective.md — session-stats.json 기반으로 재작성

107줄 → ~60줄. 에이전트 패널 활용도 / 라운드 turn 배분을 LLM이
대화에서 집계하지 않고 hook이 쓴 session-stats.json을 Read하여 표로.
기준 범위 / 경고 트리거 / 출력 포맷 명시.

Phase 4/7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4.3: Phase 4 / 최종 검증

**Files:** (read-only)

- [ ] **Step 1: 전체 테스트 통과**

Run:
```bash
node plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: 모든 테스트 PASS.

- [ ] **Step 2: 파일 최종 줄 수**

Run:
```bash
wc -l plugins/resume/skills/resume-panel/SKILL.md \
      plugins/resume/skills/resume-panel/references/*.md \
      plugins/resume/.claude/agents/*.md \
      plugins/resume/scripts/episode-watcher.mjs \
      plugins/resume/scripts/test-episode-watcher.mjs
```

**Targets**:
- SKILL.md: 250-320줄
- references/: 전체 ~600줄 (agent-contract.md ~220, askuserquestion.md ~55, gates.md ~70, hook-protocol.md ~180, storage.md ~130)
- agents/: senior~65, c-level~85, recruiter~65, hr~95, coffee-chat~28, researcher 유지, project-researcher 유지, profiler 유지, retrospective ~60
- episode-watcher.mjs: ~600-700줄
- test-episode-watcher.mjs: ~400줄

- [ ] **Step 3: 전체 순 감소 계산**

Before (Phase 0):
- SKILL.md 1094 + senior 142 + c-level 225 + recruiter 122 + hr 189 + retrospective 107 = 1879줄
- hook-messages.md 252 + askuserquestion.md 75 = 327줄
- episode-watcher.mjs 422줄
- **합계**: 2628줄 (재설계 대상 범위)

After:
- SKILL.md 250 + senior 65 + c-level 85 + recruiter 65 + hr 95 + retrospective 60 = 620줄
- agent-contract.md 220 + hook-protocol.md 180 + askuserquestion.md 55 + gates.md 70 = 525줄
- episode-watcher.mjs 650줄
- **합계**: 1795줄

**순 감소**: ~833줄 (31% 감소).

- [ ] **Step 4: 회고 개선 제안 흡수 확인**

Phase 3에서 흡수된 improvements 항목을 확인. 2026-04-20 improvements 문서의 P0/P1/P2:

- A1 (R1 Entry Gate): **흡수** — hook G1으로 이관 (자연어 서술 소멸)
- A2 (R2 Exit Gate): **흡수** — hook G3으로 이관
- A3 (Step 10 자가 검증): **흡수** — hook G4 + gates.md
- B1 (서사형 평문 폴백): **흡수** — agent-contract.md §4 단일 출처
- B2 (반복 패턴 옵션): **흡수** — agent-contract.md §4-5 단일 출처 + senior/hr 예시
- B3 (재프로빙 조건 b): **흡수** — agent-contract.md §5.5 (b) 모드
- C1 (회고 항목 2 재설계): **흡수** — retrospective.md + session-stats.json
- C2 (라운드 minimum turn): **흡수** — retrospective.md 기준 범위 표

P3 (D1 나이 선택지 / D2 findings.json 존재 보장)은 후순위로 남김.

- [ ] **Step 5: Phase 4 완료 / 재설계 종료**

최종 커밋은 없음 (각 Task가 자체 커밋).

---

## Self-Review

### 1. Spec coverage

Spec 섹션 → 태스크 매핑:

| Spec 섹션 | Task |
|---|---|
| §3 타겟 파일 레이아웃 | Task 1.1~1.8 |
| §4 SKILL.md 재구성 | Task 1.3 |
| §5 Agent Contract | Task 1.1, 2.1 |
| §6 Agent JSON 출력 | Task 2.1, 2.2, (에이전트 JSON 리턴은 Phase 2 검증 단계에서 실측, 별도 Task 없음) |
| §7 Hook JSON 프로토콜 | Task 2.3, 2.4 |
| §8 Hook 게이트 감시 | Task 3.2~3.7 |
| §9 세션 카운터 통합 | Task 3.1 |
| §10 회고 에이전트 축소 | Task 4.1, 4.2 |
| §11 Phase 나눔 | 이 플랜 구조 |

누락: **에이전트 파일이 JSON 출력을 하도록 하는 명시적 지시가 agent-contract에만 있음**. 개별 에이전트 .md에서 JSON 출력을 "무조건 해야 한다"고 강조하는 한 줄이 필요. 이미 각 에이전트 파일 맨 위에 "agent-contract.md §1~7 전체 준수" 지시가 있으므로 커버됨.

### 2. Placeholder scan

- "{회사}", "{N}" 같은 예시 플레이스홀더 — 정상 (도메인 예시).
- "TBD", "TODO", "fill in" 등 없음.

### 3. Type consistency

- `agent_calls_in_current_round`: 항상 같은 키 세트 (senior, c-level, recruiter, hr, coffee-chat). 일관.
- `session_limits.{gaps,perspectives,contradictions,reprobes}`: Task 3.1 스키마 정의와 4.1 stats 읽기/쓰기 일치.
- `gate_state.last_askuserquestion_source`: Task 3.4 (set/reset), Task 3.8 (SKILL.md에서 declare) 일치.
- `defaultSessionLimits()` / `defaultGateState()` / `defaultSessionStats()`: 3개 헬퍼 이름 일관. `readStats`, `writeStats`도 일관.
- `emit(payload)` 헬퍼: Task 2.4에서 정의, 3.4/3.5/3.6/3.7에서 사용.

모든 식별자 일치 확인.

### 4. Open Questions에서 결정사항

- **Phase 2+3 커밋 묶음 여부**: 개별 Task 단위 커밋. Phase 경계에서 별도 묶음 없음 (각 Task가 PR 검증 가능한 독립 단위).
- **Contract Read 캐시**: 초안 — 에이전트는 첫 호출 시 매번 Read. 토큰 비용이 실측 후 문제되면 오케스트레이터가 contract 내용을 Agent 프롬프트에 인라인으로 삽입하는 방식으로 전환(Phase 5 후보).
- **화이트리스트 메커니즘**: 파일 기반(meta.json.gate_state.last_askuserquestion_source) 확정. Task 3.4에서 구현.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-21-resume-panel-restructure.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
