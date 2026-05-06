# Resume Plugin Counter Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** resume 플러그인의 hook 측정 신뢰도(`agent_invocations`, `round_turn_counts`)를 회복하고, 프로파일러 트리거 가중치 모델을 인터뷰 활동(AUQ + finding 중요도)까지 반영하도록 확장.

**Architecture:** 단일 `episode-watcher.mjs`가 PostToolUse + UserPromptSubmit 두 hook 이벤트를 `input.hook_event_name`으로 분기. Agent/Task 양쪽 toolName을 수용하고, AUQ·finding·so_what 발행 시점에 새로 만든 `addProfilerScore` 헬퍼로 점수 가산. 디버그 객체(`_debug`)에 실제 관측된 toolName/이벤트를 lazy 누적해 다음 세션이 자연 진단.

**Tech Stack:** Node.js (ESM), Claude Code hooks API (PostToolUse + UserPromptSubmit), JSON 상태 파일(`.resume-panel/{meta,snapshot,session-stats}.json`).

**Spec:** `docs/superpowers/specs/2026-05-06-resume-plugin-counter-reliability-design.md`

---

## File Structure

| 파일 | 책임 | 변경 종류 |
|---|---|---|
| `plugins/resume/hooks/hooks.json` | hook 이벤트 매처 + 실행 명령 정의 | 수정 (PostToolUse 매처에 `Agent` 추가, UserPromptSubmit 엔트리 신설) |
| `plugins/resume/scripts/episode-watcher.mjs` | hook 본체 — 이벤트 분기, 카운터 갱신, finding 라우팅, 점수 누적, 메시지 발행 | 수정 (분기 신설, Agent toolName 수용, `_debug` lazy init, `addProfilerScore` 헬퍼, AUQ/finding/so_what 가중치) |
| `plugins/resume/scripts/test-episode-watcher.mjs` | episode-watcher 동작 검증 — 1936줄 단일 파일에 블록-스코프 테스트 누적 | 수정 (이번 변경에 대한 신규 테스트 케이스 추가) |
| `plugins/resume/skills/resume-panel/references/gates.md` | 게이트 명세(G1~G4) | 수정 (G3 §turn 정의 명시) |
| `plugins/resume/skills/resume-panel/references/hook-protocol.md` | additionalContext 메시지 타입 + 가중치 모델 명세 | 수정 (가중치 모델 B 표 추가) |
| `docs/superpowers/follow-ups/resume-system-deferred.md` | 이번 spec 범위 외 시스템 이슈 메모 | 이미 작성됨(이전 단계에서 커밋) — 변경 없음 |

`episode-watcher.mjs`는 약 700줄로 이미 큼. 이번 변경은 추가형이므로 분리 리팩터는 하지 않음(파일 책임은 여전히 단일 — hook 본체).

---

## Task 1: Agent toolName 수용 (핸들러)

**Files:**
- Modify: `plugins/resume/scripts/episode-watcher.mjs:62-95`
- Test: `plugins/resume/scripts/test-episode-watcher.mjs` (append)

**Why:** 현재 핸들러는 `if (toolName === "Task")`만 받는다. Claude Code 2026 환경의 실제 도구 이름은 `Agent`일 가능성이 높아 호출이 추적되지 않는다. 양쪽 모두 받게 한다.

- [ ] **Step 1: Write the failing test for tool_name="Agent"**

`test-episode-watcher.mjs` 끝부분에 추가 (`console.log("\n=== ALL TESTS COMPLETE ===");` 직전):

```js
// Test Phase 5.1: tool_name="Agent" + subagent_type=senior → agent_invocations.senior 증가
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({
    session_limits: {
      gaps: { used: 0, max: 3, intentional: [] },
      perspectives: { used: 0, max: 2, episode_refs: [] },
      contradictions: { used: 0, max: 2 },
      reprobes: { used: 0, log: [] }
    },
    gate_state: {
      direct_askuserquestion_streak: 0,
      agent_calls_in_current_round: { senior: 0, "c-level": 0, recruiter: 0, hr: 0, "coffee-chat": 0 },
      round_turn_counts: { "0": 0, "1": 0, "2": 0, "3": 0 },
      retrospective_invoked: false,
      last_askuserquestion_source: null,
    },
    current_round: 1,
    profiler_score: 0,
  }));

  run({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { subagent_type: "senior" }, cwd: "/tmp/test-resume-panel" });
  run({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { subagent_type: "senior" }, cwd: "/tmp/test-resume-panel" });

  const stats = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/session-stats.json", "utf-8"));
  const meta = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", "utf-8"));
  assert.strictEqual(stats.agent_invocations.senior, 2, "stats.agent_invocations.senior should be 2");
  assert.strictEqual(meta.gate_state.agent_calls_in_current_round.senior, 2, "meta gate_state senior should be 2");
  console.log("PASS: Phase 5.1 — Agent toolName 수용");
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/chenjing/dev/chenjing-plugins
node plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: 새 테스트에서 FAIL — `stats.agent_invocations.senior` 가 0이거나 stats 파일 자체가 없음 (현재 `toolName === "Task"`만 받아서).

- [ ] **Step 3: Modify the handler guard**

`plugins/resume/scripts/episode-watcher.mjs:62` 근처에서 다음과 같이 변경:

기존:
```js
// ── Task tool 호출 감지 (Agent 호출) ─────────────────
if (toolName === "Task") {
  const subagent = toolInput.subagent_type || "";
```

변경 후:
```js
// ── Agent/Task tool 호출 감지 (에이전트 디스패치) ─────
// Claude Code 버전에 따라 toolName이 "Task" 또는 "Agent". 양쪽 수용.
if (toolName === "Task" || toolName === "Agent") {
  const subagent = toolInput.subagent_type || "";
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node /Users/chenjing/dev/chenjing-plugins/plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: 모든 테스트 PASS, 마지막에 `=== ALL TESTS COMPLETE ===`. 새 테스트도 PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/chenjing/dev/chenjing-plugins
git add plugins/resume/scripts/episode-watcher.mjs plugins/resume/scripts/test-episode-watcher.mjs
git commit -m "$(cat <<'EOF'
fix(resume): accept both Agent and Task toolName in episode-watcher hook

Claude Code 2026 환경의 에이전트 디스패치 도구 이름이 Agent로 추정됨.
기존 핸들러는 Task만 매칭하여 agent_invocations 집계가 0으로 수렴하던 문제 해결.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: hooks.json PostToolUse matcher에 Agent 추가

**Files:**
- Modify: `plugins/resume/hooks/hooks.json`

**Why:** hook 코어가 `Agent`를 받아도 `hooks.json`의 매처가 `Agent`를 포함하지 않으면 PostToolUse가 발화하지 않는다. Task 1과 짝.

- [ ] **Step 1: Read current hooks.json**

```bash
cat /Users/chenjing/dev/chenjing-plugins/plugins/resume/hooks/hooks.json
```

기존 matcher: `"Write|Bash|Edit|Task|AskUserQuestion"`.

- [ ] **Step 2: Modify matcher to include Agent**

`plugins/resume/hooks/hooks.json`에서:

기존:
```json
"matcher": "Write|Bash|Edit|Task|AskUserQuestion",
```

변경 후:
```json
"matcher": "Write|Bash|Edit|Task|Agent|AskUserQuestion",
```

- [ ] **Step 3: Verify JSON syntax**

```bash
node -e "JSON.parse(require('fs').readFileSync('/Users/chenjing/dev/chenjing-plugins/plugins/resume/hooks/hooks.json', 'utf-8'))"
```

Expected: 출력 없음(정상 파싱). 에러 시 SyntaxError.

- [ ] **Step 4: Commit**

```bash
cd /Users/chenjing/dev/chenjing-plugins
git add plugins/resume/hooks/hooks.json
git commit -m "$(cat <<'EOF'
fix(resume): add Agent to PostToolUse matcher in hooks.json

핸들러가 Agent를 받게 됐으니 hook 발화도 Agent 호출에 매칭되도록.
Task 1과 짝.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `_debug.observed_tool_names` lazy 누적

**Files:**
- Modify: `plugins/resume/scripts/episode-watcher.mjs:62-95` (Agent/Task 핸들러 + readStats/writeStats 활용)
- Test: `plugins/resume/scripts/test-episode-watcher.mjs` (append)

**Why:** 다음 세션이 실제로 어떤 toolName을 받는지 자연 진단할 데이터를 남긴다. 가설(Claude Code가 `Agent`를 보낸다) 검증용.

- [ ] **Step 1: Write the failing test**

`test-episode-watcher.mjs` 끝부분에 추가:

```js
// Test Phase 5.2: _debug.observed_tool_names가 Agent/Task 호출마다 누적
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({
    session_limits: {
      gaps: { used: 0, max: 3, intentional: [] },
      perspectives: { used: 0, max: 2, episode_refs: [] },
      contradictions: { used: 0, max: 2 },
      reprobes: { used: 0, log: [] }
    },
    gate_state: {
      direct_askuserquestion_streak: 0,
      agent_calls_in_current_round: { senior: 0, "c-level": 0, recruiter: 0, hr: 0, "coffee-chat": 0 },
      round_turn_counts: { "0": 0, "1": 0, "2": 0, "3": 0 },
      retrospective_invoked: false,
      last_askuserquestion_source: null,
    },
    current_round: 1,
    profiler_score: 0,
  }));

  run({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { subagent_type: "senior" }, cwd: "/tmp/test-resume-panel" });
  run({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { subagent_type: "c-level" }, cwd: "/tmp/test-resume-panel" });
  run({ hook_event_name: "PostToolUse", tool_name: "Task", tool_input: { subagent_type: "hr" }, cwd: "/tmp/test-resume-panel" });

  const stats = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/session-stats.json", "utf-8"));
  assert.ok(stats._debug, "stats._debug should exist");
  assert.strictEqual(stats._debug.observed_tool_names.Agent, 2, "Agent count should be 2");
  assert.strictEqual(stats._debug.observed_tool_names.Task, 1, "Task count should be 1");
  assert.ok(stats._debug.first_seen_at, "first_seen_at should be set");
  console.log("PASS: Phase 5.2 — _debug.observed_tool_names 누적");
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node /Users/chenjing/dev/chenjing-plugins/plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: FAIL — `stats._debug` 가 undefined.

- [ ] **Step 3: Add `_debug` lazy init helper + observed_tool_names 누적**

`plugins/resume/scripts/episode-watcher.mjs`의 `defaultSessionStats` 함수(line 315) 아래에 헬퍼 추가:

```js
function ensureDebug(stats) {
  if (!stats._debug) {
    stats._debug = {
      observed_tool_names: {},
      observed_hook_events: {},
      first_seen_at: new Date().toISOString(),
    };
  }
  return stats._debug;
}
```

그리고 Agent/Task 핸들러(line 62 부근, Task 1에서 수정한 블록) 안에서 stats를 처음 읽고 쓰는 모든 분기에 `_debug.observed_tool_names[toolName]++`를 추가. 구체적으로:

기존(line 75-77 부근):
```js
const stats = readStats(base);
stats.agent_invocations[subagent] = (stats.agent_invocations[subagent] || 0) + 1;
writeStats(base, stats);
```

변경 후:
```js
const stats = readStats(base);
ensureDebug(stats);
stats._debug.observed_tool_names[toolName] = (stats._debug.observed_tool_names[toolName] || 0) + 1;
stats.agent_invocations[subagent] = (stats.agent_invocations[subagent] || 0) + 1;
writeStats(base, stats);
```

같은 처리를 retrospective 분기(line 82-84 근처)와 researcher 분기(line 88-90 근처)에도 적용:

retrospective 분기 변경:
```js
const stats = readStats(base);
ensureDebug(stats);
stats._debug.observed_tool_names[toolName] = (stats._debug.observed_tool_names[toolName] || 0) + 1;
stats.agent_invocations.retrospective = (stats.agent_invocations.retrospective || 0) + 1;
writeStats(base, stats);
```

researcher 분기 변경:
```js
const stats = readStats(base);
ensureDebug(stats);
stats._debug.observed_tool_names[toolName] = (stats._debug.observed_tool_names[toolName] || 0) + 1;
stats.agent_invocations.researcher = (stats.agent_invocations.researcher || 0) + 1;
writeStats(base, stats);
```

미지(unknown) subagent 분기(line 91-93 부근, `else` 블록)에서도 stats 갱신이 없는 상태인데, `_debug`만이라도 누적되도록 추가. 변경 후:
```js
} else {
  const stats = readStats(base);
  ensureDebug(stats);
  stats._debug.observed_tool_names[toolName] = (stats._debug.observed_tool_names[toolName] || 0) + 1;
  writeStats(base, stats);
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node /Users/chenjing/dev/chenjing-plugins/plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: 모든 테스트 PASS. 새 테스트도 PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/chenjing/dev/chenjing-plugins
git add plugins/resume/scripts/episode-watcher.mjs plugins/resume/scripts/test-episode-watcher.mjs
git commit -m "$(cat <<'EOF'
feat(resume): add _debug.observed_tool_names accumulation for tool dispatch

다음 세션이 실제 toolName(Agent vs Task) 도착 분포를 자연 진단하도록
session-stats.json._debug에 lazy 누적 로깅 추가.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: UserPromptSubmit 분기 + round_turn_counts 증가 + observed_hook_events

**Files:**
- Modify: `plugins/resume/scripts/episode-watcher.mjs` (script 진입 직후, 분기 추가)
- Test: `plugins/resume/scripts/test-episode-watcher.mjs` (append)

**Why:** "Round 2 turn 수 ≥ 15" 같은 게이트 검사가 의미를 가지려면 turn 카운트가 실제로 증가해야 한다. UserPromptSubmit 1회 = 1 turn으로 정의(spec §3).

- [ ] **Step 1: Write the failing test for round_turn_counts**

`test-episode-watcher.mjs` 끝부분에 추가:

```js
// Test Phase 5.3a: UserPromptSubmit이 round_turn_counts[current_round] 증가
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({
    session_limits: {
      gaps: { used: 0, max: 3, intentional: [] },
      perspectives: { used: 0, max: 2, episode_refs: [] },
      contradictions: { used: 0, max: 2 },
      reprobes: { used: 0, log: [] }
    },
    gate_state: {
      direct_askuserquestion_streak: 0,
      agent_calls_in_current_round: { senior: 0, "c-level": 0, recruiter: 0, hr: 0, "coffee-chat": 0 },
      round_turn_counts: { "0": 0, "1": 0, "2": 0, "3": 0 },
      retrospective_invoked: false,
      last_askuserquestion_source: null,
    },
    current_round: 1,
    profiler_score: 0,
  }));

  run({ hook_event_name: "UserPromptSubmit", prompt: "테스트 메시지 1", cwd: "/tmp/test-resume-panel" });
  run({ hook_event_name: "UserPromptSubmit", prompt: "테스트 메시지 2", cwd: "/tmp/test-resume-panel" });
  run({ hook_event_name: "UserPromptSubmit", prompt: "테스트 메시지 3", cwd: "/tmp/test-resume-panel" });

  const meta = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", "utf-8"));
  assert.strictEqual(meta.gate_state.round_turn_counts["1"], 3, "round 1 should have 3 turns");
  assert.strictEqual(meta.gate_state.round_turn_counts["2"], 0, "round 2 should still be 0");

  // 라운드 전환
  meta.current_round = 2;
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify(meta));
  run({ hook_event_name: "UserPromptSubmit", prompt: "라운드 2 메시지", cwd: "/tmp/test-resume-panel" });
  run({ hook_event_name: "UserPromptSubmit", prompt: "라운드 2 메시지 2", cwd: "/tmp/test-resume-panel" });

  const meta2 = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", "utf-8"));
  assert.strictEqual(meta2.gate_state.round_turn_counts["1"], 3, "round 1 should still be 3");
  assert.strictEqual(meta2.gate_state.round_turn_counts["2"], 2, "round 2 should be 2");

  const stats = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/session-stats.json", "utf-8"));
  assert.strictEqual(stats._debug.observed_hook_events.UserPromptSubmit, 5, "5 UserPromptSubmit events");
  console.log("PASS: Phase 5.3a — UserPromptSubmit round_turn_counts");
}

// Test Phase 5.3b: current_round 미설정 → round "0"에 누적
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({
    session_limits: { gaps: { used: 0, max: 3, intentional: [] }, perspectives: { used: 0, max: 2, episode_refs: [] }, contradictions: { used: 0, max: 2 }, reprobes: { used: 0, log: [] } },
    gate_state: {
      direct_askuserquestion_streak: 0,
      agent_calls_in_current_round: { senior: 0, "c-level": 0, recruiter: 0, hr: 0, "coffee-chat": 0 },
      round_turn_counts: { "0": 0, "1": 0, "2": 0, "3": 0 },
      retrospective_invoked: false,
      last_askuserquestion_source: null,
    },
    profiler_score: 0,
  }));

  run({ hook_event_name: "UserPromptSubmit", prompt: "라운드 미설정 메시지", cwd: "/tmp/test-resume-panel" });

  const meta = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", "utf-8"));
  assert.strictEqual(meta.gate_state.round_turn_counts["0"], 1, "fallback to round 0");
  console.log("PASS: Phase 5.3b — UserPromptSubmit fallback to round 0");
}

// Test Phase 5.3c: 비표준 round 키 안전 (NaN/crash 없음)
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({
    session_limits: { gaps: { used: 0, max: 3, intentional: [] }, perspectives: { used: 0, max: 2, episode_refs: [] }, contradictions: { used: 0, max: 2 }, reprobes: { used: 0, log: [] } },
    gate_state: {
      direct_askuserquestion_streak: 0,
      agent_calls_in_current_round: { senior: 0, "c-level": 0, recruiter: 0, hr: 0, "coffee-chat": 0 },
      round_turn_counts: { "0": 0, "1": 0, "2": 0, "3": 0 },
      retrospective_invoked: false,
      last_askuserquestion_source: null,
    },
    current_round: 5,
    profiler_score: 0,
  }));

  run({ hook_event_name: "UserPromptSubmit", prompt: "비표준 라운드", cwd: "/tmp/test-resume-panel" });

  const meta = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", "utf-8"));
  assert.strictEqual(meta.gate_state.round_turn_counts["5"], 1, "non-standard round 5 should accept");
  console.log("PASS: Phase 5.3c — UserPromptSubmit non-standard round");
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node /Users/chenjing/dev/chenjing-plugins/plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: 5.3a/b/c FAIL — `round_turn_counts` 가 0 또는 undefined.

- [ ] **Step 3: Add UserPromptSubmit branch in episode-watcher.mjs**

`plugins/resume/scripts/episode-watcher.mjs`에서 stdin 읽기(line 14-20) 직후, 그리고 `toolName`/`toolInput` 추출(line 22-23) 직전에 새 분기를 추가:

기존 (line 14-23):
```js
// ── stdin ────────────────────────────────────────────
let input;
try {
  input = JSON.parse(readFileSync("/dev/stdin", "utf-8"));
} catch {
  process.exit(0);
}

const toolName = input.tool_name;
const toolInput = input.tool_input || {};
```

변경 후 (분기 삽입):
```js
// ── stdin ────────────────────────────────────────────
let input;
try {
  input = JSON.parse(readFileSync("/dev/stdin", "utf-8"));
} catch {
  process.exit(0);
}

// ── 경로 상수 (UserPromptSubmit 분기에서도 base 필요) ─
const base = process.env.RESUME_PANEL_BASE || input.cwd || process.cwd();
const stateDir = join(base, ".resume-panel");
const snapshotPath = join(stateDir, "snapshot.json");
const metaPath = join(stateDir, "meta.json");
const sourcePath = join(base, "resume-source.json");
const inboxPath = join(stateDir, "findings-inbox.jsonl");
const processingPath = join(stateDir, "findings-inbox.processing.jsonl");
const findingsPath = join(stateDir, "findings.json");

// ── UserPromptSubmit 분기 — round_turn_counts 증가 ──
if (input.hook_event_name === "UserPromptSubmit") {
  ensureStateDir();
  const meta = migrateMeta(readJSON(metaPath) || {});
  meta.gate_state = meta.gate_state || defaultGateState();
  meta.gate_state.round_turn_counts = meta.gate_state.round_turn_counts || { "0": 0, "1": 0, "2": 0, "3": 0 };
  const round = String(meta.current_round ?? 0);
  meta.gate_state.round_turn_counts[round] = (meta.gate_state.round_turn_counts[round] || 0) + 1;

  const stats = readStats(base);
  ensureDebug(stats);
  stats._debug.observed_hook_events.UserPromptSubmit =
    (stats._debug.observed_hook_events.UserPromptSubmit || 0) + 1;

  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  writeStats(base, stats);
  process.exit(0);
}

const toolName = input.tool_name;
const toolInput = input.tool_input || {};
```

기존의 `// ── 경로 상수 ─` 블록(원래 line 25-33)을 위 위치에서 위로 옮긴 셈이므로, **원래 자리의 중복 선언은 삭제**한다. 즉 episode-watcher.mjs에서 `const base = ...` 부터 `const findingsPath = ...`까지의 7줄이 한 번만 등장해야 함.

- [ ] **Step 4: Run tests to verify they pass**

```bash
node /Users/chenjing/dev/chenjing-plugins/plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: 모든 테스트 PASS, 5.3a/b/c 포함.

- [ ] **Step 5: Commit**

```bash
cd /Users/chenjing/dev/chenjing-plugins
git add plugins/resume/scripts/episode-watcher.mjs plugins/resume/scripts/test-episode-watcher.mjs
git commit -m "$(cat <<'EOF'
feat(resume): increment round_turn_counts on UserPromptSubmit hook

UserPromptSubmit 1회 = 1 turn 정의로 round_turn_counts를 자연 누적.
G3 r2_exit 게이트의 turn_min<15 검사가 이제 실제 의미를 가짐.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: hooks.json UserPromptSubmit 엔트리 추가

**Files:**
- Modify: `plugins/resume/hooks/hooks.json`

**Why:** Task 4는 스크립트 본체에서 UserPromptSubmit을 받게 하지만, hooks.json이 그 이벤트를 등록하지 않으면 Claude Code가 발화하지 않는다.

- [ ] **Step 1: Update hooks.json**

`plugins/resume/hooks/hooks.json` 전체를 다음으로 교체:

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

- [ ] **Step 2: Verify JSON syntax**

```bash
node -e "JSON.parse(require('fs').readFileSync('/Users/chenjing/dev/chenjing-plugins/plugins/resume/hooks/hooks.json', 'utf-8'))"
```

Expected: 출력 없음(정상 파싱).

- [ ] **Step 3: Commit**

```bash
cd /Users/chenjing/dev/chenjing-plugins
git add plugins/resume/hooks/hooks.json
git commit -m "$(cat <<'EOF'
feat(resume): register UserPromptSubmit hook in hooks.json

Task 4의 스크립트 본체 분기와 짝. 이제 유저 메시지 도착 시
episode-watcher가 발화해 round_turn_counts를 누적.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `addProfilerScore` 헬퍼 + 기존 storage 가중치 리팩터

**Files:**
- Modify: `plugins/resume/scripts/episode-watcher.mjs` (helper 추가, storage 블록 line 421-478 리팩터)
- Test: `plugins/resume/scripts/test-episode-watcher.mjs` (append; `_score_reasons` 검증 신규)

**Why:** 이후 Task(7,8,9)에서 AUQ/finding/so_what 시점에도 score를 가산하려면 일관된 헬퍼가 필요. 기존 storage 가중치도 같이 마이그레이션해 `_score_reasons`(rolling 10) 누적이 일관됨.

- [ ] **Step 1: Write the failing test for `_score_reasons` accumulation**

`test-episode-watcher.mjs` 끝부분에 추가:

```js
// Test Phase 5.4: storage 가중치가 _score_reasons에 사유 기록
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  // 첫 실행 — snapshot 생성만
  writeFileSync("/tmp/test-resume-panel/resume-source.json", JSON.stringify({
    meta: { target_company: "X", target_position: "Y" },
    companies: [{ name: "C1", projects: [{ name: "P1", episodes: [{ title: "E1", star: { situation: "s", task: "t", action: "a", result: "r 30%" } }] }] }],
  }));
  run({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "/work/resume-source.json", content: "{}" }, cwd: "/tmp/test-resume-panel" });

  // 두 번째 실행 — 새 회사 + 새 에피소드 추가 → score +4 (에피소드 +1, 새 프로젝트 +3)
  writeFileSync("/tmp/test-resume-panel/resume-source.json", JSON.stringify({
    meta: { target_company: "X", target_position: "Y" },
    companies: [
      { name: "C1", projects: [{ name: "P1", episodes: [{ title: "E1", star: { situation: "s", task: "t", action: "a", result: "r 30%" } }] }] },
      { name: "C2", projects: [{ name: "P2", episodes: [{ title: "E2", star: { situation: "s", task: "t", action: "a", result: "r 50%" } }] }] },
    ],
  }));
  run({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "/work/resume-source.json", content: "{}" }, cwd: "/tmp/test-resume-panel" });

  const meta = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", "utf-8"));
  assert.ok(Array.isArray(meta._score_reasons), "_score_reasons should be an array");
  assert.ok(meta._score_reasons.length >= 2, `_score_reasons should have ≥2 entries, got ${meta._score_reasons.length}`);
  const reasons = meta._score_reasons.map(r => r.reason);
  assert.ok(reasons.some(r => r.includes("에피소드")), "에피소드 reason missing");
  assert.ok(reasons.some(r => r.includes("새 프로젝트")), "새 프로젝트 reason missing");
  console.log("PASS: Phase 5.4 — _score_reasons 누적");
}

// Test Phase 5.4b: _score_reasons rolling 10 (slice -9 + push = max 10)
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  // 미리 _score_reasons에 10개 채워둠
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({
    session_limits: { gaps: { used: 0, max: 3, intentional: [] }, perspectives: { used: 0, max: 2, episode_refs: [] }, contradictions: { used: 0, max: 2 }, reprobes: { used: 0, log: [] } },
    gate_state: defaultGateStateForTest(),
    profiler_score: 0,
    _score_reasons: Array.from({ length: 10 }, (_, i) => ({ delta: 1, reason: `seed-${i}`, at: new Date(2025, 0, 1, 0, 0, i).toISOString() })),
  }));
  writeFileSync("/tmp/test-resume-panel/.resume-panel/snapshot.json", JSON.stringify({
    episode_count: 0, project_names: [], meta_hash: "init", star_gaps: 0, current_company: null,
  }));
  writeFileSync("/tmp/test-resume-panel/resume-source.json", JSON.stringify({
    meta: { target_company: "X", target_position: "Y" },
    companies: [{ name: "C1", projects: [{ name: "P1", episodes: [{ title: "E1", star: { situation: "s", task: "t", action: "a", result: "r 30%" } }] }] }],
  }));
  run({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "/work/resume-source.json", content: "{}" }, cwd: "/tmp/test-resume-panel" });

  const meta = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", "utf-8"));
  assert.ok(meta._score_reasons.length <= 10, `_score_reasons should be ≤10, got ${meta._score_reasons.length}`);
  // 가장 오래된 seed-0가 잘려나갔는지 확인
  const reasons = meta._score_reasons.map(r => r.reason);
  assert.ok(!reasons.includes("seed-0"), "seed-0 (oldest) should be evicted");
  console.log("PASS: Phase 5.4b — _score_reasons rolling 10");
}

// Helper: defaultGateStateForTest (테스트 파일 상단에 함수 정의 추가 필요 시)
// — 실제로는 위 두 테스트 직전에 inline 함수로 두거나 reuse 가능
```

테스트 파일 상단 import 블록 직후 또는 첫 테스트 직전에 작은 헬퍼 함수 추가(테스트 코드용):

```js
function defaultGateStateForTest() {
  return {
    direct_askuserquestion_streak: 0,
    agent_calls_in_current_round: { senior: 0, "c-level": 0, recruiter: 0, hr: 0, "coffee-chat": 0 },
    round_turn_counts: { "0": 0, "1": 0, "2": 0, "3": 0 },
    retrospective_invoked: false,
    last_askuserquestion_source: null,
  };
}
```

(이 헬퍼는 후속 Task(7,8)에서도 재사용한다.)

- [ ] **Step 2: Run tests to verify they fail**

```bash
node /Users/chenjing/dev/chenjing-plugins/plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: 5.4 / 5.4b FAIL — `_score_reasons`가 undefined.

- [ ] **Step 3: Add `addProfilerScore` helper**

`plugins/resume/scripts/episode-watcher.mjs`의 `defaultSessionStats` 함수(line 315) 아래, `ensureDebug` 헬퍼와 같은 위치에 추가:

```js
function addProfilerScore(meta, delta, reason) {
  meta.profiler_score = (meta.profiler_score || 0) + delta;
  meta._score_reasons = (meta._score_reasons || []).slice(-9);
  meta._score_reasons.push({
    delta,
    reason,
    at: new Date().toISOString(),
  });
  return meta.profiler_score;
}
```

- [ ] **Step 4: Refactor storage weight block to use helper**

`plugins/resume/scripts/episode-watcher.mjs:420-478` 부근 storage 가중치 블록을 다음과 같이 변경.

기존 (대략 line 420-478):
```js
} else {
  // 이벤트 가중치 점수 계산
  const metaJSON = readJSON(metaPath) || {};
  let score = metaJSON.profiler_score || 0;
  const reasons = [];

  // +1: 에피소드 저장
  const episodeDelta = currentCount - (snapshot.episode_count || 0);
  if (episodeDelta > 0) {
    score += episodeDelta;
    reasons.push(`에피소드 +${episodeDelta}`);
  }

  // +3: 새 회사/프로젝트 추가
  const snapshotProjects = new Set(snapshot.project_names || []);
  const hasNewProject = currentProjects.some((p) => !snapshotProjects.has(p));
  if (hasNewProject) {
    score += 3;
    reasons.push("새 프로젝트 (+3)");
  }

  // +2: 빈 STAR 증가 (result 비어있음)
  const currentStarGaps = countStarGaps(source);
  const prevStarGaps = snapshot.star_gaps || 0;
  if (currentStarGaps > prevStarGaps) {
    score += 2;
    reasons.push("빈 STAR 증가 (+2)");
  }

  // +2: 역할 축소 신호
  if (detectMinimization(source, snapshot)) {
    score += 2;
    reasons.push("역할 축소 신호 (+2)");
  }

  // +2: 메타 변경
  if (currentHash !== snapshot.meta_hash) {
    score += 2;
    reasons.push("meta 변경 (+2)");
  }
```

변경 후 (`addProfilerScore` 사용):
```js
} else {
  // 이벤트 가중치 점수 계산
  const metaJSON = migrateMeta(readJSON(metaPath) || {});
  const reasons = [];

  // +1: 에피소드 저장
  const episodeDelta = currentCount - (snapshot.episode_count || 0);
  if (episodeDelta > 0) {
    addProfilerScore(metaJSON, episodeDelta, `에피소드 +${episodeDelta}`);
    reasons.push(`에피소드 +${episodeDelta}`);
  }

  // +3: 새 회사/프로젝트 추가
  const snapshotProjects = new Set(snapshot.project_names || []);
  const hasNewProject = currentProjects.some((p) => !snapshotProjects.has(p));
  if (hasNewProject) {
    addProfilerScore(metaJSON, 3, "새 프로젝트 (+3)");
    reasons.push("새 프로젝트 (+3)");
  }

  // +2: 빈 STAR 증가 (result 비어있음)
  const currentStarGaps = countStarGaps(source);
  const prevStarGaps = snapshot.star_gaps || 0;
  if (currentStarGaps > prevStarGaps) {
    addProfilerScore(metaJSON, 2, "빈 STAR 증가 (+2)");
    reasons.push("빈 STAR 증가 (+2)");
  }

  // +2: 역할 축소 신호
  if (detectMinimization(source, snapshot)) {
    addProfilerScore(metaJSON, 2, "역할 축소 신호 (+2)");
    reasons.push("역할 축소 신호 (+2)");
  }

  // +2: 메타 변경
  if (currentHash !== snapshot.meta_hash) {
    addProfilerScore(metaJSON, 2, "meta 변경 (+2)");
    reasons.push("meta 변경 (+2)");
  }

  let score = metaJSON.profiler_score;
```

그리고 같은 블록 안 임계값 체크와 트리거 후 리셋(line 462~ ) 부분의 `score` 갱신과 메타 쓰기를 `metaJSON` 일관성에 맞게 정리. 기존 코드의 후반부:

기존:
```js
  // 임계값 체크
  const THRESHOLD = 5;
  let updatedMetaFields = {};
  if (score >= THRESHOLD) {
    // ... emit profiler_trigger ...
    score = 0; // 트리거 후 리셋
  }

  // ... so_what / 스냅샷 업데이트 ...

  // meta.json에 점수 저장 (항상)
  const metaMigrated = migrateMeta(metaJSON);
  writeFileSync(metaPath, JSON.stringify({
    ...metaMigrated,
    ...updatedMetaFields,
    profiler_score: score,
  }, null, 2));
```

변경 후:
```js
  // 임계값 체크
  const THRESHOLD = 5;
  let updatedMetaFields = {};
  if (metaJSON.profiler_score >= THRESHOLD) {
    // ... emit profiler_trigger ... (기존 로직 유지)
    metaJSON.profiler_score = 0; // 트리거 후 리셋
  }

  // ... so_what / 스냅샷 업데이트 ...

  // meta.json에 점수 저장 (항상)
  writeFileSync(metaPath, JSON.stringify({
    ...metaJSON,
    ...updatedMetaFields,
  }, null, 2));
```

핵심: `metaJSON`이 이미 `migrateMeta` 거친 객체이고 `_score_reasons`/`profiler_score`가 모두 그 안에 있으므로, 마지막 write에서 `migrateMeta`를 또 부르지 않고 그대로 spread.

- [ ] **Step 5: Run all tests**

```bash
node /Users/chenjing/dev/chenjing-plugins/plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: 모든 테스트 PASS. 기존 score 관련 테스트(`Test: score accumulates across calls`, `Test: combined events: new company + meta change = immediate trigger`, `Test: score resets to 0 after trigger` 등)도 그대로 통과해야 함. 5.4 / 5.4b도 PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/chenjing/dev/chenjing-plugins
git add plugins/resume/scripts/episode-watcher.mjs plugins/resume/scripts/test-episode-watcher.mjs
git commit -m "$(cat <<'EOF'
refactor(resume): introduce addProfilerScore helper + storage weight migration

기존 storage 기반 가중치 블록을 헬퍼 경유로 일관화하고
meta._score_reasons (rolling 10) 누적을 도입.
이후 AUQ/finding/so_what 가중치도 같은 헬퍼로 추가될 수 있게 준비.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: AUQ 가중치 +1

**Files:**
- Modify: `plugins/resume/scripts/episode-watcher.mjs:98-169` (AUQ 핸들러)
- Test: `plugins/resume/scripts/test-episode-watcher.mjs` (append)

**Why:** 인터뷰 강도(질문 빈도)가 프로파일러 트리거에 반영되지 않으면 에피소드를 일괄 저장한 뒤 score가 정체된다. AUQ 1회마다 +1 가산.

- [ ] **Step 1: Write the failing test**

`test-episode-watcher.mjs` 끝부분에 추가:

```js
// Test Phase 5.5: AUQ 호출 1회 → profiler_score +1 + _score_reasons 기록
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({
    session_limits: { gaps: { used: 0, max: 3, intentional: [] }, perspectives: { used: 0, max: 2, episode_refs: [] }, contradictions: { used: 0, max: 2 }, reprobes: { used: 0, log: [] } },
    gate_state: {
      ...defaultGateStateForTest(),
      last_askuserquestion_source: { source: "agent", agent_name: "senior" },
    },
    current_round: 1,
    profiler_score: 0,
  }));

  run({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_input: {}, cwd: "/tmp/test-resume-panel" });

  const meta = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", "utf-8"));
  assert.strictEqual(meta.profiler_score, 1, "AUQ should add +1 to profiler_score");
  const reasons = (meta._score_reasons || []).map(r => r.reason);
  assert.ok(reasons.some(r => r.includes("AUQ")), `AUQ reason missing in ${JSON.stringify(reasons)}`);
  console.log("PASS: Phase 5.5 — AUQ 가중치 +1");
}

// Test Phase 5.5b: AUQ 5회 누적 → 임계 도달 → trigger 발행 + score 0 리셋
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({
    session_limits: { gaps: { used: 0, max: 3, intentional: [] }, perspectives: { used: 0, max: 2, episode_refs: [] }, contradictions: { used: 0, max: 2 }, reprobes: { used: 0, log: [] } },
    gate_state: {
      ...defaultGateStateForTest(),
      last_askuserquestion_source: { source: "agent", agent_name: "senior" },
    },
    current_round: 1,
    profiler_score: 0,
  }));

  let lastResult = null;
  for (let i = 0; i < 5; i++) {
    // AUQ 호출 직전 source 재선언 (기존 hook이 처리 후 null로 만듦)
    const meta = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", "utf-8"));
    meta.gate_state.last_askuserquestion_source = { source: "agent", agent_name: "senior" };
    writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify(meta));
    lastResult = run({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_input: {}, cwd: "/tmp/test-resume-panel" });
  }

  // 5번째 호출에서 score=5 → 임계 도달 → profiler_trigger emit + score 0 리셋
  const meta = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", "utf-8"));
  assert.strictEqual(meta.profiler_score, 0, "score should reset to 0 after threshold");
  // additionalContext에 profiler_trigger 메시지가 있어야 함
  assert.ok(lastResult, "5th AUQ should emit output");
  assert.ok(lastResult.hookSpecificOutput.additionalContext.includes('"type":"profiler_trigger"'),
    `expected profiler_trigger in: ${lastResult.hookSpecificOutput.additionalContext}`);
  console.log("PASS: Phase 5.5b — AUQ 5회 → 임계 도달 + 트리거 + 리셋");
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node /Users/chenjing/dev/chenjing-plugins/plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: 5.5 / 5.5b FAIL — score가 0 그대로.

- [ ] **Step 3: Add AUQ score increment + threshold check**

`plugins/resume/scripts/episode-watcher.mjs`의 AUQ 핸들러 블록(line 98-169 부근). `// Collect violations` 직전(line 124 근처)에 가중치 누적 + 임계 체크 추가.

기존 (대략 line 116-125):
```js
  // session-stats 집계
  {
    const stats = readStats(base);
    stats.askuserquestion.total++;
    const sourceKind = isWhitelist ? "whitelist" : (isAgent ? "agent" : "orchestrator_direct");
    stats.askuserquestion.by_source[sourceKind] =
      (stats.askuserquestion.by_source[sourceKind] || 0) + 1;
    writeStats(base, stats);
  }

  // Collect violations
  const violations = [];
```

변경 후(`writeStats` 호출과 violations 사이에 score 가산):
```js
  // session-stats 집계
  {
    const stats = readStats(base);
    stats.askuserquestion.total++;
    const sourceKind = isWhitelist ? "whitelist" : (isAgent ? "agent" : "orchestrator_direct");
    stats.askuserquestion.by_source[sourceKind] =
      (stats.askuserquestion.by_source[sourceKind] || 0) + 1;
    writeStats(base, stats);
  }

  // 프로파일러 가중치 — AUQ 1회 +1 (모든 source)
  addProfilerScore(meta, 1, "AUQ");

  // 임계 도달 시 profiler_trigger emit + score 리셋
  // (기존 storage 블록과 같은 임계값. THRESHOLD=5)
  const profilerMessages = [];
  if (meta.profiler_score >= 5) {
    profilerMessages.push(emit({
      type: "profiler_trigger",
      delta: (meta._score_reasons || []).slice(-5).map(r => r.reason).join(", "),
      score: meta.profiler_score,
      source: "AUQ",
    }));
    meta.profiler_score = 0;
  }

  // meta 재저장 (위에서 이미 한 번 썼지만 score 변경분 반영)
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  // Collect violations
  const violations = [];
```

그리고 AUQ 핸들러 끝부분의 출력 처리(line 159-168 부근). 기존:
```js
  if (violations.length > 0) {
    // ... 기존 violation emit ...
    process.stdout.write(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: outputLines,
      },
    }));
  }
  process.exit(0);
}
```

변경 후 (profilerMessages도 함께):
```js
  if (violations.length > 0 || profilerMessages.length > 0) {
    const violationLines = violations.map(v => `[resume-panel]${JSON.stringify(v)}`);
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

(주의: 기존 코드에서 `outputLines`를 만드는 부분이 violations 안에 들어 있었다면, violations 처리 블록을 위 형태로 맞추되 기존의 stats write는 한 번만 수행되도록 한다.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
node /Users/chenjing/dev/chenjing-plugins/plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: 모든 테스트 PASS, 5.5 / 5.5b 포함. 기존 AUQ 테스트(Phase 3.4a/b, 4.1 등)도 그대로 통과.

- [ ] **Step 5: Commit**

```bash
cd /Users/chenjing/dev/chenjing-plugins
git add plugins/resume/scripts/episode-watcher.mjs plugins/resume/scripts/test-episode-watcher.mjs
git commit -m "$(cat <<'EOF'
feat(resume): add AUQ +1 weight to profiler trigger model

AskUserQuestion 호출마다 profiler_score +1 가산.
임계 도달 시 storage 블록과 동일하게 profiler_trigger emit + score 0 리셋.
인터뷰 강도가 트리거 빈도에 반영되도록 함.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: HIGH finding `_last_high_finding_at` + AUQ importance 보너스 +2

**Files:**
- Modify: `plugins/resume/scripts/episode-watcher.mjs` (finding 라우팅 분기 + AUQ 핸들러)
- Test: `plugins/resume/scripts/test-episode-watcher.mjs` (append)

**Why:** HIGH finding 직후 인터뷰가 그 finding 응답 모드로 들어갈 가능성이 높다. 이 시점의 AUQ는 일반 AUQ보다 중요도가 높으므로 보너스 +2.

- [ ] **Step 1: Write the failing test**

`test-episode-watcher.mjs` 끝부분에 추가:

```js
// Test Phase 5.6a: HIGH finding 라우팅 직후 _last_high_finding_at 설정
{
  rmSync("/tmp/test-resume-panel-high-bonus", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel-high-bonus/.resume-panel", { recursive: true });
  writeFileSync(join("/tmp/test-resume-panel-high-bonus/.resume-panel", "snapshot.json"), JSON.stringify({
    episode_count: 5, project_names: ["A"], meta_hash: "abc",
  }));
  writeFileSync(join("/tmp/test-resume-panel-high-bonus/.resume-panel", "findings-inbox.jsonl"),
    JSON.stringify({
      id: "f-001", urgency: "HIGH", source: "recruiter", type: "gap_detected",
      message: "WebSocket 공백.", context: {}, created_at: new Date().toISOString(),
    }) + "\n"
  );

  execFileSync("node", [script], {
    input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "/work/some.txt", content: "x" } }),
    encoding: "utf-8",
    env: { ...process.env, RESUME_PANEL_BASE: "/tmp/test-resume-panel-high-bonus" },
  });

  const meta = JSON.parse(readFileSync("/tmp/test-resume-panel-high-bonus/.resume-panel/meta.json", "utf-8"));
  assert.ok(meta._last_high_finding_at, "_last_high_finding_at should be set");
  assert.ok(new Date(meta._last_high_finding_at).getTime() > Date.now() - 60_000, "should be recent");
  console.log("PASS: Phase 5.6a — HIGH finding sets _last_high_finding_at");
  rmSync("/tmp/test-resume-panel-high-bonus", { recursive: true, force: true });
}

// Test Phase 5.6b: HIGH finding 60초 이내 AUQ → score +3 (1 + 2 보너스)
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({
    session_limits: { gaps: { used: 0, max: 3, intentional: [] }, perspectives: { used: 0, max: 2, episode_refs: [] }, contradictions: { used: 0, max: 2 }, reprobes: { used: 0, log: [] } },
    gate_state: {
      ...defaultGateStateForTest(),
      last_askuserquestion_source: { source: "agent", agent_name: "senior" },
    },
    current_round: 1,
    profiler_score: 0,
    _last_high_finding_at: new Date().toISOString(),  // 방금 막 HIGH finding이 있었던 셈
  }));

  run({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_input: {}, cwd: "/tmp/test-resume-panel" });

  const meta = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", "utf-8"));
  assert.strictEqual(meta.profiler_score, 3, `expected 3 (1 base + 2 bonus), got ${meta.profiler_score}`);
  const reasons = (meta._score_reasons || []).map(r => r.reason);
  assert.ok(reasons.some(r => r.includes("HIGH finding")), `HIGH finding bonus reason missing in ${JSON.stringify(reasons)}`);
  console.log("PASS: Phase 5.6b — AUQ within 60s of HIGH finding → +3");
}

// Test Phase 5.6c: HIGH finding 60초 초과 AUQ → 보너스 없음 (+1만)
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  const oldTimestamp = new Date(Date.now() - 120_000).toISOString();  // 2분 전
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({
    session_limits: { gaps: { used: 0, max: 3, intentional: [] }, perspectives: { used: 0, max: 2, episode_refs: [] }, contradictions: { used: 0, max: 2 }, reprobes: { used: 0, log: [] } },
    gate_state: {
      ...defaultGateStateForTest(),
      last_askuserquestion_source: { source: "agent", agent_name: "senior" },
    },
    current_round: 1,
    profiler_score: 0,
    _last_high_finding_at: oldTimestamp,
  }));

  run({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_input: {}, cwd: "/tmp/test-resume-panel" });

  const meta = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", "utf-8"));
  assert.strictEqual(meta.profiler_score, 1, `expected 1 (no bonus), got ${meta.profiler_score}`);
  console.log("PASS: Phase 5.6c — AUQ outside 60s window → +1 only");
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node /Users/chenjing/dev/chenjing-plugins/plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: 5.6a/b/c FAIL.

- [ ] **Step 3: Set `_last_high_finding_at` in finding routing**

`plugins/resume/scripts/episode-watcher.mjs`의 finding 라우팅 분기(line 631 부근). HIGH finding을 emit 처리하는 블록 안에서 timestamp 설정.

기존 (대략 line 660-672):
```js
    for (const f of newFindings) {
      f.delivered = false;

      if (f.urgency === "HIGH") {
        messages.push(
          emit({
            type: "finding",
            urgency: "HIGH",
            finding_type: f.type,
            id: f.id,
            message: f.message,
            context: f.context || {},
          })
        );
        f.delivered = true;
      } else if (f.urgency === "MEDIUM" && companyChanged) {
```

변경 후 (HIGH 분기에 `_last_high_finding_at` 갱신 + 메타 dirty 플래그):
```js
    let highFindingDelivered = false;
    for (const f of newFindings) {
      f.delivered = false;

      if (f.urgency === "HIGH") {
        messages.push(
          emit({
            type: "finding",
            urgency: "HIGH",
            finding_type: f.type,
            id: f.id,
            message: f.message,
            context: f.context || {},
          })
        );
        f.delivered = true;
        highFindingDelivered = true;
      } else if (f.urgency === "MEDIUM" && companyChanged) {
```

같은 finding 라우팅 블록의 끝부분, `writeFileSync(findingsPath, ...)` 다음에 `_last_high_finding_at` 갱신 + meta 쓰기 추가.

기존 (대략 line 689-697):
```js
    ensureStateDir();
    writeFileSync(findingsPath, JSON.stringify(existing, null, 2));

    // 스냅샷에 current_company 동기화 (MEDIUM 라우팅 후 다음 비교를 위해)
    if (companyChanged && snapshot) {
      const updated = { ...snapshot, current_company: meta.current_company };
      writeFileSync(snapshotPath, JSON.stringify(updated));
    }
    try { unlinkSync(processingPath); } catch {}
  }
```

변경 후:
```js
    ensureStateDir();
    writeFileSync(findingsPath, JSON.stringify(existing, null, 2));

    // 스냅샷에 current_company 동기화 (MEDIUM 라우팅 후 다음 비교를 위해)
    if (companyChanged && snapshot) {
      const updated = { ...snapshot, current_company: meta.current_company };
      writeFileSync(snapshotPath, JSON.stringify(updated));
    }

    // HIGH finding 발행 시점 타임스탬프 (다음 AUQ가 60초 이내면 importance 보너스)
    if (highFindingDelivered) {
      const metaForTimestamp = migrateMeta(readJSON(metaPath) || {});
      metaForTimestamp._last_high_finding_at = new Date().toISOString();
      writeFileSync(metaPath, JSON.stringify(metaForTimestamp, null, 2));
    }

    try { unlinkSync(processingPath); } catch {}
  }
```

- [ ] **Step 4: Add importance bonus check in AUQ handler**

AUQ 핸들러의 `addProfilerScore(meta, 1, "AUQ")` 호출(Task 7에서 추가) 직후에 importance 보너스 체크 추가.

Task 7에서 추가했던 부분:
```js
  // 프로파일러 가중치 — AUQ 1회 +1 (모든 source)
  addProfilerScore(meta, 1, "AUQ");

  // 임계 도달 시 profiler_trigger emit + score 리셋
```

다음과 같이 변경:
```js
  // 프로파일러 가중치 — AUQ 1회 +1 (모든 source)
  addProfilerScore(meta, 1, "AUQ");

  // 중요도 보너스: 직전 60초 이내에 HIGH finding이 발행됐으면 +2
  if (meta._last_high_finding_at) {
    const elapsed = Date.now() - new Date(meta._last_high_finding_at).getTime();
    if (elapsed >= 0 && elapsed < 60_000) {
      addProfilerScore(meta, 2, "HIGH finding 60초 이내 (+2)");
    }
  }

  // 임계 도달 시 profiler_trigger emit + score 리셋
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
node /Users/chenjing/dev/chenjing-plugins/plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: 모든 테스트 PASS, 5.6a/b/c 포함.

- [ ] **Step 6: Commit**

```bash
cd /Users/chenjing/dev/chenjing-plugins
git add plugins/resume/scripts/episode-watcher.mjs plugins/resume/scripts/test-episode-watcher.mjs
git commit -m "$(cat <<'EOF'
feat(resume): HIGH finding importance bonus +2 for AUQ within 60s

HIGH finding 라우팅 직후 60초 이내의 AUQ는 인터뷰 중요도가 높다고 보고
profiler_score에 +2 보너스 가산. 60초 = 인터뷰 1턴 응답 + 다음 AUQ 여유 윈도.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: so_what / perspective_shift / contradiction 가중치 +3

**Files:**
- Modify: `plugins/resume/scripts/episode-watcher.mjs` (so_what 발행 분기 + finding 라우팅 분기)
- Test: `plugins/resume/scripts/test-episode-watcher.mjs` (append)

**Why:** so_what / perspective_shift / contradiction은 인터뷰의 중요한 분기점이고 이들이 트리거된 시점에 프로파일러를 더 자주 호출해 컨텍스트 갱신.

- [ ] **Step 1: Write the failing tests**

`test-episode-watcher.mjs` 끝부분에 추가:

```js
// Test Phase 5.7a: so_what 발행 시 profiler_score +3
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  // 첫 실행 — snapshot 생성
  writeFileSync("/tmp/test-resume-panel/resume-source.json", JSON.stringify({
    meta: { target_company: "X", target_position: "Y" },
    companies: [{ name: "C1", projects: [{ name: "P1", episodes: [{ title: "E1", star: { situation: "s", task: "t", action: "a", result: "수치없음" } }] }] }],
  }));
  run({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "/work/resume-source.json", content: "{}" }, cwd: "/tmp/test-resume-panel" });

  // 두 번째 실행 — 임팩트 약한 에피소드 추가 → so_what 트리거
  writeFileSync("/tmp/test-resume-panel/resume-source.json", JSON.stringify({
    meta: { target_company: "X", target_position: "Y" },
    companies: [{ name: "C1", projects: [{ name: "P1", episodes: [
      { title: "E1", star: { situation: "s", task: "t", action: "a", result: "수치없음" } },
      { title: "E2-weak", star: { situation: "s", task: "t", action: "a", result: "임팩트 정성적" } },
    ] }] }],
  }));
  run({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "/work/resume-source.json", content: "{}" }, cwd: "/tmp/test-resume-panel" });

  const meta = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", "utf-8"));
  // 두 번째 실행에서 +1 (에피소드) + +3 (so_what) = +4 누적 (첫 실행은 snapshot init이라 점수 0)
  // 단 임계 5에 못 미치면 그대로 4로 남고, 도달하면 0 리셋. 두 번째 fire에서 4면 리셋 안 함.
  const reasons = (meta._score_reasons || []).map(r => r.reason);
  assert.ok(reasons.some(r => r.includes("so_what")), `so_what reason missing in ${JSON.stringify(reasons)}`);
  console.log("PASS: Phase 5.7a — so_what 가중치 +3");
}

// Test Phase 5.7b: perspective_shift finding 라우팅 시 +3
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  writeFileSync("/tmp/test-resume-panel/.resume-panel/snapshot.json", JSON.stringify({
    episode_count: 5, project_names: ["A"], meta_hash: "abc", current_company: "C1",
  }));
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({
    session_limits: { gaps: { used: 0, max: 3, intentional: [] }, perspectives: { used: 0, max: 2, episode_refs: [] }, contradictions: { used: 0, max: 2 }, reprobes: { used: 0, log: [] } },
    gate_state: defaultGateStateForTest(),
    profiler_score: 0,
    current_company: "C1-changed",  // companyChanged 트리거 — MEDIUM finding 라우팅
  }));
  writeFileSync("/tmp/test-resume-panel/.resume-panel/findings-inbox.jsonl",
    JSON.stringify({
      id: "ps-001", urgency: "MEDIUM", source: "profiler", type: "perspective_shift",
      message: "관점 전환 필요.", context: {}, created_at: new Date().toISOString(),
    }) + "\n"
  );

  run({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "/work/some.txt", content: "x" }, cwd: "/tmp/test-resume-panel" });

  const meta = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", "utf-8"));
  const reasons = (meta._score_reasons || []).map(r => r.reason);
  assert.ok(reasons.some(r => r.includes("perspective_shift")), `perspective_shift reason missing in ${JSON.stringify(reasons)}`);
  console.log("PASS: Phase 5.7b — perspective_shift 가중치 +3");
}

// Test Phase 5.7c: contradiction_detected finding 라우팅 시 +3
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  writeFileSync("/tmp/test-resume-panel/.resume-panel/snapshot.json", JSON.stringify({
    episode_count: 5, project_names: ["A"], meta_hash: "abc",
  }));
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({
    session_limits: { gaps: { used: 0, max: 3, intentional: [] }, perspectives: { used: 0, max: 2, episode_refs: [] }, contradictions: { used: 0, max: 2 }, reprobes: { used: 0, log: [] } },
    gate_state: defaultGateStateForTest(),
    profiler_score: 0,
  }));
  writeFileSync("/tmp/test-resume-panel/.resume-panel/findings-inbox.jsonl",
    JSON.stringify({
      id: "cd-001", urgency: "HIGH", source: "profiler", type: "contradiction_detected",
      message: "역할 모순.", context: {}, created_at: new Date().toISOString(),
    }) + "\n"
  );

  run({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "/work/some.txt", content: "x" }, cwd: "/tmp/test-resume-panel" });

  const meta = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", "utf-8"));
  const reasons = (meta._score_reasons || []).map(r => r.reason);
  assert.ok(reasons.some(r => r.includes("contradiction_detected")), `contradiction_detected reason missing in ${JSON.stringify(reasons)}`);
  console.log("PASS: Phase 5.7c — contradiction_detected 가중치 +3");
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node /Users/chenjing/dev/chenjing-plugins/plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: 5.7a/b/c FAIL.

- [ ] **Step 3: Add `+3` weight in so_what emission**

`plugins/resume/scripts/episode-watcher.mjs`의 so_what 발행 분기(line 524-547 부근). 메시지 push 직후 score 가산.

기존 (대략 line 533-547):
```js
            if (!hasQuantifiedImpact(ep.star?.result || ep.result || "")) {
              messages.push(
                emit({
                  type: "so_what",
                  episode_title: ep.title || "(제목 없음)",
                  level: 1,
                  episode_ref: { company: project.companyName, project: project.name },
                })
              );
              break;
            }
```

변경 후 (so_what push 직후 metaJSON에 가산):
```js
            if (!hasQuantifiedImpact(ep.star?.result || ep.result || "")) {
              messages.push(
                emit({
                  type: "so_what",
                  episode_title: ep.title || "(제목 없음)",
                  level: 1,
                  episode_ref: { company: project.companyName, project: project.name },
                })
              );
              addProfilerScore(metaJSON, 3, "so_what (+3)");
              break;
            }
```

(`metaJSON`은 같은 storage 블록의 상위 스코프에 있고, 블록 끝에서 한 번에 write되므로 추가 write 불필요.)

- [ ] **Step 4: Add `+3` weight in finding routing for perspective_shift / contradiction_detected**

finding 라우팅 분기(line 631~ 부근, Task 8에서 수정한 곳)의 `for (const f of newFindings)` 루프 안에서, finding type별로 score 가산.

Task 8에서 만들어진 형태에 추가:
```js
    let highFindingDelivered = false;
    let scoreDeltas = [];  // 새로 추가
    for (const f of newFindings) {
      f.delivered = false;

      if (f.urgency === "HIGH") {
        messages.push(emit({ type: "finding", urgency: "HIGH", ... }));
        f.delivered = true;
        highFindingDelivered = true;
      } else if (f.urgency === "MEDIUM" && companyChanged) {
        messages.push(emit({ type: "finding", urgency: "MEDIUM", ... }));
        f.delivered = true;
      }

      // 프로파일러 가중치 — 중요 finding 종류별 +3
      if (f.delivered && (f.type === "perspective_shift" || f.type === "contradiction_detected")) {
        scoreDeltas.push({ delta: 3, reason: `${f.type} (+3)` });
      }

      existing.findings.push(f);
    }
```

그리고 finding 라우팅 블록의 끝부분(`writeFileSync(findingsPath, ...)` 다음)에 score 일괄 가산 + meta 저장:

Task 8에서 만든 형태:
```js
    ensureStateDir();
    writeFileSync(findingsPath, JSON.stringify(existing, null, 2));

    if (companyChanged && snapshot) {
      const updated = { ...snapshot, current_company: meta.current_company };
      writeFileSync(snapshotPath, JSON.stringify(updated));
    }

    if (highFindingDelivered) {
      const metaForTimestamp = migrateMeta(readJSON(metaPath) || {});
      metaForTimestamp._last_high_finding_at = new Date().toISOString();
      writeFileSync(metaPath, JSON.stringify(metaForTimestamp, null, 2));
    }

    try { unlinkSync(processingPath); } catch {}
  }
```

변경 후 (timestamp 갱신과 score 가산을 한 번의 read-write로 통합):
```js
    ensureStateDir();
    writeFileSync(findingsPath, JSON.stringify(existing, null, 2));

    if (companyChanged && snapshot) {
      const updated = { ...snapshot, current_company: meta.current_company };
      writeFileSync(snapshotPath, JSON.stringify(updated));
    }

    if (highFindingDelivered || scoreDeltas.length > 0) {
      const metaForUpdate = migrateMeta(readJSON(metaPath) || {});
      if (highFindingDelivered) {
        metaForUpdate._last_high_finding_at = new Date().toISOString();
      }
      for (const d of scoreDeltas) {
        addProfilerScore(metaForUpdate, d.delta, d.reason);
      }
      writeFileSync(metaPath, JSON.stringify(metaForUpdate, null, 2));
    }

    try { unlinkSync(processingPath); } catch {}
  }
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
node /Users/chenjing/dev/chenjing-plugins/plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: 모든 테스트 PASS, 5.7a/b/c 포함.

- [ ] **Step 6: Commit**

```bash
cd /Users/chenjing/dev/chenjing-plugins
git add plugins/resume/scripts/episode-watcher.mjs plugins/resume/scripts/test-episode-watcher.mjs
git commit -m "$(cat <<'EOF'
feat(resume): so_what/perspective_shift/contradiction +3 weight

so_what 메시지 발행, perspective_shift/contradiction_detected finding 라우팅 시점에
profiler_score +3 가산. 인터뷰의 중요한 분기점 직후 프로파일러 호출 빈도 ↑.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: r2_exit 게이트 통합 검증

**Files:**
- Test: `plugins/resume/scripts/test-episode-watcher.mjs` (append)

**Why:** Task 4가 round_turn_counts를 채우게 됐으니 G3 r2_exit의 `turn_min<15` 검사도 의미를 가진다. round 2에 턴이 충분하면 위반 없음, 부족하면 `missing: ["turn_min"]` 발생을 시뮬레이션.

(코드 변경 없음 — 검증 테스트만 추가.)

- [ ] **Step 1: Write the integration test**

`test-episode-watcher.mjs` 끝부분에 추가:

```js
// Test Phase 5.8a: round_turn_counts["2"] = 15 + recruiter/hr 호출 + gap_analysis → 위반 없음
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({
    session_limits: { gaps: { used: 0, max: 3, intentional: [] }, perspectives: { used: 0, max: 2, episode_refs: [] }, contradictions: { used: 0, max: 2 }, reprobes: { used: 0, log: [] } },
    gate_state: {
      direct_askuserquestion_streak: 0,
      agent_calls_in_current_round: { senior: 0, "c-level": 0, recruiter: 1, hr: 1, "coffee-chat": 0 },
      round_turn_counts: { "0": 0, "1": 10, "2": 15, "3": 0 },
      retrospective_invoked: false,
      last_askuserquestion_source: null,
    },
    current_round: 2,
    profiler_score: 0,
  }));
  writeFileSync("/tmp/test-resume-panel/resume-source.json", JSON.stringify({
    meta: { target_company: "X" },
    companies: [],
    gap_analysis: { met: ["a"], gaps: ["b"] },
  }));
  writeFileSync("/tmp/test-resume-panel/.resume-panel/round-transition.json",
    JSON.stringify({ to: 3, at: new Date().toISOString() }));

  const result = run({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "echo updated > .resume-panel/round-transition.json" },
    cwd: "/tmp/test-resume-panel",
  });

  // 위반 메시지 없어야 함
  const ctxStr = result?.hookSpecificOutput?.additionalContext || "";
  assert.ok(!ctxStr.includes("r2_exit"), `r2_exit violation should NOT fire when all met. Got: ${ctxStr}`);
  console.log("PASS: Phase 5.8a — r2_exit 위반 없음 (turn_min=15 충족)");
}

// Test Phase 5.8b: round_turn_counts["2"] = 14 → missing: ["turn_min"] 발행
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({
    session_limits: { gaps: { used: 0, max: 3, intentional: [] }, perspectives: { used: 0, max: 2, episode_refs: [] }, contradictions: { used: 0, max: 2 }, reprobes: { used: 0, log: [] } },
    gate_state: {
      direct_askuserquestion_streak: 0,
      agent_calls_in_current_round: { senior: 0, "c-level": 0, recruiter: 1, hr: 1, "coffee-chat": 0 },
      round_turn_counts: { "0": 0, "1": 10, "2": 14, "3": 0 },
      retrospective_invoked: false,
      last_askuserquestion_source: null,
    },
    current_round: 2,
    profiler_score: 0,
  }));
  writeFileSync("/tmp/test-resume-panel/resume-source.json", JSON.stringify({
    meta: { target_company: "X" },
    companies: [],
    gap_analysis: { met: ["a"], gaps: ["b"] },
  }));
  writeFileSync("/tmp/test-resume-panel/.resume-panel/round-transition.json",
    JSON.stringify({ to: 3, at: new Date().toISOString() }));

  const result = run({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "echo updated > .resume-panel/round-transition.json" },
    cwd: "/tmp/test-resume-panel",
  });

  const ctxStr = result?.hookSpecificOutput?.additionalContext || "";
  assert.ok(ctxStr.includes('"gate":"r2_exit"'), `r2_exit violation expected. Got: ${ctxStr}`);
  assert.ok(ctxStr.includes('"turn_min"'), `missing turn_min expected. Got: ${ctxStr}`);
  console.log("PASS: Phase 5.8b — r2_exit turn_min<15 위반 발행");
}
```

- [ ] **Step 2: Run tests**

```bash
node /Users/chenjing/dev/chenjing-plugins/plugins/resume/scripts/test-episode-watcher.mjs
```

Expected: 5.8a/b 포함 모든 테스트 PASS. (Task 4 이전이라면 카운트가 0이라 항상 위반이지만, Task 4 완료 후라면 의미 있는 검증.)

- [ ] **Step 3: Commit**

```bash
cd /Users/chenjing/dev/chenjing-plugins
git add plugins/resume/scripts/test-episode-watcher.mjs
git commit -m "$(cat <<'EOF'
test(resume): integration test for r2_exit gate with new round_turn_counts

Task 4의 UserPromptSubmit 카운터가 채운 round_turn_counts 위에서
r2_exit의 turn_min<15 검사가 정상 작동하는지 회귀 테스트.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: docs 갱신 (gates.md, hook-protocol.md)

**Files:**
- Modify: `plugins/resume/skills/resume-panel/references/gates.md` (G3 turn 정의 명시)
- Modify: `plugins/resume/skills/resume-panel/references/hook-protocol.md` (가중치 모델 B 표 추가)

**Why:** 코드가 turn 정의를 가졌으니 docs도 같이 동기화. 후속 라운드/회고가 정의를 일관 참조할 수 있게.

- [ ] **Step 1: Update gates.md G3**

`plugins/resume/skills/resume-panel/references/gates.md`의 G3 섹션에서:

기존(line 23-29 부근):
```markdown
## G3. R2 Exit

**조건**: Round 2에서 Round 3로 전환하기 직전, 다음 4개 중 하나라도 미충족:

- recruiter 에이전트 1회 이상 호출
- hr 에이전트 1회 이상 호출
- Round 2 turn 수 ≥ 15
- gap_analysis.met 또는 gap_analysis.gaps 미설정(빈 배열이라도 배열로 기록)
```

변경 후 (turn 정의 명시 추가):
```markdown
## G3. R2 Exit

**조건**: Round 2에서 Round 3로 전환하기 직전, 다음 4개 중 하나라도 미충족:

- recruiter 에이전트 1회 이상 호출
- hr 에이전트 1회 이상 호출
- Round 2 turn 수 ≥ 15
- gap_analysis.met 또는 gap_analysis.gaps 미설정(빈 배열이라도 배열로 기록)

**turn 정의**: `UserPromptSubmit` hook 이벤트 1회 = 1 turn. 즉 유저가 메시지를 보낼 때마다 `meta.gate_state.round_turn_counts[current_round]`가 +1. AUQ 호출 횟수 기준이 아님(멀티-에이전트 턴에서 과집계되므로).
```

- [ ] **Step 2: Update hook-protocol.md with weight model B**

`plugins/resume/skills/resume-panel/references/hook-protocol.md` 끝부분(line 156 이후)에 새 섹션 추가:

```markdown

## 프로파일러 트리거 가중치 모델 (Model B, 2026-05-06~)

`episode-watcher.mjs`의 `addProfilerScore(meta, delta, reason)` 헬퍼가 다음 이벤트에 따라 `meta.profiler_score`에 가산. 임계 `THRESHOLD = 5` 도달 시 `profiler_trigger` 메시지 emit + score 0 리셋.

| 이벤트 | 점수 | 트리거 위치 |
|---|---|---|
| `resume-source.json` 에피소드 +N | +N | storage 분기 (기존) |
| 새 회사/프로젝트 추가 | +3 | storage 분기 (기존) |
| 빈 STAR result 증가 | +2 | storage 분기 (기존) |
| 역할 축소 키워드(도움/참여 등) | +2 | storage 분기 (기존) |
| meta(target_company/position) 변경 | +2 | storage 분기 (기존) |
| AskUserQuestion 호출 | +1 | AUQ 핸들러 (신규) |
| AUQ + 직전 60초 이내 HIGH finding delivered | +2 추가 (총 +3) | AUQ 핸들러, `meta._last_high_finding_at` 비교 (신규) |
| `so_what` 메시지 발행 | +3 | so_what 발행 분기 (신규) |
| `perspective_shift` finding 라우팅 | +3 | finding 라우팅 분기 (신규) |
| `contradiction_detected` finding 라우팅 | +3 | finding 라우팅 분기 (신규) |

`meta._score_reasons` 배열에 가산 사유 누적(rolling 10). 디버깅·회고 보조용.

`meta._last_high_finding_at` — HIGH finding 라우팅 직후 ISO timestamp 갱신. AUQ 핸들러가 60초 이내 여부를 비교해 importance 보너스 결정.
```

- [ ] **Step 3: Verify markdown renders**

```bash
head -5 /Users/chenjing/dev/chenjing-plugins/plugins/resume/skills/resume-panel/references/gates.md
tail -20 /Users/chenjing/dev/chenjing-plugins/plugins/resume/skills/resume-panel/references/hook-protocol.md
```

Expected: 변경분이 정상 출력.

- [ ] **Step 4: Commit**

```bash
cd /Users/chenjing/dev/chenjing-plugins
git add plugins/resume/skills/resume-panel/references/gates.md plugins/resume/skills/resume-panel/references/hook-protocol.md
git commit -m "$(cat <<'EOF'
docs(resume): document turn definition + profiler weight model B

- gates.md G3: turn = UserPromptSubmit 1회 정의 추가
- hook-protocol.md: 가중치 모델 B 표 신규 (storage + AUQ + finding 중요도)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: 최종 통합 회귀 + 라이브 검증 가이드

**Files:**
- 변경 없음. 검증 단계.

**Why:** 모든 변경이 끝난 시점에서 (a) unit test 전체 회귀 (b) 라이브 검증 절차 명문화.

- [ ] **Step 1: Run full test suite**

```bash
node /Users/chenjing/dev/chenjing-plugins/plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | tee /tmp/test-output.log
```

Expected:
- 모든 PASS 메시지 출력
- 마지막에 `=== ALL TESTS COMPLETE ===`
- exit code 0 (`echo $?`)

- [ ] **Step 2: Manual sanity — hooks.json 파싱**

```bash
node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync('/Users/chenjing/dev/chenjing-plugins/plugins/resume/hooks/hooks.json', 'utf-8')), null, 2))"
```

Expected: PostToolUse + UserPromptSubmit 두 엔트리 모두 출력. matcher에 `Agent` 포함.

- [ ] **Step 3: Manual sanity — episode-watcher.mjs 실행 가능성**

```bash
echo '{"hook_event_name":"UserPromptSubmit","prompt":"test"}' | RESUME_PANEL_BASE=/tmp/sanity-check node /Users/chenjing/dev/chenjing-plugins/plugins/resume/scripts/episode-watcher.mjs && cat /tmp/sanity-check/.resume-panel/meta.json
```

Expected: `meta.gate_state.round_turn_counts.0 === 1`, `current_round` 미설정이라 0으로 누적, 에러 없음.

```bash
rm -rf /tmp/sanity-check
```

- [ ] **Step 4: 라이브 검증 절차 메모 작성**

`docs/superpowers/follow-ups/resume-system-deferred.md`의 끝에 다음 섹션 추가:

```markdown

---

## 다음 라이브 세션 검증 체크리스트 (2026-05-06 spec 후속)

`docs/superpowers/specs/2026-05-06-resume-plugin-counter-reliability-design.md` 시행 효과를 다음 실제 resume 세션의 회고에서 확인:

- [ ] `session-stats.json._debug.observed_tool_names` — Agent/Task 둘 중 어느 쪽이 실제 도착했는지 확인 (가설: Agent 우세).
- [ ] `session-stats.json._debug.observed_hook_events.UserPromptSubmit` — 0이 아닌 값. UserPromptSubmit hook 정상 발화 확인.
- [ ] `meta.json.gate_state.round_turn_counts` — 라운드별 분포가 0이 아닌 값으로 기록.
- [ ] `meta.json.gate_state.agent_calls_in_current_round` — senior/c-level 등 실제 호출 수 반영(수동 동기화 없이).
- [ ] `session-stats.json.agent_invocations` — 위와 동일 일관성.
- [ ] `meta.json.total_profiler_calls` — 직전 세션 3회 대비 5회 이상 증가 (가중치 모델 B 효과).
- [ ] `meta.json._score_reasons` — 최근 점수 가산 사유 10개 보존, 다양한 reason("AUQ", "에피소드 +N", "so_what (+3)" 등) 존재.
- [ ] `gate_violations` 배열 — `r2_exit / turn_min` 위반이 부적절하게 발행되지 않는지 (round 2 정상 진행 시).

위 항목 중 하나라도 비정상이면 후속 라운드 spec(이슈 4·5 + 추가 발견)에 포함.
```

- [ ] **Step 5: Commit verification doc**

```bash
cd /Users/chenjing/dev/chenjing-plugins
git add docs/superpowers/follow-ups/resume-system-deferred.md
git commit -m "$(cat <<'EOF'
docs(resume): add live verification checklist for next session

다음 실제 resume 세션이 완료되면 회고 시점에 _debug/round_turn_counts/
agent_invocations 일관성을 확인하기 위한 체크리스트.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Final git log review**

```bash
cd /Users/chenjing/dev/chenjing-plugins
git log --oneline -15
```

Expected: 본 spec의 모든 task별 커밋이 순서대로 보임. 약 11~12개의 새 커밋.

---

## 비고

- 본 plan은 spec `docs/superpowers/specs/2026-05-06-resume-plugin-counter-reliability-design.md`의 모든 결정 사항을 task로 매핑.
- 라이브 검증 결과는 다음 실제 resume 세션 회고에서 확인하며, 부족분은 후속 라운드 spec에 반영.
- 콘텐츠 회수 항목(버넥트 STAR/Kafka/CJ 추천 루트 등)은 본 plan 범위 외 — 다음 인터뷰 세션에서 처리.
