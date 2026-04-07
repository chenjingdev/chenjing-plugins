---
phase: 04-profiler-analysis-timeline-pattern
plan: 03
subsystem: orchestrator
tags: [skill-md, orchestration, timeline-gap, pattern-detection, gap-probing, intentional-gaps]

# Dependency graph
requires:
  - phase: 04-profiler-analysis-timeline-pattern
    plan: 01
    provides: timeline_gap_found finding emission, intentional_gaps filtering, pattern eligibility flag
  - phase: 04-profiler-analysis-timeline-pattern
    plan: 02
    provides: HR gap probing mode, profiler cross-company pattern analysis framework
provides:
  - SKILL.md item 6: timeline_gap_found handler routing to HR gap probing mode
  - SKILL.md item 7: pattern_detected handler routing via Conversation Briefing to target_agent
  - intentional_gaps tracking in meta.json with skip handling
  - gap_probes_this_session session limit (3 per session)
  - Gap probing and pattern routing in agent selection criteria
  - Gap probing flow protection rules (single-turn, SO-WHAT priority, session limit)
affects: [phase-05 perspective-shifting, phase-06 contradiction-detection]

# Tech tracking
tech-stack:
  added: []
  patterns: [two-signal message classification for finding type routing, session-scoped counter for rate limiting]

key-files:
  created: []
  modified:
    - plugins/resume/skills/resume-panel/SKILL.md

key-decisions:
  - "Two-signal detection for finding type: '공백'+'개월' for gaps, '패턴 발견' for patterns -- reduces false classification"
  - "Gap probing session limit of 3 prevents overwhelming user with gap questions"
  - "Pattern findings route through Conversation Briefing rather than immediate delivery -- follows MEDIUM urgency convention"

patterns-established:
  - "Finding-type-specific MEDIUM routing: same urgency level but different handler based on message content signals"
  - "Session-scoped counter pattern (gap_probes_this_session) for rate-limiting within orchestrator rules"

requirements-completed: [TIME-02, TIME-03, PTRN-02, PTRN-03]

# Metrics
duration: 2min
completed: 2026-04-07
tasks: 1
files: 1
---

# Phase 04 Plan 03: SKILL.md Orchestration Rules Summary

**timeline_gap_found and pattern_detected orchestration handlers in SKILL.md with HR gap probing routing, intentional gap tracking, session limits, and Conversation Briefing integration for pattern-based episode discovery**

## Performance

- **Duration:** 2 min
- **Started:** 2026-04-07T16:35:25Z
- **Completed:** 2026-04-07T16:36:56Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments
- Full pipeline wired: hook detection -> findings -> orchestrator routing -> agent action -> user interaction for both timeline gaps and pattern detection
- timeline_gap_found handler (item 6) routes to HR agent in gap probing mode with intentional_gaps tracking and 3-gap session limit
- pattern_detected handler (item 7) integrates findings into Conversation Briefing with target_agent routing and suggested_question passthrough
- Gap probing flow protection rules ensure SO-WHAT priority and graceful session limit enforcement

## Task Commits

Each task was committed atomically:

1. **Task 1: Add timeline_gap_found and pattern_detected handling rules to SKILL.md** - `6f9974d` (feat)

## Files Created/Modified
- `plugins/resume/skills/resume-panel/SKILL.md` - Added items 6-7 to message handling rules, gap probing + pattern routing to agent selection criteria, gap probing flow protection rules

## Decisions Made
- Two-signal detection ("공백"+"개월" for gaps, "패턴 발견" for patterns) reduces false classification risk per T-04-08 mitigation
- Session limit of 3 gap probes per T-04-09 DoS mitigation
- Pattern findings follow MEDIUM urgency convention (delivered at project/company change, not immediately)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 04 pipeline is complete: episode-watcher.mjs detects gaps and pattern eligibility (Plan 01) -> profiler.md analyzes patterns (Plan 02) -> SKILL.md routes findings to appropriate agents (Plan 03)
- HR agent gap probing mode is fully connected via orchestrator routing
- Pattern detection findings flow through Conversation Briefing to target agents
- Ready for Phase 05 (perspective shifting) or Phase 06 (contradiction detection)

---
*Phase: 04-profiler-analysis-timeline-pattern*
*Completed: 2026-04-07*
