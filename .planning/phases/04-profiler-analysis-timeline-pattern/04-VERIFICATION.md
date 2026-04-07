---
phase: 04-profiler-analysis-timeline-pattern
verified: 2026-04-08T12:00:00Z
status: human_needed
score: 4/4
overrides_applied: 0
human_verification:
  - test: "Create a resume-source.json with companies that have timeline gaps >6 months between them, trigger profiler threshold (5+ score), and verify the gap probing question appears via HR agent with a skip option"
    expected: "HR agent should generate a gap probing question with 2 substantive options and a skip option. Selecting skip should add the gap to intentional_gaps in meta.json. The gap should not be re-probed on subsequent triggers."
    why_human: "Full end-to-end orchestration flow requires Claude Code runtime with SKILL.md orchestrator, Agent tool, and AskUserQuestion tool interaction"
  - test: "Trigger profiler with 3+ episodes across 2+ companies and verify pattern analysis executes, producing pattern_detected finding that appears in Conversation Briefing"
    expected: "Profiler should detect cross-company patterns using the 4-category framework, write pattern_detected finding to findings-inbox.jsonl, and the orchestrator should include the pattern in Conversation Briefing with target_agent routing"
    why_human: "Pattern analysis is LLM-based semantic comparison in profiler.md prompt; cannot verify output quality without actual profiler execution"
---

# Phase 4: Profiler Analysis (Timeline + Pattern) Verification Report

**Phase Goal:** 프로파일러가 경력 타임라인 갭을 자동 탐지하고 크로스 컴퍼니 행동 패턴을 발견하여 숨은 에피소드 발굴을 유도한다
**Verified:** 2026-04-08T12:00:00Z
**Status:** human_needed
**Re-verification:** No -- initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | resume-source.json의 회사/프로젝트 기간 데이터로 전체 타임라인이 구성되고, 3개월 이상 빈 구간이 자동 탐지된다 | VERIFIED | `parsePeriod()` (line 136), `detectGaps()` (line 151) with inter-company >6mo and intra-company >3mo thresholds in episode-watcher.mjs. Data structure migrated to canonical `companies[].projects[]` via `getAllProjects()` (line 69). 53 tests passing including 6 gap detection tests and 11 timeline parsing tests. |
| 2 | 탐지된 갭에 대해 프로빙 질문이 생성되며, 민감한 공백기에는 "건너뛰기" 옵션이 제공된다 | VERIFIED | hr.md has full gap probing mode section (line 79) with inter/intra company question patterns, mandatory "이 기간은 건너뛰기" as last option (line 106/114), opportunity framing rule (line 93). SKILL.md item 6 (line 471) routes timeline_gap_found to HR agent in gap probing mode with intentional_gaps tracking and 3-gap session limit. |
| 3 | 에피소드 3개 이상 수집 시 크로스 컴퍼니 패턴 분석이 실행되어 반복 행동 패턴이 가설로 제시된다 | VERIFIED | episode-watcher.mjs pattern eligibility guard (line 304): `currentCount >= 3 && companyCount >= 2` appends "패턴 분석 가능" to profiler message. profiler.md has 4-category pattern analysis framework (line 91-124) with structured JSON output format (`pattern_detected` type), minimum evidence criteria (2+ episodes, 2+ companies), and target_agent routing. 3 pattern eligibility tests pass. |
| 4 | 패턴 및 타임라인 분석 결과가 findings-inbox.jsonl을 통해 Conversation Briefing에 포함되어 후속 에이전트에 전달된다 | VERIFIED | episode-watcher.mjs writes timeline_gap_found findings to inbox (line 298-299). profiler.md instructs appending pattern_detected findings to inbox (line 108). SKILL.md item 6 (line 471) routes gap findings to HR agent. SKILL.md item 7 (line 496) routes pattern findings to Conversation Briefing with "발견된 패턴" field and target_agent/suggested_question passthrough. |

**Score:** 4/4 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `plugins/resume/scripts/episode-watcher.mjs` | parsePeriod, getAllProjects, detectGaps, timeline trigger, pattern eligibility | VERIFIED | All 5 functions present (lines 69, 136, 149, 151, 181). timeline_gap_found emission (line 283). Pattern eligibility flag (line 306). No `source.projects ||` pattern remains -- fully migrated. |
| `plugins/resume/scripts/test-episode-watcher.mjs` | Timeline + pattern eligibility tests | VERIFIED | 53 tests pass. Includes 11 timeline parsing, 6 gap detection, 3 pattern eligibility tests. All test data uses `companies[].projects[]` schema. |
| `plugins/resume/.claude/agents/profiler.md` | Cross-company pattern analysis framework | VERIFIED | Section "2. 크로스 컴퍼니 패턴 분석" (line 91) with 4 categories, guard condition, pattern_detected output format, target_agent routing, prohibitions. Subsections renumbered: 1-4. |
| `plugins/resume/.claude/agents/hr.md` | Gap probing mode with skip option | VERIFIED | Section "갭 프로빙 모드" (line 79) with inter/intra company patterns, mandatory skip option (5 occurrences of "건너뛰기"), opportunity framing, prohibition against interrogation tone (line 129). |
| `plugins/resume/skills/resume-panel/SKILL.md` | timeline_gap_found + pattern_detected handlers + intentional_gap rules | VERIFIED | Item 6 (line 471): timeline_gap_found handler with HR routing, intentional_gaps tracking, 3-gap session limit. Item 7 (line 496): pattern_detected handler with Conversation Briefing integration, target_agent routing, suggested_question passthrough. Agent selection criteria updated (lines 167-168). Flow protection rules added (lines 524-526). |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| episode-watcher.mjs detectGaps() | findings-inbox.jsonl | writeFileSync append | WIRED | Line 298-299: `writeFileSync(inboxPath, ...)` with `timeline_gap_found` type finding JSON |
| episode-watcher.mjs profiler trigger | SKILL.md orchestrator | additionalContext message | WIRED | Lines 264-266: profiler trigger message pushed to messages array; line 306: "패턴 분석 가능" appended |
| profiler.md pattern analysis | findings-inbox.jsonl | Bash append | WIRED | Lines 108-111: explicit instructions to write `pattern_detected` findings via `echo ... >> .resume-panel/findings-inbox.jsonl` |
| hr.md gap probing | SKILL.md orchestrator | agent return text | WIRED | hr.md outputs `[인사담당자]` format (lines 101-115); SKILL.md item 6 (line 474) calls HR in gap probing mode and converts return to AskUserQuestion |
| SKILL.md timeline_gap_found handler | HR agent gap probing mode | Agent tool call | WIRED | Line 474-478: `Agent(prompt: "갭 프로빙 모드. ...")` |
| SKILL.md pattern_detected handler | Conversation Briefing | MEDIUM urgency routing | WIRED | Lines 498-505: pattern integrated into briefing with "발견된 패턴" field |
| SKILL.md skip handler | meta.json intentional_gaps | Bash write | WIRED | Lines 482-488: skip selection adds `{ "from", "to", "marked_at" }` to intentional_gaps array |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|--------------|--------|-------------------|--------|
| episode-watcher.mjs | gaps (detectGaps result) | parsePeriod on resume-source.json period fields | Yes -- deterministic date math on actual project periods | FLOWING |
| episode-watcher.mjs | timeline_gap_found finding | detectGaps() output | Yes -- structured JSON with real gap data (company, project, months) | FLOWING |
| episode-watcher.mjs | pattern eligibility flag | countEpisodes + getCompanyCount | Yes -- real counts from resume-source.json | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| All tests pass | `node plugins/resume/scripts/test-episode-watcher.mjs` | 53 PASS, 0 FAIL | PASS |
| parsePeriod handles edge cases | Covered in 7 unit tests | null/empty/invalid/현재/재직중 all handled | PASS |
| detectGaps applies correct thresholds | Covered in 4 integration tests | Inter >6mo and intra >3mo detected; sub-threshold ignored | PASS |
| Pattern eligibility guard | Covered in 3 integration tests | Only triggers with 3+ episodes AND 2+ companies | PASS |
| No source.projects pattern remains | `grep "source\.projects\s*\|\|" episode-watcher.mjs` returns 0 matches | Migration complete | PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-----------|-------------|--------|----------|
| TIME-01 | 04-01 | resume-source.json의 회사/프로젝트 기간 데이터로 타임라인 구성 | SATISFIED | parsePeriod(), getAllProjects(), detectGaps() in episode-watcher.mjs; data migrated to companies[].projects[] |
| TIME-02 | 04-01, 04-03 | 3개월 이상 빈 구간 자동 탐지 및 프로빙 질문 생성 | SATISFIED | detectGaps() with 3mo/6mo thresholds; SKILL.md item 6 routes to HR for probing |
| TIME-03 | 04-02, 04-03 | 민감한 공백기에 대해 "건너뛰기" 옵션 제공 | SATISFIED | hr.md mandatory "건너뛰기" option; SKILL.md skip handler with intentional_gaps tracking |
| PTRN-01 | 04-01, 04-02 | 에피소드 3개 이상 수집 시 크로스 컴퍼니 패턴 분석 실행 | SATISFIED | Pattern eligibility guard (3+ episodes, 2+ companies); profiler.md 4-category framework |
| PTRN-02 | 04-03 | 탐지된 패턴을 가설로 제시하여 숨은 에피소드 발굴 유도 | SATISFIED | SKILL.md item 7 routes pattern_detected to target_agent with suggested_question; profiler.md includes unexplored_company estimation |
| PTRN-03 | 04-03 | 패턴 결과가 Conversation Briefing에 포함되어 후속 에이전트에 전달 | SATISFIED | SKILL.md item 7 adds "발견된 패턴" to Conversation Briefing; target_agent routing for next agent selection |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | - | - | - | No TODO/FIXME/placeholder/stub patterns found in any phase 4 artifacts |

### Human Verification Required

### 1. End-to-End Gap Probing Flow

**Test:** Create a resume-source.json with companies that have timeline gaps >6 months between them, trigger profiler threshold (5+ score), and verify the gap probing question appears via HR agent with a skip option. Select skip and verify intentional_gap is tracked.
**Expected:** HR agent should generate a gap probing question with 2 substantive options + skip option. Selecting skip should add gap to intentional_gaps in meta.json. The gap should not be re-probed.
**Why human:** Full end-to-end orchestration flow requires Claude Code runtime with SKILL.md orchestrator, Agent tool, and AskUserQuestion tool interaction -- cannot simulate the multi-agent pipeline programmatically.

### 2. Pattern Analysis Quality

**Test:** Trigger profiler with 3+ episodes across 2+ companies and verify pattern analysis produces meaningful cross-company patterns with actionable suggested questions.
**Expected:** Profiler should detect behavioral patterns using 4-category framework, write pattern_detected findings with evidence_episodes and suggested_question, and the pattern should appear in Conversation Briefing for the next agent.
**Why human:** Pattern analysis is LLM-based semantic comparison in profiler.md prompt; output quality depends on actual profiler execution against real episode data.

### Gaps Summary

No gaps found. All 4 roadmap success criteria are met at the code level. All 6 requirements (TIME-01, TIME-02, TIME-03, PTRN-01, PTRN-02, PTRN-03) are satisfied. The full pipeline is wired: hook detection (episode-watcher.mjs) -> findings emission (findings-inbox.jsonl) -> orchestrator routing (SKILL.md items 6-7) -> agent action (hr.md gap probing, profiler.md pattern analysis) -> user interaction (AskUserQuestion via orchestrator).

Two human verification items remain: the end-to-end gap probing flow and the pattern analysis quality, both requiring actual Claude Code runtime to test.

---

_Verified: 2026-04-08T12:00:00Z_
_Verifier: Claude (gsd-verifier)_
