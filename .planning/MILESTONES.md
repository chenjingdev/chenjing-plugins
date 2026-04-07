# Milestones

## v1.0 Resume Panel Interview Enhancement (Shipped: 2026-04-07)

**Phases completed:** 6 phases, 12 plans, 20 tasks

**Key accomplishments:**

- SKILL.md orchestrator prompt rewritten to convert all agent questions and Round 0 prompts into AskUserQuestion select boxes with fallback and findings wrapping
- 5 agent prompts updated from "2~3개" to "최대 4개" option guideline, all 직접입력 items removed to align with AskUserQuestion auto-Other
- Event-weighted scoring system replacing blunt delta-based profiler trigger with 5 context-aware event types and threshold 5
- Commit:
- Commit:
- Deterministic date parsing with gap detection (inter >6mo, intra >3mo), pattern eligibility guard, and full data structure migration from projects[] to companies[].projects[]
- Commit:
- timeline_gap_found and pattern_detected orchestration handlers in SKILL.md with HR gap probing routing, intentional gap tracking, session limits, and Conversation Briefing integration for pattern-based episode discovery
- Perspective shift detection in profiler with scene-based third-person viewpoint question modes in HR and C-Level agents
- Perspective shift MEDIUM message routing with session limits, duplicate prevention, and interview flow protection in SKILL.md
- NLI-style claim extraction and contradiction detection added to profiler.md with 4-category taxonomy, context-based scoping, and connecting-tone restoration questions
- contradiction_detected handler (item 9) with connecting-tone AskUserQuestion, 3-option role resolution, STAR field update, and flow protection rules added to SKILL.md

---
