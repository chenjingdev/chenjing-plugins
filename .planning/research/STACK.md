# Technology Stack

**Project:** Resume Panel Interview Enhancement
**Researched:** 2026-04-07

## Context

This is NOT a greenfield project. The existing system is a Claude Code plugin with:
- 9 agent prompts (markdown files in `.claude/agents/`)
- A PostToolUse hook (`episode-watcher.mjs`) for autonomous orchestration
- Structured data in `resume-source.json` (STAR-format episodes)
- State tracking in `.resume-panel/` directory
- Agent tool calls for inter-agent communication

All 6 new features are implemented as **prompt engineering + data structure enhancements** within this existing architecture. There is no new framework, no new runtime, no new dependency to install. The "stack" here is techniques, prompt patterns, and data structures.

## Recommended Stack

### Core Approach: Prompt-Driven Analysis Within Agent System

| Component | Technique | Purpose | Confidence |
|-----------|-----------|---------|------------|
| So What Chain | Recursive prompt template with exit condition | Impact deepening | HIGH |
| Pattern Detection | Cross-episode structured comparison in profiler prompt | Hidden episode discovery | HIGH |
| Timeline Gap Detection | Deterministic date arithmetic + LLM probing | Career gap identification | HIGH |
| Perspective Shifting | Role-framed prompt injection to existing agents | Alternate viewpoint questions | HIGH |
| Contradiction Detection | NLI-style pairwise claim comparison in profiler | Inconsistency catching | MEDIUM |
| AskUserQuestion UX | Claude Code native tool (select box) | Replace text number selection | HIGH |

### Why This Approach (Not External Tools)

The system runs inside Claude Code's plugin sandbox. Agents are markdown prompt files invoked via the Agent tool. There is no API server, no database, no external process. Every feature must be implementable as:

1. **Enhanced prompt instructions** in agent `.md` files
2. **Extended JSON schema** in `resume-source.json`
3. **Hook logic changes** in `episode-watcher.mjs`
4. **Orchestrator instructions** in `SKILL.md`

External NLI models, vector databases, or separate ML pipelines are out of scope and unnecessary. Claude (Sonnet/Opus) already has strong NLI capabilities built into its reasoning -- the task is to structure prompts that activate these capabilities reliably.

---

## Feature-by-Feature Technical Stack

### 1. So What Chain (Impact Deepening)

**Technique:** Recursive prompt template with structured exit condition

**How it works:**
When an episode is saved with a `result` field, the orchestrator triggers a follow-up cycle. The prompt template chains "so what?" until it reaches a business-level impact or the user says "that's it."

**Prompt pattern (in SKILL.md orchestrator instructions):**

```
Episode result: "{result}"

Impact chain so far: [{action} -> {result}]

Ask: "그래서 그게 팀/회사에 어떤 영향이 있었어?"
  1) {inferred_impact_1} (profiler/C-Level가 추론한 임팩트)
  2) {inferred_impact_2}
  3) 거기까지였음
  4) 직접입력
```

**Exit conditions (deterministic, not LLM-guessed):**
- User selects "거기까지였음"
- Chain depth reaches 3 (action -> team impact -> business metric)
- Result already contains a quantified business metric (number + unit)

**Data structure extension to episode schema:**

```json
{
  "result": "배포 시간 2시간 -> 15분",
  "impact_chain": [
    { "level": "direct", "description": "배포 시간 2시간 -> 15분" },
    { "level": "team", "description": "주간 배포 횟수 2회 -> 일 3회" },
    { "level": "business", "description": "피처 출시 속도 6배, 경쟁사 대비 선점" }
  ]
}
```

**Why this approach:**
- CoT (Chain of Thought) research in 2025 shows step-by-step reasoning improves when each step has structured input/output -- random "tell me more" is worse than specific "what was the team-level effect?"
- The 3-level chain (direct -> team -> business) maps directly to resume bullet point hierarchy: what you did, what it enabled, why it mattered
- Exit conditions prevent the LLM from endlessly asking follow-ups (a common pitfall)
- C-Level agent is natural owner for impact inference since it already focuses on business metrics

**Confidence:** HIGH -- This is standard interview coaching methodology ("So What Test" in STAR method) mapped to structured prompting. No novel technique required.

---

### 2. Cross-Company Pattern Detection

**Technique:** Structured episode comparison matrix in profiler prompt

**How it works:**
When the profiler runs (triggered by episode-watcher after delta threshold), it receives ALL episodes across ALL companies. The prompt instructs it to build a comparison matrix and identify recurring themes.

**Prompt pattern (in profiler.md, added to analysis section):**

```
## 6. 크로스 컴퍼니 패턴 탐지

에피소드 전체를 회사별로 나열하고 다음을 찾는다:

1. **반복 행동 패턴**: 여러 회사에서 비슷한 역할/행동이 반복되는가?
   - 예: A사에서 CI/CD 구축, B사에서 배포 자동화, C사에서 인프라 자동화
   → 패턴: "가는 곳마다 자동화 도입"

2. **스킬 전이 패턴**: 한 회사에서 배운 기술이 다음 회사에서 활용되었는가?
   - 예: A사 Redis 캐싱 → B사 캐시 전략 설계

3. **성장 패턴**: 역할/책임이 회사를 거치며 확대되었는가?
   - 예: A사 구현 → B사 설계 → C사 팀 리드

각 패턴에 대해:
- 패턴 이름 (3-5단어)
- 근거 에피소드 목록 (회사, 프로젝트, 에피소드 제목)
- 아직 물어보지 않은 회사에서 비슷한 경험이 있을 것으로 추정되는지 여부
- 추정되면: 구체적 질문 제안 (어떤 에이전트가 물어야 하는지 포함)
```

**Data structure for findings:**

```json
{
  "id": "f-010",
  "urgency": "MEDIUM",
  "source": "profiler",
  "type": "pattern_detected",
  "message": "가는 곳마다 자동화를 밀었네. C사에서도 비슷한 거 했을 텐데?",
  "context": {
    "pattern_name": "자동화 도입 전문가",
    "evidence": [
      { "company": "A사", "episode": "CI/CD 파이프라인 구축" },
      { "company": "B사", "episode": "배포 자동화" }
    ],
    "probe_target": { "company": "C사", "suggested_agent": "senior" },
    "suggested_question": "C사에서 인프라나 배포 쪽 자동화한 거 있어?"
  }
}
```

**Why this approach:**
- LLMs excel at finding semantic similarities across structured data when the comparison framework is explicit in the prompt
- The profiler already receives all episodes and runs periodically -- no new trigger mechanism needed
- Patterns are written to `findings-inbox.jsonl` and routed through existing hook system
- The "suggested question" field lets the orchestrator hand it directly to the right agent

**What NOT to do:**
- Do NOT try to use embeddings or vector similarity for pattern matching. The episode count is small (10-30), and LLM semantic reasoning on structured STAR data outperforms embedding-based approaches at this scale
- Do NOT run pattern detection on every episode save. Wait for profiler's natural trigger cycle (3+ episode delta). Premature pattern detection on 2-3 episodes produces false patterns

**Confidence:** HIGH -- This is the profiler's natural extension. The structured comparison prompt is a well-established technique.

---

### 3. Timeline Gap Detection

**Technique:** Deterministic date arithmetic (in hook or orchestrator) + LLM probing

**How it works:**
This is a TWO-PHASE approach:

**Phase 1 (Deterministic -- in orchestrator or profiler):**
Extract `period` fields from all projects/companies. Parse dates. Find gaps > 3 months between adjacent entries.

```
Timeline:
A사 (2019.03 - 2021.06)
  - 프로젝트1 (2019.03 - 2019.12)
  - 프로젝트2 (2020.06 - 2021.06)
  [GAP: 2020.01 - 2020.05 — 5개월 빈 구간]
B사 (2022.01 - 2024.03)
  [GAP between companies: 2021.07 - 2021.12 — 6개월]
```

**Phase 2 (LLM probing -- via agents):**
For each detected gap, generate a specific probing question:

```
A사에서 프로젝트1 끝나고 프로젝트2 시작까지 5개월인데 그때 뭐 했어?
1) 다른 프로젝트 했는데 아직 안 말한 거
2) 유지보수/운영 기간
3) 공백 기간 (이직 준비, 휴식 등)
4) 직접입력
```

**Data structure extension to company schema:**

```json
{
  "name": "A사",
  "period": "2019.03 - 2021.06",
  "timeline_gaps": [
    {
      "from": "2020.01",
      "to": "2020.05",
      "duration_months": 5,
      "between": ["프로젝트1", "프로젝트2"],
      "status": "unprobed",
      "resolution": null
    }
  ]
}
```

**Why this approach:**
- Date arithmetic is deterministic -- don't waste LLM tokens on what a regex + date parser can do
- The profiler prompt can include timeline construction instructions, but gap DETECTION should be rule-based
- LLM's role is limited to generating the probing question and interpreting the answer
- Gap resolution (what the user says) feeds back into episodes or gets marked as intentional gap

**What NOT to do:**
- Do NOT ask the LLM to "find timeline gaps" from unstructured text. Parse the structured `period` fields deterministically
- Do NOT probe gaps < 3 months. Short gaps are normal transitions between projects
- Do NOT treat inter-company gaps the same as intra-company gaps. Inter-company gaps > 6 months need probing; intra-company gaps > 3 months need probing

**Implementation note:** The `period` field currently exists in the project schema but may not always be populated. The orchestrator should ensure periods are collected during Round 1 for every project. Add validation: if period is missing when episode is saved, prompt for it.

**Confidence:** HIGH -- Date arithmetic is trivial. The only risk is `period` field format inconsistency (addressed in pitfalls).

---

### 4. Perspective Shifting Questions

**Technique:** Role-framed prompt injection to existing front-stage agents

**How it works:**
This is NOT a new agent. It's an additional question generation mode for existing agents (senior, C-Level, HR, recruiter). The orchestrator injects a perspective frame when calling an agent:

```
## 관점 전환 모드

이번 질문은 유저의 관점이 아닌 타인의 관점에서 묻는다.

대상 에피소드: {에피소드 제목}
전환 관점: {PM의 시점 / 주니어 팀원 시점 / 상사 시점 / 고객 시점}

"{관점 인물}이 이 프로젝트에서 네 역할을 설명한다면 뭐라고 할까?"

선택지를 생성할 때:
- 유저가 직접 말한 것보다 더 큰 역할을 선택지에 포함한다
- "유저가 말한 수준"과 "타인이 볼 수준" 사이의 갭을 드러낸다
```

**Trigger conditions (in orchestrator logic):**
- Episode has `action` but `result` is vague or missing scale
- Episode type is "리더십" or "협업"
- Profiler flags user as "자기 평가 경향: 과소평가형"
- Round 2 (Impact & Gaps) -- this is the natural round for perspective shifting

**Perspective mapping:**

| Episode Type | Best Perspective | Agent to Ask |
|-------------|-----------------|--------------|
| 리더십 | 주니어 팀원 | HR |
| 협업 | PM or 상대 팀 담당자 | HR or 시니어 |
| 문제해결 | 상사 or CTO | C-Level |
| 성과 | 고객 or 비즈니스 오너 | C-Level |

**Why this approach:**
- Research on LLM role-play confirms that assigning explicit perspectives produces genuinely different question angles, not just rephrased versions of the same question
- Korean cultural context: users systematically understate their contributions (identified in PROJECT.md). Third-person perspective naturally inflates role description because the question frame bypasses the user's self-deprecation filter
- No new agent needed. HR agent already focuses on soft skills/leadership. C-Level already focuses on impact. They just need the perspective frame injection

**What NOT to do:**
- Do NOT create a new "perspective shifting agent." This violates the constraint of no new agents and adds unnecessary complexity
- Do NOT use perspective shifting on every episode. Reserve for episodes where the profiler detects understatement or where STAR `result` is weaker than expected given company scale
- Do NOT shift to perspectives the user can't plausibly reconstruct (e.g., "what would the CEO think?" for an intern-level episode)

**Confidence:** HIGH -- Role-framed prompting is well-established. The implementation is a conditional injection into existing agent calls.

---

### 5. Contradiction Detection

**Technique:** NLI-style pairwise claim extraction and comparison in profiler prompt

**How it works:**

**Step 1 -- Claim Extraction (continuous, during episode save):**
When the orchestrator saves an episode, it also extracts key factual claims as a flat list appended to a claims registry. This is done in the orchestrator's episode-saving logic:

```json
{
  "claims": [
    {
      "id": "c-001",
      "episode_ref": "A사/프로젝트1/에피소드1",
      "claim": "아키텍처 설계에 관여하지 않았음",
      "category": "role_scope"
    },
    {
      "id": "c-002",
      "episode_ref": "A사/프로젝트1/에피소드3",
      "claim": "마이크로서비스 구조를 재설계했음",
      "category": "role_scope"
    }
  ]
}
```

**Step 2 -- Contradiction Scan (in profiler, during periodic analysis):**

```
## 7. 모순 탐지

claims 목록에서 같은 category 내 모순을 찾는다:

모순 유형:
1. **역할 범위 모순**: "관여 안 했다" vs "내가 했다" (가장 흔함 -- 겸손에 의한 축소)
2. **시간 모순**: "그때 A를 하고 있었다" vs "그때 B를 하고 있었다" (동시 불가능한 활동)
3. **규모 모순**: "소규모 프로젝트" vs 실제 MAU/트래픽 수치가 대규모
4. **기여도 모순**: 초기에 "팀에서 했다" → 후에 "내가 리드했다"

각 모순에 대해:
- 모순되는 두 claim (id 포함)
- 모순 유형
- 해석: 겸손에 의한 축소일 가능성 (한국인 유저 특성 고려)
- 복원 질문: 실제 역할을 확인하기 위한 구체적 질문
```

**Findings output:**

```json
{
  "id": "f-020",
  "urgency": "HIGH",
  "source": "profiler",
  "type": "contradiction_detected",
  "message": "아까 아키텍처에 관여 안 했다고 했는데, 방금 재설계했다고 했잖아. 실제로는 어디까지 한 거야?",
  "context": {
    "contradiction_type": "role_scope",
    "claim_a": { "id": "c-001", "text": "관여하지 않았음" },
    "claim_b": { "id": "c-002", "text": "재설계했음" },
    "likely_cause": "겸손에 의한 축소",
    "restoration_question": "아키텍처 재설계할 때 네 역할이 정확히 뭐였어?"
  }
}
```

**Why this approach:**
- Research (arxiv:2504.00180) shows Claude Sonnet with structured prompting achieves strong contradiction detection. The key is EXPLICIT claim extraction before comparison -- don't ask the LLM to find contradictions in raw conversation history
- Claim categorization (role_scope, time, scale, contribution) narrows comparison scope. Without categories, the LLM would need to compare N^2 claim pairs. With categories, it only compares within-category pairs
- The "likely cause: 겸손에 의한 축소" framing is critical for the Korean user context. The system should assume role-scope contradictions are usually under-reporting, not lying
- HIGH urgency is appropriate because contradictions directly indicate hidden/suppressed achievements

**What NOT to do:**
- Do NOT compare raw conversation text for contradictions. Extract structured claims first. Raw text comparison has high false-positive rates (research shows ~17% self-contradiction in general LLM text, but most are linguistic rather than factual)
- Do NOT flag every contradiction to the user immediately. Route through the profiler's findings system. Only role_scope contradictions get HIGH urgency. Time/scale contradictions may be MEDIUM
- Do NOT use accusatory framing ("you said X but then said Y"). Use curious framing ("아까 X라고 했는데 방금 Y라고 했잖아 -- 실제로는 어디까지 한 거야?")
- Do NOT build a separate NLI model or call an external API. Claude's built-in NLI capability is sufficient for 10-50 claim pairs

**Confidence:** MEDIUM -- The technique is sound, but claim extraction quality depends on prompt engineering that needs iteration. The profiler may extract noisy claims initially. Plan for 2-3 rounds of prompt refinement.

---

### 6. AskUserQuestion Select Box UX

**Technique:** Replace text-based numbered options with Claude Code native AskUserQuestion tool

**How it works:**
Currently agents output text like:
```
[시니어] Kafka 도입한 거 봤는데, 이거 직접 밀었어?
  1) 내가 제안해서 도입
  2) 기존에 있었고 활용만
  3) 마이그레이션 작업
  4) 직접입력
```

Replace with orchestrator calling AskUserQuestion:
```
AskUserQuestion(
  question: "[시니어] Kafka 도입한 거 봤는데, 이거 직접 밀었어?",
  options: [
    { label: "내가 제안해서 도입" },
    { label: "기존에 있었고 활용만" },
    { label: "마이그레이션 작업" }
  ]
)
```

Users get a clickable select box UI. "Other" (직접입력) is automatically provided by AskUserQuestion.

**Implementation scope:**
- SKILL.md: Change orchestrator instructions from "에이전트가 리턴한 질문을 유저에게 그대로 전달" to "에이전트가 리턴한 질문과 선택지를 AskUserQuestion으로 변환하여 전달"
- Agent .md files: No change needed. They already output structured `1) ... 2) ... 3) ...` format. The orchestrator parses this and converts to AskUserQuestion parameters
- Parsing logic: Orchestrator extracts question text (before numbered list) and options (numbered items) from agent response

**Constraints from Claude Code AskUserQuestion:**
- 1-4 questions per call
- 2-4 options per question (plus automatic "Other" option)
- 60-second timeout per call
- `multiSelect: true` available but rarely needed (most interview questions are single-select)

**Agent output format standardization:**
Agents should output in a parseable format. Current format already works:
```
[에이전트명] 질문 텍스트
  1) 선택지1
  2) 선택지2
  3) 선택지3
```

The orchestrator extracts:
- `question` = everything between `[에이전트명]` and the first `1)`
- `options` = items after each `N)` marker
- Last option "직접입력" is dropped (AskUserQuestion provides "Other" automatically)

**Why this approach:**
- Zero overhead: agents don't need to change. The orchestrator handles the conversion
- Better UX: clicking > typing "2"
- Maintains "직접입력" functionality via AskUserQuestion's built-in "Other" option
- Consistent with Claude Code's native interaction patterns

**What NOT to do:**
- Do NOT have agents directly call AskUserQuestion. Agents are sub-agents invoked via Agent tool -- they can't call UI tools directly. The orchestrator is the only one that interacts with the user
- Do NOT use multiSelect for interview questions. One question, one answer. MultiSelect would confuse the episode extraction logic
- Do NOT change the agent output format. Keep the existing numbered list format as the agent-to-orchestrator protocol. Only change how the orchestrator presents it to the user
- Do NOT exceed 4 options per question. Currently agents output 2-3 + "직접입력". With AskUserQuestion's auto "Other", keep it at 2-3 substantive options

**Confidence:** HIGH -- AskUserQuestion is a documented Claude Code feature. The only risk is formatting edge cases (addressed in pitfalls).

---

## Data Structure Summary

### Extensions to resume-source.json

```json
{
  "companies": [
    {
      "period": "2019.03 - 2021.06",
      "timeline_gaps": [
        {
          "from": "2020.01",
          "to": "2020.05",
          "duration_months": 5,
          "between": ["프로젝트1", "프로젝트2"],
          "status": "unprobed|probed|resolved",
          "resolution": null
        }
      ],
      "projects": [
        {
          "episodes": [
            {
              "impact_chain": [
                { "level": "direct|team|business", "description": "..." }
              ]
            }
          ]
        }
      ]
    }
  ],
  "claims": [
    {
      "id": "c-001",
      "episode_ref": "회사/프로젝트/에피소드",
      "claim": "...",
      "category": "role_scope|time|scale|contribution"
    }
  ],
  "patterns": [
    {
      "name": "자동화 도입 전문가",
      "evidence": [
        { "company": "A사", "episode": "..." }
      ],
      "probed": false
    }
  ]
}
```

### New Fields in .resume-panel/findings.json Types

| type | source | urgency | trigger |
|------|--------|---------|---------|
| `pattern_detected` | profiler | MEDIUM | 프로파일러 주기적 실행 |
| `contradiction_detected` | profiler | HIGH | 프로파일러 주기적 실행 |
| `timeline_gap_found` | profiler | MEDIUM | 프로파일러 주기적 실행 |
| `impact_shallow` | profiler | LOW | 에피소드 저장 시 impact_chain 없음 |

---

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Contradiction detection | Claim extraction + NLI in profiler prompt | External NLI model (e.g., DeBERTa) | No external runtime in Claude Code plugin sandbox. Claude's built-in NLI is sufficient for <50 claims |
| Pattern detection | Structured comparison in profiler prompt | Embedding similarity (vectorize episodes) | Overkill for 10-30 episodes. LLM semantic comparison is more interpretable and actionable |
| Timeline gaps | Deterministic date math + LLM probing | Pure LLM analysis of dates | Date arithmetic should never be delegated to LLMs. They make arithmetic mistakes. Parse dates, compute gaps, let LLM generate the probing question |
| Impact chain | Recursive 3-level prompt template | Open-ended "tell me more" | Unstructured follow-up produces shallow/repetitive answers. Structured levels (direct->team->business) guide toward resume-worthy content |
| UX | AskUserQuestion native tool | Custom UI component | Custom UI doesn't exist in Claude Code plugin system. AskUserQuestion is the only option |
| Perspective shifting | Role injection into existing agents | New "perspective agent" | Violates no-new-agent constraint. Existing agents already have the domain expertise; they just need the perspective frame |

---

## No Installation Required

This project has zero new dependencies. The entire enhancement is:

1. **Prompt changes** -- .md files for agents and SKILL.md
2. **Schema changes** -- Extended JSON fields in resume-source.json
3. **Hook changes** -- Updated episode-watcher.mjs for new finding types
4. **Orchestrator logic** -- New conditional flows in SKILL.md

```bash
# No install commands. The "stack" is prompt engineering.
```

---

## Sources

### Contradiction Detection
- [Contradiction Detection in RAG Systems (arxiv:2504.00180)](https://arxiv.org/html/2504.00180v1) -- Claude Sonnet with CoT prompting achieves strong contradiction detection, HIGH confidence
- [Self-contradictory Hallucinations of LLMs (OpenReview)](https://openreview.net/forum?id=EmQSOi1X2f) -- 17.7% self-contradiction rate in ChatGPT; structured prompting reduces this, MEDIUM confidence
- [ALICE: Automated Logic for Identifying Contradictions](https://link.springer.com/article/10.1007/s10515-024-00452-x) -- Decision tree + LLM hybrid for requirement contradiction detection, MEDIUM confidence

### Chain of Thought / Impact Reasoning
- [Chain-of-Thought Prompting Guide](https://www.promptingguide.ai/techniques/cot) -- Standard CoT reference, HIGH confidence
- [Decreasing Value of CoT (Wharton)](https://gail.wharton.upenn.edu/research-and-insights/tech-report-chain-of-thought/) -- CoT benefits are marginal for reasoning models; simpler structured prompts often suffice, MEDIUM confidence
- [STAR Method "So What" Test](https://managementconsulted.com/star-method/) -- The result/impact deepening is a standard interview coaching technique, HIGH confidence

### Prompt Engineering & Structured Output
- [Claude Structured Outputs Documentation](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) -- JSON schema enforcement at inference time, HIGH confidence
- [Prompt Chaining Best Practices (Deepchecks)](https://deepchecks.com/orchestrating-multi-step-llm-chains-best-practices/) -- Multi-step LLM pipeline design, MEDIUM confidence
- [AWS Prompt Chaining Workflow](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-patterns/workflow-for-prompt-chaining.html) -- Agentic pattern reference, MEDIUM confidence

### AskUserQuestion
- [Claude Code AskUserQuestion System Prompt](https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/tool-description-askuserquestion.md) -- Tool format documentation, HIGH confidence
- [Claude Code AskUserQuestion Guide (atcyrus.com)](https://www.atcyrus.com/stories/claude-code-ask-user-question-tool-guide) -- Usage patterns and limitations, MEDIUM confidence

### Role-Play / Perspective Shifting
- [LLM Discussion: Enhancing Creativity via Role-Play (OpenReview)](https://openreview.net/forum?id=ybaK4asBT2) -- Diverse role assignment produces genuinely different outputs, MEDIUM confidence
