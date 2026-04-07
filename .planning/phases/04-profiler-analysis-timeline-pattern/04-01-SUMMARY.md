---
phase: 04-profiler-analysis-timeline-pattern
plan: 01
subsystem: hook
tags: [timeline, date-parsing, gap-detection, pattern-eligibility, data-migration]

# Dependency graph
requires:
  - phase: 02-profiler-frequency-enhancement
    provides: scoring system, profiler trigger threshold, meta.json persistence
  - phase: 03-so-what-chain
    provides: SO-WHAT trigger, hasQuantifiedImpact, findings-inbox.jsonl pipeline
provides:
  - parsePeriod() function for YYYY.MM date parsing with 현재/재직중 support
  - getAllProjects() helper for canonical companies[].projects[] iteration
  - detectGaps() with inter-company >6mo and intra-company >3mo thresholds
  - timeline_gap_found finding emission to findings-inbox.jsonl
  - Pattern eligibility flag in profiler trigger message (패턴 분석 가능)
  - intentional_gaps filtering from meta.json
  - Data structure migration from source.projects to source.companies[].projects[]
affects: [04-02 profiler.md pattern analysis, 04-03 SKILL.md orchestration rules, hr.md gap probing]

# Tech tracking
tech-stack:
  added: []
  patterns: [deterministic date arithmetic for gap detection, getAllProjects abstraction layer]

key-files:
  created: []
  modified:
    - plugins/resume/scripts/episode-watcher.mjs
    - plugins/resume/scripts/test-episode-watcher.mjs

key-decisions:
  - "Data structure fully migrated to companies[].projects[] -- no backward compatibility with flat projects[]"
  - "Gap tests check findings.json instead of findings-inbox.jsonl because inbox is consumed by routing in same hook execution"
  - "Pattern eligibility appended to existing profiler message rather than separate message"

patterns-established:
  - "getAllProjects(source) as canonical iteration pattern -- all functions use this instead of direct source access"
  - "Timeline analysis runs synchronously in profiler trigger block (score >= 5), not as separate trigger"

requirements-completed: [TIME-01, TIME-02, PTRN-01]

# Metrics
duration: 9min
completed: 2026-04-08
---

# Phase 4 Plan 01: Timeline Gap Detection + Pattern Eligibility Summary

**Deterministic date parsing with gap detection (inter >6mo, intra >3mo), pattern eligibility guard, and full data structure migration from projects[] to companies[].projects[]**

## Performance

- **Duration:** 9 min
- **Started:** 2026-04-07T16:20:54Z
- **Completed:** 2026-04-07T16:30:47Z
- **Tasks:** 2 (TDD: RED + GREEN)
- **Files modified:** 2

## Accomplishments
- Migrated all hook functions from flat `source.projects` to canonical `source.companies[].projects[]` schema via `getAllProjects()` helper
- Implemented parsePeriod() handling YYYY.MM, single-digit months, 현재, 재직중, null/invalid inputs
- Implemented detectGaps() with differentiated thresholds: inter-company >6 months, intra-company >3 months
- Timeline gap findings written to findings-inbox.jsonl as `timeline_gap_found` type with MEDIUM urgency
- Pattern eligibility flag added to profiler trigger message when episodes >= 3 and companies >= 2
- Intentional gaps in meta.json skip gap finding emission
- All 54 tests pass (34 existing migrated + 20 new)

## Task Commits

Each task was committed atomically:

1. **Task 1: RED -- Write failing tests for data structure migration + timeline functions + pattern eligibility** - `6f95505` (test)
2. **Task 2: GREEN -- Implement timeline functions, data structure migration, gap detection, and pattern eligibility** - `a8c2060` (feat)

## Files Created/Modified
- `plugins/resume/scripts/episode-watcher.mjs` - Added getAllProjects, parsePeriod, toMonths, detectGaps, getCompanyCount; migrated all iterators; added timeline analysis and pattern eligibility to profiler trigger
- `plugins/resume/scripts/test-episode-watcher.mjs` - Migrated 34 existing tests to companies[] schema; added 11 timeline parsing, 6 gap detection, 3 pattern eligibility tests

## Decisions Made
- Fully migrated to `companies[].projects[]` schema with no backward compatibility fallback -- the canonical schema in SKILL.md is the source of truth
- Gap detection tests verify findings in `findings.json` (post-routing) rather than `findings-inbox.jsonl` (pre-routing) because the hook's findings routing section processes the inbox in the same execution pass
- Pattern eligibility is appended to the existing profiler trigger message (`" 패턴 분석 가능."`) rather than emitted as a separate message, keeping the additionalContext compact
- `last_pattern_analysis_episode_count` tracked in meta.json for future delta-based pattern analysis triggers

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Gap tests checking wrong file**
- **Found during:** Task 2 (GREEN implementation)
- **Issue:** Gap detection tests checked `findings-inbox.jsonl` for gap findings, but the findings routing section (역할 2) in the same hook execution consumes the inbox, renames it to processing, and moves findings to `findings.json`
- **Fix:** Updated all 6 gap detection tests to check `findings.json` instead of `findings-inbox.jsonl`
- **Files modified:** plugins/resume/scripts/test-episode-watcher.mjs
- **Verification:** All 54 tests pass
- **Committed in:** a8c2060 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Necessary correction for test accuracy. The finding pipeline behavior was correct; only the test verification target was wrong. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Timeline gap detection and pattern eligibility are code-complete in episode-watcher.mjs
- Plan 02 (profiler.md) can add pattern analysis framework section consuming the "패턴 분석 가능" flag
- Plan 03 (SKILL.md + hr.md) can add timeline_gap_found handling rules and gap probing orchestration
- All functions tested and passing; data structure fully canonical

---
*Phase: 04-profiler-analysis-timeline-pattern*
*Completed: 2026-04-08*
