# tiers

멀티에이전트 오케스트레이션의 실행 티어를 사용자가 결정하는 플러그인.

Claude Code의 Workflow 오케스트레이션에서 서브에이전트는 기본적으로 세션 모델을 상속한다. 상위 티어 모델로 세션을 운용하고 있다면 fan-out되는 수십~수백 개의 에이전트가 전부 같은 단가로 실행된다는 뜻이고, 전체 토큰 소비의 대부분은 메인 세션이 아니라 이 서브에이전트들의 몫이다.

tiers는 이 상속을 끊는다. 판단·설계·종합 같은 오케스트레이션은 세션 모델이 그대로 담당하고, 실행을 맡는 서브에이전트는 미리 지정한 티어(model × effort)로만 생성된다. 세션의 지능은 유지하면서 실행 비용은 지정한 티어의 단가로 수렴시키는 구조다.

## 설치

```
/plugin marketplace add chenjingdev/chenjing-plugins
/plugin install tiers@chenjing-plugins
```

## /tiers:ultracode

ultracode(Claude Code의 멀티에이전트 오케스트레이션 모드)와 동일한 오케스트레이션 — 같은 품질 패턴, 같은 스케일링 — 을 수행하되, 모든 에이전트를 단일 고정 티어로 실행한다. 역할별 차등은 두지 않는다. 균일함이 곧 계약이며, 모델이 임의로 단계별 티어를 조정하는 것 자체를 배제한다.

```
/tiers:ultracode 이 diff 리뷰해줘                → 저장된 티어로 즉시 실행
/tiers:ultracode sonnet low quick sanity check   → 이번 한 번만 sonnet/low
/tiers:ultracode setup                           → 기본 티어 변경
```

기본 티어: `opus / xhigh`

## /tiers:deep-research

Scope → Search → Fetch → Verify(주장별 3표 적대 검증) → Synthesize로 이어지는 고정 파이프라인(최대 약 97 에이전트)을 번들 엔진으로 실행한다. 파이프라인의 세 자리에 서로 다른 티어를 배정할 수 있다.

| 자리 | 역할 | 호출 규모 | 기본값 |
|---|---|---|---|
| worker | 검색·수집·주장 추출 | 20 | opus / high |
| judge | 주장별 적대 검증 투표 | ~75 | opus |
| brain | 질문 분해·최종 종합 | 2 | inherit (세션 모델) |

기본값의 근거는 호출 규모다. brain은 전체에서 두 번만 호출되면서 품질 기여도가 가장 큰 자리이므로, 세션 모델을 그대로 두어도 비용 구조에 미치는 영향이 미미하다. 반대로 judge는 약 75회 호출되어 세션 모델 상속이 비용에 그대로 반영되는 자리이므로, worker와 같은 고정 티어를 기본값으로 둔다.

```
/tiers:deep-research 2026년 로컬 LLM 추론 스택 비교
/tiers:deep-research judge=sonnet 가볍게 훑어줘     → 이번 한 번만 judge 교체
/tiers:deep-research setup                         → 기본 티어 변경
```

일회성 오버라이드 토큰은 질문 앞에 붙인다: `model=` `effort=` `judge=` `brain=`

## 설정

각 커맨드의 `setup`이 대화형으로 기본 티어를 저장한다. 설정 파일은 플러그인 데이터 디렉토리(`${CLAUDE_PLUGIN_DATA}`)에 기록되므로 플러그인을 업데이트해도 유지된다.

## 동작 원리

Workflow의 `agent()` 호출은 `model`과 `effort`를 호출 단위로 지정할 수 있다. tiers의 두 스킬은 모든 `agent()` 호출에 이 두 키를 명시적으로 싣는 것을 계약으로 강제한다. 키가 누락된 호출은 조용히 세션 모델을 상속하는데, 이 플러그인은 정확히 그 실패를 막기 위해 존재한다.
