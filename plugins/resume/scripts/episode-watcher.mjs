#!/usr/bin/env node
// episode-watcher.mjs — PostToolUse hook for resume-panel
//
// 역할 1: resume-source.json 변경 감지 → 프로파일러 호출 판단
// 역할 2: findings-inbox.jsonl 소비 → 긴급도별 라우팅
//
// 출력: JSON → hookSpecificOutput.additionalContext로 오케스트레이터에 주입
// 환경변수: RESUME_PANEL_BASE (테스트용, 없으면 input.cwd 사용)

import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
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

// ── resume-source.json 변경 여부 ────────────────────
const isResumeSourceChange = targetPath.includes("resume-source.json");

// ── 경로 상수 ────────────────────────────────────────
const base = process.env.RESUME_PANEL_BASE || input.cwd || process.cwd();
const stateDir = join(base, ".resume-panel");
const snapshotPath = join(stateDir, "snapshot.json");
const metaPath = join(stateDir, "meta.json");
const sourcePath = join(base, "resume-source.json");
const inboxPath = join(stateDir, "findings-inbox.jsonl");
const processingPath = join(stateDir, "findings-inbox.processing.jsonl");
const findingsPath = join(stateDir, "findings.json");

// ── 헬퍼 함수 ────────────────────────────────────────
function ensureStateDir() {
  mkdirSync(stateDir, { recursive: true });
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
  const str = `${meta.target_company || ""}|${meta.target_position || ""}`;
  return createHash("md5").update(str).digest("hex").slice(0, 8);
}

function countStarGaps(source) {
  let gaps = 0;
  for (const company of source.companies || []) {
    for (const project of company.projects || []) {
      for (const ep of project.episodes || []) {
        const missing =
          !ep.situation || !ep.task || !ep.action || !ep.result;
        if (missing) gaps++;
      }
    }
  }
  return gaps;
}

// ── 메시지 수집 ─────────────────────────────────────
const messages = [];

// 역할 1: delta 감지 (isResumeSourceChange일 때)
if (isResumeSourceChange) {
  const source = readJSON(sourcePath);
  if (source) {
    const snapshot = readJSON(snapshotPath);
    const currentCount = countEpisodes(source);
    const currentProjects = getProjectNames(source);
    const currentHash = hashMeta(source);

    ensureStateDir();

    if (!snapshot) {
      // 첫 실행: 스냅샷만 저장, 트리거 안 함
      const metaJSON = readJSON(metaPath);
      writeFileSync(
        snapshotPath,
        JSON.stringify({
          episode_count: currentCount,
          project_names: currentProjects,
          meta_hash: currentHash,
          current_company: metaJSON?.current_company || null,
        })
      );
    } else {
      // delta 계산
      const reasons = [];
      const episodeDelta = currentCount - (snapshot.episode_count || 0);
      if (episodeDelta >= 3) reasons.push(`에피소드 +${episodeDelta}`);

      const snapshotProjects = new Set(snapshot.project_names || []);
      const hasNewProject = currentProjects.some((p) => !snapshotProjects.has(p));
      if (hasNewProject) reasons.push("새 프로젝트");

      if (currentHash !== snapshot.meta_hash) reasons.push("meta 변경");

      const metaJSON = readJSON(metaPath);
      const lastProfilerCount = metaJSON?.last_profiler_episode_count ?? null;
      if (lastProfilerCount !== null && currentCount - lastProfilerCount >= 5) {
        reasons.push("쿨다운 초과");
      }

      if (reasons.length > 0) {
        const starGaps = countStarGaps(source);
        messages.push(
          `[resume-panel] 프로파일러 호출 필요. delta: ${reasons.join(", ")}. 현재 총 에피소드 ${currentCount}개, 빈 STAR ${starGaps}개, 프로젝트 ${currentProjects.length}개.`
        );
        // 스냅샷 업데이트
        writeFileSync(
          snapshotPath,
          JSON.stringify({
            episode_count: currentCount,
            project_names: currentProjects,
            meta_hash: currentHash,
            current_company: metaJSON?.current_company || null,
          })
        );
      }
    }
  }
}

// 역할 2: findings 라우팅
if (existsSync(inboxPath)) {
  try {
    renameSync(inboxPath, processingPath);
  } catch {
    // rename 실패 시 skip
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

    // 프로젝트 전환 감지: 프로파일러가 meta.json에 쓴 current_company vs 스냅샷의 current_company
    const companyChanged =
      meta?.current_company &&
      meta.current_company !== (snapshot?.current_company || null);

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

    // 스냅샷에 current_company 동기화 (MEDIUM 라우팅 후 다음 비교를 위해)
    if (companyChanged && snapshot) {
      const updated = { ...snapshot, current_company: meta.current_company };
      writeFileSync(snapshotPath, JSON.stringify(updated));
    }
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
