---
phase: 6
slug: contradiction-detection
status: approved
nyquist_compliant: true
wave_0_complete: false
created: 2026-04-08
---

# Phase 6 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Manual verification (prompt engineering phase — no code changes) |
| **Config file** | none |
| **Quick run command** | `grep -c "클레임 추적\|모순 탐지" plugins/resume/.claude/agents/profiler.md` |
| **Full suite command** | Manual: run interview with contradicting claims, verify detection + resolution |
| **Estimated runtime** | ~2 seconds (grep), ~10 min (manual) |

---

## Sampling Rate

- **After every task commit:** Run grep presence checks on modified files
- **After every plan wave:** Verify section structure and keyword presence
- **Before `/gsd-verify-work`:** Full manual interview flow with contradiction scenarios
- **Max feedback latency:** 2 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 01-T1 (claim tracking) | 01 | 1 | CONTR-01, CONTR-03 | — | N/A | content | `grep -c "클레임 추적\|role_scope\|time\|scale\|contribution" plugins/resume/.claude/agents/profiler.md` | ✅ | ⬜ pending |
| 01-T2 (NLI detection) | 01 | 1 | CONTR-01 | — | N/A | content | `grep -c "모순 탐지\|contradiction_detected\|겸손에 의한 축소" plugins/resume/.claude/agents/profiler.md` | ✅ | ⬜ pending |
| 02-T1 (SKILL.md handler) | 02 | 2 | CONTR-01, CONTR-02, CONTR-03 | — | N/A | content | `grep -c "contradiction_detected\|contradictions_presented\|연결해보면" plugins/resume/skills/resume-panel/SKILL.md` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. This is a prompt engineering phase — no test framework or code changes needed.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Claim extraction quality | CONTR-01 | LLM output quality | Run profiler with multiple episodes, verify structured claims are extracted with correct categories |
| Contradiction detection accuracy | CONTR-01, CONTR-03 | LLM NLI judgment | Provide episodes with known role_scope contradiction, verify detection with correct urgency |
| Connecting tone | CONTR-02 | Tone quality assessment | Verify restoration question uses "아까 이야기랑 연결해보면..." framing, not accusatory |
| STAR field update | CONTR-01 | E2E flow | Select "더 큰 역할" option, verify resume-source.json STAR field is updated |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify commands (grep presence checks)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 2s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-04-08
