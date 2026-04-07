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
    projects: [{ name: "프로젝트A", company: "튜닙", episodes: [{}, {}] }],
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
    projects: [{ name: "프로젝트A", company: "튜닙", episodes: [
      { star: { situation: "s", task: "t", action: "a", result: "r" } },
      { star: { situation: "s", task: "t", action: "a", result: "r" } },
      { star: { situation: "s", task: "t", action: "a", result: "r" } },
    ] }],
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
    projects: [{ name: "프로젝트A", company: "튜닙", episodes: [
      { star: { situation: "s", task: "t", action: "a", result: "r" } },
      { star: { situation: "s", task: "t", action: "a", result: "r" } },
      { star: { situation: "s", task: "t", action: "a", result: "r" } },
    ] }],
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
    projects: [{ name: "프로젝트A", company: "튜닙", episodes: [
      { star: { situation: "s", task: "t", action: "a", result: "r" } },
      { star: { situation: "s", task: "t", action: "a", result: "r" } },
      { star: { situation: "s", task: "t", action: "a", result: "r" } },
      { star: { situation: "s", task: "t", action: "a", result: "r" } },
    ] }],
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
    projects: [
      { name: "프로젝트A", company: "튜닙", episodes: [
        { star: { situation: "s", task: "t", action: "a", result: "r" } },
        { star: { situation: "s", task: "t", action: "a", result: "r" } },
        { star: { situation: "s", task: "t", action: "a", result: "r" } },
        { star: { situation: "s", task: "t", action: "a", result: "r" } },
        { star: { situation: "s", task: "t", action: "a", result: "r" } },
      ] },
      { name: "프로젝트B", company: "튜닙", episodes: [
        { star: { situation: "s", task: "t", action: "a", result: "r" } },
      ] },
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
  const snapshot1 = { episode_count: 2, project_names: ["A"], meta_hash: correctHash, star_gaps: 0 };
  const meta1 = { profiler_score: 1 };
  const resumeSource1 = {
    meta: { target_company: "코인원", target_position: "FE" },
    projects: [{ name: "A", company: "튜닙", episodes: [
      { star: { situation: "s", task: "t", action: "a", result: "r" } },
      { star: { situation: "s", task: "t", action: "a", result: "r" } },
      { star: { situation: "s", task: "", action: "a", result: "" } },  // incomplete = new star gap
    ] }],
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
    projects: [{ name: "A", company: "튜닙", episodes: [
      { star: { situation: "s", task: "t", action: "a", result: "r" } },
      { star: { situation: "s", task: "t", action: "a", result: "r" } },
      { star: { situation: "s", task: "", action: "a", result: "" } },  // incomplete = star gap
    ] }],
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
    projects: [{ name: "A", company: "튜닙", episodes: [
      { star: { situation: "s", task: "t", action: "기존 코드 분석", result: "r" } },
      { star: { situation: "s", task: "t", action: "팀원에게 도움을 줬습니다", result: "r" } },
    ] }],
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
    projects: [{ name: "A", company: "튜닙", episodes: [
      { star: { situation: "s", task: "t", action: "기존 코드 분석", result: "r" } },
      { star: { situation: "s", task: "t", action: "프로젝트에 참여했습니다", result: "r" } },
    ] }],
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
    projects: [{ name: "프로젝트A", company: "튜닙", episodes: [
      { star: { situation: "s", task: "t", action: "a", result: "r" } },
      { star: { situation: "s", task: "t", action: "a", result: "r" } },
      { star: { situation: "s", task: "t", action: "a", result: "r" } },
      { star: { situation: "s", task: "t", action: "a", result: "r" } },
      { star: { situation: "s", task: "t", action: "a", result: "r" } },
    ] }],
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
    projects: [
      { name: "프로젝트A", company: "튜닙", episodes: [
        { star: { situation: "s", task: "t", action: "a", result: "r" } },
        { star: { situation: "s", task: "t", action: "a", result: "r" } },
        { star: { situation: "s", task: "t", action: "a", result: "r" } },
        { star: { situation: "s", task: "t", action: "a", result: "r" } },
        { star: { situation: "s", task: "t", action: "a", result: "r" } },
      ] },
      { name: "프로젝트B", company: "한섬", episodes: [
        { star: { situation: "s", task: "t", action: "a", result: "r" } },
      ] },
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
    projects: [{ name: "프로젝트A", company: "튜닙", episodes: [
      { star: { situation: "s", task: "t", action: "a", result: "r" } },
      { star: { situation: "s", task: "t", action: "a", result: "r" } },
      { star: { situation: "s", task: "t", action: "a", result: "r" } },
      { star: { situation: "s", task: "t", action: "a", result: "r" } },
      { star: { situation: "s", task: "t", action: "a", result: "r" } },
    ] }],
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
    projects: [{ name: "프로젝트A", company: "튜닙", episodes: [
      { star: { situation: "s", task: "t", action: "a", result: "r" } },
      { star: { situation: "s", task: "t", action: "a", result: "r" } },
      { star: { situation: "s", task: "t", action: "a", result: "r" } },
      { star: { situation: "s", task: "t", action: "a", result: "r" } },
      { star: { situation: "s", task: "t", action: "a", result: "r" } },
      { star: { situation: "s", task: "t", action: "a", result: "r" } },
    ] }],
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
    projects: [{
      name: "A",
      company: "튜닙",
      episodes: [
        { star: { situation: "s", task: "t", action: "a", result: "r" } },  // complete
        { star: { situation: "s", task: "", action: "a", result: "" } },     // incomplete
        {},  // no star at all → incomplete
      ],
    }],
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
