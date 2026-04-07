---
phase: 4
slug: profiler-analysis-timeline-pattern
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-08
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Manual verification via Claude Code plugin system |
| **Config file** | none — Claude Code plugin (prompt-based, no test runner) |
| **Quick run command** | `node -e "require('./episode-watcher.mjs')"` (syntax check) |
| **Full suite command** | Manual: run resume-panel interview and verify profiler triggers |
| **Estimated runtime** | ~30 seconds (syntax), ~5 min (manual) |

---

## Sampling Rate

- **After every task commit:** Run syntax check on modified files
- **After every plan wave:** Verify SKILL.md prompt parsing and agent prompt structure
- **Before `/gsd-verify-work`:** Full manual interview flow test
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 04-01-01 | 01 | 1 | TIME-01 | — | N/A | manual | Verify timeline construction from resume-source.json | ⬜ | ⬜ pending |
| 04-01-02 | 01 | 1 | TIME-02 | — | N/A | manual | Verify gap detection for >3mo gaps | ⬜ | ⬜ pending |
| 04-01-03 | 01 | 1 | TIME-03 | — | N/A | manual | Verify probing question with skip option | ⬜ | ⬜ pending |
| 04-02-01 | 02 | 1 | PTRN-01 | — | N/A | manual | Verify cross-company pattern analysis | ⬜ | ⬜ pending |
| 04-02-02 | 02 | 1 | PTRN-02 | — | N/A | manual | Verify pattern hypothesis presentation | ⬜ | ⬜ pending |
| 04-02-03 | 02 | 1 | PTRN-03 | — | N/A | manual | Verify findings-inbox.jsonl output | ⬜ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. This is a prompt engineering phase — no test framework installation needed.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Timeline gap detection | TIME-01, TIME-02 | Requires resume-source.json with real period data | Create test data with known gaps, run profiler, verify gaps detected |
| Probing question generation | TIME-03 | LLM output quality check | Verify questions are specific and include skip option |
| Cross-company pattern detection | PTRN-01, PTRN-02 | Requires multiple company episodes | Load 3+ episodes across companies, verify pattern output |
| Findings inbox integration | PTRN-03 | End-to-end flow | Verify findings appear in conversation briefing |

---

## Validation Sign-Off

- [ ] All tasks have automated verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
