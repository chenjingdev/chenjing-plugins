# 카테고리 가중치 표

## 목적

같은 LOD여도 앱 성격에 따라 어울리는 방법론은 달라진다. 예를 들어 *도구·생산성*에서는 L4의 1순위가 Mom Test로 끌려가고, *게임·습관*에서는 Laddering이 더 강해진다. 이 파일은 8개 앱 카테고리 × 17개 Layer 2 방법론의 가중치를 정의해, LOD 디폴트 1-3순위(`INDEX.md` 참조)를 동적으로 재정렬한다. 가중치는 운영 중 튜닝되는 값이므로 spec 본문이 아니라 이 파일에 위임된다.

---

## 8개 카테고리 정의

| ID | 이름 | 한 줄 설명 | 대표 예시 |
|---|---|---|---|
| `tool-productivity` | 도구·생산성 | 사용자의 작업 효율을 직접 끌어올리는 도구 | Notion · Linear · Todoist |
| `game-habit` | 게임·습관 형성 | 큰 변화 서사·반복 동기를 다루는 앱 | Duolingo · Strava · Forest |
| `social-community` | 소셜·커뮤니티 | 다른 사람과의 관계·공유가 핵심 | Discord · Threads · BeReal |
| `b2b-enterprise` | B2B·엔터프라이즈 | 조직 도입·검증 압력이 강한 영역 | Salesforce · Confluence · Linear B2B |
| `content-media` | 콘텐츠·미디어 | 발견·취향 학습·몰입이 핵심 | Spotify · Pinterest · Netflix |
| `marketplace-transaction` | 거래·마켓플레이스 | 매칭·결제·신뢰가 핵심 | 배민 · 쿠팡 · 당근 |
| `sensitive-regulated` | 민감 정보·규제 | 헬스케어·금융·미성년 등 실패 비용이 큰 영역 | 헬스케어 앱 · 금융 앱 · 청소년 대상 서비스 |
| `mixed` | 혼합·기타 | 정의가 모호하거나 다축인 경우 | (가중치 없음, LOD 디폴트 그대로) |

---

## 가중치 표

각 셀의 의미:
- `+1` boost — 이 카테고리에서 추천 점수에 +1
- `0` neutral — 영향 없음
- `-1` penalty — 추천 점수에서 -1

`mixed` 카테고리는 모든 셀이 `0`이므로 표에서 생략한다.

| 방법론 | tool-productivity | game-habit | social-community | b2b-enterprise | content-media | marketplace-transaction | sensitive-regulated |
|---|---|---|---|---|---|---|---|
| Miracle Question      | -1 | +1 |  0 |  0 |  0 |  0 |  0 |
| JTBD Switch           |  0 |  0 |  0 | +1 |  0 |  0 |  0 |
| Mom Test              | +1 | -1 |  0 | +1 | -1 | +1 |  0 |
| MICE Quotient         |  0 |  0 | +1 |  0 |  0 |  0 |  0 |
| Tetralemma            |  0 |  0 |  0 |  0 |  0 | -1 |  0 |
| Socratic              |  0 |  0 |  0 |  0 |  0 |  0 |  0 |
| Toyota Kata           | +1 |  0 |  0 |  0 |  0 |  0 |  0 |
| Counterfactual        |  0 |  0 |  0 |  0 |  0 |  0 | +1 |
| Mental Model          |  0 |  0 | +1 |  0 |  0 |  0 |  0 |
| Laddering             |  0 | +1 |  0 |  0 | +1 |  0 |  0 |
| Language Game         |  0 |  0 |  0 |  0 |  0 |  0 |  0 |
| Six Hats              |  0 |  0 |  0 | +1 |  0 | +1 |  0 |
| Master/Apprentice     | +1 |  0 |  0 |  0 | +1 |  0 |  0 |
| Scene-Sequel          |  0 |  0 |  0 |  0 |  0 | +1 |  0 |
| Projective            | -1 |  0 | +1 | -1 | +1 |  0 |  0 |
| Pragmatism            | +1 |  0 |  0 |  0 |  0 |  0 |  0 |
| Premortem             |  0 |  0 | -1 | +1 | -1 |  0 | +1 |

---

## 추천 알고리즘

매 LOD 진입 시 다음 순서로 사용자에게 보여줄 1-3순위를 계산한다.

1. 해당 LOD의 디폴트 1-3순위(`INDEX.md`의 LOD별 디폴트 표)에 시드 점수를 부여한다. **1순위 = 3점, 2순위 = 2점, 3순위 = 1점**, 그 외 방법론은 **0점**으로 시작한다.
2. manifest의 `category` 필드로 위 가중치 표의 해당 열을 찾아 모든 방법론에 `+1` / `0` / `-1`을 가산한다. 해당 LOD에서 사용자가 임시로 카테고리를 override한 경우(예: *"이 챕터만 sensitive-regulated 가중치로 봐줘"*) override된 카테고리 열을 사용한다.
3. 합산 점수 상위 3개를 사용자에게 1-3순위로 제시한다. 1순위에 ⭐. 각 항목에 한 줄 이유를 덧붙인다.
4. **동점 처리:** 합산 점수가 같으면 LOD 디폴트 순위가 더 앞이었던 방법론을 우선한다. 그래도 동점이면 `INDEX.md`의 표 등장 순서(즉 LOD 디폴트 표의 1→2→3순위, 그 외에는 위 가중치 표의 등장 순서)로 결정한다.
5. `category`가 `mixed`이면 2단계의 가중치 가산을 건너뛰고 LOD 디폴트 1-3순위를 그대로 제시한다.

이 알고리즘은 결정론적이라 같은 manifest 상태에서 같은 1-3순위가 재현된다. 사용자가 같은 노드를 재방문하면 manifest의 `methodology_l*` 값이 default로 우선 제시되고, 본 알고리즘 결과는 사용자가 *"다른 방법으로"* 요청할 때 대안으로 보여진다.

---

## 카테고리별 boost / penalty 요약

가중치 표의 의도를 자연어로 정리한다. 일부 항목은 Layer 2 방법론이 아니라 framework(예: Hero's Journey)이거나 Layer 1 메타 자세(예: Yes-And)이므로 가중치 표에는 들어가지 않고 운영 메모 형태로만 남긴다.

### `tool-productivity` — 도구·생산성

- **Boost:** Mom Test · Master/Apprentice · Toyota Kata · Pragmatism
- **Penalty:** Miracle Question · Projective
- **Framework 권고(가중치 표 외):** Hero's Journey 비추천 — 큰 변화 서사가 도구 맥락과 어긋남.

### `game-habit` — 게임·습관 형성

- **Boost:** Laddering · Miracle Question
- **Penalty:** Mom Test (검증형 봉쇄 톤이 동기 탐색을 깎음)
- **Framework 권고:** Hero's Journey 추천.

### `social-community` — 소셜·커뮤니티

- **Boost:** Mental Model · Projective · MICE Quotient (Character 축 활용)
- **Penalty:** Premortem (조기 부정이 커뮤니티 정서 탐색을 막음)
- **운영 메모:** "First Principles" 식 제일원리 환원도 약함 — 본 도구의 Layer 2 풀에는 없음.

### `b2b-enterprise` — B2B·엔터프라이즈

- **Boost:** Mom Test · Premortem · JTBD Switch · Six Hats (검정모자 검증)
- **Penalty:** Projective (조직 도입 맥락에서 우회 투사가 약함)
- **운영 메모:** IFS 부분질문 사용 자제 — 본 도구는 IFS 전체 프로토콜을 채택하지 않음.

### `content-media` — 콘텐츠·미디어

- **Boost:** Projective · Master/Apprentice · Laddering
- **Penalty:** Premortem · Mom Test (취향·몰입 탐색을 검증 톤이 깎음)
- **운영 메모:** "Diary Reflective" 일지 회고도 잘 어울리지만 본 도구의 Layer 2 풀에는 없음 — Master/Apprentice의 변형으로 활용.

### `marketplace-transaction` — 거래·마켓플레이스

- **Boost:** Six Hats (검정모자) · Scene-Sequel · Mom Test
- **Penalty:** Tetralemma (사구분별의 추상도가 거래 결정 맥락과 어긋남)

### `sensitive-regulated` — 민감 정보·규제

- **Boost:** Premortem · Counterfactual
- **Penalty:** (가중치 표 외) Layer 1의 Yes-And를 *무비판형*으로 운영하지 않는다 — 인정+확장은 유지하되 위험 신호를 침묵으로 동의하지 않는다.
- **운영 메모:** L6 한정 Paul-Elder 8 elements를 부분 차용 가능(spec 본문). 본 도구의 Layer 2 풀에는 없음.

### `mixed` — 혼합·기타

가중치 없음. LOD 디폴트 1-3순위를 그대로 제시한다. 사용자가 진행 중 카테고리가 명확해지면 manifest의 `category`를 갱신해 다음 LOD부터 가중치를 적용한다.
