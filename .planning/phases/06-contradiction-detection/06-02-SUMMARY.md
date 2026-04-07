---
phase: 06-contradiction-detection
plan: 02
subsystem: skills
tags: [skill-md, contradiction-detection, askuserquestion, star-update, orchestrator, flow-protection]

# Dependency graph
requires:
  - phase: 06-contradiction-detection
    plan: 01
    provides: "contradiction_detected finding format from profiler.md (claim_a, claim_b, contradiction_type, likely_cause, restoration_question)"
provides:
  - "contradiction_detected handler (item 9) in SKILL.md with AskUserQuestion presentation"
  - "STAR field update logic for contradiction resolution"
  - "Session limit enforcement (2 contradictions/session) via meta.json counter"
  - "MEDIUM urgency contradiction routing to Conversation Briefing"
  - "Flow protection rules for contradiction handling"
affects: [resume-source.json STAR fields, meta.json session state, interview flow]

# Tech tracking
tech-stack:
  added: []
  patterns: [two-signal message classification for contradiction_detected, single-turn contradiction resolution with STAR update]

key-files:
  created: []
  modified: [plugins/resume/skills/resume-panel/SKILL.md]

key-decisions:
  - "Orchestrator handles contradiction presentation directly via AskUserQuestion -- no agent delegation needed"
  - "Two-signal classification (keywords in message content) distinguishes contradiction HIGH from generic HIGH findings"
  - "STAR field update only modifies the specific star_field referenced by the claim, preserving all other episode content"
  - "MEDIUM urgency contradictions routed to Conversation Briefing for natural confirmation, not immediate AskUserQuestion"

patterns-established:
  - "Two-signal keyword priority: item 9 keywords checked before generic item 2 HIGH handler"
  - "Single-turn contradiction resolution: user selects role option or 'context different', then immediate interview resume"
  - "Session counter pattern extended: contradictions_presented_this_session follows perspective_shifts_this_session pattern"

requirements-completed: [CONTR-02]

# Metrics
duration: 2min
completed: 2026-04-08
---

# Phase 06 Plan 02: SKILL.md Contradiction Handler + STAR Update Summary

**contradiction_detected handler (item 9) with connecting-tone AskUserQuestion, 3-option role resolution, STAR field update, and flow protection rules added to SKILL.md**

## Performance

- **Duration:** 2 min
- **Started:** 2026-04-07T22:38:46Z
- **Completed:** 2026-04-07T22:40:46Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments
- Added item 9 handler for contradiction_detected findings with two-signal classification ("모순 발견" / "역할 모순" keywords)
- AskUserQuestion presents restoration question with connecting tone ("아까 이야기랑 연결해보면...") and 3 options: big role, small role, "상황이 달랐음"
- STAR field update logic: only modify the specific star_field referenced by the claim, preserve all other episode content
- Session limit of 2 contradictions enforced via contradictions_presented_this_session counter in meta.json
- MEDIUM urgency contradictions routed to Conversation Briefing with "확인 필요" section
- Flow protection: SO-WHAT priority over contradiction resolution, single-turn behavior, session cap enforcement
- Message classification priority note clarifying HIGH/MEDIUM keyword disambiguation across all handler items
- Agent selection criteria updated to note contradiction handling requires no agent delegation
- meta.json initialization block updated with contradictions_presented_this_session: 0

## Task Commits

Each task was committed atomically:

1. **Task 1: Add contradiction_detected handler, session tracking, STAR update, and flow protection to SKILL.md** - `984a144` (feat)

## Files Created/Modified
- `plugins/resume/skills/resume-panel/SKILL.md` - Added item 9 contradiction_detected handler, flow protection rules, meta.json counter initialization, agent selection criteria entry, message classification priority note (+50 lines)

## Decisions Made
- Orchestrator handles contradiction presentation directly via AskUserQuestion -- no agent delegation needed (per CONTEXT.md locked decision)
- Two-signal classification distinguishes contradiction_detected HIGH from generic HIGH findings, with explicit priority note
- STAR field update preserves existing content by only modifying the referenced star_field (mitigating T-06-04 tampering threat)
- MEDIUM urgency contradictions included in Conversation Briefing rather than immediate AskUserQuestion (per CLAUDE.md: "Do NOT flag every contradiction to the user immediately")

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Full contradiction pipeline is now wired: profiler detection (Plan 01) -> finding generation -> hook routing -> orchestrator handling (Plan 02) -> user interaction -> STAR update
- Phase 06 is complete -- all contradiction detection requirements (CONTR-01, CONTR-02, CONTR-03) are addressed across Plans 01 and 02

## Self-Check: PASSED

- FOUND: plugins/resume/skills/resume-panel/SKILL.md
- FOUND: .planning/phases/06-contradiction-detection/06-02-SUMMARY.md
- FOUND: 984a144 (Task 1 commit)

---
*Phase: 06-contradiction-detection*
*Completed: 2026-04-08*
