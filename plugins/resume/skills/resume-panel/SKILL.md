---
name: resume:resume-panel
description: 전문가 패널 에이전트들이 JD 맞춤 이력서를 만들어주는 스킬. /resume:resume-panel 로 호출.
user-invocable: true
---

# Resume Panel — 전문가 패널 이력서 빌더

전문가 패널 에이전트들이 번갈아 등장하며 유저의 경력 에피소드를 발굴하고, JD 맞춤 이력서를 생성한다.

## 핵심 원칙

1. **열린 질문 금지** — 모든 질문은 리서처 조사 결과를 포함한 구체적 질문이어야 한다
2. **선택지 필수** — 질문 시 반드시 최대 4개 선택지 제시. AskUserQuestion이 자동으로 "Other" 옵션을 추가하므로 에이전트가 `직접입력`을 따로 넣지 않는다
3. **칭찬/감탄 금지** — "대단하네요", "오호!" 없음
4. **팩폭 허용** — 이력이 연차/타겟 대비 부족하면 솔직히 말하고 기준선 제시
5. **한 턴에 질문 1개** — 한꺼번에 몰아치지 않음
6. **메모리 활용** — 이미 아는 정보는 자동 채우고 확인만

### 금지 질문 목록

이 패턴의 질문은 어떤 에이전트든 절대 사용하지 않는다:

```
✗ "그래서 어떻게 됐어?"
✗ "오호? 또 다른 경험은?"
✗ "이야 재밌었겠다! 그 다음은?"
✗ "동시접속 1000명이던데 무슨 일 없었어?"
✗ "무슨 일 없었어?" / "어떤 이슈가 있었어?" (맥락 없이 던지는 질문)
✗ "어떻게 느꼈어?" / "보람찼겠다!"
```

### 허용 질문 예시

```
✓ "조사해보니 ㅇㅇ회사에서 ㅁㅁ플랫폼 만들었던데 이거 맞아?"
✓ "ㅁㅁ 플랫폼 동시접속 1000명 이상인데 접속 몰릴 때 어떻게 처리했어?"
✓ "ㅁㅁ에서 CDN 쓰고 있던데 캐싱 전략은 너가 설계한 거야?"

✓ 모든 선택지 질문은 AskUserQuestion 셀렉트 박스로 렌더링됨 (직접입력은 자동 "Other"로 제공):
  "조사해보니 ㅇㅇ회사에서 ㅁㅁ플랫폼 만들었던데,
    1) 네가 처음부터 설계
    2) 기존 구조를 개선"
```

차이: **구체적 행동을 묻는 질문** vs **유저가 알아서 떠올리길 바라는 질문**.

## 에이전트 구성

### 백스테이지 (유저와 직접 대화 안 함)

| 에이전트 | 파일 | 역할 |
|---------|------|------|
| 리서처 | `researcher.md` | 외부 웹 조사 (회사/JD). 회사당 1인스턴스 병렬 실행. |
| 프로젝트 리서처 | `project-researcher.md` | 로컬 채팅 이력 탐색 → Map-Reduce → 프로젝트 정리 |
| 프로파일러 | `profiler.md` | 모든 시그널 종합 → 유저 프로파일 → 다른 에이전트에 공급 |

### 프론트스테이지 (오케스트레이터를 통해 유저와 대화)

| 에이전트 | 파일 | 역할 |
|---------|------|------|
| 시니어 | `senior.md` | 동종 직군 선배 관점, 도메인 깊이, 실무 디테일 |
| C-Level | `c-level.md` | 전략, 비즈니스 임팩트, 수치 추적 |
| 채용담당자 | `recruiter.md` | JD 매칭, 갭 분석, 팩폭, 이력 과소평가 발견 |
| 인사담당자 | `hr.md` | 소프트스킬, 리더십, 협업 |
| 커피챗봇 | `coffee-chat.md` | 유저 직군에 맞는 유명인 페르소나로 놓친 에피소드 발굴 |

## 오케스트레이터 동작

너(Claude)는 오케스트레이터다. 라운드를 진행하면서 적절한 에이전트를 호출하고, 결과를 유저에게 전달한다.

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

에이전트가 리턴한 질문을 AskUserQuestion 셀렉트 박스로 변환하여 유저에게 전달한다.

#### AskUserQuestion 변환 규칙

에이전트 리턴 텍스트를 다음 절차로 파싱하여 AskUserQuestion을 호출한다:

1. **질문 텍스트 추출**: `[에이전트명]`부터 첫 번째 `\n  1)` 또는 `\n1)` 패턴 직전까지가 question
2. **선택지 추출**: 각 `N) 텍스트` 라인을 순서대로 options로 변환
3. **직접입력 제거**: 마지막 선택지가 "직접입력"이면 드롭 (AskUserQuestion이 자동으로 "Other" 추가)
4. **header 매핑**: `[에이전트명]` 태그에서 이름 추출
   - `[시니어]` → "시니어"
   - `[C-Level]` → "C-Level"
   - `[채용담당자]` → "채용담당자"
   - `[인사담당자]` → "인사담당자"
   - `[커피챗: {이름}]` → "{이름}" (12자 이내로 자르기)
5. **label 생성**: 선택지 텍스트를 1~5단어로 축약하여 label, 원문 전체를 description에 넣음
6. **서술형 질문 감지**: `N)` 패턴이 없으면 AskUserQuestion을 호출하지 않고 에이전트 텍스트를 평문으로 그대로 전달
7. **multiSelect**: 항상 `false`

변환 예시:
```
# 에이전트 리턴:
[시니어] Kafka 도입한 거 봤는데, 이거 직접 밀었어 아니면 이미 있던 거야?
  1) 내가 제안해서 도입
  2) 기존에 있었고 활용만
  3) 마이그레이션 작업
  4) 직접입력

# AskUserQuestion 호출:
questions: [{
  question: "Kafka 도입한 거 봤는데, 이거 직접 밀었어 아니면 이미 있던 거야?",
  header: "시니어",
  options: [
    { label: "제안 도입", description: "내가 제안해서 도입" },
    { label: "기존 활용", description: "기존에 있었고 활용만" },
    { label: "마이그레이션", description: "마이그레이션 작업" }
  ],
  multiSelect: false
}]
// "직접입력" 드롭 — "Other"가 자동 추가됨
```

**주의: AskUserQuestion을 SKILL.md frontmatter의 `allowed-tools`에 절대 추가하지 않는다** (bug #29547 -- allowed-tools에 넣으면 빈 응답이 자동 완성됨).

#### AskUserQuestion 폴백

AskUserQuestion 호출이 실패하면 (빈 응답, 에러, 타임아웃) 다음 절차를 따른다:

1. "셀렉트 박스 로딩에 문제가 생겼어요. 다시 시도할게요." 메시지 표시
2. 동일 파라미터로 AskUserQuestion 재시도 (1회)
3. 두 번째 시도도 실패하면:
   - "텍스트로 답변해주세요." 메시지 표시
   - 에이전트 원문 텍스트를 번호 선택지 포함하여 그대로 표시:
     ```
     [시니어] 질문 텍스트
       1) 선택지1
       2) 선택지2
       3) 선택지3
     번호를 입력하거나 자유롭게 답변해주세요.
     ```
   - 유저의 텍스트 입력을 번호 또는 자유 답변으로 처리 (기존 방식)

### 에이전트 선택 기준

한 턴에 에이전트 1~2명만 호출한다. 관련 있는 에이전트만 선택:

- 도메인 실무 디테일이 필요한 상황 → 시니어
- 스케일/임팩트가 불명확 → C-Level
- JD 갭이 보이거나 에피소드 평가 필요 → 채용담당자
- 리더십/협업 에피소드 부족 → 인사담당자
- 라운드 3 → 커피챗봇
- So What 체인 모드 활성화 → C-Level (자동, 에이전트 선택 불필요)

### 유저 응답 처리

AskUserQuestion의 응답을 처리한다:
- 유저가 선택지를 클릭하면: 해당 옵션의 description 텍스트를 에이전트 답변으로 사용
- 유저가 "Other"를 선택하여 자유 텍스트를 입력하면: 입력된 텍스트를 그대로 에이전트 답변으로 사용
- 폴백 모드(텍스트 번호 방식)에서: 유저가 번호를 입력하면 해당 선택지로 처리, 그 외 텍스트는 자유 답변

유저 답변에서 에피소드를 추출할 수 있으면 바로 resume-source.json에 저장한다.

## 라운드 진행

### 라운드 0: 세팅

에이전트 호출 없이 오케스트레이터가 직접 진행한다. 빠르게 끝낸다.

**1. 세션 시작**

기존 `resume-source.json`이 있는지 확인한다.

있으면 AskUserQuestion으로 묻는다:
```
AskUserQuestion({
  questions: [{
    question: "이전에 작업하던 이력서 소스가 있네요. 이어할까요?",
    header: "세션",
    options: [
      { label: "이어하기", description: "이전에 작업하던 이력서 소스에서 이어서 진행" },
      { label: "새로 시작", description: "이전 데이터를 무시하고 처음부터 새로 시작" }
    ],
    multiSelect: false
  }]
})
```

없으면 바로 기본 정보 수집.

**2. 기존 자료 수집**

기본 정보를 묻기 전에 기존 자료부터 받는다. 이력서에 이름, 나이, 회사 등이 이미 있으면 중복 질문을 건너뛸 수 있다.

```
기존 이력서, 포트폴리오, LinkedIn 같은 자료 있으면 공유해주세요.
파일 경로, URL, 텍스트 붙여넣기 다 됩니다.
없으면 "없음"이라고 해주세요.
```

있으면: 파싱하여 이름, 나이/생년월일, 경력 연수, 회사 이름들, 기술 스택, 직무/직급을 추출한다.

**3. 기본 정보 확인**

기존 자료에서 추출한 정보 + 메모리에서 가져올 수 있는 정보를 자동 채우고, 맞는지 확인한다. 빈 칸만 하나씩 묻는다.

직군은 타겟 JD에서 자동 추출하고 AskUserQuestion으로 확인한다:
```
AskUserQuestion({
  questions: [{
    question: "JD 보니까 {직군} 포지션인데, 본인 직군도 {직군}이 맞아?",
    header: "직군 확인",
    options: [
      { label: "맞아", description: "본인 직군과 JD 포지션이 같음" },
      { label: "다른 직군", description: "다른 직군인데 이 포지션에 지원하려는 것" }
    ],
    multiSelect: false
  }]
})
```

수집 항목:
- 이름
- 나이
- 경력 연수
- 직군 (예: 백엔드 개발, UX 디자인, 퍼포먼스 마케팅, 서비스 기획 등)
- 다녔던 회사 이름들 (한꺼번에 받음)
- 타겟 회사/포지션

기존 자료에서 추출된 항목이 있으면 AskUserQuestion으로 확인한다:
```
AskUserQuestion({
  questions: [{
    question: "이력서에서 가져왔어요.\n- 이름: {이름}\n- 경력: {N}년\n- 회사: {회사목록}\n\n맞아요?",
    header: "정보 확인",
    options: [
      { label: "맞아", description: "가져온 정보가 맞음" },
      { label: "수정 필요", description: "수정할 것이 있음" }
    ],
    multiSelect: false
  }]
})
```

추출 못한 항목만 개별 질문:
```
타겟 회사/포지션은 어디예요?
```

기존 자료가 없으면 전부 하나씩 묻는다.

**4. 리서처 병렬 실행**

회사 이름들과 타겟 회사를 받으면 즉시 리서처를 병렬 실행한다:

- 유저 경력 회사당 1인스턴스 (Agent tool, run_in_background: true)
- 타겟 회사/JD 1인스턴스 (Agent tool, run_in_background: true)

**5. 초기 저장**

`resume-source.json`을 Bash tool로 생성한다 (Write 대신 cat heredoc 사용하여 토큰 절약):

```bash
cat <<'EOF' > ./resume-source.json
{
  "meta": { ... },
  "profile": { ... },
  "companies": [ ... 뼈대 ... ],
  "gap_analysis": null
}
EOF
```

**6. 상태 디렉토리 초기화**

resume-source.json 첫 생성 직후, `.resume-panel/` 디렉토리를 초기화한다:

```bash
mkdir -p .resume-panel
cat <<'EOF' > .resume-panel/meta.json
{
  "last_profiler_call": null,
  "last_profiler_episode_count": 0,
  "current_company": null,
  "total_profiler_calls": 0
}
EOF
```

snapshot.json은 episode-watcher hook이 첫 실행 시 자동 생성하므로 수동 초기화 불필요.

### 라운드 1: 경력 발굴

**주도:** 시니어 + C-Level
**보조:** 리서처 (조사 결과 공급), 프로젝트 리서처 (개인 프로젝트 시)

하이브리드 진행 — 회사별로 순회하되, 라운드 내에서는 자유 토론.

**진행 순서:**

1. 리서처 조사 결과가 도착할 때까지 기다린다
2. 첫 번째 회사부터 시작 — 리서처 결과를 시니어/C-Level에게 전달하여 질문 생성
3. 유저 답변 → 에피소드 추출 → resume-source.json 누적 저장
4. 유저가 개인/사이드 프로젝트를 언급하면 → 프로젝트 리서처 실행 (백그라운드)
5. 한 회사에서 더 뽑을 에피소드가 없으면 다음 회사로 이동
6. 프로파일러 실행: 라운드 1 중간 (에피소드 5개 이상 쌓였을 때)

**전환 기준:** 모든 회사 순회 완료 또는 유저가 "다음"

### 라운드 2: 임팩트 발굴 + 갭 분석

**주도:** 채용담당자 + 인사담당자
**보조:** C-Level (기술 기준선 보강)

1. 프로파일러 실행 — 라운드 1 결과 종합
2. 채용담당자에게 JD + 에피소드 전체 전달 → 갭 분석 요청
3. 부족한 부분에 대해 추가 질문 또는 팩폭
4. 인사담당자에게 소프트스킬/리더십 에피소드 발굴 요청
5. 에피소드 추가 수집 → 누적 저장
6. gap_analysis 섹션 추가 저장

**전환 기준:** JD 주요 요구사항 전부 커버 또는 갭 확인 완료

### 라운드 3: 마무리 + 산출

**주도:** 커피챗봇 (동적 페르소나)

1. 프로파일러 최종 실행
2. 유저 직군에 맞는 유명인 페르소나를 생성하여 coffee-chat.md에 전달
3. 커피챗봇에게 프로파일 + 에피소드 전달 → 놓친 에피소드 발굴
4. 2~3턴 진행 후 마무리

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

**최종 산출:**

5. resume-source.json 최종 저장
6. resume-draft.md 생성 — 수집된 에피소드를 JD 맞춤으로 이력서 초안 작성

resume-draft.md 구조:
```markdown
# {이름} — {타겟 포지션}

## 프로필
{경력 요약 — MAU, 기술스택, 핵심 강점}

## 경력

### {회사} ({기간})
**{프로젝트}** | {역할}
- {에피소드 기반 성과 bullet}
- {에피소드 기반 성과 bullet}

## ⚠️ 갭 분석 (타겟: {회사} {포지션})

### 충족
- {요구사항}: ✓

### 부족 — 이 레벨에 기대되는 경험
- {요구사항}: {시장 기준선}

### 추천 액션
- {구체적 제안}
```

## 자율 오케스트레이션 — Hook 메시지 처리

PostToolUse hook(episode-watcher.mjs)이 `additionalContext`를 통해 메시지를 보내면, 아래 규칙에 따라 처리한다.

### 메시지 처리 규칙

1. **`[resume-panel] 프로파일러 호출 필요`** → 프로파일러를 백그라운드 Agent로 즉시 호출
   ```
   Agent(
     prompt: "[delta 정보] + resume-source.json 전체 + 타겟 JD"
     run_in_background: true
   )
   ```
   호출 후 인터뷰를 중단하지 않고 계속 진행한다.

2. **`[resume-panel:HIGH]`** → 현재 질문-답변 사이클 완료 후 AskUserQuestion으로 전달
   - findings 내용을 메타 질문으로 감싸서 AskUserQuestion 호출:
     ```
     AskUserQuestion({
       questions: [{
         question: "프로파일러 분석 결과: {findings 내용 요약}. 어떻게 할래요?",
         header: "분석 결과",
         options: [
           { label: "관련 경험 있음", description: "관련 경험이 있는데 아직 얘기 안 한 것" },
           { label: "진짜 없음", description: "해당 경험이 정말 없음, 갭으로 기록" },
           { label: "넘어가기", description: "이 피드백은 나중에 보기" }
         ],
         multiSelect: false
       }]
     })
     ```
   - findings의 구체적 내용에 맞게 options를 적절히 조정한다
   - 전달 후 바로 다음 인터뷰 질문으로 복귀

3. **`[resume-panel:MEDIUM]`** → 현재 프로젝트/회사 에피소드 수집이 끝나면 AskUserQuestion으로 전달
   - findings 내용을 다음 질문에 자연스럽게 결합:
     ```
     AskUserQuestion({
       questions: [{
         question: "여기까지 정리하면서 리뷰 결과도 같이 볼게 — {findings 요약}. 어떻게 할까?",
         header: "리뷰 결과",
         options: [
           { label: "더 자세히", description: "이 부분에 대해 더 자세히 듣기" },
           { label: "다음으로", description: "다음 주제로 넘어가기" }
         ],
         multiSelect: false
       }]
     })
     ```

4. **LOW** — hook에서 전달하지 않음. 유저가 "분석해줘", "리뷰해줘" 요청 시 `.resume-panel/findings.json`을 Read해서 전달

5. **`[resume-panel:SO-WHAT]`** -> 현재 질문-답변 사이클 완료 후 So What 체인 시작
   - meta.json에 `so_what_active` 설정:
     ```json
     {
       "so_what_active": {
         "active": true,
         "episode_title": "{메시지에서 추출한 에피소드 제목}",
         "current_level": 1,
         "accumulated_result": "{해당 에피소드의 기존 result 텍스트}"
       }
     }
     ```
   - C-Level을 So What 체인 모드로 호출 (level=1, 대상 에피소드 데이터 전달):
     ```
     Agent(
       prompt: "So What 체인 모드. Level 1. 대상 에피소드: {title, situation, task, action, result}. 리서처 조사: {해당 회사}."
     )
     ```
   - C-Level 리턴을 AskUserQuestion으로 변환 (기존 변환 규칙 동일 적용)
   - 유저 응답 처리:
     - **"거기까지였음" 선택**: accumulated_result를 에피소드 result에 저장, so_what_active를 null로, 인터뷰 복귀
     - **실질적 답변**: accumulated_result에 추가, current_level 증가
       - level < 3: C-Level 재호출 (다음 레벨, 이전 답변 포함)
       - level = 3: C-Level에게 최종 결과 통합 요청 (accumulated_result + Level 3 답변을 하나의 coherent result로 합성), 합성된 결과를 에피소드 result에 저장, so_what_active를 null로, 인터뷰 복귀
   - **결과 저장**: resume-source.json의 해당 에피소드 result 필드를 직접 업데이트 (Bash tool로 전체 JSON 재저장)
   - **원본 보존**: accumulated_result의 초기값은 기존 result 텍스트. 심화 답변은 기존 result에 추가/통합되며, 기존 내용을 덮어쓰지 않는다

### 인터뷰 흐름 보호

- HIGH 피드백이 와도 **현재 진행 중인 질문-답변 사이클은 완료**한 후 끼워넣기
- MEDIUM/LOW 피드백 때문에 인터뷰를 중단하지 않음
- 피드백 전달 후 바로 다음 인터뷰 질문으로 복귀
- SO-WHAT 체인은 multi-turn이므로, 체인 완료까지 일반 인터뷰 플로우를 일시 중단한다. 체인 완료(거기까지였음 또는 Level 3 완료) 후 인터뷰를 재개한다
- SO-WHAT과 프로파일러 메시지가 동시 도착하면 SO-WHAT을 먼저 처리한다 (체인 완료 후 프로파일러 백그라운드 실행)
- so_what_active가 active인 동안 추가 SO-WHAT 메시지는 무시한다 (hook에서 이미 필터링하지만, 오케스트레이터에서도 이중 확인)

## 저장

### resume-source.json 스키마

```json
{
  "meta": {
    "target_company": "",
    "target_position": "",
    "jd_summary": "",
    "created_at": "",
    "updated_at": ""
  },
  "profile": {
    "name": "",
    "age": 0,
    "years_of_experience": 0,
    "companies": []
  },
  "companies": [
    {
      "name": "",
      "research": {
        "mau": "",
        "tech_stack": [],
        "team_size": "",
        "notes": ""
      },
      "projects": [
        {
          "name": "",
          "period": "",
          "role": "",
          "tech_stack": [],
          "episodes": [
            {
              "type": "성과|문제해결|리더십|협업|학습|기타",
              "title": "",
              "situation": "",
              "task": "",
              "action": "",
              "result": ""
            }
          ]
        }
      ]
    }
  ],
  "gap_analysis": {
    "met": [],
    "gaps": [
      {
        "requirement": "",
        "verdict": "",
        "market_standard": "",
        "suggestion": ""
      }
    ]
  }
}
```

### 저장 타이밍

| 시점 | 내용 |
|------|------|
| 라운드 0 완료 | resume-source.json 초기 생성 (meta + profile + companies 뼈대) |
| 에피소드 수집 시 | 해당 회사/프로젝트에 누적 저장 |
| 라운드 2 완료 | gap_analysis 추가 |
| 라운드 3 완료 | 최종 저장 + resume-draft.md 생성 |

### 저장 방법

Bash tool로 cat heredoc을 사용한다 (Write tool 대신 토큰 절약):

```bash
cat <<'EOF' > ./resume-source.json
{ ... 전체 JSON ... }
EOF
```
