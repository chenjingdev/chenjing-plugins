---
phase: 05-perspective-shifting
plan: 01
subsystem: agents
tags: [perspective-shifting, profiler, hr, c-level, undervaluation-detection]

# Dependency graph
requires:
  - phase: 04-profiler-analysis-timeline-pattern
    provides: profiler pattern analysis framework, hr gap probing mode, c-level so-what chain mode
provides:
  - Perspective shift detection in profiler.md (undervaluation signal -> perspective_shift finding)
  - Perspective shifting mode in HR.md (junior/PM viewpoint questions)
  - Perspective shifting mode in C-Level.md (boss/customer viewpoint questions)
affects: [05-02-PLAN, SKILL.md orchestration rules]

# Tech tracking
tech-stack:
  added: []
  patterns: [perspective-shift-detection, scene-hint-question-pattern, humble-option-last]

key-files:
  created: []
  modified:
    - plugins/resume/.claude/agents/profiler.md
    - plugins/resume/.claude/agents/hr.md
    - plugins/resume/.claude/agents/c-level.md

key-decisions:
  - "Perspective detection section kept under 40 lines to mitigate prompt length bloat (T-05-01)"
  - "All 4 episode types mapped in profiler even though detection only triggers on leadership/collaboration"
  - "Humble option always last (3rd) with max 2 upgrade options -- AskUserQuestion adds Other automatically"

patterns-established:
  - "scene_hint pattern: extract concrete scene from episode situation+action with mandatory specific detail (tech/project/team name)"
  - "Humble option last: perspective shifting questions always end with a self-deprecating exit option"
  - "perspective_shift finding: new finding type in findings-inbox.jsonl with target_perspective, target_agent, scene_hint fields"

requirements-completed: [PERSP-01, PERSP-02, PERSP-03]

# Metrics
duration: 15min
completed: 2026-04-08
---

# Phase 5 Plan 1: Agent Prompt Enhancement Summary

**Perspective shift detection in profiler with scene-based third-person viewpoint question modes in HR and C-Level agents**

## Performance

- **Duration:** 15 min
- **Started:** 2026-04-07T17:21:57Z
- **Completed:** 2026-04-07T17:37:38Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Profiler can detect undervaluation signals in leadership/collaboration episodes and generate perspective_shift findings with scene_hint and target agent routing
- HR agent can generate junior/PM perspective questions with concrete scene descriptions and mandatory humble option
- C-Level agent can generate boss/customer perspective questions with concrete scene descriptions and mandatory humble option
- Perspective mapping table covers all 4 episode types matching CLAUDE.md specification

## Task Commits

Each task was committed atomically:

1. **Task 1: Add perspective shift detection section to profiler.md** - `3437967` (feat)
2. **Task 2: Add perspective shifting mode to HR.md and C-Level.md** - `56066bf` (feat)

## Files Created/Modified
- `plugins/resume/.claude/agents/profiler.md` - Added ### 3. perspective shift detection section with AND-condition trigger, mapping table, scene_hint generation, finding JSON format, and prohibition rules; renumbered existing sections 3->4, 4->5
- `plugins/resume/.claude/agents/hr.md` - Added perspective shifting mode for leadership (junior viewpoint) and collaboration (PM viewpoint) episodes with concrete question patterns
- `plugins/resume/.claude/agents/c-level.md` - Added perspective shifting mode for problem-solving (boss/CTO viewpoint) and achievement (customer viewpoint) episodes with concrete question patterns

## Decisions Made
- Kept perspective detection section at exactly 40 lines to satisfy T-05-01 threat mitigation (prompt length bloat prevention)
- Included all 4 episode types in profiler mapping table (leadership, collaboration, problem-solving, achievement) even though detection AND-condition only triggers on leadership/collaboration -- the full table serves as reference for the finding's episode_type field
- Used double-dash (--) instead of em-dash for consistency with existing sections in hr.md and c-level.md

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All three agent prompt files have perspective shifting capabilities
- Plan 05-02 can now add SKILL.md orchestration rules for routing perspective_shift findings to the appropriate agent
- The perspective_shift finding JSON format is established and ready for hook/orchestrator consumption

## Self-Check: PASSED

All files exist, all commits verified, all content checks passed.

---
*Phase: 05-perspective-shifting*
*Completed: 2026-04-08*
