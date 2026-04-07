// plugins/resume/scripts/test-episode-watcher.mjs
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert";

const __dirname = dirname(fileURLToPath(import.meta.url));
const script = join(__dirname, "episode-watcher.mjs");

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
  // first run initializes profiler_score in meta.json
  assert.ok(existsSync(join(testBase, ".resume-panel", "meta.json")), "meta.json should be created on first run");
  const metaAfterFirst = JSON.parse(readFileSync(join(testBase, ".resume-panel", "meta.json"), "utf-8"));
  assert.strictEqual(metaAfterFirst.profiler_score, 0, "first run should initialize profiler_score to 0");
  console.log("PASS: first run creates snapshot and initializes profiler_score = 0");
}

// ── Scoring system tests ─────────────────────────────

function readMeta() {
  return JSON.parse(readFileSync(join(testBase, ".resume-panel", "meta.json"), "utf-8"));
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
  const metaAfter = readMeta();
  assert.strictEqual(metaAfter.profiler_score, 1, "profiler_score should be 1 after +1 episode");
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
  const metaAfter1 = readMeta();
  assert.strictEqual(metaAfter1.profiler_score, 4, "profiler_score should accumulate to 4");

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
  assert.ok(ctx2.includes("프로파일러"), "should mention profiler");
  assert.ok(ctx2.includes("score:"), "should include score in output");
  const metaAfter2 = readMeta();
  assert.strictEqual(metaAfter2.profiler_score, 0, "profiler_score should reset to 0 after trigger");
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
  assert.ok(ctx.includes("프로파일러"), "should mention profiler");
  assert.ok(ctx.includes("새 프로젝트"), "should mention new project");
  const metaAfter = readMeta();
  assert.strictEqual(metaAfter.profiler_score, 0, "profiler_score should reset to 0 after trigger");
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
  const metaAfter1 = readMeta();
  assert.strictEqual(metaAfter1.profiler_score, 4, "profiler_score should be 4");

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
  const metaAfter2 = readMeta();
  assert.strictEqual(metaAfter2.profiler_score, 0, "profiler_score should reset to 0");
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
  const metaAfter1 = readMeta();
  assert.strictEqual(metaAfter1.profiler_score, 4, "profiler_score should be 4");

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
  const metaAfter2 = readMeta();
  assert.strictEqual(metaAfter2.profiler_score, 0, "profiler_score should reset to 0");
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
  const metaAfter = readMeta();
  assert.strictEqual(metaAfter.profiler_score, 0, "profiler_score should reset to 0 after trigger");
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
  assert.ok(ctx.includes("프로파일러"), "should mention profiler");
  assert.ok(ctx.includes("새 프로젝트"), "should mention new project");
  assert.ok(ctx.includes("meta 변경"), "should mention meta change");
  const metaAfter = readMeta();
  assert.strictEqual(metaAfter.profiler_score, 0, "profiler_score should reset to 0");
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
  const metaAfterTrigger = readMeta();
  assert.strictEqual(metaAfterTrigger.profiler_score, 0, "profiler_score should be 0 after trigger");

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
  const metaAfterFresh = readMeta();
  assert.strictEqual(metaAfterFresh.profiler_score, 1, "profiler_score should be 1 after fresh +1");
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
  assert.ok(ctx.includes("빈 STAR 2개"), "should count 2 episodes with incomplete STAR");
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
  assert.ok(parsed.hookSpecificOutput.additionalContext.includes("[resume-panel:HIGH]"));
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
  assert.ok(parsed.hookSpecificOutput.additionalContext.includes("[resume-panel:MEDIUM]"));
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
  // Should have output containing [resume-panel:SO-WHAT]
  assert.ok(result, "weak result episode should produce output with SO-WHAT");
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes("[resume-panel:SO-WHAT]"), "should contain SO-WHAT tag");
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
    assert.ok(!ctx.includes("[resume-panel:SO-WHAT]"), "quantified result should NOT trigger SO-WHAT");
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
    assert.ok(!ctx.includes("[resume-panel:SO-WHAT]"), "so_what_active should suppress SO-WHAT trigger");
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
  assert.ok(ctx.includes("[resume-panel]"), "should contain profiler tag");
  assert.ok(ctx.includes("[resume-panel:SO-WHAT]"), "should also contain SO-WHAT tag");
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

// Test pattern-1: 3+ episodes across 2+ companies -> message includes "패턴 분석 가능"
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
  assert.ok(ctx.includes("패턴 분석 가능"), "should include pattern eligibility flag when 3+ episodes across 2+ companies");

  // meta.json should have last_pattern_analysis_episode_count
  const metaAfter = readPatternMeta();
  assert.strictEqual(metaAfter.last_pattern_analysis_episode_count, 3, "should track episode count for pattern analysis");
  console.log("PASS: pattern eligibility flag with 3+ episodes across 2+ companies");

  rmSync(patternTestBase, { recursive: true, force: true });
}

// Test pattern-2: 2 episodes (< 3) -> message does NOT include "패턴 분석 가능"
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
  assert.ok(!ctx.includes("패턴 분석 가능"), "should NOT include pattern eligibility flag when < 3 episodes");
  console.log("PASS: no pattern eligibility with < 3 episodes");

  rmSync(patternTestBase, { recursive: true, force: true });
}

// Test pattern-3: 3+ episodes but only 1 company -> message does NOT include "패턴 분석 가능"
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
  assert.ok(!ctx.includes("패턴 분석 가능"), "should NOT include pattern eligibility flag when only 1 company");
  console.log("PASS: no pattern eligibility with only 1 company");

  rmSync(patternTestBase, { recursive: true, force: true });
}

console.log("\nAll pattern eligibility tests passed.");
console.log("\n=== ALL TESTS COMPLETE ===");
