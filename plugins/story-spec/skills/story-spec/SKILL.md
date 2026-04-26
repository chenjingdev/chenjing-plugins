---
name: story-spec
description: "흐릿한 앱 아이디어를 사용자 경험의 서사로 풀어 내려가는 인터뷰형 기획 도구. 시작과 끝 → 큰 서사 → 챕터 → 시나리오 → 장면 → 구현 가능 spec 순서로 6단계 LOD를 자유 traversal하며, 매 단계에서 사용자 선택 방법론으로 인터뷰. 코드 작성 전에 호출."
---

# story-spec

이 skill은 사용자의 흐릿한 앱 아이디어를 codespeak.dev 수준의 plain-text spec까지 끌어내리는 인터뷰형 도구다. 일반 spec-driven 도구와 달리 곧장 spec/tasks를 찍어내지 않는다. 사용자의 머릿속에만 있는 80%의 암묵적 의도를 다단계 인터뷰로 끌어낸 뒤에야 구현 가능 산출물을 만든다.

핵심 정신: **제품을 만드는 것 또한 이야기다.**

## 가장 큰 룰 (positive instruction)

### 진행

- 매 인터뷰의 첫 행동은 `docs/spec/manifest.yml` 읽기다. 없으면 init 분기로 진입한다.
- 사용자가 명시적으로 "이 시나리오 spec으로 구현해줘"라고 말하기 전까지, 너의 일은 인터뷰와 산출물 작성뿐이다. 코드는 그 다음 단계의 일이다.
- 한 번의 인터뷰 메시지에는 하나의 질문만 담는다. 사용자에게 두 가지를 동시에 묻지 않는다.
- 매 단계의 산출물은 schema 파일(`schemas/<level>.md`)의 필드를 backbone으로 작성한다. 자유 형식으로 흘리지 않는다.
- 사용자가 채워달라고 하지 않은 가지는 만들지 않는다. 빈 가지 채우기는 사용자의 결정이다.

### Layer 1 메타 자세 (전 단계 상시 적용, 사용자에게 선택 노출 없음)

다음 5개는 항상 적용된다. 사용자에게 옵션으로 묻지 않는다.

- **Clean Language: 사용자의 메타포·단어를 그대로 사용한다. 인터뷰어가 다른 비유나 동의어로 바꿔치지 않는다.** 사용자가 "이 앱은 비서다"라고 하면, 너는 "비서"의 종류·위치·전후만 캐묻고, "도우미"·"파트너"·"어시스턴트" 같은 다른 단어를 끼워넣지 않는다. 자세한 룰은 `methodologies/layer1-meta/clean-language.md`.
- **OARS**: 사용자 발화를 살짝 다르게 되돌려 자기 정정을 유도한다. *"그러니까 ___라는 거네요. 맞나요?"*
- **Yes-And**: 사용자 발화를 부정하지 않고 덧붙인다. 반박이 아니라 인정 후 확장.
- **Bloom 게이지**: 사용자 답이 어느 인지 층위(기억·이해·적용·분석·평가·창조)에 있는지 진단해 다음 질문 층위를 한 단계 올리거나 내린다.
- **System 1/2 이중 캡처**: *"처음 떠오른 답이 뭐였어요? 그다음 30초 더 생각하면 뭐가 보태져요?"* 직관과 정교화를 둘 다 산출물에 기록한다.

### Layer 2 방법론 선택

- 매 LOD 노드 진입 시 manifest의 `methodology_*` 필드와 `category` 가중치를 보고 1-3순위 + "직접 입력" 옵션을 제시한다. 1순위에 ⭐ 표시.
- 추천 매핑은 `methodologies/INDEX.md`, 카테고리 가중치는 `methodologies/category-weights.md`.
- 사용자가 선택한 방법론은 그 LOD 노드 안에서 유지한다. 사용자가 막혀 "다른 방법으로" 요청할 때만 전환한다.
- 자기 판단으로 멋대로 방법론을 전환하지 않는다.

## 6단계 LOD

| Level | 이름 | 산출물 | schema |
|---|---|---|---|
| L1 | 시작과 끝 | Pixar Pitch 7문장 | `schemas/arc.md` |
| L2 | 큰 서사 | Story Circle 8단계 | `schemas/arc.md` |
| L3 | 챕터 | 챕터 카드 | `schemas/chapter.md` |
| L4 | 시나리오 | 시나리오 카드 (목표·동기·입력·행동·장애물·성공조건) | `schemas/scenario.md` |
| L5 | 장면 | 장면 분해 | `schemas/scene.md` |
| L6 | spec | codespeak-level plain-text spec | `schemas/spec.md` |

L1과 L2는 앱 전체에 대해 한 번 정의된다. L3 이하는 자유 traversal — 사용자가 어떤 챕터를 어느 깊이까지 팔지 매번 선택한다. T자형(한 챕터만 깊이), 그물형(여러 챕터 골고루), 균등형 모두 허용한다.

자세한 흐름은 `process.md`.

## init 분기 (manifest 없을 때)

manifest.yml이 존재하지 않으면 다음 순서로 진행한다.

1. **framework 선택.** 기본은 `pixar-pitch+story-circle`. 사용자에게 다음 옵션 제시:
   - 1) Pixar Pitch + Story Circle ⭐ (모든 앱에 잘 맞는 기본)
   - 2) Kishōtenketsu (기승전결, 갈등 없는 도구·생산성 앱에)
   - 3) Hero's Journey (큰 변화 서사 게임·습관 앱에)
   - 4) Custom (사용자가 `docs/spec/framework.md`에 직접 작성)
2. **카테고리 제안.** 사용자에게 한 줄 앱 설명을 요청 → 8개 카테고리 중 가장 어울리는 것을 *제안*한다. *"이건 [도구·생산성] 카테고리 같아요. 맞나요? 다른 카테고리도 보여드릴까요?"* 카테고리 ID는 `tool-productivity` / `game-habit` / `social-community` / `b2b-enterprise` / `content-media` / `marketplace-transaction` / `sensitive-regulated` / `mixed`.
3. **manifest.yml 생성.** `docs/spec/manifest.yml`에 framework, category, 빈 arc, 빈 chapters 배열 작성.
4. **L1 진입.** 선택된 framework의 backbone(예: Pixar Pitch면 `frameworks/pixar-pitch.md`)을 적재하고, 사용자가 선택한 Layer 2 방법론으로 인터뷰 시작.

## manifest.yml 운영 룰

- 매 인터뷰의 첫 행동은 manifest 읽기.
- 사용자가 LOD 노드의 산출물을 승인하면 manifest의 해당 노드 `status`·`depth`·`methodology_l*` 필드를 즉시 갱신한다.
- 같은 노드를 재방문하면 manifest의 `methodology_l*` 값을 default로 다시 제시한다(사용자는 변경 가능).
- 카테고리 override: 사용자가 특정 LOD에서 *"이 챕터만 [민감·규제] 가중치로 봐줘"*라고 하면 해당 노드에만 임시 카테고리를 적용하되 manifest의 전역 `category`는 변경하지 않는다.

## 의존성 가드

챕터끼리의 의존성은 manifest의 `depends_on`에 명시된다. 의존하는 챕터의 선행이 비어 있을 때 너는 *강제 차단하지 않는다*. 대신 사용자에게 *제안*한다:

> *"이 시나리오 spec까지 가려면 선행 챕터 [X]의 시나리오 카드(L4)부터 잡아두는 게 더 단단합니다. 먼저 [X]로 갈까요, 아니면 이대로 진행할까요?"*

사용자가 그대로 진행하면 그렇게 한다.

## 인계

L6 산출물에 대해 사용자가 명시적으로 *"이 시나리오 spec으로 구현해줘"*라고 말하면, superpowers의 `writing-plans` skill로 다음 단계를 인계한다. 본 skill 자체는 코드를 작성하지 않는다.

manifest의 `implementation_log` 배열에 인계 기록을 남긴다 (chapter, scenario, implemented_at, notes).

## 작업 산출물 디렉토리

사용자 프로젝트 안에 다음 구조로 자동 생성된다.

```
docs/spec/
├── manifest.yml
├── arc.md                 # L1-L2 (앱 전체 한 번)
├── framework.md           # custom일 때만 본문, 그 외엔 메모
└── chapters/
    └── <id>-<slug>/
        ├── index.md       # L3 챕터 카드
        └── scenarios/
            └── <id>-<slug>/
                ├── card.md         # L4 시나리오 카드
                ├── scenes/
                │   └── <id>-<slug>.md   # L5 장면
                └── spec.md         # L6 codespeak-level (있을 때)
```

빈 가지는 빈 디렉토리 또는 `(TBD)` 표시. 디렉토리 트리 자체가 진행 상태의 1차 시각화다.
