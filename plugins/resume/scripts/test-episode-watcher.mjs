// plugins/resume/scripts/test-episode-watcher.mjs
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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

// Test 3: resume-source.json 변경이지만 아직 delta 감지 미구현 → 출력 없음
{
  const result = run({
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/work/resume-source.json", content: "{}" },
  });
  assert.strictEqual(result, null, "resume-source change but no delta logic yet");
  console.log("PASS: resume-source.json change (no delta logic yet)");
}

// Test 4: Bash로 resume-source.json 저장 — 아직 delta 미구현이므로 출력 없음
{
  const result = run({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "cat <<'EOF' > resume-source.json\n{}\nEOF" },
  });
  assert.strictEqual(result, null, "bash resume-source change but no delta logic yet");
  console.log("PASS: Bash resume-source.json (no delta logic yet)");
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

console.log("\nAll skeleton tests passed.");
