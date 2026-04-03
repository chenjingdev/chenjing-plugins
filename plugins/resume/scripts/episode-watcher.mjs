#!/usr/bin/env node
// episode-watcher.mjs — PostToolUse hook for resume-panel
//
// 역할 1: resume-source.json 변경 감지 → 프로파일러 호출 판단
// 역할 2: findings-inbox.jsonl 소비 → 긴급도별 라우팅
//
// 출력: JSON → hookSpecificOutput.additionalContext로 오케스트레이터에 주입
// 환경변수: RESUME_PANEL_BASE (테스트용, 없으면 input.cwd 사용)

import { readFileSync } from "node:fs";

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

// ── resume-source.json 변경 여부 ────────────────────
const isResumeSourceChange = targetPath.includes("resume-source.json");

// ── 메시지 수집 ─────────────────────────────────────
const messages = [];

// 역할 1: delta 감지 (isResumeSourceChange일 때)
// → Task 3에서 구현

// 역할 2: findings 라우팅 (매 호출마다)
// → Task 4에서 구현

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
