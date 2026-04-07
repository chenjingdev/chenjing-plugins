---
phase: 05-perspective-shifting
plan: 02
subsystem: orchestrator
tags: [perspective-shifting, skill-orchestration, message-handling, flow-protection]

# Dependency graph
requires:
  - phase: 05-perspective-shifting
    plan: 01
    provides: perspective_shift detection in profiler.md, perspective shifting modes in HR.md and C-Level.md
provides:
  - perspective_shift message handling in SKILL.md (item 8)
  - Agent selection routing for perspective_shift target_agent
  - Flow protection rules for perspective shifting single-turn behavior
affects: [episode-watcher.mjs hook message routing, meta.json state tracking]

# Tech tracking
tech-stack:
  added: []
  patterns: [perspective-shift-orchestration, two-signal-classification, session-limit-counter]

key-files:
  created: []
  modified:
    - plugins/resume/skills/resume-panel/SKILL.md

key-decisions:
  - "Session limit of 2 perspective shifts per session (lower than gap probing limit of 3) per user decision"
  - "Two-signal classification follows Phase 4 pattern: keyword detection in MEDIUM message content"
  - "Humble option response triggers immediate interview resumption with meta.json tracking"

patterns-established:
  - "perspective_shift two-signal: MEDIUM message containing '관점 전환' -> perspective_shift finding"
  - "Session counter + episode dedup array: perspective_shifts_this_session + perspective_shifted_episodes"
  - "SO-WHAT priority over perspective shift when simultaneous arrival"

requirements-completed: [PERSP-01, PERSP-03]

# Metrics
duration: 1min
completed: 2026-04-08
---

# Phase 5 Plan 2: SKILL.md Orchestration Rules Summary

**Perspective shift MEDIUM message routing with session limits, duplicate prevention, and interview flow protection in SKILL.md**

## Performance

- **Duration:** 1 min
- **Started:** 2026-04-07T17:40:04Z
- **Completed:** 2026-04-07T17:41:02Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments
- SKILL.md item 8 handles perspective_shift findings with two-signal classification ("관점 전환" keyword in MEDIUM messages)
- Session limiting enforced via meta.json perspective_shifts_this_session counter (max 2)
- Duplicate prevention via meta.json perspective_shifted_episodes array
- Agent invocation routes to target_agent (HR or C-Level) in perspective shifting mode with episode_ref, target_perspective, scene_hint context
- Humble option response -> meta.json tracking + immediate interview resumption
- Upgraded role response -> optional follow-up question + meta.json tracking
- Agent selection criteria updated with perspective_shift target_agent routing
- Flow protection rules added: single-turn behavior, SO-WHAT priority, session limit enforcement

## Task Commits

Each task was committed atomically:

1. **Task 1: Add perspective_shift handler, agent selection, and flow protection to SKILL.md** - `ce30a86` (feat)

## Files Created/Modified
- `plugins/resume/skills/resume-panel/SKILL.md` - Added item 8 in message handling rules (perspective_shift MEDIUM finding handler with two-signal detection, session limit, duplicate prevention, Agent() invocation, response handling), added agent selection criteria for perspective_shift target_agent routing, added flow protection rules for single-turn behavior and SO-WHAT priority

## Decisions Made
- Session limit of 2 (not 3 like gap probing) per user specification -- perspective shifting is less critical than gap probing for interview completeness
- Two-signal classification follows established Phase 4 pattern for consistency: "공백"+"개월" for gaps (item 6), "패턴 발견" for patterns (item 7), "관점 전환" for perspective shifts (item 8)
- SO-WHAT takes priority over perspective shift when both arrive simultaneously, matching the established priority pattern for SO-WHAT over gap probing

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Pipeline Completeness
The full perspective shifting pipeline is now wired:
1. **Profiler detection** (Plan 01): profiler.md detects undervaluation signals in leadership/collaboration episodes
2. **Finding generation** (Plan 01): profiler outputs perspective_shift finding to findings-inbox.jsonl
3. **Hook routing** (existing): episode-watcher.mjs routes MEDIUM findings to SKILL.md via additionalContext
4. **Orchestrator handling** (Plan 02): SKILL.md item 8 classifies, validates, and routes to designated agent
5. **Agent invocation** (Plan 01 + 02): HR/C-Level called in perspective shifting mode with context
6. **User interaction** (Plan 02): AskUserQuestion conversion, humble/upgraded response handling
7. **State tracking** (Plan 02): meta.json perspective_shifts_this_session and perspective_shifted_episodes

## Self-Check: PASSED

All files exist, all commits verified, all content checks passed.

---
*Phase: 05-perspective-shifting*
*Completed: 2026-04-08*
