# story-spec 설계

## 배경

흐릿한 앱 아이디어를 받아 곧장 spec/tasks를 찍어내는 spec-driven 도구(Spec Kit, BMAD, Agent OS, gsd, ChatPRD 등)는 충분하다. 부족한 것은 **아이디어를 사용자 경험의 서사로 풀어내는 인터뷰형 사고 도구**다. Carroll의 Scenario-Based Design을 AI 인터뷰로 자동화하고, 마지막에 codespeak.dev 수준의 plain-text spec까지 잇는 화이트스페이스가 비어 있다(2026-04-27 리서치).

story-spec은 그 빈자리를 채운다.

## 철학

**제품을 만드는 것 또한 이야기다.**

- 사용자는 어떤 일상에 있었고 → 어떤 결핍을 안고 → 앱과 만나고 → 여정을 거쳐 → 어떤 변화로 떠나는가.
- AI는 이 활(arc)을 소크라테스식 인터뷰로 사용자에게서 끌어낸다. 사용자가 머릿속에만 가진 80%의 암묵적 의도를 종이 위로 옮기는 것이 1순위 목표.
- AI는 사용자가 명시적으로 허락하기 전에 코드를 짜지 않는다. 단, 이 가드는 "금지" 형태가 아니라 "해야 할 일을 정의"하는 positive instruction으로 표현한다.

## 도구의 형태

Claude Code skill 1개. `chenjing-plugins` 마켓플레이스에 새 플러그인으로 추가.

```
plugins/story-spec/
  .claude-plugin/
    plugin.json
  skills/story-spec/
    SKILL.md
    process.md
    schemas/
      arc.md
      chapter.md
      scenario.md
      scene.md
      spec.md
    frameworks/
      pixar-pitch.md
      story-circle.md
      kishotenketsu.md
      hero-journey.md
    methodologies/
      INDEX.md                    # 14개 방법론 한눈 카드 + LOD 매핑
      category-weights.md         # 앱 카테고리별 추천 가중치 표
      layer1-meta/
        clean-language.md
        oars.md
        yes-and.md
        bloom-gauge.md
        system-1-2.md
      layer2-tools/
        socratic.md
        jtbd-switch.md
        miracle-question.md
        mom-test.md
        laddering.md
        language-game.md
        mice-quotient.md
        master-apprentice.md
        scene-sequel.md
        pragmatism.md
        premortem.md
        counterfactual.md
        toyota-kata.md
        six-hats.md
        tetralemma.md
        mental-model.md
        projective.md
```

마켓플레이스 매니페스트(`/Users/chenjing/dev/chenjing-plugins/.claude-plugin/marketplace.json`)에 `story-spec` 항목을 추가한다.

## 6단계 분해 모델 (LOD)

| Level | 이름 | 산출물 | 주된 질문 |
|---|---|---|---|
| **L1** | 시작과 끝 | Pixar Pitch 7문장 | 어떤 계기로 만나, 어떤 변화로 떠나는가 |
| **L2** | 큰 서사 | Story Circle 8단계 | 사용자의 변화 활(arc) |
| **L3** | 챕터 | 챕터 카드 (제목·목적·의존성) | 어떤 사용자 여정 구간이 존재하는가 |
| **L4** | 시나리오 | 시나리오 카드 (목표·동기·입력·행동·장애물·성공조건) | 챕터 안에서 사용자는 무엇을 하는가 |
| **L5** | 장면 | 장면 분해 (화면·상태·사용자 행동·시스템 반응) | 한 시나리오는 어떻게 펼쳐지는가 |
| **L6** | spec | codespeak-level plain-text spec (state model · event flow · data model · acceptance criteria) | AI가 그대로 구현할 수 있는가 |

**진행 모델:**
- L1과 L2는 앱 전체에 대해 한 번 정의된다(breadth-first).
- L3 챕터부터 아래는 자유 traversal — 사용자가 어떤 챕터를 어느 깊이까지 팔지 매번 선택. T자형, 그물형, 균등형 모두 허용.
- 챕터끼리의 의존성은 manifest에 명시되며, 의존하는 챕터의 L4(시나리오 카드)가 비어 있으면 의존자의 L6(spec)에 진입할 때 AI가 사용자에게 "선행 챕터 X의 시나리오 카드부터 잡읍시다"라고 가이드한다(강제 아닌 제안).

## Narrative framework

기본은 **Pixar Pitch (L1) + Story Circle (L2)** 한 쌍.

**Pixar Pitch 7문장**
1. Once upon a time...
2. Every day...
3. One day...
4. Because of that...
5. Because of that...
6. Until finally...
7. (And ever since then... — 변화의 잔상)

L1 인터뷰의 backbone. AI가 7문장을 사용자에게서 끌어낼 때까지 다음 단계로 넘어가지 않는다.

**Story Circle 8단계**
1. You — 일상 (앱 만나기 전 사용자)
2. Need — 결핍·문제 인식
3. Go — 익숙한 영역 떠남 (앱 진입)
4. Search — 새 환경 탐색
5. Find — 원하는 것 발견·달성
6. Take — 대가·비용 (학습 곡선·투자)
7. Return — 일상 귀환 (재방문)
8. Change — 변화한 자신

L2 인터뷰의 backbone이자, **L3 챕터의 시드**. 8단계가 그대로 챕터 후보 8개가 되고, 사용자는 앱 성격에 따라 가지치기·병합·분할한다.

**대안 framework** (`/story-spec init --framework <name>` 옵션):
- `kishotenketsu` — 갈등 없는 도구·생산성 앱
- `hero-journey` — 큰 변화 서사 게임·습관 앱
- `custom` — 사용자가 직접 framework 정의 (`docs/spec/framework.md`에 자유 작성)

framework 선택은 L1 진입 시 한 번. 이후 변경은 가능하지만 L2 이하 산출물 영향을 사용자에게 경고한다.

## 질문 방법론 시스템 (2층 구조)

소크라테스식만으로는 인터뷰 품질이 부족하다. 14개 방법론을 두 층으로 나눠 운영한다.

### Layer 1 — 메타 자세 (전 단계 상시, 사용자에게 선택 노출 없음)

| 방법론 | 역할 |
|---|---|
| **OARS** (Motivational Interviewing) | Open · Affirm · Reflect · Summarize. 사용자 발화를 살짝 다르게 되돌려 자기 정정 유도. |
| **Yes-And** (Improv) | 사용자 발화를 부정하지 않고 덧붙임. AI 인터뷰어의 기본 자세. |
| **Clean Language** (David Grove) | **인터뷰어의 메타포로 사용자 메타포를 오염시키지 않는다.** 사용자가 "이 앱은 *비서*"라고 하면 비서의 종류·위치·전후만 캐묻고, 인터뷰어가 다른 비유를 끼워넣지 않는다. 도구의 신뢰성을 결정하는 강제 룰. |
| **Bloom 게이지** | 사용자 답이 어느 인지 층위(기억·이해·적용·분석·평가·창조)에 있는지 진단해 다음 질문 층위 선택. |
| **System 1/2 이중 캡처** (Kahneman) | "처음 떠오른 답이 뭐였어요? 그다음 30초 더 생각하면 뭐가 보태져요?" 직관과 정교화를 둘 다 기록. |

이 5개는 SKILL.md instruction에 강제 룰로 박는다. 사용자에게 선택 옵션으로 노출하지 않는다.

### Layer 2 — LOD별 전문 도구 (사용자 선택 + 추천 표시)

| LOD | 1순위 ⭐ | 2순위 | 3순위 |
|---|---|---|---|
| **L1 시작과 끝** | Miracle Question | JTBD Switch Interview | Mom Test |
| **L2 큰 서사** | MICE Quotient | Tetralemma (사구분별) | Socratic |
| **L3 챕터** | Toyota Kata | Counterfactual | Mental Model (Indi Young) |
| **L4 시나리오 카드** | Laddering | Language Game (Wittgenstein) | Six Thinking Hats |
| **L5 장면** | Master/Apprentice (Contextual Inquiry) | Scene-Sequel (Dwight Swain) | Projective |
| **L6 codespeak spec** | Pragmatism (James) | Premortem | Socratic |

각 LOD 진입 시 AI는 사용자에게 다음과 같이 선택지를 제시한다:

```
[L4 시나리오 카드] 어떤 사고법으로 갈까요?
  1) Laddering ⭐ (추천 — 표면 동기를 정체성 가치까지 끌어올립니다)
  2) Language Game (모호한 형용사 정밀화)
  3) Six Hats (시나리오를 6가지 관점으로 점검)
  4) 직접 입력 / 다른 방법 설명 요청
```

선택은 그 LOD 노드 안에서 유지된다(사용자가 막혀 "다른 방법으로" 요청하면 그때 전환). AI는 자기 판단으로 멋대로 전환하지 않는다.

선택된 방법론은 manifest에 노드별로 기록된다. 같은 노드를 재방문하면 같은 방법론이 default로 다시 제시된다.

### 제외한 방법론과 그 이유

다음은 의도적으로 도구에 포함하지 않는다(또는 내부에서만 활용):
- **Costa 3-Level Questioning** — Bloom과 중복
- **Paul-Elder 8 Elements** — 학술 무거움. L6 후반 검증 시 일부만 부분 차용
- **Zen 공안 직접 차용** — 신비주의로 보임. "무엇을 빼야 하나" 변형만 채택
- **IFS 전체 프로토콜** — 치료적. "동기의 다중성" 한 질문만 차용
- **SCAMPER 7글자 약어 노출** — 인지 부하. 내부 프롬프트로만 사용, 사용자에겐 평문 질문
- **Hegel 변증법의 "정-반-합" 학술어 노출** — "반대 입장에서 한 문장 변호해보세요"로 평문화

## 앱 카테고리 시스템

같은 LOD여도 앱 성격에 따라 1순위 방법론이 달라진다(예: *생산성 도구*에선 L4의 1순위가 Mom Test, *습관 형성 앱*에선 Laddering). 따라서 앱 카테고리를 별도 차원으로 두고, 카테고리 가중치로 LOD 추천을 동적으로 조정한다.

### 카테고리 8개

| | 카테고리 | 예시 | 강한 방법론 (boost) | 약한 방법론 (penalty) |
|---|---|---|---|---|
| 1 | 도구·생산성 | Notion · Linear · Todoist | Mom Test · Master/Apprentice · Toyota Kata · Pragmatism | Hero's Journey · Miracle Question · Projective |
| 2 | 게임·습관 형성 | Duolingo · Strava · Forest | Laddering · Hero's Journey framework · Miracle Question | Mom Test 검증형 |
| 3 | 소셜·커뮤니티 | Discord · Threads · Bereal | Mental Model · Projective · MICE Character | First Principles · Premortem |
| 4 | B2B·엔터프라이즈 | Salesforce · Linear B2B · Confluence | Mom Test · Premortem · JTBD Switch · Six Hats(검정) | Projective · IFS 부분질문 |
| 5 | 콘텐츠·미디어 | Spotify · Pinterest · Netflix | Projective · Diary Reflective · Master/Apprentice | Premortem · Mom Test |
| 6 | 거래·마켓플레이스 | 배민 · 쿠팡 · 당근 | Six Hats(검정) · Scene-Sequel · Mom Test | Tetralemma |
| 7 | 민감 정보·규제 | 헬스케어 · 금융 · 미성년 대상 | Premortem · Counterfactual · Paul-Elder(L6 한정) | Yes-And 무비판형 |
| 8 | 혼합·기타 | 정의 모호 또는 다축 | 가중치 없음 (LOD 디폴트 그대로) | — |

### 동작

1. **L1 진입 직후** AI가 사용자의 한 줄 설명을 듣고 카테고리를 *제안*: "이건 [도구·생산성] 카테고리 같아요. 맞나요? 다른 카테고리도 보여드릴까요?"
2. 사용자 승인 → manifest의 `category` 필드에 저장
3. 이후 모든 LOD에서 추천 가중치가 카테고리에 따라 동적 조정
4. 사용자는 매 LOD에서 카테고리 override 가능 ("이 챕터만 *민감·규제* 가중치로 봐줘")
5. 카테고리가 명백히 혼합이면 "혼합·기타" 선택 → 가중치 없이 디폴트 1-3순위 그대로 제시

구체적 카테고리별 가중치 표는 spec 본문이 아닌 `methodologies/category-weights.md`에 위임한다(가중치는 운영 중 튜닝되는 값이라 spec의 안정 영역 밖).

## 산출물 디렉토리 (사용자 프로젝트 안)

```
docs/spec/
  manifest.yml
  arc.md                    # L1-L2 (앱 전체 한 번)
  framework.md              # 선택한 framework 메모 (custom일 때 본문)
  chapters/
    01-discovery/
      index.md              # 챕터 카드 (L3)
      scenarios/
        01-first-encounter/
          card.md           # 시나리오 카드 (L4)
          scenes/
            01-landing.md   # 장면 (L5)
            02-cta.md
          spec.md           # codespeak-level (L6, 있을 때)
    02-onboarding/
      ...
```

빈 가지는 곧 빈 디렉토리/`(TBD)` 표시 markdown. 디렉토리 트리 자체가 진행 상태의 1차 시각화.

## manifest.yml

```yaml
version: 1
framework: pixar-pitch+story-circle
category: tool-productivity     # 8개 중 하나 또는 mixed
created_at: 2026-04-27
updated_at: 2026-04-27

arc:
  pixar_pitch:
    status: filled              # empty | filled
    methodology: jtbd-switch    # 이 노드에서 사용한 방법론
  story_circle:
    status: filled
    methodology: mice-quotient

chapters:
  - id: 01-discovery
    title: 발견
    story_circle_stage: [you, need]
    depth: L4                   # L3 | L4 | L5 | L6
    status: in_progress         # draft | in_progress | approved | implemented
    depends_on: []
    methodology_l3: toyota-kata
    scenarios:
      - id: 01-first-encounter
        depth: L5
        status: approved
        depends_on: []
        methodology_l4: laddering
        methodology_l5: master-apprentice
  - id: 02-onboarding
    title: 첫 진입
    story_circle_stage: [go]
    depth: L3
    status: draft
    depends_on: [01-discovery]
    scenarios: []

implementation_log:
  - chapter: 01-discovery
    scenario: 01-first-encounter
    implemented_at: 2026-04-28
    notes: ...
```

`methodology_*` 필드는 해당 노드에서 사용자가 선택한 방법론을 기록한다. 같은 노드를 재방문하면 이 값이 default로 제시된다.

manifest는 **AI가 매 인터뷰 시작 시 첫 번째로 읽는 파일**이다. 자기 위치·트리 형태·다음에 갈 수 있는 가지를 manifest에서 파악한 뒤 인터뷰를 시작한다.

manifest 갱신은 자연어로 AI가 직접 한다(별도 CLI 없음). 단순 YAML이라 LLM이 안전하게 다룰 수 있다.

## 인터뷰 흐름

1. **세션 시작.** 사용자가 자연어 또는 `/story-spec`으로 호출.
2. **manifest 로드.** 없으면 init 분기 (framework 선택 → 카테고리 선택 → L1 진입), 있으면 현재 트리 요약 출력 ("3개 챕터 중 1개 L5, 1개 L4, 1개 L3입니다. 어디로 갈까요?").
3. **사용자가 운전석.** 어느 챕터/시나리오를 어느 깊이까지 갈지 선택. AI는 비어 있는 가지·얕은 가지를 제안만 한다.
4. **방법론 선택.** 해당 LOD 노드에 기록된 방법론이 있으면 default, 없으면 카테고리 가중치 적용한 1-3순위 + "직접 입력" 옵션 제시. 사용자가 선택.
5. **현재 Level의 schema 적재.** 예: L4면 `schemas/scenario.md`를 읽어 시나리오 카드의 6필드(목표·동기·입력·행동·장애물·성공조건)를 인터뷰 backbone으로 삼는다.
6. **인터뷰.** Layer 1 메타 자세(OARS·Yes-And·Clean Language·Bloom 게이지·System 1/2)를 항상 적용한 채, 선택된 Layer 2 방법론의 질문 패턴을 한 번에 하나씩 던진다.
7. **사용자 승인.** 채워진 산출물을 사용자에게 요약 → 승인 받으면 파일 작성 + manifest 갱신(`methodology_*` 필드에 사용한 방법론 기록).
8. **다음 가지 제안.** "선행 챕터 X 시나리오 카드부터 잡으면 이 spec이 더 단단해집니다" 같은 가이드. 사용자가 선택.
9. **L6 도달 + 사용자 명시 승인 → 구현 단계로.** AI는 superpowers의 `writing-plans` 또는 `subagent-driven-development` skill로 인계.

## SKILL.md의 핵심 instruction (초안)

```
---
name: story-spec
description: "흐릿한 앱 아이디어를 사용자 경험의 서사로 풀어 내려가는 인터뷰형 기획 도구. 시작과 끝 → 큰 서사 → 챕터 → 시나리오 → 장면 → 구현 가능 spec 순서로 6단계 LOD를 자유 traversal하며, 매 단계에서 소크라테스식 질문으로 사용자의 암묵적 의도를 끌어낸다. 코드 작성 전에 호출."
---

# story-spec

이 skill은 사용자의 흐릿한 앱 아이디어를 codespeak.dev 수준의 plain-text spec까지 끌어내리는 인터뷰형 도구다.

## 가장 큰 룰 (positive instruction)

**진행:**
- 매 인터뷰의 첫 행동은 `docs/spec/manifest.yml` 읽기다. 없으면 init 분기로 진입.
- 사용자가 명시적으로 "이 시나리오 spec으로 구현해줘"라고 말하기 전까지, 너의 일은 인터뷰와 산출물 작성뿐이다. 코드는 그 다음 단계의 일이다.
- 한 번의 인터뷰 메시지에는 하나의 질문만 담는다. 사용자에게 두 가지를 동시에 묻지 않는다.
- 매 단계의 산출물은 schema 파일(`schemas/<level>.md`)의 필드를 backbone으로 작성한다. 자유 형식으로 흘리지 않는다.
- 사용자가 채워달라고 하지 않은 가지는 만들지 않는다. 빈 가지 채우기는 사용자의 결정이다.

**Layer 1 메타 자세 (전 단계 상시 적용, 선택 노출 없음):**
- **Clean Language: 사용자의 메타포·단어를 그대로 사용한다. 인터뷰어가 다른 비유나 동의어로 바꿔치지 않는다.** 사용자가 "이 앱은 비서다"라고 하면, 너는 "비서"의 종류·위치·전후만 캐묻고, "도우미"·"파트너"·"어시스턴트" 같은 다른 단어를 끼워넣지 않는다.
- OARS: 사용자 발화를 살짝 다르게 되돌려 자기 정정을 유도한다("그러니까 ___라는 거네요. 맞나요?").
- Yes-And: 사용자 발화를 부정하지 않고 덧붙인다.
- Bloom 게이지: 사용자 답이 어느 인지 층위에 있는지 진단해 다음 질문을 한 단계 위 또는 아래로 조정한다.
- System 1/2 이중 캡처: 사용자에게 첫 직관과 30초 정교화를 둘 다 묻는다.

**Layer 2 방법론 선택:**
- 매 LOD 진입 시 manifest의 `methodology_*` 필드와 `category` 가중치를 보고 1-3순위 + "직접 입력"을 제시한다. 1순위에 ⭐ 표시.
- 사용자가 선택하면 그 LOD 노드 안에서 해당 방법론을 유지한다.
- 자기 판단으로 멋대로 방법론을 전환하지 않는다. 사용자가 "다른 방법으로" 요청할 때만 전환한다.

## 6단계 LOD (자세한 흐름은 process.md 참조)

L1 시작과 끝 (Pixar Pitch) → L2 큰 서사 (Story Circle) → L3 챕터 → L4 시나리오 카드 → L5 장면 → L6 구현 가능 spec.

L1·L2는 앱 전체에 대해 한 번. L3 이하는 자유 traversal.

## 인계

L6 산출물에 대해 사용자가 명시 승인하면 superpowers의 `writing-plans` skill로 다음 단계를 인계한다.
```

## 비범위 (이번 spec에서 안 함)

- **CLI 도구.** manifest 조작은 자연어 + skill 지침으로 충분하다는 가정. 잦은 실수가 관측되면 차후 추가.
- **Multi-agent 분해.** 단일 skill로 시작. 컨텍스트 압박이 관측되면 단계별 sub-agent 도입 검토.
- **시각 도구 (Mermaid·웹 UI).** 디렉토리 트리 + manifest로 충분. 시각화는 차후.
- **다국어.** 한국어 우선, 영어 동시 지원은 차후.
- **코드 → spec 역방향 (codespeak의 "Coming Soon" 기능).** 본 도구는 forward-only.

## 검증 시나리오 (skill 완성 후 손으로 돌릴 것)

1. **흐릿한 한 줄 아이디어**로 시작하여 L1 Pixar Pitch가 7문장으로 채워질 때까지 인터뷰가 작동하는가.
2. **챕터 3개를 다른 깊이**로 (L3·L4·L6) 진행했을 때 manifest와 디렉토리 트리가 일관되게 갱신되는가.
3. **의존하는 챕터**의 선행이 비어 있을 때 AI가 강제 차단이 아니라 가이드로만 행동하는가.
4. L6 도달 후 명시 승인 시 `writing-plans` skill로 자연스럽게 인계되는가.
5. 두 번째 인터뷰 세션에서 manifest만 읽고도 AI가 위치·다음 가지·이전 선택 방법론을 정확히 파악하는가.
6. **Clean Language 룰 검증:** 사용자가 "비서 같은 앱"이라고 했을 때 AI가 "도우미"·"파트너"로 바꿔 부르지 않고 "비서"만 사용하는가.
7. **카테고리 가중치 검증:** 같은 L4에서 *생산성 도구* 카테고리는 Mom Test가 1순위, *습관 형성* 카테고리는 Laddering이 1순위로 추천되는가.
8. **노드별 방법론 기록 검증:** 시나리오 A에서 Laddering 선택 후 다른 시나리오 B로 갔다가 다시 A로 돌아왔을 때, manifest의 `methodology_l4: laddering`이 default로 다시 제시되는가.

## 후속

이 spec이 승인되면, superpowers의 `writing-plans` skill을 호출해 단계별 구현 계획서를 작성한다. 본 spec 자체는 구현 계획이 아니다.
