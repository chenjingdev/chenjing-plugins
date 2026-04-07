---
phase: 4
slug: profiler-analysis-timeline-pattern
status: approved
nyquist_compliant: true
wave_0_complete: false
created: 2026-04-08
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node.js built-in assert (no external test runner) |
| **Config file** | none — test file is self-contained |
| **Quick run command** | `node plugins/resume/scripts/test-episode-watcher.mjs` |
| **Full suite command** | `node plugins/resume/scripts/test-episode-watcher.mjs` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** `node plugins/resume/scripts/test-episode-watcher.mjs`
- **After every plan wave:** `node plugins/resume/scripts/test-episode-watcher.mjs`
- **Before `/gsd-verify-work`:** Full suite green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 01-T1 (RED) | 01 | 1 | TIME-01, TIME-02, PTRN-01 | — | N/A | unit | `node plugins/resume/scripts/test-episode-watcher.mjs 2>&1 \| tail -20` | Wave 0 | ⬜ pending |
| 01-T2 (GREEN) | 01 | 1 | TIME-01, TIME-02, PTRN-01 | — | N/A | unit+integration | `node plugins/resume/scripts/test-episode-watcher.mjs` | Wave 0 | ⬜ pending |
| 02-T1 (profiler.md) | 02 | 1 | PTRN-01, PTRN-02 | — | N/A | content | `grep -c "크로스 컴퍼니 패턴 분석" plugins/resume/.claude/agents/profiler.md` | ✅ | ⬜ pending |
| 02-T2 (hr.md) | 02 | 1 | TIME-03 | — | N/A | content | `grep -c "갭 프로빙 모드" plugins/resume/.claude/agents/hr.md` | ✅ | ⬜ pending |
| 03-T1 (SKILL.md) | 03 | 2 | TIME-02, TIME-03, PTRN-02, PTRN-03 | — | N/A | content | `grep -c "timeline_gap_found\|pattern_detected\|intentional_gap" plugins/resume/skills/resume-panel/SKILL.md` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Timeline parsing unit tests (parsePeriod, toMonths, detectGaps) — covers TIME-01, TIME-02
- [ ] Timeline integration test (gap finding triggers finding write) — covers TIME-02
- [ ] Intentional gap prevention test — covers TIME-03
- [ ] Pattern eligibility guard tests (episode count, company count) — covers PTRN-01
- [ ] Update all existing tests to use `companies[].projects[]` schema — prerequisite for all new tests

*Framework install: none needed (built-in Node.js assert)*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Profiler pattern output quality | PTRN-02 | LLM output quality check | Run profiler with 3+ episodes across 2+ companies, verify pattern names and suggested questions are meaningful |
| Gap probing conversation flow | TIME-03 | End-to-end UX flow | Trigger gap probing via HR agent, verify skip option works and intentional_gap is recorded |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify commands
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 5s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-04-08
