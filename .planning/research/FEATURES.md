# Feature Landscape: Interview Enhancement for Resume Panel

**Domain:** AI-powered career episode extraction and resume building
**Researched:** 2026-04-07
**Confidence:** MEDIUM (features verified against multiple AI interview tools and coaching methodologies; no direct competitor does all 6 features together)

## Table Stakes

Features users expect from an AI interview system that claims to "deeply extract hidden episodes." Missing any of these makes the enhancement feel superficial.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **So What Chain (Impact Deepening)** | Every serious AI interview tool scores STAR results on specificity and quantification. Score My Interview's 13-dimension rubric penalizes vague results. ApplyArc generates follow-up questions to push toward metrics. Users who get "pipeline 구축" without "배포 시간 40% 절감 -> 팀 생산성 향상" produce weak resumes. This is the single highest-leverage improvement. | Medium | Triggers on episode save. Needs 2-3 levels of depth: action -> immediate result -> business impact. The "five whys" / inference chaining approach from coaching literature is the right mental model. Implementation is prompt engineering in profiler + a structured follow-up protocol. |
| **Timeline Gap Detection** | Resumly AI and similar tools flag gaps >3 months automatically. ATS systems flag chronological gaps. Recruiters notice gaps immediately. If the system has company/project period data, NOT detecting gaps is a visible omission. | Low | Data already exists in resume-source.json (company periods, project periods). Pure computation: build timeline, find gaps, trigger probing questions. Simplest feature of the six. |
| **AskUserQuestion Structured Selection UI** | The current "type a number" UX is functionally adequate but feels like a CLI prototype. Claude Code's AskUserQuestion renders actual select boxes that are clickable. Every modern AI interview tool has proper UI affordances. This is a hygiene factor. | Low-Medium | Bug #29547 (AskUserQuestion silently fails in plugin skills) was filed and CLOSED (fixed). Workaround: do NOT list AskUserQuestion in skill's allowed-tools frontmatter. Constraint: 1-4 questions per call, 2-4 options each. The existing "2-3 choices + 직접입력" pattern maps perfectly. |

## Differentiators

Features not found in any single competitor. These create genuine competitive advantage for deep episode extraction.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Cross-Company Pattern Detection** | No AI resume tool does cross-company behavioral pattern matching ("가는 곳마다 자동화를 밀었네?"). Existing tools analyze single episodes or match skills to JDs. Detecting that a person consistently does X across companies unlocks episodes they would never self-report because to them it's "just what I do." This is the strongest differentiator. | High | Requires profiler to accumulate episodes across companies, then run pattern analysis. Needs enough episodes (5+) before meaningful patterns emerge. Risk: false positives from thin data. Must surface patterns as probing hypotheses, not assertions. |
| **Perspective Shifting Questions** | Coaching literature confirms reframing/perspective-taking as a powerful technique for unlocking hidden achievements. "네 PM이 이 프로젝트에서 네 역할을 설명한다면?" forces the user out of their self-minimizing frame. No AI interview tool does this. Particularly powerful for Korean users with cultural humility bias ("아직 많이 부족합니다" mindset). | Medium | Prompt engineering in frontstage agents (especially HR and Senior). Best applied to leadership/collaboration episodes. Perspectives to use: manager/상사, junior team member/주니어, PM, external stakeholder/client. Key: agent must generate the perspective-shifted question with a concrete scene cue, not an abstract "your manager would say what?" |
| **Contradiction Detection** | Research confirms AI coaching systems struggle with self-report bias -- users withhold or minimize information. However, LLMs can catch surface-level contradictions in transcripts ("아까 관여 안 했다고 했는데 방금 재설계했다고 했잖아"). No competitor does this. The Korean cultural factor (역할 축소 경향) makes this uniquely valuable for this product's target users. | High | Requires maintaining conversation state across the entire interview. The profiler or orchestrator must track claims per-episode and cross-reference. False positive risk is HIGH -- must distinguish genuine contradiction from context-dependent statements. Delivery tone must be non-accusatory: "아까 이야기랑 연결해보면..." not "앞뒤가 안 맞는데". |

## Anti-Features

Features to explicitly NOT build. Saying no to these is a design choice.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **Real-time live interview copilot** | Final Round AI and LockedIn AI dominate this space with 10M+ users. The resume-panel's value is in episode *extraction*, not in interview *performance*. Building a copilot would dilute focus and require entirely different architecture (audio processing, low-latency responses, stealth mode). | Stay focused on pre-interview episode mining. The output (resume-draft.md) is the deliverable, not live coaching. |
| **STAR answer scoring / grading** | Score My Interview already scores answers on 13 dimensions with 3000+ calibration responses. Building a scorer competes on a dimension where existing tools are mature. The resume-panel's job is to *extract* episodes, not *grade* them. | Use quality signals internally (profiler already grades urgency LOW/MEDIUM/HIGH) but don't expose scores to users. Instead, deepen weak episodes via So What chain. |
| **Generic AI career counseling / career path suggestions** | Apt AI, LockedIn AI, and others provide AI career path analysis. The resume-panel extracts episodes for a specific JD. Scope creep into "what should my career be?" destroys the focused value prop. | Maintain JD-targeted focus. Pattern detection surfaces transferable skills, but always in service of "how does this help your resume for THIS job." |
| **Video/audio mock interview** | Huru.ai, Final Round AI do video mock with body language analysis. Completely different technical stack. The resume-panel runs in Claude Code CLI. | Text-based interview is the correct medium for deep episode extraction. Users type more thoughtful answers than they speak. |
| **Emotional validation / cheerleading** | Explicitly banned in current SKILL.md design principles. Research confirms users find AI cheerleading ("오호! 대단하네요!") actively harmful -- it signals the AI has nothing useful to say. The user's own feedback called cheerleading "talking to a wall." | Recognition over recall: provide concrete scene cues to trigger memory. Factual acknowledgment ("그 프로젝트 규모면 기술적으로 까다로웠을 텐데") is acceptable. Praise without substance is not. |
| **Automatic resume rewriting / AI-generated bullet points from scratch** | The product's philosophy is extraction, not fabrication. AI-generated resume bullets risk hallucination and lose the user's authentic voice. | Extract real episodes through deep interviewing, then organize into resume format. The user's actual experiences are the content; the AI structures and surfaces them. |

## Feature Dependencies

```
AskUserQuestion UI ─── (no dependencies, can ship independently)

Timeline Gap Detection ─── (no dependencies, uses existing resume-source.json data)
     |
     v
So What Chain ─── depends on episode save trigger (existing episode-watcher hook)
     |            also benefits from Timeline Gap (gaps become probing targets)
     v
Cross-Company Pattern Detection ─── requires 5+ episodes across 2+ companies
     |                                depends on So What Chain (richer episodes = better patterns)
     v
Perspective Shifting ─── benefits from Pattern Detection (patterns suggest which perspectives)
     |                   benefits from So What Chain (deeper episodes give more to reframe)
     v
Contradiction Detection ─── requires full conversation state tracking
                             benefits from all other features (more data = better detection)
                             highest false-positive risk, ship last
```

## MVP Recommendation

**Phase 1 (Foundation):** Ship these first, they are independent and high-impact.

1. **AskUserQuestion UI** -- Lowest complexity, pure UX improvement, no prompt engineering. Replaces text number typing with clickable select boxes. Verify bug #29547 fix works in current Claude Code version before committing.
2. **Timeline Gap Detection** -- Lowest complexity among analytical features. Pure data analysis on existing resume-source.json structure. Gaps found become probing targets for other features.
3. **So What Chain** -- Highest leverage single feature. Every episode becomes richer. Profiler enhancement + structured follow-up protocol. This is what turns a mediocre resume into a strong one.

**Phase 2 (Intelligence):** Ship these after episodes are richer from Phase 1.

4. **Cross-Company Pattern Detection** -- Needs episode volume. Phase 1's So What chain produces richer episodes, giving pattern detection better signal.
5. **Perspective Shifting** -- Benefits from pattern data. "가는 곳마다 자동화 밀었으니, 주니어 입장에서 네가 어떤 사람이었을 것 같아?" is stronger when backed by detected patterns.

**Phase 3 (Polish):** Ship last, highest risk of false positives.

6. **Contradiction Detection** -- Most complex, highest false-positive risk, requires careful tone calibration. Benefits from all other features being in place. A premature contradiction call breaks trust; better to ship it refined than ship it early.

**Defer to v2:**
- Episode bank + multi-JD generation
- Mock interview mode
- Career narrative auto-summary

## Detailed Feature Specifications

### So What Chain (Impact Deepening)

**What it is:** When an episode is saved to resume-source.json, the system automatically evaluates whether the "result" field has reached business-level impact. If not, it triggers follow-up questions that push deeper.

**How existing tools do it:**
- ApplyArc generates follow-up questions per STAR component
- Score My Interview penalizes answers scoring <80 for lacking "data depth and quantified business impact"
- Coaching literature uses "inference chaining" (ResearchGate) -- a sequence of Socratic questions that move from surface to root

**How this system should do it:**
- Episode watcher detects new/updated episode
- Profiler evaluates result depth: Level 0 (action only), Level 1 (immediate output), Level 2 (team/project impact), Level 3 (business/org impact)
- If Level < 2, trigger So What follow-up via frontstage agent
- Follow-up uses concrete scene cues, not abstract "so what happened?":
  - "배포 시간 줄었다고 했는데, 줄기 전에 팀이 배포할 때 어떤 상황이었어? 야근? 장애?"
  - "그래서 팀 전체로 보면 한 달에 몇 시간 정도 아꼈을 것 같아?"

**Complexity:** Medium. Prompt engineering + episode-watcher trigger logic. No new infrastructure.

**Risk:** Over-probing fatigue. If every episode triggers 3 follow-ups, the interview drags. Mitigation: limit to episodes where result is Level 0-1, skip if user already gave quantified impact.

### Cross-Company Pattern Detection

**What it is:** After accumulating episodes across multiple companies, the profiler identifies recurring behavioral patterns ("이 사람은 어디를 가든 레거시 시스템을 리팩토링한다") and uses them to probe for unreported episodes at other companies.

**How existing tools do it:**
- No tool does cross-company behavioral pattern matching for episode extraction
- ApplyArc tracks application history but for job search optimization, not episode mining
- Career coaching AI (Wharton research) detects "non-obvious possibilities" across career paths but for career planning, not resume building

**How this system should do it:**
- Profiler runs pattern analysis when episode count >= 5 and companies >= 2
- Pattern categories: technical themes (자동화, 성능최적화, 시스템설계), role patterns (항상 리더, 항상 문제해결사), domain patterns (항상 B2C, 항상 결제)
- Detected patterns become probing hypotheses: "A회사에서도 B회사에서도 레거시 리팩토링 했는데, C회사에서도 비슷한 거 있었을 것 같은데?"
- Must frame as hypothesis, not assertion. User can reject.

**Complexity:** High. Requires semantic analysis across episodes, careful threshold calibration.

**Risk:** False pattern detection from small sample size. Mitigation: require 2+ matching episodes across 2+ companies before surfacing. Confidence framing ("혹시... 있었을 것 같은데" not "분명히 했을 텐데").

### Timeline Gap Detection

**What it is:** Construct a chronological timeline from company/project period data in resume-source.json. Identify gaps > 3 months where no activity is recorded. Trigger probing for unreported experiences.

**How existing tools do it:**
- Resumly AI: flags gaps >3 months, classifies by NLP context clues (travel, study, freelance), cross-references with BLS industry patterns
- General ATS tools: flag chronological gaps as red flags

**How this system should do it:**
- Parse period fields from resume-source.json companies and projects
- Build timeline, find gaps > N months (configurable, default 3)
- For each gap: generate probing question with context: "A 프로젝트 끝난 게 2022년 3월이고 B 시작이 2022년 9월인데, 그 6개월 동안 뭐 했어? 1) 이직 준비 2) 사이드 프로젝트 3) 직접입력"
- Output: list of gaps with timestamps, used by frontstage agents for targeted probing

**Complexity:** Low. Date parsing and arithmetic. Minimal prompt engineering.

**Risk:** Inaccurate period data from user (vague "2022년쯤"). Mitigation: accept fuzzy dates, flag uncertainty.

### Perspective Shifting Questions

**What it is:** Re-ask about an episode from a different person's viewpoint. Forces the user to see their contribution through others' eyes, often revealing impact they minimize about themselves.

**How coaching literature describes it:**
- Reframing is a core coaching technique: shifting the frame changes perception and unlocks new information
- "How would this situation be seen by someone else?" is a standard coaching question
- Behavioral interview guides use "Tell me about a time someone recognized your contribution" as a variant

**How this system should do it:**
- Applied by frontstage agents (HR for leadership/collaboration, Senior for technical impact)
- Perspectives: 상사/manager ("네 상사가 이 프로젝트 회고에서 너에 대해 뭐라고 했을 것 같아?"), 주니어/team member ("주니어 입장에서 네가 한 코드리뷰가 어떤 영향이었을까?"), PM ("PM이 이 기능 배포 회의에서 네 역할을 설명한다면?"), 외부 stakeholder ("클라이언트가 이 결과를 보고 뭐라고 했어?")
- Must use concrete scene cues per the recognition-over-recall principle: "팀 회식에서 상사가 너에 대해 말하는 장면을 상상해봐" not "상사가 뭐라 할 것 같아?"
- Best triggered on episodes with high action-detail but low result-detail (user knows what they did but undersells impact)

**Complexity:** Medium. Prompt engineering in agent prompts. Requires episode analysis to determine WHEN to apply.

**Risk:** Feels artificial if applied to every episode. Mitigation: selective application -- only leadership/collaboration episodes, or when profiler flags self-undervaluation pattern.

### Contradiction Detection

**What it is:** Track claims made throughout the interview. When a later statement contradicts an earlier one, surface it to recover likely-minimized contributions.

**How research describes the challenge:**
- AI coaching literature confirms self-report bias is a fundamental limitation
- LLMs can catch surface contradictions but miss contextual nuance
- Research (Lenny's Newsletter) emphasizes AI must "catch contradictions in customer stories"
- Therapeutic chatbot research warns AI "cannot easily identify inconsistencies or detect underlying issues not explicitly stated"

**How this system should do it:**
- Orchestrator maintains a claim ledger: key assertions per episode (role scope, decision authority, team involvement)
- On each new episode/answer, cross-reference against claim ledger
- Types of contradictions to catch:
  - Role scope: "관여 안 했어" then later "내가 재설계했어"
  - Scale: "작은 프로젝트" then later "MAU 100만"
  - Authority: "팀 결정" then later "내가 제안해서 바뀐 거"
- Delivery tone is critical: non-accusatory, curiosity-framed
  - "아까 이야기랑 연결해보면 재밌는 게 있는데 -- 그때 관여 안 했다고 했잖아, 근데 방금 재설계 이야기가 나왔거든. 혹시 처음엔 안 하려다가 나중에 맡게 된 거야?"
- Never say "앞뒤가 안 맞아" or anything accusatory

**Complexity:** High. Requires stateful tracking across entire conversation, semantic similarity analysis, careful UX tone.

**Risk:** False positives destroy trust. A wrong contradiction accusation makes the user defensive and shuts down sharing. Mitigation: only surface when confidence is high (exact role claim + exact counter-claim), always frame as exploration, and only after rapport is established (Round 2+).

### AskUserQuestion Structured Selection UI

**What it is:** Replace current text-based "1) 뭐뭐 2) 뭐뭐" format with Claude Code's native AskUserQuestion tool that renders actual clickable select boxes.

**Current state of the tool:**
- Available since Claude Code v2.0.21
- Supports 1-4 questions per call, 2-4 options each
- Options have labels and descriptions
- Users can type free text instead of selecting
- 60-second timeout per call
- Bug #29547 (silent failure in plugin skills) was filed and CLOSED/FIXED

**How this system should do it:**
- Do NOT list AskUserQuestion in skill's allowed-tools frontmatter (workaround for permission path issue)
- Map existing question patterns: current "2-3 choices + 직접입력" -> AskUserQuestion options array
- The "직접입력" option maps to user typing free text (native behavior)
- Agent-generated questions need to output structured format that orchestrator converts to AskUserQuestion calls

**Complexity:** Low-Medium. Primarily UX plumbing. Need to verify the fix works in current Claude Code version. Agents currently output text questions; need protocol for structured question format.

**Risk:** AskUserQuestion is NOT available in subagents spawned via Agent tool. The current architecture uses Agent tool to spawn frontstage agents who generate questions, then orchestrator relays to user. AskUserQuestion must be called by the orchestrator, not the subagent. This means the orchestrator must parse agent output and construct the AskUserQuestion call.

## Competitive Landscape Summary

| Feature | This System | Final Round AI | ApplyArc | Score My Interview | Resumly AI |
|---------|------------|----------------|----------|-------------------|------------|
| STAR episode extraction | Core function | Mock Q&A only | Pre-generated answers | Practice scoring | No |
| Impact deepening (So What) | Planned | Basic follow-ups | Follow-up Qs from JD | Scores result depth | No |
| Cross-company patterns | Planned (unique) | No | No | No | No |
| Timeline gap detection | Planned | No | No | No | Yes (3-month threshold) |
| Perspective shifting | Planned (unique) | No | No | No | No |
| Contradiction detection | Planned (unique) | No | No | No | No |
| Structured UI | Planned | Native web app | Native web app | Native web app | Native web app |
| Multi-agent panel | Existing (9 agents) | Single AI | Single AI | Single AI | Single AI |
| Korean humility bias handling | Core design factor | No | No | No | No |
| JD-targeted extraction | Existing | JD-aware Q&A | JD-specific prep | Company-specific scoring | JD skill matching |

**Unique positioning:** No competitor combines multi-agent deep extraction with cross-company pattern detection, perspective shifting, and contradiction detection. The Korean cultural factor (self-minimization) is entirely unaddressed by English-language tools.

## Sources

- [ApplyArc - Best AI Interview Prep Tools 2026](https://applyarc.com/blog/best-ai-interview-prep-tools-2026) -- feature comparison
- [Final Round AI](https://www.finalroundai.com/) -- real-time interview copilot features
- [Score My Interview](https://www.scoremyinterview.com/) -- STAR scoring methodology, 13-dimension rubric
- [Resumly AI - Career Gap Detection](https://www.resumly.ai/blog/how-ai-can-identify-career-gaps-in-resumes-guide) -- timeline gap analysis approach
- [Resumly AI - Chronology Detection](https://www.resumly.ai/blog/using-ai-to-detect-inconsistent-career-chronology-and-fix-resume-gaps-automatically) -- gap detection thresholds
- [Reframing Perspectives - International Coach Academy](https://coachcampus.com/articles/reframing-perspectives/) -- perspective shifting methodology
- [Inference Chaining: A Rational Coaching Technique - ResearchGate](https://www.researchgate.net/publication/341314023_Inference_Chaining_A_Rational_Coaching_Technique) -- So What chain methodology basis
- [Lenny's Newsletter - AI Analysis Trust](https://www.lennysnewsletter.com/p/how-to-do-ai-analysis-you-can-actually) -- contradiction detection in AI analysis
- [Conference Board - AI Career Coaching](https://www.conference-board.org/press/ai-can-provide-career-coaching-but-humans-still-matter) -- AI coaching capabilities and limitations
- [Claude Code AskUserQuestion Issue #29547](https://github.com/anthropics/claude-code/issues/29547) -- plugin skill bug, CLOSED/FIXED
- [HBR - STAR Interview Method](https://hbr.org/2025/02/use-the-star-interview-method-to-land-your-next-job) -- STAR methodology best practices
- [Wharton - AI Career Coach](https://magazine.wharton.upenn.edu/digital/when-ai-becomes-your-career-coach/) -- cross-career pattern recognition research
