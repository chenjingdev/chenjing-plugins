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

function getAllProjects(source) {
  const projects = [];
  for (const company of source.companies || []) {
    for (const project of company.projects || []) {
      projects.push({ ...project, companyName: company.name });
    }
  }
  return projects;
}

function countEpisodes(source) {
  let count = 0;
  for (const p of getAllProjects(source)) {
    count += (p.episodes || []).length;
  }
  return count;
}

function getProjectNames(source) {
  return getAllProjects(source).map(p => p.name).filter(Boolean).sort();
}

function hashMeta(source) {
  const meta = source.meta || {};
  const str = `${meta.target_company || ""}|${meta.target_position || ""}`;
  return createHash("md5").update(str).digest("hex").slice(0, 8);
}

function countStarGaps(source) {
  let gaps = 0;
  for (const p of getAllProjects(source)) {
    for (const ep of p.episodes || []) {
      const star = ep.star || {};
      const situation = star.situation || ep.situation;
      const task = star.task || ep.task;
      const action = star.action || ep.action;
      const result = star.result || ep.result;
      if (!situation || !task || !action || !result) gaps++;
    }
  }
  return gaps;
}

function detectMinimization(source, snapshot) {
  const MINIMIZATION_KEYWORDS = ["도움", "참여", "지원", "보조", "서포트"];
  const prevCount = snapshot.episode_count || 0;
  let found = false;
  let checked = 0;
  for (const p of getAllProjects(source)) {
    for (const ep of p.episodes || []) {
      checked++;
      if (checked <= prevCount) continue; // skip already-seen episodes
      const text = `${ep.star?.action || ep.action || ""} ${ep.star?.result || ep.result || ""}`;
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

function toMonths(d) { return d.year * 12 + d.month; }

function detectGaps(source) {
  const gaps = [];
  const allProjects = getAllProjects(source);
  const spans = allProjects
    .map(p => {
      const parsed = parsePeriod(p.period);
      if (!parsed) return null;
      return { ...parsed, company: p.companyName, project: p.name };
    })
    .filter(Boolean)
    .sort((a, b) => toMonths(a.start) - toMonths(b.start));

  for (let i = 0; i < spans.length - 1; i++) {
    const curr = spans[i];
    const next = spans[i + 1];
    const gapMo = toMonths(next.start) - toMonths(curr.end);
    const sameCompany = curr.company === next.company;
    const threshold = sameCompany ? 3 : 6;
    if (gapMo > threshold) {
      gaps.push({
        from: { company: curr.company, project: curr.project, end: curr.end },
        to: { company: next.company, project: next.project, start: next.start },
        months: gapMo,
        type: sameCompany ? "intra_company" : "inter_company",
      });
    }
  }
  return gaps;
}

function getCompanyCount(source) {
  return (source.companies || []).length;
}

function emit(payload) {
  return `[resume-panel]${JSON.stringify(payload)}`;
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
      let updatedMetaFields = {};
      if (score >= THRESHOLD) {
        const starGaps = countStarGaps(source);
        const companyCount = getCompanyCount(source);
        const patternEligible = currentCount >= 3 && companyCount >= 2;
        messages.push(
          emit({
            type: "profiler_trigger",
            delta: reasons.join(", "),
            score,
            episode_count: currentCount,
            star_gaps: starGaps,
            project_count: currentProjects.length,
            pattern_eligible: patternEligible,
          })
        );

        // Timeline gap detection -- deterministic, runs with profiler trigger
        const metaForTimeline = readJSON(metaPath) || {};
        const intentionalGaps = metaForTimeline.intentional_gaps || [];
        const gaps = detectGaps(source);
        for (const gap of gaps) {
          // Skip intentional gaps
          const fromEnd = `${gap.from.end.year}.${String(gap.from.end.month).padStart(2, "0")}`;
          const toStart = `${gap.to.start.year}.${String(gap.to.start.month).padStart(2, "0")}`;
          const isIntentional = intentionalGaps.some(ig =>
            ig.from === fromEnd && ig.to === toStart
          );
          if (isIntentional) continue;

          const finding = {
            id: `tg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            type: "timeline_gap_found",
            urgency: "MEDIUM",
            source: "episode-watcher",
            message: `${fromEnd} ~ ${toStart} (${gap.months}개월) 공백: ${gap.from.project}(${gap.from.company}) 종료 후 ${gap.to.project}(${gap.to.company}) 시작 전`,
            context: {
              from_company: gap.from.company,
              from_project: gap.from.project,
              to_company: gap.to.company,
              to_project: gap.to.project,
              gap_months: gap.months,
              gap_type: gap.type,
            },
            created_at: new Date().toISOString(),
          };
          ensureStateDir();
          const line = JSON.stringify(finding) + "\n";
          writeFileSync(inboxPath, existsSync(inboxPath) ? readFileSync(inboxPath, "utf-8") + line : line);
        }

        // Pattern eligibility tracking (flag already in JSON payload above)
        const companyCountForMeta = getCompanyCount(source);
        if (currentCount >= 3 && companyCountForMeta >= 2) {
          updatedMetaFields.last_pattern_analysis_episode_count = currentCount;
          updatedMetaFields.last_timeline_check = new Date().toISOString();
        }

        score = 0; // 트리거 후 리셋
      }

      // So What chain trigger — check for impact-shallow episodes
      const metaForSoWhat = readJSON(metaPath) || {};
      if (!metaForSoWhat.so_what_active?.active) {
        const prevCount = snapshot.episode_count || 0;
        let checked = 0;
        for (const project of getAllProjects(source)) {
          for (const ep of project.episodes || []) {
            checked++;
            if (checked <= prevCount) continue;
            if (!hasQuantifiedImpact(ep.star?.result || ep.result || "")) {
              messages.push(
                emit({
                  type: "so_what",
                  episode_title: ep.title || "(제목 없음)",
                  level: 1,
                  episode_ref: { company: project.companyName, project: project.name },
                })
              );
              break;
            }
          }
          if (messages.some(m => m.includes('"type":"so_what"'))) break;
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
        ...updatedMetaFields,
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
        messages.push(
          emit({
            type: "finding",
            urgency: "HIGH",
            finding_type: f.type,
            id: f.id,
            message: f.message,
            context: f.context || {},
          })
        );
        f.delivered = true;
      } else if (f.urgency === "MEDIUM" && companyChanged) {
        messages.push(
          emit({
            type: "finding",
            urgency: "MEDIUM",
            finding_type: f.type,
            id: f.id,
            message: f.message,
            context: f.context || {},
          })
        );
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
