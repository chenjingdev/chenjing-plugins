# Domain Pitfalls

**Domain:** LLM-based multi-agent interview system enhancement (contradiction detection, pattern matching, impact chaining, perspective shifting, timeline gap detection, structured UI migration)
**Researched:** 2026-04-07

## Critical Pitfalls

Mistakes that cause rewrites or major issues.

### Pitfall 1: False Positive Contradiction Accusations Destroy User Trust

**What goes wrong:** The contradiction detector flags "inconsistencies" that are actually valid nuance. Example: user says "I wasn't involved in the architecture decision" about Company A, then later says "I redesigned the data pipeline" at Company A. The system flags this as a contradiction, but the user was talking about two different projects. The system accuses the user of being inconsistent, and the user feels attacked or mistrusted.

**Why it happens:** LLMs lack dedicated mechanisms for tracking specific assertions with their full context (which company, which project, which time period). They pattern-match surface-level semantic contradictions without understanding scope boundaries. Research shows LLMs process text as continuous sequence without compartmentalizing assertions by context. In a multi-turn interview spanning multiple companies and years of experience, the same topic (e.g., "architecture") appears in completely different scopes.

**Consequences:**
- User becomes defensive and gives shorter, less detailed answers
- Breaks the core interview dynamic (user should feel safe to elaborate, not interrogated)
- Korean users who are already self-deprecating will shut down entirely if accused of inconsistency
- Directly undermines the stated goal: "recovering episodes hidden by modesty"

**Prevention:**
1. Contradiction detection must be scope-bound: same company + same project + same time period before flagging
2. Use soft framing, never accusatory: "You mentioned X earlier about the A project -- is the B project's pipeline work a separate thing, or did those overlap?" with choices
3. Require minimum confidence threshold -- only surface contradictions where the overlap is genuinely in the same context
4. Store assertions with full metadata (company, project, time period, episode ID) so comparison is apples-to-apples
5. Test with real Korean interview transcripts where role-minimization looks like contradiction but is not

**Detection (warning signs):**
- Users start answering "yes/no" instead of elaborating after a contradiction challenge
- Users say "I already said that" or "that's different"
- Contradiction flags fire on >20% of episodes (too sensitive)

**Which phase should address it:** Contradiction detection phase -- must be solved in the prompt design, not patched later. The framing and scope-binding rules need to be baked into the agent prompt from day one.

**Confidence:** HIGH -- this is well-documented in LLM research and directly maps to this system's goals.

### Pitfall 2: Prompt Bloat Degrades All Agent Quality

**What goes wrong:** Adding 6 features to existing agent prompts (especially profiler.md, senior.md, c-level.md) causes prompts to exceed the effective attention range. Agent quality degrades across ALL tasks, not just the new ones. The "lost in the middle" effect means that instructions in the middle of long prompts get underweighted.

**Why it happens:** 2025 ICLR research ("Why Do Multi-Agent LLM Systems Fail?") identifies 14 failure modes, including "role specification disobedience" where agents drift from their assigned role when prompts become complex. Current agents are already substantial (senior.md is ~130 lines, profiler.md is ~135 lines). Adding So What chain logic, pattern detection rules, contradiction detection criteria, perspective shifting instructions, and timeline gap analysis to existing prompts could double their size. Research shows prompt bloat causes >50% accuracy degradation in tool selection alone.

**Consequences:**
- Existing working features (e.g., researcher fact-based questions, "one question per turn" rule) break
- New features work inconsistently -- sometimes triggered, sometimes ignored
- The "never praise" and "never open questions" rules get violated as prompt complexity increases
- Agents start producing blended outputs that half-follow old rules and half-follow new rules

**Prevention:**
1. Do NOT add all 6 features as inline instructions to existing agent prompts
2. Use the profiler as the intelligence hub -- So What chain, pattern detection, and timeline gap analysis should be profiler responsibilities that produce structured outputs consumed by front-stage agents
3. Keep front-stage agent prompts focused on their existing role + minimal integration points (e.g., "If profiler provides a contradiction flag, use this framing template")
4. Measure: after adding each feature, test that existing behavior (fact-based questions, no praise, selection format) still works
5. Consider a separate analysis config/context block that gets injected only when relevant, not baked into every prompt

**Detection (warning signs):**
- Agents start violating existing rules (praise, open questions, multiple questions per turn)
- Agent outputs become longer and less focused
- The same agent gives different quality responses depending on which features happen to "activate"

**Which phase should address it:** Architecture decision that must be settled BEFORE any feature implementation begins. The integration pattern (profiler-centric vs. distributed) determines all subsequent work.

**Confidence:** HIGH -- backed by ICLR 2025 multi-agent failure research and directly observable in the existing prompt sizes.

### Pitfall 3: AskUserQuestion Cannot Be Called from Sub-Agents

**What goes wrong:** AskUserQuestion is designed for the top-level orchestrator only. Sub-agents spawned via the Agent tool cannot render the interactive UI. If the system design assumes that individual agents (senior, c-level, recruiter) will directly use AskUserQuestion to present choices, the UI will silently fail -- returning empty answers with no error.

**Why it happens:** Claude Code's architecture routes AskUserQuestion through the terminal UI layer. Sub-agents run in a sandboxed context without terminal access. There was also a bug (issue #29547) where listing AskUserQuestion in a skill's `allowed-tools` caused the permission evaluator to auto-approve it without rendering the UI, returning empty strings.

**Consequences:**
- Interview completely breaks if agents try to ask selection questions via AskUserQuestion
- Silent failure (empty response, no error) makes debugging extremely hard
- Workaround of putting AskUserQuestion in `allowed-tools` makes it worse, not better

**Prevention:**
1. AskUserQuestion must ONLY be called by the orchestrator (SKILL.md level), never by sub-agents
2. The current architecture is actually correct: agents return text questions, orchestrator presents them. AskUserQuestion migration means the orchestrator translates agent text output into AskUserQuestion calls
3. Do NOT refactor agents to "natively" use AskUserQuestion -- keep the agent -> text -> orchestrator -> AskUserQuestion flow
4. Do NOT add AskUserQuestion to the skill's `allowed-tools` frontmatter (the workaround from #29547)
5. Test the AskUserQuestion flow in the actual plugin context early, not just in standalone Claude Code

**Detection (warning signs):**
- Agents return empty strings where user responses should be
- Interview "skips" questions without user input
- Works in development/testing but breaks when loaded as plugin

**Which phase should address it:** AskUserQuestion UX phase -- the very first implementation task should be a proof-of-concept that confirms the orchestrator-level AskUserQuestion call works in the plugin skill context.

**Confidence:** HIGH -- directly confirmed by Claude Code issue #29547 and official documentation stating sub-agents cannot use AskUserQuestion.

### Pitfall 4: So What Chain Creates Interrogation Fatigue

**What goes wrong:** The So What chain ("pipeline build" -> "deploy time reduced" -> "team productivity improved" -> "business revenue impact") asks 3-4 follow-up questions for EVERY episode. With 15-20 episodes across multiple companies, this adds 45-80 extra questions to an already long interview. Users disengage or start giving low-quality "I don't know the numbers" responses.

**Why it happens:** The feature design assumes users can articulate business impact for every technical/creative action. In reality, many practitioners (especially individual contributors) genuinely don't know downstream business metrics. Korean cultural modesty compounds this -- users feel pressured to manufacture impact they're unsure about, or they deflect entirely.

**Consequences:**
- Interview becomes 2-3x longer than necessary
- User quality of responses drops after the 3rd or 4th "so what" chain
- Users start selecting "don't know" or the weakest option to end the chain faster
- Fabricated impact claims end up in the resume (worse than no impact claim)

**Prevention:**
1. So What chain should be selective, not universal -- only trigger for episodes where the profiler identifies high potential for business impact
2. Maximum 2 levels deep (action -> immediate result -> one level of business impact). Stop there.
3. If user says "don't know the numbers" at any level, stop the chain for that episode and note it as "impact: qualitative"
4. Batch the chain with episode collection -- ask the So What follow-up immediately after collecting the episode, not as a separate pass through all episodes
5. Set a session-level limit: max 5 So What chains per interview, prioritized by JD relevance

**Detection (warning signs):**
- Average user response length drops after the 3rd consecutive So What chain
- Users select "don't know" or "no metrics" option >50% of the time
- Interview duration exceeds 45 minutes without proportional episode quality improvement

**Which phase should address it:** So What chain phase -- design the trigger criteria and depth limits before implementing the chain logic.

**Confidence:** HIGH -- interview fatigue is well-documented in UX research; the compound effect with Korean modesty is specific to this user base.

## Moderate Pitfalls

### Pitfall 5: Pattern Detection Hallucinates Patterns That Don't Exist

**What goes wrong:** The profiler "discovers" cross-company patterns that are superficial or fabricated. Example: user used Python at both companies, profiler declares "you have a pattern of introducing Python-based automation everywhere" when the user was just using the company's existing stack both times. The false pattern then drives interview questions that waste time and confuse the user.

**Why it happens:** LLMs are pattern-completion machines -- they will find patterns even in noise. With only 3-5 companies and 10-20 episodes, the sample size is too small for genuine statistical patterns. The profiler is incentivized (by its prompt) to find patterns, so it optimizes for pattern generation rather than pattern validity.

**Prevention:**
1. Require minimum 3 episodes across 2+ companies before declaring a pattern
2. Pattern must involve user AGENCY (they chose to do X), not just coincidence (both companies happened to use X)
3. Present patterns as hypotheses to validate, not facts: "Looks like you pushed for automation at both A and B -- was that a conscious choice?" with option to reject
4. Profiler prompt must explicitly state: "If no genuine pattern exists, say so. Do not fabricate patterns."
5. Include a "null finding is acceptable" instruction -- don't force output

**Detection (warning signs):**
- Patterns reference technology/domain that the user didn't choose (company default stack)
- User responds "no, that's just how it was" to pattern-based questions
- Pattern descriptions are vague ("you tend to improve things") rather than specific

**Which phase should address it:** Pattern detection phase -- prompt engineering and validation rules.

**Confidence:** MEDIUM -- based on general LLM hallucination research applied to this specific use case.

### Pitfall 6: Perspective Shifting Produces Speculation, Not Episodes

**What goes wrong:** "How would your PM describe your role?" generates speculative fiction, not factual episodes. The user invents what they think the PM would say rather than recalling actual feedback they received. This speculation then gets stored as an episode, polluting resume-source.json with unverifiable claims.

**Why it happens:** The third-person technique is designed for therapy/coaching where feelings matter. In resume writing, only verifiable actions and results matter. Research on the third-person technique notes that "people will often attribute virtues to themselves where they see vices in others" -- the reverse also applies. Users may underattribute their own impact even in the third-person framing if they're culturally modest.

**Consequences:**
- Resume contains claims the user can't substantiate in an actual interview
- Speculative episodes dilute the quality of genuine episodes
- User may feel uncomfortable speculating about others' opinions

**Prevention:**
1. Frame perspective shifts as recall prompts, not speculation prompts: "Did your PM ever mention your contribution to X in a review or standup?" not "How would your PM describe you?"
2. Require the perspective shift to surface a SPECIFIC event (a meeting, a review, a Slack message) where feedback was given
3. Tag perspective-shifted episodes with a "source: third-party feedback" flag so the resume writer knows to frame them as received feedback, not self-assessment
4. Limit to 2-3 perspective shifts per interview -- use them strategically for leadership/collaboration episodes only (where HR agent is active)
5. If user says "I don't know what they'd say," accept it and move on -- don't push

**Detection (warning signs):**
- Episodes from perspective shifts contain no specific events, just general assessments
- User answers start with "I think they would say..." (speculation) vs "They told me..." (recall)
- Perspective-shifted episodes are significantly vaguer than direct episodes

**Which phase should address it:** Perspective shifting phase -- the question framing must be recall-oriented from the start.

**Confidence:** MEDIUM -- based on interview technique research and the specific dynamics of Korean modesty culture.

### Pitfall 7: Timeline Gap Probing Hits Sensitive Topics

**What goes wrong:** Automated gap detection finds a 6-month gap and probes it. The gap was due to health issues, family crisis, burnout, or job loss. The system's relentless probing feels invasive. Unlike human interviewers who read emotional cues, the LLM system has no ability to detect discomfort and back off.

**Why it happens:** The system is designed to be thorough. "A 6-month gap between Project A and Project B -- what happened?" is mechanically correct but socially tone-deaf. Korean work culture adds pressure -- unexplained gaps carry significant stigma, making the probe even more uncomfortable.

**Consequences:**
- User has a strongly negative emotional reaction and loses trust in the system
- User gives a vague non-answer that gets stored as an episode of poor quality
- User may quit the interview entirely

**Prevention:**
1. Gap probing must offer an explicit "skip" option: "There's a 6-month gap here. 1) I was doing X, 2) Personal reasons -- skip this, 3) Tell me more about why this matters"
2. Accept "personal reasons" immediately and move on -- never follow up on a skipped gap
3. Frame gaps as opportunities, not interrogations: "Some people use gaps for learning, travel, or freelancing -- did you pick up anything useful during this period?" with a clear "no, nothing relevant" option
4. Only probe gaps > 3 months (shorter gaps are normal between jobs)
5. Maximum 2 gap probes per interview -- if there are more gaps, prioritize the ones most relevant to JD

**Detection (warning signs):**
- User selects "skip" or "personal reasons" -- this is not a failure, it's working correctly
- User gives one-word answers to gap questions
- Session ends shortly after a gap probe

**Which phase should address it:** Timeline gap detection phase -- the sensitivity rules must be in the initial design, not added as a patch.

**Confidence:** HIGH -- employment gap sensitivity is universally documented; Korean cultural context amplifies it significantly.

### Pitfall 8: Episode-Watcher Hook Overload from Rapid Saves

**What goes wrong:** So What chain and pattern detection cause more frequent resume-source.json saves (each follow-up adds detail to an existing episode). The episode-watcher hook fires on every save, potentially triggering profiler calls in rapid succession. Multiple background profiler agents run simultaneously, producing conflicting or duplicate findings.

**Why it happens:** The current hook uses episode count delta (>=3) as a trigger. With So What chain enriching existing episodes (modifying result fields, adding impact data), the hook may fire on structure changes even when the episode count hasn't changed by 3. If the trigger logic is loosened to catch enrichment, it may fire too frequently. Multiple simultaneous profiler calls create race conditions on findings-inbox.jsonl.

**Consequences:**
- Multiple profiler instances write to findings-inbox.jsonl simultaneously, causing append conflicts
- Duplicate or contradictory findings reach the orchestrator
- Hook fires every 30 seconds during active So What chain probing, consuming API tokens
- meta.json gets overwritten by concurrent profiler instances

**Prevention:**
1. Add a cooldown timer to the hook: minimum 2 minutes between profiler triggers, regardless of delta
2. Use a lock file mechanism: `.resume-panel/profiler.lock` -- if lock exists and is < 5 minutes old, skip trigger
3. Distinguish between "new episode" saves and "episode enrichment" saves -- only new episodes count toward the delta threshold
4. The profiler should read meta.json at START of execution and skip if another call is in-flight (check last_profiler_call timestamp)
5. findings-inbox.jsonl append should use atomic write (write to temp file, then rename) to prevent corruption

**Detection (warning signs):**
- findings.json contains duplicate entries with similar timestamps
- profiler_calls count in meta.json jumps by 3-4 in a single interview segment
- API token usage spikes during So What chain segments

**Which phase should address it:** Must be addressed in the first feature phase that increases save frequency (So What chain). Hook hardening should be a prerequisite task.

**Confidence:** MEDIUM -- based on analysis of the existing episode-watcher.mjs code and the predictable increase in save frequency from new features.

## Minor Pitfalls

### Pitfall 9: AskUserQuestion 4-Option Limit Conflicts with Current Design

**What goes wrong:** Current agents generate 2-3 choices + "direct input" = 3-4 options. AskUserQuestion supports 2-4 options per question, 1-4 questions simultaneously. This is a tight fit. Some agents (recruiter doing gap analysis) may need 4 choices + "direct input" = 5 options, exceeding the limit. The "direct input" option itself is problematic in a select box -- selecting "direct input" should open a text field, but AskUserQuestion's select box just returns the string "direct input."

**Prevention:**
1. Standardize all agents to produce exactly 2 choices + "direct input" = 3 options (within limit)
2. For "direct input" handling: after user selects it via AskUserQuestion, the orchestrator should follow up with a free-text prompt asking for their input
3. Document the option limit in agent prompts so they don't generate 4+ choices
4. Test edge cases: what happens when user selects "direct input" in the select box?

**Which phase should address it:** AskUserQuestion UX phase -- this is a constraint that affects all agent prompt designs.

**Confidence:** MEDIUM -- based on documented AskUserQuestion constraints (2-4 options, 1-4 questions).

### Pitfall 10: Conversation Briefing Grows Unbounded

**What goes wrong:** The conversation briefing ("topics covered, not yet covered, user keywords") that gets passed to each agent grows as the interview progresses. By Round 2-3, with 15+ episodes, the briefing itself becomes a significant chunk of each agent's context, competing with the agent's actual instructions for attention.

**Prevention:**
1. Cap briefing to fixed structure: max 5 "covered" items (most recent), max 5 "not covered" items (highest priority), last answer summary (2 sentences max)
2. Rotate covered items: once a topic has been fully explored, remove it from the briefing
3. The profiler's "exploration strategy" output should replace the raw briefing for later rounds

**Which phase should address it:** Any phase that adds new information types to the briefing (pattern findings, contradiction flags, timeline gaps). Set the cap before adding new content types.

**Confidence:** MEDIUM -- extrapolated from context window management research and the existing briefing structure.

### Pitfall 11: Feature Interaction Creates Contradictory Signals

**What goes wrong:** Multiple analysis features fire simultaneously with conflicting recommendations. Example: Pattern detection says "user always automates -- probe for automation at Company C," but timeline gap detection says "6-month gap after Company B -- probe the gap," and the So What chain is still pending for the last episode. The orchestrator doesn't know which to prioritize and either overwhelms the user with rapid-fire different-topic questions or arbitrarily picks one, ignoring the others.

**Prevention:**
1. Define explicit priority ordering: (1) active So What chain completion, (2) HIGH urgency findings, (3) current-company episode collection, (4) gap probes, (5) pattern-based probes
2. Only one analysis-driven interruption per 3 regular interview turns
3. Queue analysis findings rather than processing them immediately -- the existing findings-inbox.jsonl + urgency system is the right architecture, just enforce that the orchestrator processes one finding at a time
4. The orchestrator's SKILL.md must include a "signal conflict resolution" section

**Which phase should address it:** Must be addressed in the orchestrator integration phase (after individual features are built but before they're all active simultaneously). However, the priority ordering should be decided during planning.

**Confidence:** MEDIUM -- this is a system integration risk that becomes critical only when 3+ features are active simultaneously.

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| So What Chain | Interrogation fatigue; hook overload from rapid saves | Selective trigger (profiler-gated), max 2 levels deep, cooldown timer on hook |
| Pattern Detection | Hallucinated patterns from small sample sizes | Minimum evidence threshold (3 episodes, 2+ companies), "null finding is OK" |
| Timeline Gap Detection | Sensitive topic collision; over-probing short gaps | Always offer "skip" option, >3 months only, max 2 probes per session |
| Perspective Shifting | Speculation instead of recall; cultural mismatch | Frame as recall ("Did PM say...") not speculation ("What would PM say...") |
| Contradiction Detection | False positives destroy trust; scope confusion | Scope-bound to same company+project+period, soft framing, high confidence threshold |
| AskUserQuestion UX | Sub-agent cannot call it; option count limits; "direct input" flow | Orchestrator-only calls, standardize to 3 options, two-step flow for direct input |
| All features combined | Signal conflict; prompt bloat; interview pacing breakdown | Priority ordering, profiler-centric architecture, one interruption per 3 turns |

## Sources

- [Why Do Multi-Agent LLM Systems Fail? (ICLR 2025)](https://arxiv.org/abs/2503.13657) -- 14 failure modes including role specification disobedience and inter-agent misalignment
- [Contradiction Detection in RAG Systems (2025)](https://arxiv.org/html/2504.00180v1) -- challenges of evaluating contradictions across large context sets
- [Self-contradictory Hallucinations of LLMs (EMNLP 2023/ICLR 2024)](https://openreview.net/forum?id=EmQSOi1X2f) -- 17.7% self-contradiction rate in ChatGPT outputs
- [AskUserQuestion plugin skill bug #29547](https://github.com/anthropics/claude-code/issues/29547) -- silent empty returns when AskUserQuestion is in allowed-tools
- [RAG-MCP: Mitigating Prompt Bloat (2025)](https://arxiv.org/pdf/2505.03275) -- prompt bloat causes >50% accuracy degradation in tool selection
- [Lost in Context: How to Keep LLMs Focused](https://softwareguru.substack.com/p/lost-in-context-how-to-keep-llms) -- "lost in the middle" effect in long prompts
- [Third-Person Technique (University of Guelph)](https://www.uoguelph.ca/hftm/third-person-technique) -- people attribute virtues to self, vices to others in third-person framing
- [Korean Job Interview Tips (Wise)](https://wise.com/gb/blog/south-korean-job-interview-tips) -- cultural modesty and self-deprecation in professional settings
- [AI Career Gap Detection (Resumly)](https://www.resumly.ai/blog/how-ai-can-identify-career-gaps-in-resumes-guide) -- 68% recruiter rejection rate for unexplained gaps
