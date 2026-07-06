# tiers

멀티에이전트 오케스트레이션에서 **하위 에이전트가 비싼 세션 모델을 상속하는 것을 막는** 플러그인.
Fable 같은 상위 모델로 세션을 돌리더라도, fan-out되는 수십~수백 개의 서브에이전트는 내가 고정한 티어(모델/effort)로만 실행된다. 토큰의 90% 이상은 서브에이전트가 소비하므로, 이 고정만으로 실행 비용이 사실상 워커 티어 가격으로 내려간다.

## 설치

```
/plugin marketplace add chenjingdev/chenjing-plugins
/plugin install tiers@chenjing-plugins
```

## 커맨드

### /tiers:ultracode — 티어 고정 울트라코드

울트라코드와 동일한 오케스트레이션(패턴·스케일링 전부)을 하되, **모든** 에이전트를 저장된 단일 티어로 실행한다. 역할별 차등 없음 — 균일함이 기능이다.

```
/tiers:ultracode 이 diff 리뷰해줘                → 저장된 티어로 즉시 실행
/tiers:ultracode sonnet low quick sanity check   → 이번만 sonnet/low (선행 토큰 오버라이드)
/tiers:ultracode setup                           → 기본 티어 변경 (기본값: opus/xhigh)
```

### /tiers:deep-research — 티어 고정 딥리서치

고정 파이프라인(Scope → Search → Fetch → 3표 적대 검증 → Synthesize, 최대 ~97 에이전트)을 번들 engine.js로 실행한다. 자리별 티어 3종:

| 자리 | 담당 | 기본값 |
|---|---|---|
| worker | 검색·수집 (5+15) | opus/high |
| judge | 검증 투표관 (~75) | opus |
| brain | scope+synthesize (2) | inherit (세션 모델) — 단 2회 호출이라 상위 모델을 써도 사실상 공짜 |

```
/tiers:deep-research 2026년 로컬 LLM 추론 스택 비교
/tiers:deep-research judge=sonnet 가볍게 훑어줘    → 이번만 judge 교체 (model=/effort=/brain= 동일)
/tiers:deep-research setup                        → 기본 티어 변경
```

## 설정 저장 위치

`setup`으로 저장한 티어는 플러그인 데이터 디렉토리(`${CLAUDE_PLUGIN_DATA}`)에 저장되어 플러그인 업데이트에도 유지된다.
