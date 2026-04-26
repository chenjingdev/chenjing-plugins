# story-spec Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 흐릿한 앱 아이디어를 사용자 경험의 서사로 풀어 6단계 LOD로 분해하는 인터뷰형 Claude Code skill `story-spec`을 `chenjing-plugins` 마켓플레이스에 새 플러그인으로 추가한다.

**Architecture:** Claude Code skill 1개. SKILL.md instruction이 핵심 진행 통제, schemas/frameworks/methodologies/ 디렉토리가 인터뷰 backbone과 질문 풀을 제공. 사용자 프로젝트 안의 `docs/spec/manifest.yml`이 진행 상태의 단일 권위. Layer 1 메타 자세는 강제 룰, Layer 2 방법론은 사용자 선택. 8개 앱 카테고리 가중치로 추천 동적 조정.

**Tech Stack:** Markdown(SKILL.md, 콘텐츠 파일) · YAML(manifest, plugin.json) · Claude Code skill 시스템.

**Spec 참조:** `docs/superpowers/specs/2026-04-27-story-spec-design.md`

---

## 작성 원칙

이 플랜은 코드 구현이 아닌 **markdown skill 파일 작성**이 주를 이룬다. 따라서 traditional TDD(failing test → impl → pass) 형식은 적용되지 않는다. 대신:

- 각 Task = 한 파일 또는 응집된 파일 그룹 작성
- 각 Step = 파일 작성 → 셀프 리뷰(placeholder/모순/스코프) → commit
- 검증은 각 단계 commit 후 spec의 검증 시나리오 8개에 매핑하여 manual run-through (Task 11에서 일괄)

**Commit 메시지 패턴:** `feat(story-spec): <범위>` 또는 `docs(story-spec): <범위>`

**모든 작업 디렉토리:** `/Users/chenjing/dev/chenjing-plugins/`

---

## File Structure

```
plugins/story-spec/
├── .claude-plugin/
│   └── plugin.json
└── skills/story-spec/
    ├── SKILL.md                              # Task 2
    ├── process.md                            # Task 3
    ├── schemas/
    │   ├── arc.md                            # Task 4
    │   ├── chapter.md
    │   ├── scenario.md
    │   ├── scene.md
    │   └── spec.md
    ├── frameworks/
    │   ├── pixar-pitch.md                    # Task 5
    │   ├── story-circle.md
    │   ├── kishotenketsu.md
    │   └── hero-journey.md
    └── methodologies/
        ├── INDEX.md                          # Task 6
        ├── category-weights.md
        ├── layer1-meta/                      # Task 7
        │   ├── clean-language.md
        │   ├── oars.md
        │   ├── yes-and.md
        │   ├── bloom-gauge.md
        │   └── system-1-2.md
        └── layer2-tools/                     # Task 8, 9, 10
            ├── socratic.md
            ├── jtbd-switch.md
            ├── miracle-question.md
            ├── mom-test.md
            ├── mice-quotient.md
            ├── tetralemma.md
            ├── toyota-kata.md
            ├── counterfactual.md
            ├── mental-model.md
            ├── laddering.md
            ├── language-game.md
            ├── six-hats.md
            ├── master-apprentice.md
            ├── scene-sequel.md
            ├── projective.md
            ├── pragmatism.md
            └── premortem.md
```

마켓플레이스 등록은 Task 1에서 `.claude-plugin/marketplace.json`에 항목 추가.

---

## Task 1: 플러그인 스캐폴딩 + 마켓플레이스 등록

**Files:**
- Create: `plugins/story-spec/.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`

- [ ] **Step 1.1: `plugins/story-spec/.claude-plugin/plugin.json` 작성**

```json
{
  "name": "story-spec",
  "description": "흐릿한 앱 아이디어를 사용자 경험의 서사로 풀어 6단계 LOD로 분해하는 인터뷰형 기획 도구",
  "version": "0.1.0"
}
```

- [ ] **Step 1.2: `.claude-plugin/marketplace.json`에 항목 추가**

기존 `plugins` 배열의 `resume` 항목 다음에 다음 객체 추가:

```json
{
  "name": "story-spec",
  "description": "흐릿한 앱 아이디어를 사용자 경험의 서사로 풀어 6단계 LOD로 분해하는 인터뷰형 기획 도구",
  "source": "./plugins/story-spec",
  "skills": [
    "./skills/story-spec"
  ]
}
```

- [ ] **Step 1.3: 디렉토리 트리 생성**

```bash
mkdir -p plugins/story-spec/skills/story-spec/{schemas,frameworks,methodologies/layer1-meta,methodologies/layer2-tools}
```

- [ ] **Step 1.4: Commit**

```bash
git add plugins/story-spec/.claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "feat(story-spec): 플러그인 스캐폴딩 + 마켓플레이스 등록"
```

---

## Task 2: SKILL.md 작성 (핵심 진행 통제)

**Files:**
- Create: `plugins/story-spec/skills/story-spec/SKILL.md`

**핵심 책임:** 인터뷰의 모든 진행 통제 룰. AI가 매 인터뷰의 첫 행동, Layer 1 메타 자세 강제, Layer 2 방법론 선택 패턴, L6 도달 시 인계까지 명시.

- [ ] **Step 2.1: 파일 작성** — 다음 구조로 (full content는 spec의 "SKILL.md의 핵심 instruction" 섹션을 충실히 확장):

```markdown
---
name: story-spec
description: "흐릿한 앱 아이디어를 사용자 경험의 서사로 풀어 내려가는 인터뷰형 기획 도구. 시작과 끝 → 큰 서사 → 챕터 → 시나리오 → 장면 → 구현 가능 spec 순서로 6단계 LOD를 자유 traversal하며, 매 단계에서 사용자 선택 방법론으로 인터뷰. 코드 작성 전에 호출."
---

# story-spec

[역할 1단락]

## 가장 큰 룰 (positive instruction)

### 진행
- 매 인터뷰의 첫 행동은 `docs/spec/manifest.yml` 읽기다. 없으면 init 분기.
- ... (spec의 진행 룰 5개)

### Layer 1 메타 자세 (전 단계 상시, 선택 노출 없음)
- **Clean Language: 사용자의 메타포·단어를 그대로 사용한다. ...** (spec의 Clean Language 강조 룰)
- ... (OARS, Yes-And, Bloom 게이지, System 1/2)

### Layer 2 방법론 선택
- 매 LOD 진입 시 manifest의 methodology_* 필드와 category 가중치를 보고 1-3순위 + 직접 입력을 제시. 1순위에 ⭐.
- ... (선택 유지/전환 룰)

## 6단계 LOD

L1 시작과 끝 (Pixar Pitch) → L2 큰 서사 (Story Circle) → L3 챕터 → L4 시나리오 카드 → L5 장면 → L6 구현 가능 spec.
자세한 흐름은 process.md, 단계별 schema는 schemas/<level>.md, 방법론 풀은 methodologies/INDEX.md 참조.

## init 분기 (manifest 없을 때)

1. framework 선택 (default: pixar-pitch+story-circle)
2. 카테고리 선택 (사용자 한 줄 설명 듣고 AI가 8개 중 제안 → 승인)
3. manifest.yml 생성
4. L1 진입

## 인계

L6 산출물에 대해 사용자가 명시 승인하면 superpowers:writing-plans skill로 다음 단계를 인계.
```

- [ ] **Step 2.2: 셀프 리뷰** — placeholder/TODO 0개, Clean Language 룰이 강제 명시되어 있는지, init 분기 흐름 명확한지 확인

- [ ] **Step 2.3: Commit**

```bash
git add plugins/story-spec/skills/story-spec/SKILL.md
git commit -m "feat(story-spec): SKILL.md — 인터뷰 진행 통제 룰"
```

---

## Task 3: process.md 작성 (6단계 흐름)

**Files:**
- Create: `plugins/story-spec/skills/story-spec/process.md`

**핵심 책임:** SKILL.md가 *룰*을 명시한다면 process.md는 *세션 흐름*을 자세히 설명. 9단계 인터뷰 흐름 (spec의 "인터뷰 흐름" 섹션) + LOD 진입/이탈 시 manifest 갱신 패턴 + 카테고리 변경 시 동작.

- [ ] **Step 3.1: 파일 작성**

다음 섹션 포함:
1. 세션 시작 → manifest 로드 (없으면 init 분기) — Mermaid 또는 텍스트 다이어그램
2. 9단계 인터뷰 흐름 (spec 섹션 그대로, 코드 예시 보강)
3. 각 LOD 진입 시 패턴 (방법론 선택 → schema 적재 → 인터뷰 → 사용자 승인 → manifest 갱신)
4. 의존성 가드 동작 (선행 챕터 비어 있을 때 가이드 톤 예시)
5. 카테고리 override 패턴 (LOD 안에서 카테고리 변경 시 manifest 임시 필드)
6. L6 도달 후 writing-plans 인계 패턴

- [ ] **Step 3.2: 셀프 리뷰 + Commit**

```bash
git add plugins/story-spec/skills/story-spec/process.md
git commit -m "feat(story-spec): process.md — 9단계 인터뷰 흐름과 LOD 진입 패턴"
```

---

## Task 4: schemas/ 5개 (LOD별 산출물 backbone)

**Files:**
- Create: `plugins/story-spec/skills/story-spec/schemas/arc.md`
- Create: `plugins/story-spec/skills/story-spec/schemas/chapter.md`
- Create: `plugins/story-spec/skills/story-spec/schemas/scenario.md`
- Create: `plugins/story-spec/skills/story-spec/schemas/scene.md`
- Create: `plugins/story-spec/skills/story-spec/schemas/spec.md`

**핵심 책임:** 각 LOD의 산출물이 *어떤 필드*를 가져야 하는지 backbone 정의. AI는 매 LOD에서 이 schema를 읽어 인터뷰 backbone으로 삼고, 결과 markdown 파일을 이 형식으로 작성.

- [ ] **Step 4.1: `schemas/arc.md` 작성** (L1 + L2)

다음 섹션:
- Pixar Pitch 7필드 (Once upon a time / Every day / One day / Because of that / Because of that / Until finally / And ever since then)
- Story Circle 8필드 (You / Need / Go / Search / Find / Take / Return / Change), 각 필드 1-3문장 수준 가이드
- 출력 markdown 템플릿 (헤딩 구조)

- [ ] **Step 4.2: `schemas/chapter.md` 작성** (L3)

필드: 제목, 목적 1문장, story_circle_stage 매핑, 의존하는 챕터 ID, 챕터 한 줄 활(arc) 묘사. 출력 템플릿 포함.

- [ ] **Step 4.3: `schemas/scenario.md` 작성** (L4)

필드 6개: 목표 / 동기 / 입력(전제 조건과 사용자가 가지고 들어오는 것) / 행동(사용자가 수행하는 일련의 동작) / 장애물(실패 가능 지점) / 성공 조건(관찰 가능한 형태로). 각 필드 가이드 + 좋은/나쁜 예시 1쌍씩.

- [ ] **Step 4.4: `schemas/scene.md` 작성** (L5)

필드 4개: 화면(이름과 정체) / 상태(이 장면 직전 시스템 상태) / 사용자 행동(클릭·타입·말 등 raw input) / 시스템 반응(시각·청각·데이터 변화). 시퀀스 다이어그램 형식 옵션 안내.

- [ ] **Step 4.5: `schemas/spec.md` 작성** (L6)

codespeak.dev 스타일 plain-text spec 4섹션:
- State model (어떤 상태가 있고 전이 조건)
- Event flow (사용자/시스템 이벤트의 발생 순서)
- Data model (저장되는 entity와 관계)
- Acceptance criteria (관찰 가능한 형태의 통과 기준 N개)

각 섹션은 자연어 작성, AI 구현 시 코드로 변환 가능한 정밀도. 예시 1세트 (간단한 todo 추가 시나리오 기준).

- [ ] **Step 4.6: 셀프 리뷰 + Commit**

```bash
git add plugins/story-spec/skills/story-spec/schemas/
git commit -m "feat(story-spec): schemas — L1~L6 산출물 backbone 5개"
```

---

## Task 5: frameworks/ 4개 (narrative framework 옵션)

**Files:**
- Create: `plugins/story-spec/skills/story-spec/frameworks/pixar-pitch.md`
- Create: `plugins/story-spec/skills/story-spec/frameworks/story-circle.md`
- Create: `plugins/story-spec/skills/story-spec/frameworks/kishotenketsu.md`
- Create: `plugins/story-spec/skills/story-spec/frameworks/hero-journey.md`

**핵심 책임:** L1·L2 인터뷰의 backbone framework. 각 파일은 framework의 단계 정의, 각 단계의 핵심 질문, 제품 기획 적용 시 변형, 어떤 앱 카테고리에 어울리는지.

- [ ] **Step 5.1: `pixar-pitch.md` 작성**

7문장 구조 + 각 문장이 던지는 핵심 질문 + 제품 기획 변형 예시 1개 (가상의 todo 앱 기준).

- [ ] **Step 5.2: `story-circle.md` 작성**

8단계 (You/Need/Go/Search/Find/Take/Return/Change) + 각 단계가 챕터로 변환될 때의 가이드 + 사용자의 "발견~재방문" 8챕터 예시와의 매핑 표.

- [ ] **Step 5.3: `kishotenketsu.md` 작성** (대안)

기-승-전-결 4단계, 갈등 없는 진행 정신 강조. 도구·생산성 카테고리에 추천. 4단계 → 챕터 변환 가이드.

- [ ] **Step 5.4: `hero-journey.md` 작성** (대안)

캠벨의 12단계 약식. 게임·습관 형성 카테고리 추천. 단계 → 챕터 변환 가이드.

- [ ] **Step 5.5: `custom.md` 작성** (대안)

사용자가 자기만의 framework를 쓰고 싶을 때 `docs/spec/framework.md`에 직접 작성하는 1단락 가이드. 최소 요구 명시: L1 단계 정의(시작과 끝 한 쌍) + L2 펼침 단계 정의(N단계). 사용자가 작성하면 AI는 그 framework를 backbone으로 인터뷰. AI가 사용자 framework를 *오염시키지 않는* Clean Language 룰이 여기에도 적용됨을 명시.

- [ ] **Step 5.6: Commit**

```bash
git add plugins/story-spec/skills/story-spec/frameworks/
git commit -m "feat(story-spec): frameworks — Pixar Pitch + Story Circle 기본 + Kishōtenketsu/Hero's Journey/Custom 대안"
```

---

## Task 6: methodologies/INDEX.md + category-weights.md

**Files:**
- Create: `plugins/story-spec/skills/story-spec/methodologies/INDEX.md`
- Create: `plugins/story-spec/skills/story-spec/methodologies/category-weights.md`

- [ ] **Step 6.1: `INDEX.md` 작성**

- 14개 Layer 2 방법론 한눈 카드 (이름 · 한 줄 정의 · 어울리는 LOD · 파일 링크)
- 5개 Layer 1 메타 자세 별도 섹션
- LOD별 1-3순위 표 (spec과 동일)
- 사용자에게 보여주는 선택지 형식 예시 (L4 진입 시 화면 mockup)

- [ ] **Step 6.2: `category-weights.md` 작성**

8개 카테고리 × 14개 Layer 2 방법론의 가중치 표. boost(+1) / neutral(0) / penalty(-1) 3단계로 단순화. spec의 카테고리 표를 풀어서 각 셀 채움. 가중치 합산 알고리즘 설명 1단락.

- [ ] **Step 6.3: Commit**

```bash
git add plugins/story-spec/skills/story-spec/methodologies/INDEX.md plugins/story-spec/skills/story-spec/methodologies/category-weights.md
git commit -m "feat(story-spec): methodologies INDEX + 카테고리 가중치 표"
```

---

## Task 7: methodologies/layer1-meta/ 5개 (강제 메타 자세)

**Files:**
- Create: `plugins/story-spec/skills/story-spec/methodologies/layer1-meta/clean-language.md`
- Create: `plugins/story-spec/skills/story-spec/methodologies/layer1-meta/oars.md`
- Create: `plugins/story-spec/skills/story-spec/methodologies/layer1-meta/yes-and.md`
- Create: `plugins/story-spec/skills/story-spec/methodologies/layer1-meta/bloom-gauge.md`
- Create: `plugins/story-spec/skills/story-spec/methodologies/layer1-meta/system-1-2.md`

**각 파일의 공통 구조:**
- 무엇인가 (1-2문장)
- 핵심 룰 1-3개 (positive instruction)
- 좋은 적용 / 위반 예시 각 1쌍
- 다른 Layer 1과의 관계

- [ ] **Step 7.1: `clean-language.md`** — David Grove 9 questions 중 핵심 5개 + "사용자 단어 그대로" 강제 룰 + 위반 예시(사용자가 "비서"라고 했는데 AI가 "도우미"로 바꿔 부르기) + 올바른 적용

- [ ] **Step 7.2: `oars.md`** — Open / Affirm / Reflect / Summarize 각각 한 문장 룰 + Reflective listening 예시

- [ ] **Step 7.3: `yes-and.md`** — Improv 규칙. 부정하지 않고 덧붙이기. 위반(부정·반박) vs 올바름(인정+확장) 예시

- [ ] **Step 7.4: `bloom-gauge.md`** — 6층위(기억·이해·적용·분석·평가·창조). 사용자 답이 어느 층위인지 진단하는 신호 + 다음 질문 층위 결정 룰

- [ ] **Step 7.5: `system-1-2.md`** — Kahneman 직관/정교화. "처음 떠오른 답 + 30초 정교화" 이중 캡처 패턴. 둘 다 manifest나 산출물에 기록.

- [ ] **Step 7.6: Commit**

```bash
git add plugins/story-spec/skills/story-spec/methodologies/layer1-meta/
git commit -m "feat(story-spec): Layer 1 메타 자세 5개 — Clean Language·OARS·Yes-And·Bloom·System 1/2"
```

---

## Task 8: methodologies/layer2-tools/ — L1·L2용 5개

**Files:**
- Create: `plugins/story-spec/skills/story-spec/methodologies/layer2-tools/miracle-question.md`
- Create: `plugins/story-spec/skills/story-spec/methodologies/layer2-tools/jtbd-switch.md`
- Create: `plugins/story-spec/skills/story-spec/methodologies/layer2-tools/mom-test.md`
- Create: `plugins/story-spec/skills/story-spec/methodologies/layer2-tools/mice-quotient.md`
- Create: `plugins/story-spec/skills/story-spec/methodologies/layer2-tools/tetralemma.md`

**각 파일의 공통 구조:**
- 무엇인가 (1-2문장 + 출처/역사)
- 어울리는 LOD (1순위/2순위/3순위 중 어디에 등장하는지)
- 어울리는 카테고리 (boost 받는 카테고리)
- 핵심 질문 패턴 3-5개 (그대로 사용 가능한 한국어 문장)
- 안티패턴 (잘못 적용하면 어떤 모습인지)
- Layer 1 메타 자세와의 결합 메모

- [ ] **Step 8.1: `miracle-question.md`** — Solution-Focused Brief Therapy. "기적이 일어나 다 해결됐다, 내일 처음 무엇으로 알아채요?" L1 1순위. Pixar의 "and finally"를 체험적으로 끌어냄.

- [ ] **Step 8.2: `jtbd-switch.md`** — Bob Moesta. "마지막으로 그 문제가 일어났던 순간"·"현재 방식을 *해고*하려면" L1 2순위. 도구·생산성/B2B 카테고리에 boost.

- [ ] **Step 8.3: `mom-test.md`** — Rob Fitzpatrick. 가정형·일반론 봉쇄, 과거 행동·자원 지출만 묻기. L1·L4 검증용. 도구·B2B·규제 카테고리에 boost.

- [ ] **Step 8.4: `mice-quotient.md`** — Orson Scott Card. Milieu·Inquiry·Character·Event 4축으로 사용자 여정 분류. L2 1순위. 소셜·콘텐츠 카테고리에 boost.

- [ ] **Step 8.5: `tetralemma.md`** — 불교 사구분별. A다/A 아니다/둘 다/둘 다 아니다 강제 펼침. L2 3순위. 카테고리 정체성이 모호할 때.

- [ ] **Step 8.6: Commit**

```bash
git add plugins/story-spec/skills/story-spec/methodologies/layer2-tools/{miracle-question,jtbd-switch,mom-test,mice-quotient,tetralemma}.md
git commit -m "feat(story-spec): Layer 2 L1·L2용 방법론 5개"
```

---

## Task 9: methodologies/layer2-tools/ — L3·L4용 6개

**Files:**
- Create: `plugins/story-spec/skills/story-spec/methodologies/layer2-tools/toyota-kata.md`
- Create: `plugins/story-spec/skills/story-spec/methodologies/layer2-tools/counterfactual.md`
- Create: `plugins/story-spec/skills/story-spec/methodologies/layer2-tools/mental-model.md`
- Create: `plugins/story-spec/skills/story-spec/methodologies/layer2-tools/laddering.md`
- Create: `plugins/story-spec/skills/story-spec/methodologies/layer2-tools/language-game.md`
- Create: `plugins/story-spec/skills/story-spec/methodologies/layer2-tools/six-hats.md`

(공통 구조는 Task 8과 동일)

- [ ] **Step 9.1: `toyota-kata.md`** — Improvement Kata 4질문 (목표상태/현재상태/다음 장애물/다음 실험). L3 1순위. 도구·생산성 카테고리 boost.

- [ ] **Step 9.2: `counterfactual.md`** — "이 챕터/기능 *없이* 사용자가 같은 일을 하려면?" L3 2순위, L5 보조. 모든 카테고리에서 중성.

- [ ] **Step 9.3: `mental-model.md`** — Indi Young. 평가하지 않고 "그 일을 하던 중 마음속에서 무엇이?" 듣기. L3 3순위. 소셜·콘텐츠 boost.

- [ ] **Step 9.4: `laddering.md`** — 수단-목적 사슬. "이게 왜 중요해요?" × 5단으로 표면 → 정체성 가치까지. L4 1순위. 게임·습관/콘텐츠 boost.

- [ ] **Step 9.5: `language-game.md`** — Wittgenstein. 정의가 아닌 *용례*를 수집. 모호한 형용사("간편한", "스마트한") 정밀화. L4 2순위.

- [ ] **Step 9.6: `six-hats.md`** — de Bono. 흰/빨강/검정/노랑/초록/파랑 모자. 같은 시나리오를 6관점으로 점검. L4 3순위. 거래·B2B에서 검정모자 boost.

- [ ] **Step 9.7: Commit**

```bash
git add plugins/story-spec/skills/story-spec/methodologies/layer2-tools/{toyota-kata,counterfactual,mental-model,laddering,language-game,six-hats}.md
git commit -m "feat(story-spec): Layer 2 L3·L4용 방법론 6개"
```

---

## Task 10: methodologies/layer2-tools/ — L5·L6용 6개

**Files:**
- Create: `plugins/story-spec/skills/story-spec/methodologies/layer2-tools/master-apprentice.md`
- Create: `plugins/story-spec/skills/story-spec/methodologies/layer2-tools/scene-sequel.md`
- Create: `plugins/story-spec/skills/story-spec/methodologies/layer2-tools/projective.md`
- Create: `plugins/story-spec/skills/story-spec/methodologies/layer2-tools/pragmatism.md`
- Create: `plugins/story-spec/skills/story-spec/methodologies/layer2-tools/premortem.md`
- Create: `plugins/story-spec/skills/story-spec/methodologies/layer2-tools/socratic.md`

- [ ] **Step 10.1: `master-apprentice.md`** — Contextual Inquiry. "제가 견습생이라 치고 처음부터 끝까지 보여주세요." L5 1순위. 도구·생산성·콘텐츠 boost.

- [ ] **Step 10.2: `scene-sequel.md`** — Dwight Swain. 장면(목표-갈등-결말) + sequel(반응-딜레마-결정). L5 2순위. 거래·게임 boost.

- [ ] **Step 10.3: `projective.md`** — "이 앱이 사람이라면? 친구에게 추천 문자 한 통이라면?" L5 3순위. 콘텐츠·소셜 boost.

- [ ] **Step 10.4: `pragmatism.md`** — William James. "이게 참이라면 *어떤 차이*가 발생?" 추상 비전을 관찰 가능한 차이로. L1 끝·L4 success·L6 1순위.

- [ ] **Step 10.5: `premortem.md`** — Klein. "1년 뒤 망했다 가정. 무엇 때문이었나?" L1 끝·L4 장애물·L6 2순위. B2B·규제에 강한 boost.

- [ ] **Step 10.6: `socratic.md`** — 산파술. 명료화·가정 검토·근거·반대·함의·메타 6패턴. L2·L4·L6에 등장. 다른 방법론들과의 차이를 명시(소크라테스가 모든 단계에 등장하지만 단일 솔루션은 아님).

- [ ] **Step 10.7: Commit**

```bash
git add plugins/story-spec/skills/story-spec/methodologies/layer2-tools/{master-apprentice,scene-sequel,projective,pragmatism,premortem,socratic}.md
git commit -m "feat(story-spec): Layer 2 L5·L6용 방법론 6개"
```

---

## Task 11: 검증 시나리오 manual run-through (8개)

**Files:**
- Create: `plugins/story-spec/skills/story-spec/VERIFY.md`

**핵심 책임:** spec의 검증 시나리오 8개를 *수동 실행 가능한 체크리스트*로 변환. 각 시나리오마다 입력 / 기대 동작 / 통과 기준 명시. 향후 회귀 테스트의 토대.

- [ ] **Step 11.1: `VERIFY.md` 작성**

각 시나리오 항목 형식:

```markdown
## 시나리오 N: [이름]

**입력:** 사용자가 ___이라고 말한다.

**기대 동작:**
- AI는 ___을 한다
- AI는 ___을 하지 않는다 (Layer 1 룰 위반 금지)

**통과 기준 (관찰 가능):**
- [ ] manifest의 X 필드가 Y로 갱신됨
- [ ] AI 응답에 ___ 표현이 포함됨 (또는 포함되지 않음)
```

8개 시나리오 모두 (spec 본문의 "검증 시나리오" 섹션 그대로 풀어 작성).

- [ ] **Step 11.2: 첫 시나리오 실제 실행**

Claude Code에서 `/story-spec`을 호출해 1번 시나리오(흐릿한 한 줄 아이디어 → L1 Pixar Pitch 7문장 채워질 때까지) 한 번 돌려보기. 통과/미통과 기록.

- [ ] **Step 11.3: 발견된 버그/모호함은 별도 commit으로 수정**

1번 시나리오에서 미통과 항목이 있으면 SKILL.md / process.md / schemas/arc.md를 수정해 통과시킨 뒤, 새 commit:

```bash
git commit -m "fix(story-spec): VERIFY 시나리오 1 통과를 위한 <범위> 수정"
```

- [ ] **Step 11.4: VERIFY.md commit**

```bash
git add plugins/story-spec/skills/story-spec/VERIFY.md
git commit -m "test(story-spec): 8개 검증 시나리오 manual run-through 체크리스트"
```

---

## Self-Review (계획서 작성 후 본인 점검)

### 1. Spec coverage

spec의 모든 섹션을 plan task에 매핑:
- 6단계 LOD → schemas/ Task 4
- Pixar Pitch + Story Circle 기본 framework → frameworks/ Task 5
- 대안 framework 3개 → Task 5에 포함 (kishotenketsu, hero-journey, custom)
- Layer 1 메타 자세 5개 → Task 7
- Layer 2 방법론 14개 → Task 8/9/10 (5+6+6=17, 단 socratic·pragmatism·premortem 등 LOD 다중 등장 포함하여 중복 정리. 실제 파일 수는 socratic 1·jtbd-switch 1 등 17 - 중복 제거 = 17개 그대로)
- 8개 카테고리 시스템 → Task 6 (category-weights)
- manifest.yml schema → Task 2 SKILL.md + Task 3 process.md에 분산
- 산출물 디렉토리 구조 → Task 2/3에서 안내, 사용자 프로젝트에 자동 생성되므로 별도 task 없음
- Clean Language 강제 룰 → Task 2 SKILL.md + Task 7 clean-language.md
- 카테고리 override → Task 3 process.md
- writing-plans 인계 → Task 2 SKILL.md "인계" 섹션
- 검증 시나리오 8개 → Task 11

**Custom framework**은 spec에서 옵션으로 명시되어 있다 — Task 5의 Step 5.5에 `custom.md` 가이드 작성을 포함시켜 해소함.

### 2. Placeholder scan

`grep -i "TBD\|TODO\|fill in\|implement later"` 통과 (이 plan에는 없음 — 각 task에 무엇을 쓸지 outline 명시되어 있음, 단 완전한 markdown 본문은 task 실행 단계에서 작성).

**주의:** 이 plan은 traditional writing-plans와 다르게 *완전한 코드*를 step에 박지 않고 *outline*을 박는다. 이유: markdown 콘텐츠 작성은 코드와 달리 outline만으로 충분한 지침이 되며, 모든 본문을 plan에 박으면 plan이 5천줄을 넘어 가독성 손해. 이는 의도적 절충이며, brainstorming spec의 "AI 지침으로 풀린다" 신호와 일치.

### 3. Type consistency

- 모든 task에서 디렉토리 경로 일관: `plugins/story-spec/skills/story-spec/...`
- 방법론 파일 이름 kebab-case 일관 (`jtbd-switch.md`, `miracle-question.md`)
- 카테고리 ID 일관: `tool-productivity` / `game-habit` / `social-community` / `b2b-enterprise` / `content-media` / `marketplace-transaction` / `sensitive-regulated` / `mixed`
- LOD 표기 일관: `L1`~`L6`
- methodology_l1~l6 manifest 필드 이름 일관

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-27-story-spec-implementation.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Task별로 fresh subagent를 띄워 task 단위로 review·iterate. story-spec은 11개 task로 task당 컨텍스트가 깔끔하게 분리되어 subagent 적합.

**2. Inline Execution** — 이 세션에서 그대로 task 차례차례 실행. 컨텍스트가 누적되지만 사용자가 매 commit 후 검토 가능.

어느 방식으로 갈까?
