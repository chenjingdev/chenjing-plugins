# Architecture Patterns

**Domain:** Interview enhancement features for multi-agent resume builder (Claude Code plugin)
**Researched:** 2026-04-07

## Existing System Map

Before defining integration points, here is the system as it stands today:

```
User <──> Orchestrator (SKILL.md)
              │
              ├── Agent tool ──> Frontstage agents (senior, c-level, recruiter, hr, coffee-chat)
              │                      └── return question + options to orchestrator
              │
              ├── Agent tool (background) ──> Backstage agents (researcher, project-researcher, profiler)
              │                                    └── profiler dispatches sub-agents
              │                                    └── profiler writes findings-inbox.jsonl
              │
              ├── Bash tool ──> resume-source.json (episode storage, STAR format)
              │
              └── Read tool ──> .resume-panel/findings.json (on-demand)

PostToolUse hook (episode-watcher.mjs)
    │
    ├── Role 1: resume-source.json change detection → delta analysis → "profiler call needed" message
    │
    └── Role 2: findings-inbox.jsonl consumption → urgency routing → additionalContext injection
         ├── HIGH → immediate injection
         ├── MEDIUM → injection on company change
         └── LOW → stored in findings.json, user pulls on-demand
```

### Key Data Flows

1. **Episode Collection:** User answers → orchestrator extracts episode → Bash writes to resume-source.json
2. **Autonomous Analysis:** PostToolUse hook detects resume-source.json change → sends profiler-call message via additionalContext → orchestrator calls profiler as background Agent → profiler dispatches sub-agents → writes findings-inbox.jsonl
3. **Findings Delivery:** Next PostToolUse hook invocation → consumes inbox → routes by urgency via additionalContext → orchestrator delivers to user between Q&A cycles

### Architectural Constraints

| Constraint | Impact on New Features |
|-----------|----------------------|
| Hook output capped at 10,000 chars | Analysis results must be concise or stored in files |
| AskUserQuestion must NOT be in skill's `allowed-tools` (bug #29547) | AskUserQuestion works via normal permission path; do not list in frontmatter |
| PostToolUse hook is synchronous, 10s timeout | No heavy computation in hook; analysis stays in profiler agent |
| Agent tool is the only way to run sub-agents | New analysis logic lives in agent prompts, not in scripts |
| Profiler runs on claude-sonnet | All analysis features must be expressible as prompt instructions, not code |
| 1 question per turn rule | Orchestrator gates all user-facing output; agents return exactly 1 question |

## Recommended Architecture: Feature Integration Map

Each of the 6 features integrates at specific points in the existing pipeline. No new agents are created (per PROJECT.md constraint). No new hook scripts are created.

### Feature 1: So What Chain (Impact Deepening)

**Integration Point:** Orchestrator (SKILL.md) — episode save trigger
**When:** Immediately after orchestrator extracts and saves an episode to resume-source.json
**How:**

```
User answers question
   → Orchestrator extracts episode (S/T/A/R)
   → Orchestrator saves to resume-source.json
   → IF episode.result lacks business metrics (no numbers, no %, no impact language)
      → Orchestrator generates So What follow-up question
      → Present to user with options:
         1) [specific metric A]
         2) [specific metric B]
         3) [impact didn't get measured]
         4) direct input
   → IF user provides metric → update episode.result in resume-source.json
   → Continue to next question
```

**Data Flow Direction:** Orchestrator-internal loop. No agent call needed for basic So What. The orchestrator checks the saved episode's `result` field for metric presence and triggers a follow-up.

**Why in orchestrator, not profiler:** So What is synchronous and immediate. The user just gave an answer; drilling deeper must happen in the same conversational turn. Sending it to the profiler (async background) would break flow. The orchestrator already has the episode context.

**Advanced mode (profiler-assisted):** For episodes where the impact chain is long (action → intermediate result → business impact → revenue), the profiler can suggest deeper So What chains during its periodic analysis. These arrive via findings-inbox.jsonl as MEDIUM urgency: "Episode X has action 'migrated to Kafka' but result only says 'performance improved'. Suggest asking: throughput change? latency change? cost impact?"

### Feature 2: Contradiction Detection

**Integration Point:** Profiler agent — analysis pass enhancement
**When:** During profiler's periodic analysis (triggered by episode-watcher delta detection)
**How:**

```
Profiler receives all episodes + conversation history
   → New analysis section: Contradiction Scan
   → Compare across episodes for:
      a) Role claims: "I led the project" in ep-3 vs "I joined midway" in ep-7
      b) Timeline overlap: Same time period, different projects claimed as full-time
      c) Scale inconsistency: "3-person team" in one answer, "managed 10 people" in another
      d) Responsibility inflation/deflation: Pattern of claiming less/more than evidence supports
   → Output contradictions to findings-inbox.jsonl with urgency:
      HIGH: Direct factual contradiction (dates, numbers, role)
      MEDIUM: Soft contradiction (tone/framing mismatch across episodes)
```

**Data Flow Direction:** resume-source.json → profiler → findings-inbox.jsonl → hook → additionalContext → orchestrator → user

**Orchestrator handling of contradiction findings:**

```
[resume-panel:HIGH] 모순 발견: ep-3에서 "프로젝트 리드"라고 했는데 ep-7에서 "중간에 합류"라고 했어.
   → Orchestrator presents: "아까 {프로젝트}에서 리드라고 했는데, 방금은 중간에 합류라고 했거든.
      1) 처음부터 리드 — 맞음
      2) 중간에 합류해서 나중에 리드가 됨
      3) 직접입력"
   → Update the contradicting episode with clarified info
```

**Why in profiler, not orchestrator:** Contradiction detection requires comparing ALL episodes across ALL companies. The orchestrator processes one Q&A at a time and does not re-read the full episode history every turn. The profiler already has a "compare everything" mandate.

### Feature 3: Pattern Recognition (Cross-Company)

**Integration Point:** Profiler agent — analysis pass enhancement
**When:** During profiler's periodic analysis, specifically when episodes from 2+ companies exist
**How:**

```
Profiler receives all episodes
   → New analysis section: Cross-Company Pattern Scan
   → Detect recurring themes:
      a) Repeated role pattern: "always the one who introduces new tools" across 3 companies
      b) Domain consistency: "performance optimization" appears at every job
      c) Transition pattern: "inherited legacy → modernized → handed off" at 2+ companies
      d) Skill cluster: "data pipeline + monitoring + alerting" appears together repeatedly
   → Output patterns to findings-inbox.jsonl as MEDIUM urgency:
      "Pattern detected: User consistently introduced CI/CD at every company.
       This is a 'change agent' narrative. Ask about: motivation, resistance, outcomes."
   → Profiler also updates "발굴 전략 제안" section with pattern-based questions
```

**Data Flow Direction:** Same as contradiction detection. Profiler → findings-inbox.jsonl → orchestrator

**Orchestrator handling:** Pattern findings arrive as MEDIUM and get delivered at company transitions. The orchestrator uses them to generate questions like: "{회사A}에서도 CI/CD 도입했고, {회사B}에서도 했네. 이건 팀에서 요청한 건지 본인이 알아서 밀었는지 어느 쪽?"

**Why MEDIUM not HIGH:** Patterns are insight-generation, not error-correction. They enrich the interview but don't need to interrupt the current Q&A cycle.

### Feature 4: Timeline Gap Detection

**Integration Point:** Profiler agent — analysis pass enhancement + episode-watcher.mjs delta detection enhancement
**When:** Two trigger points:

1. **Profiler analysis (primary):** When profiler runs, it examines the full timeline
2. **Hook-level pre-check (optional optimization):** episode-watcher can flag obvious gaps by date arithmetic

**Profiler-side (primary):**

```
Profiler receives resume-source.json
   → New analysis section: Timeline Analysis
   → Build timeline from companies[].projects[].period
   → Detect:
      a) Unexplained gaps > 3 months between companies
      b) Overlapping periods that don't make sense
      c) Suspiciously short stints (< 6 months, no episode)
      d) Long tenures with few episodes (5 years, 1 episode = under-probed)
   → Output to findings-inbox.jsonl:
      HIGH: "2019.03-2019.11 gap between 회사A and 회사B. 8 months unexplained."
      MEDIUM: "회사C tenure 4 years but only 2 episodes. Under-probed."
```

**Hook-side (optional enhancement to episode-watcher.mjs):**

```javascript
// In delta detection section, after episode count check:
// Quick timeline gap check — only runs when companies array changes
function detectTimelineGaps(source) {
  const periods = []; // extract all company/project periods
  // Sort by start date, find gaps > 90 days
  // Return gap descriptions
}
// Include in profiler trigger message: "타임라인 갭 발견: 2019.03-2019.11"
```

**Why split between hook and profiler:** The hook can do cheap date arithmetic (no LLM needed) to flag gaps immediately. The profiler does deeper analysis — is this a gap that matters? Does it overlap with education? Is it a career break the user already mentioned?

**Data Flow Direction:** resume-source.json → hook (quick gap flag) → profiler (deep analysis) → findings-inbox.jsonl → orchestrator → user

### Feature 5: Perspective Shifting Questions

**Integration Point:** Frontstage agents (senior, c-level, recruiter, hr, coffee-chat) — question generation enhancement
**When:** During Rounds 1-3, when an agent generates a question about an existing episode
**How:**

```
Agent receives episode context + conversation briefing
   → In addition to normal question patterns, agents can now generate perspective-shift questions:
   
   시니어: "그 프로젝트에서 같이 일한 PM이 너한테 제일 고마워한 게 뭘 거 같아?
      1) 기술적으로 불가능하다고 생각한 걸 해결해줬을 때
      2) 일정 맞추려고 야근해서 데드라인 지켜줬을 때
      3) 직접입력"
   
   인사담당자: "네가 온보딩해준 주니어가 너에 대해 한 마디로 뭐라고 할 거 같아?
      1) 코드 리뷰 꼼꼼하게 해주는 사람
      2) 질문하면 바로 답 주는 사람
      3) 직접입력"
```

**Why in existing agents, not a new mechanism:** Perspective shifting is a question *technique*, not a data *analysis*. It belongs in the agent prompt instructions as an additional question pattern, alongside existing patterns (domain depth, scale verification, problem solving).

**Implementation pattern:** Add a "관점 전환 질문 패턴" section to each frontstage agent's prompt:

```markdown
### 관점 전환 질문 패턴 (선택적 — 에피소드가 2개 이상 수집된 후 사용)

유저가 자기 역할을 축소 표현하는 경향이 있을 때, 타인 시점으로 재질문한다.
관점 전환 가능한 대상: PM, 주니어, 상사, 고객, 다른 팀 동료

{직군에 맞는 예시들}
```

**Trigger condition:** Orchestrator decides when to request perspective-shift questions from agents. Ideal timing: when profiler flags "과소평가형" communication style, or after 2+ episodes from the same project.

**Data Flow Direction:** Profiler analysis ("user tends to undervalue their role") → conversation briefing → agent generates perspective-shift question → orchestrator delivers to user

### Feature 6: AskUserQuestion UX Replacement

**Integration Point:** Orchestrator (SKILL.md) — output formatting
**When:** Every user-facing question throughout all rounds
**How:**

```
CURRENT:
   Orchestrator outputs text:
   "[시니어] Kafka 도입한 거 봤는데, 이거 직접 밀었어?
     1) 내가 제안해서 도입
     2) 기존에 있었고 활용만
     3) 직접입력"
   → User types "1" or free text

PROPOSED:
   Orchestrator calls AskUserQuestion tool:
   AskUserQuestion({
     question: "[시니어] Kafka 도입한 거 봤는데, 이거 직접 밀었어?",
     options: [
       "내가 제안해서 도입",
       "기존에 있었고 활용만",
       "직접입력"
     ]
   })
   → User clicks select box or types free text
```

**Critical constraint (bug #29547):** AskUserQuestion MUST NOT be listed in the skill's `allowed-tools` frontmatter. If listed, it silently auto-completes with empty answers. The fix: do not add it to allowed-tools; let it go through the normal permission path where `requiresUserInteraction()` is checked. The bug is closed/fixed in newer Claude Code versions, but the safest approach is to omit it from allowed-tools regardless.

**Fallback behavior:** If AskUserQuestion fails (e.g., non-interactive environment, older Claude Code version), the orchestrator should fall back to text-based numbered options. The SKILL.md should include: "AskUserQuestion 사용 시도. 실패하면 기존 텍스트 번호 방식으로 폴백."

**Data Flow Direction:** Agent returns question+options → orchestrator formats as AskUserQuestion call → user selects → orchestrator processes response

**Multi-question constraint:** AskUserQuestion supports 1-4 questions per call with 2-4 options each. The "한 턴에 질문 1개" rule means we use 1 question per call. The multiSelect option exists but should not be used (our questions are single-choice).

## Component Boundaries (Updated)

| Component | Current Responsibility | New Responsibility |
|-----------|----------------------|-------------------|
| Orchestrator (SKILL.md) | Round management, agent dispatch, episode extraction, save | + So What chain trigger, + AskUserQuestion formatting, + contradiction/pattern finding delivery |
| Profiler (profiler.md) | Profile building, agent dispatch, findings writing | + Contradiction scan, + Cross-company pattern scan, + Timeline analysis |
| episode-watcher.mjs | Delta detection, findings routing | + Timeline gap quick-check (optional) |
| Frontstage agents | Question generation with options | + Perspective shifting question patterns |
| resume-source.json | Episode storage (STAR format) | No schema change needed |
| findings-inbox.jsonl | Finding records | + New finding types: contradiction, pattern, timeline_gap |

## New Finding Types Schema

```json
// Contradiction
{
  "id": "f-030",
  "urgency": "HIGH",
  "source": "profiler",
  "type": "contradiction",
  "message": "ep-3 '프로젝트 리드'와 ep-7 '중간 합류' 모순",
  "context": {
    "episode_a": "ep-3",
    "episode_b": "ep-7",
    "field": "role",
    "claim_a": "프로젝트 리드",
    "claim_b": "중간에 합류"
  },
  "created_at": "2026-04-07T10:00:00Z"
}

// Cross-company pattern
{
  "id": "f-031",
  "urgency": "MEDIUM",
  "source": "profiler",
  "type": "pattern_detected",
  "message": "3개 회사에서 반복: 레거시 시스템 → 현대화 주도. 'change agent' 내러티브 가능.",
  "context": {
    "pattern_name": "modernizer",
    "related_episodes": ["ep-2", "ep-5", "ep-9"],
    "companies": ["회사A", "회사B", "회사C"],
    "suggested_questions": [
      "이 패턴이 의식적인 건지 우연인지",
      "현대화 프로젝트를 왜 항상 본인이 맡게 되는지"
    ]
  },
  "created_at": "2026-04-07T10:00:00Z"
}

// Timeline gap
{
  "id": "f-032",
  "urgency": "HIGH",
  "source": "profiler",
  "type": "timeline_gap",
  "message": "2019.03-2019.11 사이 8개월 공백. 회사A 퇴사 → 회사B 입사 사이.",
  "context": {
    "gap_start": "2019-03",
    "gap_end": "2019-11",
    "gap_months": 8,
    "before_company": "회사A",
    "after_company": "회사B"
  },
  "created_at": "2026-04-07T10:00:00Z"
}

// Under-probed tenure
{
  "id": "f-033",
  "urgency": "MEDIUM",
  "source": "profiler",
  "type": "under_probed",
  "message": "회사C 4년 재직 에피소드 2개뿐. 추가 발굴 필요.",
  "context": {
    "company": "회사C",
    "tenure_years": 4,
    "episode_count": 2,
    "expected_minimum": 5
  },
  "created_at": "2026-04-07T10:00:00Z"
}
```

## Patterns to Follow

### Pattern 1: Profiler as Analysis Hub

**What:** All cross-episode analysis (contradiction, pattern, timeline) runs inside the profiler agent, not in the hook or orchestrator.

**Why:** The profiler already has the mandate to "종합하여 프로파일링" and the architecture to dispatch sub-agents and write to findings-inbox. Adding analysis sections to the profiler prompt is additive, not architectural change.

**Rule:** If a feature needs to compare multiple episodes or look across the full resume-source.json, it goes in the profiler. If it responds to a single episode in real-time, it goes in the orchestrator.

### Pattern 2: Findings Pipeline for Async Results

**What:** Analysis results flow through the existing findings-inbox.jsonl → hook → additionalContext → orchestrator pipeline.

**Why:** The urgency-based routing already handles timing (HIGH = immediate, MEDIUM = company transition, LOW = on-demand). New analysis types just produce new findings with appropriate urgency levels.

**Rule:** Never inject analysis results directly into the conversation. Always go through findings-inbox.jsonl so the hook manages timing and the orchestrator manages delivery.

### Pattern 3: Agent Prompt Enhancement for Question Techniques

**What:** Perspective shifting and advanced question patterns are added as new sections in existing agent prompts, not as new agents or new tools.

**Why:** The agent-per-role structure (senior = domain depth, c-level = business impact, etc.) is well-established. Perspective shifting is a technique any agent can use, not a new role.

**Rule:** New question techniques go into agent prompts. New analysis capabilities go into the profiler prompt. The boundary is: "Does it change what you ask?" (agent prompt) vs "Does it change what you analyze?" (profiler prompt).

### Pattern 4: Orchestrator as UX Gateway

**What:** The orchestrator is the only component that calls AskUserQuestion and formats user-facing output. Agents return structured question data; the orchestrator wraps it.

**Why:** Agents run as background sub-agents and cannot call AskUserQuestion (it requires user interaction). The orchestrator is the main Claude instance that holds the conversation.

**Rule:** Agents return `[에이전트명] {question}\n  1) {option}\n  2) {option}\n  3) 직접입력`. The orchestrator converts this to an AskUserQuestion call.

## Anti-Patterns to Avoid

### Anti-Pattern 1: Analysis in the Hook

**What:** Adding contradiction detection or pattern recognition logic to episode-watcher.mjs.

**Why bad:** The hook has a 10-second timeout, runs synchronously, and is plain JavaScript with no LLM access. Complex analysis requires understanding language nuance (Korean text), comparing semantic meaning across episodes, and making judgment calls. This is LLM work, not script work.

**Instead:** Keep the hook lean (delta detection + findings routing). All intelligence goes in agent prompts.

**Exception:** Simple date arithmetic for timeline gaps is acceptable in the hook because it is pure numeric comparison, not language understanding.

### Anti-Pattern 2: New Agents for Each Feature

**What:** Creating contradiction-detector.md, pattern-recognizer.md, timeline-analyzer.md as separate agents.

**Why bad:** The system already has 8 agent files. Adding 3 more increases orchestrator complexity (which agent to call when?) without benefit. The profiler already handles all cross-episode analysis.

**Instead:** Add analysis sections to profiler.md. The profiler's prompt grows, but its role stays coherent: "analyze everything, produce findings."

### Anti-Pattern 3: Blocking the Interview for Analysis

**What:** Making the orchestrator wait for contradiction detection before asking the next question.

**Why bad:** The profiler runs asynchronously in the background. Making the user wait for analysis breaks the conversational flow. The current architecture specifically protects interview flow ("피드백 전달 후 바로 다음 인터뷰 질문으로 복귀").

**Instead:** Analysis arrives asynchronously via findings. The orchestrator weaves findings into the conversation at natural breakpoints. Exception: So What chain is synchronous because it is a direct follow-up to the user's just-given answer.

### Anti-Pattern 4: Modifying resume-source.json Schema

**What:** Adding fields like `contradictions: []` or `patterns: []` to resume-source.json.

**Why bad:** resume-source.json is the episode storage format. Analysis metadata belongs in the analysis pipeline (.resume-panel/ directory). Mixing storage and analysis creates coupling.

**Instead:** Analysis outputs go to findings-inbox.jsonl → findings.json. If a contradiction is resolved, the orchestrator updates the affected episode's STAR fields with corrected info.

## Suggested Build Order (Dependencies)

```
Phase 1: AskUserQuestion UX ──────────────────────────────────
   No dependencies. Can ship independently.
   Changes: SKILL.md orchestrator instructions only.
   Risk: Low. Bug #29547 is closed; just don't add to allowed-tools.
   
Phase 2: So What Chain ────────────────────────────────────────
   Dependency: AskUserQuestion (for better UX of follow-up questions)
   Changes: SKILL.md (episode save → So What trigger logic)
   Risk: Low. Orchestrator-internal logic, no agent/hook changes.

Phase 3: Profiler Analysis Enhancements ───────────────────────
   Includes: Contradiction Detection + Timeline Analysis + Pattern Recognition
   Dependency: None from Phase 1-2, but benefits from AskUserQuestion UX
   Changes: profiler.md (3 new analysis sections), findings schema additions
   Risk: Medium. Profiler prompt gets substantially longer.
   
   Sub-order within Phase 3:
   3a: Timeline Analysis (simplest — pure date arithmetic + gap detection)
   3b: Contradiction Detection (requires cross-episode comparison)
   3c: Pattern Recognition (requires multi-company, most episodes needed)
   
   Rationale: Timeline is testable with minimal episodes. Contradiction
   needs at least 2 related episodes. Pattern needs episodes from 2+ companies.

Phase 4: Perspective Shifting ─────────────────────────────────
   Dependency: Benefits from Pattern Recognition (profiler flags "과소평가형")
   Changes: All 5 frontstage agent prompts (new question pattern section)
   Risk: Low per agent, but 5 files to update.

Optional: Hook Timeline Enhancement ──────────────────────────
   Dependency: Phase 3a (profiler already handles timeline)
   Changes: episode-watcher.mjs (add date gap check function)
   Risk: Low. Additive JavaScript function, existing tests provide safety net.
```

### Build Order Rationale

1. **AskUserQuestion first** because it is the foundation UX — every subsequent feature generates questions that benefit from select-box UI. It is also zero-risk and standalone.

2. **So What second** because it is the highest-value feature (directly improves episode quality) and is orchestrator-internal (no agent/hook changes). It also demonstrates the AskUserQuestion UX immediately.

3. **Profiler analysis features together** because they share the same integration pattern (add analysis section to profiler, produce findings). Shipping them together means one profiler.md update, one set of findings schema additions, and one round of testing the findings pipeline.

4. **Perspective shifting last** because it depends on profiler signals ("user undervalues their role") to know when to trigger. Without the profiler enhancements, perspective shifting would fire randomly rather than when it matters most.

## Scalability Considerations

| Concern | Current (5-10 episodes) | At 20+ episodes | At 50+ episodes |
|---------|------------------------|-----------------|-----------------|
| Profiler prompt size | Fine. Full resume-source.json fits in context. | Growing. May need to summarize older episodes. | Risk. Consider passing episode summaries instead of full STAR. |
| Contradiction detection accuracy | Limited pairs to compare | More comparison pairs, more value | Too many pairs for brute-force. Need clustering by project/company first. |
| Pattern recognition | Not enough data for patterns | Sweet spot. 2-3 companies, 5-8 episodes each. | Patterns are clear but prompt is long. |
| Hook execution time | < 100ms | < 200ms (more JSON to parse) | < 500ms (still under 10s limit) |
| findings.json size | Tiny | Manageable | May need archival/rotation |

## Sources

- [AskUserQuestion bug #29547](https://github.com/anthropics/claude-code/issues/29547) — Silent empty answers when in skill's allowed-tools. CLOSED.
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks) — PostToolUse additionalContext specification
- [PostToolUse additionalContext issue #24788](https://github.com/anthropics/claude-code/issues/24788) — MCP tool limitation (not applicable here)
- [AskUserQuestion system prompt spec](https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/tool-description-askuserquestion.md) — multiSelect option, recommended label formatting
- [Resumly timeline gap detection](https://www.resumly.ai/blog/using-ai-to-detect-inconsistent-career-chronology-and-fix-resume-gaps-automatically) — 3-month gap threshold, timeline graph construction approach
