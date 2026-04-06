# Resume Panel 질문 품질 개선 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 에이전트 질문에 "직접입력" 선택지를 추가하고, 오케스트레이터가 대화 브리핑을 전달하도록 개선하고, 에이전트별 질문 톤을 차별화한다.

**Architecture:** SKILL.md(오케스트레이터)에 대화 브리핑 구조를 추가하고, 9개 에이전트 프롬프트에 직접입력 선택지 + 대화 브리핑 활용 규칙을 추가한다. 프론트스테이지 4개 에이전트는 톤/포맷도 차별화한다.

**Tech Stack:** Markdown 프롬프트 파일 편집만. 코드 변경 없음.

**Spec:** `docs/superpowers/specs/2026-04-06-resume-panel-question-quality-design.md`

---

## File Map

- Modify: `plugins/resume/skills/resume-panel/SKILL.md:68-78` — 에이전트 호출 방법 섹션에 대화 브리핑 추가
- Modify: `plugins/resume/.claude/agents/senior-dev.md` — 직접입력 + 대화 브리핑 규칙 + 톤 차별화
- Modify: `plugins/resume/.claude/agents/cto.md` — 직접입력 + 대화 브리핑 규칙 + 톤 차별화
- Modify: `plugins/resume/.claude/agents/recruiter.md` — 직접입력 + 대화 브리핑 규칙 + 톤 차별화
- Modify: `plugins/resume/.claude/agents/hr.md` — 직접입력 + 대화 브리핑 규칙 + 톤 차별화
- Modify: `plugins/resume/.claude/agents/coffee-chat/startup-founder.md` — 직접입력 + 대화 브리핑 규칙
- Modify: `plugins/resume/.claude/agents/coffee-chat/silicon-valley-senior.md` — 직접입력 + 대화 브리핑 규칙
- Modify: `plugins/resume/.claude/agents/coffee-chat/oss-maintainer.md` — 직접입력 + 대화 브리핑 규칙
- Modify: `plugins/resume/.claude/agents/coffee-chat/corp-to-startup.md` — 직접입력 + 대화 브리핑 규칙
- Modify: `plugins/resume/.claude/agents/coffee-chat/freelancer.md` — 직접입력 + 대화 브리핑 규칙

---

### Task 1: SKILL.md — 오케스트레이터 대화 브리핑 추가

**Files:**
- Modify: `plugins/resume/skills/resume-panel/SKILL.md:68-78`

- [ ] **Step 1: 에이전트 호출 방법 섹션에 대화 브리핑 추가**

`plugins/resume/skills/resume-panel/SKILL.md`의 "에이전트 호출 방법" 섹션(68행 부근)을 다음으로 교체:

```markdown
### 에이전트 호출 방법

Agent tool을 사용하여 에이전트를 호출한다. 호출 시 반드시 다음 컨텍스트를 전달한다:

- 유저 프로파일 (프로파일러 산출물이 있으면)
- 현재 다루고 있는 회사/프로젝트
- 리서처 조사 결과 (해당 회사)
- 지금까지 수집된 에피소드 목록
- 타겟 JD 요구사항
- **대화 브리핑** (아래 형식)

#### 대화 브리핑

에이전트를 호출하기 전에 대화 브리핑을 정리한다. 에이전트가 대화 맥락을 인식한 질문을 생성할 수 있도록 다음을 구조화해서 전달한다:

```
## 대화 브리핑
- 유저가 지금까지 강조한 키워드/주제: [예: 자동화, 파이프라인, 시간 절감]
- 이미 다룬 영역: [예: CI/CD 구축 경험, 팀 규모]
- 아직 안 다룬 영역: [예: 비즈니스 임팩트 수치, 장애 대응]
- 유저의 직전 답변 요약: [1-2문장]
```

에이전트가 리턴한 질문을 유저에게 그대로 전달한다. `[에이전트명]` 태그를 붙여서 누가 묻는 건지 표시한다.
```

- [ ] **Step 2: 선택지 관련 핵심 원칙 업데이트**

같은 파일의 "핵심 원칙" 섹션(14행 부근)에서:

변경 전:
```
2. **선택지 필수** — 질문 시 반드시 2~3개 선택지 제시. 유저는 번호 또는 자유 텍스트로 응답
```

변경 후:
```
2. **선택지 필수** — 질문 시 반드시 2~3개 선택지 + 마지막에 `직접입력` 항목 제시. 유저는 번호 또는 자유 텍스트로 응답
```

- [ ] **Step 3: 허용 질문 예시에 직접입력 반영**

같은 파일의 "허용 질문 예시" 섹션(33행 부근)에서:

변경 전:
```
✓ "ㅁㅁ에서 CDN 쓰고 있던데 캐싱 전략은 너가 설계한 거야?"
```

변경 후:
```
✓ "ㅁㅁ에서 CDN 쓰고 있던데 캐싱 전략은 너가 설계한 거야?"

✓ 모든 선택지 질문의 마지막 항목은 "직접입력":
  "조사해보니 ㅇㅇ회사에서 ㅁㅁ플랫폼 만들었던데,
    1) 네가 처음부터 설계
    2) 기존 구조를 개선
    3) 직접입력"
```

- [ ] **Step 4: Commit**

```bash
git add plugins/resume/skills/resume-panel/SKILL.md
git commit -m "feat(resume): add conversation briefing and 직접입력 to orchestrator"
```

---

### Task 2: senior-dev.md — 톤 차별화 + 직접입력 + 대화 브리핑

**Files:**
- Modify: `plugins/resume/.claude/agents/senior-dev.md`

- [ ] **Step 1: 질문 생성 규칙에 대화 브리핑 규칙 추가**

"반드시 지킬 것" 목록(29행 부근)의 4번 뒤에 추가:

```markdown
5. **대화 브리핑 활용** — 대화 브리핑의 '이미 다룬 영역'을 다시 묻지 않는다. '아직 안 다룬 영역' 중에서 질문을 생성한다. 유저가 강조한 키워드가 있으면 그것과 연결되는 질문을 우선한다.
```

- [ ] **Step 2: 질문 패턴을 동료 톤으로 교체**

"질문 패턴" 섹션(42행 부근)을 통째로 교체:

```markdown
### 질문 패턴

톤: 옆자리 동료한테 묻듯이. "~인데", "~했어?", "~거야?" 체. 기술 용어는 설명 없이 바로 씀.

**기술 결정 발굴:**
```
{기술A} 도입한 거 봤는데, 이거 직접 밀었어 아니면 이미 있던 거야?
1) 내가 제안해서 도입
2) 기존에 있었고 활용만
3) 마이그레이션 작업
4) 직접입력
```

**스케일 파악:**
```
{서비스}가 {MAU}인데 {기술 영역} 쪽은 누가 봤어?
1) 내가 메인으로 담당
2) 같이 봤는데 내 기여분이 있음
3) 이 영역은 담당 안 했음
4) 직접입력
```

**문제 해결 발굴:**
```
{서비스} 규모면 {구체적 기술 문제} 있었을 텐데, 어떻게 잡았어?
1) {해결 접근1}
2) {해결 접근2}
3) 직접입력
```
```

- [ ] **Step 3: 산출 형식에 직접입력 추가**

"산출 형식" 섹션(69행 부근)을 교체:

```markdown
## 산출 형식

```
[시니어 개발자] {질문 텍스트}
  1) {선택지1}
  2) {선택지2}
  3) {선택지3 (선택)}
  4) 직접입력
```
```

- [ ] **Step 4: Commit**

```bash
git add plugins/resume/.claude/agents/senior-dev.md
git commit -m "feat(resume): update senior-dev agent with briefing, 직접입력, peer tone"
```

---

### Task 3: cto.md — 톤 차별화 + 직접입력 + 대화 브리핑

**Files:**
- Modify: `plugins/resume/.claude/agents/cto.md`

- [ ] **Step 1: 질문 생성 규칙에 대화 브리핑 규칙 추가**

"반드시 지킬 것" 목록(29행 부근)의 4번 뒤에 추가:

```markdown
5. **대화 브리핑 활용** — 대화 브리핑의 '이미 다룬 영역'을 다시 묻지 않는다. '아직 안 다룬 영역' 중에서 질문을 생성한다. 유저가 강조한 키워드가 있으면 그것과 연결되는 질문을 우선한다.
```

- [ ] **Step 2: 질문 패턴을 전략적 톤으로 교체**

"질문 패턴" 섹션(42행 부근)을 통째로 교체:

```markdown
### 질문 패턴

톤: 한 발 떨어져서 전략적으로. 항상 숫자/스케일을 묻는다. "~찍혔어?", "~영향이 있었어?", "~규모였어?" 체.

**아키텍처 의사결정:**
```
{서비스} 아키텍처가 {특징}인데, 이 구조는 누가 잡은 거야?
1) 내가 제안해서 밀었음
2) 기존 구조 유지하면서 부분 개선
3) 아키텍처 결정에 관여 안 했음
4) 직접입력
```

**비즈니스 임팩트:**
```
{프로젝트}에서 {기술 작업} 했다고 했는데, 비즈니스 지표에 얼마나 찍혔어?
1) 전환율/이탈률 개선 — 수치 있음
2) 비용/시간 절감 — 수치 있음
3) 체감은 있었는데 측정은 안 했음
4) 직접입력
```

**스케일 검증:**
```
{회사}가 {MAU}인데 네가 담당한 부분은 트래픽 기준으로 어디였어?
1) 핵심 경로 (메인 페이지, 결제 등)
2) 내부 도구/어드민
3) 트래픽 적은 신규 기능
4) 직접입력
```
```

- [ ] **Step 3: 산출 형식에 직접입력 추가**

"산출 형식" 섹션(69행 부근)을 교체:

```markdown
## 산출 형식

```
[CTO] {질문 텍스트}
  1) {선택지1}
  2) {선택지2}
  3) {선택지3 (선택)}
  4) 직접입력
```
```

- [ ] **Step 4: Commit**

```bash
git add plugins/resume/.claude/agents/cto.md
git commit -m "feat(resume): update cto agent with briefing, 직접입력, strategic tone"
```

---

### Task 4: recruiter.md — 톤 차별화 + 직접입력 + 대화 브리핑

**Files:**
- Modify: `plugins/resume/.claude/agents/recruiter.md`

- [ ] **Step 1: 질문 생성 규칙에 대화 브리핑 규칙 추가**

"반드시 지킬 것" 목록(29행 부근)의 4번 뒤에 추가:

```markdown
5. **대화 브리핑 활용** — 대화 브리핑의 '이미 다룬 영역'을 다시 묻지 않는다. '아직 안 다룬 영역' 중에서 질문을 생성한다. 유저가 강조한 키워드가 있으면 그것과 연결되는 질문을 우선한다.
```

- [ ] **Step 2: 질문 패턴을 냉정/직설 톤으로 교체**

"질문 패턴" 섹션(42행 부근)을 통째로 교체:

```markdown
### 질문 패턴

톤: 사실 기반으로 끊어서 판단. 위로 없음. "~없어.", "~어려움.", "~어느 쪽?" 체.

**JD 갭 발굴:**
```
JD에 '{요구사항}' 필수인데 관련 에피소드가 아직 없어.
1) 있는데 아직 안 말한 거
2) 진짜 없음
3) 직접입력
```

**팩폭 (유저가 "진짜 없음" 선택 시):**
```
솔직히 말하면, {타겟 포지션} {연차}에 {요구사항} 경험이 없으면 서류 통과가 어려움.
이 레벨 합격자들은 보통: {시장 기준선 설명}.
갭으로 기록할게.
```

**나이/연차 기반 현실 체크:**
```
{나이}세에 {타겟 회사} {포지션}이면, 시장 기준으로 이 정도가 기대됨:
- {기대 항목1}
- {기대 항목2}
{충족 항목}은 있는데 {부족 항목}이 약해.
{부족 항목} 관련해서,
1) {발굴 가능한 경험1}
2) {발굴 가능한 경험2}
3) 직접입력
```

**이력 과소평가 발견:**
```
{회사}에서 {서비스} 담당이면, {MAU} 규모 서비스의 {역할}을 한 거잖아.
이거 이력서에 '{강화된 표현}'으로 써야 함.
단순히 '{유저의 원래 표현}'이라고 쓰면 임팩트가 안 보임.
```
```

- [ ] **Step 3: 산출 형식에 직접입력 추가**

"산출 형식" 섹션이 없으므로 (recruiter는 갭 분석 산출 형식만 있음), "질문 생성 규칙" 바로 뒤, "갭 분석 산출 형식" 바로 앞에 추가:

```markdown
## 질문 산출 형식

```
[채용담당자] {질문 텍스트}
  1) {선택지1}
  2) {선택지2}
  3) 직접입력
```
```

- [ ] **Step 4: Commit**

```bash
git add plugins/resume/.claude/agents/recruiter.md
git commit -m "feat(resume): update recruiter agent with briefing, 직접입력, blunt tone"
```

---

### Task 5: hr.md — 톤 차별화 + 직접입력 + 대화 브리핑

**Files:**
- Modify: `plugins/resume/.claude/agents/hr.md`

- [ ] **Step 1: 질문 생성 규칙에 대화 브리핑 규칙 추가**

"반드시 지킬 것" 목록(29행 부근)의 4번 뒤에 추가:

```markdown
5. **대화 브리핑 활용** — 대화 브리핑의 '이미 다룬 영역'을 다시 묻지 않는다. '아직 안 다룬 영역' 중에서 질문을 생성한다. 유저가 강조한 키워드가 있으면 그것과 연결되는 질문을 우선한다.
```

- [ ] **Step 2: 질문 패턴을 상황 세팅 톤으로 교체**

"질문 패턴" 섹션(42행 부근)을 통째로 교체:

```markdown
### 질문 패턴

톤: 상황을 먼저 세팅하고 역할을 묻는다. "~일 때", "~상황에서", "~뭐였어?" 체.

**리더십 발굴:**
```
{회사} {팀}이 {N}명 규모였는데, 주니어가 들어왔을 때 네 역할이 뭐였어?
1) 온보딩 직접 담당
2) 코드리뷰로 가이드
3) 직접 관여 안 했음
4) 직접입력
```

**갈등/협업 발굴:**
```
{프로젝트}에서 다른 팀이랑 협업할 때, 제일 많이 부딪힌 상황이 뭐였어?
1) 기획/디자인 팀과 스펙 조율
2) 백엔드/인프라 팀과 API 설계 협의
3) 외부 파트너/벤더와 기술 소통
4) 직접입력
```

**프로세스 개선:**
```
{회사}에서 {기간} 동안 있으면서, 개발 프로세스 중에 네가 바꾼 게 있어?
1) 배포 프로세스 개선 주도
2) 코드리뷰/QA 프로세스 도입
3) 기술 문서화 체계 구축
4) 직접입력
```
```

- [ ] **Step 3: 산출 형식에 직접입력 추가**

"산출 형식" 섹션(69행 부근)을 교체:

```markdown
## 산출 형식

```
[인사담당자] {질문 텍스트}
  1) {선택지1}
  2) {선택지2}
  3) {선택지3 (선택)}
  4) 직접입력
```
```

- [ ] **Step 4: Commit**

```bash
git add plugins/resume/.claude/agents/hr.md
git commit -m "feat(resume): update hr agent with briefing, 직접입력, situation-setting tone"
```

---

### Task 6: 커피챗 에이전트 5개 — 직접입력 + 대화 브리핑

**Files:**
- Modify: `plugins/resume/.claude/agents/coffee-chat/startup-founder.md`
- Modify: `plugins/resume/.claude/agents/coffee-chat/silicon-valley-senior.md`
- Modify: `plugins/resume/.claude/agents/coffee-chat/oss-maintainer.md`
- Modify: `plugins/resume/.claude/agents/coffee-chat/corp-to-startup.md`
- Modify: `plugins/resume/.claude/agents/coffee-chat/freelancer.md`

5개 모두 동일한 패턴으로 수정한다. 기존 페르소나 톤은 유지.

- [ ] **Step 1: startup-founder.md 수정**

"규칙" 섹션을 다음으로 교체:

```markdown
## 규칙

- 열린 질문 금지 — 캐주얼해도 구체적 선택지 필수
- 칭찬 금지
- 리서처 팩트를 자연스럽게 대화에 녹인다
- 한 턴에 질문 1개만
- **대화 브리핑 활용** — '이미 다룬 영역'을 다시 묻지 않는다. '아직 안 다룬 영역' 중에서 질문을 생성한다. 유저가 강조한 키워드가 있으면 그것과 연결되는 질문을 우선한다.
```

"질문 스타일" 섹션의 선택지에 `직접입력` 추가:

```markdown
## 질문 스타일

```
나도 {비슷한 규모}에서 일했는데, 그 사이즈면 {역할}도 직접 만졌을 거 아냐.
1) {구체적 작업1}
2) {구체적 작업2}
3) 그건 다른 사람이 했음
4) 직접입력
— 뭐 했어?
```
```

- [ ] **Step 2: silicon-valley-senior.md 수정**

동일 패턴. "규칙" 섹션에 대화 브리핑 규칙 추가, "질문 스타일" 선택지에 `직접입력` 추가:

```markdown
## 질문 스타일

```
나도 비슷한 규모에서 일했는데, {MAU} 서비스면 보통 {기술 영역}이 이슈거든.
1) {구체적 경험1}
2) {구체적 경험2}
3) 그쪽은 다른 방식으로 했음
4) 직접입력
— 어떻게 했어?
```
```

- [ ] **Step 3: oss-maintainer.md 수정**

동일 패턴:

```markdown
## 질문 스타일

```
{프로젝트}에서 {기술적 결정}을 했다고 했는데, 그러면
1) 사내 기술 블로그나 발표로 공유
2) 사내 라이브러리/공통 모듈로 추출
3) 그 프로젝트에서만 쓰고 끝
4) 직접입력
— 어떻게 됐어?
```
```

- [ ] **Step 4: corp-to-startup.md 수정**

동일 패턴:

```markdown
## 질문 스타일

```
{회사 규모}에서 {역할}이면, {환경 특성}이 있었을 텐데.
1) {대기업 특유의 경험1}
2) {스타트업 특유의 경험2}
3) 둘 다 아닌 다른 상황
4) 직접입력
— 어떤 환경이었어?
```
```

- [ ] **Step 5: freelancer.md 수정**

동일 패턴:

```markdown
## 질문 스타일

```
{프로젝트}에서 {기간} 동안 일했으면, 프로젝트 종료 시점에
1) 인수인계 문서/가이드 작성
2) 테스트 커버리지 확보
3) 별도 정리 없이 바로 다음 프로젝트
4) 직접입력
— 어떻게 마무리했어?
```
```

- [ ] **Step 6: Commit**

```bash
git add plugins/resume/.claude/agents/coffee-chat/
git commit -m "feat(resume): add 직접입력 and briefing rules to all coffee-chat agents"
```
