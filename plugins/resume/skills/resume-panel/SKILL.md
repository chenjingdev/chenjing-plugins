---
name: resume:resume-panel
description: 전문가 패널 에이전트들이 JD 맞춤 이력서를 만들어주는 스킬. /resume:resume-panel 로 호출.
user-invocable: true
---

# Resume Panel — 전문가 패널 이력서 빌더

전문가 패널 에이전트들이 번갈아 등장하며 유저의 경력 에피소드를 발굴하고, JD 맞춤 이력서를 생성한다.

## 호출 모드 (1.3)

스킬은 라운드 선형 진행이 기본이지만, 인자로 특정 모드에 직행할 수 있다. 기존 `resume-source.json`이 있을 때만 모드 인자가 의미를 가진다 (없으면 모드 무시하고 라운드 0부터).

**호출 형태**: `/resume:resume-panel {mode} [추가 설명]`

| 모드 인자 | 동작 | 사용 상황 |
|---------|------|---------|
| (없음) | 라운드 0 → 1 → 2 → 3 선형 진행 | 처음 시작 또는 기본 이어하기 |
| `추가 탐색` / `explore` | Round 1 5.5 (일상 루틴) 모드로 직행. 회사 선택 후 해당 회사만 재탐색 | 이미 draft 생성 후 추가 에피소드 필요 |
| `자소서만` / `cover-letter` | Round 3 최종 산출의 "자소서 초안 생성" 단계만 실행. 에피소드 수집/갭 분석 스킵 | JD 자소서 항목이 바뀌었을 때 재생성 |
| `갭 재분석` / `regap` | Round 2 갭 분석만 재실행. 기존 에피소드 그대로 사용 | 타겟 회사/JD가 바뀌었을 때 |
| `모순 체크` / `contradict` | 프로파일러 claim 추출 + 모순 탐지만 실행. 발견 시 유저 확인 | 여러 번 수정 후 데이터 정합성 점검 |
| `리라이트` / `rewrite` | Round 3 draft 생성만 재실행 (모든 단계 1~8). 에피소드는 기존 사용 | draft 포맷/구성만 재생성 |

**인자 파싱 규칙**:

- 유저 첫 메시지가 `/resume:resume-panel {text}` 형태면 `{text}`를 mode arg로 해석
- 위 표의 한국어 또는 영어 키워드 매칭 (부분 문자열, 대소문자 무시)
- 매칭 실패 또는 키워드 없음 → 기본 선형 진행
- `추가 탐색 튜닙` 처럼 뒤에 회사명이 붙으면 해당 회사를 대상으로 스코핑

**모드 실행 시 주의**:

- 모드 실행 전 `resume-source.json` 존재 확인. 없으면 "모드 실행은 기존 세션이 있을 때만 가능해. 라운드 0부터 시작할게"로 폴백
- 모드 완료 후 유저에게 "계속 일반 플로우로 갈까?" 확인 (AskUserQuestion)
- 모드는 라운드 상태를 건드리지 않음 — 일반 플로우 재개 시 마지막 라운드 위치에서 이어감

---

## 핵심 원칙

1. **열린 질문 금지** — 모든 질문은 리서처 조사 결과를 포함한 구체적 질문이어야 한다
2. **선택지 필수** — 질문 시 반드시 최대 4개 선택지 제시. AskUserQuestion이 자동으로 "Other" 옵션을 추가하므로 에이전트가 `직접입력`을 따로 넣지 않는다
3. **칭찬/감탄 금지** — "대단하네요", "오호!" 없음
4. **팩폭 허용** — 이력이 연차/타겟 대비 부족하면 솔직히 말하고 기준선 제시
5. **한 턴에 질문 1~3개 (배치 허용)** — 관련 주제는 묶어서 물어도 OK. 단, 답 하나가 다음 질문의 전제가 되는 경우(분기형)는 반드시 1개만
6. **메모리 활용** — 이미 아는 정보는 자동 채우고 확인만
7. **대화 컨텍스트 재사용** — 스킬 호출 전 대화에 이미 PDF/이력서/JD가 공유되었으면 라운드 0의 "기존 자료 수집" 단계를 스킵하고 바로 파싱한다 (재요구 금지)

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
- **리서처 활용 필수 팩트 (최소 1개 인용)**: [예: "BuyBox 쿠폰 적용가 정렬", "GDS 마이그레이션", "MAU 800만"] — 에이전트가 반드시 이 중 1개 이상을 질문에 명시적으로 넣어야 함
```

**리서처 결과 강제 활용 (3.2)**: 에이전트에 리서처 결과를 전달할 때, 추상 요약이 아닌 **구체 팩트 3~5개를 bullet로 추출**하여 브리핑의 "리서처 활용 필수 팩트"에 나열한다. 에이전트는 그 중 최소 1개를 질문 본문에 인용해야 한다. 이 규칙 없이 리서처 결과를 통으로 던지면 에이전트가 팩트를 묵살하고 일반 질문을 생성하는 경향이 있다.

에이전트가 리턴한 질문을 AskUserQuestion 셀렉트 박스로 변환하여 유저에게 전달한다.

#### AskUserQuestion 변환 규칙

에이전트 리턴 텍스트를 다음 절차로 파싱하여 AskUserQuestion을 호출한다:

1. **질문 블록 분할**: `[에이전트명]` 태그가 여러 개 연속으로 나오면 각각을 별개의 question으로 취급한다. 에이전트는 1~3개의 질문을 배치로 리턴할 수 있다
2. **질문 텍스트 추출**: 각 블록 내에서 `[에이전트명]`부터 첫 번째 `\n  1)` 또는 `\n1)` 패턴 직전까지가 question
3. **선택지 추출**: 블록 내 `N) 텍스트` 라인을 순서대로 options로 변환
4. **직접입력 제거**: 마지막 선택지가 "직접입력"이면 드롭 (AskUserQuestion이 자동으로 "Other" 추가)
5. **header 매핑**: `[에이전트명]` 태그에서 이름 추출
   - `[시니어]` → "시니어"
   - `[C-Level]` → "C-Level"
   - `[채용담당자]` → "채용담당자"
   - `[인사담당자]` → "인사담당자"
   - `[커피챗: {이름}]` → "{이름}" (12자 이내로 자르기)
6. **label 생성**: 선택지 텍스트를 1~5단어로 축약하여 label, 원문 전체를 description에 넣음
7. **서술형 질문 감지**: `N)` 패턴이 없으면 AskUserQuestion을 호출하지 않고 에이전트 텍스트를 평문으로 그대로 전달
8. **multiSelect**: 항상 `false`
9. **배치 상한**: 한 AskUserQuestion 호출에 최대 3개 질문. 4개 이상이면 앞 3개만 보내고 나머지는 다음 턴으로 이월
10. **배치 조건**: 다음 모두 만족 시에만 배치로 묶는다
    - 질문들이 서로 독립적 (앞 답변이 뒤 질문의 전제가 아님)
    - 유저의 이전 답변이 5단어 이상 또는 15초 이내 응답 — 빠른 답변자 시그널. `meta.json.response_speed` 필드에 최근 3회 평균 유지 (있으면 참고, 없으면 default=single)
    - 분기형 질문(유저 답변에 따라 다음 질문이 달라지는 경우)은 절대 배치하지 않음

변환 예시 (단일):
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

변환 예시 (배치 — 관련 주제 2개 묶음):
```
# 에이전트 리턴:
[시니어] Kafka 파티션 전략은 누가 정했어?
  1) 내가 설계
  2) 기존 설계 유지
  3) 팀 논의 후 합의
[시니어] Consumer lag 모니터링은 어떻게 했어?
  1) Burrow 같은 전용 툴
  2) Prometheus + Grafana
  3) 별도 모니터링 안 함

# AskUserQuestion 호출 (questions 배열에 2개):
questions: [
  { question: "...", header: "시니어", options: [...] },
  { question: "...", header: "시니어", options: [...] }
]
```

배치 금지 예시 (분기형 — 첫 답변이 다음 질문의 전제):
```
# 에이전트 리턴:
[시니어] Kafka 도입 주도했어? (내가 제안/기존 활용)
[시니어] 도입 과정에서 레거시 마이그레이션 있었어?  // ← 첫 질문 답에 따라 의미가 달라짐

# 이 경우 첫 질문만 단일 호출. 답변 받은 후 두 번째 질문 생성
```

**주의: AskUserQuestion을 SKILL.md frontmatter의 `allowed-tools`에 절대 추가하지 않는다** (bug #29547 -- allowed-tools에 넣으면 빈 응답이 자동 완성됨).

#### AskUserQuestion 폴백

AskUserQuestion 호출이 실패하면 (빈 응답, 에러, 타임아웃, **유저가 reject/취소/dismiss**) 다음 절차를 따른다:

1. 유저 reject/dismiss 케이스는 특히 주의:
   - "취소", "아니 다시", "잘못 눌렀어", "다시 띄워줘", 또는 AskUserQuestion이 빈 문자열/null/"interrupted" 류의 응답을 리턴하는 경우 → reject로 간주
   - reject로 판정되면 유저 재요청을 기다리지 말고 **즉시** 동일 파라미터로 1회 자동 재시도
2. "다시 띄워드릴게요." 또는 (빈응답/타임아웃이면) "셀렉트 박스 로딩에 문제가 생겼어요. 다시 시도할게요." 메시지 표시
3. 동일 파라미터로 AskUserQuestion 재시도 (1회)
4. 두 번째 시도도 실패하면:
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

**reject 감지 주의**: 자동 재시도는 1회만. 두 번째 시도도 유저가 reject하면 텍스트 모드로 fallback. 3회 이상 AskUserQuestion을 반복 호출하지 않는다 — 무한 재시도 방지.

### 에이전트 선택 기준

한 턴에 에이전트 1~2명만 호출한다. 관련 있는 에이전트만 선택:

- 도메인 실무 디테일이 필요한 상황 → 시니어
- 스케일/임팩트가 불명확 → C-Level
- JD 갭이 보이거나 에피소드 평가 필요 → 채용담당자
- 리더십/협업 에피소드 부족 → 인사담당자
- 라운드 3 → 커피챗봇
- So What 체인 모드 활성화 → C-Level (자동, 에이전트 선택 불필요)
- 타임라인 갭 프로빙 필요 → 인사담당자 (갭 프로빙 모드)
- 패턴에서 `target_agent` 지정됨 → 해당 에이전트 우선
- 관점 전환 finding에서 `target_agent` 지정됨 → 해당 에이전트 관점 전환 모드로 호출
- 모순 복원 (contradiction_detected) → 오케스트레이터가 직접 AskUserQuestion으로 처리 (별도 에이전트 호출 불필요)
- 과소평가 재프로빙 모드 (underestimation_reprobe) → 직전 에이전트를 재호출 (같은 영역에서 구체 프로빙 질문 1개 더 생성)

### 유저 응답 처리

AskUserQuestion의 응답을 처리한다:
- 유저가 선택지를 클릭하면: 해당 옵션의 description 텍스트를 에이전트 답변으로 사용
- 유저가 "Other"를 선택하여 자유 텍스트를 입력하면: 입력된 텍스트를 그대로 에이전트 답변으로 사용
- 폴백 모드(텍스트 번호 방식)에서: 유저가 번호를 입력하면 해당 선택지로 처리, 그 외 텍스트는 자유 답변

유저 답변에서 에피소드를 추출할 수 있으면 바로 resume-source.json에 저장한다.

#### 과소평가 자기보고 재프로빙

유저가 질문에 대해 "없음", "부족", "딱히", "잘 모르겠어", "특별한 거 없어" 류의 자기 부정 답변을 하면, 바로 수용하지 말고 **1회 재프로빙**한다. 한국 유저의 자기 과소평가 경향(PROJECT.md 기반)을 감안한 안전장치다.

**재프로빙 조건 (ALL):**
- 직전 질문이 "경험 여부" 또는 "에피소드 존재" 확인 유형
- 유저 답변이 자기부정 키워드 포함 (없음/부족/딱히/모르겠/특별히/그런 건 없)
- 해당 영역에 대해 이번 세션에서 재프로빙 이력 없음 (meta.json `reprobe_log` 배열로 추적)

**재프로빙 방법:**
- 직전 에이전트를 재호출. 프롬프트에 추가 지시:
  ```
  과소평가 재프로빙 모드. 유저가 "{원답변}"이라고 했는데, 일상적으로 하고 있어서 특별하다고 못 느끼는 경우일 수 있음.
  "혹시 {구체 활동/루틴}을 하고 있는 건 아닌지?" 패턴으로 1개 질문만 생성.
  답이 또 부정이면 그땐 진짜 없는 걸로 수용.
  ```
- 에이전트 리턴 → AskUserQuestion 변환 → 유저 답변
- 답변이 또 부정이면 gap으로 기록하고 복귀
- meta.json `reprobe_log`에 `{area, timestamp}` append

**재프로빙 금지:**
- 같은 영역에 세션당 1회 초과 금지
- 유저가 "진짜 없어"로 명시적 부정하면 재프로빙 안 함
- 에피소드 디테일(액션/결과) 질문에는 적용하지 않음 — 경험 존재 여부 질문에만 적용

## 라운드 진행

### 라운드 0: 세팅

에이전트 호출 없이 오케스트레이터가 직접 진행한다. 빠르게 끝낸다.

**0.1 환경 체크 (하드 게이트)**

리서치 품질이 Playwright MCP에 의존하므로, 미설치 환경에서는 진행하지 않는다.

```bash
claude mcp list 2>&1 | grep -iE 'playwright'
```

- 종료 코드 0 (매칭 있음) → 다음 단계 진행
- 종료 코드 ≠ 0 → 아래 안내 메시지를 출력하고 스킬 종료 (Round 0.2 이후 절대 진행 금지):

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

스킬 호출 전 대화를 먼저 훑는다. 다음이 이미 컨텍스트에 있으면 해당 수집 단계를 스킵한다:

- **이력서/포트폴리오 PDF/텍스트**: 파일 경로가 대화에 등장했거나, 유저가 내용을 붙여넣었으면 → "기존 자료 수집" 단계(아래 2번) 스킵, 바로 파싱
- **JD/공고**: 대화에 이미 JD 텍스트나 분석 결과가 있으면 → 타겟 회사/포지션 수집(3번) 스킵, 메모리에서 추출
- **복수 이력서**: 같은 사람의 이력서가 2개 이상 감지되면 → 자동 diff 후 기술 차이 리스트업 → 유저에게 어느 쪽이 정확한지 AskUserQuestion으로 확인 (아래 "복수 이력서 diff 절차" 참조)

스캔 결과 요약을 유저에게 먼저 보여준다:
```
컨텍스트에서 발견:
- 이력서: {파일명 또는 '붙여넣기 텍스트'}
- JD: {타겟 회사/포지션}
- 이 정보로 바로 진행할게요. 추가 자료 있으면 알려줘.
```

발견 안 되면 일반 플로우(1번부터)로 진행.

**복수 이력서 diff 절차 (2.3)**:

같은 사람의 이력서 2개 이상이 감지되면 (파일명, 대화 컨텍스트, 또는 유저가 명시적으로 공유), 다음 절차로 diff 분석한다:

1. **파싱**: 각 이력서에서 `(회사, 기간, 역할, bullet 목록)` 형태로 구조화
2. **회사 단위 매칭**: 같은 회사가 양쪽에 있으면 해당 회사의 bullet을 nullable 매칭 (텍스트 유사도 기준, 80% 이상이면 같은 bullet으로 간주)
3. **차이 분류**:
   - **A에만 있음**: 한쪽 이력서에만 적힌 bullet
   - **B에만 있음**: 반대쪽 이력서에만 적힌 bullet
   - **표현 차이**: 같은 활동을 다르게 표현 (예: "업체 1곳 추가 확보" vs "협력 업체 관리")
   - **수치 불일치**: 같은 성과에 다른 수치 (예: "30% 개선" vs "40% 개선")
4. **유저 확인** — 차이가 많으면 한 번에 몰아서 AskUserQuestion 배치 모드로 최대 3개 묻기:
   ```
   AskUserQuestion({
     questions: [
       {
         question: "쿠팡 이력서에는 '협력 운영 업체 1곳 추가 확보'가 있는데 G마켓 이력서엔 없어. 실제로 한 적 있어?",
         header: "차이 확인",
         options: [
           { label: "한 적 있음", description: "쿠팡 이력서가 맞음. 에피소드로 추가" },
           { label: "한 적 없음", description: "쿠팡 이력서가 과장. 제거해야 함" },
           { label: "맥락 다름", description: "같은 사람이지만 맥락이 다른 활동" }
         ],
         multiSelect: false
       },
       // ... 최대 3개까지 배치
     ]
   })
   ```
5. **결과 저장**:
   - "한 적 없음" 응답 → resume-source.json에 해당 bullet 넣지 않음 + `context_notes`에 "기존 이력서(쿠팡)에 과장 기술 있었으나 유저 확인 후 제거" 기록
   - "한 적 있음" → 해당 bullet을 정식 에피소드 발굴 대상으로 큐잉 (Round 1에서 STAR 보강)
   - "맥락 다름" → 두 bullet 모두 보존

**diff 제한**:
- 5개 초과 차이는 유저에게 한 번에 보여주지 않고 상위 3개만 배치로. 나머지는 "더 볼까?" 옵션으로 추가 요청 시에만 노출
- 파싱 실패 시(형식이 너무 달라 매칭 불가) 다음 fallback: "여러 이력서가 있는데 자동 비교가 어려워. 가장 최근 것 하나만 기준으로 갈까?" 질문

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
cat <<EOF > .resume-panel/meta.json
{
  "session_started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "last_profiler_call": null,
  "last_profiler_episode_count": 0,
  "current_company": null,
  "total_profiler_calls": 0,
  "gap_probes_this_session": 0,
  "perspective_shifts_this_session": 0,
  "perspective_shifted_episodes": [],
  "contradictions_presented_this_session": 0,
  "reprobe_log": [],
  "daily_routine_explored_companies": [],
  "response_speed": { "recent_avg_seconds": null, "samples": [] }
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
5. 한 회사에서 기존 이력서 bullet 기반 에피소드 4~5개 수집 완료 → **일상 루틴 탐색 페이즈(5.5) 자동 삽입**
6. 다음 회사로 이동
7. 프로파일러 실행: 라운드 1 중간 (에피소드 5개 이상 쌓였을 때)

**5.5. 일상 루틴 탐색 페이즈 (신규)**

기존 이력서 bullet에 갇혀 있는 에피소드 발굴을 보완하기 위해, 각 회사당 한 번 시니어에게 "주간 루틴" 기반 질문을 생성하도록 지시한다.

호출 방식:
```
Agent(
  subagent_type: "senior",
  prompt: "{기존 컨텍스트}. 일상 루틴 탐색 모드. 유저가 이 회사에서 한 일상 업무(주간/월간 반복 업무, 정기 행사 대응, 정책/문서 운영, 교육/멘토링, 사이드 오퍼레이션 등) 중 이력서에 안 적은 것을 발굴할 질문 1개. 예: '행사 시즌 검수', '정책 위키 운영', '신입 교육', '정기 모니터링 당번'. 리서처 결과의 회사 특성(커머스/B2B/등)을 반영한 구체적 후보 2~3개를 선택지로 제시."
)
```

- 시니어 질문 리턴 → AskUserQuestion 변환 → 유저 답변
- 답변에 구체 활동이 나오면 해당 영역으로 2~3턴 더 파고듦 → 에피소드 추출
- "없음" 답변이면 **과소평가 재프로빙 규칙**(위 섹션) 발동 → 1회 재프로빙
- 완료 시 meta.json `daily_routine_explored_companies` 배열에 회사명 추가 (중복 탐색 방지)

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

**최종 산출 (순서 엄수):**

draft 생성은 **반드시 아래 순서**로 진행한다. 특히 간략소개는 항상 **마지막**에 작성한다 — 전체 에피소드(행사검수/정책위키/교육 등 Round 1 5.5에서 뒤늦게 발굴된 것 포함)를 종합해야 정확한 요약이 나오기 때문이다.

**1. resume-source.json 최종 저장** — 수집 완료된 전체 데이터 저장

**2. 출력 포맷 선택** (4.1)

유저에게 AskUserQuestion으로 원하는 출력 포맷을 묻는다:
```
AskUserQuestion({
  questions: [{
    question: "이력서 포맷을 어떻게 뽑을까?",
    header: "출력 포맷",
    options: [
      { label: "자유양식", description: "마크다운 자유 양식 (개발자/디자이너 포트폴리오 스타일)" },
      { label: "잡코리아형", description: "잡코리아/사람인 양식 — 간략소개/경력/자소서 분리" },
      { label: "둘 다", description: "자유양식 + 잡코리아형 둘 다 생성" }
    ],
    multiSelect: false
  }]
})
```

**3. 자소서 항목 확인** (4.3) — 잡코리아형 또는 '둘 다' 선택 시에만

타겟 JD에 자소서 항목이 명시되어 있는지 먼저 확인한다:
- JD 텍스트에서 "자기소개서", "자소서 항목", "다음 항목에 대해 작성" 같은 키워드 + 번호 목록을 파싱 시도
- 파싱 성공 시: 추출된 항목을 유저에게 확인만 (AskUserQuestion)
- 파싱 실패 시: 유저에게 항목수/주제를 묻는다:
  ```
  AskUserQuestion({
    questions: [{
      question: "자소서 항목을 어떻게 할까?",
      header: "자소서 항목",
      options: [
        { label: "기본 4개", description: "강점1 / 강점2 / 강점3 / 지원동기" },
        { label: "공고 붙여넣기", description: "JD에 자소서 항목이 있는데 못 찾은 경우 — 유저가 텍스트로 붙여넣기" },
        { label: "3개만", description: "강점1 / 강점2 / 지원동기" }
      ],
      multiSelect: false
    }]
  })
  ```

**4. 에피소드 → 경력 bullet 변환**

수집된 에피소드를 JD 맞춤 bullet으로 변환하여 경력 섹션 생성. 회사별/프로젝트별 정렬.

**5. 갭 분석 섹션 생성** (gap_analysis 기반)

**6. 자소서 초안 생성** (잡코리아형일 때)

단계 3에서 확정된 항목수/주제에 맞춰 각 항목당 400~800자 초안 생성. 에피소드 참조 명시 (`{회사명}:{에피소드 제목}`).

**7. 간략소개(요약) 생성** ← **항상 마지막** (4.2)

전체 경력 섹션, 갭 분석, 자소서 초안이 모두 완성된 후에 **처음으로** 간략소개를 작성한다:
- 입력: 완성된 경력 bullets 전체 + 자소서 초안 + 갭 분석 결과
- 출력: 3~5줄 요약 (핵심 강점 3개 + 타겟 포지션 적합성 1문장)
- Round 1 5.5(일상 루틴)에서 뒤늦게 발굴된 에피소드도 자동으로 반영됨
- 에피소드 1~2개 기반으로 초기에 간략소개를 만들지 않는다 — 반드시 전체 수집 완료 후

**8. resume-draft.md 파일(들) 쓰기**

선택된 포맷에 따라 파일을 쓴다:
- 자유양식만: `resume-draft.md`
- 잡코리아형만: `resume-draft-jobkorea.md`
- 둘 다: 두 파일 모두 생성

**9. 회고 분석 호출**

`retrospective` 에이전트를 호출한다. 다음 컨텍스트를 함께 전달:

- 세션 대화 요약 (오케스트레이터가 라운드별 주요 turn을 정리한 텍스트)
- `.resume-panel/findings.json` 전체 내용
- `resume-source.json`의 episodes 요약 (회사별 개수, STAR 충실도)
- 세션 메타데이터:
  - 시작 시각: `.resume-panel/meta.json` 또는 첫 turn 시각
  - 종료 시각: 현재 시각
  - 라운드별 turn 수: 오케스트레이터가 카운트

리턴값은 마크다운 텍스트.

**10. 회고 파일 저장 + 안내**

세션 ID 생성: `YYYYMMDD-HHMMSS` 형식 (예: `20260420-143052`).

```bash
mkdir -p docs/retrospectives
```

리턴된 마크다운을 `docs/retrospectives/{session-id}.md`로 Write. 예: `docs/retrospectives/20260420-143052.md`.

저장 후 유저에게 한 줄 안내:
```
세션 회고를 docs/retrospectives/{filename}.md에 저장했어. 다음 세션 시작 전에 한 번 훑어봐.
```

### 포맷 템플릿

**자유양식** (`resume-draft.md`):
```markdown
# {이름} — {타겟 포지션}

## 간략소개
{3~5줄 요약 — 단계 7에서 생성}

## 핵심 역량
{키워드 기반 태그 리스트}

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

**잡코리아형** (`resume-draft-jobkorea.md`):
```markdown
# {이름}

## 1. 간략소개 (자기소개 요약)
{3~5줄 — 잡코리아 입력란에 바로 복붙 가능한 형태}

## 2. 경력사항

### {회사} | {직급} | {기간}
**담당 업무**
- {에피소드 bullet}

**주요 성과**
- {수치 포함 성과 bullet}

## 3. 자기소개서

### 항목 1: {JD 또는 기본 제목}
{400~800자 초안 — 에피소드 ref: {회사명}:{에피소드 제목}}

### 항목 2: ...

## 4. 갭 분석 참고 (내부용, 제출 전 제거)
{자유양식과 동일}
```

**출력 포맷 금지사항:**
- 간략소개를 draft 생성 초기에 작성하지 않는다 (단계 7에서만)
- 자소서 항목수를 4개로 고정하지 않는다 (단계 3에서 확정)
- 잡코리아형에 갭 분석 섹션을 제출용으로 포함하지 않는다 (내부 참고용 표시)

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

   **프로파일러 완료 시 1줄 요약 자동 표시** (신규):
   - 백그라운드 Agent가 완료되면 findings-inbox.jsonl에 append된 결과를 읽고, 다음 유저 턴(다음 AskUserQuestion 또는 평문 메시지) 전에 1줄 요약을 **평문**으로 표시:
     ```
     📊 프로파일 분석 완료: 강점 {N}개 · 갭 {N}개 · 패턴 {N}개. '분석 보여줘'로 상세 확인.
     ```
   - 숫자는 이번 사이클에 새로 생성된 finding 기준(HIGH + MEDIUM + LOW 전체). 0이면 해당 카테고리 생략
   - HIGH/SO-WHAT이 섞여 있으면 요약을 **먼저** 표시한 후 원래 규칙(item 2/5)대로 AskUserQuestion 전달
   - 1줄 요약은 AskUserQuestion이 아닌 평문 출력이므로 인터뷰 흐름을 끊지 않음
   - 유저가 "분석 보여줘"/"리뷰해줘" 요청 시 `.resume-panel/findings.json`을 Read하여 상세 전달 (item 4 규칙과 동일)

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

6. **`[resume-panel:MEDIUM]` (timeline_gap_found)** → 갭 프로빙
   - MEDIUM 메시지 내용에 "공백" + "개월"이 포함되어 있으면 타임라인 갭 finding으로 판단
   - meta.json의 `intentional_gaps` 배열 확인 — 이미 스킵한 갭이면 무시하고 다음 메시지로
   - HR 에이전트를 갭 프로빙 모드로 호출:
     ```
     Agent(
       prompt: "갭 프로빙 모드. 공백: {from_company} {from_project} 종료({from_end}) ~ {to_company} {to_project} 시작({to_start}). {gap_months}개월 공백. 갭 유형: {gap_type}. 유저 프로파일: {프로파일 요약}. 리서처 조사: {관련 회사 조사 결과}."
     )
     ```
   - HR 리턴을 AskUserQuestion으로 변환 (기존 변환 규칙 동일 적용)
   - 유저 응답 처리:
     - **"건너뛰기" 선택 시**:
       - meta.json의 `intentional_gaps` 배열에 추가:
         ```bash
         # meta.json 읽기 → intentional_gaps에 추가 → 다시 쓰기
         # { "from": "{from_end}", "to": "{to_start}", "marked_at": "{ISO timestamp}" }
         ```
       - 해당 갭에 대해 다시 질문하지 않음 — hook에서도 intentional_gaps를 확인하여 finding 재생성 방지
       - 인터뷰 즉시 복귀
     - **실질적 답변 시**:
       - 답변에서 에피소드 추출하여 resume-source.json에 저장 (기존 저장 규칙 동일)
       - HR 에이전트가 후속 질문 1-2개 더 할 수 있음 (일반 HR 모드로 전환)
       - 후속 질문 완료 후 인터뷰 복귀
   - **갭 프로빙 제한**: 한 세션에 최대 3개 갭까지만 프로빙. meta.json에 `gap_probes_this_session` 카운터로 추적. 초과 시 나머지 갭 finding은 무시.

7. **`[resume-panel:MEDIUM]` (pattern_detected)** → 패턴 기반 에피소드 발굴
   - MEDIUM 메시지 내용에 "패턴 발견"이 포함되어 있으면 패턴 finding으로 판단
   - 대화 브리핑의 별도 섹션으로 포함:
     ```
     ## 대화 브리핑
     - 유저가 지금까지 강조한 키워드/주제: [...]
     - 이미 다룬 영역: [...]
     - 아직 안 다룬 영역: [...]
     - 유저의 직전 답변 요약: [...]
     - **발견된 패턴**: {패턴 이름} — {근거 에피소드 요약}. {미탐색 회사 추정 또는 심화 방향}.
     ```
   - 패턴의 `target_agent` 필드에 지정된 에이전트를 다음 에이전트 선택 시 우선 고려
   - `suggested_question`이 있으면 해당 에이전트 호출 시 컨텍스트에 포함:
     ```
     Agent(
       prompt: "{기존 컨텍스트}. 패턴 분석에서 제안된 질문: '{suggested_question}'. 이 질문을 기반으로 에피소드를 발굴해줘."
     )
     ```
   - 패턴 finding은 즉시 전달하지 않고 다음 에이전트 호출 시 자연스럽게 결합 (MEDIUM urgency 규칙 따름)

8. **`[resume-panel:MEDIUM]` (perspective_shift)** → 관점 전환 질문
   - MEDIUM 메시지 내용에 "관점 전환"이 포함되어 있으면 perspective_shift finding으로 판단
   - meta.json의 `perspective_shifts_this_session` 카운터 확인 — 2 이상이면 무시
   - meta.json의 `perspective_shifted_episodes` 배열 확인 — 해당 episode_ref가 이미 있으면 무시
   - context에서 target_agent 확인 — 해당 에이전트를 관점 전환 모드로 호출:
     ```
     Agent(
       prompt: "관점 전환 모드. 대상 에피소드: {episode_ref}({company} {project}). 관점: {target_perspective}. 장면 힌트: {scene_hint}. 유저 프로파일: {프로파일 요약}. 리서처 조사: {관련 회사 조사 결과}."
     )
     ```
   - 에이전트 리턴을 AskUserQuestion으로 변환 (기존 변환 규칙 동일 적용)
   - 유저 응답 처리:
     - **겸손 옵션 선택** ("특별히 없었을 듯", "딱히 그런 인상은 없었을 듯" 등): meta.json에 `perspective_shifted_episodes` 배열에 episode_ref 추가, 인터뷰 복귀
     - **업그레이드 역할 선택**: 해당 에피소드의 result 보강을 위한 후속 질문 1개 가능 (일반 모드로 전환), meta.json에 `perspective_shifted_episodes` 배열에 episode_ref 추가
   - meta.json `perspective_shifts_this_session` 카운터 증가

9. **`[resume-panel:HIGH]` (contradiction_detected)** → 모순 복원 질문
   - HIGH 메시지 내용에 "모순 발견" 또는 "역할 모순"이 포함되어 있으면 contradiction_detected finding으로 판단 (이 키워드가 없는 일반 HIGH는 item 2로 처리)
   - meta.json의 `contradictions_presented_this_session` 카운터 확인 — 2 이상이면 무시
   - context에서 claim_a, claim_b, contradiction_type, likely_cause, restoration_question 추출
   - AskUserQuestion으로 복원 질문 제시:
     ```
     AskUserQuestion({
       questions: [{
         question: "아까 이야기랑 연결해보면, {에피소드A}에서는 {claim_a.text 요약}라고 했는데 {에피소드B}에서는 {claim_b.text 요약}라고 했거든. 실제로는 어디까지 한 거야?",
         header: "연결 확인",
         options: [
           { label: "{큰 역할 요약}", description: "{claim with bigger role/scale}" },
           { label: "{작은 역할 요약}", description: "{claim with smaller role/scale}" },
           { label: "상황이 달랐음", description: "두 에피소드의 맥락이 달라서 역할이 다른 것" }
         ],
         multiSelect: false
       }]
     })
     ```
   - 유저 응답 처리:
     - **큰 역할 선택**: 작은 claim이 있는 에피소드의 해당 STAR 필드(claim_b.star_field)를 큰 역할 내용으로 업데이트. resume-source.json 전체를 Bash tool로 재저장 (기존 저장 패턴 동일). 해당 필드만 수정하고 나머지 에피소드 내용은 보존
     - **작은 역할 선택**: 큰 claim이 있는 에피소드의 해당 STAR 필드(claim_a.star_field)를 작은 역할 내용으로 업데이트. 동일하게 해당 필드만 수정
     - **"상황이 달랐음" 선택**: 양쪽 모두 유효, STAR 업데이트 없음. 인터뷰 즉시 복귀
   - STAR 필드 업데이트 시: 해당 star_field만 수정하고 나머지 에피소드 내용은 보존. 기존 내용을 정정/보완하며 전체 교체하지 않음. 업데이트 후 resume-source.json 전체를 Bash tool로 재저장:
     ```bash
     cat <<'EOF' > ./resume-source.json
     { ... 전체 JSON (수정된 필드만 변경, 나머지 보존) ... }
     EOF
     ```
   - meta.json `contradictions_presented_this_session` 카운터 증가
   - MEDIUM urgency contradiction (메시지에 "모순 발견" 포함 + urgency가 MEDIUM):
     - 대화 브리핑의 별도 섹션으로 포함:
       ```
       ## 대화 브리핑
       - ...기존 항목...
       - **확인 필요**: {contradiction_type} 관련 — {에피소드A}에서 {claim_a 요약}, {에피소드B}에서 {claim_b 요약}. 다음 관련 질문 시 자연스럽게 확인.
       ```
     - 즉시 AskUserQuestion으로 제시하지 않고, 다음 에이전트 호출 시 브리핑에 포함하여 자연스럽게 확인

**메시지 분류 우선순위 참고:**
- HIGH 메시지에 "모순 발견" 또는 "역할 모순" 키워드 → item 9 (contradiction_detected)
- HIGH 메시지에 위 키워드 없음 → item 2 (일반 HIGH findings)
- MEDIUM 메시지 키워드 분류: "공백" + "개월" → item 6 (gap), "패턴 발견" → item 7 (pattern), "관점 전환" → item 8 (perspective), "모순 발견" → item 9 MEDIUM (briefing)

### 인터뷰 흐름 보호

- HIGH 피드백이 와도 **현재 진행 중인 질문-답변 사이클은 완료**한 후 끼워넣기
- MEDIUM/LOW 피드백 때문에 인터뷰를 중단하지 않음
- 피드백 전달 후 바로 다음 인터뷰 질문으로 복귀
- SO-WHAT 체인은 multi-turn이므로, 체인 완료까지 일반 인터뷰 플로우를 일시 중단한다. 체인 완료(거기까지였음 또는 Level 3 완료) 후 인터뷰를 재개한다
- SO-WHAT과 프로파일러 메시지가 동시 도착하면 SO-WHAT을 먼저 처리한다 (체인 완료 후 프로파일러 백그라운드 실행)
- so_what_active가 active인 동안 추가 SO-WHAT 메시지는 무시한다 (hook에서 이미 필터링하지만, 오케스트레이터에서도 이중 확인)
- 갭 프로빙은 single-turn이므로 인터뷰 흐름을 크게 방해하지 않는다. 유저가 건너뛰기를 선택하면 즉시 복귀한다
- 갭 프로빙과 SO-WHAT이 동시 도착하면 SO-WHAT을 먼저 처리한다 (체인 완료 후 갭 프로빙)
- 갭 프로빙 제한(3개/세션)에 도달하면 나머지 갭 finding은 조용히 무시한다
- 관점 전환은 single-turn이므로 인터뷰 흐름을 크게 방해하지 않는다. 유저가 겸손 옵션을 선택하면 즉시 복귀한다
- 관점 전환과 SO-WHAT이 동시 도착하면 SO-WHAT을 먼저 처리한다 (체인 완료 후 관점 전환)
- 관점 전환 제한(2개/세션)에 도달하면 나머지 관점 전환 finding은 조용히 무시한다
- 모순 복원은 single-turn이므로 인터뷰 흐름을 크게 방해하지 않는다. 유저가 "상황이 달랐음"을 선택하면 즉시 복귀한다
- 모순 복원과 SO-WHAT이 동시 도착하면 SO-WHAT을 먼저 처리한다 (체인 완료 후 모순 복원)
- 모순 복원 제한(2개/세션)에 도달하면 나머지 모순 finding은 조용히 무시한다

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
              "result": "",
              "context_notes": ""
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
| 라운드 3 완료 | 최종 저장 + resume-draft.md (+ resume-draft-jobkorea.md) 생성. 간략소개는 반드시 마지막 단계에 작성 |

### 저장 방법

**원칙: 부분 업데이트 우선 (5.1)**

resume-source.json이 커질수록 (에피소드 10개 이상) 전체 재저장은 토큰 낭비가 심하다. 다음 우선순위로 저장한다:

**1순위 — 부분 업데이트 (jq)**: 에피소드 1개 추가/수정, STAR 필드 수정, context_notes 수정 같은 작은 변경은 `jq`로 in-place 수정:

```bash
# 에피소드 추가
jq --argjson ep '{"type":"성과","title":"...","situation":"...","task":"...","action":"...","result":"...","context_notes":""}' \
  '(.companies[] | select(.name=="{회사명}") | .projects[] | select(.name=="{프로젝트명}") | .episodes) += [$ep]' \
  ./resume-source.json > ./resume-source.json.tmp && mv ./resume-source.json.tmp ./resume-source.json

# 특정 에피소드의 result 필드만 수정
jq '(.companies[] | select(.name=="{회사명}") | .projects[] | select(.name=="{프로젝트명}") | .episodes[] | select(.title=="{에피소드 제목}") | .result) = "{새 내용}"' \
  ./resume-source.json > ./resume-source.json.tmp && mv ./resume-source.json.tmp ./resume-source.json

# context_notes 추가/수정 (5.3)
jq '(.companies[] | select(.name=="{회사명}") | .projects[] | select(.name=="{프로젝트명}") | .episodes[] | select(.title=="{에피소드 제목}") | .context_notes) = "{메타 정보}"' \
  ./resume-source.json > ./resume-source.json.tmp && mv ./resume-source.json.tmp ./resume-source.json

# gap_analysis 섹션 교체
jq --argjson ga '{"met":[...],"gaps":[...]}' '.gap_analysis = $ga' \
  ./resume-source.json > ./resume-source.json.tmp && mv ./resume-source.json.tmp ./resume-source.json
```

**jq 사용 시 주의:**
- 항상 `.tmp` → `mv` 패턴 사용 (in-place redirect는 빈 파일 만들 수 있음)
- 업데이트 후 파일 크기를 간단히 검증 (`wc -c`)하여 비정상 축소 감지
- 에러 시 즉시 heredoc 전체 재저장으로 폴백

**2순위 — heredoc 전체 재저장**: 스키마 변경, 여러 필드 동시 수정, 초기 생성 시에만 사용:

```bash
cat <<'EOF' > ./resume-source.json
{ ... 전체 JSON ... }
EOF
```

**금지:**
- 에피소드 10개 초과 상태에서 에피소드 1개 추가에 heredoc 전체 재저장 사용 금지 — 토큰 낭비
- Write tool 사용 금지 (Bash가 항상 우선)

### context_notes 활용 (5.3)

`context_notes` 필드는 에피소드의 STAR 외적 메타 정보를 저장한다. 다음 턴이나 다음 세션에서 컨텍스트 복원에 사용.

**저장 대상:**
- 유저가 처음 답변했을 때의 자기평가 (예: "처음엔 '고객 관점 부족'이라고 했으나, 재프로빙 후 정기 모니터링 수행 확인")
- 관점 전환/모순 복원의 배경 (예: "인사담당자 재질문 후 주니어 온보딩 담당 확인")
- 유저가 이 에피소드에 대해 특별히 강조한 주제나 뉘앙스
- 재프로빙이 있었던 경우 원답변과 보정된 답변의 차이

**금지:**
- STAR 필드를 context_notes에 중복 저장 금지 — 메타 정보만
- 빈 context_notes로 쓰지 않음 (값이 없으면 jq 업데이트 생략)

### resume-draft.md 변경 diff 자동 표시 (5.2)

resume-draft.md 또는 resume-draft-jobkorea.md를 업데이트할 때, **기존 파일이 있으면 덮어쓰기 전에** 변경 내역 요약을 자동 표시한다.

**절차:**

1. 기존 파일 존재 확인 (`test -f ./resume-draft.md`)
2. 존재하면 임시 파일에 새 버전 쓰기 (`./resume-draft.md.new`)
3. `diff` 또는 `git diff --no-index` 로 변경 추출:
   ```bash
   diff -u ./resume-draft.md ./resume-draft.md.new | head -100
   ```
4. 변경 요약을 유저에게 평문으로 표시 (섹션별 변경 라인 수):
   ```
   📝 resume-draft.md 업데이트:
   - 간략소개: +2 / -1 줄
   - 경력/튜닙: +3 bullet 추가
   - 갭 분석: 변경 없음
   ```
5. `mv ./resume-draft.md.new ./resume-draft.md`로 교체
6. 기존 파일이 없으면 diff 없이 신규 생성 알림만

**git 저장소가 있으면 추가로:**
- 변경 후 `git add ./resume-draft.md && git status --short` 정도만 실행하여 working tree 상태 알림 (자동 커밋은 안 함 — 유저 명시적 요청 시에만)
