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

// Test: 첫 실행 (스냅샷 없음) → 스냅샷만 저장, 트리거 안 함
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
  console.log("PASS: first run creates snapshot without triggering");
}

// Test: 에피소드 +3 → 프로파일러 호출 필요
{
  const correctHash = createHash("md5").update("코인원|FE").digest("hex").slice(0, 8);
  const snapshot = { episode_count: 2, project_names: ["프로젝트A"], meta_hash: correctHash };
  const resumeSource = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [{ name: "튜닙", projects: [{ name: "프로젝트A", episodes: [{}, {}, {}, {}, {}] }] }],
  };
  setupTestDir(snapshot, resumeSource);

  const result = runWithBase(bashResumeInput);
  assert.ok(result, "should produce output when delta >= 3");
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes("[resume-panel]"), "should have resume-panel tag");
  assert.ok(ctx.includes("프로파일러"), "should mention profiler");
  assert.ok(ctx.includes("에피소드 +3"), "should mention episode delta");
  console.log("PASS: episode +3 triggers profiler");
}

// Test: 에피소드 +1 → 임계치 미달 → skip
{
  const correctHash = createHash("md5").update("코인원|FE").digest("hex").slice(0, 8);
  const snapshot = { episode_count: 4, project_names: ["프로젝트A"], meta_hash: correctHash };
  const resumeSource = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [{ name: "튜닙", projects: [{ name: "프로젝트A", episodes: [{}, {}, {}, {}, {}] }] }],
  };
  setupTestDir(snapshot, resumeSource);

  const result = runWithBase(bashResumeInput);
  assert.strictEqual(result, null, "episode +1 should not trigger");
  console.log("PASS: episode +1 does not trigger");
}

// Test: 새 프로젝트 등장 → 트리거
{
  const correctHash = createHash("md5").update("코인원|FE").digest("hex").slice(0, 8);
  const snapshot = { episode_count: 5, project_names: ["프로젝트A"], meta_hash: correctHash };
  const resumeSource = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [{
      name: "튜닙",
      projects: [
        { name: "프로젝트A", episodes: [{}, {}, {}, {}, {}] },
        { name: "프로젝트B", episodes: [{}] },
      ],
    }],
  };
  setupTestDir(snapshot, resumeSource);

  const result = runWithBase(bashResumeInput);
  assert.ok(result, "new project should trigger");
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes("새 프로젝트"), "should mention new project");
  console.log("PASS: new project triggers profiler");
}

// Test: 쿨다운 초과 (meta.json의 last_profiler_episode_count 대비 +5)
{
  const correctHash = createHash("md5").update("코인원|FE").digest("hex").slice(0, 8);
  const snapshot = { episode_count: 9, project_names: ["프로젝트A"], meta_hash: correctHash };
  const meta = { last_profiler_call: "2026-04-03T15:00:00Z", last_profiler_episode_count: 5, total_profiler_calls: 1 };
  const resumeSource = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [{ name: "튜닙", projects: [{ name: "프로젝트A", episodes: [{},{},{},{},{},{},{},{},{},{}] }] }],
  };
  setupTestDir(snapshot, resumeSource, meta);

  const result = runWithBase(bashResumeInput);
  assert.ok(result, "cooldown exceeded should trigger");
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes("쿨다운"), "should mention cooldown");
  console.log("PASS: cooldown exceeded triggers profiler");
}

// Test: STAR 갭 카운팅
{
  const correctHash = createHash("md5").update("코인원|FE").digest("hex").slice(0, 8);
  const snapshot = { episode_count: 0, project_names: ["A"], meta_hash: correctHash };
  const resumeSource = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [{
      name: "튜닙",
      projects: [{
        name: "A",
        episodes: [
          { situation: "s", task: "t", action: "a", result: "r" },  // complete
          { situation: "s", task: "", action: "a", result: "" },     // 2 gaps → counts as 1 incomplete episode
          {},  // all missing → 1 incomplete episode
        ],
      }],
    }],
  };
  setupTestDir(snapshot, resumeSource);

  const result = runWithBase(bashResumeInput);
  assert.ok(result, "should trigger (episode +3)");
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes("빈 STAR 2개"), "should count 2 episodes with incomplete STAR");
  console.log("PASS: STAR gap counting works");
}

// Cleanup
rmSync(testBase, { recursive: true, force: true });
console.log("\nAll delta detection tests passed.");

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

console.log("\nAll findings routing tests passed.");
