# story-spec 세션 흐름

이 문서는 SKILL.md의 룰을 *어떻게 한 세션 동안 풀어 진행하는지* 설명한다. SKILL.md가 "무엇을 하지 말고 무엇을 해라"의 룰이라면 여기는 "한 세션이 시작부터 끝까지 어떻게 흐르는가"의 시간축이다.

룰이 충돌해 보이면 SKILL.md가 권위다.

## 1. 세션 시작 흐름

매 세션의 첫 행동은 사용자 프로젝트의 `docs/spec/manifest.yml` 읽기다. 분기는 두 갈래다.

### 1.1. manifest가 있으면 — 트리 요약 출력

manifest의 `chapters` 배열을 훑어 챕터별 `depth`·`status`를 표로 요약한 뒤, 사용자에게 다음에 갈 곳을 묻는다. 출력 예시:

```
docs/spec/manifest.yml 읽었습니다.

framework: pixar-pitch+story-circle
category: tool-productivity
arc: L1 채움 / L2 채움

챕터 트리:
  01-discovery       L4   approved      (시나리오 1개 L5)
  02-onboarding      L3   draft         (의존: 01-discovery)
  03-daily-loop      L2   empty         (의존: 02-onboarding)

다음에 어디로 갈까요?
  1) 02-onboarding의 시나리오 카드 (L4) 잡기 ⭐ 추천
  2) 03-daily-loop의 챕터 카드 (L3) 채우기
  3) 01-discovery의 시나리오를 L6 spec까지 끌어올리기
  4) 직접 입력
```

추천(⭐)은 "선행 챕터 의존성이 만족된 가장 얕은 가지" 휴리스틱이다. 사용자가 선택하면 해당 LOD 진입 패턴(섹션 3)으로 들어간다.

### 1.2. manifest가 없으면 — init 분기

`docs/spec/` 디렉토리가 없거나 `manifest.yml`이 없으면 init 분기다. 다음 4단계를 한 번에 다 묻지 않고 차례로 진행한다(한 메시지 한 질문 룰).

1. **framework 선택.** Pixar Pitch + Story Circle ⭐ / Kishōtenketsu / Hero's Journey / Custom 중 하나.
2. **앱 한 줄 설명 요청.** "어떤 앱인지 한 줄로 들려주세요."
3. **카테고리 제안.** 사용자 한 줄 설명을 듣고 8개 카테고리 중 가장 어울리는 것을 *제안*. *"이건 [도구·생산성] 카테고리 같아요. 맞나요? 다른 카테고리도 보여드릴까요?"* 사용자가 거절하면 8개 전체 목록을 보여주고 선택받는다.
4. **manifest.yml 생성 + L1 진입.** 위 선택을 manifest에 기록하고, 곧장 L1(Pixar Pitch) 인터뷰로 들어간다.

## 2. 9단계 인터뷰 흐름

매 LOD 노드 한 회를 진행하는 표준 흐름이다. spec의 "인터뷰 흐름" 섹션을 한 단계씩 풀어 적는다.

### 2.1. 세션 시작

사용자가 `/story-spec` 또는 자연어로 호출한다. 너는 manifest를 먼저 읽는다(섹션 1).

### 2.2. manifest 로드

없으면 init 분기, 있으면 트리 요약 출력 후 사용자에게 다음 가지를 묻는다.

manifest 갱신 동작: 이 단계에서는 갱신하지 않는다(읽기만).

### 2.3. 사용자가 운전석 — LOD 노드 선택

너는 비어 있는 가지·얕은 가지를 *제안*만 한다. 어느 챕터를 어느 깊이까지 갈지 선택하는 사람은 사용자다. T자형(한 챕터만 깊이), 그물형(여러 챕터 골고루), 균등형 모두 허용한다.

사용자에게 보여주는 형태:

```
어디로 갈까요?
  1) 02-onboarding의 챕터 카드(L3) → 시나리오 카드(L4) 채우기 ⭐
  2) 새 챕터 추가
  3) 01-discovery의 시나리오를 L6 spec까지
  4) 직접 입력
```

manifest 갱신 동작: 사용자가 새 챕터 추가를 골랐다면 manifest의 `chapters` 배열에 빈 항목(`status: draft`, `depth: L3`)을 push.

### 2.4. 방법론 선택

해당 LOD 노드의 manifest `methodology_l*` 필드를 본다.

- **이미 기록되어 있으면** 그것을 default로 다시 제시. *"전에 이 노드에서 Laddering으로 진행했네요. 이어서 갈까요, 아니면 다른 방법으로?"*
- **비어 있으면** 카테고리 가중치를 적용한 1-3순위 + "직접 입력" 4개 옵션 제시. 1순위에 ⭐.

출력 예시는 섹션 3의 LOD별 진입 패턴 참조.

manifest 갱신 동작: 사용자 선택 직후 해당 노드의 `methodology_l*` 필드를 즉시 갱신.

### 2.5. 현재 Level의 schema 적재

LOD에 대응하는 schema 파일을 읽어 인터뷰 backbone으로 삼는다.

- L1+L2 → `schemas/arc.md` (Pixar Pitch 7필드 + Story Circle 8필드)
- L3 → `schemas/chapter.md` (제목·목적·story_circle_stage·의존 챕터·한 줄 활)
- L4 → `schemas/scenario.md` (목표·동기·입력·행동·장애물·성공조건)
- L5 → `schemas/scene.md` (화면·상태·사용자 행동·시스템 반응)
- L6 → `schemas/spec.md` (state model·event flow·data model·acceptance criteria)

schema의 필드를 *순서대로* 한 필드씩 채운다. 자유 형식으로 흘리지 않는다.

manifest 갱신 동작: 없음(읽기만).

### 2.6. 인터뷰

Layer 1 메타 자세 5개(Clean Language·OARS·Yes-And·Bloom 게이지·System 1/2)를 항상 적용한 채, 선택된 Layer 2 방법론의 질문 패턴을 한 번에 하나씩 던진다.

한 메시지 한 질문 룰. 사용자에게 두 가지를 동시에 묻지 않는다.

manifest 갱신 동작: 인터뷰 진행 중에는 갱신하지 않는다. 산출물 승인 시점에 한 번에 갱신.

### 2.7. 사용자 승인

schema 필드가 모두 채워지면 산출물을 사용자에게 요약해 보여주고 승인을 받는다.

```
[L4 시나리오 카드 — 01-first-encounter] 이렇게 정리됐어요.

  목표:    앱을 처음 연 사용자가 5분 안에 첫 할 일을 추가한다
  동기:    출근길 버스에서 떠오른 일을 어디다 적을지 몰라 메모 앱을 전전했다
  입력:    스마트폰 · 1분~5분 자투리 시간 · 잊고 싶지 않은 일 1건
  행동:    아이콘 탭 → 입력창 자동 포커스 → 한 줄 작성 → 저장
  장애물:  로그인 강제 / 카테고리 강제 / 광고 가림
  성공조건: 5분 이내 1건 저장, 다음 날 같은 자리에 그 항목이 있다

승인하시면 docs/spec/chapters/01-discovery/scenarios/01-first-encounter/card.md로 저장하고 다음 가지를 제안합니다.
```

승인 후 파일 작성 + manifest 갱신을 한 번에 한다.

manifest 갱신 동작: 해당 노드의 `status`(`approved`), `depth`(현재 LOD), `methodology_l*`(이번에 사용한 방법론) 필드 갱신. 새 시나리오·장면이라면 배열에 항목 push. `updated_at`도 오늘 날짜로 갱신.

### 2.8. 다음 가지 제안

승인 직후 다음 가지를 제안한다. 휴리스틱:

- 승인된 노드의 의존자가 비어 있으면 그쪽 우선 제안
- 같은 챕터의 다른 시나리오가 비어 있으면 그쪽
- 의존성 가드(섹션 4)가 발동할 상황이면 가이드 톤으로 안내

```
01-first-encounter 시나리오 카드 저장했습니다. 다음은 어떻게?
  1) 같은 시나리오를 L5 장면으로 분해하기 ⭐
  2) 같은 챕터의 다른 시나리오 잡기
  3) 의존자 챕터 02-onboarding로 옮겨가기
  4) 오늘은 여기까지
```

manifest 갱신 동작: 없음(다음 노드 진입 시 그쪽 단계에서 갱신).

### 2.9. L6 도달 + 명시 승인 → 인계

L6 spec이 채워지고 사용자가 *"이 시나리오 spec으로 구현해줘"*라고 명시 승인하면, superpowers의 `writing-plans` skill로 인계한다. 자세한 인계 패턴은 섹션 6.

manifest 갱신 동작: `implementation_log` 배열에 인계 기록 push.

## 3. 각 LOD 진입 시 패턴

### 3.1. L1 진입 — Pixar Pitch + Story Circle 한 쌍

framework가 `pixar-pitch+story-circle`이면 L1과 L2를 *연속*으로 진행한다(분리해도 되지만 기본은 연속). framework 적재 후 7+8 필드 인터뷰.

방법론 선택 화면 예시(카테고리 `tool-productivity` 가정):

```
[L1 시작과 끝 — Pixar Pitch] 어떤 사고법으로 갈까요?

  1) JTBD Switch Interview ⭐ (추천 — 도구·생산성 앱의 "해고 결심" 순간을 가장 또렷이 끌어냅니다)
  2) Mom Test (가정·일반론을 거르고 과거 행동만 모읍니다)
  3) Miracle Question (기적이 일어났다고 가정하고 첫 신호를 떠올립니다)
  4) 직접 입력 / 다른 방법 설명 요청
```

선택 후 `frameworks/pixar-pitch.md`의 7문장을 backbone으로, 선택한 Layer 2 방법론의 질문 패턴으로 한 문장씩 채운다.

L1 7문장 완료 후 곧장 L2(Story Circle 8단계)로 channeling. L2 진입 시 방법론 선택 화면을 다시 띄운다(L2의 1순위는 MICE Quotient).

### 3.2. L2 진입 — Story Circle 8단계

L1에서 채운 Pixar Pitch를 backbone으로, Story Circle의 8단계(You/Need/Go/Search/Find/Take/Return/Change)에 맞춰 사용자 변화 활을 펼친다. 이 8단계가 곧 L3 챕터의 시드 후보다.

방법론 선택 화면 예시(카테고리 `tool-productivity`):

```
[L2 큰 서사 — Story Circle 8단계] 어떤 사고법으로 갈까요?

  1) MICE Quotient ⭐ (추천 — 사용자 여정을 Milieu·Inquiry·Character·Event 4축으로 분류합니다)
  2) Tetralemma 사구분별 (정체성이 모호할 때 4가지 입장 강제 펼침)
  3) Socratic 산파술 (가정 검토 + 함의 탐색)
  4) 직접 입력
```

L2 종료 후, 8단계가 *그대로 8개 챕터 후보*임을 사용자에게 보여주고 가지치기·병합·분할을 묻는다.

### 3.3. L3 진입 — 챕터 카드

Story Circle 8단계가 챕터 시드. 사용자가 챕터 1개를 골라 진입.

`schemas/chapter.md`의 필드(제목·목적 1문장·story_circle_stage 매핑·의존 챕터 ID·챕터 한 줄 활)를 backbone으로 인터뷰.

방법론 선택 화면 예시(카테고리 `tool-productivity`):

```
[L3 챕터 카드 — 02-onboarding] 어떤 사고법으로 갈까요?

  1) Toyota Kata ⭐ (추천 — 목표상태·현재상태·다음 장애물·다음 실험 4질문)
  2) Counterfactual ("이 챕터 없이 사용자가 같은 일을 하려면?")
  3) Mental Model — Indi Young (평가 없이 그 시점의 마음 듣기)
  4) 직접 입력
```

### 3.4. L4 진입 — 시나리오 카드

`schemas/scenario.md`의 6필드(목표·동기·입력·행동·장애물·성공조건)를 backbone으로 인터뷰. 시나리오 카드는 챕터 안에 N개 있을 수 있다.

방법론 선택 화면 예시(카테고리 `game-habit`):

```
[L4 시나리오 카드 — 01-streak-recovery] 어떤 사고법으로 갈까요?

  1) Laddering ⭐ (추천 — 게임·습관 앱에서 표면 동기를 정체성 가치까지 끌어올립니다)
  2) Language Game (모호한 형용사를 용례로 정밀화)
  3) Six Hats (시나리오를 6가지 관점으로 점검)
  4) 직접 입력
```

같은 카테고리가 `tool-productivity`였다면 1순위가 Mom Test, 2순위가 Laddering으로 바뀐다(`category-weights.md` 참조).

### 3.5. L5 진입 — 장면

`schemas/scene.md`의 4필드(화면·상태·사용자 행동·시스템 반응)를 backbone. 한 시나리오는 보통 N개의 장면으로 펼쳐진다.

방법론 선택 화면 예시(카테고리 `tool-productivity`):

```
[L5 장면 — 02-empty-state] 어떤 사고법으로 갈까요?

  1) Master/Apprentice ⭐ (추천 — "제가 견습생이라 치고 처음부터 끝까지 보여주세요")
  2) Scene-Sequel (장면 = 목표·갈등·결말 / sequel = 반응·딜레마·결정)
  3) Projective ("이 화면이 사람이라면?")
  4) 직접 입력
```

### 3.6. L6 진입 — codespeak spec

`schemas/spec.md`의 4섹션(state model·event flow·data model·acceptance criteria)을 backbone. 자연어로 작성하지만 AI가 그대로 코드로 옮길 수 있는 정밀도.

방법론 선택 화면 예시(카테고리 `b2b-enterprise`):

```
[L6 codespeak spec — 01-first-encounter/spec] 어떤 사고법으로 갈까요?

  1) Premortem ⭐ (추천 — B2B·규제 앱에서 "1년 뒤 망했다 가정, 왜 망했나"로 acceptance criteria를 구체화)
  2) Pragmatism (이게 참이라면 어떤 관찰 가능한 차이가?)
  3) Socratic (명료화·가정 검토·근거·반대·함의·메타)
  4) 직접 입력
```

카테고리가 `tool-productivity`라면 1순위는 Pragmatism, 2순위가 Premortem이다.

## 4. 의존성 가드 동작

챕터끼리의 의존성은 manifest의 `depends_on` 배열로 표현된다. 의존하는 챕터의 선행이 비어 있을 때 너는 *강제 차단하지 않는다*. 가이드 톤으로 *제안*만 한다.

상황: 사용자가 `02-onboarding`(의존: `01-discovery`)을 L6까지 끌어올리고 싶다고 말했는데, `01-discovery`의 시나리오 카드(L4)가 비어 있다.

가이드 톤 출력 예시:

```
02-onboarding의 spec(L6)으로 가시려는 거 잘 알겠습니다. 한 가지만 확인할게요.

이 챕터는 manifest에서 01-discovery에 의존한다고 되어 있어요. 그런데
01-discovery의 시나리오 카드(L4)가 아직 비어 있습니다. 그대로 02-onboarding의
spec을 잡으면 "사용자가 이 화면에 어떻게 도착했는지"가 모호한 채로 acceptance
criteria를 쓰게 될 가능성이 큽니다.

  1) 먼저 01-discovery의 시나리오 카드부터 잡고 오기 ⭐ 권장
  2) 이대로 02-onboarding의 spec 진행 (선행이 비어 있다는 메모를 spec 머리에 남깁니다)
  3) 다른 가지로

어떻게 할까요?
```

핵심: "선행이 비었으니 안 됩니다"가 아니라 "이렇게 진행하면 이런 위험이 있어요, 그래도 진행할까요"의 톤. 사용자가 2번을 골라도 그대로 진행한다.

## 5. 카테고리 override 패턴

manifest의 전역 `category` 필드는 그대로 두고, 특정 LOD 노드 안에서만 임시로 다른 카테고리 가중치를 적용하는 패턴이다.

### 5.1. 발동 시점

사용자가 LOD 진입 직후의 방법론 선택 화면에서 다음과 같이 말한다:

- *"이 챕터만 sensitive-regulated 가중치로 봐줘"*
- *"이 시나리오는 b2b-enterprise 관점으로 다시 추천해줘"*

### 5.2. 동작

1. 사용자 요청한 임시 카테고리로 가중치를 다시 계산해 1-3순위를 다시 제시한다.
2. manifest의 전역 `category`는 *변경하지 않는다*.
3. 해당 노드의 manifest 항목에 `category_override: <id>` 필드를 임시로 기록한다(다음 재방문 시 같은 override가 default가 됨).
4. 다른 노드에는 영향 없음. 같은 세션에서 다른 챕터로 가면 전역 `category`로 돌아간다.

출력 예시:

```
이 챕터만 sensitive-regulated 가중치로 봐 드립니다. 전역 카테고리(tool-productivity)는
그대로 둡니다.

[L4 시나리오 카드 — 03-account-deletion] 어떤 사고법으로 갈까요?

  1) Premortem ⭐ (추천 — 민감·규제 앱에서 실패 시나리오를 먼저 펼침)
  2) Mom Test (가정·일반론을 거르고 과거 행동만 모음)
  3) Counterfactual ("이 기능 없이 사용자가 같은 일을 하려면?")
  4) 직접 입력
```

manifest 갱신 동작:

```yaml
chapters:
  - id: 03-privacy
    scenarios:
      - id: 03-account-deletion
        depth: L4
        category_override: sensitive-regulated   # 이 노드만 임시 적용
        methodology_l4: premortem
```

## 6. L6 도달 후 writing-plans 인계 패턴

L6 spec이 채워지고 사용자가 명시적으로 *"이 시나리오 spec으로 구현해줘"* 또는 동등한 표현으로 승인하면, 인계 절차에 들어간다.

### 6.1. 인계 직전 확인

```
[L6 spec — 01-first-encounter/spec] 구현 단계로 인계하기 전에 한 번만 확인할게요.

  - state model 4개 상태 정의됨
  - event flow 7개 이벤트 순서 정의됨
  - data model entity 3개와 관계 정의됨
  - acceptance criteria 관찰 가능한 항목 6개

이대로 superpowers의 writing-plans skill로 인계합니다. manifest의
implementation_log에도 기록을 남길게요. 진행할까요?
```

### 6.2. 인계 메시지

사용자 승인 직후 다음 형태로 인계한다.

```
superpowers:writing-plans skill로 인계합니다.

입력 spec: docs/spec/chapters/01-discovery/scenarios/01-first-encounter/spec.md
참조 자료:
  - docs/spec/manifest.yml
  - docs/spec/arc.md (L1-L2 전체 활)
  - docs/spec/chapters/01-discovery/index.md (L3 챕터 카드)
  - docs/spec/chapters/01-discovery/scenarios/01-first-encounter/card.md (L4)
  - docs/spec/chapters/01-discovery/scenarios/01-first-encounter/scenes/*.md (L5)

writing-plans는 위 spec을 단계별 구현 계획으로 변환합니다. 이후 코드 작성은
executing-plans 또는 subagent-driven-development skill이 담당합니다.

story-spec은 여기서 자기 일을 마치고, 사용자가 다시 인터뷰가 필요하면 호출하면
됩니다.
```

### 6.3. manifest 갱신

`implementation_log` 배열에 항목을 push한다.

```yaml
implementation_log:
  - chapter: 01-discovery
    scenario: 01-first-encounter
    spec_path: docs/spec/chapters/01-discovery/scenarios/01-first-encounter/spec.md
    handed_off_at: 2026-04-27
    handed_off_to: superpowers:writing-plans
    notes: state 4개·event 7개·entity 3개·acceptance 6개로 인계
```

해당 시나리오 노드의 `status`도 `approved`에서 `implemented`로 갱신한다.

## 정리

이 process.md는 SKILL.md의 룰을 시간축으로 푼 운영 매뉴얼이다. 룰이 바뀌면 SKILL.md를, 흐름이 바뀌면 이 파일을 고친다. 두 파일이 충돌해 보이면 SKILL.md가 권위다.
