# manifest schema

## 무엇인가

`docs/spec/manifest.yml`은 한 사용자 프로젝트의 story-spec 세션 *전체 상태*를 한 파일에 응축한 진실의 단일 출처(single source of truth)다. 매 인터뷰의 첫 행동은 이 파일을 읽는 것이고, 매 산출물 승인 시점에 이 파일이 갱신된다. 다음 세션이 *같은 파일만 읽고도* 위치·다음 가지·이전 방법론을 정확히 복원할 수 있어야 한다.

크게 세 묶음의 필드로 구성된다.

1. **메타** — framework / category / updated_at
2. **콘텐츠** — arc / chapters / implementation_log (LOD 노드의 진행 상태)
3. **세션 상태** — session_state (사용자의 *지금 상태* 자가 인식 트래커)

세션 상태는 매 턴 갱신되는 사용자 인지 모델이다. 큰 신호 4종(단어 미합의·메타 동형·prototype 부재·막힘)이 detected되면 명시 turn-back을 발동시키고, 사일런트 신호 3종(톤·답변 깊이·어휘 수준)은 응답 톤만 조용히 조정한다. 자세한 자가 점검 룰은 `SKILL.md`의 `### 매 턴 자가 점검` 섹션 참조.

## 필드 정의 — 메타

### `framework`
- **값:** `pixar-pitch+story-circle` | `kishotenketsu` | `hero-journey` | `custom`
- **갱신 시점:** init 분기에서 한 번 박힘. 이후 변경 금지(다른 framework로 가려면 새 manifest를 만든다).

### `category`
- **값:** `tool-productivity` | `game-habit` | `social-community` | `b2b-enterprise` | `content-media` | `marketplace-transaction` | `sensitive-regulated` | `mixed`
- **갱신 시점:** init 분기에서 한 번 박힘. 노드별 임시 변경은 `category_override`로 (전역 `category`는 그대로).

### `updated_at`
- **값:** ISO 8601 날짜 또는 datetime
- **갱신 시점:** 콘텐츠/세션 상태 어느 필드든 갱신될 때마다.

## 필드 정의 — 콘텐츠

### `arc`
L1·L2(앱 전체에 한 번)의 진행 상태.

```yaml
arc:
  pixar_pitch:
    status: empty | in_progress | filled | approved
    methodology_l1: jtbd-switch | mom-test | miracle-question | <id>
  story_circle:
    status: empty | in_progress | filled | approved
    methodology_l2: mice-quotient | tetralemma | socratic | <id>
```

- `status`: 산출물(`docs/spec/arc.md`)에 해당 부분이 채워진 정도.
- `methodology_l*`: 사용자가 선택한 방법론 ID. 재방문 시 default로 다시 제시됨.

### `chapters`
L3 이하 트리. 자유 traversal로 각 챕터의 깊이가 다를 수 있다.

```yaml
chapters:
  - id: 01-discovery
    slug: discovery
    depth: L3 | L4 | L5 | L6        # 사용자가 이 챕터를 어디까지 팠는지
    status: empty | draft | approved
    story_circle_stage: 1-8         # L2에서 매핑된 stage
    depends_on: [<other_chapter_id>]
    methodology_l3: toyota-kata | counterfactual | mental-model | <id>
    category_override: null | <category_id>   # 이 챕터에만 임시 적용
    scenarios:
      - id: 01-first-encounter
        slug: first-encounter
        depth: L4 | L5 | L6
        status: empty | draft | approved | implemented
        methodology_l4: laddering | mom-test | language-game | six-hats | <id>
        methodology_l5: master-apprentice | scene-sequel | projective | <id>
        methodology_l6: premortem | pragmatism | socratic | <id>
        category_override: null | <category_id>
        scenes:
          - id: 02-empty-state
            slug: empty-state
            status: empty | draft | approved
```

### `implementation_log`
L6 spec이 `superpowers:writing-plans`로 인계된 이력.

```yaml
implementation_log:
  - chapter: 01-discovery
    scenario: 01-first-encounter
    spec_path: docs/spec/chapters/01-discovery/scenarios/01-first-encounter/spec.md
    handed_off_at: 2026-04-27
    handed_off_to: superpowers:writing-plans
    notes: state 4개·event 7개·entity 3개·acceptance 6개로 인계
```

## 필드 정의 — 세션 상태 (자가 인식 트래커)

매 턴 사용자 발화 직후 + AI 응답 직전에 갱신되는 사용자 인지 모델. SKILL.md `### 매 턴 자가 점검`이 이 필드들을 읽고 쓴다.

### `session_state.vocabulary` — 단어 합의 추적 (큰 신호 #2/#3)

사용자가 새로 발화한 단어/메타포/신조어를 모두 등록한다. AI는 `agreed: false`인 단어를 후속 문장에 *그 단어로* 재사용하지 않는다. 재사용이 필요하면 먼저 `agreed_definition`을 사용자와 합의해 박는다.

```yaml
session_state:
  vocabulary:
    - term: "스탭"                        # 사용자가 발화한 그대로
      first_used_by: user | ai
      first_used_at: 2026-05-01T12:34
      agreed: false | true
      agreed_definition: null | "한 번의 인터뷰 묶음 전체"
      candidate_definitions:              # AI가 합의 시도 시 제시한 후보들
        - "한 번의 LOD 노드 진입"
        - "한 번의 인터뷰 묶음 전체"
        - "직접 입력"
```

### `session_state.meta_isomorphism` — 메타 동형 (큰 신호 #5)

사용자가 만들려는 도구가 *story-spec 자체와 동형*인지 자가 판정. L1 Pixar Pitch 답변에서 감지.

```yaml
session_state:
  meta_isomorphism:
    detected: false | true
    detected_at: null | L1.5 | L2.3       # 어느 단계에서 감지됐는지
    user_app_resembles_this_tool: false | true
    note: null | "사용자 앱이 story-spec과 동형 — '흐릿한 아이디어 구체화 도구'"
    user_acknowledged: false | true       # 사용자가 명시 turn-back에 동의했는지
```

### `session_state.prototype_exists` — prototype 부재 (큰 신호 #6)

사용자가 만드는 도구의 작동 prototype이 존재하는지. 미존재 + 인터뷰가 *없는 것의 미래 행동을 묻고 있는가*가 결합되면 분기 발동.

```yaml
session_state:
  prototype_exists:
    status: false | true | self           # self = 이 세션 자체가 prototype
    note: null | "L4/L5 인터뷰 시 사용자에게 *상상* 강요 금지 신호"
```

### `session_state.big_signals_log` — 큰 신호 발동 이력

큰 신호 4종(`stuck` / `word_unagreed` / `meta_isomorphism` / `prototype_absent`) 중 하나가 detected되어 명시 turn-back이 발동된 모든 사건의 로그.

```yaml
session_state:
  big_signals_log:
    - signal: stuck | word_unagreed | meta_isomorphism | prototype_absent
      at: turn_42                          # 턴 번호 또는 ISO datetime
      term: null | "스탭"                  # word_unagreed일 때
      handled: false | true               # 사용자 응답으로 해소됐는지
      resolution: null | "후보 2개 중 두 번째 선택"
```

### `session_state.silent_state` — 사일런트 신호 3종

큰 신호가 아니지만 응답 톤 조정에 쓰이는 상태. HTML 캔버스의 게이지에만 표시되고 인터뷰 흐름은 끊지 않는다.

```yaml
session_state:
  silent_state:
    tone_preference: unset | plain | metaphor   # #1
    last_reply_depth: short | medium | long     # #8
    vocab_level: layperson | intermediate | expert  # #9
```

## 출력 yaml 템플릿

`docs/spec/manifest.yml` 전체 구조.

```yaml
framework: pixar-pitch+story-circle
category: tool-productivity
updated_at: 2026-05-01

arc:
  pixar_pitch:
    status: empty
    methodology_l1: null
  story_circle:
    status: empty
    methodology_l2: null

chapters: []

implementation_log: []

session_state:
  vocabulary: []
  meta_isomorphism:
    detected: false
    detected_at: null
    user_app_resembles_this_tool: false
    note: null
    user_acknowledged: false
  prototype_exists:
    status: false
    note: null
  big_signals_log: []
  silent_state:
    tone_preference: unset
    last_reply_depth: unset
    vocab_level: unset
```

## init 시점 기본값

manifest.yml을 처음 만들 때 다음 기본값으로 시드:

- `framework`·`category`: 사용자 init 분기 선택값
- `updated_at`: 오늘 날짜
- `arc.*.status`: `empty`
- `arc.*.methodology_l*`: `null` (L1·L2 진입 시 사용자 선택으로 채워짐)
- `chapters`: `[]`
- `implementation_log`: `[]`
- `session_state`: 위 yaml 템플릿 그대로

## AI 행동 룰

### 갱신 시점

1. **매 사용자 발화 직후 + AI 응답 직전** — `session_state` 7개 신호 자가 점검 → 변동 있으면 즉시 갱신. `updated_at`도 함께.
2. **노드 산출물 승인 시점** — 해당 LOD 노드의 `status`·`depth`·`methodology_l*` 갱신. 새 노드는 배열에 push.
3. **L6 spec 인계 시점** — `implementation_log`에 push, 시나리오 `status`를 `implemented`로.

### 큰 신호 발동 시 행동

`big_signals_log`에 새 항목을 push하면 동시에:

- **명시 turn-back 메시지를 생성**해 사용자에게 보여준다 (인터뷰 흐름을 한 번 멈춤).
- **HTML 캔버스가 활성**이면 해당 게이지를 자동 펼침 + 강조 색으로 갱신한다.
- 사용자가 응답으로 해소하면 `handled: true` + `resolution` 채움.

### 사일런트 신호 갱신 시 행동

- `silent_state` 갱신만 — 사용자에게 명시하지 않는다.
- 다음 응답의 톤·옵션 카드 설명·후속 질문 깊이를 이 값에 맞춘다.
- HTML 캔버스가 활성이면 게이지만 조용히 갱신.

### 재방문 시

- 같은 노드 재방문 시 manifest의 `methodology_l*`을 default로 다시 제시.
- `session_state.vocabulary`의 `agreed: true` 단어들은 합의된 정의가 살아있는 것으로 간주, 추가 합의 없이 재사용 가능.
- `meta_isomorphism.user_acknowledged: true`이면 다시 묻지 않는다.

### 마이그레이션

기존 manifest.yml에 `session_state`가 없으면(과거 세션) 첫 읽기 시 위 init 기본값으로 보강해 다시 쓴다. 다른 필드는 건드리지 않는다.
