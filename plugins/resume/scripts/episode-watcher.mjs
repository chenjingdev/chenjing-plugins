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
  const cmd = toolInput.command || "";
  if (cmd.includes("resume-source.json")) {
    targetPath = "resume-source.json";
  } else if (cmd.includes(".resume-panel/") || cmd.includes(".resume-panel\\")) {
    targetPath = ".resume-panel/";
  }
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
  for (const project of source.projects || []) {
    count += (project.episodes || []).length;
  }
  return count;
}

function getProjectNames(source) {
  const names = [];
  for (const project of source.projects || []) {
    if (project.name) names.push(project.name);
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
  for (const project of source.projects || []) {
    for (const ep of project.episodes || []) {
      const star = ep.star || {};
      const missing =
        !star.situation || !star.task || !star.action || !star.result;
      if (missing) gaps++;
    }
  }
  return gaps;
}

function detectMinimization(source, snapshot) {
  const MINIMIZATION_KEYWORDS = ["도움", "참여", "지원", "보조", "서포트"];
  const prevCount = snapshot.episode_count || 0;
  let found = false;
  let checked = 0;
  for (const project of source.projects || []) {
    for (const ep of project.episodes || []) {
      checked++;
      if (checked <= prevCount) continue; // skip already-seen episodes
      const text = `${ep.star?.action || ""} ${ep.star?.result || ""}`;
      if (MINIMIZATION_KEYWORDS.some(kw => text.includes(kw))) {
        found = true;
        break;
      }
    }
    if (found) break;
  }
  return found;
}

function hasQuantifiedImpact(resultText) {
  if (!resultText || resultText.trim() === "") return false;
  const IMPACT_PATTERN = /\d+(\.\d+)?\s*(명|건|%|원|만|억|배|시간|분|초|ms|개월|일|주|달|회|번|개|위|등|톤|km|kg|L|대|편|권|통|점|곳|팀)/;
  return IMPACT_PATTERN.test(resultText);
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
      // 첫 실행: 스냅샷 저장 + profiler_score 초기화, 트리거 안 함
      const metaJSON = readJSON(metaPath) || {};
      writeFileSync(
        snapshotPath,
        JSON.stringify({
          episode_count: currentCount,
          project_names: currentProjects,
          meta_hash: currentHash,
          star_gaps: countStarGaps(source),
          current_company: metaJSON?.current_company || null,
        })
      );
      if (!metaJSON.profiler_score && metaJSON.profiler_score !== 0) {
        writeFileSync(metaPath, JSON.stringify({
          ...metaJSON,
          profiler_score: 0,
        }, null, 2));
      }
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

      // 임계값 체크
      const THRESHOLD = 5;
      if (score >= THRESHOLD) {
        const starGaps = countStarGaps(source);
        messages.push(
          `[resume-panel] 프로파일러 호출 필요. delta: ${reasons.join(", ")}. 현재 총 에피소드 ${currentCount}개, 빈 STAR ${starGaps}개, 프로젝트 ${currentProjects.length}개. (score: ${score})`
        );
        score = 0; // 트리거 후 리셋
      }

      // So What chain trigger — check for impact-shallow episodes
      const metaForSoWhat = readJSON(metaPath) || {};
      if (!metaForSoWhat.so_what_active?.active) {
        const prevCount = snapshot.episode_count || 0;
        let checked = 0;
        for (const project of source.projects || []) {
          for (const ep of project.episodes || []) {
            checked++;
            if (checked <= prevCount) continue;
            if (!hasQuantifiedImpact(ep.star?.result || ep.result || "")) {
              messages.push(
                `[resume-panel:SO-WHAT] 에피소드 "${ep.title || "(제목 없음)"}" 임팩트 부족`
              );
              break;
            }
          }
          if (messages.some(m => m.includes("[resume-panel:SO-WHAT]"))) break;
        }
      }

      // 스냅샷 업데이트 (항상)
      writeFileSync(
        snapshotPath,
        JSON.stringify({
          episode_count: currentCount,
          project_names: currentProjects,
          meta_hash: currentHash,
          star_gaps: countStarGaps(source),
          current_company: metaJSON?.current_company || null,
        })
      );

      // meta.json에 점수 저장 (항상)
      writeFileSync(metaPath, JSON.stringify({
        ...metaJSON,
        profiler_score: score,
      }, null, 2));
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
