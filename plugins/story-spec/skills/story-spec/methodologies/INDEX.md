# 방법론 INDEX

story-spec의 인터뷰 방법론은 두 층으로 운영된다.

- **Layer 1 메타 자세** — 전 단계 상시 적용. 사용자에게 선택 옵션으로 노출하지 않는다.
- **Layer 2 전문 도구** — 매 LOD 진입 시 사용자에게 1-3순위 + "직접 입력"으로 제시한다. 1순위에 ⭐ 표시.

LOD별 추천 1-3순위는 카테고리 가중치(`category-weights.md`)에 의해 동적 조정된다.

---

## Layer 1 메타 자세 (5개)

전 단계에서 항상 적용된다. AI는 사용자에게 옵션으로 묻지 않는다.

| 방법론 | 한 줄 정의 | 파일 |
|---|---|---|
| Clean Language | 사용자의 메타포·단어를 그대로 사용한다. 인터뷰어가 다른 비유나 동의어로 바꿔치지 않는다. | [`layer1-meta/clean-language.md`](./layer1-meta/clean-language.md) |
| OARS | Open · Affirm · Reflect · Summarize. 사용자 발화를 살짝 다르게 되돌려 자기 정정을 유도한다. | [`layer1-meta/oars.md`](./layer1-meta/oars.md) |
| Yes-And | Improv 규칙. 사용자 발화를 부정하지 않고 인정 후 덧붙인다. | [`layer1-meta/yes-and.md`](./layer1-meta/yes-and.md) |
| Bloom 게이지 | 사용자 답이 어느 인지 층위(기억·이해·적용·분석·평가·창조)에 있는지 진단해 다음 질문 층위를 조정한다. | [`layer1-meta/bloom-gauge.md`](./layer1-meta/bloom-gauge.md) |
| System 1/2 이중 캡처 | "처음 떠오른 답"과 "30초 정교화"를 둘 다 묻고 산출물에 함께 기록한다. | [`layer1-meta/system-1-2.md`](./layer1-meta/system-1-2.md) |

---

## Layer 2 전문 도구 (17개)

매 LOD 진입 시 사용자가 선택한다. 1순위에는 ⭐, 2-3순위는 카테고리 가중치에 따라 보정된다.

| 방법론 | 한 줄 정의 | 어울리는 LOD | 출처 | 파일 |
|---|---|---|---|---|
| Miracle Question | "기적이 일어나 다 해결됐다, 내일 처음 무엇으로 알아채요?" 미래 상태를 체험적으로 끌어낸다. | L1 | Solution-Focused Brief Therapy (de Shazer) | [`layer2-tools/miracle-question.md`](./layer2-tools/miracle-question.md) |
| JTBD Switch | "마지막으로 그 문제가 일어났던 순간"·"현재 방식을 *해고*하려면" 같은 전환 인터뷰. | L1 | Bob Moesta · Clay Christensen | [`layer2-tools/jtbd-switch.md`](./layer2-tools/jtbd-switch.md) |
| Mom Test | 가정형·일반론을 봉쇄하고 과거 행동·자원 지출만 묻는다. | L1 검증 · L4 | Rob Fitzpatrick | [`layer2-tools/mom-test.md`](./layer2-tools/mom-test.md) |
| MICE Quotient | Milieu·Inquiry·Character·Event 4축으로 사용자 여정을 분류한다. | L2 | Orson Scott Card | [`layer2-tools/mice-quotient.md`](./layer2-tools/mice-quotient.md) |
| Tetralemma | 사구분별. A다 / A 아니다 / 둘 다 / 둘 다 아니다로 강제 펼침. | L2 | 불교 논리학 (Nāgārjuna) | [`layer2-tools/tetralemma.md`](./layer2-tools/tetralemma.md) |
| Socratic | 명료화·가정 검토·근거·반대·함의·메타 6패턴의 산파술. | L2 · L4 · L6 보조 | 플라톤 | [`layer2-tools/socratic.md`](./layer2-tools/socratic.md) |
| Toyota Kata | Improvement Kata 4질문(목표 상태·현재 상태·다음 장애물·다음 실험). | L3 | Mike Rother | [`layer2-tools/toyota-kata.md`](./layer2-tools/toyota-kata.md) |
| Counterfactual | "이 챕터/기능 *없이* 같은 일을 하려면?" 가능성 공간을 펼친다. | L3 · L5 보조 | 반사실 추론 (Lewis · Pearl) | [`layer2-tools/counterfactual.md`](./layer2-tools/counterfactual.md) |
| Mental Model | 평가하지 않고 "그 일을 하던 중 마음속에서 무엇이?"를 듣는다. | L3 | Indi Young | [`layer2-tools/mental-model.md`](./layer2-tools/mental-model.md) |
| Laddering | 수단-목적 사슬. "이게 왜 중요해요?" × 5단으로 표면 동기를 정체성 가치까지 올린다. | L4 | Means-End Theory (Reynolds·Gutman) | [`layer2-tools/laddering.md`](./layer2-tools/laddering.md) |
| Language Game | 정의가 아닌 *용례*를 수집한다. 모호한 형용사("간편한", "스마트한")를 정밀화한다. | L4 | Wittgenstein | [`layer2-tools/language-game.md`](./layer2-tools/language-game.md) |
| Six Hats | 흰·빨강·검정·노랑·초록·파랑 6관점으로 같은 시나리오를 점검. | L4 | de Bono | [`layer2-tools/six-hats.md`](./layer2-tools/six-hats.md) |
| Master/Apprentice | "제가 견습생이라 치고 처음부터 끝까지 보여주세요." 맥락 안 행동을 본다. | L5 | Contextual Inquiry (Beyer·Holtzblatt) | [`layer2-tools/master-apprentice.md`](./layer2-tools/master-apprentice.md) |
| Scene-Sequel | 장면(목표-갈등-결말) + 후속(반응-딜레마-결정) 쌍으로 분해. | L5 | Dwight Swain | [`layer2-tools/scene-sequel.md`](./layer2-tools/scene-sequel.md) |
| Projective | "이 앱이 사람이라면? 친구에게 추천 문자 한 통이라면?" 우회 투사. | L5 | 투사 기법 (광고·임상심리) | [`layer2-tools/projective.md`](./layer2-tools/projective.md) |
| Pragmatism | "이게 참이라면 *어떤 차이*가 발생하나?" 추상 비전을 관찰 가능한 차이로. | L1 끝 · L4 success · L6 | William James | [`layer2-tools/pragmatism.md`](./layer2-tools/pragmatism.md) |
| Premortem | "1년 뒤 망했다 가정. 무엇 때문이었나?" 사후 부검을 미리. | L1 끝 · L4 장애물 · L6 | Gary Klein | [`layer2-tools/premortem.md`](./layer2-tools/premortem.md) |

---

## LOD별 디폴트 1-3순위

카테고리가 `mixed`거나 가중치 적용 후에도 동점일 때 이 표가 디폴트다.

| LOD | 1순위 ⭐ | 2순위 | 3순위 |
|---|---|---|---|
| **L1 시작과 끝** | Miracle Question | JTBD Switch | Mom Test |
| **L2 큰 서사** | MICE Quotient | Tetralemma | Socratic |
| **L3 챕터** | Toyota Kata | Counterfactual | Mental Model |
| **L4 시나리오 카드** | Laddering | Language Game | Six Hats |
| **L5 장면** | Master/Apprentice | Scene-Sequel | Projective |
| **L6 codespeak spec** | Pragmatism | Premortem | Socratic |

---

## 사용자에게 보여주는 선택지 형식

매 LOD 진입 시 AI는 다음과 같은 형식으로 사용자에게 선택지를 제시한다. 1순위에 ⭐, 각 항목에 한 줄 이유, 마지막에 "직접 입력 / 다른 방법 설명 요청" 옵션을 포함한다.

**예시 — L4 시나리오 카드 진입 시 (카테고리: `game-habit`):**

```
[L4 시나리오 카드] 어떤 사고법으로 갈까요?
  1) Laddering ⭐ (추천 — 표면 동기를 정체성 가치까지 끌어올립니다)
  2) Language Game (모호한 형용사 정밀화)
  3) Six Hats (시나리오를 6가지 관점으로 점검)
  4) 직접 입력 / 다른 방법 설명 요청
```

같은 노드를 재방문하면 manifest의 `methodology_l*` 값을 default로 다시 제시한다(사용자는 변경 가능). 사용자가 막혀 *"다른 방법으로"* 요청할 때만 전환하며, AI가 자기 판단으로 멋대로 전환하지 않는다.
