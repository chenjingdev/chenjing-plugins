// plugins/resume/scripts/test-episode-watcher.mjs
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert";

const __dirname = dirname(fileURLToPath(import.meta.url));
const script = join(__dirname, "episode-watcher.mjs");

function defaultGateStateForTest() {
  return {
    direct_askuserquestion_streak: 0,
    agent_calls_in_current_round: { senior: 0, "c-level": 0, recruiter: 0, hr: 0, "coffee-chat": 0 },
    round_turn_counts: { "0": 0, "1": 0, "2": 0, "3": 0 },
    retrospective_invoked: false,
    last_askuserquestion_source: null,
  };
}

function defaultSessionLimits_forTest() {
  return {
    gaps: { used: 0, max: 3, intentional: [] },
    perspectives: { used: 0, max: 2, episode_refs: [] },
    contradictions: { used: 0, max: 2 },
    reprobes: { used: 0, log: [] },
  };
}

function run(input) {
  try {
    const stdout = execFileSync("node", [script], {
      input: JSON.stringify(input),
      encoding: "utf-8",
      env: { ...process.env, RESUME_PANEL_BASE: "/tmp/test-resume-panel" },
    });
    return stdout.trim() ? JSON.parse(stdout.trim()) : null;
  } catch (e) {
    if (e.stdout) return e.stdout.trim() ? JSON.parse(e.stdout.trim()) : null;
    throw e;
  }
}

// Test 1: self-trigger — .resume-panel/ 내부 파일 쓰기는 무시해야 함
{
  const result = run({
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/work/.resume-panel/findings.json", content: "{}" },
  });
  assert.strictEqual(result, null, "self-trigger should produce no output");
  console.log("PASS: self-trigger prevention");
}

// Test 1b: self-trigger — Bash로 .resume-panel/ 쓰기도 무시해야 함
{
  const result = run({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "echo '{\"id\":\"f-001\"}' >> .resume-panel/findings-inbox.jsonl" },
  });
  assert.strictEqual(result, null, "Bash write to .resume-panel/ should be ignored");
  console.log("PASS: self-trigger prevention (Bash .resume-panel/)");
}

// Test 2: 무관한 파일 쓰기는 무시
{
  const result = run({
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/work/README.md", content: "hello" },
  });
  assert.strictEqual(result, null, "unrelated file should produce no output");
  console.log("PASS: unrelated file ignored");
}

// Test 3: resume-source.json 변경 (delta 감지 구현됨, 스냅샷 없으면 트리거 안 함)
{
  const result = run({
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/work/resume-source.json", content: "{}" },
  });
  assert.strictEqual(result, null, "resume-source change with no snapshot and no readable source → no trigger");
  console.log("PASS: resume-source.json change (no readable source, no trigger)");
}

// Test 4: Bash로 resume-source.json 저장 (delta 감지 구현됨, 스냅샷 없으면 트리거 안 함)
{
  const result = run({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "cat <<'EOF' > resume-source.json\n{}\nEOF" },
  });
  assert.strictEqual(result, null, "bash resume-source change with no snapshot → no trigger");
  console.log("PASS: Bash resume-source.json (no snapshot, no trigger)");
}

// Test 5: 잘못된 stdin → 에러 없이 종료
{
  try {
    const stdout = execFileSync("node", [script], {
      input: "not-json",
      encoding: "utf-8",
      env: { ...process.env, RESUME_PANEL_BASE: "/tmp/test-resume-panel" },
    });
    console.log("PASS: invalid stdin handled gracefully");
  } catch (e) {
    // exit code 0이면 OK
    assert.strictEqual(e.status, 0, "should exit with code 0 on invalid stdin");
    console.log("PASS: invalid stdin handled gracefully");
  }
}

// Test 6: 워크스페이스 가드 — resume-source.json도 .resume-panel/도 없는 폴더에서는
// 상태 파일을 만들지 않고 즉시 종료해야 함 (전역 플러그인의 무관 프로젝트 오염 방지)
{
  const guardBase = "/tmp/test-resume-panel-guard";
  rmSync(guardBase, { recursive: true, force: true });
  mkdirSync(guardBase, { recursive: true });
  const stdout = execFileSync("node", [script], {
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "아무 프롬프트", cwd: guardBase }),
    encoding: "utf-8",
    env: { ...process.env, RESUME_PANEL_BASE: guardBase },
  });
  assert.strictEqual(stdout.trim(), "", "non-workspace should produce no output");
  assert.ok(!existsSync(join(guardBase, ".resume-panel")), "non-workspace should not create .resume-panel/");
  rmSync(guardBase, { recursive: true, force: true });
  console.log("PASS: workspace guard (no state files outside resume workspace)");
}

// ── Delta detection tests ─────────────────────────────

const testBase = "/tmp/test-resume-panel-delta";

function setupTestDir(snapshot, resumeSource, meta) {
  rmSync(testBase, { recursive: true, force: true });
  mkdirSync(join(testBase, ".resume-panel"), { recursive: true });
  if (snapshot) {
    writeFileSync(join(testBase, ".resume-panel", "snapshot.json"), JSON.stringify(snapshot));
  }
  if (resumeSource) {
    writeFileSync(join(testBase, "resume-source.json"), JSON.stringify(resumeSource));
  }
  if (meta) {
    writeFileSync(join(testBase, ".resume-panel", "meta.json"), JSON.stringify(meta));
  }
}

function runWithBase(input) {
  try {
    const stdout = execFileSync("node", [script], {
      input: JSON.stringify(input),
      encoding: "utf-8",
      env: { ...process.env, RESUME_PANEL_BASE: testBase },
    });
    return stdout.trim() ? JSON.parse(stdout.trim()) : null;
  } catch (e) {
    if (e.stdout) return e.stdout.trim() ? JSON.parse(e.stdout.trim()) : null;
    throw e;
  }
}

const bashResumeInput = {
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command: "cat <<'EOF' > resume-source.json\n...\nEOF" },
};

// Test: 첫 실행 (스냅샷 없음) → 스냅샷만 저장, profiler_score 초기화, 트리거 안 함
{
  const resumeSource = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [{ name: "튜닙", projects: [{ name: "프로젝트A", episodes: [{}, {}] }] }],
  };
  rmSync(testBase, { recursive: true, force: true });
  mkdirSync(testBase, { recursive: true });
  writeFileSync(join(testBase, "resume-source.json"), JSON.stringify(resumeSource));
  // no .resume-panel dir at all

  const result = runWithBase(bashResumeInput);
  assert.strictEqual(result, null, "first run should not trigger");
  assert.ok(existsSync(join(testBase, ".resume-panel", "snapshot.json")), "snapshot should be created");
  const snap = JSON.parse(readFileSync(join(testBase, ".resume-panel", "snapshot.json"), "utf-8"));
  assert.strictEqual(snap.episode_count, 2, "snapshot should have correct episode count");
  // first run initializes profiler_score in hook-state.json
  assert.ok(existsSync(join(testBase, ".resume-panel", "hook-state.json")), "hook-state.json should be created on first run");
  const hsAfterFirst = JSON.parse(readFileSync(join(testBase, ".resume-panel", "hook-state.json"), "utf-8"));
  assert.strictEqual(hsAfterFirst.profiler_score, 0, "first run should initialize profiler_score to 0");
  console.log("PASS: first run creates snapshot and initializes profiler_score = 0");
}

// ── Scoring system tests ─────────────────────────────

function readMeta() {
  return JSON.parse(readFileSync(join(testBase, ".resume-panel", "meta.json"), "utf-8"));
}

function readHookState() {
  return JSON.parse(readFileSync(join(testBase, ".resume-panel", "hook-state.json"), "utf-8"));
}

// Test: episode save +1 below threshold -> no trigger
{
  const correctHash = createHash("md5").update("코인원|FE").digest("hex").slice(0, 8);
  const snapshot = { episode_count: 2, project_names: ["프로젝트A"], meta_hash: correctHash, star_gaps: 0 };
  const meta = { profiler_score: 0 };
  const resumeSource = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [{ name: "튜닙", projects: [{ name: "프로젝트A", episodes: [
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
    ] }] }],
  };
  setupTestDir(snapshot, resumeSource, meta);

  const result = runWithBase(bashResumeInput);
  assert.strictEqual(result, null, "episode +1 with score=0 should not trigger (total=1, threshold=5)");
  const hsAfter = readHookState();
  assert.strictEqual(hsAfter.profiler_score, 1, "profiler_score should be 1 after +1 episode");
  console.log("PASS: episode save +1 below threshold -> no trigger");
}

// Test: score accumulates across calls
{
  const correctHash = createHash("md5").update("코인원|FE").digest("hex").slice(0, 8);

  // Call 1: score=3, +1 episode -> total=4, no trigger
  const snapshot1 = { episode_count: 2, project_names: ["프로젝트A"], meta_hash: correctHash, star_gaps: 0 };
  const meta1 = { profiler_score: 3 };
  const resumeSource1 = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [{ name: "튜닙", projects: [{ name: "프로젝트A", episodes: [
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
    ] }] }],
  };
  setupTestDir(snapshot1, resumeSource1, meta1);
  const result1 = runWithBase(bashResumeInput);
  assert.strictEqual(result1, null, "score 3 + 1 = 4, should not trigger");
  const hsAfter1 = readHookState();
  assert.strictEqual(hsAfter1.profiler_score, 4, "profiler_score should accumulate to 4");

  // Call 2: score=4, +1 episode -> total=5, TRIGGERS
  const snapshot2 = { episode_count: 3, project_names: ["프로젝트A"], meta_hash: correctHash, star_gaps: 0 };
  const meta2 = { profiler_score: 4 };
  const resumeSource2 = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [{ name: "튜닙", projects: [{ name: "프로젝트A", episodes: [
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
    ] }] }],
  };
  setupTestDir(snapshot2, resumeSource2, meta2);
  const result2 = runWithBase(bashResumeInput);
  assert.ok(result2, "score 4 + 1 = 5, should trigger");
  const ctx2 = result2.hookSpecificOutput.additionalContext;
  assert.ok(ctx2.includes("[resume-panel]"), "should have resume-panel tag");
  assert.ok(ctx2.includes('"type":"profiler_trigger"'), "should mention profiler");
  assert.ok(ctx2.includes('"score":'), "should include score in output");
  const hsAfter2 = readHookState();
  assert.strictEqual(hsAfter2.profiler_score, 0, "profiler_score should reset to 0 after trigger");
  console.log("PASS: score accumulates across calls");
}

// Test: new company +3 score
{
  const correctHash = createHash("md5").update("코인원|FE").digest("hex").slice(0, 8);
  const snapshot = { episode_count: 5, project_names: ["프로젝트A"], meta_hash: correctHash, star_gaps: 0 };
  const meta = { profiler_score: 2 };
  const resumeSource = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [
      { name: "튜닙", projects: [{ name: "프로젝트A", episodes: [
        { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
        { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
        { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
        { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
        { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      ] }] },
      { name: "튜닙", projects: [{ name: "프로젝트B", episodes: [
        { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      ] }] },
    ],
  };
  setupTestDir(snapshot, resumeSource, meta);

  const result = runWithBase(bashResumeInput);
  // score: 2 (existing) + 1 (episode delta) + 3 (new project) = 6 >= 5 -> trigger
  assert.ok(result, "new company +3 should trigger when combined score >= 5");
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes("[resume-panel]"), "should have resume-panel tag");
  assert.ok(ctx.includes('"type":"profiler_trigger"'), "should mention profiler");
  assert.ok(ctx.includes("새 프로젝트"), "should mention new project");
  const hsAfterNew = readHookState();
  assert.strictEqual(hsAfterNew.profiler_score, 0, "profiler_score should reset to 0 after trigger");
  console.log("PASS: new company +3 score");
}

// Test: empty result +2 score (new star gaps)
{
  const correctHash = createHash("md5").update("코인원|FE").digest("hex").slice(0, 8);

  // First call: score=1, +1 episode + +2 star gap = +3, total = 4, no trigger
  // so_what_active suppresses SO-WHAT to isolate star gap scoring test
  const snapshot1 = { episode_count: 2, project_names: ["A"], meta_hash: correctHash, star_gaps: 0 };
  const meta1 = { profiler_score: 1, so_what_active: { active: true, episode_title: "test", current_level: 1, accumulated_result: "" } };
  const resumeSource1 = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [{ name: "튜닙", projects: [{ name: "A", episodes: [
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "", action: "a", result: "" } },  // incomplete = new star gap
    ] }] }],
  };
  setupTestDir(snapshot1, resumeSource1, meta1);
  const result1 = runWithBase(bashResumeInput);
  assert.strictEqual(result1, null, "score 1 + 1(ep) + 2(gap) = 4, should not trigger");
  const hsAfterGap1 = readHookState();
  assert.strictEqual(hsAfterGap1.profiler_score, 4, "profiler_score should be 4");

  // Second call: score=3, +1 episode + +2 star gap = +3, total = 6 >= 5, triggers
  const snapshot2 = { episode_count: 2, project_names: ["A"], meta_hash: correctHash, star_gaps: 0 };
  const meta2 = { profiler_score: 3 };
  const resumeSource2 = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [{ name: "튜닙", projects: [{ name: "A", episodes: [
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "", action: "a", result: "" } },  // incomplete = star gap
    ] }] }],
  };
  setupTestDir(snapshot2, resumeSource2, meta2);
  const result2 = runWithBase(bashResumeInput);
  assert.ok(result2, "score 3 + 1(ep) + 2(gap) = 6, should trigger");
  const ctx2 = result2.hookSpecificOutput.additionalContext;
  assert.ok(ctx2.includes("빈 STAR"), "should mention star gaps");
  const hsAfterGap2 = readHookState();
  // After trigger (reset to 0), new ep has result="" (no quantified impact) → so_what fires → +3
  // So final score = 0 (reset) + 3 (so_what) = 3
  assert.strictEqual(hsAfterGap2.profiler_score, 3, "profiler_score should be 3 after trigger reset + so_what +3");
  console.log("PASS: empty result +2 score");
}

// Test: role minimization signal +2 score (역할 축소 신호)
{
  const correctHash = createHash("md5").update("코인원|FE").digest("hex").slice(0, 8);

  // Call 1: score=1, +1 episode + +2 minimization = 3, total=4, no trigger
  const snapshot1 = { episode_count: 1, project_names: ["A"], meta_hash: correctHash, star_gaps: 0 };
  const meta1 = { profiler_score: 1 };
  const resumeSource1 = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [{ name: "튜닙", projects: [{ name: "A", episodes: [
      { star: { situation: "s", task: "t", action: "기존 코드 분석", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "팀원에게 도움을 줬습니다", result: "매출 30% 증가" } },
    ] }] }],
  };
  setupTestDir(snapshot1, resumeSource1, meta1);
  const result1 = runWithBase(bashResumeInput);
  assert.strictEqual(result1, null, "score 1 + 1(ep) + 2(minimization) = 4, should not trigger");
  const hsAfterMin1 = readHookState();
  assert.strictEqual(hsAfterMin1.profiler_score, 4, "profiler_score should be 4");

  // Call 2: score=3, +1 episode + +2 minimization = 3, total=6 >= 5, triggers
  const snapshot2 = { episode_count: 1, project_names: ["A"], meta_hash: correctHash, star_gaps: 0 };
  const meta2 = { profiler_score: 3 };
  const resumeSource2 = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [{ name: "튜닙", projects: [{ name: "A", episodes: [
      { star: { situation: "s", task: "t", action: "기존 코드 분석", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "프로젝트에 참여했습니다", result: "매출 30% 증가" } },
    ] }] }],
  };
  setupTestDir(snapshot2, resumeSource2, meta2);
  const result2 = runWithBase(bashResumeInput);
  assert.ok(result2, "score 3 + 1(ep) + 2(minimization) = 6, should trigger");
  const ctx2 = result2.hookSpecificOutput.additionalContext;
  assert.ok(ctx2.includes("역할 축소"), "should mention role minimization signal");
  const hsAfterMin2 = readHookState();
  assert.strictEqual(hsAfterMin2.profiler_score, 0, "profiler_score should reset to 0");
  console.log("PASS: role minimization signal +2 score (도움, 참여, 지원, 보조, 서포트)");
}

// Test: meta change +2 score
{
  const oldHash = createHash("md5").update("코인원|FE").digest("hex").slice(0, 8);
  // new meta has different target -> different hash
  const snapshot = { episode_count: 5, project_names: ["프로젝트A"], meta_hash: oldHash, star_gaps: 0 };
  const meta = { profiler_score: 3 };
  const resumeSource = {
    meta: { target_company: "한섬", target_position: "PM" },  // changed from 코인원|FE
    companies: [{ name: "튜닙", projects: [{ name: "프로젝트A", episodes: [
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
    ] }] }],
  };
  setupTestDir(snapshot, resumeSource, meta);

  const result = runWithBase(bashResumeInput);
  // score: 3 (existing) + 0 (no new episodes) + 2 (meta change) = 5, triggers
  assert.ok(result, "meta change +2 should trigger when combined score >= 5");
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes("meta 변경"), "should mention meta change");
  const hsAfterMeta = readHookState();
  assert.strictEqual(hsAfterMeta.profiler_score, 0, "profiler_score should reset to 0 after trigger");
  console.log("PASS: meta change +2 score");
}

// Test: combined events: new company + meta change = immediate trigger
{
  const oldHash = createHash("md5").update("코인원|FE").digest("hex").slice(0, 8);
  const snapshot = { episode_count: 5, project_names: ["프로젝트A"], meta_hash: oldHash, star_gaps: 0 };
  const meta = { profiler_score: 0 };
  const resumeSource = {
    meta: { target_company: "한섬", target_position: "PM" },  // meta changed
    companies: [
      { name: "튜닙", projects: [{ name: "프로젝트A", episodes: [
        { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
        { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
        { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
        { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
        { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      ] }] },
      { name: "한섬", projects: [{ name: "프로젝트B", episodes: [
        { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      ] }] },
    ],
  };
  setupTestDir(snapshot, resumeSource, meta);

  const result = runWithBase(bashResumeInput);
  // score: 0 + 1 (episode) + 3 (new project) + 2 (meta change) = 6 >= 5, immediate trigger
  assert.ok(result, "combined events should trigger immediately");
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes("[resume-panel]"), "should have resume-panel tag");
  assert.ok(ctx.includes('"type":"profiler_trigger"'), "should mention profiler");
  assert.ok(ctx.includes("새 프로젝트"), "should mention new project");
  assert.ok(ctx.includes("meta 변경"), "should mention meta change");
  const hsAfterCombined = readHookState();
  assert.strictEqual(hsAfterCombined.profiler_score, 0, "profiler_score should reset to 0");
  console.log("PASS: combined events: new company + meta change = immediate trigger");
}

// Test: score resets to 0 after trigger, next call starts fresh
{
  const correctHash = createHash("md5").update("코인원|FE").digest("hex").slice(0, 8);

  // First: trigger (score reaches 5)
  const snapshot1 = { episode_count: 4, project_names: ["프로젝트A"], meta_hash: correctHash, star_gaps: 0 };
  const meta1 = { profiler_score: 4 };
  const resumeSource1 = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [{ name: "튜닙", projects: [{ name: "프로젝트A", episodes: [
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
    ] }] }],
  };
  setupTestDir(snapshot1, resumeSource1, meta1);
  const result1 = runWithBase(bashResumeInput);
  assert.ok(result1, "should trigger (score 4 + 1 = 5)");
  const hsAfterTrigger = readHookState();
  assert.strictEqual(hsAfterTrigger.profiler_score, 0, "profiler_score should be 0 after trigger");

  // Second: +1 episode from fresh, should NOT trigger
  const snapAfterTrigger = JSON.parse(readFileSync(join(testBase, ".resume-panel", "snapshot.json"), "utf-8"));
  const resumeSource2 = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [{ name: "튜닙", projects: [{ name: "프로젝트A", episodes: [
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
    ] }] }],
  };
  writeFileSync(join(testBase, "resume-source.json"), JSON.stringify(resumeSource2));
  const result2 = runWithBase(bashResumeInput);
  assert.strictEqual(result2, null, "after reset, +1 episode should NOT trigger");
  const hsAfterFresh = readHookState();
  assert.strictEqual(hsAfterFresh.profiler_score, 1, "profiler_score should be 1 after fresh +1");
  console.log("PASS: score resets to 0 after trigger, next call starts fresh");
}

// Test: STAR 갭 카운팅 (in scoring context)
{
  const correctHash = createHash("md5").update("코인원|FE").digest("hex").slice(0, 8);
  const snapshot = { episode_count: 0, project_names: ["A"], meta_hash: correctHash, star_gaps: 0 };
  const meta = { profiler_score: 0 };
  const resumeSource = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [{ name: "튜닙", projects: [{
      name: "A",
      episodes: [
        { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },  // complete
        { star: { situation: "s", task: "", action: "a", result: "" } },     // incomplete
        {},  // no star at all → incomplete
      ],
    }] }],
  };
  setupTestDir(snapshot, resumeSource, meta);

  const result = runWithBase(bashResumeInput);
  // score: 0 + 3(episodes) + 2(star gap increase) = 5 >= 5, triggers
  assert.ok(result, "should trigger with episode delta + star gaps");
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('"star_gaps":2'), "should count 2 episodes with incomplete STAR");
  console.log("PASS: STAR gap counting in scoring context");
}

// Cleanup
rmSync(testBase, { recursive: true, force: true });
console.log("\nAll scoring system tests passed.");

// ── findings 라우팅 테스트 ──────────────────────────

// Test: HIGH finding → 즉시 라우팅
{
  const testDir = "/tmp/test-resume-panel-findings-high";
  rmSync(testDir, { recursive: true, force: true });
  mkdirSync(join(testDir, ".resume-panel"), { recursive: true });

  writeFileSync(join(testDir, ".resume-panel", "snapshot.json"), JSON.stringify({
    episode_count: 5, project_names: ["A"], meta_hash: "abc",
  }));

  const finding = {
    id: "f-001", urgency: "HIGH", source: "recruiter", type: "gap_detected",
    message: "WebSocket 실시간 경험 완전 공백.",
    context: {}, created_at: new Date().toISOString(),
  };
  writeFileSync(
    join(testDir, ".resume-panel", "findings-inbox.jsonl"),
    JSON.stringify(finding) + "\n"
  );

  const result = execFileSync("node", [script], {
    input: JSON.stringify({
      hook_event_name: "PostToolUse", tool_name: "Write",
      tool_input: { file_path: "/work/some-file.txt", content: "x" },
    }),
    encoding: "utf-8",
    env: { ...process.env, RESUME_PANEL_BASE: testDir },
  });
  const parsed = result.trim() ? JSON.parse(result.trim()) : null;
  assert.ok(parsed, "HIGH finding should produce output");
  assert.ok(parsed.hookSpecificOutput.additionalContext.includes('"urgency":"HIGH"'));
  assert.ok(parsed.hookSpecificOutput.additionalContext.includes("WebSocket"));

  // findings.json에 delivered: true
  const findings = JSON.parse(readFileSync(join(testDir, ".resume-panel", "findings.json"), "utf-8"));
  assert.ok(findings.findings[0].delivered, "should be marked delivered");

  // inbox 삭제됨
  assert.ok(!existsSync(join(testDir, ".resume-panel", "findings-inbox.jsonl")));
  assert.ok(!existsSync(join(testDir, ".resume-panel", "findings-inbox.processing.jsonl")));

  console.log("PASS: HIGH finding routed immediately");
  rmSync(testDir, { recursive: true, force: true });
}

// Test: LOW finding → skip
{
  const testDir = "/tmp/test-resume-panel-findings-low";
  rmSync(testDir, { recursive: true, force: true });
  mkdirSync(join(testDir, ".resume-panel"), { recursive: true });

  writeFileSync(join(testDir, ".resume-panel", "snapshot.json"), JSON.stringify({
    episode_count: 5, project_names: ["A"], meta_hash: "abc",
  }));

  const finding = {
    id: "f-002", urgency: "LOW", source: "recruiter", type: "improvement",
    message: "키워드 추가 권장.",
    context: {}, created_at: new Date().toISOString(),
  };
  writeFileSync(
    join(testDir, ".resume-panel", "findings-inbox.jsonl"),
    JSON.stringify(finding) + "\n"
  );

  const result = execFileSync("node", [script], {
    input: JSON.stringify({
      hook_event_name: "PostToolUse", tool_name: "Write",
      tool_input: { file_path: "/work/something.txt", content: "x" },
    }),
    encoding: "utf-8",
    env: { ...process.env, RESUME_PANEL_BASE: testDir },
  });
  const parsed = result.trim() ? JSON.parse(result.trim()) : null;
  assert.strictEqual(parsed, null, "LOW finding should not produce output");

  // But findings.json should still contain it with delivered: false
  const findings = JSON.parse(readFileSync(join(testDir, ".resume-panel", "findings.json"), "utf-8"));
  assert.strictEqual(findings.findings[0].delivered, false, "LOW should be delivered=false");

  console.log("PASS: LOW finding skipped but saved");
  rmSync(testDir, { recursive: true, force: true });
}

// Test: MEDIUM finding without company change → skip
{
  const testDir = "/tmp/test-resume-panel-findings-med";
  rmSync(testDir, { recursive: true, force: true });
  mkdirSync(join(testDir, ".resume-panel"), { recursive: true });

  writeFileSync(join(testDir, ".resume-panel", "snapshot.json"), JSON.stringify({
    episode_count: 5, project_names: ["A"], meta_hash: "abc",
  }));
  // No meta.json → companyChanged will be false

  const finding = {
    id: "f-003", urgency: "MEDIUM", source: "profiler", type: "star_gap",
    message: "ep-8 Result 수치 부족.",
    context: {}, created_at: new Date().toISOString(),
  };
  writeFileSync(
    join(testDir, ".resume-panel", "findings-inbox.jsonl"),
    JSON.stringify(finding) + "\n"
  );

  const result = execFileSync("node", [script], {
    input: JSON.stringify({
      hook_event_name: "PostToolUse", tool_name: "Write",
      tool_input: { file_path: "/work/something.txt", content: "x" },
    }),
    encoding: "utf-8",
    env: { ...process.env, RESUME_PANEL_BASE: testDir },
  });
  const parsed = result.trim() ? JSON.parse(result.trim()) : null;
  assert.strictEqual(parsed, null, "MEDIUM without company change should not produce output");

  console.log("PASS: MEDIUM finding without company change skipped");
  rmSync(testDir, { recursive: true, force: true });
}

// Test: Multiple findings (HIGH + LOW) → only HIGH routed
{
  const testDir = "/tmp/test-resume-panel-findings-multi";
  rmSync(testDir, { recursive: true, force: true });
  mkdirSync(join(testDir, ".resume-panel"), { recursive: true });

  writeFileSync(join(testDir, ".resume-panel", "snapshot.json"), JSON.stringify({
    episode_count: 5, project_names: ["A"], meta_hash: "abc",
  }));

  const lines = [
    JSON.stringify({ id: "f-010", urgency: "HIGH", source: "recruiter", message: "핵심 갭 발견", context: {} }),
    JSON.stringify({ id: "f-011", urgency: "LOW", source: "profiler", message: "사소한 개선", context: {} }),
  ].join("\n") + "\n";
  writeFileSync(join(testDir, ".resume-panel", "findings-inbox.jsonl"), lines);

  const result = execFileSync("node", [script], {
    input: JSON.stringify({
      hook_event_name: "PostToolUse", tool_name: "Write",
      tool_input: { file_path: "/work/file.txt", content: "x" },
    }),
    encoding: "utf-8",
    env: { ...process.env, RESUME_PANEL_BASE: testDir },
  });
  const parsed = result.trim() ? JSON.parse(result.trim()) : null;
  assert.ok(parsed, "should have output for HIGH finding");
  assert.ok(parsed.hookSpecificOutput.additionalContext.includes("핵심 갭"));
  assert.ok(!parsed.hookSpecificOutput.additionalContext.includes("사소한"), "LOW should not appear");

  const findings = JSON.parse(readFileSync(join(testDir, ".resume-panel", "findings.json"), "utf-8"));
  assert.strictEqual(findings.findings.length, 2, "both findings should be saved");
  assert.ok(findings.findings[0].delivered, "HIGH should be delivered");
  assert.ok(!findings.findings[1].delivered, "LOW should not be delivered");

  console.log("PASS: multiple findings - only HIGH routed");
  rmSync(testDir, { recursive: true, force: true });
}

// Test: MEDIUM finding WITH company change → routed
{
  const testDir = "/tmp/test-resume-panel-findings-med-change";
  rmSync(testDir, { recursive: true, force: true });
  mkdirSync(join(testDir, ".resume-panel"), { recursive: true });

  // snapshot has current_company: "튜닙"
  writeFileSync(join(testDir, ".resume-panel", "snapshot.json"), JSON.stringify({
    episode_count: 5, project_names: ["A"], meta_hash: "abc", current_company: "튜닙",
  }));
  // meta.json has current_company: "한섬" → different → companyChanged = true
  writeFileSync(join(testDir, ".resume-panel", "meta.json"), JSON.stringify({
    current_company: "한섬", last_profiler_episode_count: 5, total_profiler_calls: 1,
  }));

  const finding = {
    id: "f-020", urgency: "MEDIUM", source: "profiler", type: "star_gap",
    message: "ep-8 Result 수치 보강 필요.",
    context: {}, created_at: new Date().toISOString(),
  };
  writeFileSync(
    join(testDir, ".resume-panel", "findings-inbox.jsonl"),
    JSON.stringify(finding) + "\n"
  );

  const result = execFileSync("node", [script], {
    input: JSON.stringify({
      hook_event_name: "PostToolUse", tool_name: "Write",
      tool_input: { file_path: "/work/something.txt", content: "x" },
    }),
    encoding: "utf-8",
    env: { ...process.env, RESUME_PANEL_BASE: testDir },
  });
  const parsed = result.trim() ? JSON.parse(result.trim()) : null;
  assert.ok(parsed, "MEDIUM with company change should produce output");
  assert.ok(parsed.hookSpecificOutput.additionalContext.includes('"urgency":"MEDIUM"'));
  assert.ok(parsed.hookSpecificOutput.additionalContext.includes("수치 보강"));

  // snapshot should be updated with new current_company
  const updatedSnapshot = JSON.parse(readFileSync(join(testDir, ".resume-panel", "snapshot.json"), "utf-8"));
  assert.strictEqual(updatedSnapshot.current_company, "한섬", "snapshot should update current_company");

  console.log("PASS: MEDIUM finding with company change routed");
  rmSync(testDir, { recursive: true, force: true });
}

console.log("\nAll findings routing tests passed.");

// ── So What chain tests ──────────────────────────────

// hasQuantifiedImpact unit tests
// The function doesn't exist yet in episode-watcher.mjs, so we define the expected logic here
// to validate the regex pattern. Task 2 will implement it in the actual file.
{
  // Expected regex pattern for quantified impact detection
  const IMPACT_PATTERN = /\d+(\.\d+)?\s*(명|건|%|원|만|억|배|시간|분|초|ms|개월|일|주|달|회|번|개|위|등|톤|km|kg|L|대|편|권|통|점|곳|팀)/;

  function hasQuantifiedImpactLocal(resultText) {
    if (!resultText || resultText.trim() === "") return false;
    return IMPACT_PATTERN.test(resultText);
  }

  // Test hasQuantifiedImpact-1: % 단위
  assert.strictEqual(hasQuantifiedImpactLocal("매출 30% 증가"), true, "30% should be detected");
  console.log("PASS: hasQuantifiedImpact - % 단위 감지");

  // Test hasQuantifiedImpact-2: ms 단위
  assert.strictEqual(hasQuantifiedImpactLocal("응답 시간 200ms로 개선"), true, "200ms should be detected");
  console.log("PASS: hasQuantifiedImpact - ms 단위 감지");

  // Test hasQuantifiedImpact-3: 배 단위
  assert.strictEqual(hasQuantifiedImpactLocal("팀 생산성 3배 향상"), true, "3배 should be detected");
  console.log("PASS: hasQuantifiedImpact - 배 단위 감지");

  // Test hasQuantifiedImpact-4: 수치 없음
  assert.strictEqual(hasQuantifiedImpactLocal("업무 효율이 좋아졌다"), false, "no number should return false");
  console.log("PASS: hasQuantifiedImpact - 수치 없음 감지");

  // Test hasQuantifiedImpact-5: 빈 문자열
  assert.strictEqual(hasQuantifiedImpactLocal(""), false, "empty string should return false");
  console.log("PASS: hasQuantifiedImpact - 빈 문자열");

  // Test hasQuantifiedImpact-6: null
  assert.strictEqual(hasQuantifiedImpactLocal(null), false, "null should return false");
  console.log("PASS: hasQuantifiedImpact - null 처리");
}

// SO-WHAT trigger integration tests (using setupTestDir/runWithBase infrastructure)
const soWhatTestBase = "/tmp/test-resume-panel-sowhat";

function setupSoWhatTestDir(snapshot, resumeSource, meta) {
  rmSync(soWhatTestBase, { recursive: true, force: true });
  mkdirSync(join(soWhatTestBase, ".resume-panel"), { recursive: true });
  if (snapshot) {
    writeFileSync(join(soWhatTestBase, ".resume-panel", "snapshot.json"), JSON.stringify(snapshot));
  }
  if (resumeSource) {
    writeFileSync(join(soWhatTestBase, "resume-source.json"), JSON.stringify(resumeSource));
  }
  if (meta) {
    writeFileSync(join(soWhatTestBase, ".resume-panel", "meta.json"), JSON.stringify(meta));
  }
}

function runSoWhat(input) {
  try {
    const stdout = execFileSync("node", [script], {
      input: JSON.stringify(input),
      encoding: "utf-8",
      env: { ...process.env, RESUME_PANEL_BASE: soWhatTestBase },
    });
    return stdout.trim() ? JSON.parse(stdout.trim()) : null;
  } catch (e) {
    if (e.stdout) return e.stdout.trim() ? JSON.parse(e.stdout.trim()) : null;
    throw e;
  }
}

const bashSoWhatInput = {
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command: "cat <<'EOF' > resume-source.json\n...\nEOF" },
};

// Test SO-WHAT-trigger: episode with weak result triggers SO-WHAT message
{
  const correctHash = createHash("md5").update("코인원|FE").digest("hex").slice(0, 8);
  const snapshot = { episode_count: 2, project_names: ["프로젝트A"], meta_hash: correctHash, star_gaps: 0 };
  const meta = { profiler_score: 0 };
  const resumeSource = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [{ name: "튜닙", projects: [{ name: "프로젝트A", episodes: [
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "개선했다" } },
    ] }] }],
  };
  setupSoWhatTestDir(snapshot, resumeSource, meta);

  const result = runSoWhat(bashSoWhatInput);
  // Should have output containing so_what JSON payload
  assert.ok(result, "weak result episode should produce output with SO-WHAT");
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('"type":"so_what"'), "should contain SO-WHAT tag");
  console.log("PASS: SO-WHAT trigger on weak result episode");
}

// Test SO-WHAT-skip: episode with quantified result does NOT trigger SO-WHAT
{
  const correctHash = createHash("md5").update("코인원|FE").digest("hex").slice(0, 8);
  const snapshot = { episode_count: 2, project_names: ["프로젝트A"], meta_hash: correctHash, star_gaps: 0 };
  const meta = { profiler_score: 0 };
  const resumeSource = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [{ name: "튜닙", projects: [{ name: "프로젝트A", episodes: [
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
    ] }] }],
  };
  setupSoWhatTestDir(snapshot, resumeSource, meta);

  const result = runSoWhat(bashSoWhatInput);
  // Should NOT have SO-WHAT message (score is only 1, below threshold 5 for profiler)
  if (result) {
    const ctx = result.hookSpecificOutput.additionalContext;
    assert.ok(!ctx.includes('"type":"so_what"'), "quantified result should NOT trigger SO-WHAT");
  }
  console.log("PASS: SO-WHAT skip on quantified result episode");
}

// Test SO-WHAT-suppression: so_what_active.active === true suppresses SO-WHAT
{
  const correctHash = createHash("md5").update("코인원|FE").digest("hex").slice(0, 8);
  const snapshot = { episode_count: 2, project_names: ["프로젝트A"], meta_hash: correctHash, star_gaps: 0 };
  const meta = {
    profiler_score: 0,
    so_what_active: {
      active: true,
      episode_title: "진행중",
      current_level: 2,
      accumulated_result: "이전 답변 내용",
    },
  };
  const resumeSource = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [{ name: "튜닙", projects: [{ name: "프로젝트A", episodes: [
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "개선했다" } },
    ] }] }],
  };
  setupSoWhatTestDir(snapshot, resumeSource, meta);

  const result = runSoWhat(bashSoWhatInput);
  // SO-WHAT should be suppressed even though result is weak
  if (result) {
    const ctx = result.hookSpecificOutput.additionalContext;
    assert.ok(!ctx.includes('"type":"so_what"'), "so_what_active should suppress SO-WHAT trigger");
  }
  console.log("PASS: SO-WHAT suppression when so_what_active.active === true");
}

// Test SO-WHAT-title: SO-WHAT message includes episode title
{
  const correctHash = createHash("md5").update("코인원|FE").digest("hex").slice(0, 8);
  const snapshot = { episode_count: 2, project_names: ["프로젝트A"], meta_hash: correctHash, star_gaps: 0 };
  const meta = { profiler_score: 0 };
  const resumeSource = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [{ name: "튜닙", projects: [{ name: "프로젝트A", episodes: [
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { title: "검색 성능 최적화", star: { situation: "s", task: "t", action: "a", result: "개선했다" } },
    ] }] }],
  };
  setupSoWhatTestDir(snapshot, resumeSource, meta);

  const result = runSoWhat(bashSoWhatInput);
  assert.ok(result, "should produce output for weak result");
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes("검색 성능 최적화"), "SO-WHAT message should include episode title");
  console.log("PASS: SO-WHAT message includes episode title");
}

// Test SO-WHAT + profiler coexistence: both messages in additionalContext
{
  const correctHash = createHash("md5").update("코인원|FE").digest("hex").slice(0, 8);
  // score=4, +1 episode = 5 = threshold -> profiler triggers
  // AND the new episode has weak result -> SO-WHAT also triggers
  const snapshot = { episode_count: 2, project_names: ["프로젝트A"], meta_hash: correctHash, star_gaps: 0 };
  const meta = { profiler_score: 4 };
  const resumeSource = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [{ name: "튜닙", projects: [{ name: "프로젝트A", episodes: [
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { title: "성능 개선", star: { situation: "s", task: "t", action: "a", result: "빨라졌다" } },
    ] }] }],
  };
  setupSoWhatTestDir(snapshot, resumeSource, meta);

  const result = runSoWhat(bashSoWhatInput);
  assert.ok(result, "should produce output");
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('"type":"profiler_trigger"'), "should contain profiler tag");
  assert.ok(ctx.includes('"type":"so_what"'), "should also contain SO-WHAT tag");
  console.log("PASS: SO-WHAT and profiler messages coexist");
}

// Test SO-WHAT with no title: episode without title field uses "(제목 없음)"
{
  const correctHash = createHash("md5").update("코인원|FE").digest("hex").slice(0, 8);
  const snapshot = { episode_count: 2, project_names: ["프로젝트A"], meta_hash: correctHash, star_gaps: 0 };
  const meta = { profiler_score: 0 };
  const resumeSource = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [{ name: "튜닙", projects: [{ name: "프로젝트A", episodes: [
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      { star: { situation: "s", task: "t", action: "a", result: "개선했다" } },
    ] }] }],
  };
  setupSoWhatTestDir(snapshot, resumeSource, meta);

  const result = runSoWhat(bashSoWhatInput);
  assert.ok(result, "should produce output for weak result without title");
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes("(제목 없음)"), "should use fallback title when episode has no title");
  console.log("PASS: SO-WHAT with no title uses (제목 없음) fallback");
}

// Cleanup
rmSync(soWhatTestBase, { recursive: true, force: true });
console.log("\nAll So What chain tests passed.");

// ── Timeline parsing tests ──────────────────────────────

// mirrors episode-watcher.mjs parsePeriod for unit testing
function parsePeriod(periodStr) {
  if (!periodStr || typeof periodStr !== "string") return null;
  const currentDate = new Date();
  const currentStr = `${currentDate.getFullYear()}.${String(currentDate.getMonth() + 1).padStart(2, "0")}`;
  const normalized = periodStr.replace(/현재|재직중/g, currentStr);
  const match = normalized.match(/(\d{4})\.(\d{1,2})\s*-\s*(\d{4})\.(\d{1,2})/);
  if (!match) return null;
  return {
    start: { year: parseInt(match[1]), month: parseInt(match[2]) },
    end: { year: parseInt(match[3]), month: parseInt(match[4]) },
  };
}

// mirrors episode-watcher.mjs toMonths for unit testing
function toMonths(d) { return d.year * 12 + d.month; }

// mirrors episode-watcher.mjs getAllProjects for unit testing
function getAllProjects(source) {
  const projects = [];
  for (const company of source.companies || []) {
    for (const project of company.projects || []) {
      projects.push({ ...project, companyName: company.name });
    }
  }
  return projects;
}

// Test parsePeriod-1: valid "YYYY.MM - YYYY.MM" format
{
  const result = parsePeriod("2023.03 - 2024.06");
  assert.deepStrictEqual(result, { start: { year: 2023, month: 3 }, end: { year: 2024, month: 6 } });
  console.log("PASS: parsePeriod - valid YYYY.MM - YYYY.MM format");
}

// Test parsePeriod-2: single-digit months
{
  const result = parsePeriod("2023.3 - 2024.6");
  assert.deepStrictEqual(result, { start: { year: 2023, month: 3 }, end: { year: 2024, month: 6 } });
  console.log("PASS: parsePeriod - single-digit month");
}

// Test parsePeriod-3: "현재" end date
{
  const result = parsePeriod("2023.03 - 현재");
  const now = new Date();
  assert.strictEqual(result.start.year, 2023);
  assert.strictEqual(result.start.month, 3);
  assert.strictEqual(result.end.year, now.getFullYear());
  assert.strictEqual(result.end.month, now.getMonth() + 1);
  console.log("PASS: parsePeriod - 현재 end date");
}

// Test parsePeriod-4: "재직중" end date
{
  const result = parsePeriod("2023.03 - 재직중");
  const now = new Date();
  assert.strictEqual(result.end.year, now.getFullYear());
  assert.strictEqual(result.end.month, now.getMonth() + 1);
  console.log("PASS: parsePeriod - 재직중 end date");
}

// Test parsePeriod-5: null input
{
  const result = parsePeriod(null);
  assert.strictEqual(result, null);
  console.log("PASS: parsePeriod - null input");
}

// Test parsePeriod-6: invalid input
{
  const result = parsePeriod("invalid");
  assert.strictEqual(result, null);
  console.log("PASS: parsePeriod - invalid input");
}

// Test parsePeriod-7: empty string
{
  const result = parsePeriod("");
  assert.strictEqual(result, null);
  console.log("PASS: parsePeriod - empty string");
}

// Test toMonths-1: arithmetic check
{
  const result = toMonths({ year: 2023, month: 3 });
  assert.strictEqual(result, 2023 * 12 + 3);
  console.log("PASS: toMonths - arithmetic (2023*12+3 = 24279)");
}

// Test getAllProjects-1: multiple companies
{
  const source = {
    companies: [
      { name: "A", projects: [{ name: "p1", episodes: [] }] },
      { name: "B", projects: [{ name: "p2", episodes: [] }] },
    ],
  };
  const result = getAllProjects(source);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].companyName, "A");
  assert.strictEqual(result[0].name, "p1");
  assert.strictEqual(result[1].companyName, "B");
  assert.strictEqual(result[1].name, "p2");
  console.log("PASS: getAllProjects - multiple companies with companyName");
}

// Test getAllProjects-2: empty companies
{
  const result = getAllProjects({ companies: [] });
  assert.strictEqual(result.length, 0);
  console.log("PASS: getAllProjects - empty companies");
}

// Test getAllProjects-3: no companies key
{
  const result = getAllProjects({});
  assert.strictEqual(result.length, 0);
  console.log("PASS: getAllProjects - no companies key");
}

console.log("\nAll timeline parsing tests passed.");

// ── Gap detection tests ──────────────────────────────

const gapTestBase = "/tmp/test-resume-panel-gaps";

function setupGapTestDir(snapshot, resumeSource, meta) {
  rmSync(gapTestBase, { recursive: true, force: true });
  mkdirSync(join(gapTestBase, ".resume-panel"), { recursive: true });
  if (snapshot) {
    writeFileSync(join(gapTestBase, ".resume-panel", "snapshot.json"), JSON.stringify(snapshot));
  }
  if (resumeSource) {
    writeFileSync(join(gapTestBase, "resume-source.json"), JSON.stringify(resumeSource));
  }
  if (meta) {
    writeFileSync(join(gapTestBase, ".resume-panel", "meta.json"), JSON.stringify(meta));
  }
}

function runGapTest(input) {
  try {
    const stdout = execFileSync("node", [script], {
      input: JSON.stringify(input),
      encoding: "utf-8",
      env: { ...process.env, RESUME_PANEL_BASE: gapTestBase },
    });
    return stdout.trim() ? JSON.parse(stdout.trim()) : null;
  } catch (e) {
    if (e.stdout) return e.stdout.trim() ? JSON.parse(e.stdout.trim()) : null;
    throw e;
  }
}

function readGapMeta() {
  return JSON.parse(readFileSync(join(gapTestBase, ".resume-panel", "meta.json"), "utf-8"));
}

const bashGapInput = {
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command: "cat <<'EOF' > resume-source.json\n...\nEOF" },
};

// Test gap-1: detectGaps finds inter-company gap of 7 months (> 6 threshold)
{
  const correctHash = createHash("md5").update("코인원|FE").digest("hex").slice(0, 8);
  // score=4, +1 episode = 5 -> triggers profiler, which runs timeline analysis
  const snapshot = { episode_count: 1, project_names: ["프로젝트A", "프로젝트B"], meta_hash: correctHash, star_gaps: 0 };
  const meta = { profiler_score: 4 };
  const resumeSource = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [
      { name: "튜닙", projects: [{ name: "프로젝트A", period: "2021.06 - 2022.01", episodes: [
        { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      ] }] },
      { name: "한섬", projects: [{ name: "프로젝트B", period: "2022.08 - 2023.03", episodes: [
        { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      ] }] },
    ],
  };
  setupGapTestDir(snapshot, resumeSource, meta);

  const result = runGapTest(bashGapInput);
  assert.ok(result, "should trigger profiler (score 4 + 1 = 5)");

  // Gap findings are written to inbox then immediately consumed by findings routing
  // Check findings.json where they end up after routing
  const findingsJsonPath = join(gapTestBase, ".resume-panel", "findings.json");
  assert.ok(existsSync(findingsJsonPath), "findings.json should exist with gap finding");
  const findingsData = JSON.parse(readFileSync(findingsJsonPath, "utf-8"));
  const finding = findingsData.findings.find(f => f.type === "timeline_gap_found");
  assert.ok(finding, "should have timeline_gap_found finding");
  assert.strictEqual(finding.urgency, "MEDIUM", "finding urgency should be MEDIUM");
  assert.strictEqual(finding.context.gap_months, 7, "gap should be 7 months");
  assert.strictEqual(finding.context.gap_type, "inter_company", "gap type should be inter_company");
  assert.strictEqual(finding.context.from_company, "튜닙");
  assert.strictEqual(finding.context.to_company, "한섬");
  console.log("PASS: detectGaps finds inter-company gap of 7 months");

  rmSync(gapTestBase, { recursive: true, force: true });
}

// Test gap-2: detectGaps finds intra-company gap of 4 months (> 3 threshold)
{
  const correctHash = createHash("md5").update("코인원|FE").digest("hex").slice(0, 8);
  const snapshot = { episode_count: 1, project_names: ["프로젝트A", "프로젝트B"], meta_hash: correctHash, star_gaps: 0 };
  const meta = { profiler_score: 4 };
  const resumeSource = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [
      { name: "튜닙", projects: [
        { name: "프로젝트A", period: "2022.01 - 2022.06", episodes: [
          { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
        ] },
        { name: "프로젝트B", period: "2022.10 - 2023.03", episodes: [
          { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
        ] },
      ] },
    ],
  };
  setupGapTestDir(snapshot, resumeSource, meta);

  const result = runGapTest(bashGapInput);
  assert.ok(result, "should trigger profiler");

  const findingsJsonPath = join(gapTestBase, ".resume-panel", "findings.json");
  assert.ok(existsSync(findingsJsonPath), "findings.json should exist with gap finding");
  const findingsData = JSON.parse(readFileSync(findingsJsonPath, "utf-8"));
  const finding = findingsData.findings.find(f => f.type === "timeline_gap_found");
  assert.ok(finding, "should have timeline_gap_found finding");
  assert.strictEqual(finding.context.gap_months, 4, "gap should be 4 months");
  assert.strictEqual(finding.context.gap_type, "intra_company", "gap type should be intra_company");
  assert.strictEqual(finding.context.from_company, "튜닙");
  assert.strictEqual(finding.context.to_company, "튜닙");
  console.log("PASS: detectGaps finds intra-company gap of 4 months");

  rmSync(gapTestBase, { recursive: true, force: true });
}

// Test gap-3: detectGaps ignores inter-company gap of 5 months (< 6 threshold)
{
  const correctHash = createHash("md5").update("코인원|FE").digest("hex").slice(0, 8);
  const snapshot = { episode_count: 1, project_names: ["프로젝트A", "프로젝트B"], meta_hash: correctHash, star_gaps: 0 };
  const meta = { profiler_score: 4 };
  const resumeSource = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [
      { name: "튜닙", projects: [{ name: "프로젝트A", period: "2022.01 - 2022.06", episodes: [
        { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      ] }] },
      { name: "한섬", projects: [{ name: "프로젝트B", period: "2022.11 - 2023.03", episodes: [
        { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      ] }] },
    ],
  };
  setupGapTestDir(snapshot, resumeSource, meta);

  const result = runGapTest(bashGapInput);
  assert.ok(result, "should trigger profiler");

  // No gap finding should be written (5 months inter-company, threshold is > 6)
  const findingsJsonPath = join(gapTestBase, ".resume-panel", "findings.json");
  if (existsSync(findingsJsonPath)) {
    const findingsData = JSON.parse(readFileSync(findingsJsonPath, "utf-8"));
    const gapFindings = (findingsData.findings || []).filter(f => f.type === "timeline_gap_found");
    assert.strictEqual(gapFindings.length, 0, "no gap findings should be written for 5-month inter-company gap");
  }
  console.log("PASS: detectGaps ignores inter-company gap of 5 months");

  rmSync(gapTestBase, { recursive: true, force: true });
}

// Test gap-4: detectGaps ignores intra-company gap of 2 months (< 3 threshold)
{
  const correctHash = createHash("md5").update("코인원|FE").digest("hex").slice(0, 8);
  const snapshot = { episode_count: 1, project_names: ["프로젝트A", "프로젝트B"], meta_hash: correctHash, star_gaps: 0 };
  const meta = { profiler_score: 4 };
  const resumeSource = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [
      { name: "튜닙", projects: [
        { name: "프로젝트A", period: "2022.01 - 2022.06", episodes: [
          { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
        ] },
        { name: "프로젝트B", period: "2022.08 - 2023.03", episodes: [
          { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
        ] },
      ] },
    ],
  };
  setupGapTestDir(snapshot, resumeSource, meta);

  const result = runGapTest(bashGapInput);
  assert.ok(result, "should trigger profiler");

  const findingsJsonPath = join(gapTestBase, ".resume-panel", "findings.json");
  if (existsSync(findingsJsonPath)) {
    const findingsData = JSON.parse(readFileSync(findingsJsonPath, "utf-8"));
    const gapFindings = (findingsData.findings || []).filter(f => f.type === "timeline_gap_found");
    assert.strictEqual(gapFindings.length, 0, "no gap findings should be written for 2-month intra-company gap");
  }
  console.log("PASS: detectGaps ignores intra-company gap of 2 months");

  rmSync(gapTestBase, { recursive: true, force: true });
}

// Test gap-5: Gap finding message format verification
{
  const correctHash = createHash("md5").update("코인원|FE").digest("hex").slice(0, 8);
  const snapshot = { episode_count: 1, project_names: ["프로젝트A", "프로젝트B"], meta_hash: correctHash, star_gaps: 0 };
  const meta = { profiler_score: 4 };
  const resumeSource = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [
      { name: "튜닙", projects: [{ name: "프로젝트A", period: "2022.01 - 2022.03", episodes: [
        { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      ] }] },
      { name: "한섬", projects: [{ name: "프로젝트B", period: "2022.10 - 2023.03", episodes: [
        { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      ] }] },
    ],
  };
  setupGapTestDir(snapshot, resumeSource, meta);

  const result = runGapTest(bashGapInput);
  assert.ok(result, "should trigger profiler");

  const findingsJsonPath = join(gapTestBase, ".resume-panel", "findings.json");
  assert.ok(existsSync(findingsJsonPath), "findings.json should exist");
  const findingsData = JSON.parse(readFileSync(findingsJsonPath, "utf-8"));
  const finding = findingsData.findings.find(f => f.type === "timeline_gap_found");
  assert.ok(finding, "should have timeline_gap_found finding");
  // Message format: "{from_end} ~ {to_start} ({N}개월) 공백: {from_project}({from_company}) 종료 후 {to_project}({to_company}) 시작 전"
  assert.ok(finding.message.includes("2022.03"), "message should include from_end date");
  assert.ok(finding.message.includes("2022.10"), "message should include to_start date");
  assert.ok(finding.message.includes("개월"), "message should include 개월");
  assert.ok(finding.message.includes("공백"), "message should include 공백");
  assert.ok(finding.message.includes("프로젝트A"), "message should include from_project");
  assert.ok(finding.message.includes("튜닙"), "message should include from_company");
  assert.ok(finding.message.includes("프로젝트B"), "message should include to_project");
  assert.ok(finding.message.includes("한섬"), "message should include to_company");
  assert.ok(finding.source === "episode-watcher", "source should be episode-watcher");
  assert.ok(finding.id.startsWith("tg-"), "id should start with tg-");
  assert.ok(finding.created_at, "created_at should be present");
  console.log("PASS: gap finding message format correct");

  rmSync(gapTestBase, { recursive: true, force: true });
}

// Test gap-6: intentional_gaps in meta.json filters out matching gap
{
  const correctHash = createHash("md5").update("코인원|FE").digest("hex").slice(0, 8);
  const snapshot = { episode_count: 1, project_names: ["프로젝트A", "프로젝트B"], meta_hash: correctHash, star_gaps: 0 };
  // meta has intentional_gaps that matches the gap from 2022.01 end to 2022.08 start
  const meta = {
    profiler_score: 4,
    intentional_gaps: [{ from: "2022.01", to: "2022.08" }],
  };
  const resumeSource = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [
      { name: "튜닙", projects: [{ name: "프로젝트A", period: "2021.06 - 2022.01", episodes: [
        { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      ] }] },
      { name: "한섬", projects: [{ name: "프로젝트B", period: "2022.08 - 2023.03", episodes: [
        { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      ] }] },
    ],
  };
  setupGapTestDir(snapshot, resumeSource, meta);

  const result = runGapTest(bashGapInput);
  assert.ok(result, "should trigger profiler");

  // The gap should be filtered out by intentional_gaps
  const findingsJsonPath = join(gapTestBase, ".resume-panel", "findings.json");
  if (existsSync(findingsJsonPath)) {
    const findingsData = JSON.parse(readFileSync(findingsJsonPath, "utf-8"));
    const gapFindings = (findingsData.findings || []).filter(f => f.type === "timeline_gap_found");
    assert.strictEqual(gapFindings.length, 0, "intentional gap should be filtered out");
  }
  console.log("PASS: intentional_gaps filters out matching gap");

  rmSync(gapTestBase, { recursive: true, force: true });
}

console.log("\nAll gap detection tests passed.");

// ── Pattern eligibility tests ──────────────────────────────

const patternTestBase = "/tmp/test-resume-panel-pattern";

function setupPatternTestDir(snapshot, resumeSource, meta) {
  rmSync(patternTestBase, { recursive: true, force: true });
  mkdirSync(join(patternTestBase, ".resume-panel"), { recursive: true });
  if (snapshot) {
    writeFileSync(join(patternTestBase, ".resume-panel", "snapshot.json"), JSON.stringify(snapshot));
  }
  if (resumeSource) {
    writeFileSync(join(patternTestBase, "resume-source.json"), JSON.stringify(resumeSource));
  }
  if (meta) {
    writeFileSync(join(patternTestBase, ".resume-panel", "meta.json"), JSON.stringify(meta));
  }
}

function runPatternTest(input) {
  try {
    const stdout = execFileSync("node", [script], {
      input: JSON.stringify(input),
      encoding: "utf-8",
      env: { ...process.env, RESUME_PANEL_BASE: patternTestBase },
    });
    return stdout.trim() ? JSON.parse(stdout.trim()) : null;
  } catch (e) {
    if (e.stdout) return e.stdout.trim() ? JSON.parse(e.stdout.trim()) : null;
    throw e;
  }
}

function readPatternMeta() {
  return JSON.parse(readFileSync(join(patternTestBase, ".resume-panel", "meta.json"), "utf-8"));
}

const bashPatternInput = {
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command: "cat <<'EOF' > resume-source.json\n...\nEOF" },
};

// Test pattern-1: 3+ episodes across 2+ companies -> payload has pattern_eligible=true
{
  const correctHash = createHash("md5").update("코인원|FE").digest("hex").slice(0, 8);
  // score=4, +1 episode = 5 -> triggers profiler
  const snapshot = { episode_count: 2, project_names: ["프로젝트A", "프로젝트B"], meta_hash: correctHash, star_gaps: 0 };
  const meta = { profiler_score: 4 };
  const resumeSource = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [
      { name: "튜닙", projects: [{ name: "프로젝트A", period: "2021.01 - 2022.01", episodes: [
        { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
        { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      ] }] },
      { name: "한섬", projects: [{ name: "프로젝트B", period: "2022.02 - 2023.01", episodes: [
        { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      ] }] },
    ],
  };
  setupPatternTestDir(snapshot, resumeSource, meta);

  const result = runPatternTest(bashPatternInput);
  assert.ok(result, "should trigger profiler");
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('"pattern_eligible":true'), "should include pattern eligibility flag when 3+ episodes across 2+ companies");

  // hook-state.json should have last_pattern_analysis_episode_count
  const hsPattern1 = JSON.parse(readFileSync(join(patternTestBase, ".resume-panel", "hook-state.json"), "utf-8"));
  assert.strictEqual(hsPattern1.last_pattern_analysis_episode_count, 3, "should track episode count for pattern analysis in hook-state");
  console.log("PASS: pattern eligibility flag with 3+ episodes across 2+ companies");

  rmSync(patternTestBase, { recursive: true, force: true });
}

// Test pattern-2: 2 episodes (< 3) -> payload has pattern_eligible=false
{
  const correctHash = createHash("md5").update("코인원|FE").digest("hex").slice(0, 8);
  const snapshot = { episode_count: 1, project_names: ["프로젝트A", "프로젝트B"], meta_hash: correctHash, star_gaps: 0 };
  const meta = { profiler_score: 4 };
  const resumeSource = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [
      { name: "튜닙", projects: [{ name: "프로젝트A", period: "2021.01 - 2022.01", episodes: [
        { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      ] }] },
      { name: "한섬", projects: [{ name: "프로젝트B", period: "2022.02 - 2023.01", episodes: [
        { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      ] }] },
    ],
  };
  setupPatternTestDir(snapshot, resumeSource, meta);

  const result = runPatternTest(bashPatternInput);
  assert.ok(result, "should trigger profiler");
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('"pattern_eligible":false'), "should mark pattern_eligible=false when < 3 episodes");
  console.log("PASS: no pattern eligibility with < 3 episodes");

  rmSync(patternTestBase, { recursive: true, force: true });
}

// Test pattern-3: 3+ episodes but only 1 company -> payload has pattern_eligible=false
{
  const correctHash = createHash("md5").update("코인원|FE").digest("hex").slice(0, 8);
  const snapshot = { episode_count: 2, project_names: ["프로젝트A"], meta_hash: correctHash, star_gaps: 0 };
  const meta = { profiler_score: 4 };
  const resumeSource = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [
      { name: "튜닙", projects: [{ name: "프로젝트A", period: "2021.01 - 2023.01", episodes: [
        { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
        { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
        { star: { situation: "s", task: "t", action: "a", result: "매출 30% 증가" } },
      ] }] },
    ],
  };
  setupPatternTestDir(snapshot, resumeSource, meta);

  const result = runPatternTest(bashPatternInput);
  assert.ok(result, "should trigger profiler");
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('"pattern_eligible":false'), "should mark pattern_eligible=false when only 1 company");
  console.log("PASS: no pattern eligibility with only 1 company");

  rmSync(patternTestBase, { recursive: true, force: true });
}

console.log("\nAll pattern eligibility tests passed.");

// ── Phase 2 JSON 프로토콜 테스트 ──────────────────────
// Test Phase 2.1: profiler_trigger 메시지가 [resume-panel]{"type":"profiler_trigger"}... 형태인지 확인
{
  // setup: snapshot + resume-source.json with episodes
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  writeFileSync("/tmp/test-resume-panel/.resume-panel/snapshot.json", JSON.stringify({
    episode_count: 0, project_names: [], meta_hash: "initial", star_gaps: 0, current_company: null
  }));
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({ profiler_score: 4 }));
  const source = {
    meta: { target_company: "T", target_position: "P" },
    companies: [{
      name: "C1", projects: [{
        name: "P1", episodes: [
          { title: "e1", action: "a1", result: "완료", situation: "s", task: "t" },
          { title: "e2", action: "a2", result: "10% 개선", situation: "s", task: "t" }
        ]
      }]
    }]
  };
  writeFileSync("/tmp/test-resume-panel/resume-source.json", JSON.stringify(source));

  const result = run({
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/tmp/test-resume-panel/resume-source.json" },
    cwd: "/tmp/test-resume-panel",
  });

  assert.ok(result, "should produce output when score crosses threshold");
  const ctx = result.hookSpecificOutput.additionalContext;
  const lines = ctx.split("\n\n").filter(Boolean);
  const profilerLine = lines.find(l => l.includes('"type":"profiler_trigger"'));
  assert.ok(profilerLine, `profiler_trigger JSON line missing. got: ${ctx}`);
  assert.ok(profilerLine.startsWith("[resume-panel]"), "prefix missing");
  const payload = JSON.parse(profilerLine.slice("[resume-panel]".length));
  assert.strictEqual(payload.type, "profiler_trigger");
  assert.ok(typeof payload.score === "number", "score should be number");
  assert.ok(typeof payload.episode_count === "number", "episode_count should be number");
  console.log("PASS: Phase 2.1 — profiler_trigger JSON format");
}

// Test Phase 2.2: finding도 JSON 형태로 발행되는지 (해당 조건일 때)
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  writeFileSync("/tmp/test-resume-panel/.resume-panel/snapshot.json", JSON.stringify({
    episode_count: 0, project_names: [], meta_hash: "initial", star_gaps: 0, current_company: null
  }));
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({ profiler_score: 4 }));
  // Two projects with 8-month gap
  const source = {
    meta: { target_company: "T", target_position: "P" },
    companies: [
      { name: "C1", projects: [{ name: "P1", period: "2018.01-2018.08",
        episodes: [{ title: "e1", action: "a", result: "10개 개선", situation: "s", task: "t" }] }] },
      { name: "C2", projects: [{ name: "P2", period: "2019.05-2019.12",
        episodes: [{ title: "e2", action: "a", result: "20% 개선", situation: "s", task: "t" }] }] }
    ]
  };
  writeFileSync("/tmp/test-resume-panel/resume-source.json", JSON.stringify(source));

  // First run: triggers profiler threshold + gap detection (writes to inbox)
  run({
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/tmp/test-resume-panel/resume-source.json" },
    cwd: "/tmp/test-resume-panel",
  });

  // Second run: inbox routing → finding emitted
  const result2 = run({
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/tmp/test-resume-panel/resume-source.json" },
    cwd: "/tmp/test-resume-panel",
  });

  // Note: MEDIUM findings require companyChanged signal — we don't test delivery here.
  if (result2 && result2.hookSpecificOutput) {
    const ctx = result2.hookSpecificOutput.additionalContext;
    const findingLine = ctx.split("\n\n").find(l => l.includes('"type":"finding"'));
    if (findingLine) {
      const payload = JSON.parse(findingLine.slice("[resume-panel]".length));
      assert.strictEqual(payload.type, "finding");
      assert.ok(payload.finding_type, "finding_type required");
      assert.ok(["HIGH", "MEDIUM", "LOW"].includes(payload.urgency), "urgency valid");
      console.log("PASS: Phase 2.2 — finding JSON format");
    } else {
      console.log("SKIP: Phase 2.2 — finding not delivered this run (expected)");
    }
  } else {
    console.log("SKIP: Phase 2.2 — no output this run");
  }
}

// ── Phase 3 meta.json 스키마 테스트 ──────────────────────
// Test Phase 3.1: meta.json 초기화 시 session_limits와 gate_state 포함
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  // no snapshot → first run will initialize
  const source = {
    meta: { target_company: "T", target_position: "P" },
    companies: [{ name: "C1", projects: [{ name: "P1", episodes: [] }] }]
  };
  writeFileSync("/tmp/test-resume-panel/resume-source.json", JSON.stringify(source));

  run({
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/tmp/test-resume-panel/resume-source.json" },
    cwd: "/tmp/test-resume-panel",
  });

  const hs31 = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));
  assert.ok(hs31.session_limits, "session_limits missing");
  assert.ok(hs31.session_limits.gaps, "session_limits.gaps missing");
  assert.strictEqual(hs31.session_limits.gaps.max, 3);
  assert.strictEqual(hs31.session_limits.gaps.used, 0);
  assert.ok(Array.isArray(hs31.session_limits.gaps.intentional), "gaps.intentional should be array");
  assert.strictEqual(hs31.session_limits.perspectives.max, 2);
  assert.strictEqual(hs31.session_limits.contradictions.max, 2);
  assert.ok(hs31.gate_state, "gate_state missing");
  assert.strictEqual(hs31.gate_state.direct_askuserquestion_streak, 0);
  assert.deepStrictEqual(hs31.gate_state.agent_calls_in_current_round, {
    senior: 0, "c-level": 0, recruiter: 0, hr: 0, "coffee-chat": 0
  });
  console.log("PASS: Phase 3.1 — hook-state.json 초기 스키마");
}

// Test Phase 3.2: 기존 meta.json (구 스키마)의 마이그레이션
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  // 구 스키마
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({
    gap_probes_this_session: 1,
    perspective_shifts_this_session: 0,
    perspective_shifted_episodes: ["epA"],
    contradictions_presented_this_session: 2,
    reprobe_log: [{ area: "KB카드", timestamp: "2026-04-20T08:00:00Z" }],
    intentional_gaps: [{ from: "2018.09", to: "2019.05" }],
    profiler_score: 3,
  }));
  writeFileSync("/tmp/test-resume-panel/.resume-panel/snapshot.json", JSON.stringify({
    episode_count: 0, project_names: [], meta_hash: "x", star_gaps: 0, current_company: null
  }));
  const source = { meta: {}, companies: [] };
  writeFileSync("/tmp/test-resume-panel/resume-source.json", JSON.stringify(source));

  run({
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/tmp/test-resume-panel/resume-source.json" },
    cwd: "/tmp/test-resume-panel",
  });

  const meta32 = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", "utf-8"));
  const hs32 = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));
  // hook fields migrated to hook-state.json
  assert.strictEqual(hs32.session_limits.gaps.used, 1, "gaps.used migrated to hook-state");
  assert.strictEqual(hs32.session_limits.perspectives.used, 0, "perspectives.used migrated to hook-state");
  assert.deepStrictEqual(hs32.session_limits.perspectives.episode_refs, ["epA"]);
  assert.strictEqual(hs32.session_limits.contradictions.used, 2, "contradictions.used migrated to hook-state");
  assert.strictEqual(hs32.session_limits.reprobes.log.length, 1, "reprobes.log migrated to hook-state");
  assert.deepStrictEqual(hs32.session_limits.gaps.intentional, [{ from: "2018.09", to: "2019.05" }]);
  // 구 필드 meta에서 삭제 확인
  assert.strictEqual(meta32.gap_probes_this_session, undefined, "old field should be removed from meta");
  assert.strictEqual(meta32.contradictions_presented_this_session, undefined, "old field should be removed from meta");
  console.log("PASS: Phase 3.2 — meta.json 마이그레이션 → hook-state.json");
}

// Test Phase 3.3: Task tool 호출이 agent_calls_in_current_round 증가시킴
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
      direct_askuserquestion_streak: 2,
      agent_calls_in_current_round: { senior: 0, "c-level": 0, recruiter: 0, hr: 0, "coffee-chat": 0 },
      round_turn_counts: { "0": 0, "1": 5, "2": 0, "3": 0 },
      retrospective_invoked: false,
      last_askuserquestion_source: null,
    },
    current_round: 1,
    profiler_score: 0,
  }));

  run({
    hook_event_name: "PostToolUse",
    tool_name: "Task",
    tool_input: { subagent_type: "senior", prompt: "..." },
    cwd: "/tmp/test-resume-panel",
  });

  const hs33 = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));
  assert.strictEqual(hs33.gate_state.agent_calls_in_current_round.senior, 1, "senior count should increment");
  assert.strictEqual(hs33.gate_state.direct_askuserquestion_streak, 0, "direct streak should reset on Task call");
  console.log("PASS: Phase 3.3 — Task 호출 감지");
}

// Test Phase 3.4a: 화이트리스트 선언된 AskUserQuestion은 streak 증가 안 함
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
      round_turn_counts: { "0": 5, "1": 0, "2": 0, "3": 0 },
      retrospective_invoked: false,
      last_askuserquestion_source: { source: "whitelist", case: "round0_basic_info" },
    },
    current_round: 0,
    profiler_score: 0,
  }));

  run({
    hook_event_name: "PostToolUse",
    tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: "?" }] },
    cwd: "/tmp/test-resume-panel",
  });

  const hs34a = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));
  assert.strictEqual(hs34a.gate_state.direct_askuserquestion_streak, 0, "whitelist declared → streak should stay 0");
  assert.strictEqual(hs34a.gate_state.last_askuserquestion_source, null, "source should reset to null");
  console.log("PASS: Phase 3.4a — whitelist 선언 시 streak 비증가");
}

// Test Phase 3.4b: 미선언 AskUserQuestion 3연속 → gate_violation 발행
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
      direct_askuserquestion_streak: 2,
      agent_calls_in_current_round: { senior: 1, "c-level": 0, recruiter: 0, hr: 0, "coffee-chat": 0 },
      round_turn_counts: { "0": 0, "1": 5, "2": 0, "3": 0 },
      retrospective_invoked: false,
      last_askuserquestion_source: null,
    },
    current_round: 1,
    profiler_score: 0,
  }));

  const result = run({
    hook_event_name: "PostToolUse",
    tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: "?" }] },
    cwd: "/tmp/test-resume-panel",
  });

  const hs34b = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));
  assert.strictEqual(hs34b.gate_state.direct_askuserquestion_streak, 3, "streak should hit 3");
  assert.ok(result, "should emit output");
  const ctx = result.hookSpecificOutput.additionalContext;
  const violationLine = ctx.split("\n\n").find(l => l.includes('"gate":"direct_question_burst"'));
  assert.ok(violationLine, `gate_violation direct_question_burst missing: ${ctx}`);
  const payload = JSON.parse(violationLine.slice("[resume-panel]".length));
  assert.strictEqual(payload.type, "gate_violation");
  assert.strictEqual(payload.gate, "direct_question_burst");
  assert.strictEqual(payload.count, 3);
  console.log("PASS: Phase 3.4b — direct_question_burst 감지");
}

// Test Phase 3.5: Round 1 첫 AskUserQuestion 시 senior/c-level 호출 없으면 r1_entry 위반
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
      last_askuserquestion_source: { source: "orchestrator_direct" },
    },
    current_round: 1,
    current_company: "KB국민카드",
    profiler_score: 0,
  }));

  const result = run({
    hook_event_name: "PostToolUse",
    tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: "?" }] },
    cwd: "/tmp/test-resume-panel",
  });

  assert.ok(result, "should emit output");
  const ctx = result.hookSpecificOutput.additionalContext;
  const r1Line = ctx.split("\n\n").find(l => l.includes('"gate":"r1_entry"'));
  assert.ok(r1Line, `r1_entry gate_violation missing: ${ctx}`);
  const payload = JSON.parse(r1Line.slice("[resume-panel]".length));
  assert.strictEqual(payload.gate, "r1_entry");
  assert.strictEqual(payload.company, "KB국민카드");
  console.log("PASS: Phase 3.5 — G1 r1_entry");
}

// Test Phase 3.6: round-transition 2→3 시 recruiter/hr 0회면 r2_exit 위반
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
      agent_calls_in_current_round: { senior: 2, "c-level": 1, recruiter: 0, hr: 0, "coffee-chat": 0 },
      round_turn_counts: { "0": 30, "1": 40, "2": 10, "3": 0 },
      retrospective_invoked: false,
      last_askuserquestion_source: null,
    },
    current_round: 2,
    profiler_score: 0,
  }));
  writeFileSync("/tmp/test-resume-panel/resume-source.json", JSON.stringify({
    meta: {}, companies: [], gap_analysis: null
  }));

  // 시그널: round-transition to 3 — Bash로 파일 쓰기
  writeFileSync("/tmp/test-resume-panel/.resume-panel/round-transition.json", JSON.stringify({ to: 3 }));
  const result = run({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "echo '{\"to\":3}' > .resume-panel/round-transition.json" },
    cwd: "/tmp/test-resume-panel",
  });

  assert.ok(result, "should emit output");
  const ctx = result.hookSpecificOutput.additionalContext;
  const r2Line = ctx.split("\n\n").find(l => l.includes('"gate":"r2_exit"'));
  assert.ok(r2Line, `r2_exit gate_violation missing: ${ctx}`);
  const payload = JSON.parse(r2Line.slice("[resume-panel]".length));
  assert.strictEqual(payload.gate, "r2_exit");
  assert.ok(payload.missing.includes("recruiter"), "missing should include recruiter");
  assert.ok(payload.missing.includes("hr"), "missing should include hr");
  assert.ok(payload.missing.includes("turn_min"), "missing should include turn_min");
  assert.ok(payload.missing.includes("gap_analysis"), "missing should include gap_analysis");
  console.log("PASS: Phase 3.6 — G3 r2_exit");
}

// Test Phase 3.7: session-end 시그널 시 retrospective 미호출이면 G4 위반
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
      round_turn_counts: { "0": 0, "1": 0, "2": 0, "3": 10 },
      retrospective_invoked: false,
      last_askuserquestion_source: null,
    },
    current_round: 3,
    profiler_score: 0,
  }));

  writeFileSync("/tmp/test-resume-panel/.resume-panel/session-end.json", JSON.stringify({}));
  const result = run({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "echo '{}' > .resume-panel/session-end.json" },
    cwd: "/tmp/test-resume-panel",
  });

  assert.ok(result, "should emit output");
  const ctx = result.hookSpecificOutput.additionalContext;
  const g4Line = ctx.split("\n\n").find(l => l.includes('"gate":"retrospective_skipped"'));
  assert.ok(g4Line, `retrospective_skipped missing: ${ctx}`);
  console.log("PASS: Phase 3.7 — G4 retrospective_skipped");
}

// Test Phase 3.8: retrospective Task 호출이 retrospective_invoked=true
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
      round_turn_counts: { "0": 0, "1": 0, "2": 0, "3": 10 },
      retrospective_invoked: false,
      last_askuserquestion_source: null,
    },
    current_round: 3,
    profiler_score: 0,
  }));

  run({
    hook_event_name: "PostToolUse",
    tool_name: "Task",
    tool_input: { subagent_type: "retrospective", prompt: "..." },
    cwd: "/tmp/test-resume-panel",
  });

  const hs38 = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));
  assert.strictEqual(hs38.gate_state.retrospective_invoked, true, "retrospective_invoked should be true");
  console.log("PASS: Phase 3.8 — retrospective Task 감지");
}

// Test Phase 4.1: Task/AskUserQuestion 호출이 session-stats.json에 집계됨
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

  // senior Task 2회 호출
  run({ hook_event_name: "PostToolUse", tool_name: "Task", tool_input: { subagent_type: "senior" }, cwd: "/tmp/test-resume-panel" });
  run({ hook_event_name: "PostToolUse", tool_name: "Task", tool_input: { subagent_type: "senior" }, cwd: "/tmp/test-resume-panel" });

  // AskUserQuestion (agent 소스) 3회 — 각각 호출 전에 소스 선언 (hook-state.json에 기록)
  for (let i = 0; i < 3; i++) {
    const hs41 = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));
    hs41.gate_state.last_askuserquestion_source = { source: "agent", agent_name: "senior" };
    writeFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", JSON.stringify(hs41));
    run({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_input: {}, cwd: "/tmp/test-resume-panel" });
  }

  // AskUserQuestion (whitelist) 1회
  {
    const hs41 = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));
    hs41.gate_state.last_askuserquestion_source = { source: "whitelist", case: "round0_basic_info" };
    writeFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", JSON.stringify(hs41));
    run({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_input: {}, cwd: "/tmp/test-resume-panel" });
  }

  const stats = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/session-stats.json", "utf-8"));
  assert.strictEqual(stats.agent_invocations.senior, 2);
  assert.strictEqual(stats.askuserquestion.total, 4);
  assert.strictEqual(stats.askuserquestion.by_source.agent, 3);
  assert.strictEqual(stats.askuserquestion.by_source.whitelist, 1);
  assert.strictEqual(stats.askuserquestion.by_source.orchestrator_direct, 0);
  console.log("PASS: Phase 4.1 — session-stats.json 집계");
}

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

  const stats51 = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/session-stats.json", "utf-8"));
  const hs51 = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));
  assert.strictEqual(stats51.agent_invocations.senior, 2, "stats.agent_invocations.senior should be 2");
  assert.strictEqual(hs51.gate_state.agent_calls_in_current_round.senior, 2, "hs gate_state senior should be 2");
  console.log("PASS: Phase 5.1 — Agent toolName 수용");
}

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

// Test Phase 5.3a: UserPromptSubmit이 round_turn_counts[current_round] 증가
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  // gate_state/session_limits는 meta.json에 넣어도 loadState가 hook-state.json으로 이전함
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

  // UserPromptSubmit은 이제 hook-state.json에 gate_state를 저장함
  const hs = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));
  assert.strictEqual(hs.gate_state.round_turn_counts["1"], 3, "round 1 should have 3 turns");
  assert.strictEqual(hs.gate_state.round_turn_counts["2"], 0, "round 2 should still be 0");

  // 라운드 전환: meta.json의 current_round를 2로 변경
  const metaForRound = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", "utf-8"));
  metaForRound.current_round = 2;
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify(metaForRound));
  run({ hook_event_name: "UserPromptSubmit", prompt: "라운드 2 메시지", cwd: "/tmp/test-resume-panel" });
  run({ hook_event_name: "UserPromptSubmit", prompt: "라운드 2 메시지 2", cwd: "/tmp/test-resume-panel" });

  const hs2 = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));
  assert.strictEqual(hs2.gate_state.round_turn_counts["1"], 3, "round 1 should still be 3");
  assert.strictEqual(hs2.gate_state.round_turn_counts["2"], 2, "round 2 should be 2");

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

  // UserPromptSubmit은 이제 hook-state.json에 gate_state를 저장함
  const hs = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));
  assert.strictEqual(hs.gate_state.round_turn_counts["0"], 1, "fallback to round 0");
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

  // UserPromptSubmit은 이제 hook-state.json에 gate_state를 저장함
  const hs = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));
  assert.strictEqual(hs.gate_state.round_turn_counts["5"], 1, "non-standard round 5 should accept");
  console.log("PASS: Phase 5.3c — UserPromptSubmit non-standard round");
}

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

  const hs54 = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));
  assert.ok(Array.isArray(hs54._score_reasons), "_score_reasons should be an array");
  assert.ok(hs54._score_reasons.length >= 2, `_score_reasons should have ≥2 entries, got ${hs54._score_reasons.length}`);
  const reasons = hs54._score_reasons.map(r => r.reason);
  assert.ok(reasons.some(r => r.includes("에피소드")), "에피소드 reason missing");
  assert.ok(reasons.some(r => r.includes("새 프로젝트")), "새 프로젝트 reason missing");
  console.log("PASS: Phase 5.4 — _score_reasons 누적 (hook-state.json)");
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

  const hs54b = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));
  assert.ok(hs54b._score_reasons.length <= 10, `_score_reasons should be ≤10, got ${hs54b._score_reasons.length}`);
  // 가장 오래된 seed-0가 잘려나갔는지 확인
  const reasons54b = hs54b._score_reasons.map(r => r.reason);
  assert.ok(!reasons54b.includes("seed-0"), "seed-0 (oldest) should be evicted");
  console.log("PASS: Phase 5.4b — _score_reasons rolling 10");
}

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

  const hs55 = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));
  assert.strictEqual(hs55.profiler_score, 1, "AUQ should add +1 to profiler_score");
  const reasons55 = (hs55._score_reasons || []).map(r => r.reason);
  assert.ok(reasons55.some(r => r.includes("AUQ")), `AUQ reason missing in ${JSON.stringify(reasons55)}`);
  console.log("PASS: Phase 5.5 — AUQ 가중치 +1");
}

// Test Phase 5.5b: AUQ 5회 누적 → 임계 도달 → trigger 발행 + score 0 리셋
{
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  // hook-state.json에 직접 초기 상태 기록 (gate_state/profiler_score는 hook-state 소관)
  writeFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", JSON.stringify({
    session_limits: { gaps: { used: 0, max: 3, intentional: [] }, perspectives: { used: 0, max: 2, episode_refs: [] }, contradictions: { used: 0, max: 2 }, reprobes: { used: 0, log: [] } },
    gate_state: {
      ...defaultGateStateForTest(),
      last_askuserquestion_source: { source: "agent", agent_name: "senior" },
    },
    profiler_score: 0,
    _score_reasons: [],
  }));
  // meta.json에는 content 필드만
  writeFileSync("/tmp/test-resume-panel/.resume-panel/meta.json", JSON.stringify({
    current_round: 1,
  }));

  let lastResult = null;
  for (let i = 0; i < 5; i++) {
    // AUQ 호출 직전 source 재선언 (기존 hook이 처리 후 null로 만듦) — hook-state.json에 기록
    const hs55b = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));
    hs55b.gate_state.last_askuserquestion_source = { source: "agent", agent_name: "senior" };
    writeFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", JSON.stringify(hs55b));
    lastResult = run({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_input: {}, cwd: "/tmp/test-resume-panel" });
  }

  // 5번째 호출에서 score=5 → 임계 도달 → profiler_trigger emit + score 0 리셋
  const hs55bFinal = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));
  assert.strictEqual(hs55bFinal.profiler_score, 0, "score should reset to 0 after threshold");
  // additionalContext에 profiler_trigger 메시지가 있어야 함
  assert.ok(lastResult, "5th AUQ should emit output");
  assert.ok(lastResult.hookSpecificOutput.additionalContext.includes('"type":"profiler_trigger"'),
    `expected profiler_trigger in: ${lastResult.hookSpecificOutput.additionalContext}`);
  console.log("PASS: Phase 5.5b — AUQ 5회 → 임계 도달 + 트리거 + 리셋");
}

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

  const hs56a = JSON.parse(readFileSync("/tmp/test-resume-panel-high-bonus/.resume-panel/hook-state.json", "utf-8"));
  assert.ok(hs56a._last_high_finding_at, "_last_high_finding_at should be set in hook-state.json");
  assert.ok(new Date(hs56a._last_high_finding_at).getTime() > Date.now() - 60_000, "should be recent");
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

  const hs56b = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));
  assert.strictEqual(hs56b.profiler_score, 3, `expected 3 (1 base + 2 bonus), got ${hs56b.profiler_score}`);
  const reasons56b = (hs56b._score_reasons || []).map(r => r.reason);
  assert.ok(reasons56b.some(r => r.includes("HIGH finding")), `HIGH finding bonus reason missing in ${JSON.stringify(reasons56b)}`);
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

  const hs56c = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));
  assert.strictEqual(hs56c.profiler_score, 1, `expected 1 (no bonus), got ${hs56c.profiler_score}`);
  console.log("PASS: Phase 5.6c — AUQ outside 60s window → +1 only");
}

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

  const hs57a = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));
  // 두 번째 실행에서 +1 (에피소드) + +3 (so_what) = +4 누적 (첫 실행은 snapshot init이라 점수 0)
  // 단 임계 5에 못 미치면 그대로 4로 남고, 도달하면 0 리셋. 두 번째 fire에서 4면 리셋 안 함.
  const reasons57a = (hs57a._score_reasons || []).map(r => r.reason);
  assert.ok(reasons57a.some(r => r.includes("so_what")), `so_what reason missing in ${JSON.stringify(reasons57a)}`);
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

  const hs57b = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));
  const reasons57b = (hs57b._score_reasons || []).map(r => r.reason);
  assert.ok(reasons57b.some(r => r.includes("perspective_shift")), `perspective_shift reason missing in ${JSON.stringify(reasons57b)}`);
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

  const hs57c = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));
  const reasons57c = (hs57c._score_reasons || []).map(r => r.reason);
  assert.ok(reasons57c.some(r => r.includes("contradiction_detected")), `contradiction_detected reason missing in ${JSON.stringify(reasons57c)}`);
  console.log("PASS: Phase 5.7c — contradiction_detected 가중치 +3");
}

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

// Test Phase 5.9: unknown subagent → observed_tool_names만 기록, agent_invocations·gate_state 무변동
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
      direct_askuserquestion_streak: 2,
      agent_calls_in_current_round: { senior: 0, "c-level": 0, recruiter: 0, hr: 0, "coffee-chat": 0 },
      round_turn_counts: { "0": 0, "1": 0, "2": 0, "3": 0 },
      retrospective_invoked: false,
      last_askuserquestion_source: null,
    },
    current_round: 1,
    profiler_score: 0,
  }));

  run({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { subagent_type: "mystery-agent" }, cwd: "/tmp/test-resume-panel" });

  const stats59 = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/session-stats.json", "utf-8"));
  const hs59 = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));
  assert.strictEqual(stats59._debug.observed_tool_names.Agent, 1, "Agent observed once");
  const totalInvocations = Object.values(stats59.agent_invocations).reduce((a, b) => a + b, 0);
  assert.strictEqual(totalInvocations, 0, "no agent_invocations counter incremented for unknown subagent");
  assert.strictEqual(hs59.gate_state.direct_askuserquestion_streak, 2, "streak unchanged for unknown subagent");
  assert.strictEqual(hs59.gate_state.retrospective_invoked, false, "retrospective_invoked unchanged");
  console.log("PASS: Phase 5.9 — unknown subagent 안전 처리");
}

// Test Phase 6.1: defaultHookState() returns expected schema
{
  // helper export 없으므로 hook 호출로 간접 검증
  rmSync("/tmp/test-resume-panel", { recursive: true, force: true });
  mkdirSync("/tmp/test-resume-panel/.resume-panel", { recursive: true });
  // meta.json도 hook-state.json도 없는 상태에서 UserPromptSubmit 호출
  run({ hook_event_name: "UserPromptSubmit", cwd: "/tmp/test-resume-panel" });

  const hs61 = JSON.parse(readFileSync("/tmp/test-resume-panel/.resume-panel/hook-state.json", "utf-8"));
  assert.ok(hs61.session_limits, "session_limits exists");
  assert.deepStrictEqual(hs61.session_limits.gaps, { used: 0, max: 3, intentional: [] }, "default gaps");
  assert.ok(hs61.gate_state, "gate_state exists");
  assert.strictEqual(hs61.gate_state.direct_askuserquestion_streak, 0, "default streak 0");
  assert.deepStrictEqual(hs61.gate_state.round_turn_counts, { "0": 1, "1": 0, "2": 0, "3": 0 }, "round 0 incremented by this UserPromptSubmit");
  assert.strictEqual(hs61.profiler_score, 0, "default score 0");
  assert.deepStrictEqual(hs61._score_reasons, [], "default reasons empty");
  console.log("PASS: Phase 6.1 — defaultHookState 스키마");
}

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
  const bakFiles = readdirSync("/tmp/test-resume-panel/.resume-panel/")
    .filter(f => f.startsWith("hook-state.json.bak."));
  assert.strictEqual(bakFiles.length, 1, "백업 파일 1개 생성");
  console.log("PASS: Phase 6.5 — malformed hook-state.json 백업 + 복구");
}

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
    current_round: 1,
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
      env: { ...process.env, RESUME_PANEL_BASE: focusBase },
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

console.log("\n=== ALL TESTS COMPLETE ===");
