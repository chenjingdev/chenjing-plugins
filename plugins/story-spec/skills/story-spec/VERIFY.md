# story-spec 검증 시나리오

이 문서는 story-spec skill이 spec(`docs/superpowers/specs/2026-04-27-story-spec-design.md`)에 명시된 8개 검증 시나리오를 모두 통과하는지 *수동으로* 점검하기 위한 체크리스트다. 각 시나리오는 입력 한 줄, 기대 동작, 관찰 가능한 통과 기준 체크박스, 위반 시 수정 후보 파일 목록으로 이뤄진다. 향후 회귀 테스트의 토대이기도 하다.

## 사용법

1. Claude Code에서 사용자 프로젝트(또는 빈 임시 프로젝트)를 열고 `/story-spec`을 호출한다.
2. 시나리오 1번부터 차례로 돌린다. 각 시나리오의 *입력*을 사용자 발화로 넣고, AI 응답·생성된 파일·`docs/spec/manifest.yml` 변경을 관찰한다.
3. 통과 기준 체크박스를 하나씩 채운다. 모두 채우면 시나리오 통과.
4. 시나리오 간에는 가능하면 `docs/spec/`을 초기화하거나 새 임시 디렉토리에서 시작한다(시나리오 5·8처럼 *세션 간 상태*를 검증하는 시나리오는 예외 — 이전 시나리오의 manifest를 그대로 두고 이어 진행).

## 발견된 버그·모호함 처리 룰

체크박스 중 하나라도 미통과면 그 자리에서 멈추고 다음 룰에 따라 즉시 수정한다.

- AI가 룰을 어긴 경우(예: 한 메시지에 두 질문, 메타포 오염) → `SKILL.md` 또는 해당 Layer 1 메타 자세 파일(`methodologies/layer1-meta/*.md`)을 강화.
- 흐름이 모호한 경우(예: init 분기가 어디서 끝나는지 불분명) → `process.md` 보강.
- 산출물 형식이 어긋난 경우(예: schema 필드가 비어 채워짐) → `schemas/<level>.md` 보강.
- 추천 순위가 spec과 어긋난 경우 → `methodologies/INDEX.md` 또는 `methodologies/category-weights.md` 보강.

수정 후 같은 시나리오를 다시 돌려 통과 기준이 모두 채워지는지 재확인한다. 이 사이클이 곧 회귀 테스트의 단위가 된다.

---

## 시나리오 1: 흐릿한 한 줄 아이디어 → L1 Pixar Pitch 7문장 완성

**입력:** 사용자가 *"독서 습관을 만들어주는 앱을 만들고 싶어"*라고 말한다.

**기대 동작:**

- AI는 `docs/spec/manifest.yml`이 없으므로 init 분기로 진입한다.
- AI는 framework 옵션 4개(Pixar Pitch + Story Circle ⭐ / Kishōtenketsu / Hero's Journey / Custom)를 한 메시지에 한 번에 제시하되, framework 선택은 그 한 질문으로 끝낸다.
- AI는 카테고리 후보(예: `game-habit`)를 1개 *제안*하고 사용자 승인을 받는다. 8개 전체를 강제로 펼치지 않는다.
- AI는 L1 Pixar Pitch 7문장을 한 번에 하나씩 인터뷰한다.
- AI는 7문장이 모두 채워지기 전에 L2(Story Circle)로 넘어가지 않는다.
- AI는 코드를 작성하지 않는다.

**통과 기준 (관찰 가능):**

- [ ] `docs/spec/manifest.yml` 파일이 새로 생성됨
- [ ] manifest의 `framework` 필드가 사용자 선택 값(default 시 `pixar-pitch+story-circle`)으로 채워짐
- [ ] manifest의 `category` 필드가 8개 ID 중 하나로 채워짐(`tool-productivity` / `game-habit` / `social-community` / `b2b-enterprise` / `content-media` / `marketplace-transaction` / `sensitive-regulated` / `mixed`)
- [ ] `docs/spec/arc.md`가 생성되고 Pixar Pitch 7문장이 모두 채워짐 (`(TBD)` 0개)
- [ ] AI 메시지 중 두 가지 질문을 동시에 던진 메시지 0건 (한 메시지 한 질문 룰)
- [ ] 7문장 중 하나라도 비어 있는 상태에서 L2 또는 L3 인터뷰로 넘어간 시도 0건

**관련 파일 (위반 시 수정 후보):**

- `plugins/story-spec/skills/story-spec/SKILL.md` (init 분기, 한 메시지 한 질문 룰)
- `plugins/story-spec/skills/story-spec/process.md` (1.2절 init 흐름, 2절 9단계)
- `plugins/story-spec/skills/story-spec/frameworks/pixar-pitch.md` (7문장 backbone)
- `plugins/story-spec/skills/story-spec/schemas/arc.md` (Pixar Pitch 출력 템플릿)

---

## 시나리오 2: 챕터 3개를 다른 깊이(L3·L4·L6)로 진행 — manifest와 디렉토리 트리 일관

**입력:** 사용자가 시나리오 1에 이어 *"챕터 3개를 만들고 싶어. 하나는 챕터 카드만, 하나는 시나리오 카드까지, 하나는 spec까지 가자"*라고 말하고 차례로 진행한다.

**기대 동작:**

- AI는 사용자에게 어떤 챕터를 어느 깊이까지 갈지 차례로 묻는다(자유 traversal 룰).
- AI는 챕터 1을 L3에서, 챕터 2를 L4에서, 챕터 3을 L6에서 멈춘다(사용자가 더 깊이 가자고 하지 않으면 *제안*만 한다).
- AI는 사용자가 채워달라고 하지 않은 가지를 만들지 않는다(빈 가지 자동 채움 금지).
- AI는 매 노드 승인 시점에 manifest의 해당 필드를 갱신한다.

**통과 기준 (관찰 가능):**

- [ ] manifest의 `chapters` 배열에 3개 항목이 존재하고 각각 `depth` 필드가 `L3`·`L4`·`L6`로 정확히 기록됨
- [ ] 각 챕터의 `status` 필드가 spec의 상태(`draft` / `in_progress` / `approved` 중 적절한 값)와 일관됨
- [ ] `docs/spec/chapters/<id1>/index.md`(L3 챕터 카드만 존재), `docs/spec/chapters/<id2>/scenarios/<sid>/card.md`(L4까지), `docs/spec/chapters/<id3>/scenarios/<sid>/spec.md`(L6까지)가 각각 생성됨
- [ ] L3로 멈춘 챕터의 디렉토리에 `scenarios/`가 비어 있거나 존재하지 않음 (자동 채움 0건)
- [ ] manifest의 `updated_at` 필드가 매 챕터 승인 시 갱신됨

**관련 파일 (위반 시 수정 후보):**

- `plugins/story-spec/skills/story-spec/SKILL.md` ("사용자가 채워달라고 하지 않은 가지는 만들지 않는다" 룰)
- `plugins/story-spec/skills/story-spec/process.md` (2.7 사용자 승인 시 manifest 갱신, 3절 LOD 진입 패턴)
- `plugins/story-spec/skills/story-spec/schemas/chapter.md` / `scenario.md` / `spec.md` (출력 템플릿)

---

## 시나리오 3: 의존하는 챕터의 선행이 비어 있을 때 가이드 톤

**입력:** 사용자가 *"02-onboarding 챕터의 spec(L6)으로 가자"*라고 말한다. 단, manifest에서 `02-onboarding`은 `01-discovery`에 의존(`depends_on: [01-discovery]`)하고, `01-discovery`의 시나리오 카드(L4)가 비어 있다.

**기대 동작:**

- AI는 사용자를 *강제 차단하지 않는다*. "선행이 비었으니 안 됩니다"라고 거절하지 않는다.
- AI는 가이드 톤으로 위험을 설명하고 옵션을 제시한다.
- AI는 사용자가 그대로 진행을 선택하면 그대로 진행한다(차단 없음).

**통과 기준 (관찰 가능):**

- [ ] AI 응답에 *"선행"·"의존"·"권장"·"이대로 진행"* 또는 동등한 표현이 포함됨 (가이드 톤 신호)
- [ ] AI 응답에 사용자 선택지가 최소 2개 이상 포함됨 (선행 먼저 / 이대로 진행 / 다른 가지)
- [ ] AI 응답에 *"안 됩니다"·"불가능"·"먼저 채워야"·"진행할 수 없습니다"* 같은 강제 차단 표현 0건
- [ ] 사용자가 *"이대로 진행"*을 선택하면 AI가 02-onboarding의 L6 인터뷰로 들어감 (차단 0건)

**관련 파일 (위반 시 수정 후보):**

- `plugins/story-spec/skills/story-spec/SKILL.md` (의존성 가드 섹션, "강제 차단하지 않는다" 룰)
- `plugins/story-spec/skills/story-spec/process.md` (4절 의존성 가드 동작, 출력 예시)

---

## 시나리오 4: L6 도달 후 명시 승인 시 writing-plans 인계

**입력:** 사용자가 L6 spec이 채워진 시나리오에 대해 *"이 시나리오 spec으로 구현해줘"*라고 명시 승인한다.

**기대 동작:**

- AI는 인계 직전 spec 4섹션(state model · event flow · data model · acceptance criteria)을 한 번 요약 확인한다.
- AI는 사용자 재승인을 받은 뒤 superpowers의 `writing-plans` skill을 호출한다.
- AI는 자기 손으로 코드를 작성하지 않는다.
- AI는 manifest의 `implementation_log` 배열에 인계 기록을 남긴다.
- AI는 해당 시나리오 노드의 `status`를 `approved`에서 `implemented`로 갱신한다.

**통과 기준 (관찰 가능):**

- [ ] AI가 인계 직전에 spec 4섹션 요약을 한 번 보여줌
- [ ] AI 응답에 *"superpowers:writing-plans"* 또는 *"writing-plans skill로 인계"*라는 표현이 포함됨
- [ ] manifest의 `implementation_log` 배열에 새 항목이 push되고 `chapter`·`scenario`·`handed_off_at`·`handed_off_to: superpowers:writing-plans` 필드가 채워짐
- [ ] 해당 시나리오 노드의 manifest `status`가 `implemented`로 갱신됨
- [ ] AI가 자기 손으로 코드 파일(.ts/.py/.js 등)을 작성한 흔적 0건

**관련 파일 (위반 시 수정 후보):**

- `plugins/story-spec/skills/story-spec/SKILL.md` (인계 섹션, "코드는 그 다음 단계의 일이다" 룰)
- `plugins/story-spec/skills/story-spec/process.md` (6절 L6 도달 후 writing-plans 인계 패턴)

---

## 시나리오 5: 두 번째 인터뷰 세션에서 manifest만 읽고 위치·다음 가지·이전 방법론 정확히 파악

**입력:** 시나리오 1·2를 마친 뒤 Claude Code 세션을 종료하고 새 세션에서 다시 `/story-spec`을 호출한다. 사용자는 추가 컨텍스트를 주지 않는다.

**기대 동작:**

- AI의 첫 행동은 `docs/spec/manifest.yml` 읽기다.
- AI는 챕터 트리를 표 형식으로 요약 출력한다(챕터 ID·depth·status·의존).
- AI는 추천 다음 가지(⭐)를 1개 이상 제시한다.
- AI는 같은 노드를 재방문할 때 manifest의 `methodology_l*` 값을 default로 다시 제시한다.

**통과 기준 (관찰 가능):**

- [ ] AI의 첫 액션이 manifest 파일 Read이고, 그 결과를 사용자에게 한 단락 또는 표로 요약함
- [ ] AI 요약에 시나리오 2에서 만든 챕터 3개의 ID·depth(L3/L4/L6)가 정확히 기록됨
- [ ] AI 요약에 "다음 가지" 옵션이 최소 2개 이상 제시되고, 그 중 하나에 ⭐ 표시가 있음
- [ ] 사용자가 시나리오 2에서 진행했던 노드를 재방문하면 AI가 *"전에 이 노드에서 [방법론]으로 진행했네요. 이어서 갈까요?"* 또는 동등한 표현으로 default를 제시함
- [ ] 사용자가 명시하지 않은 추가 정보(framework·category 등)를 AI가 다시 묻지 않음

**관련 파일 (위반 시 수정 후보):**

- `plugins/story-spec/skills/story-spec/SKILL.md` (manifest.yml 운영 룰, "매 인터뷰의 첫 행동은 manifest 읽기")
- `plugins/story-spec/skills/story-spec/process.md` (1.1절 트리 요약 출력, 2.4절 방법론 default 제시)

---

## 시나리오 6: Clean Language 룰 — 사용자 메타포 오염 금지

**입력:** 사용자가 *"이 앱은 비서 같은 앱이야"*라고 말한 뒤, AI가 후속 질문을 던지고 사용자가 한 번 더 답한다.

**기대 동작:**

- AI는 사용자가 쓴 단어 "비서"를 그대로 사용한다.
- AI는 "도우미"·"파트너"·"어시스턴트"·"매니저"·"컨시어지" 등 동의어로 바꿔치지 않는다.
- AI의 후속 질문은 "비서"의 종류·위치·전후·맥락만 캐묻는다(예: *"어떤 종류의 비서인가요?"* / *"이 비서는 사용자 옆 어디에 있어요?"* / *"이 비서가 등장하기 직전에는 무엇이 있었나요?"*).
- AI는 자기 비유를 끼워넣지 않는다(예: *"마치 그림자처럼…"*은 위반).

**통과 기준 (관찰 가능):**

- [ ] AI 응답 텍스트에 "비서"라는 단어가 1회 이상 등장함
- [ ] AI 응답 텍스트에 "도우미"·"파트너"·"어시스턴트"·"매니저"·"컨시어지" 같은 동의어 등장 0건
- [ ] AI가 사용자가 쓰지 않은 새 비유(예: *"마치 ___처럼"*, *"___이라는 메타포로 보면"*)를 끼워넣은 경우 0건
- [ ] AI의 후속 질문이 "비서"의 속성·위치·전후 중 하나를 캐묻는 형태임 (Clean Language 9 questions 패턴)

**관련 파일 (위반 시 수정 후보):**

- `plugins/story-spec/skills/story-spec/SKILL.md` (Layer 1 메타 자세, Clean Language 강제 룰)
- `plugins/story-spec/skills/story-spec/methodologies/layer1-meta/clean-language.md` (좋은 적용/위반 예시 보강)

---

## 시나리오 7: 카테고리 가중치 — 같은 L4에서 카테고리에 따라 1순위 다름

**입력:** 같은 L4 시나리오 카드 진입을 두 번 시뮬레이션한다.

- 7-A. manifest의 `category`가 `tool-productivity`인 상태에서 L4 진입.
- 7-B. manifest의 `category`가 `game-habit`인 상태에서 L4 진입(다른 임시 프로젝트 또는 manifest를 수정한 뒤 재진입).

**기대 동작:**

- 7-A에서 AI는 L4 방법론 선택 화면의 1순위(⭐)로 *Mom Test*를 추천한다.
- 7-B에서 AI는 L4 방법론 선택 화면의 1순위(⭐)로 *Laddering*을 추천한다.
- 두 경우 모두 1-3순위 + "직접 입력" 4개 옵션을 제시한다.

**통과 기준 (관찰 가능):**

- [ ] 7-A의 AI 응답에 *"Mom Test ⭐"* 또는 *"Mom Test (추천"*이 1순위로 표기됨
- [ ] 7-B의 AI 응답에 *"Laddering ⭐"* 또는 *"Laddering (추천"*이 1순위로 표기됨
- [ ] 두 응답 모두 1-3순위 + "직접 입력" 4개 옵션 형식을 따름
- [ ] 7-A에서 Laddering이 1순위로 등장하지 않음 (역전 없음)
- [ ] 7-B에서 Mom Test가 1순위로 등장하지 않음 (역전 없음)

**관련 파일 (위반 시 수정 후보):**

- `plugins/story-spec/skills/story-spec/methodologies/INDEX.md` (LOD별 1-3순위 디폴트)
- `plugins/story-spec/skills/story-spec/methodologies/category-weights.md` (카테고리별 boost/penalty 표)
- `plugins/story-spec/skills/story-spec/process.md` (3.4절 L4 진입 패턴, 카테고리에 따른 추천 변동 예시)

---

## 시나리오 8: 노드별 방법론 기록 — 시나리오 A→B→A 재방문 시 default 복원

**입력:**

1. 사용자가 시나리오 A(예: `01-first-encounter`)의 L4 진입에서 *Laddering*을 선택해 시나리오 카드를 채우고 승인한다.
2. 사용자가 시나리오 B(예: `02-empty-state`)로 이동해 L4를 *Language Game*으로 진행한다.
3. 사용자가 다시 시나리오 A로 돌아와 L4를 재방문한다(예: 같은 카드를 보강하거나 사용자가 *"여기 한 번 더"*라고 요청).

**기대 동작:**

- 1단계 직후 manifest의 시나리오 A 항목에 `methodology_l4: laddering`이 기록된다.
- 2단계 직후 manifest의 시나리오 B 항목에 `methodology_l4: language-game`이 기록되고, A의 기록은 그대로 유지된다.
- 3단계에서 AI가 시나리오 A의 L4 진입 시 *"전에 이 노드에서 Laddering으로 진행했네요. 이어서 갈까요, 아니면 다른 방법으로?"* 형태로 Laddering을 default로 다시 제시한다.

**통과 기준 (관찰 가능):**

- [ ] 1단계 후 manifest의 시나리오 A 항목에 `methodology_l4: laddering` 필드가 정확히 기록됨
- [ ] 2단계 후 manifest의 시나리오 B 항목에 `methodology_l4: language-game` 필드가 기록되고, A의 `methodology_l4: laddering`이 보존됨
- [ ] 3단계에서 AI 응답이 Laddering을 default로 제시함 (응답 텍스트에 "Laddering"이 default 옵션 또는 "이어서" 표현과 함께 등장)
- [ ] 3단계에서 AI가 카테고리 가중치 기반의 새 1-3순위 표를 처음부터 제시하지 않음 (재방문 시 default 우선 룰)

**관련 파일 (위반 시 수정 후보):**

- `plugins/story-spec/skills/story-spec/SKILL.md` (manifest.yml 운영 룰, "같은 노드를 재방문하면 default 다시 제시")
- `plugins/story-spec/skills/story-spec/process.md` (2.4절 방법론 선택, 재방문 분기)
- `plugins/story-spec/skills/story-spec/methodologies/INDEX.md` (default 복원 우선순위 명시 여부 점검)

---

## 검증 완료 조건

8개 시나리오 모두에서 모든 통과 기준 체크박스가 채워지면 story-spec skill의 1차 검증 완료. 한 시나리오라도 미통과 항목이 남아 있으면 위 "발견된 버그·모호함 처리 룰"을 따라 관련 파일을 수정한 뒤 그 시나리오를 다시 돌린다.

이 문서는 살아있는 회귀 테스트 체크리스트다. skill 콘텐츠가 바뀔 때마다 8개 시나리오를 다시 한 바퀴 돌려 통과 여부를 재확인한다.
