# Project Research Summary

**Project:** Resume Panel Interview Enhancement
**Domain:** LLM-based multi-agent interview system (Claude Code plugin)
**Researched:** 2026-04-07
**Confidence:** HIGH

## Executive Summary

This project enhances an existing multi-agent resume interview system (9 agents, PostToolUse hook, structured STAR-format episode storage) with 6 new capabilities: impact deepening (So What chain), cross-company pattern detection, timeline gap detection, perspective shifting questions, contradiction detection, and structured selection UI (AskUserQuestion). The critical insight from research is that all 6 features are implementable purely through prompt engineering, data structure extensions, and orchestrator logic changes -- zero new dependencies, zero new agents, zero new infrastructure. The "stack" is techniques, not technologies.

The recommended approach is a profiler-centric architecture where cross-episode analysis (contradiction, pattern, timeline) runs inside the existing profiler agent and flows through the established findings-inbox pipeline. Synchronous features (So What chain, AskUserQuestion) stay in the orchestrator. Frontstage agents gain perspective-shifting question patterns as prompt additions, not new agents. This approach respects the existing system's design: the hook detects changes, the profiler analyzes, findings route by urgency, and the orchestrator delivers. The three research files (STACK, ARCHITECTURE, FEATURES) converge on this same integration pattern independently, which is a strong signal.

The primary risks are: (1) false-positive contradiction accusations destroying user trust, especially given Korean cultural modesty where self-minimization looks like inconsistency but is not; (2) prompt bloat from adding 6 features degrading existing agent quality (ICLR 2025 research shows >50% accuracy degradation from prompt bloat); and (3) So What chain interrogation fatigue if applied universally. Mitigation for all three is the same principle: selectivity. Contradiction detection must be scope-bound and high-confidence-only. Prompt additions must be minimal in frontstage agents (profiler absorbs complexity). So What chains must be gated by profiler assessment, not triggered on every episode.

## Key Findings

### Recommended Stack

There is no traditional technology stack. The entire enhancement is prompt engineering within the Claude Code plugin sandbox. All features are implemented as enhanced prompt instructions in agent `.md` files, extended JSON schema in `resume-source.json`, hook logic changes in `episode-watcher.mjs`, and orchestrator instructions in `SKILL.md`. See [STACK.md](./STACK.md) for full technical details per feature.

**Core techniques:**
- **Recursive prompt template with exit conditions**: So What chain -- structured 3-level impact deepening (direct -> team -> business) with deterministic exit conditions
- **Structured comparison matrix in profiler prompt**: Pattern detection and contradiction detection -- explicit comparison frameworks activate Claude's built-in NLI capabilities
- **Deterministic date arithmetic + LLM probing**: Timeline gaps -- never delegate date math to LLMs; parse structured `period` fields, compute gaps, let LLM generate probing questions
- **Role-framed prompt injection**: Perspective shifting -- conditional injection of perspective frames into existing agent calls, not a new agent
- **AskUserQuestion native tool**: UX upgrade -- orchestrator converts agent text output to clickable select boxes; agents do not change
- **Claim extraction + NLI-style comparison**: Contradiction detection -- extract structured claims with metadata on save, compare within-category pairs in profiler

### Expected Features

See [FEATURES.md](./FEATURES.md) for competitive landscape, detailed specifications, and anti-features.

**Must have (table stakes):**
- **So What Chain** -- highest single-feature leverage; every serious AI interview tool penalizes vague results. Turns "pipeline 구축" into "배포 시간 40% 절감 -> 팀 생산성 향상"
- **Timeline Gap Detection** -- ATS systems and recruiters flag gaps; simplest feature to implement (pure date arithmetic on existing data)
- **AskUserQuestion UI** -- hygiene factor; current "type a number" feels like a CLI prototype. Claude Code native select boxes are clickable

**Should have (differentiators -- no competitor does these):**
- **Cross-Company Pattern Detection** -- discovers behavioral patterns users never self-report because "it's just what I do." Strongest differentiator
- **Perspective Shifting** -- bypasses Korean cultural self-minimization by reframing through third-person perspective. Particularly powerful for leadership/collaboration episodes
- **Contradiction Detection** -- catches role-scope contradictions that reveal suppressed achievements. Requires careful tone calibration

**Defer (v2+):**
- Episode bank with multi-JD generation
- Mock interview mode
- Career narrative auto-summary

### Architecture Approach

The system follows a hub-and-spoke pattern where the profiler is the intelligence hub and findings-inbox.jsonl is the communication bus. All cross-episode analysis runs in the profiler agent during its periodic cycles (triggered by episode-watcher delta detection). Results flow through the existing urgency-routed pipeline: profiler writes to findings-inbox.jsonl, the hook consumes and routes (HIGH = immediate, MEDIUM = company transition, LOW = on-demand), and the orchestrator delivers to the user. The only synchronous feature is So What chain, which runs as an orchestrator-internal loop immediately after episode save. See [ARCHITECTURE.md](./ARCHITECTURE.md) for integration maps and component boundaries.

**Major components (updated responsibilities):**
1. **Orchestrator (SKILL.md)** -- round management, agent dispatch, episode extraction, + So What chain trigger, + AskUserQuestion formatting, + finding delivery to user
2. **Profiler (profiler.md)** -- profile building, agent dispatch, findings writing, + contradiction scan, + cross-company pattern scan, + timeline analysis
3. **episode-watcher.mjs** -- delta detection, findings routing, + optional timeline gap quick-check (date arithmetic only)
4. **Frontstage agents** -- question generation with options, + perspective shifting question patterns (prompt additions)
5. **findings-inbox.jsonl** -- existing communication bus, + 3 new finding types (contradiction, pattern_detected, timeline_gap)

### Critical Pitfalls

See [PITFALLS.md](./PITFALLS.md) for all 11 pitfalls with detailed prevention strategies.

1. **False positive contradiction accusations** -- scope-bind comparisons to same company+project+period; use curious framing never accusatory; require high confidence threshold before surfacing; test with real Korean transcripts where modesty mimics inconsistency
2. **Prompt bloat degrades all agent quality** -- keep frontstage agent additions minimal; profiler absorbs analytical complexity; measure existing behavior regression after each feature addition; consider injectable context blocks over inline instructions
3. **AskUserQuestion cannot be called from sub-agents** -- orchestrator-only calls; agents return text, orchestrator converts; do NOT add to skill's allowed-tools frontmatter; test in actual plugin context early
4. **So What chain interrogation fatigue** -- selective trigger (profiler-gated, not universal); max 2 levels deep; session limit of 5 chains; stop immediately on "don't know" responses
5. **Pattern detection hallucinates patterns** -- minimum 3 episodes across 2+ companies; must involve user agency not coincidence; present as hypothesis not fact; "null finding is acceptable" instruction in profiler prompt

## Implications for Roadmap

Based on combined research across all four files, the following phase structure reflects dependency ordering, risk mitigation, and architectural coherence.

### Phase 1: Foundation UX and Quick Wins
**Rationale:** AskUserQuestion is zero-risk, standalone, and improves UX for every subsequent feature. Timeline gap detection is the simplest analytical feature (pure date arithmetic on existing data). Shipping these first validates the integration pattern and delivers visible improvement immediately.
**Delivers:** Clickable select-box UI replacing text number selection; automated timeline gap identification with sensitive probing questions
**Addresses:** AskUserQuestion UI (table stakes), Timeline Gap Detection (table stakes)
**Avoids:** Pitfall 3 (AskUserQuestion sub-agent limitation -- validated early), Pitfall 7 (gap sensitivity -- "skip" option designed from day one), Pitfall 9 (option count limits -- standardized here)

### Phase 2: Impact Deepening (So What Chain)
**Rationale:** Highest single-feature leverage. Every episode becomes richer, which directly benefits pattern detection and contradiction detection in later phases. Depends on AskUserQuestion for better follow-up UX. Must address hook overload (Pitfall 8) since So What chain increases save frequency.
**Delivers:** Structured 3-level impact chains on episodes; richer resume-source.json data for downstream analysis
**Addresses:** So What Chain (table stakes, highest leverage)
**Avoids:** Pitfall 4 (interrogation fatigue -- selective trigger, max 2 levels, session limit), Pitfall 8 (hook overload -- cooldown timer, lock file, distinguish enrichment vs. new episode saves)

### Phase 3: Profiler Analysis Enhancements
**Rationale:** All three analytical features (timeline deep analysis, contradiction, pattern) share the same integration point (profiler.md) and the same pipeline (findings-inbox.jsonl). Building them together means one profiler.md update, one round of findings schema additions, one round of pipeline testing. Internal sub-ordering: 3a Timeline deep analysis (simplest, testable with few episodes), 3b Contradiction detection (needs related episode pairs), 3c Cross-company patterns (needs episodes from 2+ companies).
**Delivers:** Contradiction detection with claim ledger; cross-company behavioral pattern discovery; deep timeline analysis with under-probed tenure flagging
**Addresses:** Contradiction Detection (differentiator), Cross-Company Pattern Detection (strongest differentiator)
**Avoids:** Pitfall 1 (false contradiction accusations -- scope-binding, soft framing), Pitfall 2 (prompt bloat -- profiler absorbs analysis, frontstage agents stay lean), Pitfall 5 (hallucinated patterns -- minimum evidence threshold), Pitfall 10 (briefing bloat -- cap structure before adding new content types)

### Phase 4: Perspective Shifting
**Rationale:** Benefits from profiler signals ("user undervalues role") delivered by Phase 3. Pattern data from Phase 3c enables richer perspective questions ("you always push automation -- how did your junior see that?"). Without profiler intelligence, perspective shifts fire randomly rather than strategically.
**Delivers:** Third-person perspective questions in frontstage agents; targeted activation on leadership/collaboration episodes and profiler-flagged self-undervaluation
**Addresses:** Perspective Shifting (differentiator)
**Avoids:** Pitfall 6 (speculation vs. recall -- frame as recall prompts from day one, require specific events), Pitfall 2 (prompt bloat -- minimal additions to each of 5 frontstage agent prompts)

### Phase 5: Integration Hardening
**Rationale:** With all features active simultaneously, signal conflicts (Pitfall 11) become critical. This phase defines priority ordering, enforces one-interruption-per-3-turns, and stress-tests the combined system.
**Delivers:** Conflict resolution logic in orchestrator; tuned priority ordering; end-to-end regression testing
**Addresses:** System-level integration quality
**Avoids:** Pitfall 11 (contradictory signals from multiple features firing simultaneously)

### Phase Ordering Rationale

- **Dependency chain:** AskUserQuestion enables better UX for all features -> So What chain produces richer episodes -> Profiler analysis needs rich episodes -> Perspective shifting needs profiler signals. This ordering is independently confirmed by FEATURES.md dependency graph, ARCHITECTURE.md build order, and STACK.md implementation logic.
- **Risk gradient:** Phases progress from lowest risk (UX plumbing) to highest risk (contradiction detection, which can break trust if wrong). This gives the team experience with the integration pattern before tackling the hardest problems.
- **Architecture coherence:** Phase 3 groups all profiler-centric features together, avoiding multiple rounds of profiler.md modification and findings pipeline testing. Phase 4 groups all frontstage agent changes together.
- **Pitfall timing:** Hook hardening (Pitfall 8) must happen in Phase 2 before So What chain increases save frequency. Prompt bloat mitigation (Pitfall 2) must be a Phase 3 decision, not deferred. Signal conflict resolution (Pitfall 11) is Phase 5 because it only manifests with 3+ active features.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 3 (Profiler Analysis):** Contradiction detection prompt engineering needs 2-3 iteration rounds. Claim extraction quality is uncertain (MEDIUM confidence). The NLI-style comparison in profiler prompt is sound in theory but needs real-transcript testing to calibrate false-positive rates.
- **Phase 5 (Integration Hardening):** Priority ordering between findings types is a design decision that cannot be fully resolved until features are running. Needs empirical testing with realistic interview sessions.

Phases with standard patterns (skip research-phase):
- **Phase 1 (Foundation UX):** AskUserQuestion is documented Claude Code API. Timeline gap detection is pure date arithmetic. Both have well-established patterns.
- **Phase 2 (So What Chain):** Standard interview coaching methodology (STAR "So What Test") mapped to structured prompting. Well-documented, clear implementation path.
- **Phase 4 (Perspective Shifting):** Role-framed prompting is a well-established LLM technique. Implementation is conditional prompt injection into existing agents. The main risk (speculation vs. recall) is a framing decision, not a technical unknown.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | No external dependencies; all techniques are established prompt engineering patterns. Sources include Claude documentation, CoT research, and interview methodology literature. |
| Features | MEDIUM | Feature specifications are well-defined. Competitive landscape confirms unique positioning. Uncertainty: contradiction detection claim extraction quality needs iteration. No direct competitor validates the full feature combination. |
| Architecture | HIGH | Integration points map cleanly onto existing system. Profiler-as-hub pattern is independently recommended by STACK, ARCHITECTURE, and PITFALLS research. AskUserQuestion constraint is confirmed by Claude Code issue tracker. |
| Pitfalls | HIGH | 11 pitfalls identified with specific prevention strategies. Critical pitfalls (false contradictions, prompt bloat, AskUserQuestion sub-agent limitation) are backed by peer-reviewed research and documented Claude Code bugs. |

**Overall confidence:** HIGH -- this is an enhancement to an existing, well-understood system. The features are additive, the architecture is stable, and the risks are identified with clear mitigations.

### Gaps to Address

- **Claim extraction prompt quality:** The contradiction detection feature depends on high-quality claim extraction during episode save. The profiler must extract clean, scoped claims with metadata (company, project, time period, category). This has not been tested and likely needs 2-3 prompt iteration rounds. Plan for this during Phase 3 implementation.
- **AskUserQuestion behavior in current Claude Code version:** Bug #29547 is marked CLOSED, but the fix should be verified in the exact Claude Code version running the plugin before committing to Phase 1 scope. A 30-minute spike to confirm behavior is warranted.
- **Period field completeness:** Timeline gap detection assumes `period` fields are populated in resume-source.json. The current data may have missing or inconsistently formatted periods. The orchestrator needs validation logic to collect periods during Round 1 if missing.
- **Profiler prompt length after Phase 3:** Adding 3 analysis sections (contradiction, pattern, timeline) to profiler.md will significantly increase its length. The "lost in the middle" effect may degrade existing profiler capabilities. Measure profiler output quality before and after additions. Consider a modular prompt structure if degradation is observed.
- **Session-level So What chain limits:** The recommendation is max 5 chains per interview, but the optimal number depends on interview length and episode count. This needs calibration with real usage data.

## Sources

### Primary (HIGH confidence)
- [Claude Code AskUserQuestion System Prompt](https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/tool-description-askuserquestion.md) -- tool format, constraints, option limits
- [AskUserQuestion bug #29547](https://github.com/anthropics/claude-code/issues/29547) -- silent failure in allowed-tools; CLOSED/FIXED
- [Contradiction Detection in RAG Systems (arxiv:2504.00180)](https://arxiv.org/html/2504.00180v1) -- Claude Sonnet with CoT prompting for contradiction detection
- [STAR Method "So What" Test (Management Consulted)](https://managementconsulted.com/star-method/) -- impact deepening methodology
- [Chain-of-Thought Prompting Guide](https://www.promptingguide.ai/techniques/cot) -- structured prompting reference
- [Claude Structured Outputs Documentation](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) -- JSON schema enforcement

### Secondary (MEDIUM confidence)
- [Why Do Multi-Agent LLM Systems Fail? (ICLR 2025, arxiv:2503.13657)](https://arxiv.org/abs/2503.13657) -- 14 failure modes; prompt bloat and role disobedience
- [RAG-MCP: Mitigating Prompt Bloat (2025)](https://arxiv.org/pdf/2505.03275) -- >50% accuracy degradation from prompt bloat
- [Self-contradictory Hallucinations of LLMs (OpenReview)](https://openreview.net/forum?id=EmQSOi1X2f) -- 17.7% self-contradiction rate; structured prompting reduces this
- [Resumly AI - Career Gap Detection](https://www.resumly.ai/blog/how-ai-can-identify-career-gaps-in-resumes-guide) -- 3-month gap threshold, timeline construction
- [Reframing Perspectives - International Coach Academy](https://coachcampus.com/articles/reframing-perspectives/) -- perspective shifting methodology
- [LLM Discussion: Enhancing Creativity via Role-Play (OpenReview)](https://openreview.net/forum?id=ybaK4asBT2) -- diverse role assignment produces different outputs
- [Score My Interview](https://www.scoremyinterview.com/) -- 13-dimension STAR scoring rubric
- [ApplyArc - Best AI Interview Prep Tools 2026](https://applyarc.com/blog/best-ai-interview-prep-tools-2026) -- competitive feature comparison

### Tertiary (LOW confidence)
- [Third-Person Technique (University of Guelph)](https://www.uoguelph.ca/hftm/third-person-technique) -- virtue attribution in third-person framing; applied to Korean modesty context by inference
- [Decreasing Value of CoT (Wharton)](https://gail.wharton.upenn.edu/research-and-insights/tech-report-chain-of-thought/) -- CoT benefits marginal for reasoning models; simpler structured prompts may suffice

---
*Research completed: 2026-04-07*
*Ready for roadmap: yes*
