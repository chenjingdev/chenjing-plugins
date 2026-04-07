---
phase: 01-askuserquestion-ux
plan: 02
subsystem: ui
tags: [agent-prompts, askuserquestion, select-box, ux]

# Dependency graph
requires:
  - phase: 01-askuserquestion-ux plan 01
    provides: SKILL.md orchestrator conversion logic for AskUserQuestion
provides:
  - 5 agent prompts updated with max-4-option guideline
  - All 직접입력 option items removed from agent examples
affects: [02-impact-deepening, 03-pattern-detection, 04-profiler-enhancement]

# Tech tracking
tech-stack:
  added: []
  patterns: ["Agent outputs max 4 substantive options; orchestrator adds Other via AskUserQuestion"]

key-files:
  created: []
  modified:
    - plugins/resume/.claude/agents/senior.md
    - plugins/resume/.claude/agents/c-level.md
    - plugins/resume/.claude/agents/recruiter.md
    - plugins/resume/.claude/agents/hr.md
    - plugins/resume/.claude/agents/coffee-chat.md

key-decisions:
  - "Examples keep existing substantive options intact; only 직접입력 line removed"
  - "Output format template shows optional 4th slot instead of 직접입력"

patterns-established:
  - "Agent option guideline: 최대 4개 substantive options, no 직접입력"
  - "Orchestrator responsibility: AskUserQuestion auto-adds Other for free-text input"

requirements-completed: [UX-02]

# Metrics
duration: 8min
completed: 2026-04-07
---

# Phase 01 Plan 02: Agent Option Guidelines Summary

**5 agent prompts updated from "2~3개" to "최대 4개" option guideline, all 직접입력 items removed to align with AskUserQuestion auto-Other**

## Performance

- **Duration:** 8 min
- **Started:** 2026-04-07T06:59:49Z
- **Completed:** 2026-04-07T07:07:50Z
- **Tasks:** 1
- **Files modified:** 5

## Accomplishments
- Updated option count guideline from "2~3개" to "최대 4개" in 4 agents (senior, c-level, recruiter, hr)
- Removed all 직접입력 option lines from examples across all 5 agent files (19 lines total)
- Updated output format templates to show optional 4th slot instead of 직접입력
- Added explicit "직접입력은 넣지 않는다" instruction in guideline text

## Task Commits

Each task was committed atomically:

1. **Task 1: 5개 에이전트 선택지 가이드라인 + 예시 업데이트** - `6a279a6` (feat)

**Plan metadata:** [pending] (docs: complete plan)

## Files Created/Modified
- `plugins/resume/.claude/agents/senior.md` - Role description + rule updated to 최대 4개, 8 직접입력 lines removed, output format updated
- `plugins/resume/.claude/agents/c-level.md` - Rule updated to 최대 4개, 6 직접입력 lines removed from examples, output format updated
- `plugins/resume/.claude/agents/recruiter.md` - Rule updated to 최대 4개, 2 직접입력 lines removed, output format updated
- `plugins/resume/.claude/agents/hr.md` - Rule updated to 최대 4개, 3 직접입력 lines removed, output format updated
- `plugins/resume/.claude/agents/coffee-chat.md` - 1 직접입력 line removed from example template

## Decisions Made
- Examples keep existing substantive options intact; only the 직접입력 line is removed (not replaced with a 4th substantive option in concrete examples)
- Output format templates show `{선택지4 (선택)}` placeholder to indicate optional 4th slot is available
- coffee-chat.md has no "선택지 2~3개" guideline to update (only has "구체적 선택지 필수"), so only example was modified

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 01 (AskUserQuestion UX) is now complete: SKILL.md conversion logic (plan 01) + agent option guidelines (plan 02)
- Agents output max 4 substantive options; orchestrator converts to AskUserQuestion select box with auto Other
- Ready for Phase 02 (Impact Deepening) which builds on the same agent prompt structure

## Self-Check: PASSED

All 5 modified files verified present. All 1 commit hash verified in git log.

---
*Phase: 01-askuserquestion-ux*
*Completed: 2026-04-07*
