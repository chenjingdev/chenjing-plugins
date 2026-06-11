# Resume Plugin — Agent/Hook State Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `meta.json`을 `meta.json` (profiler write) + `hook-state.json` (hook write)으로 분할하여 profiler agent의 통째 덮어쓰기로 인한 hook 상태 손실을 구조적으로 차단한다.

**Architecture:** episode-watcher.mjs에 `loadState()` 헬퍼를 신설해 두 파일을 함께 읽고 1회성 자동 migration을 수행한다. 모든 hook 관리 필드(`session_limits`, `gate_state`, `profiler_score`, `_score_reasons`, `_last_high_finding_at`, `last_timeline_check`, `last_pattern_analysis_*`)를 `hook-state.json`으로 옮기고, profiler.md 가이드와 4개 references 문서를 동기화한다.

**Tech Stack:** Node.js (>=18), node:fs/path/crypto, node:assert (블록 스코프 테스트), 기존 episode-watcher.mjs hook 인프라.

---

## File Structure

| 파일 | 역할 | 변경 방식 |
|---|---|---|
| `plugins/resume/scripts/episode-watcher.mjs` | hook 본체 | `migrateMeta` 제거, `loadState/saveMeta/saveHookState/defaultHookState` 신설, 8개 entry point 리팩토링 |
| `plugins/resume/scripts/test-episode-watcher.mjs` | 테스트 | Phase 6 추가 (state isolation), 기존 82 PASS 회귀 보장 |
| `plugins/resume/.claude/agents/profiler.md` | profiler 가이드 | meta.json read-modify-write 강제, 옛 필드 참조 갱신, hook-state.json read-only 명시 |
| `plugins/resume/skills/resume-panel/references/storage.md` | 저장소 명세 | `hook-state.json` 추가 + 분할 표 |
| `plugins/resume/skills/resume-panel/references/hook-protocol.md` | hook 계약 | pattern_detected 발행/라우팅 주체 cross-reference |
| `plugins/resume/skills/resume-panel/references/agent-contract.md` | 에이전트 계약 | profiler 산출 형식 cross-reference |

---

## Task 1: `defaultHookState` 헬퍼 + 경로 상수

**Files:**
- Modify: `plugins/resume/scripts/episode-watcher.mjs`
- Test: `plugins/resume/scripts/test-episode-watcher.mjs`

- [ ] **Step 1: 실패 테스트 추가**

테스트 파일 끝(Phase 5.9 직후, `console.log("\n=== ALL TESTS COMPLETE ===");` 직전)에 추가:

```js
// Test Phase 6.1: defaultHookState() returns expected schema
{
  // helper export 없으므로 hook 호출로 간접 검증
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  // meta.json도 hook-state.json도 없는 상태에서 UserPromptSubmit 호출
  run({ hook_event_name: "UserPromptSubmit", cwd: "/tmp/test-resume-panel" });
  const hs = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));
  assert.ok(hs.session_limits, "session_limits exists");
  assert.deepStrictEqual(hs.session_limits.gaps, { used: 0, max: 3, intentional: [] }, "default gaps");
  assert.ok(hs.gate_state, "gate_state exists");
  assert.strictEqual(hs.gate_state.direct_askuserquestion_streak, 0, "default streak 0");
  assert.deepStrictEqual(hs.gate_state.round_turn_counts, { "0": 1, "1": 0, "2": 0, "3": 0 }, "round 0 incremented by this UserPromptSubmit");
  assert.strictEqual(hs.profiler_score, 0, "default score 0");
  assert.deepStrictEqual(hs._score_reasons, [], "default reasons empty");
  console.log("PASS: Phase 6.1 — defaultHookState 스키마");
}
```

- [ ] **Step 2: 실패 확인**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | grep -E "(FAIL|Error|6.1)"`
Expected: FAIL — `hook-state.json` 파일이 존재하지 않음 (현재는 meta.json에만 씀).

- [ ] **Step 3: 경로 상수 + defaultHookState 추가**

`plugins/resume/scripts/episode-watcher.mjs` 상단의 경로 상수 블록(`const findingsPath = ...` 바로 다음)에 추가:

```js
const hookStatePath = join(stateDir, "hook-state.json");
```

`defaultGateState()` 함수 정의 직후에 신설:

```js
function defaultHookState() {
  return {
    session_limits: defaultSessionLimits(),
    gate_state: defaultGateState(),
    profiler_score: 0,
    _score_reasons: [],
  };
}
```

- [ ] **Step 4: 테스트는 아직 실패 (loadState 미구현)**

이 task는 토대만 깐다. Task 2에서 `loadState`로 hook-state.json 생성 로직 완성. Step 1의 테스트는 Task 2 완료 후 PASS 예정. 임시로 테스트 끝 한 줄을 주석화:

```js
// Phase 6.1 Task 2까지 보류 (loadState 미구현 상태에서는 fail)
// console.log("PASS: Phase 6.1 — defaultHookState 스키마");
```

대신 단위 검증으로 helper 추가만 확인:

```bash
node -e 'import("./plugins/resume/scripts/episode-watcher.mjs").catch(()=>{}); console.log("module loads ok")'
```

Expected: `module loads ok` (모듈 import 시 stdin 미입력으로 process.exit(0); 에러 없음).

- [ ] **Step 5: Commit**

```bash
git add plugins/resume/scripts/episode-watcher.mjs plugins/resume/scripts/test-episode-watcher.mjs
git commit -m "$(cat <<'EOF'
feat(resume): add hook-state.json path + defaultHookState helper

state isolation Task 1 — episode-watcher의 hook 관리 필드를 별도 파일로 분리하기 위한 토대.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `loadState` 첫 실행 — meta.json hook 필드 분리

**Files:**
- Modify: `plugins/resume/scripts/episode-watcher.mjs`
- Test: `plugins/resume/scripts/test-episode-watcher.mjs`

- [ ] **Step 1: 실패 테스트 추가**

테스트 파일에 추가 (Phase 6.1 직후):

```js
// Test Phase 6.2: loadState moves hook fields from meta.json to hook-state.json on first run
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  // 구 스키마 시뮬레이션: meta.json에 hook 필드와 콘텐츠 필드가 섞여 있음
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({
    current_company: "튜닙",
    current_round: 1,
    last_profiler_call: "2026-04-01T00:00:00Z",
    session_limits: { gaps: { used: 1, max: 3, intentional: [] }, perspectives: { used: 0, max: 2, episode_refs: [] }, contradictions: { used: 0, max: 2 }, reprobes: { used: 0, log: [] } },
    gate_state: {
      direct_askuserquestion_streak: 2,
      agent_calls_in_current_round: { senior: 1, "c-level": 0, recruiter: 0, hr: 0, "coffee-chat": 0 },
      round_turn_counts: { "0": 0, "1": 5, "2": 0, "3": 0 },
      retrospective_invoked: false,
      last_askuserquestion_source: null,
    },
    profiler_score: 3,
    _score_reasons: [{ delta: 1, reason: "AUQ", at: "2026-04-01T00:00:00Z" }],
    _last_high_finding_at: "2026-04-01T00:00:00Z",
    last_timeline_check: "2026-04-01T00:00:00Z",
    last_pattern_analysis_episode_count: 5,
    last_pattern_analysis_company_count: 2,
  }));

  // hook 호출 (UserPromptSubmit) — loadState가 분리해야 함
  run({ hook_event_name: "UserPromptSubmit", cwd: "/tmp/test-resume-panel" });

  const meta = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", "utf-8"));
  const hs = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));

  // meta.json: 콘텐츠 필드만 남음
  assert.strictEqual(meta.current_company, "튜닙", "meta.current_company 보존");
  assert.strictEqual(meta.current_round, 1, "meta.current_round 보존");
  assert.strictEqual(meta.last_profiler_call, "2026-04-01T00:00:00Z", "meta.last_profiler_call 보존");
  assert.strictEqual(meta.session_limits, undefined, "meta.session_limits 제거");
  assert.strictEqual(meta.gate_state, undefined, "meta.gate_state 제거");
  assert.strictEqual(meta.profiler_score, undefined, "meta.profiler_score 제거");
  assert.strictEqual(meta._score_reasons, undefined, "meta._score_reasons 제거");
  assert.strictEqual(meta._last_high_finding_at, undefined, "meta._last_high_finding_at 제거");
  assert.strictEqual(meta.last_timeline_check, undefined, "meta.last_timeline_check 제거");
  assert.strictEqual(meta.last_pattern_analysis_episode_count, undefined, "meta.last_pattern_analysis_episode_count 제거");
  assert.strictEqual(meta.last_pattern_analysis_company_count, undefined, "meta.last_pattern_analysis_company_count 제거");

  // hook-state.json: hook 필드 이전됨
  assert.strictEqual(hs.session_limits.gaps.used, 1, "hs.session_limits.gaps.used 이전");
  assert.strictEqual(hs.gate_state.direct_askuserquestion_streak, 2, "hs.gate_state.streak 이전");
  assert.strictEqual(hs.gate_state.agent_calls_in_current_round.senior, 1, "hs.gate_state.agent_calls 이전");
  assert.strictEqual(hs.gate_state.round_turn_counts["1"], 6, "hs.gate_state.round_turn_counts[1] 이전 + UserPromptSubmit +1");
  assert.strictEqual(hs.profiler_score, 3, "hs.profiler_score 이전");
  assert.strictEqual(hs._score_reasons.length, 1, "hs._score_reasons 이전");
  assert.strictEqual(hs._last_high_finding_at, "2026-04-01T00:00:00Z", "hs._last_high_finding_at 이전");
  assert.strictEqual(hs.last_timeline_check, "2026-04-01T00:00:00Z", "hs.last_timeline_check 이전");
  assert.strictEqual(hs.last_pattern_analysis_episode_count, 5, "hs.last_pattern_analysis_episode_count 이전");
  assert.strictEqual(hs.last_pattern_analysis_company_count, 2, "hs.last_pattern_analysis_company_count 이전");
  console.log("PASS: Phase 6.2 — loadState 첫 실행 분리");
}
```

- [ ] **Step 2: 실패 확인**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | grep -E "(FAIL|6.2)"`
Expected: FAIL — meta.json에 hook 필드가 그대로 남아 있음.

- [ ] **Step 3: `loadState` 신설 + UserPromptSubmit 분기에 적용**

`plugins/resume/scripts/episode-watcher.mjs`에서 `migrateMeta` 함수 직전에 신설:

```js
const HOOK_FIELDS = [
  "session_limits", "gate_state", "profiler_score",
  "_score_reasons", "_last_high_finding_at",
  "last_timeline_check", "last_pattern_analysis_episode_count",
  "last_pattern_analysis_company_count",
];

function loadState(base) {
  const meta = readJSON(metaPath) || {};
  let hookState = readJSON(hookStatePath);
  if (!hookState) hookState = defaultHookState();

  let metaChanged = false;
  for (const f of HOOK_FIELDS) {
    if (meta[f] !== undefined) {
      hookState[f] = meta[f];
      delete meta[f];
      metaChanged = true;
    }
  }

  // 옛 스키마 흡수: meta.json에 perspective_shifts_this_session 등 잔존 시 hookState로 옮김
  hookState = absorbLegacyFields(hookState, meta);
  // absorbLegacyFields가 meta에서 옛 필드를 삭제했는지 metaChanged 갱신
  for (const k of ["gap_probes_this_session", "perspective_shifts_this_session", "perspective_shifted_episodes", "contradictions_presented_this_session", "reprobe_log", "intentional_gaps"]) {
    if (meta[k] === undefined) continue; // already absorbed (shouldn't reach)
  }

  return { meta, hookState, metaChanged };
}

function saveMeta(base, meta) {
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

function saveHookState(base, hs) {
  writeFileSync(hookStatePath, JSON.stringify(hs, null, 2));
}

function absorbLegacyFields(hookState, meta) {
  // session_limits 보장
  if (!hookState.session_limits) hookState.session_limits = defaultSessionLimits();
  if (typeof meta.gap_probes_this_session === "number") {
    hookState.session_limits.gaps.used = meta.gap_probes_this_session;
    delete meta.gap_probes_this_session;
  }
  if (typeof meta.perspective_shifts_this_session === "number") {
    hookState.session_limits.perspectives.used = meta.perspective_shifts_this_session;
    delete meta.perspective_shifts_this_session;
  }
  if (Array.isArray(meta.perspective_shifted_episodes)) {
    hookState.session_limits.perspectives.episode_refs = meta.perspective_shifted_episodes;
    delete meta.perspective_shifted_episodes;
  }
  if (typeof meta.contradictions_presented_this_session === "number") {
    hookState.session_limits.contradictions.used = meta.contradictions_presented_this_session;
    delete meta.contradictions_presented_this_session;
  }
  if (Array.isArray(meta.reprobe_log)) {
    hookState.session_limits.reprobes.log = meta.reprobe_log;
    hookState.session_limits.reprobes.used = meta.reprobe_log.length;
    delete meta.reprobe_log;
  }
  if (Array.isArray(meta.intentional_gaps)) {
    hookState.session_limits.gaps.intentional = meta.intentional_gaps;
    delete meta.intentional_gaps;
  }
  // gate_state 보장
  if (!hookState.gate_state) hookState.gate_state = defaultGateState();
  return hookState;
}
```

UserPromptSubmit 분기(L33-49)를 다음으로 교체:

```js
if (input.hook_event_name === "UserPromptSubmit") {
  ensureStateDir();
  const { meta, hookState, metaChanged } = loadState(base);
  hookState.gate_state.round_turn_counts = hookState.gate_state.round_turn_counts || { "0": 0, "1": 0, "2": 0, "3": 0 };
  const round = String(meta.current_round ?? 0);
  hookState.gate_state.round_turn_counts[round] = (hookState.gate_state.round_turn_counts[round] || 0) + 1;

  const stats = readStats(base);
  ensureDebug(stats);
  stats._debug.observed_hook_events.UserPromptSubmit =
    (stats._debug.observed_hook_events.UserPromptSubmit || 0) + 1;

  saveHookState(base, hookState);
  if (metaChanged) saveMeta(base, meta);
  writeStats(base, stats);
  process.exit(0);
}
```

또한 Task 1에서 임시 주석 처리한 Phase 6.1 PASS 한 줄 다시 활성화:

```js
console.log("PASS: Phase 6.1 — defaultHookState 스키마");
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | grep -E "(FAIL|6\.1|6\.2)"`
Expected:
```
PASS: Phase 6.1 — defaultHookState 스키마
PASS: Phase 6.2 — loadState 첫 실행 분리
```

- [ ] **Step 5: Commit**

```bash
git add plugins/resume/scripts/episode-watcher.mjs plugins/resume/scripts/test-episode-watcher.mjs
git commit -m "$(cat <<'EOF'
feat(resume): introduce loadState splitting meta.json into hook-state.json

state isolation Task 2 — UserPromptSubmit 분기에 적용. 다른 7개 entry point는 후속 task에서 변환.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `loadState` idempotency

**Files:**
- Test: `plugins/resume/scripts/test-episode-watcher.mjs`

- [ ] **Step 1: 실패 테스트 추가**

```js
// Test Phase 6.3: loadState idempotent — 두 번째 호출은 meta.json에 이미 hook 필드 없음
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({
    current_company: "튜닙",
    profiler_score: 7,
  }));

  // 1차 호출 — migration 발생
  run({ hook_event_name: "UserPromptSubmit", cwd: "/tmp/test-resume-panel" });
  const meta1 = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", "utf-8"));
  const hs1 = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));
  assert.strictEqual(meta1.profiler_score, undefined, "1차: meta.profiler_score 제거");
  assert.strictEqual(hs1.profiler_score, 7, "1차: hs.profiler_score = 7");

  // 2차 호출 — meta.json에 이미 hook 필드 없음, hookState만 갱신
  run({ hook_event_name: "UserPromptSubmit", cwd: "/tmp/test-resume-panel" });
  const meta2 = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", "utf-8"));
  const hs2 = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));
  assert.deepStrictEqual(meta2, meta1, "2차: meta 동일");
  assert.strictEqual(hs2.profiler_score, 7, "2차: hs.profiler_score 보존 (migration 재발 안 됨)");
  assert.strictEqual(hs2.gate_state.round_turn_counts["0"], 2, "2차: round_turn_counts 정상 누적 (1+1)");
  console.log("PASS: Phase 6.3 — loadState idempotent");
}
```

- [ ] **Step 2: 실패 확인**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | grep -E "(FAIL|6.3)"`
Expected: PASS (이미 idempotent — Task 2에서 자동 보장됨). 만약 FAIL이면 절대 발생할 수 없음 — `loadState`는 hook 필드 잔존 시에만 이동하므로 두 번째 호출은 no-op.

- [ ] **Step 3: 변경 없음**

`loadState` 로직이 이미 idempotent. 별도 구현 불필요.

- [ ] **Step 4: 테스트 통과 확인**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | grep "6.3"`
Expected: `PASS: Phase 6.3 — loadState idempotent`

- [ ] **Step 5: Commit**

```bash
git add plugins/resume/scripts/test-episode-watcher.mjs
git commit -m "$(cat <<'EOF'
test(resume): verify loadState idempotency

state isolation Task 3 — 두 번째 호출에서 migration 재발하지 않음을 회귀로 고정.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `loadState` 옛 스키마 흡수

**Files:**
- Test: `plugins/resume/scripts/test-episode-watcher.mjs`

- [ ] **Step 1: 실패 테스트 추가**

```js
// Test Phase 6.4: loadState absorbs legacy fields into hookState.session_limits
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  // 옛 스키마: 평면 필드들이 meta.json에 있음
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({
    current_company: "튜닙",
    gap_probes_this_session: 2,
    perspective_shifts_this_session: 1,
    perspective_shifted_episodes: ["ep-001", "ep-002"],
    contradictions_presented_this_session: 1,
    reprobe_log: [{ episode: "ep-003", at: "2026-04-01" }],
    intentional_gaps: [{ from: "2024.01", to: "2024.06", reason: "휴직" }],
  }));

  run({ hook_event_name: "UserPromptSubmit", cwd: "/tmp/test-resume-panel" });

  const meta = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", "utf-8"));
  const hs = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));

  // 옛 필드들 모두 meta에서 제거됨
  assert.strictEqual(meta.gap_probes_this_session, undefined, "gap_probes_this_session 제거");
  assert.strictEqual(meta.perspective_shifts_this_session, undefined, "perspective_shifts_this_session 제거");
  assert.strictEqual(meta.perspective_shifted_episodes, undefined, "perspective_shifted_episodes 제거");
  assert.strictEqual(meta.contradictions_presented_this_session, undefined, "contradictions_presented_this_session 제거");
  assert.strictEqual(meta.reprobe_log, undefined, "reprobe_log 제거");
  assert.strictEqual(meta.intentional_gaps, undefined, "intentional_gaps 제거");
  assert.strictEqual(meta.current_company, "튜닙", "current_company 보존");

  // hookState.session_limits로 흡수됨
  assert.strictEqual(hs.session_limits.gaps.used, 2, "gaps.used 흡수");
  assert.strictEqual(hs.session_limits.perspectives.used, 1, "perspectives.used 흡수");
  assert.deepStrictEqual(hs.session_limits.perspectives.episode_refs, ["ep-001", "ep-002"], "episode_refs 흡수");
  assert.strictEqual(hs.session_limits.contradictions.used, 1, "contradictions.used 흡수");
  assert.strictEqual(hs.session_limits.reprobes.used, 1, "reprobes.used 흡수");
  assert.deepStrictEqual(hs.session_limits.reprobes.log[0].episode, "ep-003", "reprobes.log 흡수");
  assert.strictEqual(hs.session_limits.gaps.intentional.length, 1, "gaps.intentional 흡수");
  assert.strictEqual(hs.session_limits.gaps.intentional[0].from, "2024.01", "intentional 내용 보존");
  console.log("PASS: Phase 6.4 — loadState 옛 스키마 흡수");
}
```

- [ ] **Step 2: 실패 확인**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | grep -E "(FAIL|6.4)"`
Expected: PASS (Task 2의 `absorbLegacyFields`가 이미 처리). FAIL이면 absorbLegacyFields 점검.

- [ ] **Step 3: 변경 없음**

Task 2의 `absorbLegacyFields`가 이미 흡수 로직 포함. 추가 구현 불필요.

- [ ] **Step 4: 테스트 통과 확인**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | grep "6.4"`
Expected: `PASS: Phase 6.4 — loadState 옛 스키마 흡수`

- [ ] **Step 5: Commit**

```bash
git add plugins/resume/scripts/test-episode-watcher.mjs
git commit -m "$(cat <<'EOF'
test(resume): verify loadState absorbs legacy schema into hookState

state isolation Task 4 — gap_probes_this_session 등 평면 필드가 hook-state.json/session_limits로 이전됨을 회귀로 고정.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: malformed `hook-state.json` 백업 + 복구

**Files:**
- Modify: `plugins/resume/scripts/episode-watcher.mjs`
- Test: `plugins/resume/scripts/test-episode-watcher.mjs`

- [ ] **Step 1: 실패 테스트 추가**

```js
// Test Phase 6.5: malformed hook-state.json → backup + default 복구
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({ current_company: "튜닙" }));
  writeFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "{ broken json");

  run({ hook_event_name: "UserPromptSubmit", cwd: "/tmp/test-resume-panel" });

  const hs = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));
  assert.strictEqual(hs.profiler_score, 0, "default profiler_score 0");
  assert.strictEqual(hs.gate_state.round_turn_counts["0"], 1, "round_turn_counts 정상 +1");

  // 백업 파일이 생성됨
  const bakFiles = require("node:fs").readdirSync("/tmp/test-resume-panel/.resume-panel/")
    .filter(f => f.startsWith("hook-state.json.bak."));
  assert.strictEqual(bakFiles.length, 1, "백업 파일 1개 생성");
  console.log("PASS: Phase 6.5 — malformed hook-state.json 백업 + 복구");
}
```

`require`가 ESM에서 안 되므로 테스트 파일 상단의 import에 `readdirSync` 추가:

```js
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
```

테스트 본문 `require("node:fs").readdirSync` → `readdirSync`.

- [ ] **Step 2: 실패 확인**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | grep -E "(FAIL|6.5)"`
Expected: FAIL — backup 파일 생성 안 됨, 또는 broken json으로 hook이 crash.

- [ ] **Step 3: `loadState` malformed 처리 추가**

`plugins/resume/scripts/episode-watcher.mjs`의 `loadState` 함수에서 hook-state 읽기 부분 수정:

```js
function loadState(base) {
  const meta = readJSON(metaPath) || {};
  let hookState;
  try {
    hookState = readJSON(hookStatePath);
  } catch {
    hookState = null;
  }
  // readJSON이 try/catch로 null 반환하므로 별도 검증
  if (existsSync(hookStatePath) && hookState === null) {
    // 파일은 있는데 파싱 실패 → 백업 후 default
    const bakPath = `${hookStatePath}.bak.${Date.now()}`;
    try {
      const raw = readFileSync(hookStatePath, "utf-8");
      writeFileSync(bakPath, raw);
    } catch {}
  }
  if (!hookState) hookState = defaultHookState();

  let metaChanged = false;
  for (const f of HOOK_FIELDS) {
    if (meta[f] !== undefined) {
      hookState[f] = meta[f];
      delete meta[f];
      metaChanged = true;
    }
  }
  hookState = absorbLegacyFields(hookState, meta);

  return { meta, hookState, metaChanged };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | grep "6.5"`
Expected: `PASS: Phase 6.5 — malformed hook-state.json 백업 + 복구`

- [ ] **Step 5: Commit**

```bash
git add plugins/resume/scripts/episode-watcher.mjs plugins/resume/scripts/test-episode-watcher.mjs
git commit -m "$(cat <<'EOF'
feat(resume): backup + recover from malformed hook-state.json

state isolation Task 5 — 손상된 JSON 시 timestamp suffix 백업 후 default로 복구. 사용자가 진단 가능하면서 hook은 계속 동작.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: 나머지 entry points 리팩토링 (전반부)

**Files:**
- Modify: `plugins/resume/scripts/episode-watcher.mjs`

Task/Agent 분기, AskUserQuestion 분기, isResumeSourceChange 분기를 `loadState`로 변환.

- [ ] **Step 1: 회귀 baseline 확인**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | tail -3`
Expected: `=== ALL TESTS COMPLETE ===` (현재 PASS 수: 86 — 5.x 28 + 6.1~6.5 5 + 기존 53. 정확한 수는 출력으로 확인).

- [ ] **Step 2: Task/Agent 분기 변환**

`plugins/resume/scripts/episode-watcher.mjs`의 `if (toolName === "Task" || toolName === "Agent")` 블록(L82-110, Task 1 cleanup commit 이후 라인)을 다음으로 교체:

```js
if (toolName === "Task" || toolName === "Agent") {
  const subagent = toolInput.subagent_type || "";
  const knownAgents = ["senior", "c-level", "recruiter", "hr", "coffee-chat"];
  ensureStateDir();
  const { meta, hookState, metaChanged } = loadState(base);

  const stats = readStats(base);
  ensureDebug(stats);
  stats._debug.observed_tool_names[toolName] = (stats._debug.observed_tool_names[toolName] || 0) + 1;

  if (knownAgents.includes(subagent)) {
    hookState.gate_state.agent_calls_in_current_round[subagent] =
      (hookState.gate_state.agent_calls_in_current_round[subagent] || 0) + 1;
    hookState.gate_state.direct_askuserquestion_streak = 0;
    stats.agent_invocations[subagent] = (stats.agent_invocations[subagent] || 0) + 1;
  } else if (subagent === "retrospective") {
    hookState.gate_state.retrospective_invoked = true;
    stats.agent_invocations.retrospective = (stats.agent_invocations.retrospective || 0) + 1;
  } else if (subagent === "researcher" || subagent === "project-researcher") {
    stats.agent_invocations.researcher = (stats.agent_invocations.researcher || 0) + 1;
  }

  saveHookState(base, hookState);
  if (metaChanged) saveMeta(base, meta);
  writeStats(base, stats);
  process.exit(0);
}
```

- [ ] **Step 3: AskUserQuestion 분기 변환**

`if (toolName === "AskUserQuestion")` 블록 전체를 다음으로 교체. `meta.gate_state` → `hookState.gate_state`, `meta.profiler_score` → `hookState.profiler_score`, `addProfilerScore(meta, ...)` → `addProfilerScore(hookState, ...)`, `meta._last_high_finding_at` → `hookState._last_high_finding_at`, `meta.current_round` → `meta.current_round` (read-only):

```js
if (toolName === "AskUserQuestion") {
  ensureStateDir();
  const { meta, hookState, metaChanged } = loadState(base);

  const source = hookState.gate_state.last_askuserquestion_source;
  const isWhitelist = source && source.source === "whitelist";
  const isAgent = source && source.source === "agent";

  if (isWhitelist || isAgent) {
    hookState.gate_state.direct_askuserquestion_streak = 0;
  } else {
    hookState.gate_state.direct_askuserquestion_streak++;
  }
  hookState.gate_state.last_askuserquestion_source = null;

  // session-stats 집계
  {
    const stats = readStats(base);
    stats.askuserquestion.total++;
    const sourceKind = isWhitelist ? "whitelist" : (isAgent ? "agent" : "orchestrator_direct");
    stats.askuserquestion.by_source[sourceKind] =
      (stats.askuserquestion.by_source[sourceKind] || 0) + 1;
    writeStats(base, stats);
  }

  // 프로파일러 가중치 — AUQ 1회 +1
  addProfilerScore(hookState, 1, "AUQ");

  // HIGH finding 60초 이내 보너스 +2
  if (hookState._last_high_finding_at) {
    const elapsed = Date.now() - new Date(hookState._last_high_finding_at).getTime();
    if (elapsed >= 0 && elapsed < 60_000) {
      addProfilerScore(hookState, 2, "HIGH finding 60초 이내 (+2)");
    }
  }

  // 임계 도달 시 trigger emit + 리셋
  const profilerMessages = [];
  if (hookState.profiler_score >= 5) {
    profilerMessages.push(emit({
      type: "profiler_trigger",
      delta: (hookState._score_reasons || []).slice(-5).map(r => r.reason).join(", "),
      score: hookState.profiler_score,
      source: "AUQ",
    }));
    hookState.profiler_score = 0;
  }

  saveHookState(base, hookState);
  if (metaChanged) saveMeta(base, meta);

  // Collect violations
  const violations = [];

  // G1: r1_entry
  if (meta.current_round === 1 &&
      (hookState.gate_state.agent_calls_in_current_round.senior || 0) === 0 &&
      (hookState.gate_state.agent_calls_in_current_round["c-level"] || 0) === 0 &&
      !isWhitelist && !isAgent) {
    violations.push({
      type: "gate_violation",
      gate: "r1_entry",
      company: meta.current_company || null,
    });
  }

  // G2: direct_question_burst
  if (hookState.gate_state.direct_askuserquestion_streak >= 3) {
    violations.push({
      type: "gate_violation",
      gate: "direct_question_burst",
      count: hookState.gate_state.direct_askuserquestion_streak,
    });
  }

  if (violations.length > 0 || profilerMessages.length > 0) {
    if (violations.length > 0) {
      const statsForViolation = readStats(base);
      for (const v of violations) {
        statsForViolation.gate_violations.push({
          gate: v.gate,
          at: new Date().toISOString(),
          detail: { company: v.company, count: v.count, missing: v.missing },
        });
      }
      writeStats(base, statsForViolation);
    }
    const violationLines = violations.map(v => `[resume-panel]${JSON.stringify(v)}`);
    const allMessages = [...violationLines, ...profilerMessages];
    process.stdout.write(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: allMessages.join("\n\n"),
      },
    }));
  }
  process.exit(0);
}
```

- [ ] **Step 4: 회귀 테스트 통과 확인**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | grep -c "^PASS:"`
Expected: 모든 PASS 유지 (Task 5까지 추가된 87 또는 그 이상). FAIL이 있으면 수정 후 재실행.

특히 Phase 5.5/5.5b/5.6a/5.6b/5.6c (AUQ 가중치 관련)가 PASS인지 확인:

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | grep -E "5\.[567]"`
Expected: 모두 PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/resume/scripts/episode-watcher.mjs
git commit -m "$(cat <<'EOF'
refactor(resume): convert Task/Agent + AskUserQuestion branches to loadState

state isolation Task 6 — gate_state, profiler_score, _score_reasons, _last_high_finding_at를 hookState로 이전. 회귀 테스트 모두 통과.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: 나머지 entry points 리팩토링 (후반부)

**Files:**
- Modify: `plugins/resume/scripts/episode-watcher.mjs`

isResumeSourceChange (첫 실행 + 후속), round-transition, session-end, finding 라우팅 분기를 `loadState`로 변환.

- [ ] **Step 1: 회귀 baseline 확인**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | grep -c "^PASS:"`
Expected: Task 6과 동일한 수.

- [ ] **Step 2: isResumeSourceChange 분기 변환**

`if (isResumeSourceChange)` 블록 전체에서 `migrateMeta` 호출 2곳을 `loadState`로 교체. `metaJSON`을 그대로 유지하되 hook 관리 필드는 hookState로 변경:

기존 첫 실행 분기(스냅샷 없음):

```js
const metaJSON = readJSON(metaPath) || {};
writeFileSync(snapshotPath, JSON.stringify({...}));
const metaMigrated = migrateMeta(metaJSON);
if (metaMigrated.profiler_score === undefined) metaMigrated.profiler_score = 0;
writeFileSync(metaPath, JSON.stringify(metaMigrated, null, 2));
```

다음으로 교체:

```js
const { meta: metaJSON, hookState, metaChanged } = loadState(base);
writeFileSync(snapshotPath, JSON.stringify({
  episode_count: currentCount,
  project_names: currentProjects,
  meta_hash: currentHash,
  star_gaps: countStarGaps(source),
  current_company: metaJSON?.current_company || null,
}));
saveHookState(base, hookState);
if (metaChanged) saveMeta(base, metaJSON);
```

기존 후속 분기(스냅샷 있음):

```js
const metaJSON = migrateMeta(readJSON(metaPath) || {});
const reasons = [];
const episodeDelta = currentCount - (snapshot.episode_count || 0);
if (episodeDelta > 0) {
  addProfilerScore(metaJSON, episodeDelta, `에피소드 +${episodeDelta}`);
  reasons.push(`에피소드 +${episodeDelta}`);
}
// ... (나머지 가중치들)
```

다음으로 교체 — `metaJSON.profiler_score` → `hookState.profiler_score`, `addProfilerScore(metaJSON, ...)` → `addProfilerScore(hookState, ...)`, `metaJSON.intentional_gaps` 등은 이미 hookState로 옮겨졌으므로 `hookState.session_limits.gaps.intentional` 사용:

```js
const { meta: metaJSON, hookState, metaChanged } = loadState(base);
const reasons = [];

const episodeDelta = currentCount - (snapshot.episode_count || 0);
if (episodeDelta > 0) {
  addProfilerScore(hookState, episodeDelta, `에피소드 +${episodeDelta}`);
  reasons.push(`에피소드 +${episodeDelta}`);
}

const snapshotProjects = new Set(snapshot.project_names || []);
const hasNewProject = currentProjects.some((p) => !snapshotProjects.has(p));
if (hasNewProject) {
  addProfilerScore(hookState, 3, "새 프로젝트 (+3)");
  reasons.push("새 프로젝트 (+3)");
}

const currentStarGaps = countStarGaps(source);
const prevStarGaps = snapshot.star_gaps || 0;
if (currentStarGaps > prevStarGaps) {
  addProfilerScore(hookState, 2, "빈 STAR 증가 (+2)");
  reasons.push("빈 STAR 증가 (+2)");
}

if (detectMinimization(source, snapshot)) {
  addProfilerScore(hookState, 2, "역할 축소 신호 (+2)");
  reasons.push("역할 축소 신호 (+2)");
}

if (currentHash !== snapshot.meta_hash) {
  addProfilerScore(hookState, 2, "meta 변경 (+2)");
  reasons.push("meta 변경 (+2)");
}

const THRESHOLD = 5;
if (hookState.profiler_score >= THRESHOLD) {
  const starGaps = countStarGaps(source);
  const companyCount = getCompanyCount(source);
  const patternEligible = currentCount >= 3 && companyCount >= 2;
  messages.push(
    emit({
      type: "profiler_trigger",
      delta: reasons.join(", "),
      score: hookState.profiler_score,
      episode_count: currentCount,
      star_gaps: starGaps,
      project_count: currentProjects.length,
      pattern_eligible: patternEligible,
    })
  );

  const intentionalGaps = hookState.session_limits?.gaps?.intentional || [];
  const gaps = detectGaps(source);
  for (const gap of gaps) {
    const fromEnd = `${gap.from.end.year}.${String(gap.from.end.month).padStart(2, "0")}`;
    const toStart = `${gap.to.start.year}.${String(gap.to.start.month).padStart(2, "0")}`;
    const isIntentional = intentionalGaps.some(ig =>
      ig.from === fromEnd && ig.to === toStart
    );
    if (isIntentional) continue;

    const finding = {
      id: `tg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: "timeline_gap_found",
      urgency: "MEDIUM",
      source: "episode-watcher",
      message: `${fromEnd} ~ ${toStart} (${gap.months}개월) 공백: ${gap.from.project}(${gap.from.company}) 종료 후 ${gap.to.project}(${gap.to.company}) 시작 전`,
      context: {
        from_company: gap.from.company,
        from_project: gap.from.project,
        to_company: gap.to.company,
        to_project: gap.to.project,
        gap_months: gap.months,
        gap_type: gap.type,
      },
      created_at: new Date().toISOString(),
    };
    ensureStateDir();
    const line = JSON.stringify(finding) + "\n";
    writeFileSync(inboxPath, existsSync(inboxPath) ? readFileSync(inboxPath, "utf-8") + line : line);
  }

  const companyCountForMeta = getCompanyCount(source);
  if (currentCount >= 3 && companyCountForMeta >= 2) {
    hookState.last_pattern_analysis_episode_count = currentCount;
    hookState.last_timeline_check = new Date().toISOString();
  }

  hookState.profiler_score = 0;
}

if (!metaJSON.so_what_active?.active) {
  const prevCount = snapshot.episode_count || 0;
  let checked = 0;
  for (const project of getAllProjects(source)) {
    for (const ep of project.episodes || []) {
      checked++;
      if (checked <= prevCount) continue;
      if (!hasQuantifiedImpact(ep.star?.result || ep.result || "")) {
        messages.push(
          emit({
            type: "so_what",
            episode_title: ep.title || "(제목 없음)",
            level: 1,
            episode_ref: { company: project.companyName, project: project.name },
          })
        );
        addProfilerScore(hookState, 3, "so_what (+3)");
        break;
      }
    }
    if (messages.some(m => m.includes('"type":"so_what"'))) break;
  }
}

writeFileSync(snapshotPath, JSON.stringify({
  episode_count: currentCount,
  project_names: currentProjects,
  meta_hash: currentHash,
  star_gaps: countStarGaps(source),
  current_company: metaJSON?.current_company || null,
}));

saveHookState(base, hookState);
if (metaChanged) saveMeta(base, metaJSON);
```

- [ ] **Step 3: round-transition + session-end 분기 변환**

`if (targetPath === "round-transition")` 블록의 `migrateMeta(readJSON(metaPath) || {})` 호출을 `loadState`로 교체. `meta.gate_state` → `hookState.gate_state`:

```js
if (targetPath === "round-transition") {
  const transitionPath = join(stateDir, "round-transition.json");
  const transition = readJSON(transitionPath);
  if (transition && transition.to === 3) {
    ensureStateDir();
    const { meta, hookState, metaChanged } = loadState(base);
    const gs = hookState.gate_state || defaultGateState();
    const missing = [];
    if ((gs.agent_calls_in_current_round.recruiter || 0) === 0) missing.push("recruiter");
    if ((gs.agent_calls_in_current_round.hr || 0) === 0) missing.push("hr");
    if ((gs.round_turn_counts["2"] || 0) < 15) missing.push("turn_min");

    const source = readJSON(sourcePath);
    const ga = source?.gap_analysis;
    if (!ga || !Array.isArray(ga.met) || !Array.isArray(ga.gaps)) {
      missing.push("gap_analysis");
    }

    if (missing.length > 0) {
      messages.push(emit({
        type: "gate_violation",
        gate: "r2_exit",
        missing,
      }));
      const stats = readStats(base);
      stats.gate_violations.push({
        gate: "r2_exit",
        at: new Date().toISOString(),
        detail: { missing },
      });
      writeStats(base, stats);
    }
    if (metaChanged) saveMeta(base, meta);
    try { unlinkSync(transitionPath); } catch {}
  }
}
```

`if (targetPath === "session-end")` 블록도 동일 패턴:

```js
if (targetPath === "session-end") {
  const sessionEndPath = join(stateDir, "session-end.json");
  ensureStateDir();
  const { meta, hookState, metaChanged } = loadState(base);
  const gs = hookState.gate_state || defaultGateState();
  if (!gs.retrospective_invoked) {
    messages.push(emit({
      type: "gate_violation",
      gate: "retrospective_skipped",
    }));
    const stats = readStats(base);
    stats.gate_violations.push({
      gate: "retrospective_skipped",
      at: new Date().toISOString(),
      detail: {},
    });
    writeStats(base, stats);
  }
  if (metaChanged) saveMeta(base, meta);
  try { unlinkSync(sessionEndPath); } catch {}
}
```

- [ ] **Step 4: finding 라우팅 분기 변환**

기존 finding 라우팅 끝부분의 `migrateMeta(readJSON(metaPath) || {})` 사용을 `loadState`로 교체. `_last_high_finding_at`와 `addProfilerScore` 모두 hookState 대상:

```js
if (highFindingDelivered || scoreDeltas.length > 0) {
  const { meta: metaForUpdate, hookState: hsForUpdate, metaChanged: hsMetaChanged } = loadState(base);
  if (highFindingDelivered) {
    hsForUpdate._last_high_finding_at = new Date().toISOString();
  }
  for (const d of scoreDeltas) {
    addProfilerScore(hsForUpdate, d.delta, d.reason);
  }
  saveHookState(base, hsForUpdate);
  if (hsMetaChanged) saveMeta(base, metaForUpdate);
}
```

- [ ] **Step 5: 회귀 테스트 통과 확인 + commit**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | grep -c "^PASS:"; node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | grep -c "^FAIL:"`
Expected: PASS 수 유지, FAIL=0.

```bash
git add plugins/resume/scripts/episode-watcher.mjs
git commit -m "$(cat <<'EOF'
refactor(resume): convert remaining branches to loadState

state isolation Task 7 — isResumeSourceChange (첫 실행 + 후속), round-transition, session-end, finding 라우팅 모두 loadState/saveHookState/saveMeta 패턴으로 변환. migrateMeta 호출 사이트 0개.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `migrateMeta` 함수 제거

**Files:**
- Modify: `plugins/resume/scripts/episode-watcher.mjs`

- [ ] **Step 1: 호출 사이트 0개 확인**

Run: `grep -n "migrateMeta(" plugins/resume/scripts/episode-watcher.mjs`
Expected: 함수 정의(`function migrateMeta(meta) {`) 1줄만 출력. 호출 0개.

- [ ] **Step 2: `migrateMeta` 함수 본체 삭제**

`plugins/resume/scripts/episode-watcher.mjs`에서 `function migrateMeta(meta) { ... }` 함수 전체 블록 삭제 (`function migrateMeta` 부터 그에 매칭되는 닫는 `}`까지).

- [ ] **Step 3: 회귀 테스트 통과 확인**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | tail -3`
Expected: `=== ALL TESTS COMPLETE ===` + 모든 PASS 유지.

- [ ] **Step 4: 함수 제거 확인**

Run: `grep -n "function migrateMeta\|migrateMeta(" plugins/resume/scripts/episode-watcher.mjs`
Expected: 출력 없음.

- [ ] **Step 5: Commit**

```bash
git add plugins/resume/scripts/episode-watcher.mjs
git commit -m "$(cat <<'EOF'
chore(resume): remove migrateMeta — fully replaced by loadState

state isolation Task 8 — 모든 호출 사이트가 loadState로 변환 완료. 함수 본체 삭제로 코드 최소화.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: profiler 시뮬레이션 통합 테스트

**Files:**
- Test: `plugins/resume/scripts/test-episode-watcher.mjs`

- [ ] **Step 1: 실패 테스트 추가**

```js
// Test Phase 6.6: profiler가 meta.json을 통째 덮어써도 hook-state.json 무영향
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });

  // 초기: hook이 hook-state.json에 점수 누적
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({
    current_company: "튜닙",
    current_round: 1,
  }));
  writeFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", JSON.stringify({
    session_limits: defaultSessionLimits_forTest(),
    gate_state: defaultGateStateForTest(),
    profiler_score: 4,
    _score_reasons: [{ delta: 2, reason: "AUQ", at: "2026-04-01T00:00:00Z" }],
    _last_high_finding_at: "2026-04-01T00:00:00Z",
  }));

  // profiler 시뮬레이션: meta.json 통째 덮어쓰기 (heredoc 패턴)
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({
    last_profiler_call: "2026-04-02T00:00:00Z",
    last_profiler_episode_count: 12,
    current_company: "튜닙",
    total_profiler_calls: 1,
  }));

  // 다음 hook 호출 (UserPromptSubmit)
  run({ hook_event_name: "UserPromptSubmit", cwd: "/tmp/test-resume-panel" });

  const meta = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", "utf-8"));
  const hs = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));

  // hook-state.json: profiler 덮어쓰기와 무관하게 보존
  assert.strictEqual(hs.profiler_score, 4, "profiler_score 보존");
  assert.strictEqual(hs._score_reasons.length, 1, "_score_reasons 보존");
  assert.strictEqual(hs._last_high_finding_at, "2026-04-01T00:00:00Z", "_last_high_finding_at 보존");

  // meta.json: profiler가 쓴 콘텐츠 필드 그대로 + UserPromptSubmit이 round_turn_counts만 hookState에 +1
  assert.strictEqual(meta.last_profiler_call, "2026-04-02T00:00:00Z", "profiler 필드 보존");
  assert.strictEqual(meta.total_profiler_calls, 1, "total_profiler_calls 보존");
  assert.strictEqual(hs.gate_state.round_turn_counts["1"], 1, "round_turn_counts 정상 +1");
  console.log("PASS: Phase 6.6 — profiler 통째 덮어쓰기 격리");
}
```

테스트 파일 상단에 헬퍼 추가 필요 (`defaultGateStateForTest`는 이미 있음, `defaultSessionLimits_forTest` 신설):

```js
function defaultSessionLimits_forTest() {
  return {
    gaps: { used: 0, max: 3, intentional: [] },
    perspectives: { used: 0, max: 2, episode_refs: [] },
    contradictions: { used: 0, max: 2 },
    reprobes: { used: 0, log: [] },
  };
}
```

- [ ] **Step 2: 실패 확인**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | grep -E "(FAIL|6.6)"`
Expected: PASS — Task 1-7로 격리 메커니즘이 이미 완성되어 있어 즉시 PASS. 만약 FAIL이면 saveMeta가 hook 필드를 다시 쓰는지 점검.

- [ ] **Step 3: 변경 없음**

격리 동작이 이미 보장됨. 추가 구현 불필요.

- [ ] **Step 4: 테스트 통과 확인**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | grep "6.6"`
Expected: `PASS: Phase 6.6 — profiler 통째 덮어쓰기 격리`

- [ ] **Step 5: Commit**

```bash
git add plugins/resume/scripts/test-episode-watcher.mjs
git commit -m "$(cat <<'EOF'
test(resume): integration test — profiler heredoc overwrite isolated from hook-state

state isolation Task 9 — profiler가 cat <<EOF > meta.json으로 통째 덮어써도 hook-state.json의 profiler_score, _score_reasons, _last_high_finding_at가 보존됨을 회귀로 고정.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: pattern_detected 라우팅 통합 테스트

**Files:**
- Test: `plugins/resume/scripts/test-episode-watcher.mjs`

- [ ] **Step 1: 실패 테스트 추가**

```js
// Test Phase 6.7: pattern_detected (MEDIUM) routing — company 변경 시 라우팅
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });

  // snapshot에 이전 company "A"
  writeFileSync("/tmp/test-resume-panel/.resume-panel/snapshot.json", JSON.stringify({
    episode_count: 0, project_names: [], meta_hash: "x",
    star_gaps: 0, current_company: "A",
  }));
  // meta에 새 company "B" — profiler가 반영했다고 가정
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({
    current_company: "B",
  }));
  // profiler가 inbox에 pt-... append (echo >> 패턴 시뮬레이션)
  writeFileSync("/tmp/test-resume-panel/.resume-panel/findings-inbox.jsonl",
    JSON.stringify({
      id: "pt-test-001",
      type: "pattern_detected",
      urgency: "MEDIUM",
      source: "profiler",
      message: "패턴 발견: '레거시 시스템 현대화' — A(p1), B(p2)에서 반복",
      context: {
        pattern_name: "레거시 시스템 현대화",
        category: "역할반복",
        evidence_episodes: [
          { company: "A", project: "p1", episode: "ep1" },
          { company: "B", project: "p2", episode: "ep2" },
        ],
        unexplored_company: null,
        suggested_question: "C에서도 비슷한 경험?",
        target_agent: "시니어",
      },
      created_at: "2026-04-01T00:00:00Z",
    }) + "\n"
  );

  // hook 호출 (resume-source.json 변경 트리거 — 라우팅 path 진입)
  const result = run({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "echo done > resume-source.json" },
    cwd: "/tmp/test-resume-panel",
  });

  // findings.json에 delivered=true로 적재됨
  const findings = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/findings.json", "utf-8"));
  const target = findings.findings.find(f => f.id === "pt-test-001");
  assert.ok(target, "pattern_detected finding이 findings.json에 적재됨");
  assert.strictEqual(target.delivered, true, "MEDIUM company 변경 → delivered true");

  // additionalContext에 finding 메시지 포함
  const ctx = result?.hookSpecificOutput?.additionalContext || "";
  assert.ok(ctx.includes('"finding_type":"pattern_detected"'), "라우팅 메시지에 pattern_detected 포함");
  assert.ok(ctx.includes('"id":"pt-test-001"'), "라우팅 메시지에 finding id 포함");

  // snapshot의 current_company도 "B"로 동기화됨
  const snapAfter = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/snapshot.json", "utf-8"));
  assert.strictEqual(snapAfter.current_company, "B", "snapshot.current_company 동기화");
  console.log("PASS: Phase 6.7 — pattern_detected MEDIUM 라우팅");
}
```

- [ ] **Step 2: 실패 확인**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | grep -E "(FAIL|6.7)"`
Expected: PASS — 기존 finding 라우팅 로직이 이미 MEDIUM + companyChanged 처리. FAIL이면 finding 라우팅 분기(Task 7 step 4) 변환 점검.

- [ ] **Step 3: 변경 없음**

라우팅 로직 이미 완성. 추가 구현 불필요.

- [ ] **Step 4: 테스트 통과 확인**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | grep "6.7"`
Expected: `PASS: Phase 6.7 — pattern_detected MEDIUM 라우팅`

- [ ] **Step 5: Commit**

```bash
git add plugins/resume/scripts/test-episode-watcher.mjs
git commit -m "$(cat <<'EOF'
test(resume): integration test — pattern_detected MEDIUM routing on company change

state isolation Task 10 — 이슈 4 검증. profiler가 inbox에 pt-... append + company 변경 시 hook이 MEDIUM으로 라우팅하여 findings.json에 delivered=true로 적재됨을 회귀로 고정.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: profiler.md 가이드 갱신

**Files:**
- Modify: `plugins/resume/.claude/agents/profiler.md`

- [ ] **Step 1: §269-282 read-modify-write 강제로 교체**

`plugins/resume/.claude/agents/profiler.md`의 "### 7. meta.json 갱신" 섹션 (기존 §255-282)을 다음으로 교체:

````markdown
### 7. meta.json 갱신

분석 완료 후 `.resume-panel/meta.json`을 갱신한다. **반드시 read-modify-write 패턴**으로 자기 필드만 갱신한다 (기존 필드 보존):

```bash
node -e '
  const fs=require("fs"), p=".resume-panel/meta.json";
  const m=fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,"utf-8")) : {};
  m.last_profiler_call=new Date().toISOString();
  m.last_profiler_episode_count=12;
  m.current_company="튜닙";
  m.total_profiler_calls=(m.total_profiler_calls||0)+1;
  fs.writeFileSync(p, JSON.stringify(m,null,2));
'
```

패턴 분석 실행 시: `last_pattern_analysis_episode_count`, `last_pattern_analysis_company_count`, `last_timeline_check`는 **hook-state.json**에 hook이 자동 기록한다. profiler가 직접 쓸 필요 없음.

**절대 금지**:
- `cat <<EOF > .resume-panel/meta.json` 같은 통째 덮어쓰기. 다른 필드(`current_round`, `so_what_active` 등)가 손실된다.
- `.resume-panel/hook-state.json` write. 이 파일은 episode-watcher hook이 단독 관리하며 profiler는 read-only로만 참조 가능.
````

- [ ] **Step 2: §164·166·236 옛 필드 참조 갱신**

§164 (관점 전환 금지사항):

```diff
- 세션당 2개 초과 관점 전환 finding 생성 금지 (meta.json의 perspective_shifts_this_session 확인)
+ 세션당 2개 초과 관점 전환 finding 생성 금지 (hook-state.json의 session_limits.perspectives.used 확인)
```

§166:

```diff
- 이미 관점 전환한 에피소드 재탐지 금지 (meta.json의 perspective_shifted_episodes 확인)
+ 이미 관점 전환한 에피소드 재탐지 금지 (hook-state.json의 session_limits.perspectives.episode_refs 확인)
```

§236 (모순 탐지 금지사항):

```diff
- meta.json의 `contradictions_presented_this_session`이 2 이상이면 새 모순 finding을 생성하지 않는다
+ hook-state.json의 `session_limits.contradictions.used`가 2 이상이면 새 모순 finding을 생성하지 않는다
```

- [ ] **Step 3: 검증**

Run: `grep -E "perspective_shifts_this_session|perspective_shifted_episodes|contradictions_presented_this_session" plugins/resume/.claude/agents/profiler.md`
Expected: 출력 없음 (옛 필드 참조 모두 제거됨).

Run: `grep -c "hook-state.json" plugins/resume/.claude/agents/profiler.md`
Expected: 4 이상 (read-modify-write 섹션 + 3개 옛 필드 참조 + 금지사항).

- [ ] **Step 4: 기존 hook 테스트 영향 없음 확인**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | grep -c "^FAIL:"`
Expected: 0.

- [ ] **Step 5: Commit**

```bash
git add plugins/resume/.claude/agents/profiler.md
git commit -m "$(cat <<'EOF'
docs(resume): profiler.md — read-modify-write meta.json + hook-state.json read-only

state isolation Task 11 — heredoc 통째 덮어쓰기 패턴을 node 한 줄 read-modify-write로 강제. 옛 필드 참조 (perspective_shifts_this_session 등)를 신 경로 (hook-state.json/session_limits)로 갱신. hook-state.json write 금지 명시.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: storage.md / hook-protocol.md / agent-contract.md 동기화

**Files:**
- Modify: `plugins/resume/skills/resume-panel/references/storage.md`
- Modify: `plugins/resume/skills/resume-panel/references/hook-protocol.md`
- Modify: `plugins/resume/skills/resume-panel/references/agent-contract.md`

- [ ] **Step 1: storage.md에 hook-state.json 추가**

`plugins/resume/skills/resume-panel/references/storage.md` 파일을 Read로 확인 후, `.resume-panel/` 파일 목록 섹션에 `hook-state.json` 항목 신설. 다음 표 삽입:

```markdown
### `hook-state.json` (신규, 2026-05-07~)

episode-watcher hook이 단독 관리하는 메커니즘 상태. profiler/orchestrator는 read-only로만 참조.

| 필드 | 용도 |
|---|---|
| `session_limits.gaps` | gap probe 카운터 + 의도된 gap 목록 (`{used, max, intentional}`) |
| `session_limits.perspectives` | 관점 전환 사용 수 + episode_refs (`{used, max, episode_refs}`) |
| `session_limits.contradictions` | 모순 제시 카운터 (`{used, max}`) |
| `session_limits.reprobes` | 재프로빙 로그 (`{used, log}`) |
| `gate_state.direct_askuserquestion_streak` | G2 burst 감지 |
| `gate_state.agent_calls_in_current_round` | 라운드별 에이전트 호출 카운터 |
| `gate_state.round_turn_counts` | UserPromptSubmit 1회 = 1 turn |
| `gate_state.retrospective_invoked` | G4 회고 누락 감지 |
| `gate_state.last_askuserquestion_source` | AUQ 출처 (whitelist/agent/orchestrator_direct) |
| `profiler_score` | 모델 B 점수 (THRESHOLD=5) |
| `_score_reasons` | rolling 10 가산 사유 |
| `_last_high_finding_at` | HIGH finding 60s 보너스 윈도 |
| `last_timeline_check` | timeline gap 분석 시점 |
| `last_pattern_analysis_episode_count` | 패턴 분석 trigger 시점 에피소드 수 |
| `last_pattern_analysis_company_count` | 패턴 분석 trigger 시점 회사 수 |

writer: episode-watcher hook 단독. 다른 주체 write 금지.
```

또한 기존 `meta.json` 섹션에서 위 필드 목록 제거 (이미 분리됨을 명시).

- [ ] **Step 2: hook-protocol.md에 pattern_detected cross-reference 추가**

`plugins/resume/skills/resume-panel/references/hook-protocol.md`에서 `pattern_detected` (MEDIUM) 처리 패턴 다음에 한 단락 추가:

```markdown
**발행 주체**: profiler agent — `.claude/agents/profiler.md` §2.6 "크로스 컴퍼니 패턴 분석" 결과를 `findings-inbox.jsonl`에 append (Bash echo 패턴).
**라우팅 주체**: episode-watcher hook (`scripts/episode-watcher.mjs` finding 라우팅 분기). MEDIUM은 `current_company` 변경 시점에 라우팅.
**적재 위치**: `.resume-panel/findings.json` (delivered=true 플래그).
**형식 정의**: profiler.md `pt-{timestamp}` 산출 형식 (이 문서의 §finding 정의와 일치).
```

- [ ] **Step 3: agent-contract.md에 profiler 산출 형식 cross-reference**

`plugins/resume/skills/resume-panel/references/agent-contract.md`에서 profiler agent 섹션(또는 적절한 위치)에 cross-reference 표 추가:

```markdown
## profiler 산출 형식 cross-reference

profiler agent가 `findings-inbox.jsonl`에 append하는 finding 종류:

| id prefix | type | urgency | 발행 조건 |
|---|---|---|---|
| `pt-{ts}` | `pattern_detected` | MEDIUM | 에피소드 ≥3 + 회사 ≥2 + 패턴 발견 |
| `ps-{ts}` | `perspective_shift` | MEDIUM | 리더십/협업 에피소드 + 과소평가 신호 |
| `cd-{ts}` | `contradiction_detected` | HIGH (role_scope) / MEDIUM (기타) | claim NLI에서 CONTRADICTION |
| `tg-{ts}` | `timeline_gap_found` | MEDIUM | 회사 간 6개월+ 또는 회사 내 3개월+ gap |

세부 형식: `.claude/agents/profiler.md` §2.6 (pt-), §2.3 (ps-), §2.5 (cd-).
`tg-`는 episode-watcher hook이 직접 발행 (`scripts/episode-watcher.mjs` Timeline gap detection 분기).
```

- [ ] **Step 4: 검증**

Run: `grep -l "hook-state.json" plugins/resume/skills/resume-panel/references/*.md`
Expected: `storage.md` 출력.

Run: `grep -l "pattern_detected" plugins/resume/skills/resume-panel/references/*.md`
Expected: `hook-protocol.md` (그리고 `agent-contract.md`에 추가됐다면 그것도) 출력.

- [ ] **Step 5: Commit**

```bash
git add plugins/resume/skills/resume-panel/references/storage.md plugins/resume/skills/resume-panel/references/hook-protocol.md plugins/resume/skills/resume-panel/references/agent-contract.md
git commit -m "$(cat <<'EOF'
docs(resume): sync references for state isolation + pattern_detected

state isolation Task 12 — storage.md에 hook-state.json 분할 표 추가, hook-protocol.md/agent-contract.md에 pattern_detected 발행/라우팅 cross-reference 추가. 이슈 4 명세 동기화.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: 최종 회귀 + 검증 체크리스트 갱신

**Files:**
- Modify: `docs/superpowers/follow-ups/resume-system-deferred.md`

- [ ] **Step 1: 전체 테스트 통과 확인**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | tail -3`
Expected: `=== ALL TESTS COMPLETE ===`

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | grep -c "^PASS:"; node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | grep -c "^SKIP:"; node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | grep -c "^FAIL:"`
Expected: PASS ≥ 89, SKIP=1, FAIL=0.

- [ ] **Step 2: follow-up 문서에서 이슈 4·5 해소 표시**

`docs/superpowers/follow-ups/resume-system-deferred.md`에서 이슈 4와 이슈 5 섹션 끝에 다음 한 줄씩 추가:

```markdown
**상태 (2026-05-07)**: `2026-05-07-resume-state-isolation-design.md` spec으로 처리 완료. 다음 라이브 세션에서 검증.
```

이슈 4 섹션 끝과 이슈 5 섹션 끝 두 곳에.

- [ ] **Step 3: 라이브 검증 체크리스트에 신 항목 추가**

같은 파일의 "## 다음 라이브 세션 검증 체크리스트" 섹션 끝에 추가:

```markdown
- [ ] `.resume-panel/hook-state.json` 파일 존재. session_limits, gate_state, profiler_score 모두 hook-state.json에 위치 (meta.json엔 없음).
- [ ] profiler 호출 후에도 `hook-state.json.profiler_score`, `_score_reasons`, `_last_high_finding_at` 보존 (이전엔 매 사이클 리셋).
- [ ] `findings.json`에 `pattern_detected` (pt-) finding이 라우팅된 흔적 존재 (delivered=true). 회사 전환 시점에 발생.
- [ ] `meta.json`에 `session_limits`, `gate_state` 같은 hook 필드가 잔존하지 않음 (loadState idempotent 검증).
```

- [ ] **Step 4: 검증**

Run: `grep -A 2 "이슈 4" docs/superpowers/follow-ups/resume-system-deferred.md | grep "2026-05-07"`
Expected: 일치 줄 출력.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/follow-ups/resume-system-deferred.md
git commit -m "$(cat <<'EOF'
docs(resume): mark issues 4·5 as addressed by state isolation spec

state isolation Task 13 — follow-up 문서에 이슈 4·5 해소 상태 기록 + 다음 라이브 세션 검증 체크리스트에 hook-state.json 분리 검증 항목 추가.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 완료 체크리스트

- [ ] 13 task 모두 PASS, FAIL=0
- [ ] migrateMeta 함수 제거 확인
- [ ] hook-state.json 신규 생성 확인 (테스트에서)
- [ ] profiler.md / storage.md / hook-protocol.md / agent-contract.md 동기화 완료
- [ ] follow-up 문서에 이슈 4·5 해소 상태 기록
