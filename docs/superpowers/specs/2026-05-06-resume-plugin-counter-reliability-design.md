# Resume Plugin — Counter Reliability & Profiler Trigger Redesign

**Date**: 2026-05-06
**Trigger**: 회고 `playground/docs/retrospectives/20260504-185751.md` §5 P0 — hook 집계 누락. 추가 발견 — 프로파일러 트리거 모델에 인터뷰 강도가 빠져 있어 호출 빈도 부족.
**Scope**: 시스템 트랙 (코드/hook). 회고가 지적한 콘텐츠 회수(버넥트 STAR/Kafka/CJ 추천 루트 등)는 이번 spec 범위 외.

---

## 1. 문제 정의

회고가 식별한 시스템 측 결함:

1. `agent_invocations` 집계가 모두 0인데 실제로는 senior 등 다수 호출됐음. meta.json은 사후 수동 동기화(`retrospective_synced_manual: true`)된 상태로 stats와 모순.
2. `round_turn_counts` 모두 0. 코드(`scripts/episode-watcher.mjs`) 어디에서도 증가시키지 않음. 그러나 G3 r2_exit 게이트는 `turn_min < 15`를 검사 → 항상 위반이어야 정상이지만 회고는 위반 0건. 즉 카운터 미수집 + 게이트 사실상 무효 두 결함이 공존.
3. 프로파일러 호출 3회 = SKILL.md 필수 호출(R1 중간 / R2 진입 / R3 최종) 정확히 그 수. 임계 기반 추가 트리거가 한 번도 실효되지 않음. 원인은 가중치 모델이 **resume-source.json 변경 이벤트만** 반영하고 인터뷰 활동(AUQ/Agent 호출/finding 발행)을 점수화하지 않음. 따라서 에피소드를 일괄 저장하면 점수가 한 번 폭발하고 그 뒤 인터뷰가 길어져도 score는 정체 → 트리거 누락.

별도 follow-up으로 분리한 이슈(이번 spec 범위 외):

- 이슈 4: `pattern_detected` finding 발행 경로 미정립 (프로파일러 산출물 → inbox 흐름 명세 부재)
- 이슈 5: `migrateMeta` 단방향 — 구필드(`perspective_shifts_this_session` 등)가 `delete` 후에도 실제 파일에 잔존

---

## 2. 가설: agent_invocations 집계 누락의 root cause

`hooks/hooks.json` 매처: `"Write|Bash|Edit|Task|AskUserQuestion"`.
`scripts/episode-watcher.mjs:62`: `if (toolName === "Task")`.

Claude Code 2026 현재 에이전트 호출 도구 이름은 **`Agent`**일 가능성이 높음 (현재 환경에 노출된 도구 스키마 기준). 매처와 핸들러 모두 `Task`만 보고 있어 Agent 호출 시 PostToolUse 자체가 발화하지 않음. 결과: meta/stats 둘 다 0이어야 정상이고, meta가 6인 것은 회고 작성자가 사후 수동 보정한 결과.

이 가설이 맞으면 `round_turn_counts` 미증가도 같은 뿌리(Hook이 Agent 호출에 무반응)일 수 있음. 단 turn 카운트는 별도로 신설하므로 가설 의존 없음.

**검증 방식**: 방어적 수정(매처에 `Agent` 추가, 핸들러에서 `toolName === "Task" || toolName === "Agent"` 양쪽 수용) + 디버그 로깅(`session-stats.json._debug.observed_tool_names`) → 다음 실제 세션이 자연 진단 → 다음 회고에서 검증.

검증 먼저(진단 스크립트로 toolName 확인 후 수정)는 채택 안 함. 이유: PostToolUse hook을 dummy로 트리거하는 환경이 진짜 운영과 동등성 보장이 어려워 위양성/위음성 위험. 양쪽 매칭은 미래 도구명 변경에도 안전하고 비용 1줄.

---

## 3. 결정 사항

- 스코프 = 시스템 트랙. 카운터(이슈 1·2·3) + 프로파일러 가중치 재설계(이슈 3의 후속 결정). 이슈 4·5는 follow-up.
- agent_invocations 정상화 = 매처/핸들러에 Agent 추가 + 디버그 로깅, 다음 세션 자연 검증.
- round_turn_counts의 "turn" 정의 = **UserPromptSubmit 이벤트 1회 = 1 turn** (유저 메시지 1번). AUQ 기반 정의는 멀티-에이전트 턴에서 과집계되므로 기각.
- r2_exit 게이트 임계값 `turn_min ≥ 15` 그대로 유지. 의미가 정상화된 turn 정의 위에 자연 적용.
- 프로파일러 가중치 = 모델 B (storage + AUQ + finding 중요도 보정). THRESHOLD 5 유지. 다음 세션 데이터로 튜닝 결정.
- 미해결 이슈는 `docs/superpowers/follow-ups/resume-system-deferred.md`에 보존.

---

## 4. 변경 표면

| 파일 | 변경 |
|---|---|
| `plugins/resume/hooks/hooks.json` | PostToolUse 매처에 `Agent` 추가, UserPromptSubmit 엔트리 신설 |
| `plugins/resume/scripts/episode-watcher.mjs` | Agent toolName 양쪽 수용, UserPromptSubmit 분기 신설, 가중치 확장(addProfilerScore 헬퍼), `_debug` 객체 lazy 초기화 |
| `plugins/resume/scripts/test-episode-watcher.mjs` | 위 변경에 대한 테스트 신규 케이스 |
| `plugins/resume/skills/resume-panel/references/gates.md` | G3 §turn 정의를 `UserPromptSubmit 이벤트 1회 = 1 turn`로 명시 |
| `plugins/resume/skills/resume-panel/references/hook-protocol.md` | 가중치 모델 B 표 추가 |
| `docs/superpowers/follow-ups/resume-system-deferred.md` | 신규 — 이슈 4·5 메모 |

---

## 5. 아키텍처 & 데이터 흐름

### 5.1 단일 스크립트 통합

`episode-watcher.mjs`가 PostToolUse + UserPromptSubmit 두 이벤트 모두 처리. `input.hook_event_name`으로 분기. 이유 — 같은 상태 파일들(meta.json, session-stats.json)을 다루고 분리 시 동시 쓰기 레이스가 새로 발생.

### 5.2 hooks.json 구조

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Bash|Edit|Task|Agent|AskUserQuestion",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/episode-watcher.mjs\"",
            "timeout": 10
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/episode-watcher.mjs\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

### 5.3 episode-watcher.mjs 분기 구조 (의사코드)

```js
const eventName = input.hook_event_name;

if (eventName === "UserPromptSubmit") {
  ensureStateDir();
  const meta = migrateMeta(readJSON(metaPath) || {});
  meta.gate_state ||= defaultGateState();
  const round = String(meta.current_round ?? 0);
  meta.gate_state.round_turn_counts ||= { "0": 0, "1": 0, "2": 0, "3": 0 };
  meta.gate_state.round_turn_counts[round] =
    (meta.gate_state.round_turn_counts[round] || 0) + 1;

  const stats = readStats(base);
  stats._debug ||= { observed_tool_names: {}, observed_hook_events: {}, first_seen_at: new Date().toISOString() };
  stats._debug.observed_hook_events.UserPromptSubmit =
    (stats._debug.observed_hook_events.UserPromptSubmit || 0) + 1;

  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  writeStats(base, stats);
  process.exit(0);
}

// 이하 PostToolUse 흐름 (기존)
// 변경: Task → Agent도 받음
const isAgentInvocation = toolName === "Task" || toolName === "Agent";
if (isAgentInvocation) { /* 기존 Task 핸들러 로직 + observed_tool_names[toolName]++ */ }
```

### 5.4 상태 흐름

```
유저 메시지 도착
  └→ UserPromptSubmit hook
       └→ meta.gate_state.round_turn_counts[current_round]++
       └→ stats._debug.observed_hook_events.UserPromptSubmit++

오케스트레이터 동작 (Agent/AUQ/Write 등)
  └→ PostToolUse hook (도구별 매칭)
       ├→ Agent/Task    → agent_invocations[subagent]++ (기존), observed_tool_names[toolName]++
       ├→ AskUserQuestion → askuserquestion 집계 (기존), addProfilerScore(1, "AUQ") 신규
       ├→ Write resume-source.json → storage 가중치 (기존), addProfilerScore 경유
       └→ finding 라우팅 (HIGH 등) → meta._last_high_finding_at 갱신, 종류별 addProfilerScore

라운드 전환 시: round-transition.json 시그널 → r2_exit 검증 (turn_min<15 등)
```

### 5.5 디버그 로깅

`session-stats.json`에 `_debug` 객체 추가:

```json
{
  "agent_invocations": { ... },
  "askuserquestion": { ... },
  "gate_violations": [ ... ],
  "_debug": {
    "observed_tool_names": { "Agent": 18, "Task": 0 },
    "observed_hook_events": { "PostToolUse": 50, "UserPromptSubmit": 23 },
    "first_seen_at": "2026-05-06T..."
  }
}
```

다음 실제 세션이 자연스럽게 데이터를 채움. 다음 회고가 이 데이터를 보고 (a) 가설 검증, (b) 가중치 튜닝 근거 확보.

---

## 6. 컴포넌트 상세

### 6.1 (A) agent_invocations 정상화

**위치**: `episode-watcher.mjs:62-95` Task 핸들러 + `hooks.json:5` 매처.

**변경**:
1. `hooks.json` PostToolUse matcher: `"Write|Bash|Edit|Task|Agent|AskUserQuestion"`
2. 핸들러 가드: `if (toolName === "Task" || toolName === "Agent")` — 양쪽 동일 처리
3. 핸들러 진입 시 `stats._debug.observed_tool_names[toolName]++` 누적

**성공 기준**: 다음 세션 종료 후 `_debug.observed_tool_names`에 `Agent` 또는 `Task` 둘 중 하나라도 양수 + `agent_invocations.senior` 등이 실제 호출 수 반영.

---

### 6.2 (B) round_turn_counts 신설

**위치**: `episode-watcher.mjs` 진입 직후 새 분기.

**규칙**:
- UserPromptSubmit 1회 → `meta.gate_state.round_turn_counts[String(meta.current_round ?? 0)]++`
- `meta.current_round` 미설정 시 round "0"으로 카운트 (Round 0 세팅 단계).
- 라운드 전환은 오케스트레이터가 `meta.current_round`를 직접 갱신 — 이미 그렇게 동작 중.
- 비표준 round 키 안전: `round_turn_counts[round]` 미존재 시 0으로 초기화 후 ++.

**성공 기준**: 다음 세션 종료 시 `round_turn_counts`에 라운드별 분포가 0이 아닌 값으로 기록.

---

### 6.3 (C) r2_exit 게이트 의미 회복

**위치**: `episode-watcher.mjs:583` (기존 코드).

**변경 없음**. (B)에서 카운터가 채워지면 `gs.round_turn_counts["2"] < 15` 검사가 자연 의미. 단 `references/gates.md` §G3에 turn 정의 명시 추가:

> turn = UserPromptSubmit 이벤트 1회 = 유저 메시지 1번

**검증**: 테스트 케이스 추가 — round 2에 15회 이상 UserPromptSubmit 시뮬레이션 → 위반 없음 / 14회 이하 → `missing: ["turn_min"]` 위반.

---

### 6.4 (D) 프로파일러 가중치 모델 B

**위치**: `episode-watcher.mjs:98-169` AUQ 핸들러 + 새 헬퍼 + finding 라우팅 분기.

**가중치**:

| 이벤트 | 점수 | 조건 |
|---|---|---|
| AUQ 호출 (모든 source) | +1 | 매 AUQ |
| AUQ + 직전 60초 이내 finding HIGH delivered | +2 추가 (총 +3) | `meta._last_high_finding_at` 비교. 60초 = 인터뷰 1턴 응답 작성 + 다음 AUQ까지 여유 윈도. HIGH finding 라우팅 분기에서 `meta._last_high_finding_at = new Date().toISOString()` 세팅. |
| so_what 트리거 발행 | +3 | 기존 so_what 발행 분기에서 |
| perspective_shift finding 라우팅 | +3 | finding 라우팅 분기에서 |
| contradiction_detected finding 라우팅 | +3 | 동상 |
| 에피소드 +N (storage) | +N | 기존 |
| 새 프로젝트 (storage) | +3 | 기존 |
| 빈 STAR 증가 (storage) | +2 | 기존 |
| 역할 축소 신호 (storage) | +2 | 기존 |
| meta 변경 (storage) | +2 | 기존 |

**구현**:
```js
// 인메모리 meta 객체에 직접 가산. 호출자가 마지막에 한 번 writeFileSync.
// 이유: 한 hook fire에서 여러 score 가산이 일어날 수 있는데(예: AUQ +1 + finding HIGH 보너스 +2 + so_what +3),
// 헬퍼 안에서 매번 read-write하면 (a) 디스크 비용 (b) 같은 fire 내 다른 meta 수정과의 race.
function addProfilerScore(meta, delta, reason) {
  meta.profiler_score = (meta.profiler_score || 0) + delta;
  meta._score_reasons = (meta._score_reasons || []).slice(-9);
  meta._score_reasons.push({ delta, reason, at: new Date().toISOString() });
  return meta.profiler_score;
}
```

호출자(AUQ 핸들러, finding 라우팅 분기 등)는 이 헬퍼로 가산 후, 자신의 분기 끝에서 단일 `writeFileSync(metaPath, JSON.stringify(meta, null, 2))`. 기존 storage 가중치 블록(`episode-watcher.mjs:425~478`)도 동일 헬퍼 경유로 일관화 — 점수 가산 사유가 `_score_reasons`에 모이게 함. 임계 도달 시 `profiler_trigger` 메시지 emit + score 0 리셋(기존 흐름 유지).

`_score_reasons` — 최근 10개 점수 누적 사유 보존(디버깅·회고용).

**THRESHOLD 5 그대로**. 다음 세션 데이터로 튜닝 결정.

**시뮬레이션 근거 (지난 세션 기준)**:

| | 누적 점수 | 트리거 횟수 | 빈도 |
|---|---|---|---|
| 현재 (storage만) | ~26 | 5회 (실제 3회) | 12분/회 |
| 모델 B (제안) | ~64 | ~12회 | 5분/회 |
| 모델 C (Agent 호출 +2 추가, 제안 외) | ~100 | ~20회 | 3분/회 |

모델 C는 기각. 사유:
- 이중 카운트: senior 호출(+2) → 거기서 나온 AUQ(+1) → 한 인터뷰 활동 = +3
- over-trigger 시 (a) 오케스트레이터 무시 (b) Agent 호출 비용 폭증
- Agent 호출 추적은 이슈 1 디버그가 필요한 영역이라 가중치 모델까지 의존하면 결합도 증가

---

### 6.5 (E) follow-up 문서

`docs/superpowers/follow-ups/resume-system-deferred.md` 신규 작성. 내용:

- 이슈 4 — `pattern_detected` finding 발행 경로 미정립
- 이슈 5 — `migrateMeta` 단방향 (구필드 잔존)
- 회고 §5의 콘텐츠 회수 항목은 시스템 이슈 아님 — 다음 인터뷰 세션 진입 시 처리

---

## 7. 에러 처리 & 엣지 케이스

- **동시성**: PostToolUse + UserPromptSubmit 짧은 간격으로 도착 가능. 둘 다 meta.json read-modify-write. 기존 코드도 같은 패턴이므로 새 리스크 없음. `gate_state ||= defaultGateState()`, `_debug ||= { ... }` lazy 초기화로 부분 누락 방어.
- **비표준 입력**: UserPromptSubmit 입력에 `cwd` 부재 가능성. 기존 fallback `process.env.RESUME_PANEL_BASE || input.cwd || process.cwd()` 그대로 사용.
- **비정상 round 키**: 오케스트레이터가 잘못된 `current_round` 값을 넣어 "5" 같은 키가 들어와도 객체에 추가만 됨. 게이트 검사는 `["2"]`만 보므로 무해.
- **트리거 후 즉시 재트리거 방지**: 기존 `score = 0` 리셋 그대로. AUQ 폭주(예: senior가 5개 질문 배치)로 한 번에 +5 → 트리거 → 다음 AUQ는 +1부터 누적 → 안전.
- **로그 폭증 방지**: `_debug.observed_tool_names`는 키별 카운터(bounded). `_score_reasons`는 최근 10개로 잘림 (`.slice(-9)` + push).
- **기존 세션 상태 보존**: `migrateMeta`는 그대로. 새 spec 변경은 모두 추가형(필드 신설). 파괴적 마이그레이션 없음. 기존 사후 수동 동기화 필드(`retrospective_synced_manual` 등)도 건드리지 않음.
- **hook 실행 실패**: 기존과 동일 `process.exit(0)` — Claude Code 흐름 안 막음. JSON output은 메시지가 있을 때만.

---

## 8. 테스트 전략

### 8.1 unit test (`test-episode-watcher.mjs` 확장)

1. **agent_invocations 정상화**:
   - `toolName: "Agent"`, `subagent_type: "senior"` → `stats.agent_invocations.senior === 1`, `_debug.observed_tool_names.Agent === 1`
   - `toolName: "Task"`, `subagent_type: "senior"` → 동일하게 +1, `observed_tool_names.Task === 1`
   - 두 이름 혼재 호출 → 누적 정확

2. **round_turn_counts**:
   - UserPromptSubmit × 3, `current_round = 1` → `round_turn_counts["1"] === 3`
   - 라운드 전환(`meta.current_round = 2`) 후 UserPromptSubmit × 2 → `["1"] === 3`, `["2"] === 2`
   - `current_round` 미설정 → `["0"]`에 누적
   - 비표준 round 키 들어와도 크래시 없음

3. **r2_exit 게이트**:
   - `round_turn_counts["2"] = 15`, recruiter/hr 호출 + gap_analysis 정상 → 위반 없음
   - `round_turn_counts["2"] = 14` → `missing: ["turn_min"]` 발생
   - 카운터 0 → 기존처럼 위반

4. **프로파일러 가중치 모델 B**:
   - AUQ 5회 (모든 agent source) → score +5 → 임계 도달 → trigger → 0 리셋
   - AUQ 직후 + finding HIGH delivered (1분 이내 모킹) → 추가 +2 검증
   - so_what 발행 → score +3
   - perspective_shift finding 발행 → +3
   - contradiction_detected → +3
   - storage 가중치 + AUQ 가중치 동시 누적 → 임계 도달 검증
   - `_score_reasons` 최근 10개로 잘림

5. **마이그레이션**:
   - `_debug` 없는 기존 stats → 첫 fire 후 lazy 생성
   - `migrateMeta` 호출해도 새 필드(`_score_reasons` 등) 손실 없음

### 8.2 라이브 검증

다음 실제 resume 세션이 자연 진단:
- 다음 회고가 `agent_invocations` 실값 보유, `round_turn_counts` 분포 보유 → 시스템 신뢰도 회복 증거.
- `_debug.observed_tool_names`로 실제 toolName 확정.
- 프로파일러 호출 횟수 5 이상이면 가중치 모델 B 효과 검증.

테스트 통과 기준: 기존 `test-episode-watcher.mjs` 통과 + 신규 케이스 모두 통과 + 다음 라이브 세션이 위 데이터를 산출.

---

## 9. 비고

- 이번 spec은 카운터 정확성·트리거 빈도 회복에 한정. 결과 데이터(다음 세션 회고)에 따라 후속 라운드에서 (a) THRESHOLD 튜닝, (b) 모델 C 업그레이드 검토, (c) 이슈 4·5 본격 수정 spec 분기.
- 콘텐츠 회수(버넥트 STAR / Kafka / CJ 추천 루트 등)는 시스템 이슈가 아니므로 본 spec 범위 외. 다음 인터뷰 세션 진입(`/resume:resume-panel explore` 등) 시점에 처리.
