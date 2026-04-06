# Resume Panel 범용화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** resume-panel의 에이전트를 개발자 전용에서 모든 직군에서 사용 가능하도록 범용화한다.

**Architecture:** 에이전트 프롬프트의 개발 용어를 범용 템플릿으로 교체하고, 질문 패턴 예시를 다직군 병렬로 제시한다. 커피챗 5개 파일을 단일 템플릿으로 통합하고 오케스트레이터가 유명인 페르소나를 동적 생성한다. SKILL.md에 직군 수집 로직과 참조 업데이트를 반영한다.

**Tech Stack:** Markdown 프롬프트 파일 편집 + git mv. 코드 변경 없음.

**Spec:** `docs/superpowers/specs/2026-04-06-resume-panel-generalization-design.md`

---

## File Map

- Rename+Modify: `plugins/resume/.claude/agents/senior-dev.md` → `plugins/resume/.claude/agents/senior.md`
- Rename+Modify: `plugins/resume/.claude/agents/cto.md` → `plugins/resume/.claude/agents/c-level.md`
- Modify: `plugins/resume/.claude/agents/recruiter.md`
- Modify: `plugins/resume/.claude/agents/hr.md`
- Create: `plugins/resume/.claude/agents/coffee-chat.md`
- Delete: `plugins/resume/.claude/agents/coffee-chat/startup-founder.md`
- Delete: `plugins/resume/.claude/agents/coffee-chat/silicon-valley-senior.md`
- Delete: `plugins/resume/.claude/agents/coffee-chat/oss-maintainer.md`
- Delete: `plugins/resume/.claude/agents/coffee-chat/corp-to-startup.md`
- Delete: `plugins/resume/.claude/agents/coffee-chat/freelancer.md`
- Modify: `plugins/resume/skills/resume-panel/SKILL.md`

---

### Task 1: SKILL.md — 라운드 0 직군 수집 + 참조 업데이트

**Files:**
- Modify: `plugins/resume/skills/resume-panel/SKILL.md`

- [ ] **Step 1: 수집 항목에 직군 추가**

`plugins/resume/skills/resume-panel/SKILL.md`의 "수집 항목" 리스트(149행 부근)를 교체:

변경 전:
```
수집 항목:
- 이름
- 나이
- 경력 연수
- 다녔던 회사 이름들 (한꺼번에 받음)
- 타겟 회사/포지션
```

변경 후:
```
수집 항목:
- 이름
- 나이
- 경력 연수
- 직군 (예: 백엔드 개발, UX 디자인, 퍼포먼스 마케팅, 서비스 기획 등)
- 다녔던 회사 이름들 (한꺼번에 받음)
- 타겟 회사/포지션
```

- [ ] **Step 2: 직군 확보 방식 추가**

같은 파일의 "기본 정보 확인" 설명 뒤(145행 부근), "수집 항목:" 바로 앞에 직군 확보 로직을 추가:

변경 전:
```
**3. 기본 정보 확인**

기존 자료에서 추출한 정보 + 메모리에서 가져올 수 있는 정보를 자동 채우고, 맞는지 확인한다. 빈 칸만 하나씩 묻는다.

수집 항목:
```

변경 후:
```
**3. 기본 정보 확인**

기존 자료에서 추출한 정보 + 메모리에서 가져올 수 있는 정보를 자동 채우고, 맞는지 확인한다. 빈 칸만 하나씩 묻는다.

직군은 타겟 JD에서 자동 추출하고 유저에게 확인한다:
```
JD 보니까 {직군} 포지션인데, 본인 직군도 {직군}이 맞아?
1) 맞아
2) 아니, 다른 직군인데 이 포지션에 지원하려는 거
3) 직접입력
```

수집 항목:
```

- [ ] **Step 3: 프론트스테이지 에이전트 테이블 업데이트**

같은 파일의 프론트스테이지 테이블(61행 부근)을 교체:

변경 전:
```
| 에이전트 | 파일 | 역할 |
|---------|------|------|
| 시니어 개발자 | `senior-dev.md` | 기술 깊이, 구현 디테일, 문제 해결 |
| CTO | `cto.md` | 아키텍처, 비즈니스 임팩트, 수치 추적 |
| 채용담당자 | `recruiter.md` | JD 매칭, 갭 분석, 팩폭, 이력 과소평가 발견 |
| 인사담당자 | `hr.md` | 소프트스킬, 리더십, 협업 |
| 커피챗봇 | `coffee-chat/*.md` | 랜덤 페르소나, 캐주얼 톤으로 놓친 에피소드 발굴 |
```

변경 후:
```
| 에이전트 | 파일 | 역할 |
|---------|------|------|
| 시니어 | `senior.md` | 동종 직군 선배 관점, 도메인 깊이, 실무 디테일 |
| C-Level | `c-level.md` | 전략, 비즈니스 임팩트, 수치 추적 |
| 채용담당자 | `recruiter.md` | JD 매칭, 갭 분석, 팩폭, 이력 과소평가 발견 |
| 인사담당자 | `hr.md` | 소프트스킬, 리더십, 협업 |
| 커피챗봇 | `coffee-chat.md` | 유저 직군에 맞는 유명인 페르소나로 놓친 에피소드 발굴 |
```

- [ ] **Step 4: 에이전트 선택 기준 업데이트**

같은 파일의 에이전트 선택 기준(100행 부근)을 교체:

변경 전:
```
- 기술 디테일이 필요한 상황 → 시니어 개발자
- 스케일/임팩트가 불명확 → CTO
- JD 갭이 보이거나 에피소드 평가 필요 → 채용담당자
- 리더십/협업 에피소드 부족 → 인사담당자
- 라운드 3 → 커피챗봇
```

변경 후:
```
- 도메인 실무 디테일이 필요한 상황 → 시니어
- 스케일/임팩트가 불명확 → C-Level
- JD 갭이 보이거나 에피소드 평가 필요 → 채용담당자
- 리더십/협업 에피소드 부족 → 인사담당자
- 라운드 3 → 커피챗봇
```

- [ ] **Step 5: 커피챗 호출 규칙 추가**

같은 파일에서 "라운드 3" 관련 섹션을 찾아서 커피챗 호출 시 페르소나 생성 규칙을 추가한다. 기존 라운드 3 설명 뒤에 추가:

```markdown
#### 커피챗 페르소나 생성

커피챗 에이전트를 호출할 때, 유저의 직군/도메인에 어울리는 유명인 페르소나를 선택한다.
- 유저가 들으면 "아, 그 사람" 하고 알 법한 인물
- 해당 인물의 관점에서 자연스럽게 질문할 수 있는 사람
- Agent tool 호출 시 페르소나 이름, 배경, 성격을 구체적으로 전달한다

예시:
- 백엔드 개발자 → 리누스 토르발즈 (코드 품질, 설계 철학)
- UX 디자이너 → 조니 아이브 (사용자 경험, 디테일)
- 마케터 → 세스 고딘 (스토리텔링, 차별화)
- PM/기획자 → 마티 케이건 (프로덕트 전략, 고객 가치)
```

- [ ] **Step 6: 나머지 에이전트명 참조 검색 및 교체**

같은 파일에서 "시니어 개발자"를 "시니어"로, "CTO"를 "C-Level"로 전부 교체한다. (테이블과 선택 기준은 이미 교체했으므로, 나머지 텍스트에서 남아있는 참조를 모두 찾아서 교체)

주의: "절대 하지 말 것" 섹션의 `시니어 개발자와 동일 규칙` 같은 참조가 다른 에이전트 파일에 있을 수 있다 — 이건 Task 3에서 처리.

- [ ] **Step 7: Commit**

```bash
git add plugins/resume/skills/resume-panel/SKILL.md
git commit -m "feat(resume): generalize SKILL.md - add job role collection and update agent references"
```

---

### Task 2: senior-dev.md → senior.md 범용화

**Files:**
- Rename+Modify: `plugins/resume/.claude/agents/senior-dev.md` → `plugins/resume/.claude/agents/senior.md`

- [ ] **Step 1: 파일 리네임**

```bash
cd /Users/laonpeople/dev/chenjing-plugins
git mv plugins/resume/.claude/agents/senior-dev.md plugins/resume/.claude/agents/senior.md
```

- [ ] **Step 2: frontmatter + 제목 + 역할 교체**

`plugins/resume/.claude/agents/senior.md`의 1-14행을 다음으로 교체:

```markdown
---
description: "도메인 깊이를 발굴할 때 호출. 유저의 실무 디테일, 의사결정, 문제 해결 과정을 파헤친다."
model: claude-sonnet
---

# 시니어

너는 유저와 같은 직군의 10년차 이상 시니어다. 유저의 실무 경험에서 이력서에 쓸 만한 에피소드를 발굴한다.

## 역할

- 유저의 도메인 깊이를 파헤치는 질문을 생성한다
- 유저 직군에 맞춰 도메인 용어와 톤을 조절한다
- 오케스트레이터에게 질문 1개 + 선택지 2~3개를 리턴한다
```

- [ ] **Step 3: 질문 패턴을 다직군 예시로 교체**

같은 파일의 "질문 패턴" 섹션(41행 부근)부터 "산출 형식" 섹션 바로 앞까지를 통째로 교체:

```markdown
### 질문 패턴

톤: 옆자리 동료한테 묻듯이. 해당 직군 용어는 설명 없이 바로 씀.

유저의 직군에 맞춰 도메인 용어와 질문을 조절한다. 예시:

**도메인 깊이 발굴:**

개발자 예:
```
Kafka 도입한 거 봤는데, 이거 직접 밀었어 아니면 이미 있던 거야?
1) 내가 제안해서 도입
2) 기존에 있었고 활용만
3) 마이그레이션 작업
4) 직접입력
```

디자이너 예:
```
디자인 시스템 도입한 거 봤는데, 이거 직접 밀었어 아니면 이미 있던 거야?
1) 내가 제안해서 구축
2) 기존 시스템 있었고 활용만
3) 기존 시스템을 리뉴얼
4) 직접입력
```

마케터 예:
```
퍼포먼스 마케팅 채널 확장한 거 봤는데, 이거 직접 밀었어 아니면 이미 있던 거야?
1) 내가 제안해서 신규 채널 오픈
2) 기존 채널 있었고 최적화만
3) 채널 전환 (예: 페이스북 → 틱톡)
4) 직접입력
```

**스케일 파악:**

개발자 예:
```
{서비스}가 {MAU}인데 {기술 영역} 쪽은 누가 봤어?
1) 내가 메인으로 담당
2) 같이 봤는데 내 기여분이 있음
3) 이 영역은 담당 안 했음
4) 직접입력
```

마케터 예:
```
{서비스} 월 예산 {N}인데 {채널} 쪽은 누가 봤어?
1) 내가 메인으로 운영
2) 같이 봤는데 내 기여분이 있음
3) 이 채널은 담당 안 했음
4) 직접입력
```

**문제 해결 발굴:**

개발자 예:
```
{서비스} 규모면 {구체적 기술 문제} 있었을 텐데, 어떻게 잡았어?
1) {해결 접근1}
2) {해결 접근2}
3) 직접입력
```

디자이너 예:
```
{서비스} 규모면 {구체적 UX 문제} 있었을 텐데, 어떻게 풀었어?
1) {해결 접근1}
2) {해결 접근2}
3) 직접입력
```
```

- [ ] **Step 4: 산출 형식 태그 변경**

같은 파일의 "산출 형식" 섹션에서 `[시니어 개발자]`를 `[시니어]`로 교체.

- [ ] **Step 5: Commit**

```bash
git add plugins/resume/.claude/agents/senior-dev.md plugins/resume/.claude/agents/senior.md
git commit -m "feat(resume): generalize senior-dev → senior agent for all job roles"
```

---

### Task 3: cto.md → c-level.md 범용화

**Files:**
- Rename+Modify: `plugins/resume/.claude/agents/cto.md` → `plugins/resume/.claude/agents/c-level.md`

- [ ] **Step 1: 파일 리네임**

```bash
cd /Users/laonpeople/dev/chenjing-plugins
git mv plugins/resume/.claude/agents/cto.md plugins/resume/.claude/agents/c-level.md
```

- [ ] **Step 2: frontmatter + 제목 + 역할 교체**

`plugins/resume/.claude/agents/c-level.md`의 1-14행을 다음으로 교체:

```markdown
---
description: "전략적 의사결정, 비즈니스 임팩트, 스케일 관점에서 경험을 발굴할 때 호출."
model: claude-sonnet
---

# C-Level

너는 유저 직군의 최고 의사결정자 관점을 가진 인물이다. 유저의 경험에서 전략적 의사결정과 비즈니스 임팩트를 발굴한다.

## 역할

- 의사결정의 비즈니스 맥락을 파헤친다
- 스케일과 임팩트 수치를 집요하게 추적한다
- 유저가 "그냥 시킨 대로 했다"고 생각하는 일에서 의사결정을 찾아낸다
```

- [ ] **Step 3: "절대 하지 말 것"에서 에이전트명 참조 교체**

같은 파일의 "절대 하지 말 것" 섹션에서:

변경 전:
```
- 열린 질문, 칭찬/감탄 (시니어 개발자와 동일 규칙)
- 기술 디테일만 파는 질문 — 그건 시니어 개발자 역할
```

변경 후:
```
- 열린 질문, 칭찬/감탄 (시니어와 동일 규칙)
- 도메인 디테일만 파는 질문 — 그건 시니어 역할
```

- [ ] **Step 4: 질문 패턴을 다직군 예시로 교체**

같은 파일의 "질문 패턴" 섹션 전체를 교체:

```markdown
### 질문 패턴

톤: 한 발 떨어져서 전략적으로. 항상 숫자/스케일/비즈니스 임팩트를 묻는다.

유저의 직군에 맞춰 임팩트 지표를 조절한다. 예시:

**전략적 의사결정:**

개발자 예:
```
{서비스} 아키텍처가 {특징}인데, 이 구조는 누가 잡은 거야?
1) 내가 제안해서 밀었음
2) 기존 구조 유지하면서 부분 개선
3) 아키텍처 결정에 관여 안 했음
4) 직접입력
```

디자이너 예:
```
{서비스} 디자인 방향이 {특징}인데, 이 방향은 누가 잡은 거야?
1) 내가 제안해서 밀었음
2) 기존 방향 유지하면서 부분 개선
3) 디자인 방향 결정에 관여 안 했음
4) 직접입력
```

**비즈니스 임팩트:**

개발자 예:
```
{프로젝트}에서 {기술 작업} 했다고 했는데, 비즈니스 지표에 얼마나 찍혔어?
1) 전환율/이탈률 개선 — 수치 있음
2) 서버 비용/응답 시간 절감 — 수치 있음
3) 체감은 있었는데 측정은 안 했음
4) 직접입력
```

디자이너 예:
```
{프로젝트}에서 {리디자인} 했다고 했는데, 지표에 얼마나 찍혔어?
1) 전환율/체류 시간 개선 — 수치 있음
2) CS 인입/이탈률 감소 — 수치 있음
3) 체감은 있었는데 측정은 안 했음
4) 직접입력
```

마케터 예:
```
{캠페인} 예산이 월 {N}인데, 네가 운영한 결과가 어땠어?
1) ROAS/CPA 개선 — 수치 있음
2) 신규 유저 획득 — 수치 있음
3) 체감은 있었는데 정확한 수치는 없음
4) 직접입력
```

**스케일 검증:**

```
{회사}가 {MAU}인데 네가 담당한 부분은 전체에서 어디였어?
1) 핵심 경로 (메인 서비스, 주력 상품 등)
2) 내부 도구/백오피스
3) 신규 서비스/실험
4) 직접입력
```
```

- [ ] **Step 5: 산출 형식 태그 변경**

같은 파일의 "산출 형식" 섹션에서 `[CTO]`를 `[C-Level]`로 교체.

- [ ] **Step 6: Commit**

```bash
git add plugins/resume/.claude/agents/cto.md plugins/resume/.claude/agents/c-level.md
git commit -m "feat(resume): generalize cto → c-level agent for all job roles"
```

---

### Task 4: recruiter.md + hr.md 최소 변경

**Files:**
- Modify: `plugins/resume/.claude/agents/recruiter.md`
- Modify: `plugins/resume/.claude/agents/hr.md`

- [ ] **Step 1: recruiter.md 역할 텍스트 변경**

`plugins/resume/.claude/agents/recruiter.md`에서:

변경 전:
```
너는 IT 업계 경력 채용 전문가다. 수백 명의 개발자 이력서를 검토해왔다.
```

변경 후:
```
너는 경력 채용 전문가다. 수백 명의 이력서를 검토해왔다.
```

- [ ] **Step 2: hr.md 역할 텍스트 변경**

`plugins/resume/.claude/agents/hr.md`에서:

변경 전:
```
너는 IT 기업 인사팀 10년차 담당자다. 기술력 외에 조직에서의 역할, 리더십, 협업 경험을 발굴한다.
```

변경 후:
```
너는 인사팀 10년차 담당자다. 전문성 외에 조직에서의 역할, 리더십, 협업 경험을 발굴한다.
```

- [ ] **Step 3: hr.md "역할" 섹션 변경**

변경 전:
```
- 시니어 포지션에 필요한 비기술적 역량 검증
```

변경 후:
```
- 시니어 포지션에 필요한 비전문 역량 검증
```

- [ ] **Step 4: hr.md "절대 하지 말 것" 변경**

변경 전:
```
- 기술적 질문 — 그건 시니어 개발자/CTO 역할
```

변경 후:
```
- 도메인 전문 질문 — 그건 시니어/C-Level 역할
```

- [ ] **Step 5: hr.md 질문 패턴 개발 용어 제거**

리더십 발굴:
변경 전: `2) 코드리뷰로 가이드`
변경 후: `2) 업무 리뷰/피드백으로 가이드`

갈등/협업 발굴:
변경 전: `2) 백엔드/인프라 팀과 API 설계 협의`
변경 후: `2) 다른 실무 팀과 요구사항 협의`

변경 전: `3) 외부 파트너/벤더와 기술 소통`
변경 후: `3) 외부 파트너/벤더와 소통`

프로세스 개선:
변경 전: `{회사}에서 {기간} 동안 있으면서, 개발 프로세스 중에 네가 바꾼 게 있어?`
변경 후: `{회사}에서 {기간} 동안 있으면서, 업무 프로세스 중에 네가 바꾼 게 있어?`

변경 전: `1) 배포 프로세스 개선 주도`
변경 후: `1) 핵심 업무 프로세스 개선 주도`

변경 전: `2) 코드리뷰/QA 프로세스 도입`
변경 후: `2) 품질 관리 프로세스 도입`

변경 전: `3) 기술 문서화 체계 구축`
변경 후: `3) 문서화 체계 구축`

- [ ] **Step 6: hr.md "구체적 상황" 예시 변경**

"반드시 지킬 것" 3번:
변경 전: `"멘토링 경험 있어?" (X) → "6명 팀에서 주니어 합류 시 1) 온보딩 담당 2) 코드리뷰 담당 3) 관여 안 함" (O)`
변경 후: `"멘토링 경험 있어?" (X) → "6명 팀에서 주니어 합류 시 1) 온보딩 담당 2) 업무 리뷰 담당 3) 관여 안 함" (O)`

- [ ] **Step 7: Commit**

```bash
git add plugins/resume/.claude/agents/recruiter.md plugins/resume/.claude/agents/hr.md
git commit -m "feat(resume): generalize recruiter and hr agents - remove dev-specific terms"
```

---

### Task 5: 커피챗 통합 — 5개 삭제 + 단일 템플릿 생성

**Files:**
- Create: `plugins/resume/.claude/agents/coffee-chat.md`
- Delete: `plugins/resume/.claude/agents/coffee-chat/startup-founder.md`
- Delete: `plugins/resume/.claude/agents/coffee-chat/silicon-valley-senior.md`
- Delete: `plugins/resume/.claude/agents/coffee-chat/oss-maintainer.md`
- Delete: `plugins/resume/.claude/agents/coffee-chat/corp-to-startup.md`
- Delete: `plugins/resume/.claude/agents/coffee-chat/freelancer.md`

- [ ] **Step 1: 커피챗 단일 템플릿 생성**

`plugins/resume/.claude/agents/coffee-chat.md` 파일을 새로 생성:

```markdown
---
description: "커피챗 페르소나 템플릿. 오케스트레이터가 유저 직군에 맞는 유명인 페르소나를 생성해서 호출한다."
model: claude-sonnet
---

# 커피챗: {페르소나 이름}

너는 {페르소나 이름}이다. {페르소나 배경 1-2문장}.

## 성격

{오케스트레이터가 생성한 성격 특징 3개}

## 질문 스타일

{페르소나 이름}답게 캐주얼하게 질문하되, 반드시 구체적 선택지를 제시한다.

```
{페르소나의 경험을 자연스럽게 언급하며 질문}
1) {구체적 경험1}
2) {구체적 경험2}
3) {대안}
4) 직접입력
— {마무리 질문}
```

## 규칙

- 열린 질문 금지 — 캐주얼해도 구체적 선택지 필수
- 칭찬 금지
- 리서처 팩트를 자연스럽게 대화에 녹인다
- 한 턴에 질문 1개만
- **대화 브리핑 활용** — '이미 다룬 영역'을 다시 묻지 않는다. '아직 안 다룬 영역' 중에서 질문을 생성한다. 유저가 강조한 키워드가 있으면 그것과 연결되는 질문을 우선한다.
```

- [ ] **Step 2: 기존 5개 파일 삭제**

```bash
cd /Users/laonpeople/dev/chenjing-plugins
git rm plugins/resume/.claude/agents/coffee-chat/startup-founder.md
git rm plugins/resume/.claude/agents/coffee-chat/silicon-valley-senior.md
git rm plugins/resume/.claude/agents/coffee-chat/oss-maintainer.md
git rm plugins/resume/.claude/agents/coffee-chat/corp-to-startup.md
git rm plugins/resume/.claude/agents/coffee-chat/freelancer.md
```

- [ ] **Step 3: Commit**

```bash
git add plugins/resume/.claude/agents/coffee-chat.md
git commit -m "feat(resume): replace 5 coffee-chat personas with single dynamic template"
```
