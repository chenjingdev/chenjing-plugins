---
phase: 3
slug: so-what-chain
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-07
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | node --test (Node.js built-in) |
| **Config file** | plugins/resume/scripts/episode-watcher.test.mjs |
| **Quick run command** | `node --test plugins/resume/scripts/episode-watcher.test.mjs` |
| **Full suite command** | `node --test plugins/resume/scripts/episode-watcher.test.mjs` |
| **Estimated runtime** | ~3 seconds |

---

## Sampling Rate

- **After every task commit:** Run `node --test plugins/resume/scripts/episode-watcher.test.mjs`
- **After every plan wave:** Run full suite
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 03-01-01 | 01 | 1 | IMPACT-01 | — | N/A | unit | `node --test plugins/resume/scripts/episode-watcher.test.mjs` | ❌ W0 | ⬜ pending |
| 03-01-02 | 01 | 1 | IMPACT-03 | — | N/A | unit | `node --test plugins/resume/scripts/episode-watcher.test.mjs` | ❌ W0 | ⬜ pending |
| 03-02-01 | 02 | 2 | IMPACT-02 | — | N/A | manual | Review c-level.md prompt quality | N/A | ⬜ pending |
| 03-02-02 | 02 | 2 | IMPACT-01 | — | N/A | manual | Review SKILL.md SO-WHAT handling | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `plugins/resume/scripts/episode-watcher.test.mjs` — test stubs for hasQuantifiedImpact() and SO-WHAT trigger
- [ ] Test fixtures for resume-source.json with/without quantified impact

*Existing test file from Phase 2 may be extended.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| C-Level So What chain question quality | IMPACT-02 | Prompt output quality is non-deterministic | Invoke C-Level agent with test episode, verify 3-level chain structure |
| SKILL.md SO-WHAT message routing | IMPACT-01 | Orchestrator behavior in live interview context | Run interview, save shallow episode, verify chain triggers |
| result field update after chain | IMPACT-01 | End-to-end flow through orchestrator+agent | Complete So What chain, check resume-source.json result field |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
