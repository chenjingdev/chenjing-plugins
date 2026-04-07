---
phase: 03-so-what-chain
plan: 01
subsystem: episode-watcher hook
tags: [so-what-chain, impact-detection, tdd, regex]
dependency_graph:
  requires: [02-01]
  provides: [hasQuantifiedImpact, SO-WHAT-trigger]
  affects: [episode-watcher.mjs, test-episode-watcher.mjs]
tech_stack:
  added: []
  patterns: [regex-based-impact-detection, so_what_active-flag-check, break-based-single-trigger]
key_files:
  created: []
  modified:
    - plugins/resume/scripts/episode-watcher.mjs
    - plugins/resume/scripts/test-episode-watcher.mjs
decisions:
  - "Existing scoring tests updated to use quantified result data ('매출 30% 증가') to avoid SO-WHAT interference with profiler scoring isolation"
  - "Star gap test uses so_what_active suppression flag to isolate star gap scoring from SO-WHAT trigger"
metrics:
  duration: 4min
  completed: "2026-04-07T08:07:02Z"
  tasks: 2
  files: 2
---

# Phase 03 Plan 01: So What Chain Trigger Detection Summary

TDD implementation of hasQuantifiedImpact() regex function and SO-WHAT trigger logic in episode-watcher.mjs, detecting impact-shallow episodes via Korean number+unit pattern matching.

## What Was Done

### Task 1: RED -- Failing tests for hasQuantifiedImpact and SO-WHAT trigger
**Commit:** 9d150d1

Added 12 new tests in the `// -- So What chain tests` section:
- 6 unit tests for `hasQuantifiedImpact()` regex validation (%, ms, 배, no-number, empty, null)
- 6 integration tests using setupTestDir/runWithBase infrastructure:
  - SO-WHAT trigger on weak result
  - SO-WHAT skip on quantified result
  - SO-WHAT suppression when `so_what_active.active === true`
  - SO-WHAT message includes episode title
  - SO-WHAT and profiler message coexistence
  - Fallback to "(제목 없음)" when episode has no title

All 22 existing tests passed; new integration tests failed (RED state confirmed).

### Task 2: GREEN -- Implement hasQuantifiedImpact() and SO-WHAT trigger
**Commit:** e99294c

Added to `episode-watcher.mjs`:
1. **`hasQuantifiedImpact(resultText)` function** (after `detectMinimization`): Regex `/\d+(\.\d+)?\s*(명|건|%|원|만|억|배|시간|분|초|ms|개월|일|주|달|회|번|개|위|등|톤|km|kg|L|대|편|권|통|점|곳|팀)/` checks for Korean number+unit patterns.
2. **SO-WHAT trigger block** (after scoring threshold check, before snapshot update): Iterates new episodes (beyond `snapshot.episode_count`), checks `hasQuantifiedImpact()` on `ep.star?.result || ep.result`, sends `[resume-panel:SO-WHAT] 에피소드 "{title}" 임팩트 부족` message. Guarded by `so_what_active?.active` flag check and single-trigger `break`.

Updated existing scoring test data from `result: "r"` to `result: "매출 30% 증가"` to prevent SO-WHAT interference with profiler scoring tests.

All 34 tests pass (22 existing + 12 new).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Existing scoring tests broken by SO-WHAT trigger**
- **Found during:** Task 2
- **Issue:** Existing scoring tests used `result: "r"` (non-quantified) which triggered SO-WHAT output, breaking tests that expected `null` output when profiler score was below threshold
- **Fix:** Changed scoring test data to use `result: "매출 30% 증가"` (quantified) and added `so_what_active` suppression to star gap tests with `result: ""`
- **Files modified:** `plugins/resume/scripts/test-episode-watcher.mjs`
- **Commit:** e99294c

## Verification Results

```
All scoring system tests passed.     (16 tests)
All findings routing tests passed.   (6 tests)
All So What chain tests passed.      (12 tests)
Exit code: 0
```

## Threat Model Compliance

- T-03-01 (re-trigger loop): Mitigated via `so_what_active?.active` flag check before SO-WHAT trigger
- T-03-02 (result field overwrite): Accepted -- hook reads only, no writes to resume-source.json
- T-03-03 (episode title disclosure): Accepted -- local pipeline only

## Self-Check: PASSED

- [x] episode-watcher.mjs exists
- [x] test-episode-watcher.mjs exists
- [x] 03-01-SUMMARY.md exists
- [x] Commit 9d150d1 (Task 1 RED) found
- [x] Commit e99294c (Task 2 GREEN) found
