# Resume Panel 자율 오케스트레이션 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** resume-panel 스킬에 상태 기반 자율 에이전트 트리거 시스템을 추가하여, 메인 오케스트레이터가 인터뷰에 집중하는 동안 뒷단에서 에이전트들이 자동 조사/분석/피드백하는 구조를 만든다.

**Architecture:** PostToolUse hook(episode-watcher.mjs)이 resume-source.json 변경을 감지하여 프로파일러를 트리거하고, 프로파일러가 전문 에이전트들을 디스패치한 결과를 findings-inbox.jsonl에 기록하면, hook이 긴급도별로 라우팅하여 오케스트레이터 컨텍스트에 주입한다.

**Tech Stack:** Node.js (ESM), Claude Code Plugin Hooks (PostToolUse), JSON/JSONL 상태 파일

**설계 문서:** `docs/superpowers/resume-panel-orchestration-design.md`

**설계 대비 수정사항:**
- 설계문서의 `systemMessage`는 Claude Code에서 유저에게 경고를 보여주는 용도. 오케스트레이터(Claude)에게 텍스트를 주입하려면 `hookSpecificOutput.additionalContext`를 사용해야 함. 본 계획에서는 `additionalContext`로 수정.

---

## 파일 구조

```
plugins/resume/
├── .claude/
│   └── agents/
│       └── profiler.md              ← 수정: findings-inbox.jsonl 쓰기 지시 추가
├── hooks/
│   └── hooks.json                   ← 생성: PostToolUse hook 설정
├── scripts/
│   ├── episode-watcher.mjs          ← 생성: 메인 hook 스크립트
│   └── test-episode-watcher.mjs     ← 생성: 수동 테스트 스크립트
└── skills/
    └── resume-panel/
        └── SKILL.md                 ← 수정: additionalContext 처리 규칙 추가
```

런타임 상태 파일 (`.resume-panel/`는 resume-source.json과 같은 디렉토리에 생성):
```
.resume-panel/
├── snapshot.json
├── findings.json
├── findings-inbox.jsonl
└── meta.json
```

---

### Task 1: hooks.json 생성

**Files:**
- Create: `plugins/resume/hooks/hooks.json`

- [ ] **Step 1: hooks 디렉토리 생성 및 hooks.json 작성**

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Bash|Edit",
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

Note: matcher에 `Edit`도 추가. resume-source.json을 Edit tool로 수정할 수도 있음.

- [ ] **Step 2: 커밋**

```bash
git add plugins/resume/hooks/hooks.json
git commit -m "feat(resume): add PostToolUse hook config for episode-watcher"
```

---

### Task 2: episode-watcher.mjs — 뼈대 + self-trigger 방지

**Files:**
- Create: `plugins/resume/scripts/episode-watcher.mjs`
- Create: `plugins/resume/scripts/test-episode-watcher.mjs`

- [ ] **Step 1: 테스트 스크립트 작성 — self-trigger 방지 검증**

```js
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

console.log("\nAll tests passed.");
```

- [ ] **Step 2: episode-watcher.mjs 뼈대 작성 — stdin 파싱 + self-trigger 방지**

```js
#!/usr/bin/env node
// plugins/resume/scripts/episode-watcher.mjs
//
// PostToolUse hook: resume-source.json 변경 감지 + findings 라우팅
// 입력: stdin (JSON) — Claude Code hook input
// 출력: stdout (JSON) — hookSpecificOutput.additionalContext 포함, 또는 빈 출력

import { readFileSync } from "node:fs";

// --- stdin 읽기 ---
let input;
try {
  const raw = readFileSync("/dev/stdin", "utf-8");
  input = JSON.parse(raw);
} catch {
  process.exit(0); // 파싱 실패 → 무시
}

const toolName = input.tool_name;
const toolInput = input.tool_input || {};

// --- 파일 경로 추출 ---
// Write/Edit: tool_input.file_path
// Bash: tool_input.command에서 resume-source.json 포함 여부로 판단
let targetPath = "";
if (toolName === "Write" || toolName === "Edit") {
  targetPath = toolInput.file_path || "";
} else if (toolName === "Bash") {
  targetPath = (toolInput.command || "").includes("resume-source.json")
    ? "resume-source.json"
    : "";
}

// --- self-trigger 방지 ---
if (targetPath.includes(".resume-panel/") || targetPath.includes(".resume-panel\\")) {
  process.exit(0);
}

// --- resume-source.json 변경 여부 ---
const isResumeSourceChange = targetPath.includes("resume-source.json");

// --- 메인 로직 (Task 3, 4에서 구현) ---
const messages = [];

// 역할 1: delta 감지 (isResumeSourceChange일 때)
// → Task 3에서 구현

// 역할 2: findings 라우팅 (매 호출마다)
// → Task 4에서 구현

// --- 출력 ---
if (messages.length > 0) {
  const output = {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: messages.join("\n\n"),
    },
  };
  process.stdout.write(JSON.stringify(output));
}
```

- [ ] **Step 3: 테스트 실행**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs`
Expected: 
```
PASS: self-trigger prevention
PASS: unrelated file ignored

All tests passed.
```

- [ ] **Step 4: 커밋**

```bash
git add plugins/resume/scripts/episode-watcher.mjs plugins/resume/scripts/test-episode-watcher.mjs
git commit -m "feat(resume): add episode-watcher skeleton with self-trigger prevention"
```

---

### Task 3: episode-watcher.mjs — 역할 1: delta 감지 → 프로파일러 호출 판단

**Files:**
- Modify: `plugins/resume/scripts/episode-watcher.mjs`
- Modify: `plugins/resume/scripts/test-episode-watcher.mjs`

- [ ] **Step 1: 테스트 추가 — delta 감지 시나리오들**

test-episode-watcher.mjs에 추가:

```js
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

const testBase = "/tmp/test-resume-panel-delta";

function setupTestDir(snapshot, resumeSource) {
  rmSync(testBase, { recursive: true, force: true });
  mkdirSync(join(testBase, ".resume-panel"), { recursive: true });
  if (snapshot) {
    writeFileSync(join(testBase, ".resume-panel", "snapshot.json"), JSON.stringify(snapshot));
  }
  if (resumeSource) {
    writeFileSync(join(testBase, "resume-source.json"), JSON.stringify(resumeSource));
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

// Test 3: 에피소드 +3 → 프로파일러 호출 필요
{
  const snapshot = {
    episode_count: 2,
    project_names: ["프로젝트A"],
    meta_hash: "abc",
  };
  const resumeSource = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [
      {
        name: "튜닙",
        projects: [
          { name: "프로젝트A", episodes: [{}, {}, {}, {}, {}] }, // 5개
        ],
      },
    ],
  };
  setupTestDir(snapshot, resumeSource);

  const result = runWithBase({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "cat <<'EOF' > resume-source.json\n...\nEOF" },
  });

  assert.ok(result, "should produce output when delta >= 3");
  const ctx = result.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes("[resume-panel]"), "should have resume-panel tag");
  assert.ok(ctx.includes("프로파일러"), "should mention profiler");
  console.log("PASS: episode +3 triggers profiler");
}

// Test 4: 에피소드 +1 → 임계치 미달 → 무시
{
  const snapshot = { episode_count: 4, project_names: ["프로젝트A"], meta_hash: "abc" };
  const resumeSource = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [
      { name: "튜닙", projects: [{ name: "프로젝트A", episodes: [{}, {}, {}, {}, {}] }] },
    ],
  };
  setupTestDir(snapshot, resumeSource);

  const result = runWithBase({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "cat <<'EOF' > resume-source.json\n...\nEOF" },
  });

  // findings도 없으므로 null이어야 함
  assert.strictEqual(result, null, "episode +1 should not trigger");
  console.log("PASS: episode +1 does not trigger");
}

// Test 5: 새 프로젝트 등장 → 트리거
{
  const snapshot = { episode_count: 5, project_names: ["프로젝트A"], meta_hash: "abc" };
  const resumeSource = {
    meta: { target_company: "코인원", target_position: "FE" },
    companies: [
      {
        name: "튜닙",
        projects: [
          { name: "프로젝트A", episodes: [{}, {}, {}, {}, {}] },
          { name: "프로젝트B", episodes: [{}] },
        ],
      },
    ],
  };
  setupTestDir(snapshot, resumeSource);

  const result = runWithBase({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "cat <<'EOF' > resume-source.json\n...\nEOF" },
  });

  assert.ok(result, "new project should trigger");
  console.log("PASS: new project triggers profiler");
}

// Cleanup
rmSync(testBase, { recursive: true, force: true });

console.log("\nAll delta detection tests passed.");
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs`
Expected: Test 3, 4, 5 FAIL (delta detection not implemented yet)

- [ ] **Step 3: delta 감지 로직 구현**

episode-watcher.mjs에서 `// 역할 1: delta 감지` 주석 부분을 다음으로 교체:

```js
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

// --- 기본 경로 ---
// RESUME_PANEL_BASE: resume-source.json이 있는 디렉토리 (테스트용 오버라이드 가능)
// 실제 사용 시: cwd (input.cwd)
const base = process.env.RESUME_PANEL_BASE || input.cwd || process.cwd();
const stateDir = join(base, ".resume-panel");
const snapshotPath = join(stateDir, "snapshot.json");
const metaPath = join(stateDir, "meta.json");
const resumeSourcePath = join(base, "resume-source.json");

function ensureStateDir() {
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
}

function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function countEpisodes(source) {
  let count = 0;
  for (const company of source.companies || []) {
    for (const project of company.projects || []) {
      count += (project.episodes || []).length;
    }
  }
  return count;
}

function getProjectNames(source) {
  const names = [];
  for (const company of source.companies || []) {
    for (const project of company.projects || []) {
      if (project.name) names.push(project.name);
    }
  }
  return names.sort();
}

function hashMeta(source) {
  const meta = source.meta || {};
  const str = `${meta.target_company}|${meta.target_position}`;
  return createHash("md5").update(str).digest("hex").slice(0, 8);
}

// 역할 1: delta 감지
if (isResumeSourceChange) {
  const source = readJSON(resumeSourcePath);
  if (source) {
    const snapshot = readJSON(snapshotPath);
    const currentCount = countEpisodes(source);
    const currentProjects = getProjectNames(source);
    const currentMetaHash = hashMeta(source);

    let shouldTrigger = false;
    const reasons = [];

    if (!snapshot) {
      // 첫 실행: 스냅샷이 없으면 스냅샷만 저장하고 트리거하지 않음
      ensureStateDir();
      writeFileSync(snapshotPath, JSON.stringify({
        episode_count: currentCount,
        project_names: currentProjects,
        meta_hash: currentMetaHash,
      }));
    } else {
      const prevCount = snapshot.episode_count || 0;
      const prevProjects = snapshot.project_names || [];
      const prevMetaHash = snapshot.meta_hash || "";

      // 임계치 1: 에피소드 +3
      if (currentCount - prevCount >= 3) {
        shouldTrigger = true;
        reasons.push(`에피소드 +${currentCount - prevCount}`);
      }

      // 임계치 2: 새 프로젝트 등장
      const newProjects = currentProjects.filter((p) => !prevProjects.includes(p));
      if (newProjects.length > 0) {
        shouldTrigger = true;
        reasons.push(`새 프로젝트: ${newProjects.join(", ")}`);
      }

      // 임계치 3: meta 변경 (타겟 회사/포지션)
      if (currentMetaHash !== prevMetaHash) {
        shouldTrigger = true;
        reasons.push("타겟 변경");
      }

      // 임계치 4: 절대 쿨다운 — 마지막 프로파일러 호출 이후 에피소드 +5
      const meta = readJSON(metaPath);
      if (meta && meta.last_profiler_episode_count != null) {
        if (currentCount - meta.last_profiler_episode_count >= 5) {
          shouldTrigger = true;
          reasons.push(`쿨다운 초과 (마지막 프로파일러 이후 +${currentCount - meta.last_profiler_episode_count})`);
        }
      }

      if (shouldTrigger) {
        // 스냅샷 갱신
        ensureStateDir();
        writeFileSync(snapshotPath, JSON.stringify({
          episode_count: currentCount,
          project_names: currentProjects,
          meta_hash: currentMetaHash,
        }));

        const starGaps = countStarGaps(source);
        const projectCount = currentProjects.length;
        messages.push(
          `[resume-panel] 프로파일러 호출 필요. delta: ${reasons.join(", ")}. 현재 총 에피소드 ${currentCount}개, 빈 STAR ${starGaps}개, 프로젝트 ${projectCount}개.`
        );
      }
    }
  }
}

function countStarGaps(source) {
  let gaps = 0;
  for (const company of source.companies || []) {
    for (const project of company.projects || []) {
      for (const ep of project.episodes || []) {
        if (!ep.situation || !ep.task || !ep.action || !ep.result) gaps++;
      }
    }
  }
  return gaps;
}
```

Note: `readFileSync`는 이미 최상단에서 import됨. 추가 import가 필요한 `existsSync`, `writeFileSync`, `mkdirSync`, `join`, `createHash`를 최상단 import에 추가.

- [ ] **Step 4: 테스트 실행 — 통과 확인**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs`
Expected: All tests pass.

- [ ] **Step 5: 커밋**

```bash
git add plugins/resume/scripts/episode-watcher.mjs plugins/resume/scripts/test-episode-watcher.mjs
git commit -m "feat(resume): implement delta detection in episode-watcher"
```

---

### Task 4: episode-watcher.mjs — 역할 2: findings 라우팅

**Files:**
- Modify: `plugins/resume/scripts/episode-watcher.mjs`
- Modify: `plugins/resume/scripts/test-episode-watcher.mjs`

- [ ] **Step 1: 테스트 추가 — findings 라우팅 시나리오들**

test-episode-watcher.mjs에 추가:

```js
// Test 6: HIGH finding → 즉시 additionalContext에 포함
{
  const testFindingsBase = "/tmp/test-resume-panel-findings";
  rmSync(testFindingsBase, { recursive: true, force: true });
  mkdirSync(join(testFindingsBase, ".resume-panel"), { recursive: true });

  // snapshot 있어야 첫 실행 분기 안 타고 넘어감
  writeFileSync(join(testFindingsBase, ".resume-panel", "snapshot.json"), JSON.stringify({
    episode_count: 5, project_names: ["A"], meta_hash: "abc",
  }));

  // findings-inbox에 HIGH 항목
  const finding = {
    id: "f-001",
    urgency: "HIGH",
    source: "recruiter",
    type: "gap_detected",
    message: "WebSocket 실시간 경험 완전 공백.",
    context: {},
    created_at: new Date().toISOString(),
  };
  writeFileSync(
    join(testFindingsBase, ".resume-panel", "findings-inbox.jsonl"),
    JSON.stringify(finding) + "\n"
  );

  const result = execFileSync("node", [script], {
    input: JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/work/some-other-file.txt", content: "x" },
    }),
    encoding: "utf-8",
    env: { ...process.env, RESUME_PANEL_BASE: testFindingsBase },
  });

  const parsed = result.trim() ? JSON.parse(result.trim()) : null;
  assert.ok(parsed, "HIGH finding should produce output");
  const ctx = parsed.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes("[resume-panel:HIGH]"), "should have HIGH tag");
  assert.ok(ctx.includes("WebSocket"), "should include finding message");
  console.log("PASS: HIGH finding routed immediately");

  // 확인: findings.json에 delivered: true로 저장됨
  const findings = JSON.parse(readFileSync(join(testFindingsBase, ".resume-panel", "findings.json"), "utf-8"));
  assert.ok(findings.findings[0].delivered, "should be marked delivered");
  console.log("PASS: finding marked as delivered");

  // 확인: inbox 삭제됨
  assert.ok(!existsSync(join(testFindingsBase, ".resume-panel", "findings-inbox.jsonl")), "inbox should be removed");
  assert.ok(!existsSync(join(testFindingsBase, ".resume-panel", "findings-inbox.processing.jsonl")), "processing file should be removed");
  console.log("PASS: inbox cleaned up");

  rmSync(testFindingsBase, { recursive: true, force: true });
}

// Test 7: LOW finding → skip (additionalContext에 포함하지 않음)
{
  const testLowBase = "/tmp/test-resume-panel-low";
  rmSync(testLowBase, { recursive: true, force: true });
  mkdirSync(join(testLowBase, ".resume-panel"), { recursive: true });

  writeFileSync(join(testLowBase, ".resume-panel", "snapshot.json"), JSON.stringify({
    episode_count: 5, project_names: ["A"], meta_hash: "abc",
  }));

  const finding = {
    id: "f-002",
    urgency: "LOW",
    source: "recruiter",
    type: "improvement",
    message: "사소한 키워드 추가 권장.",
    context: {},
    created_at: new Date().toISOString(),
  };
  writeFileSync(
    join(testLowBase, ".resume-panel", "findings-inbox.jsonl"),
    JSON.stringify(finding) + "\n"
  );

  const result = execFileSync("node", [script], {
    input: JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/work/something.txt", content: "x" },
    }),
    encoding: "utf-8",
    env: { ...process.env, RESUME_PANEL_BASE: testLowBase },
  });

  const parsed = result.trim() ? JSON.parse(result.trim()) : null;
  assert.strictEqual(parsed, null, "LOW finding should not produce output");
  console.log("PASS: LOW finding skipped");

  rmSync(testLowBase, { recursive: true, force: true });
}

console.log("\nAll findings routing tests passed.");
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs`
Expected: Test 6, 7 FAIL (findings routing not implemented yet)

- [ ] **Step 3: findings 라우팅 로직 구현**

episode-watcher.mjs에서 `// 역할 2: findings 라우팅` 주석 부분을 다음으로 교체:

```js
// 역할 2: findings 라우팅
const inboxPath = join(stateDir, "findings-inbox.jsonl");
const processingPath = join(stateDir, "findings-inbox.processing.jsonl");
const findingsPath = join(stateDir, "findings.json");

if (existsSync(inboxPath)) {
  // 원자적으로 inbox 가져오기
  try {
    renameSync(inboxPath, processingPath);
  } catch {
    // rename 실패 시 (다른 프로세스가 먼저 가져감) → 건너뜀
  }

  if (existsSync(processingPath)) {
    const raw = readFileSync(processingPath, "utf-8").trim();
    const lines = raw.split("\n").filter(Boolean);
    const newFindings = lines.map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

    // 기존 findings.json 로드
    const existing = readJSON(findingsPath) || { findings: [] };

    // 프로젝트 전환 감지 (MEDIUM 라우팅용)
    const snapshot = readJSON(snapshotPath);
    const meta = readJSON(metaPath);
    const companyChanged = meta && snapshot &&
      meta.current_company && meta.current_company !== (snapshot.current_company || "");

    for (const finding of newFindings) {
      finding.delivered = false;

      if (finding.urgency === "HIGH") {
        messages.push(`[resume-panel:HIGH] ${finding.message}`);
        finding.delivered = true;
      } else if (finding.urgency === "MEDIUM" && companyChanged) {
        messages.push(`[resume-panel:MEDIUM] ${finding.message}`);
        finding.delivered = true;
      }
      // LOW: skip — 오케스트레이터가 필요 시 직접 findings.json을 Read

      existing.findings.push(finding);
    }

    // findings.json 저장
    ensureStateDir();
    writeFileSync(findingsPath, JSON.stringify(existing, null, 2));

    // processing 파일 삭제
    try { unlinkSync(processingPath); } catch {}
  }
}
```

추가 import: `renameSync`, `unlinkSync` (최상단 import에 추가)

- [ ] **Step 4: 테스트 실행 — 통과 확인**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs`
Expected: All tests pass (Test 1~7).

- [ ] **Step 5: 커밋**

```bash
git add plugins/resume/scripts/episode-watcher.mjs plugins/resume/scripts/test-episode-watcher.mjs
git commit -m "feat(resume): implement findings routing in episode-watcher"
```

---

### Task 5: SKILL.md에 additionalContext 처리 규칙 추가

**Files:**
- Modify: `plugins/resume/skills/resume-panel/SKILL.md`

- [ ] **Step 1: SKILL.md 끝에 다음 섹션 추가**

`## 저장` 섹션 앞에 다음을 삽입:

```markdown
## 자율 오케스트레이션 — Hook 메시지 처리

PostToolUse hook(episode-watcher.mjs)이 `additionalContext`를 통해 메시지를 보내면, 아래 규칙에 따라 처리한다.

### 메시지 처리 규칙

1. **`[resume-panel] 프로파일러 호출 필요`** → 프로파일러를 백그라운드 Agent로 즉시 호출
   ```
   Agent(
     prompt: "[delta 정보] + resume-source.json 전체 + 타겟 JD"
     run_in_background: true
   )
   ```
   호출 후 인터뷰를 중단하지 않고 계속 진행한다.

2. **`[resume-panel:HIGH]`** → 현재 질문-답변 사이클 완료 후 유저에게 전달
   - "아 그리고 방금 분석 결과가 나왔는데 — {내용}"
   - 전달 후 바로 다음 인터뷰 질문으로 복귀

3. **`[resume-panel:MEDIUM]`** → 현재 프로젝트/회사 에피소드 수집이 끝나면 전달
   - "여기까지 정리하면서 리뷰 결과도 같이 볼게 — {내용}"

4. **LOW** — hook에서 전달하지 않음. 유저가 "분석해줘", "리뷰해줘" 요청 시 `.resume-panel/findings.json`을 Read해서 전달

### 인터뷰 흐름 보호

- HIGH 피드백이 와도 **현재 진행 중인 질문-답변 사이클은 완료**한 후 끼워넣기
- MEDIUM/LOW 피드백 때문에 인터뷰를 중단하지 않음
- 피드백 전달 후 바로 다음 인터뷰 질문으로 복귀
```

- [ ] **Step 2: 커밋**

```bash
git add plugins/resume/skills/resume-panel/SKILL.md
git commit -m "feat(resume): add hook message handling rules to SKILL.md"
```

---

### Task 6: 프로파일러 에이전트 수정 — findings-inbox.jsonl 쓰기

**Files:**
- Modify: `plugins/resume/.claude/agents/profiler.md`

- [ ] **Step 1: profiler.md에 findings 산출 지시 추가**

`## 금지사항` 섹션 앞에 다음 섹션을 삽입:

```markdown
## 자율 오케스트레이션 모드

hook에 의해 백그라운드 Agent로 호출될 때, 기존 프로파일 산출 외에 추가로 다음을 수행한다.

### 1. 전문 에이전트 디스패치

분석 결과에 따라 필요한 전문 에이전트를 Agent tool로 호출:
- 타겟 JD 핵심 갭 발견 → 채용담당자
- 기술 깊이 부족 → 시니어 개발자 / CTO
- 소프트스킬/리더십 부족 → 인사담당자
- 회사 정보 부족 → 리서처

### 2. findings-inbox.jsonl에 결과 기록

전문 에이전트 결과를 종합하여 `.resume-panel/findings-inbox.jsonl`에 **append**한다. **findings.json을 직접 수정하지 않는다.**

각 라인은 독립된 JSON 객체:

```json
{"id":"f-001","urgency":"HIGH","source":"recruiter","type":"gap_detected","message":"WebSocket 실시간 경험 완전 공백. AX 팀 핵심 갭.","context":{"related_episodes":[],"target_requirement":"실시간 데이터 처리"},"created_at":"2026-04-03T15:30:00Z"}
```

append 방법 (Bash tool):
```bash
echo '{"id":"f-001","urgency":"HIGH",...}' >> .resume-panel/findings-inbox.jsonl
```

### 3. meta.json 갱신

분석 완료 후 `.resume-panel/meta.json`을 갱신:
```bash
cat <<'EOF' > .resume-panel/meta.json
{
  "last_profiler_call": "2026-04-03T15:25:00Z",
  "last_profiler_episode_count": 12,
  "current_company": "튜닙",
  "total_profiler_calls": 3
}
EOF
```

### 긴급도 판단 기준

| urgency | 기준 |
|---------|------|
| HIGH | 타겟 JD 핵심 요구사항과 직결되는 갭 / 치명적 프레이밍 오류 / "이력서에서 빼야 할 것" |
| MEDIUM | 특정 카테고리 에피소드 부족 / STAR 수치 보강 필요 / 에피소드 등급 C |
| LOW | 사소한 표현 개선 / 추가하면 좋을 키워드 / 선택적 보강 |
```

- [ ] **Step 2: 커밋**

```bash
git add plugins/resume/.claude/agents/profiler.md
git commit -m "feat(resume): add autonomous orchestration mode to profiler agent"
```

---

### Task 7: episode-watcher.mjs 통합 — 전체 파일 정리

**Files:**
- Modify: `plugins/resume/scripts/episode-watcher.mjs` (최종 정리)

이전 Task 2~4에서 점진적으로 구현한 코드를 하나의 정리된 파일로 통합한다. 아래가 최종 episode-watcher.mjs 전체:

- [ ] **Step 1: episode-watcher.mjs 전체를 아래로 교체**

```js
#!/usr/bin/env node
// episode-watcher.mjs — PostToolUse hook for resume-panel
//
// 역할 1: resume-source.json 변경 감지 → 프로파일러 호출 판단
// 역할 2: findings-inbox.jsonl 소비 → 긴급도별 라우팅
//
// 출력: JSON → hookSpecificOutput.additionalContext로 오케스트레이터에 주입
// 환경변수: RESUME_PANEL_BASE (테스트용, 없으면 input.cwd 사용)

import {
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

// ── stdin ────────────────────────────────────────────
let input;
try {
  input = JSON.parse(readFileSync("/dev/stdin", "utf-8"));
} catch {
  process.exit(0);
}

const toolName = input.tool_name;
const toolInput = input.tool_input || {};

// ── 파일 경로 추출 ──────────────────────────────────
let targetPath = "";
if (toolName === "Write" || toolName === "Edit") {
  targetPath = toolInput.file_path || "";
} else if (toolName === "Bash") {
  targetPath = (toolInput.command || "").includes("resume-source.json")
    ? "resume-source.json"
    : "";
}

// ── self-trigger 방지 ───────────────────────────────
if (targetPath.includes(".resume-panel/") || targetPath.includes(".resume-panel\\")) {
  process.exit(0);
}

// ── 경로 설정 ───────────────────────────────────────
const base = process.env.RESUME_PANEL_BASE || input.cwd || process.cwd();
const stateDir = join(base, ".resume-panel");
const snapshotPath = join(stateDir, "snapshot.json");
const metaPath = join(stateDir, "meta.json");
const resumeSourcePath = join(base, "resume-source.json");
const inboxPath = join(stateDir, "findings-inbox.jsonl");
const processingPath = join(stateDir, "findings-inbox.processing.jsonl");
const findingsPath = join(stateDir, "findings.json");

const isResumeSourceChange = targetPath.includes("resume-source.json");
const messages = [];

// ── 유틸 ────────────────────────────────────────────
function ensureStateDir() {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
}

function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function countEpisodes(source) {
  let n = 0;
  for (const c of source.companies || [])
    for (const p of c.projects || []) n += (p.episodes || []).length;
  return n;
}

function getProjectNames(source) {
  const names = [];
  for (const c of source.companies || [])
    for (const p of c.projects || []) if (p.name) names.push(p.name);
  return names.sort();
}

function hashMeta(source) {
  const m = source.meta || {};
  return createHash("md5")
    .update(`${m.target_company}|${m.target_position}`)
    .digest("hex")
    .slice(0, 8);
}

function countStarGaps(source) {
  let gaps = 0;
  for (const c of source.companies || [])
    for (const p of c.projects || [])
      for (const ep of p.episodes || [])
        if (!ep.situation || !ep.task || !ep.action || !ep.result) gaps++;
  return gaps;
}

// ── 역할 1: delta 감지 ──────────────────────────────
if (isResumeSourceChange) {
  const source = readJSON(resumeSourcePath);
  if (source) {
    const snapshot = readJSON(snapshotPath);
    const cur = {
      episode_count: countEpisodes(source),
      project_names: getProjectNames(source),
      meta_hash: hashMeta(source),
    };

    if (!snapshot) {
      // 첫 실행: 스냅샷 저장만
      ensureStateDir();
      writeFileSync(snapshotPath, JSON.stringify(cur));
    } else {
      let shouldTrigger = false;
      const reasons = [];

      // 임계치 1: 에피소드 +3
      const delta = cur.episode_count - (snapshot.episode_count || 0);
      if (delta >= 3) {
        shouldTrigger = true;
        reasons.push(`에피소드 +${delta}`);
      }

      // 임계치 2: 새 프로젝트
      const newProjects = cur.project_names.filter(
        (p) => !(snapshot.project_names || []).includes(p)
      );
      if (newProjects.length > 0) {
        shouldTrigger = true;
        reasons.push(`새 프로젝트: ${newProjects.join(", ")}`);
      }

      // 임계치 3: meta 변경
      if (cur.meta_hash !== (snapshot.meta_hash || "")) {
        shouldTrigger = true;
        reasons.push("타겟 변경");
      }

      // 임계치 4: 절대 쿨다운
      const meta = readJSON(metaPath);
      if (meta?.last_profiler_episode_count != null) {
        if (cur.episode_count - meta.last_profiler_episode_count >= 5) {
          shouldTrigger = true;
          reasons.push(
            `쿨다운 초과 (마지막 프로파일러 이후 +${cur.episode_count - meta.last_profiler_episode_count})`
          );
        }
      }

      if (shouldTrigger) {
        ensureStateDir();
        writeFileSync(snapshotPath, JSON.stringify(cur));
        messages.push(
          `[resume-panel] 프로파일러 호출 필요. delta: ${reasons.join(", ")}. ` +
            `현재 총 에피소드 ${cur.episode_count}개, 빈 STAR ${countStarGaps(source)}개, 프로젝트 ${cur.project_names.length}개.`
        );
      }
    }
  }
}

// ── 역할 2: findings 라우팅 ─────────────────────────
if (existsSync(inboxPath)) {
  try {
    renameSync(inboxPath, processingPath);
  } catch {
    // 다른 프로세스가 먼저 가져감 → skip
  }

  if (existsSync(processingPath)) {
    const lines = readFileSync(processingPath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean);
    const newFindings = lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);

    const existing = readJSON(findingsPath) || { findings: [] };
    const meta = readJSON(metaPath);
    const snapshot = readJSON(snapshotPath);

    // 프로젝트 전환 감지 (MEDIUM 라우팅용)
    const companyChanged =
      meta?.current_company &&
      snapshot?.current_company &&
      meta.current_company !== snapshot.current_company;

    for (const f of newFindings) {
      f.delivered = false;

      if (f.urgency === "HIGH") {
        messages.push(`[resume-panel:HIGH] ${f.message}`);
        f.delivered = true;
      } else if (f.urgency === "MEDIUM" && companyChanged) {
        messages.push(`[resume-panel:MEDIUM] ${f.message}`);
        f.delivered = true;
      }

      existing.findings.push(f);
    }

    ensureStateDir();
    writeFileSync(findingsPath, JSON.stringify(existing, null, 2));
    try { unlinkSync(processingPath); } catch {}
  }
}

// ── 출력 ────────────────────────────────────────────
if (messages.length > 0) {
  process.stdout.write(
    JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: messages.join("\n\n"),
      },
    })
  );
}
```

- [ ] **Step 2: 전체 테스트 실행**

Run: `node plugins/resume/scripts/test-episode-watcher.mjs`
Expected: All tests pass.

- [ ] **Step 3: 커밋**

```bash
git add plugins/resume/scripts/episode-watcher.mjs
git commit -m "refactor(resume): consolidate episode-watcher into final form"
```

---

### Task 8: .resume-panel/ 상태 파일 초기화 — SKILL.md 보강

**Files:**
- Modify: `plugins/resume/skills/resume-panel/SKILL.md`

- [ ] **Step 1: 라운드 0의 "5. 초기 저장" 단계에 .resume-panel 초기화 추가**

SKILL.md의 라운드 0 섹션, `resume-source.json`을 Bash tool로 생성하는 부분 바로 아래에 추가:

```markdown
**6. 상태 디렉토리 초기화**

resume-source.json 첫 생성 직후, `.resume-panel/` 디렉토리를 초기화한다:

```bash
mkdir -p .resume-panel
cat <<'EOF' > .resume-panel/meta.json
{
  "last_profiler_call": null,
  "last_profiler_episode_count": 0,
  "current_company": null,
  "total_profiler_calls": 0
}
EOF
```

snapshot.json은 episode-watcher hook이 첫 실행 시 자동 생성하므로 수동 초기화 불필요.
```

- [ ] **Step 2: 커밋**

```bash
git add plugins/resume/skills/resume-panel/SKILL.md
git commit -m "feat(resume): add .resume-panel state dir initialization to round 0"
```

---

## 완료 후 수동 검증

모든 Task 완료 후, 실제 resume-panel 세션에서 다음을 확인:

1. resume-source.json에 에피소드 3개 이상 추가 시 `[resume-panel] 프로파일러 호출 필요` 메시지가 additionalContext로 들어오는지
2. 프로파일러가 findings-inbox.jsonl에 쓴 HIGH 항목이 다음 hook 실행 시 `[resume-panel:HIGH]` 로 전달되는지
3. .resume-panel/ 상태 파일들이 올바르게 생성/갱신되는지
4. self-trigger가 발생하지 않는지 (.resume-panel/ 내부 파일 쓰기 시 hook이 무시하는지)
