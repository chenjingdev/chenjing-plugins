# Mid-Session Compaction Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 인터뷰 세션이 250k 토큰을 넘을 때 `/compact`를 가로지르며 작업 흐름을 잇는 브릿지 구조를 구현한다.

**Architecture:** `episode-watcher.mjs`에 3개 hook 분기(UserPromptSubmit 임계치 권고, PreCompact backstop, SessionStart:compact 재로드)를 추가하고, 휘발성 작업 메모리를 `.resume-panel/current-focus.md`에 격리한다. Claude가 작성하고 hook이 라우팅·재주입한다.

**Tech Stack:** Node.js (ESM), Claude Code hooks (PostToolUse / UserPromptSubmit / PreCompact / SessionStart), markdown frontmatter-style metadata.

**Spec:** `docs/superpowers/specs/2026-05-09-mid-session-compaction-bridge-design.md`

---

## File Structure

| 파일 | 책임 | 상태 |
|---|---|---|
| `plugins/resume/scripts/episode-watcher.mjs` | hook 분기 3개 추가 + helper 2개 (`estimateTokens`, `readCurrentFocus`) | 수정 |
| `plugins/resume/scripts/test-episode-watcher.mjs` | Phase 7.x 테스트 블록 | 수정 |
| `plugins/resume/hooks/hooks.json` | PreCompact / SessionStart 이벤트 등록 | 수정 |
| `plugins/resume/skills/resume-panel/references/hook-protocol.md` | `compaction_warning` 메시지 타입 명세 | 수정 |
| `plugins/resume/skills/resume-panel/references/storage.md` | `current-focus.md` 스키마 표 | 수정 |
| `plugins/resume/skills/resume-panel/SKILL.md` | "임계치 도달 시 Claude의 의무" 섹션 | 수정 |

---

## Task 1: `readCurrentFocus` helper + path constant

**Files:**
- Modify: `plugins/resume/scripts/episode-watcher.mjs` (path 상수 블록 + 헬퍼 함수 블록)
- Modify: `plugins/resume/scripts/test-episode-watcher.mjs` (Phase 7 블록 시작)

목표: `current-focus.md`를 읽어 `{session_id, saved_at, turn, raw}` 객체로 반환. 파싱 실패 시 `.bak.<ts>`로 백업 후 null. 파일 없으면 null.

- [ ] **Step 1: Write failing test (file missing)**

`test-episode-watcher.mjs` 파일 끝에 추가:

```js
// ── Phase 7: Mid-session compaction bridge ─────────────

const focusBase = "/tmp/test-resume-panel-focus";

function setupFocusBase(focusContent) {
  rmSync(focusBase, { recursive: true, force: true });
  mkdirSync(join(focusBase, ".resume-panel"), { recursive: true });
  if (focusContent !== undefined) {
    writeFileSync(join(focusBase, ".resume-panel", "current-focus.md"), focusContent);
  }
}

function runFocus(input) {
  try {
    const stdout = execFileSync("node", [script], {
      input: JSON.stringify(input),
      encoding: "utf-8",
      env: { ...process.env, RESUME_PANEL_BASE: focusBase, RESUME_PANEL_FOCUS_PROBE: "1" },
    });
    return stdout.trim() ? JSON.parse(stdout.trim()) : null;
  } catch (e) {
    if (e.stdout) return e.stdout.trim() ? JSON.parse(e.stdout.trim()) : null;
    throw e;
  }
}

// Phase 7.0a — readCurrentFocus: missing file returns null
{
  setupFocusBase(undefined);
  const result = runFocus({
    hook_event_name: "SessionStart",
    source: "compact",
    session_id: "s-1",
  });
  assert.strictEqual(result, null, "missing focus file should produce no output");
  console.log("PASS: Phase 7.0a — readCurrentFocus missing");
}
```

- [ ] **Step 2: Run test, verify it fails**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs`
Expected: existing tests still PASS, but the script may also fail with an unrelated error if we haven't yet set up the SessionStart branch. If "Phase 7.0a" line is the first failure, the test file is wired correctly.

(Note: 이후 task에서 SessionStart 분기를 구현하므로 지금은 단순히 테스트가 추가되어 현재 상태에서 통과함을 확인한다 — `runFocus` SessionStart는 어떤 분기에도 안 잡혀서 hook이 noop으로 종료. assert가 strict null이라 통과해야 함.)

Run again to confirm: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | tail -20`
Expected: PASS line for "Phase 7.0a"

- [ ] **Step 3: Add `currentFocusPath` constant**

`episode-watcher.mjs:31` 근처 (`hookStatePath` 다음 줄):

```js
const hookStatePath = join(stateDir, "hook-state.json");
const currentFocusPath = join(stateDir, "current-focus.md");
```

- [ ] **Step 4: Add `readCurrentFocus` helper**

`episode-watcher.mjs`에서 `absorbLegacyFields` 함수 다음 (line ~504 부근):

```js
function readCurrentFocus() {
  if (!existsSync(currentFocusPath)) return null;
  let raw;
  try {
    raw = readFileSync(currentFocusPath, "utf-8");
  } catch {
    return null;
  }
  const sessionMatch = raw.match(/^session_id:\s*(\S+)\s*$/m);
  const savedAtMatch = raw.match(/^saved_at:\s*(\S+)\s*$/m);
  const turnMatch = raw.match(/^turn:\s*(\d+)\s*$/m);
  if (!sessionMatch || !savedAtMatch) {
    // 파싱 실패 → 백업 후 null
    const bakPath = `${currentFocusPath}.bak.${Date.now()}`;
    try { writeFileSync(bakPath, raw); } catch {}
    return null;
  }
  return {
    session_id: sessionMatch[1],
    saved_at: savedAtMatch[1],
    turn: turnMatch ? parseInt(turnMatch[1], 10) : 0,
    raw,
  };
}
```

- [ ] **Step 5: Add failing test for parse failure backup**

`test-episode-watcher.mjs` 끝에 추가:

```js
// Phase 7.0b — readCurrentFocus: malformed file backed up to .bak
{
  setupFocusBase("# Current Focus\n(no session_id, no saved_at)\n");
  // SessionStart:compact will read it, fail to parse → backup → emit nothing
  runFocus({
    hook_event_name: "SessionStart",
    source: "compact",
    session_id: "s-1",
  });
  const baks = readdirSync(join(focusBase, ".resume-panel")).filter(f => f.startsWith("current-focus.md.bak."));
  assert.ok(baks.length === 1, `expected exactly 1 bak file, got ${baks.length}`);
  console.log("PASS: Phase 7.0b — readCurrentFocus malformed backed up");
}
```

- [ ] **Step 6: Run tests**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | tail -10`
Expected: PASS Phase 7.0a, PASS Phase 7.0b. (SessionStart 분기가 아직 없어도 readCurrentFocus는 helper로 호출 가능. Step 4의 helper만 동작하면 통과한다 — 단, helper는 SessionStart 분기에서만 호출되므로 7.0b는 다음 task에서 SessionStart 분기 구현 후에야 실제로 검증된다. 일단 helper 정의 자체는 syntax 검증.)

Note: 7.0b는 SessionStart 분기 구현(Task 5) 전엔 .bak 파일이 생성되지 않으므로 fail이다. 이 fail은 Task 5에서 fix되도록 의도된 것 — 그때까지 7.0b는 expected fail로 둔다. 일단 Task 1 commit은 7.0a만 통과 상태로 진행.

7.0b는 Task 1 단계에선 주석 처리하고 Task 5에서 활성화한다. Step 5를 다시 다음과 같이 수정한다 (주석 처리):

```js
// Phase 7.0b — activated in Task 5 (SessionStart branch)
// {
//   setupFocusBase("# Current Focus\n(no session_id, no saved_at)\n");
//   runFocus({ hook_event_name: "SessionStart", source: "compact", session_id: "s-1" });
//   const baks = readdirSync(join(focusBase, ".resume-panel")).filter(f => f.startsWith("current-focus.md.bak."));
//   assert.ok(baks.length === 1, `expected exactly 1 bak file, got ${baks.length}`);
//   console.log("PASS: Phase 7.0b — readCurrentFocus malformed backed up");
// }
```

Run again: PASS Phase 7.0a only.

- [ ] **Step 7: Commit**

```bash
git add plugins/resume/scripts/episode-watcher.mjs plugins/resume/scripts/test-episode-watcher.mjs
git commit -m "$(cat <<'EOF'
feat(resume-hook): add readCurrentFocus helper + currentFocusPath

current-focus.md 파일을 읽어 session_id/saved_at/turn 메타를 추출하는
helper. 파싱 실패 시 .bak.<ts> 백업 후 null. SessionStart:compact 분기
구현(Task 5)에서 사용.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `estimateTokens` helper

**Files:**
- Modify: `plugins/resume/scripts/episode-watcher.mjs` (헬퍼 함수 블록)
- Modify: `plugins/resume/scripts/test-episode-watcher.mjs` (Phase 7.0c)

목표: `input.transcript_path` (Claude Code가 hook 입력에 제공) 파일 크기를 4로 나눠 토큰 추정. 경로 없거나 파일 없으면 0.

- [ ] **Step 1: Write failing test**

`test-episode-watcher.mjs` 끝에 추가:

```js
// Phase 7.0c — estimateTokens via transcript_path file size
{
  // 큰 transcript 파일 시뮬레이션: 1MB → ~250k 토큰 추정 (1MB / 4 = 262144)
  const fakeTranscript = join(focusBase, "fake-transcript.jsonl");
  setupFocusBase(undefined);
  writeFileSync(fakeTranscript, "x".repeat(1_048_576)); // 1MB
  const result = runFocus({
    hook_event_name: "UserPromptSubmit",
    transcript_path: fakeTranscript,
    cwd: focusBase,
  });
  // 250k 임계치 초과 → compaction_warning 발화 예상 (Task 3 구현 후 통과)
  // 지금은 helper만 추가 단계 → noop. 일단 noop이면 PASS.
  // 이 테스트는 Task 3에서 활성화. 지금은 placeholder PASS.
  console.log("PASS: Phase 7.0c — placeholder, full check in Task 3");
}
```

- [ ] **Step 2: Run test, verify it passes (placeholder)**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | tail -10`
Expected: PASS Phase 7.0c.

- [ ] **Step 3: Add `estimateTokens` helper**

`episode-watcher.mjs`에서 `readCurrentFocus` 다음에 추가:

```js
function estimateTokens(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== "string") return 0;
  if (!existsSync(transcriptPath)) return 0;
  try {
    const { size } = require("node:fs").statSync(transcriptPath);
    return Math.floor(size / 4);
  } catch {
    return 0;
  }
}
```

위 코드는 `require`를 쓰는데 본 파일이 ESM이라 `require`를 쓸 수 없다. import에 statSync 추가:

```js
// 파일 상단 import 라인 수정
import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync, unlinkSync, statSync } from "node:fs";
```

그리고 helper 본체:

```js
function estimateTokens(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== "string") return 0;
  if (!existsSync(transcriptPath)) return 0;
  try {
    const { size } = statSync(transcriptPath);
    return Math.floor(size / 4);
  } catch {
    return 0;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | tail -10`
Expected: 모든 기존 PASS + PASS Phase 7.0c.

- [ ] **Step 5: Commit**

```bash
git add plugins/resume/scripts/episode-watcher.mjs plugins/resume/scripts/test-episode-watcher.mjs
git commit -m "$(cat <<'EOF'
feat(resume-hook): add estimateTokens helper

transcript_path 파일 크기 / 4 로 토큰을 rough estimate.
UserPromptSubmit 분기(Task 3)에서 250k 임계치 비교에 사용.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: UserPromptSubmit — `compaction_warning` 임계치 권고

**Files:**
- Modify: `plugins/resume/scripts/episode-watcher.mjs` (UserPromptSubmit 분기 — 현재 `episode-watcher.mjs:42-58`)
- Modify: `plugins/resume/scripts/test-episode-watcher.mjs` (Phase 7.1, 7.2, 7.2b)

목표: UserPromptSubmit hook에서 `estimateTokens(input.transcript_path) >= 250000`이면 `compaction_warning` additionalContext 주입. 단 `current-focus.md`의 `saved_at`이 5분 이내면 suppress.

- [ ] **Step 1: Write failing test (under threshold)**

기존 Phase 7.0c 자리를 다음으로 교체:

```js
// Phase 7.1 — UserPromptSubmit: under 250k → no warning
{
  const fakeTranscript = join(focusBase, "small-transcript.jsonl");
  setupFocusBase(undefined);
  writeFileSync(fakeTranscript, "x".repeat(100_000)); // 100KB → 25k tokens
  const result = runFocus({
    hook_event_name: "UserPromptSubmit",
    transcript_path: fakeTranscript,
    cwd: focusBase,
  });
  if (result && result.hookSpecificOutput && result.hookSpecificOutput.additionalContext) {
    assert.ok(!result.hookSpecificOutput.additionalContext.includes("compaction_warning"),
      "should not emit compaction_warning under threshold");
  }
  console.log("PASS: Phase 7.1 — under threshold no warning");
}

// Phase 7.2 — UserPromptSubmit: >= 250k → warning emitted
{
  const fakeTranscript = join(focusBase, "big-transcript.jsonl");
  setupFocusBase(undefined);
  writeFileSync(fakeTranscript, "x".repeat(1_100_000)); // 1.1MB → ~275k tokens
  const result = runFocus({
    hook_event_name: "UserPromptSubmit",
    transcript_path: fakeTranscript,
    cwd: focusBase,
  });
  assert.ok(result, "should produce output above threshold");
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('"type":"compaction_warning"'), "should emit compaction_warning");
  console.log("PASS: Phase 7.2 — over threshold warning emitted");
}

// Phase 7.2b — de-bounce: focus saved within 5 min → suppress warning
{
  const fakeTranscript = join(focusBase, "big-transcript-2.jsonl");
  setupFocusBase(`# Current Focus\nsession_id: s-1\nsaved_at: ${new Date().toISOString()}\nturn: 5\n`);
  writeFileSync(fakeTranscript, "x".repeat(1_100_000));
  const result = runFocus({
    hook_event_name: "UserPromptSubmit",
    transcript_path: fakeTranscript,
    cwd: focusBase,
  });
  if (result && result.hookSpecificOutput && result.hookSpecificOutput.additionalContext) {
    assert.ok(!result.hookSpecificOutput.additionalContext.includes("compaction_warning"),
      "should suppress warning when focus is fresh (<5min)");
  }
  console.log("PASS: Phase 7.2b — de-bounce within 5min");
}
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | grep -E "(Phase 7|FAIL|Error)" | tail -20`
Expected: Phase 7.2 fails (no compaction_warning emitted yet). 7.1 / 7.2b 통과 (현재 미구현이라 어차피 발화 안함).

- [ ] **Step 3: Add threshold logic to UserPromptSubmit branch**

`episode-watcher.mjs:42-58` 의 UserPromptSubmit 분기에서 `process.exit(0);` 직전에 추가:

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

  // ── compaction_warning 분기 ───────────────────────
  const tokens = estimateTokens(input.transcript_path);
  const TOKEN_THRESHOLD = 250_000;
  if (tokens >= TOKEN_THRESHOLD) {
    const focus = readCurrentFocus();
    let suppress = false;
    if (focus) {
      const ageMs = Date.now() - new Date(focus.saved_at).getTime();
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 5 * 60_000) {
        suppress = true;
      }
    }
    if (!suppress) {
      const payload = emit({
        type: "compaction_warning",
        tokens_estimate: tokens,
        threshold: TOKEN_THRESHOLD,
        message: "컨텍스트가 250k 토큰 이상이다. 다음 응답 직전에 .resume-panel/current-focus.md를 references/storage.md 스키마대로 저장하고, 사용자에게 '/compact 권고' 한 줄 안내해라.",
      });
      process.stdout.write(JSON.stringify({
        continue: true,
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: payload,
        },
      }));
    }
  }

  process.exit(0);
}
```

- [ ] **Step 4: Run tests**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | grep -E "(Phase 7|FAIL)" | tail -10`
Expected: PASS Phase 7.1, PASS Phase 7.2, PASS Phase 7.2b. 기존 모든 PASS 유지.

- [ ] **Step 5: Run full test suite**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | tail -5`
Expected: 모든 PASS, FAIL 없음. 마지막에 "All tests passed" 또는 동등 메시지.

- [ ] **Step 6: Commit**

```bash
git add plugins/resume/scripts/episode-watcher.mjs plugins/resume/scripts/test-episode-watcher.mjs
git commit -m "$(cat <<'EOF'
feat(resume-hook): emit compaction_warning at 250k tokens

UserPromptSubmit hook이 transcript 파일 크기 기준 추정 토큰이 250k
이상이면 additionalContext로 compaction_warning을 주입한다.
current-focus.md가 5분 이내 작성된 경우 suppress (de-bounce).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: PreCompact 분기 (backstop) + hooks.json 등록

**Files:**
- Modify: `plugins/resume/scripts/episode-watcher.mjs` (PreCompact 분기 신설)
- Modify: `plugins/resume/scripts/test-episode-watcher.mjs` (Phase 7.3, 7.4)
- Modify: `plugins/resume/hooks/hooks.json` (PreCompact 등록)

목표: `hook_event_name === "PreCompact"`인 경우 current-focus.md가 없거나 5분 이상 stale이면 backstop 메시지를 additionalContext로 주입.

- [ ] **Step 1: Write failing test**

`test-episode-watcher.mjs` 끝에 추가:

```js
// Phase 7.3 — PreCompact: focus missing → backstop emit
{
  setupFocusBase(undefined);
  const result = runFocus({
    hook_event_name: "PreCompact",
    session_id: "s-1",
  });
  assert.ok(result, "PreCompact with no focus should produce output");
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('"type":"compaction_warning"'), "should emit compaction_warning");
  assert.ok(ctx.includes('"backstop":true'), "should mark as backstop");
  console.log("PASS: Phase 7.3 — PreCompact backstop missing focus");
}

// Phase 7.4 — PreCompact: fresh focus (<5min) → noop
{
  setupFocusBase(`# Current Focus\nsession_id: s-1\nsaved_at: ${new Date().toISOString()}\nturn: 5\n`);
  const result = runFocus({
    hook_event_name: "PreCompact",
    session_id: "s-1",
  });
  assert.strictEqual(result, null, "PreCompact with fresh focus should noop");
  console.log("PASS: Phase 7.4 — PreCompact fresh focus noop");
}

// Phase 7.4b — PreCompact: stale focus (>5min) → backstop emit
{
  const stale = new Date(Date.now() - 6 * 60_000).toISOString();
  setupFocusBase(`# Current Focus\nsession_id: s-1\nsaved_at: ${stale}\nturn: 5\n`);
  const result = runFocus({
    hook_event_name: "PreCompact",
    session_id: "s-1",
  });
  assert.ok(result, "PreCompact with stale focus should emit backstop");
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('"type":"compaction_warning"'), "should emit compaction_warning");
  console.log("PASS: Phase 7.4b — PreCompact backstop stale focus");
}
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | grep -E "(Phase 7|FAIL|Error)" | tail -10`
Expected: Phase 7.3, 7.4b fail (no PreCompact branch yet). Phase 7.4 통과 (default noop).

- [ ] **Step 3: Add PreCompact branch**

`episode-watcher.mjs`의 UserPromptSubmit 분기 직후 (line ~58 다음, Agent/Task 분기 앞):

```js
// ── PreCompact 분기 — backstop 메시지 ──────────────
if (input.hook_event_name === "PreCompact") {
  ensureStateDir();
  const focus = readCurrentFocus();
  let needsBackstop = true;
  if (focus) {
    const ageMs = Date.now() - new Date(focus.saved_at).getTime();
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 5 * 60_000) {
      needsBackstop = false;
    }
  }
  if (needsBackstop) {
    const payload = emit({
      type: "compaction_warning",
      backstop: true,
      message: "compact 직전 backstop. current-focus.md가 없거나 stale이다. 가능하면 즉시 references/storage.md 스키마대로 저장 후 compact 진행. (이 메시지는 PreCompact 시점에 hook이 주입한 것)",
    });
    process.stdout.write(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreCompact",
        additionalContext: payload,
      },
    }));
  }
  process.exit(0);
}
```

- [ ] **Step 4: Register PreCompact in hooks.json**

`plugins/resume/hooks/hooks.json` 에 새 키 추가:

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
    ],
    "PreCompact": [
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

- [ ] **Step 5: Run tests**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | grep -E "(Phase 7|FAIL)" | tail -15`
Expected: PASS Phase 7.3, PASS Phase 7.4, PASS Phase 7.4b. 기존 모든 PASS 유지.

- [ ] **Step 6: Commit**

```bash
git add plugins/resume/scripts/episode-watcher.mjs plugins/resume/scripts/test-episode-watcher.mjs plugins/resume/hooks/hooks.json
git commit -m "$(cat <<'EOF'
feat(resume-hook): add PreCompact backstop branch

current-focus.md가 없거나 5분 이상 stale일 때 PreCompact 시점에
compaction_warning(backstop=true)을 additionalContext로 주입한다.
Task 3 임계치 권고를 Claude가 무시한 경우의 마지막 알림.

hooks.json에 PreCompact 이벤트 등록 추가.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: SessionStart:compact 분기 (재로드) + hooks.json 등록

**Files:**
- Modify: `plugins/resume/scripts/episode-watcher.mjs` (SessionStart 분기 신설)
- Modify: `plugins/resume/scripts/test-episode-watcher.mjs` (Phase 7.5~7.9)
- Modify: `plugins/resume/hooks/hooks.json` (SessionStart 등록)

목표: `hook_event_name === "SessionStart" && input.source === "compact"`이면 current-focus.md를 읽고 매칭 규칙(session_id 일치 + 30분 이내) 통과 시 raw 본문을 additionalContext로 주입. 일반 SessionStart는 noop.

매칭 규칙 매트릭스 (spec §5.1):

| 조건 | 처리 |
|---|---|
| `source !== "compact"` | 무시 |
| 파일 없음 | 무시 |
| `session_id` 불일치 | 무시 |
| `saved_at` 30분 초과 | 무시 |
| 위 모두 통과 | additionalContext 주입 |

- [ ] **Step 1: Write failing tests**

`test-episode-watcher.mjs` 끝에 추가하고, Task 1 Step 5에서 주석 처리한 7.0b를 활성화:

```js
// Phase 7.0b — readCurrentFocus malformed → backup (activated here)
{
  setupFocusBase("# Current Focus\n(no session_id, no saved_at)\n");
  runFocus({
    hook_event_name: "SessionStart",
    source: "compact",
    session_id: "s-1",
  });
  const baks = readdirSync(join(focusBase, ".resume-panel")).filter(f => f.startsWith("current-focus.md.bak."));
  assert.ok(baks.length === 1, `expected exactly 1 bak file, got ${baks.length}`);
  console.log("PASS: Phase 7.0b — readCurrentFocus malformed backed up");
}

// Phase 7.5 — SessionStart:compact match → reload
{
  const now = new Date().toISOString();
  const focusContent = `# Current Focus\nsession_id: sess-abc\nsaved_at: ${now}\nturn: 12\n\n## 활성 컨텍스트\n- round: 1\n- 회사: 코인원\n`;
  setupFocusBase(focusContent);
  const result = runFocus({
    hook_event_name: "SessionStart",
    source: "compact",
    session_id: "sess-abc",
  });
  assert.ok(result, "matching SessionStart:compact should produce output");
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes("session_id: sess-abc"), "additionalContext should contain raw focus");
  assert.ok(ctx.includes("코인원"), "should preserve focus body");
  console.log("PASS: Phase 7.5 — SessionStart:compact reload");
}

// Phase 7.6 — SessionStart:compact session_id mismatch → no inject
{
  const now = new Date().toISOString();
  setupFocusBase(`# Current Focus\nsession_id: sess-OLD\nsaved_at: ${now}\nturn: 5\n`);
  const result = runFocus({
    hook_event_name: "SessionStart",
    source: "compact",
    session_id: "sess-NEW",
  });
  assert.strictEqual(result, null, "session_id mismatch should produce no output");
  console.log("PASS: Phase 7.6 — session_id mismatch ignored");
}

// Phase 7.7 — SessionStart:compact stale (>30min) → no inject
{
  const stale = new Date(Date.now() - 31 * 60_000).toISOString();
  setupFocusBase(`# Current Focus\nsession_id: sess-abc\nsaved_at: ${stale}\nturn: 5\n`);
  const result = runFocus({
    hook_event_name: "SessionStart",
    source: "compact",
    session_id: "sess-abc",
  });
  assert.strictEqual(result, null, "stale focus (>30min) should produce no output");
  console.log("PASS: Phase 7.7 — stale focus ignored");
}

// Phase 7.8 — SessionStart non-compact source → noop
{
  const now = new Date().toISOString();
  setupFocusBase(`# Current Focus\nsession_id: sess-abc\nsaved_at: ${now}\nturn: 5\n`);
  const result = runFocus({
    hook_event_name: "SessionStart",
    source: "startup",
    session_id: "sess-abc",
  });
  assert.strictEqual(result, null, "non-compact SessionStart should noop");
  console.log("PASS: Phase 7.8 — non-compact source ignored");
}

// Phase 7.9 — SessionStart:compact missing focus → noop
{
  setupFocusBase(undefined);
  const result = runFocus({
    hook_event_name: "SessionStart",
    source: "compact",
    session_id: "sess-abc",
  });
  assert.strictEqual(result, null, "missing focus should noop");
  console.log("PASS: Phase 7.9 — missing focus ignored");
}
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | grep -E "(Phase 7\.|FAIL|Error)" | tail -20`
Expected: Phase 7.5, 7.0b fail (no SessionStart branch). 7.6, 7.7, 7.8, 7.9는 default null 반환이라 통과.

- [ ] **Step 3: Add SessionStart branch**

`episode-watcher.mjs`의 PreCompact 분기 직후:

```js
// ── SessionStart 분기 — compact 직후 focus 재로드 ──
if (input.hook_event_name === "SessionStart") {
  if (input.source !== "compact") {
    process.exit(0);
  }
  const focus = readCurrentFocus();
  if (!focus) {
    process.exit(0);
  }
  if (focus.session_id !== input.session_id) {
    process.exit(0);
  }
  const ageMs = Date.now() - new Date(focus.saved_at).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 30 * 60_000) {
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: focus.raw,
    },
  }));
  process.exit(0);
}
```

- [ ] **Step 4: Register SessionStart in hooks.json**

`plugins/resume/hooks/hooks.json` 에 SessionStart 키 추가:

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
    ],
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/episode-watcher.mjs\"",
            "timeout": 10
          }
        ]
      }
    ],
    "SessionStart": [
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

- [ ] **Step 5: Run tests**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | grep -E "(Phase 7\.|FAIL)" | tail -15`
Expected: PASS Phase 7.0b, 7.5, 7.6, 7.7, 7.8, 7.9. 기존 PASS 모두 유지.

- [ ] **Step 6: Run full test suite**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | tail -5`
Expected: 모든 PASS, FAIL 0.

- [ ] **Step 7: Commit**

```bash
git add plugins/resume/scripts/episode-watcher.mjs plugins/resume/scripts/test-episode-watcher.mjs plugins/resume/hooks/hooks.json
git commit -m "$(cat <<'EOF'
feat(resume-hook): SessionStart:compact reloads current-focus.md

SessionStart 분기를 추가하고 source==="compact" + session_id 일치 +
saved_at 30분 이내 조건을 모두 만족할 때 current-focus.md raw 본문을
additionalContext로 주입한다. compact 직후 휘발성 작업 메모리 복원.

hooks.json에 SessionStart 이벤트 등록 추가.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `references/hook-protocol.md` — `compaction_warning` 메시지 명세

**Files:**
- Modify: `plugins/resume/skills/resume-panel/references/hook-protocol.md`

목표: 새 메시지 타입 `compaction_warning`을 §6 또는 §메시지 타입 끝에 추가. trigger 조건, payload 필드, Claude 처리 의무 명시.

- [ ] **Step 1: Read current hook-protocol.md to find insertion point**

`plugins/resume/skills/resume-panel/references/hook-protocol.md`의 §5 LOW finding 끝, "## 인터뷰 흐름 보호" 직전 위치 확인.

- [ ] **Step 2: Insert new section**

§5 LOW finding 다음 (현재 line 99 부근), "## 인터뷰 흐름 보호" 앞에 다음 추가:

```markdown
### 6. `compaction_warning` (2026-05-09~)

세션 컨텍스트가 250k+ 토큰을 넘었거나 PreCompact 시점에 발행. compact 전후 작업 흐름을 잇는 브릿지 트리거.

```json
{
  "type": "compaction_warning",
  "tokens_estimate": 280000,
  "threshold": 250000,
  "backstop": false,
  "message": "..."
}
```

**필드**:
- `tokens_estimate`: transcript 파일 크기 / 4 추정 토큰 수 (UserPromptSubmit 발행 시).
- `threshold`: 임계치 (현재 250000).
- `backstop`: PreCompact 시점에서 발행된 보조 알림이면 `true`. UserPromptSubmit 임계치 권고는 `false`.
- `message`: Claude에게 전달되는 행동 지시문.

**발행 주체**:
- UserPromptSubmit hook — `tokens_estimate >= 250000` AND `current-focus.md`의 `saved_at`이 5분 이내가 아닌 경우.
- PreCompact hook — `current-focus.md`가 없거나 5분 이상 stale인 경우.

**Claude 처리 의무**:
1. 다음 응답 직전에 `.resume-panel/current-focus.md`를 `references/storage.md` §current-focus.md 스키마대로 저장.
2. 사용자에게 "/compact 권고" 한 줄 안내.
3. 5분 이내 같은 경고가 또 와도 이미 저장된 파일이 있으면 hook 측 de-bounce로 suppress된다 (Claude는 매번 답할 필요 없음).

**재로드**: `/compact` 후 `SessionStart` hook의 `source === "compact"` 분기가 current-focus.md를 자동으로 additionalContext에 주입한다. Claude는 추가 동작 없이 다음 사용자 발화에 이어서 응답.
```

(코드블록 안의 ```json ... ``` 펜스 처리 주의: outer 마크다운에서 inner는 ` ``` ` 형태 그대로 둔다.)

- [ ] **Step 3: Verify file structure**

Run: `grep -n "^### " plugins/resume/skills/resume-panel/references/hook-protocol.md`
Expected: `### 1. profiler_trigger`, `### 2. finding`, ..., `### 5. LOW finding`, `### 6. compaction_warning`이 순서대로.

- [ ] **Step 4: Commit**

```bash
git add plugins/resume/skills/resume-panel/references/hook-protocol.md
git commit -m "$(cat <<'EOF'
docs(resume-hook-protocol): add compaction_warning message type

§6에 compaction_warning 추가 — UserPromptSubmit 임계치 권고와
PreCompact backstop 양쪽에서 발행. Claude 처리 의무 명시.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `references/storage.md` — `current-focus.md` 스키마 추가

**Files:**
- Modify: `plugins/resume/skills/resume-panel/references/storage.md`

목표: `hook-state.json` 섹션 다음에 `current-focus.md` 스키마 표 + 작성 책임 + 라이프사이클 추가.

- [ ] **Step 1: Insert new section after hook-state.json (line 128 부근)**

`plugins/resume/skills/resume-panel/references/storage.md`의 "writer: episode-watcher hook 단독." 다음 줄, "## resume-draft.md Structure" 직전에 추가:

```markdown
### `current-focus.md` (신규, 2026-05-09~)

세션 중 컨텍스트가 250k+ 토큰을 넘어 `/compact`가 임박했을 때, compact를 가로질러 활성 작업 메모리를 잇기 위한 브릿지 파일. 위치: `<base>/.resume-panel/current-focus.md`.

**스키마** (markdown):

```markdown
# Current Focus

session_id: <Claude Code session UUID>
saved_at: <ISO8601 timestamp>
turn: <누적 턴 수>

## 활성 컨텍스트
- round: <0|1|1.5|2|3>
- 회사: <현재 다루는 회사명 또는 null>
- 활성 페르소나: <senior|c-level|recruiter|hr|coffee-chat|null>

## 검증 중인 클레임
- <fact-check 중이거나 STAR 보강 중인 1-3개 항목>

## 다음 턴 액션
- <다음 사용자 발화에 어떻게 반응하려 했는지 1-2줄>

## 미해결 sub-thread
- [ ] <짧고 즉시 처리 가능한 미완 항목>

## 직전 흐름 (4-5턴 압축)
<자유 텍스트 200-400자>
```

**필수 필드**: `session_id`, `saved_at`. 둘 중 하나라도 누락되면 hook이 파싱 실패로 간주하고 `.bak.<ts>`로 백업 후 무시.

**writer**: Claude (오케스트레이터). hook은 절대 작성하지 않는다 — 휘발 메모리는 Claude만 알기 때문.

**reader**: episode-watcher hook의 SessionStart:compact 분기. 매칭 조건 (session_id 일치 + saved_at 30분 이내) 통과 시 raw 본문을 additionalContext로 주입.

**라이프사이클**:
1. UserPromptSubmit hook이 250k 토큰 임계치 도달 시 `compaction_warning` 발행 → Claude가 작성.
2. 사용자가 `/compact` 입력 → compact 실행 → 새 컨텍스트.
3. SessionStart:compact hook이 자동 재로드.
4. 다음 정상 compact-resume 사이클이 자동으로 덮어쓴다.

**영속 facts와의 책임 분리**:
- `meta.json` / `hook-state.json` / `findings.json` / episode log는 **확정된 사실** 보관.
- `current-focus.md`는 **휘발성 작업 메모리만** 보관.
- 중복 금지: STAR 데이터, 회사 메타, finding 같은 fact는 영속 파일에 이미 있으니 current-focus.md에 다시 적지 않는다.
```

- [ ] **Step 2: Verify section ordering**

Run: `grep -n "^### " plugins/resume/skills/resume-panel/references/storage.md`
Expected: `### hook-state.json (신규, 2026-05-07~)`, `### current-focus.md (신규, 2026-05-09~)` 순.

- [ ] **Step 3: Commit**

```bash
git add plugins/resume/skills/resume-panel/references/storage.md
git commit -m "$(cat <<'EOF'
docs(resume-storage): add current-focus.md schema and lifecycle

휘발성 작업 메모리를 compact 가로질러 잇는 브릿지 파일 명세 추가.
영속 facts(meta/hook-state/findings/episode log)와의 책임 분리 명시.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `SKILL.md` — Claude 의무 섹션 추가

**Files:**
- Modify: `plugins/resume/skills/resume-panel/SKILL.md`

목표: `compaction_warning` 메시지 받았을 때 Claude의 작성 형식과 사용자 안내 문구 정형화. SKILL.md 적절한 위치에 새 섹션 추가.

- [ ] **Step 1: Find insertion point**

Run: `grep -n "^## " plugins/resume/skills/resume-panel/SKILL.md`
SKILL.md의 "## 라운드별 저장 타이밍" (line 243 부근) 또는 "## 자율 오케스트레이션" 앞 위치를 확인.

- [ ] **Step 2: Insert new section before "## 라운드별 저장 타이밍"**

SKILL.md "## 라운드별 저장 타이밍" 직전에 추가:

```markdown
## 컨텍스트 압축 브릿지 (`compaction_warning`)

hook이 `[resume-panel]{"type":"compaction_warning",...}` 메시지를 보낸 경우 — UserPromptSubmit 임계치 권고든 PreCompact backstop이든 — 다음을 동일하게 수행한다.

**1. 파일 작성**: `.resume-panel/current-focus.md`를 `references/storage.md` §current-focus.md 스키마대로 저장. 다음 7개 섹션을 모두 채운다:

- `session_id` — Claude Code 환경에서 알 수 있는 세션 ID. 모르면 임의의 UUID라도 부여.
- `saved_at` — 현재 ISO8601 타임스탬프.
- `turn` — 현재까지 누적 턴 수 (대략 추정 가능).
- `## 활성 컨텍스트` — round, 다루는 회사, 활성 페르소나.
- `## 검증 중인 클레임` — 지금 사용자한테 fact-check 중이거나 STAR 보강 중인 항목.
- `## 다음 턴 액션` — 사용자 다음 발화에 어떻게 반응하려 했는지.
- `## 미해결 sub-thread` — 짧고 즉시 처리 가능한 미완 항목.
- `## 직전 흐름 (4-5턴 압축)` — 자유 텍스트 200-400자.

**중복 금지**: STAR 데이터, 회사 메타, finding 같은 확정된 사실은 영속 파일(`meta.json`/`hook-state.json`/`findings.json`/episode log)이 이미 갖고 있다. current-focus.md는 **휘발성 작업 메모리만** 담는다.

**2. 사용자 안내**: 한 줄로 안내한다.

> "컨텍스트가 250k를 넘어 `/compact` 권고합니다. 작업 메모리는 `.resume-panel/current-focus.md`에 저장했고 compact 직후 자동 복원됩니다."

**3. compact 후 동작**: SessionStart:compact hook이 current-focus.md를 자동으로 컨텍스트에 주입한다. Claude는 추가 동작 없이 사용자 다음 발화에 이어서 응답하면 된다.

**De-bounce**: 5분 이내 동일 경고가 또 들어와도 hook이 자동 suppress하므로 매번 다시 작성할 필요 없음. 단 이미 작성된 파일을 갱신할 필요는 있을 수 있다 (직전 흐름이 변했으면).
```

- [ ] **Step 3: Verify section is in place**

Run: `grep -n "^## " plugins/resume/skills/resume-panel/SKILL.md | head -30`
Expected: "## 컨텍스트 압축 브릿지" 섹션이 "## 라운드별 저장 타이밍" 앞에 위치.

- [ ] **Step 4: Commit**

```bash
git add plugins/resume/skills/resume-panel/SKILL.md
git commit -m "$(cat <<'EOF'
docs(resume-skill): add 'compaction_warning' Claude obligations

compaction_warning hook 메시지 처리 — current-focus.md 작성 형식
(7개 섹션) + 사용자 안내 문구 + de-bounce 동작 정형화.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: 통합 sanity check + follow-up 갱신

**Files:**
- Read-only verification on multiple files
- Modify: `docs/superpowers/follow-ups/resume-system-deferred.md` (라이브 검증 항목 추가)

목표: 전체 흐름 통합 점검 + 다음 라이브 인터뷰에서 검증할 체크리스트를 follow-up 문서에 추가.

- [ ] **Step 1: Run full test suite, confirm all pass**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 | tail -5`
Expected: 모든 PASS. FAIL 0. 새로 추가된 Phase 7.0a, 7.0b, 7.1, 7.2, 7.2b, 7.3, 7.4, 7.4b, 7.5, 7.6, 7.7, 7.8, 7.9 모두 PASS.

- [ ] **Step 2: Verify hook event registration**

Run: `node -e "const j=require('./plugins/resume/hooks/hooks.json'); console.log(Object.keys(j.hooks).sort().join(','))"`
Expected: `PostToolUse,PreCompact,SessionStart,UserPromptSubmit`

- [ ] **Step 3: Verify references cross-link**

Run: `grep -l "compaction_warning\|current-focus.md" plugins/resume/skills/resume-panel/references/*.md plugins/resume/skills/resume-panel/SKILL.md`
Expected: 4개 파일 모두 일치 — `hook-protocol.md`, `storage.md`, `SKILL.md` (3개). `agent-contract.md`는 미포함이어도 됨.

- [ ] **Step 4: Add live verification checklist to follow-up doc**

`docs/superpowers/follow-ups/resume-system-deferred.md` 끝의 "다음 라이브 세션 검증 체크리스트" 섹션에 다음 추가:

```markdown

## 다음 라이브 세션 검증 체크리스트 (2026-05-09 spec 후속)

`docs/superpowers/specs/2026-05-09-mid-session-compaction-bridge-design.md` 시행 효과를 다음 실제 resume 세션 — 컨텍스트가 250k 이상으로 늘어난 세션 — 의 회고에서 확인:

- [ ] 컨텍스트 ≥ 250k 시점에 hook이 `[resume-panel]{"type":"compaction_warning",...}`을 한 번 이상 발행했는지 transcript 또는 디버그 로그에서 확인.
- [ ] Claude가 `compaction_warning` 받은 직후 턴에 `.resume-panel/current-focus.md`를 작성했는지 (`saved_at` 타임스탬프 기준).
- [ ] current-focus.md에 `session_id`, `saved_at`, `turn` 메타가 모두 있고, 7개 섹션(활성 컨텍스트/검증 중인 클레임/다음 턴 액션/미해결 sub-thread/직전 흐름) 모두 채워졌는지.
- [ ] 5분 이내 추가 UserPromptSubmit이 와도 `compaction_warning`이 다시 발화하지 않는지 (de-bounce 동작).
- [ ] `/compact` 직전 PreCompact backstop이 발화했거나, 발화하지 않은 경우 그 이유 (focus가 5분 이내 신선이었음).
- [ ] `/compact` 직후 새 컨텍스트에 current-focus.md raw 본문이 additionalContext로 들어왔는지 (Claude가 그 내용을 인지하고 있는지 회고에서 확인).
- [ ] session_id가 새 세션과 일치하지 않거나 30분 초과인 경우 재주입이 일어나지 않는지 (negative test — 다른 세션 시작 시).

위 항목 중 하나라도 비정상이면 후속 라운드 spec에 포함.
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/follow-ups/resume-system-deferred.md
git commit -m "$(cat <<'EOF'
docs(follow-up): add 2026-05-09 compaction bridge verification checklist

다음 라이브 세션에서 mid-session compaction bridge 효과 확인할
7개 체크리스트 항목 추가. 250k 임계치 발화, current-focus.md 작성,
de-bounce, /compact 재주입, session_id mismatch negative.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Checklist (planner 자체)

- [x] **Spec coverage**:
  - §1 문제 → 동기 (Task 4-5의 PreCompact backstop + SessionStart 재로드가 작업 흐름 단절을 해결)
  - §2 결정 (3-layer) → Task 1-2 helper, Task 3-5 분기 구현
  - §3.1 임계치 권고 → Task 3
  - §3.2 토큰 추정 → Task 2
  - §3.3 PreCompact backstop → Task 4
  - §4 스키마 → Task 7 (storage.md), Task 8 (SKILL.md 의무)
  - §5 재로드 매칭 규칙 → Task 5 + tests 7.5/7.6/7.7/7.8/7.9
  - §6 컴포넌트 — 모든 변경 대상 task로 매핑됨
  - §7 에러 처리 → Task 1 (.bak), Task 5 (negative cases), Task 4 (backstop이 missing/stale 모두 커버)
  - §8 테스트 — Task 1-5에 9개 Phase 7.x 블록 분산
  - §9 비스코프 — 자동 /compact, ±10% 정확도 등 의도적 미구현
  - §10 cross-reference → Task 6, 7, 8 모두 명시

- [x] **Placeholder scan**: 모든 step에 실제 code block 또는 정확한 명령 포함. "TBD"/"적절한"/"기타" 없음.

- [x] **Type consistency**: `currentFocusPath`, `readCurrentFocus`, `estimateTokens` — 모든 task에서 동일 이름 사용. `compaction_warning` 메시지 type, `tokens_estimate`/`threshold`/`backstop` 필드명 — Task 3, 4, 6에서 동일.

- [x] **TDD**: 각 task가 failing test → impl → passing test 순서.

- [x] **Bite-sized**: 각 task 5-7 step. 한 step은 2-5분 분량.
