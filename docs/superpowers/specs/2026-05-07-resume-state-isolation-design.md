# Resume Plugin — Agent/Hook 상태 격리 설계

> 본 spec은 [`2026-05-06-resume-plugin-counter-reliability-design.md`](2026-05-06-resume-plugin-counter-reliability-design.md)의 후속 라운드. follow-up `docs/superpowers/follow-ups/resume-system-deferred.md`의 이슈 4(`pattern_detected` 발행 경로 미정립)와 이슈 5(`migrateMeta` 단방향)를 통합 처리.

## 1. 문제

### 1.1 진단

**root cause**: `meta.json`에 두 writer (profiler agent + episode-watcher hook)가 동시에 쓰는데 충돌 회피 규약이 없음.

- `profiler.md:269-282` — profiler가 `cat <<EOF > .resume-panel/meta.json`으로 meta.json을 **통째로 덮어씀**. 명시한 6개 필드만 적고 hook 관리 필드(`session_limits`, `gate_state`, `profiler_score`, `_score_reasons`, `_last_high_finding_at` 등)는 **전부 소실**.
- `migrateMeta`는 hook 진입 시 옛 스키마를 신 스키마로 옮기지만, profiler가 다음 사이클에서 다시 통째로 덮어쓰면 무용.
- 결과: hook이 누적한 모델 B 가중치 점수, 게이트 카운터, finding 보너스 윈도가 profiler 호출마다 리셋. 회고 §`playground/docs/retrospectives/20260504-185751.md`에서 식별된 카운터 정합성 이슈의 일부 원인.

### 1.2 이슈 4 재진단

회고 follow-up은 "pattern_detected가 어디서 발행되는지 불명확"이라 적었지만, `profiler.md:113·240`에 발행 형식·경로(`echo ... >> .resume-panel/findings-inbox.jsonl`)가 **이미 명세돼 있음**. 즉 이슈 4의 본질은:

- 발행 명세는 존재하나 `hook-protocol.md`, `agent-contract.md`, `profiler.md`, `storage.md` 4개 문서 간 cross-reference가 없어 다음 회고에서 다시 미스터리로 분류될 위험.
- 발행→라우팅 흐름을 검증하는 통합 테스트 부재.

## 2. 결정

### 2.1 파일 분할

`.resume-panel/` 아래 두 파일로 분리:

```
meta.json         ← profiler / orchestrator write, hook read-only
hook-state.json   ← hook 단독 writer, profiler / orchestrator read-only  (신규)
```

**writer 단일성 원칙** (엄격):
- `hook-state.json`은 episode-watcher hook만 write. profiler가 cat heredoc으로 meta.json을 통째 덮어써도 hook-state.json은 영향 없음 → 충돌 구조적 차단.
- `meta.json`은 profiler + orchestrator가 write 가능 (LLM 두 주체지만 둘 다 콘텐츠 의미 있는 필드만 다루므로 위험도 낮음. 본 spec 외 처리).

### 2.2 자동 migration

hook 진입 시점에 1회성 migration:
1. `hook-state.json`이 없으면 default로 생성.
2. `meta.json`에 hook 관리 필드가 잔존하면 `hook-state.json`으로 옮기고 `meta.json`에서 삭제.
3. 옛 스키마(`perspective_shifts_this_session` 등)도 동일하게 hook-state.json/session_limits로 정리.

idempotent: 두 번째 호출에서는 meta.json에 hook 필드 없음 → no-op. profiler가 다음 사이클에서 다시 meta.json 덮어써도 다음 hook 호출에서 다시 자동 정리.

### 2.3 명세 동기화

이슈 4 처리: `profiler.md`, `hook-protocol.md`, `agent-contract.md`, `storage.md` 4개 문서에 `pattern_detected` (와 자매 finding `perspective_shift`, `contradiction_detected`, `timeline_gap_found`)의 발행 주체/라우팅 주체/형식을 cross-reference. 통합 테스트로 발행→라우팅 경로 회귀 방지.

## 3. 필드 분할

### 3.1 `meta.json` — profiler / orchestrator write, hook read-only

| 필드 | writer | hook이 read하는 곳 |
|---|---|---|
| `last_profiler_call` | profiler | — |
| `last_profiler_episode_count` | profiler | — |
| `current_company` | profiler | snapshot 비교 (`episode-watcher.mjs:496, 631`) |
| `total_profiler_calls` | profiler | — |
| `current_round` | orchestrator | `round_turn_counts` 키 (`:38, :170`) |
| `so_what_active` | orchestrator | so_what 차단 (`:589`) |

### 3.2 `hook-state.json` — hook 단독 writer, profiler / orchestrator read-only

| 필드 | 용도 |
|---|---|
| `session_limits.gaps` | gap probe 카운터 + 의도된 gap 목록 |
| `session_limits.perspectives` | 관점 전환 사용 수 + episode_refs |
| `session_limits.contradictions` | 모순 제시 카운터 |
| `session_limits.reprobes` | 재프로빙 로그 |
| `gate_state.direct_askuserquestion_streak` | G2 burst 감지 |
| `gate_state.agent_calls_in_current_round` | 라운드별 에이전트 호출 |
| `gate_state.round_turn_counts` | UserPromptSubmit 카운트 |
| `gate_state.retrospective_invoked` | G4 회고 누락 감지 |
| `gate_state.last_askuserquestion_source` | AUQ 출처 추적 |
| `profiler_score` | 모델 B 점수 |
| `_score_reasons` | rolling 10 가산 사유 |
| `_last_high_finding_at` | 60s 보너스 윈도 |
| `last_timeline_check` | timeline gap 분석 시점 (이전엔 meta.json) |
| `last_pattern_analysis_episode_count` | 패턴 분석 trigger 시점 (이전엔 meta.json) |
| `last_pattern_analysis_company_count` | 패턴 분석 trigger 시점 (이전엔 meta.json) |

**제외**: `_debug.observed_*` (이미 `session-stats.json`에 있음).

## 4. 표면 (인터페이스)

### 4.1 episode-watcher.mjs 신규 헬퍼

```js
function loadState(base) {
  const meta = readJSON(metaPath) || {};
  let hookState = readJSON(hookStatePath);
  if (!hookState) hookState = defaultHookState();

  const HOOK_FIELDS = [
    "session_limits", "gate_state", "profiler_score",
    "_score_reasons", "_last_high_finding_at",
    "last_timeline_check", "last_pattern_analysis_episode_count",
    "last_pattern_analysis_company_count",
  ];
  let metaChanged = false;
  for (const f of HOOK_FIELDS) {
    if (meta[f] !== undefined) {
      hookState[f] = meta[f];
      delete meta[f];
      metaChanged = true;
    }
  }

  // 옛 스키마 정리 (구 migrateMeta 로직을 hookState 측으로 이전)
  hookState = migrateLegacyFields(hookState, meta);

  return { meta, hookState, metaChanged };
}

function saveMeta(base, meta) { writeFileSync(metaPath, JSON.stringify(meta, null, 2)); }
function saveHookState(base, hs) { writeFileSync(hookStatePath, JSON.stringify(hs, null, 2)); }

function defaultHookState() {
  return {
    session_limits: defaultSessionLimits(),
    gate_state: defaultGateState(),
    profiler_score: 0,
    _score_reasons: [],
  };
}
```

`migrateMeta` 함수는 `loadState`로 흡수되어 제거. `defaultGateState`, `defaultSessionLimits`는 그대로 재사용.

### 4.2 호출 패턴 변경

기존:
```js
const meta = migrateMeta(readJSON(metaPath) || {});
meta.gate_state.foo = ...;
writeFileSync(metaPath, JSON.stringify(meta, null, 2));
```

변경:
```js
const { meta, hookState, metaChanged } = loadState(base);
hookState.gate_state.foo = ...;
saveHookState(base, hookState);
if (metaChanged) saveMeta(base, meta); // migration 발생 시만
```

### 4.3 profiler.md 변경

**§238-253 (inbox append)**: 변경 없음. 이미 정확.

**§269-282 (meta.json 갱신)** — read-modify-write 강제:

```diff
- 분석 완료 후 `.resume-panel/meta.json`을 갱신:
- ```bash
- cat <<'EOF' > .resume-panel/meta.json
- {
-   "last_profiler_call": "2026-04-03T15:25:00Z",
-   ...
- }
- EOF
- ```
+ 분석 완료 후 `.resume-panel/meta.json`을 갱신한다. **반드시 read-modify-write 패턴**으로 자기 필드만 갱신한다 (기존 필드 보존):
+
+ ```bash
+ node -e '
+   const fs=require("fs"), p=".resume-panel/meta.json";
+   const m=JSON.parse(fs.readFileSync(p,"utf-8"));
+   m.last_profiler_call=new Date().toISOString();
+   m.last_profiler_episode_count=12;
+   m.current_company="튜닙";
+   m.total_profiler_calls=(m.total_profiler_calls||0)+1;
+   fs.writeFileSync(p, JSON.stringify(m,null,2));
+ '
+ ```
+
+ **절대 금지**: `cat <<EOF > meta.json` 같은 통째 덮어쓰기. 다른 필드(`current_round`, `so_what_active` 등)가 손실된다.
```

**§164·166·236 옛 필드 참조** — 신 경로로:
- `meta.json의 perspective_shifts_this_session` → `hook-state.json의 session_limits.perspectives.used`
- `meta.json의 perspective_shifted_episodes` → `hook-state.json의 session_limits.perspectives.episode_refs`
- `meta.json의 contradictions_presented_this_session` → `hook-state.json의 session_limits.contradictions.used`

**금지사항 추가**:
- `hook-state.json`은 read-only. write 금지. (필요하면 hook 시그널로 의사를 전달.)

### 4.4 references/ 문서

- **`storage.md`**: 파일 목록에 `hook-state.json` 추가 + 본 §3 분할 표 발췌. profiler/hook 권한 명시.
- **`hook-protocol.md`**: pattern_detected 섹션에 "발행 주체: profiler agent (`profiler.md` §2.6 참조). 라우팅: hook이 inbox에서 읽어 MEDIUM 라우팅 규약 적용." 추가.
- **`agent-contract.md`**: profiler 출력 형식(pt-..., ps-..., cd-..., tg-...) cross-reference 표.

## 5. 아키텍처

```
profiler agent (LLM)
  │
  ├─ Read .resume-panel/meta.json
  ├─ Read .resume-panel/hook-state.json (참조만, write 금지)
  │   (findings.json은 read 금지 — 기존 규약 유지)
  ├─ Bash: node -e '...meta.json read-modify-write...'
  └─ Bash: echo '...pt/ps/cd...' >> .resume-panel/findings-inbox.jsonl
            │
            ▼
episode-watcher hook (PostToolUse / UserPromptSubmit)
  │
  ├─ loadState() → { meta, hookState, metaChanged }
  │     ├─ hook-state.json 없으면 default
  │     └─ meta.json에 hook 필드 잔존하면 옮기고 삭제 (idempotent)
  ├─ hookState 갱신 (gate, score, reasons)
  ├─ inbox 라우팅 → findings.json 갱신
  ├─ saveHookState()
  └─ metaChanged이면 saveMeta()  (migration 발생 시만)
```

## 6. 컴포넌트

### 6.1 `loadState` (1단계)

`migrateMeta` 대체. 모든 entry point(`UserPromptSubmit` 분기, `Task/Agent` 분기, `AskUserQuestion` 분기, `isResumeSourceChange` 분기, `round-transition` 분기, `session-end` 분기, finding 라우팅 분기)에서 호출.

### 6.2 `saveMeta` / `saveHookState` (2단계)

각 분기에서 갱신한 객체를 적절히 persist. metaChanged 플래그로 불필요한 saveMeta 회피.

### 6.3 옛 스키마 정리 (`migrateLegacyFields`)

기존 `migrateMeta`의 옛 필드 → session_limits 변환 로직을 흡수. 입력은 hookState + meta, 출력은 hookState. meta에 옛 필드가 있으면 hookState로 옮기고 meta에서 삭제.

### 6.4 명세 동기화 (이슈 4)

`pattern_detected` 발행/라우팅 흐름을 4개 문서에 cross-reference. 본 spec 부록 §A에 cross-reference 표.

### 6.5 통합 테스트

`test-episode-watcher.mjs`에 다음 테스트 추가:
- profiler 시뮬레이션: `cat <<EOF > meta.json` 패턴 후 hook 호출 → hook-state.json 무영향 + meta.json에 잔존하던 필드 정상 복원
- pattern_detected 라우팅: inbox에 `{"id":"pt-...","type":"pattern_detected","urgency":"MEDIUM","source":"profiler",...}` append + company 변경 → hook이 MEDIUM 라우팅 → findings.json에 delivered=true 적재

## 7. 에러 처리

| 상황 | 처리 |
|---|---|
| `hook-state.json` 없음 | `defaultHookState()` 생성 (현 `migrateMeta`와 동일 패턴) |
| `hook-state.json` malformed JSON | `hook-state.json.bak.${unixMs}` 백업 후 default 사용. stderr에 한 줄 경고 |
| `meta.json` malformed JSON | 기존과 동일 — `readJSON` null 반환, default `{}` 사용 |
| profiler가 meta.json 통째 덮어씀 (정상 흐름) | 다음 hook 호출에서 자동 정리. 본 spec의 의도된 회복 메커니즘 |
| profiler가 hook-state.json을 실수로 write (sequence 외) | 본 spec scope 외. profiler.md 가이드로 1차 차단. 후속 라운드에서 _debug 감지 추가 가능 |

## 8. 테스트

### 8.1 unit (TDD red-green-refactor)

1. `loadState` 첫 호출: `meta.json`만 있는 상태에서 호출 → `hook-state.json` 생성 + meta.json에서 hook 필드 분리.
2. `loadState` idempotent: 두 번 호출 동일 결과.
3. `loadState` 옛 스키마 흡수: `meta.json`에 `perspective_shifts_this_session: 3` 만 있는 상태 → `hook-state.json.session_limits.perspectives.used === 3`.
4. profiler 시뮬레이션: `meta.json`에 `{current_company: "X"}`만 있는 상태로 통째 덮어쓰기 → 다음 hook 호출 → hook-state.json 무영향 + meta.json에 current_company 보존.
5. `saveHookState` malformed 백업: 깨진 JSON으로 시작 → backup 파일 생성 + default로 복구.

### 8.2 integration

6. pattern_detected 라우팅: inbox에 pt-... append + meta.current_company 변경 시뮬레이션 → hook 호출 → findings.json에 `delivered=true`로 적재.
7. ps-... (perspective_shift) 라우팅: 동일 패턴.
8. cd-... (contradiction_detected) HIGH 라우팅: company 변경 무관하게 즉시 라우팅.

### 8.3 회귀

9. 기존 82 PASS 유지. `migrateMeta` 호출이 모두 `loadState`로 치환되어도 동일 동작.

### 8.4 명세 일치 (수동 검증)

10. spec 부록 §A의 cross-reference 표를 4개 문서와 대조해 일치 확인. spec 작성 시 1회 수행.

## 9. 부록

### §A `pattern_detected` cross-reference

| 항목 | 출처 |
|---|---|
| 발행 주체 | profiler agent (`profiler.md §2.6`) |
| 발행 트리거 | 프로파일러 호출 시 + 에피소드 ≥3 + 회사 ≥2 |
| 발행 위치 | `.resume-panel/findings-inbox.jsonl` (Bash echo append) |
| 형식 정의 | `profiler.md:113`, `hook-protocol.md §finding` |
| 라우팅 주체 | episode-watcher hook (`hook-protocol.md §라우팅`) |
| 라우팅 조건 | MEDIUM + `current_company` 변경 시 |
| 처리 위치 | `hook-protocol.md §pattern_detected` 처리 패턴 |
| 적재 위치 | `.resume-panel/findings.json` |

### §B 비스코프

본 spec 외 후속 처리:
- 오케스트레이터의 `meta.json` write (current_round, so_what_active) — 단일 writer 원칙 엄격 적용 시 추가 분리 필요. 현재는 LLM 두 주체가 통째 덮어쓰기 패턴 안 쓰는 한 안전.
- profiler가 hook-state.json을 실수로 write 시 감지 (`_debug.illegal_write`). 본 spec은 prompt 가이드로 1차 차단만.
- 콘텐츠 트랙 항목 (버넥트 STAR, Reverse Proxy Mocking 등) — `docs/superpowers/follow-ups/resume-system-deferred.md` 관할.
