# story-spec 상태 트래커 + HTML 캔버스 도입 plan

> 근거 retrospective: [`story-spec-session-2026-05-01.md`](./story-spec-session-2026-05-01.md)
> 결정 출처: 2026-05-01 grill 세션 10개 질문
> 적용 대상: `plugins/story-spec/skills/story-spec/`

이 문서는 story-spec prototype을 직접 사용한 결과 발견된 9개 결함을 한 메타 패턴으로 통합 진단하고, 그 처방을 *세션 컨텍스트 자가 인식 트래커 + 일방향 HTML 캔버스* 구조로 응축한 implementation plan이다.

---

## 1. 진단

9개 결함은 모두 **"AI가 사용자의 *지금 상태*를 듣지 않고 자기 페이스로 인터뷰를 던진다"**는 단일 메타 패턴의 발현이다. 룰은 SKILL.md / methodologies / Layer 1 메타 자세에 모두 명시되어 있으나, LLM이 자연스러운 흐름으로 룰을 흘려보내며, 그것을 잡아낼 *세션 컨텍스트 자가 인식 모델*이 SKILL 안에 없다.

특히 메타 동형성: 사용자가 만들려는 도구의 본질이 *흐릿함을 듣고 구체화하는 것*인데, 그 prototype이 사용자의 *상태를 듣지 못하고* 있다. 처방의 본질은 "듣는 도구가 듣는 능력을 갖추게 한다"이다.

---

## 2. 6개 아키텍처 결정 (grill 응축)

| # | 결정 | 요지 |
|---|---|---|
| Q4 | 근본 원인 | 세션 컨텍스트 자가 인식 부재 |
| Q5 | 트래커 가시성 | 평소 사일런트, *큰 신호* 4종일 때만 명시 turn-back |
| Q6 | HTML 모드 내용 | LOD 트리 캔버스 + 토글 트래커 사이드 패널 |
| Q7 | HTML 메커니즘 | 일방향 거울, 매 턴 파일 재쓰기 + auto-reload |
| Q8 | 레이아웃 | L1·L2 서사적(7행 카드 + 원형 다이어그램), L3 이하 일관 카드 그리드, 트래커 우측 280-320px |
| Q9 | 신호 감지 | 계층 하이브리드 — 쉬운 4종 패턴 매칭 + 어려운 3종 LLM 자가 판정 + 지속 상태는 manifest |

**큰 신호 4종 (자동 펼침 + 강조)**: 단어 미합의 / 메타 동형 / prototype 부재 / 막힘
**사일런트 신호 3종 (조용히 조정)**: 톤 선호 / 답변 깊이 / 어휘 수준

---

## 3. 9개 결함 → 결정 흡수 매핑

| 결함 # | 처방 |
|---|---|
| #1 문학적 톤 | 사일런트 어휘 조정 (Q9 패턴 매칭: "쉽게/평이하게" 키워드) |
| #2 단어 슬쩍 확장 | manifest `vocabulary` 추적 + 큰 신호 명시 turn-back |
| #3 정의 떠넘김 | Clean Language 룰 보강: "사용자가 자기 단어 의미 모를 때 AI가 후보 제시" |
| #4 자명한 모호함 분리 질문 | **국지 룰** — 추론 우선 discipline 한 단락 추가 (P1 §6) |
| #5 메타 동형 미탐지 | LLM 자가 판정 + HTML 캔버스 *시각으로* 즉시 보임 |
| #6 prototype 부재 상상 강요 | HTML 캔버스 자체가 *움직이는 prototype* — "상상"을 "이거 보세요"로 치환 |
| #7 막힘 늦은 후보 | 패턴 매칭 즉시 감지 + 직전 발화 재조합 후보 2-3개 |
| #8 압축/풍성 임의 | **국지 작업** — `methodologies/depth-matrix.md` living matrix seed (P2) |
| #9 학술 용어 노출 | 사일런트 어휘 조정 + methodology별 첫 질문 평이화 검증 룰 |

7/9는 아키텍처 결정에 자연 흡수, 2/9(#4·#8)는 별도 국지 작업.

---

## 4. 파일별 변경 — P0 (핵심 아키텍처)

### A. manifest 스키마 확장

**대상**: `plugins/story-spec/skills/story-spec/schemas/manifest.md` (없으면 신설) + 모든 manifest.yml 생성/갱신 코드 경로의 SKILL.md 룰

**추가 필드**:

```yaml
# 기존 필드는 그대로
session_state:
  vocabulary:                    # #2/#3 단어 합의 추적
    - term: "스탭"
      first_used_by: user        # user | ai
      first_used_at: 2026-05-01T12:34
      agreed: false              # true가 되기 전엔 AI가 후속 문장에 재사용 금지
      agreed_definition: null    # agreed=true일 때 문장 1개로 박음
  meta_isomorphism:              # #5
    detected: true
    detected_at: L1.5            # 어느 단계에서 감지됐는지
    user_app_resembles_this_tool: true
    note: "사용자 앱이 story-spec과 동형 — '흐릿한 아이디어 구체화 도구'"
  prototype_exists:              # #6
    status: false                # true | false | self  (self = 이 세션 자체가 prototype)
    note: "L4/L5 인터뷰 시 사용자에게 *상상* 강요 금지 신호"
  big_signals_log:               # 큰 신호 발동 이력
    - signal: stuck
      at: turn_42
      handled: true
    - signal: word_unagreed
      at: turn_47
      term: "스탭"
      handled: true
  silent_state:                  # 사일런트 추적 (HTML 게이지에만 표시)
    tone_preference: plain       # plain | metaphor | unset
    vocab_level: layperson       # layperson | intermediate | expert
    last_reply_depth: short      # short | medium | long
```

**갱신 시점**: 매 턴 사용자 발화 직후 + AI 응답 직전 한 번에. SKILL.md `manifest 운영 룰` 섹션 끝에 신설.

---

### B. SKILL.md "매 턴 자가 점검" 섹션 신설

**대상**: `plugins/story-spec/skills/story-spec/SKILL.md`

**위치**: `## 가장 큰 룰` 안 `### 진행` 다음에 신설.

**내용 골자**:

```markdown
### 매 턴 자가 점검 (큰 신호 4종 + 사일런트 3종)

매 사용자 발화 수신 직후, AI 응답 생성 직전에 다음 7개 신호를 점검한다.
점검 결과는 manifest의 `session_state`에 갱신하고, 그 결과에 따라
응답 톤·후보 제시·turn-back 여부를 조정한다.

#### 큰 신호 4종 (감지 시 명시 turn-back, HTML 트래커 자동 펼침 + 강조)

1. **막힘 신호** — 패턴 매칭으로 우선 감지. 키워드: "음", "흠", "잘 모르겠",
   "뭘 넣으면", "이상한 질문", "그건 너가", 또는 사용자 발화가 1문장 미만인데
   직전 질문이 서술형. 감지 시 즉시 *직전 N턴 발화의 재조합* 후보 2-3개를
   제시 + "직접 입력" 옵션. 후보는 prescription이 아니라 *당신이 이미 한 말의 재조합*임을 명시.

2. **단어 미합의** — 사용자가 새 단어/메타포/신조어를 발화하면 manifest
   `vocabulary`에 `agreed: false`로 등록. AI는 그 단어를 후속 문장에 재사용
   금지. 재사용이 필요하면 먼저 정의를 명시적으로 합의 — 후보 정의 2-3개를
   제시하고 사용자가 고른 것을 `agreed_definition`에 박음 (사용자가 *"그건 너가
   알려줘야지"*라고 정의를 요청해도 AI가 후보를 먼저 낸다 — Clean Language의
   과적용 금지).

3. **메타 동형** — L1 Pixar Pitch 답변에서 사용자가 만드는 도구가 *story-spec
   자체와 동형*인지 자가 판정 (LLM judgment). 동형 신호: 답변에 "인터뷰",
   "spec", "구체화", "흐릿한", "아이디어 구체화", "ideation tool" 류 등장 +
   structure가 본 도구와 닮음. 감지 시 *카테고리 제안 직후 또는 L1 종료 시점*에
   사용자에게 명시: *"제가 보기에 만드시는 도구가 지금 우리가 쓰고 있는
   인터뷰 도구와 결이 비슷합니다. 이 세션 자체를 prototype 사용 경험으로
   다루겠습니다. 동의하시면 `prototype_exists.status: self`로 설정합니다."*

4. **prototype 부재** — `prototype_exists.status: false`이고 인터뷰가 *없는
   것의 미래 사용자 행동을 묻고 있는가*를 매 턴 자가 점검. 대상 단계: L2
   Search·Find·Take, L4 시나리오 카드 "장애물·성공조건", L5 장면. 감지 시
   분기:
     - 메타 동형이 함께 detected이면 *현재 세션 자체*를 사용 경험 데이터로 받는다.
     - 그렇지 않으면 *유사 자매 도구 사용 경험*에서 시행착오를 추출하는 질문으로 변환.

#### 사일런트 신호 3종 (조용히 조정, HTML 게이지에만 반영)

5. **톤 선호** — 패턴 매칭. "쉽게", "평이하게", "문학적", "비유 빼고" 키워드
   감지 시 `silent_state.tone_preference: plain` 박음. 이후 옵션 카드의 한 줄
   설명을 *행동 중심 평이*로 default. 비유는 사용자가 *"비유로 풀어줘"* 신호
   시에만.

6. **답변 깊이** — 사용자 답변 토큰 길이 + 자기수정 마커("..", "근데", "그러니까")
   카운팅. `silent_state.last_reply_depth` 갱신. AI 응답의 후속 질문 깊이를
   거기 맞춤 (짧은 답에 긴 후속 질문 던지지 않음).

7. **어휘 수준** — 사용자가 *"무슨 뜻이야"*, *"그러니까 X야?"* 류 되묻기
   패턴 감지 시 `silent_state.vocab_level: layperson`. 학술 용어 노출 금지.
   methodology별 첫 질문은 항상 평이화 검증을 통과해야 함 (mice-quotient.md
   안의 *"갈등" 같은 학술 용어를 첫 질문에 노출 금지* 안티패턴 룰을 SKILL.md
   본문에 끌어올림).
```

---

### C. Clean Language 룰 보강

**대상**: `plugins/story-spec/skills/story-spec/methodologies/layer1-meta/clean-language.md`

**추가**:

- "사용자 단어를 *그 단어로 후속 문장 짓기 전에 정의를 명시적으로 합의*. 합의 없는 단어 재사용 금지" 룰 신설.
- "사용자가 자기 단어 의미를 모를 때 AI는 *후보를 먼저 제시*하고 사용자가 고른다. 정의 자체를 사용자에게 떠넘기지 않는다" 룰 신설 (#3 처방).
- 위반/준수 예시 각 2개씩 보강. 특히 *"스탭이라는게 모든 과정을 말하는거야?"* 케이스를 위반 예시로 인용.

---

### D. HTML 캔버스 신설

**대상**: 새 디렉토리 `plugins/story-spec/skills/story-spec/canvas/`

**파일 구성**:

```
canvas/
├── README.md                # 캔버스 모드 사용 가이드 (사용자가 어떻게 켜고 보는지)
├── template.html            # 베이스 HTML — 빈 트리 + 빈 트래커 패널 + auto-reload script
├── render-rules.md          # AI가 매 턴 HTML을 어떻게 다시 쓰는지의 룰
└── styles.css               # (선택) 분리된 스타일
```

**`template.html` 골자**:

- 좌측 메인: LOD 트리 캔버스
  - 상단: L1 Pixar Pitch 7행 카드 패널 (서사적 풍부, 빈 칸은 `(TBD)`)
  - 그 아래: L2 Story Circle *원형 8단계 다이어그램* (SVG, 채워진 단계는 색칠, 빈 단계는 회색)
  - 그 아래: L3 챕터 카드 그리드 (가로 흐름, 각 카드에 depth 배지: L3/L4/L5/L6)
  - 카드 클릭 시 우측 디테일 영역에 해당 노드 내용 (L4/L5/L6 내용)
- 우측 사이드 패널 (280-320px): 트래커
  - 평소엔 *접힘* 상태로 7개 게이지만 얇게 표시 (큰 4 + 사일런트 3)
  - 큰 신호 발동 시 해당 게이지가 자동 펼침 + 강조 색 (예: 적색 박스)
  - 게이지 아래엔 1줄 메모 (예: "스탭 — 정의 미합의")
- 하단 footer: 마지막 갱신 시각 + 현재 활성 노드 경로

**auto-reload script**: HTML head에 다음 한 조각 삽입.

```html
<script>
  let lastEtag = null;
  setInterval(async () => {
    const res = await fetch(window.location.href, { method: 'HEAD' });
    const etag = res.headers.get('etag') || res.headers.get('last-modified');
    if (lastEtag && etag !== lastEtag) location.reload();
    lastEtag = etag;
  }, 1000);
</script>
```

(또는 더 단순하게 `<meta http-equiv="refresh" content="2">`. 첫 prototype은 후자로 충분.)

**갱신 위치**: `docs/spec/.canvas/index.html` (사용자 프로젝트 안). manifest와 같은 시점에 AI가 다시 쓴다 — 매 턴 사용자 발화 직후 + AI 응답 직전.

**`render-rules.md` 골자**: AI가 매 턴 HTML을 다시 쓸 때 따르는 룰. *"manifest를 읽어 LOD 트리를 그리고, `session_state`를 읽어 트래커 게이지를 그리고, 큰 신호가 detected이면 해당 게이지를 펼친 상태로 그린다"* 단계 명시.

---

### E. process.md "캔버스 모드" 섹션 신설

**대상**: `plugins/story-spec/skills/story-spec/process.md`

**위치**: `## 1. 세션 시작 흐름` 다음에 새 섹션 `## 1.3. 캔버스 모드` 신설.

**내용**: 사용자가 캔버스 모드를 켜는 방법 (예: `/story-spec --canvas` 또는 *"캔버스 띄워줘"* 발화), AI가 첫 캔버스를 그리고 사용자에게 브라우저로 열어볼 경로를 안내, 매 턴 갱신 시점, 큰 신호 발동 시 트래커가 자동 펼쳐지는 동작.

---

## 5. 파일별 변경 — P1 (국지 룰)

### F. 추론 우선 discipline (#4)

**대상**: `plugins/story-spec/skills/story-spec/SKILL.md`

**위치**: `### 매 턴 자가 점검` 섹션 다음에 한 단락 추가.

**내용**:

```markdown
### 모호한 단어를 만났을 때 — 추론 우선 discipline

사용자 답변 안에 모호한 단어/대명사/지시어를 만나면 다음 3단계를 순서대로 적용한다:

1. **추론 시도** — 직전 N=3턴의 사용자 발화 흐름에서 그 단어의 의미가
   추론되는지 자체 점검.
2. **추론 굳히기** — 추론이 가능하면 짧게 굳혀 보여주고 확인:
   *"여기서 '이 앱'은 [추론된 의미]로 이해했어요. 맞나요?"*
3. **분리 질문** — 위 둘 다 안 풀릴 때만 분리해 다시 묻는다:
   *"이 앱이 [후보 A]인가요, [후보 B]인가요?"*

직전 흐름에서 자명한 모호함을 *분리해 다시 묻는 행동*은 사용자에게
*"AI가 흐름을 듣지 않는다"*는 신호로 작동한다 (#4 결함).
```

---

## 6. 파일별 변경 — P2 (데이터 추가)

### G. MICE 4축 × Story Circle 8단계 깊이 매트릭스 (#8)

**대상**: 새 파일 `plugins/story-spec/skills/story-spec/methodologies/depth-matrix.md`

**내용 골자**:

- 32셀 표 (4축 × 8단계). 각 셀은 권고 깊이: `1문장` / `1-2턴` / `3-5턴` / `5-7턴`.
- 첫 prototype에선 *MICE 4축 각각에 대해 1행씩만* seed로 채우고, 나머지는 *living matrix*로 두며 사용 경험 누적 시 채운다.
- 첫 seed (Inquiry 축):

```
You: 1문장 / Need: 3-5턴 / Go: 1-2턴 / Search: 5-7턴 /
Find: 5-7턴 / Take: 1-2턴 / Return: 1문장 / Change: 1-2턴
```

- AI는 인터뷰 진행 시 이 매트릭스의 권고 깊이에 *맞추되*, 사용자가 더 길게/짧게 가고 싶다고 신호하면 그쪽이 우선.
- 처음부터 32셀 다 채우려 하지 말 것 (#1 문학적 톤과 같은 *과잉 정밀* 결함의 재발 위험).

---

## 7. 파일별 변경 — P3 (회귀 검증)

### H. VERIFY.md에 9개 결함 회귀 시나리오 추가

**대상**: `plugins/story-spec/skills/story-spec/VERIFY.md`

**추가**: 시나리오 9~17 (현재 1~8 다음). 각 시나리오는:
- 입력: 사용자 발화 1줄 (회고에 인용된 그대로 또는 동등 케이스)
- 기대 동작: 트래커가 해당 신호를 detect, manifest에 기록, 큰 신호면 명시 turn-back
- 통과 기준 체크박스
- 위반 시 수정 후보 파일 (P0~P2 어느 항목에 매핑되는지)

**가장 중요한 회귀 케이스** (메타 acceptance criteria):
- *시나리오 17: 같은 사용자가 같은 앱 아이디어("흐릿한 아이디어 구체화 Claude Code 플러그인")로 L1·L2를 다시 돌렸을 때, 9개 결함 중 어느 하나도 재발하지 않거나, 재발 시 트래커가 detect하고 명시 turn-back을 발동시킨다.*

이게 통과되면 *근본 결함*이 처방되었음을 선언할 수 있다.

---

## 8. acceptance criteria

이 plan의 implementation이 끝났다고 선언하기 위한 조건:

1. P0 A~E 모두 구현됨. manifest 스키마에 새 필드 추가, SKILL.md 자가 점검 섹션 신설, Clean Language 룰 보강, HTML 캔버스 디렉토리 생성, process.md 캔버스 모드 섹션 신설.
2. P1 F (추론 우선 discipline) SKILL.md에 추가됨.
3. P2 G (depth-matrix seed) 신설됨, Inquiry 축 한 행만 채워짐.
4. P3 H VERIFY.md 시나리오 9~17 추가됨.
5. 회귀 시나리오 17 통과 — 같은 사용자/같은 앱 아이디어로 L1·L2를 다시 돌렸을 때 9개 결함 미재발 또는 트래커 detect.

---

## 9. 단계 순서

서로 독립적인 묶음 4개로 분리 가능:

| Phase | 작업 | 의존성 | 예상 작업량 |
|---|---|---|---|
| 1 | A (manifest 스키마) + B (SKILL.md 자가 점검) | 없음 | M |
| 2 | C (Clean Language 보강) + F (추론 우선) | Phase 1 | S |
| 3 | D (HTML 캔버스) + E (process.md 캔버스 모드) | Phase 1 | L |
| 4 | G (depth-matrix seed) + H (VERIFY 회귀) | Phase 1-3 | M |

Phase 1이 모든 후속 작업의 *기반*. 먼저 잡고 그 위에 Phase 2-4를 병렬 진행 가능.

---

## 10. 인계

이 plan을 다음 단계로 인계할 때 두 갈래:

- **(a) `to-issues` 스킬로 인계** — Phase 1-4를 vertical slice 이슈 4개로 변환하고 GitHub Project에 등록.
- **(b) `tdd` 스킬로 곧장 진입** — 회귀 시나리오 17을 red-green-refactor의 첫 red로 잡고 Phase 1부터 차례로 green.

선택은 사용자에게 맡긴다. 둘 다 본 plan을 그대로 입력으로 사용 가능.
