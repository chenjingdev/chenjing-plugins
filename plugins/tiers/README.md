# tiers

실행 티어를 사용자가 결정하는 위임 플러그인.

Claude Code에서 서브에이전트는 기본적으로 세션 모델을 상속한다. 상위 티어 모델로 세션을 운용하면 fan-out되는 에이전트도, 일상적으로 띄우는 구현 서브에이전트도 전부 같은 단가로 돈다. 전체 토큰 소비의 대부분은 메인 세션이 아니라 이 서브에이전트들의 몫이다.

tiers는 이 상속을 끊는다. 판단·설계·검증은 세션 모델이 그대로 맡고, 실행은 미리 지정한 티어로만 생성된다. 세 층으로 나뉜다.

| 층 | 커맨드 | 대상 | 방식 |
|---|---|---|---|
| 일상 위임 | `/tiers:delegate` | 평범한 구현 작업, 넓은 조사 | Agent 도구 + 가드 훅. worker·scout 에이전트 |
| 대규모 fan-out | `/tiers:ultracode` | 감사·마이그레이션급 오케스트레이션 | Workflow, 전 에이전트 단일 고정 티어 |
| 리서치 | `/tiers:deep-research` | 검색·수집·검증 파이프라인 | 번들 엔진, 자리별 티어 |

## 설치

```
/plugin marketplace add chenjingdev/chenjing-plugins
/plugin install tiers@chenjing-plugins
```

가드 훅은 Node.js 18 이상이 PATH에 있어야 동작한다. 없으면 훅은 조용히 넘어가고 위임 강제만 빠진다.

## /tiers:delegate

세션이 계획하고, worker가 구현하고, 세션이 검증한다. 설치만으로는 훅이 아무 일도 하지 않는다. `on`을 켠 사람의 세션에서만 모델 고정과 편집 차단이 걸린다.

```
/tiers:delegate on          → 훅 전체를 켠다. 모델 고정 + 메인 세션 구현 편집 거부
/tiers:delegate off         → 훅 전체를 끈다. 모델 고정도 하지 않는다
/tiers:delegate status      → 설정·데이터 위치·최근 핸드오프
/tiers:delegate setup       → worker 모델, 고정 범위, 소규모 편집 허용치
/tiers:delegate <작업>       → on/off와 무관하게 위임 프로토콜을 한 번 실행
```

### 훅이 하는 일

플러그인의 `hooks/guard.js` 하나가 PreToolUse와 SubagentStop에 붙는다. 설정 파일은 호출마다 다시 읽으므로 변경이 즉시 적용된다. 스위치는 `enabled` 하나다. `true`면 아래 세 가지가 함께 동작하고, `false`면 훅은 아무것도 하지 않는다. 모델 고정도 하지 않는다.

- **모델 고정**: Agent 호출에 `model`이 없으면 설정 모델을 넣는다. `tiers:worker`는 명시한 모델이 있어도 설정 모델로 바꾼다. `fork`는 건드리지 않는다. 범위는 `pin: all | worker`.
- **메인 세션 편집 차단**: 훅 입력에 `agent_id`가 없는 호출, 즉 메인 세션의 Edit/Write/MultiEdit/NotebookEdit를 거부한다. Bash도 파일 쓰기 패턴을 거부한다. 리다이렉트, `tee`, `sed -i`, `cp/mv/rm/touch`, `git apply`, `patch`, Python·Node의 파일 쓰기. `/tmp` 아래 쓰기와 설정 파일(`${CLAUDE_PLUGIN_DATA}/delegate.json`) 쓰기는 통과한다. 설정 파일이 열려 있어야 `off`가 스스로를 끌 수 있다. 데이터 디렉토리의 나머지(핸드오프 기록)는 훅이 직접 쓰므로 열어 두지 않는다. 서브에이전트의 호출은 전부 통과.
- **브리프 검사**: 메인 세션이 `tiers:worker`나 general-purpose를 부를 때 브리프에 목표·맥락·범위·완료 기준 네 절이 없으면 거부하고 빠진 절과 템플릿을 알려 준다. 한글·영문 제목 모두 인식한다.
- **핸드오프 기록** (`log: true`일 때): 통과한 worker 브리프를 `${CLAUDE_PLUGIN_DATA}/handoffs/`에 남긴다. worker가 끝나면 마지막 보고를 같은 파일에 붙이는데, 이쪽은 `enabled`가 꺼진 뒤에도 계속 동작한다. 켜져 있을 때 시작한 worker의 기록이 반쪽으로 남지 않게 하기 위해서다.

거부 사유는 두 단계로 나뉜다. 편집을 막을 때는 한두 줄만 남긴다 — 여기서는 못 고친다, `tiers:worker`에 넘겨라, 끄려면 `/tiers:delegate off`. 브리프 템플릿은 그다음 단계, 즉 네 절이 빠진 브리프를 거부할 때만 나온다. 정작 템플릿이 필요한 순간이 거기이기 때문이다. 어느 쪽이든 CLAUDE.md에 규칙을 깔아 두는 것보다 필요한 순간에 주입되는 쪽이 훨씬 덜 희석된다.

### 분업 규칙

- 구현은 예외 없이 worker. 세션은 의도 파악, 브리프에 실을 좁은 읽기, 검증, 커밋 승인.
- 넓은 수색은 scout. 발췌와 출처를 그대로 가져오고 결론은 내지 않는다. 판단에 바로 들어가는 좁은 읽기는 세션이 직접 한다.
- worker는 작업 한 건 동안 유지한다. 되묻기(BLOCKED)와 수정 요청은 SendMessage로 같은 worker에 보낸다. 같은 파일 위의 연속 작업은 재사용하고, 영역이 바뀌면 새로 띄운다.
- 탈출구 세 개. `small_edit_chars` 이하의 Edit 하나는 통과. 같은 지점에서 BLOCKED가 두 번 오면 `off`로 끄고 그 부분만 직접. 분석·토론 세션은 처음부터 `off` 또는 `TIERS_DELEGATE=off`로 시작.

### 에이전트

| 에이전트 | 모델 | 도구 | 계약 |
|---|---|---|---|
| `tiers:worker` | 설정 모델 (기본 opus), effort xhigh | 전체 | 브리프대로 구현. 결정 못 하는 갭은 `BLOCKED:`로 되묻기. 고정 형식 보고(상태·변경·검증·재량 결정·남은 것) |
| `tiers:scout` | 설정 모델 | 편집·Agent 제외 전체(MCP 상속) | 질문을 받아 넓게 수색. 원문 발췌 + 출처만 반환, 결론 금지 |

scout는 그 사람 환경에 등록된 MCP 도구를 그대로 상속한다. 메모리 서버든 사내 지식베이스든 플러그인에 박혀 있지 않다.

### 설정

`${CLAUDE_PLUGIN_DATA}/delegate.json`

```json
{"model":"opus","enabled":false,"pin":"all","small_edit_chars":200,"log":true}
```

| 키 | 값 | 뜻 |
|---|---|---|
| `model` | `opus` `sonnet` `haiku` `fable` 또는 전체 모델 ID | worker 모델이자 고정 대상 모델 |
| `enabled` | `true` `false` | 훅 전체. 모델 고정 + 메인 세션 편집 차단 + 브리프 검사 |
| `pin` | `all` `worker` | 켜졌을 때의 모델 고정 범위 |
| `small_edit_chars` | 정수, 0이면 없음 | 켜졌을 때 허용하는 단일 Edit 크기(old+new 문자 수) |
| `log` | `true` `false` | 핸드오프 기록 |

환경변수 `TIERS_DELEGATE=on|off`는 그 세션에 한해 `enabled`를 덮어쓴다. 즉 모델 고정까지 함께 켜고 끈다.

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

## 설정 파일

각 커맨드의 `setup`이 대화형으로 기본 티어를 저장한다. 설정 파일은 플러그인 데이터 디렉토리(`${CLAUDE_PLUGIN_DATA}`)에 기록되므로 플러그인을 업데이트해도 유지된다.

## 동작 원리

Workflow의 `agent()` 호출과 Agent 도구는 모두 호출 단위로 `model`을 지정할 수 있다. ultracode와 deep-research는 모든 `agent()` 호출에 이 키를 명시적으로 싣는 것을 계약으로 강제하고, delegate는 같은 일을 PreToolUse 훅이 기계적으로 한다. 키가 누락된 호출은 조용히 세션 모델을 상속하는데, 이 플러그인은 정확히 그 실패를 막기 위해 존재한다.

## 개발

```
node --test plugins/tiers/tests/                       # 가드 훅 단위 테스트
claude --plugin-dir plugins/tiers -p "..."             # 설치 없이 세션 하나에 붙여 실측
```
