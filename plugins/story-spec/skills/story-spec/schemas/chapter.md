# chapter schema (L3)

## 무엇인가

`chapter.md`는 **L3 챕터 카드**의 backbone이다. 챕터는 사용자 여정의 한 구간이다. L2 Story Circle의 8단계가 챕터 후보 8개의 시드가 되며, 사용자가 앱 성격에 맞게 가지치기·병합·분할한다. 사용자 프로젝트에서는 `docs/spec/chapters/<id>-<slug>/index.md`로 작성된다. 한 챕터는 그 안에 여러 L4 시나리오를 담는 그릇이다.

## 필드 정의

5개 필드. 모두 짧다 — 챕터 카드는 *그릇*이지 *내용물*이 아니다.

### 1. 제목
- **역할:** 챕터의 한 단어 또는 한 구절 이름. 디렉토리 slug와 짝.
- **작성 가이드:** 사용자 여정에서 그 구간을 부르는 자연스러운 이름. 사용자의 단어를 그대로(Clean Language).
- **좋은 예:** *"발견"*, *"첫 캡처"*, *"매일 회고"*
- **나쁜 예:** *"기능 1"*, *"챕터 A"* (여정 안 이름이 아님)

### 2. 목적 (1문장)
- **역할:** 이 챕터에서 사용자가 무엇을 *겪고/달성하는지* 한 문장.
- **작성 가이드:** 기능 나열이 아닌 사용자 변화 한 줄. *"사용자가 ___을 한다"* 또는 *"사용자가 ___이 된다"* 형태.
- **좋은 예:** *"사용자가 흩어진 할 일이라는 자기 결핍을 처음으로 의식한다."*
- **나쁜 예:** *"앱의 첫 화면을 보여준다."* (시스템 동작이지 사용자 변화 아님)

### 3. story_circle_stage (매핑)
- **역할:** L2 Story Circle 8단계 중 어느 단계에 해당하는지. 배열로 1개 이상.
- **작성 가이드:** `you` / `need` / `go` / `search` / `find` / `take` / `return` / `change` 중 골라 배열로. 한 챕터가 두 단계를 걸칠 수 있다(예: 발견 챕터는 `[you, need]`).
- **좋은 예:** `[you, need]` (발견 챕터)
- **나쁜 예:** `[chapter-1]` (Story Circle 단계가 아닌 ID)

### 4. depends_on (의존하는 챕터 ID 배열)
- **역할:** 이 챕터를 깊이 파기 전에 *시나리오 카드(L4) 수준은 잡혀 있어야* 의미가 통하는 선행 챕터의 ID들.
- **작성 가이드:** 시간 순서가 아니라 *서사적 의존성*. 빈 배열도 정상(독립 챕터). 의존이 비어 있으면 AI는 강제 차단이 아니라 사용자에게 제안한다.
- **좋은 예:** `["01-discovery"]` (첫 캡처 챕터는 발견 챕터에 의존)
- **나쁜 예:** `["all-previous"]` (구체적 ID가 아님)

### 5. arc 한 줄 묘사
- **역할:** 챕터 안에서 사용자가 시작점에서 종료점까지 어떻게 변하는지 한 줄.
- **작성 가이드:** *"___한 사용자가 ___한 사용자가 된다"* 형식 권장. 챕터 자체의 미니 활.
- **좋은 예:** *"머릿속에 13개를 들고 다니던 사용자가, 첫 한 줄을 화면에 옮긴 사용자가 된다."*
- **나쁜 예:** *"사용자가 todo를 추가한다."* (변화의 활이 없음)

## 출력 markdown 템플릿

`docs/spec/chapters/<id>-<slug>/index.md`에 다음 구조.

```markdown
# Chapter: <제목>

> id: <id>
> story_circle_stage: [<stage>, ...]
> depends_on: [<id>, ...]
> depth: L3 | L4 | L5 | L6
> status: draft | in_progress | approved | implemented

## 목적
<1문장>

## arc
<한 줄 묘사>

## 시나리오
- [ ] 01-<slug> — <한 줄 요약> (L4: <status>)
- [ ] 02-<slug> — ... (L3 빈 가지)
```

`시나리오` 섹션은 챕터 안의 L4 시나리오 카드 목록. 빈 가지는 빈 체크박스로 둔다.

## 가상 todo 앱 "DayLine" 예시 (좋은 예시 1쌍)

### 좋은 예시
```markdown
# Chapter: 첫 캡처

> id: 02-first-capture
> story_circle_stage: [go, search]
> depends_on: [01-discovery]
> depth: L4
> status: in_progress

## 목적
사용자가 머릿속의 첫 할 일을 한 줄로 화면에 옮긴다.

## arc
머릿속에 13개를 들고 다니던 사용자가, 첫 한 줄을 화면에 옮긴 사용자가 된다.

## 시나리오
- [x] 01-quick-add — 한 줄로 할 일 추가하기 (L5: approved)
- [ ] 02-import-from-katalk — 카톡에서 받은 요청 받아넘기기 (L4: draft)
```

### 나쁜 예시
```markdown
# Chapter: 기능 1

> id: ch-1
> story_circle_stage: [chapter-1]
> depends_on: ["all-previous"]

## 목적
앱의 첫 화면을 보여준다.

## arc
사용자가 todo를 추가한다.
```

문제점:
- 제목이 여정 안 이름이 아님 (*"기능 1"*)
- `story_circle_stage`가 단계 enum이 아님
- `depends_on`이 구체적 ID가 아님
- 목적이 시스템 동작 문장
- arc에 변화의 활이 없음

## AI 행동 룰 (이 schema를 인터뷰 backbone으로 쓸 때)

L3 챕터 카드를 채울 때 너는 위 5필드를 *제목 → 목적 → story_circle_stage → depends_on → arc* 순서로 묻는다. 한 필드당 한 메시지 한 질문 룰. 챕터 후보가 비어 있으면 manifest의 L2 Story Circle 8단계를 시드로 *"이 8개를 챕터로 그대로 둘까요, 합치거나 나눌까요?"*라고 사용자에게 묻고 사용자의 답대로 한다(자기 판단으로 합치거나 나누지 않는다). 의존성을 채울 때 사용자가 깊이 가려는 챕터의 `depends_on`이 비어 있지 않으면, 그 선행 챕터의 깊이(`depth`)를 manifest에서 확인하고 *"선행 챕터 [X]의 시나리오 카드부터 잡아두는 게 더 단단합니다. 먼저 [X]로 갈까요?"*라고 *제안*만 한다 — 강제 차단 아님. 5필드가 채워지면 사용자에게 요약 → 명시 승인 → `docs/spec/chapters/<id>-<slug>/index.md` 작성 → manifest의 해당 챕터 항목에 `depth: L3`, `status: draft` 또는 `in_progress`, `methodology_l3: <선택된 방법론>` 갱신.
