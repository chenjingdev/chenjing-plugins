<!-- GSD:project-start source:PROJECT.md -->
## Project

**Resume Panel Interview Enhancement**

이력서 쓸 줄 모르는 사람들을 위한 Claude 플러그인의 인터뷰 프로세스 강화 프로젝트. 기존 9개 에이전트 패널 인터뷰 시스템에 임팩트 심화, 패턴 탐지, 타임라인 분석, 관점 전환, 모순 탐지 기능을 추가하고, 텍스트 기반 선택 UI를 AskUserQuestion 셀렉트 박스로 교체한다.

**Core Value:** 인터뷰를 통해 유저 본인도 몰랐던 숨은 에피소드와 비즈니스 임팩트를 발굴하여, 이력서 품질을 근본적으로 높인다.

### Constraints

- **플랫폼**: Claude Code 플러그인 시스템 (SKILL.md + agents + hooks)
- **도구 제약**: AskUserQuestion은 질문당 2-4개 옵션, 1-4개 질문 동시 가능
- **기존 구조 유지**: 4라운드 구조와 에이전트 역할 분담은 유지하면서 기능 추가
- **프로파일러 의존**: So What 체인, 패턴 발견, 타임라인 갭은 profiler 에이전트 강화 필요
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## Context
- 9 agent prompts (markdown files in `.claude/agents/`)
- A PostToolUse hook (`episode-watcher.mjs`) for autonomous orchestration
- Structured data in `resume-source.json` (STAR-format episodes)
- State tracking in `.resume-panel/` directory
- Agent tool calls for inter-agent communication
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
## Feature-by-Feature Technical Stack
### 1. So What Chain (Impact Deepening)
- User selects "거기까지였음"
- Chain depth reaches 3 (action -> team impact -> business metric)
- Result already contains a quantified business metric (number + unit)
- CoT (Chain of Thought) research in 2025 shows step-by-step reasoning improves when each step has structured input/output -- random "tell me more" is worse than specific "what was the team-level effect?"
- The 3-level chain (direct -> team -> business) maps directly to resume bullet point hierarchy: what you did, what it enabled, why it mattered
- Exit conditions prevent the LLM from endlessly asking follow-ups (a common pitfall)
- C-Level agent is natural owner for impact inference since it already focuses on business metrics
### 2. Cross-Company Pattern Detection
## 6. 크로스 컴퍼니 패턴 탐지
- 패턴 이름 (3-5단어)
- 근거 에피소드 목록 (회사, 프로젝트, 에피소드 제목)
- 아직 물어보지 않은 회사에서 비슷한 경험이 있을 것으로 추정되는지 여부
- 추정되면: 구체적 질문 제안 (어떤 에이전트가 물어야 하는지 포함)
- LLMs excel at finding semantic similarities across structured data when the comparison framework is explicit in the prompt
- The profiler already receives all episodes and runs periodically -- no new trigger mechanism needed
- Patterns are written to `findings-inbox.jsonl` and routed through existing hook system
- The "suggested question" field lets the orchestrator hand it directly to the right agent
- Do NOT try to use embeddings or vector similarity for pattern matching. The episode count is small (10-30), and LLM semantic reasoning on structured STAR data outperforms embedding-based approaches at this scale
- Do NOT run pattern detection on every episode save. Wait for profiler's natural trigger cycle (3+ episode delta). Premature pattern detection on 2-3 episodes produces false patterns
### 3. Timeline Gap Detection
- Date arithmetic is deterministic -- don't waste LLM tokens on what a regex + date parser can do
- The profiler prompt can include timeline construction instructions, but gap DETECTION should be rule-based
- LLM's role is limited to generating the probing question and interpreting the answer
- Gap resolution (what the user says) feeds back into episodes or gets marked as intentional gap
- Do NOT ask the LLM to "find timeline gaps" from unstructured text. Parse the structured `period` fields deterministically
- Do NOT probe gaps < 3 months. Short gaps are normal transitions between projects
- Do NOT treat inter-company gaps the same as intra-company gaps. Inter-company gaps > 6 months need probing; intra-company gaps > 3 months need probing
### 4. Perspective Shifting Questions
## 관점 전환 모드
- 유저가 직접 말한 것보다 더 큰 역할을 선택지에 포함한다
- "유저가 말한 수준"과 "타인이 볼 수준" 사이의 갭을 드러낸다
- Episode has `action` but `result` is vague or missing scale
- Episode type is "리더십" or "협업"
- Profiler flags user as "자기 평가 경향: 과소평가형"
- Round 2 (Impact & Gaps) -- this is the natural round for perspective shifting
| Episode Type | Best Perspective | Agent to Ask |
|-------------|-----------------|--------------|
| 리더십 | 주니어 팀원 | HR |
| 협업 | PM or 상대 팀 담당자 | HR or 시니어 |
| 문제해결 | 상사 or CTO | C-Level |
| 성과 | 고객 or 비즈니스 오너 | C-Level |
- Research on LLM role-play confirms that assigning explicit perspectives produces genuinely different question angles, not just rephrased versions of the same question
- Korean cultural context: users systematically understate their contributions (identified in PROJECT.md). Third-person perspective naturally inflates role description because the question frame bypasses the user's self-deprecation filter
- No new agent needed. HR agent already focuses on soft skills/leadership. C-Level already focuses on impact. They just need the perspective frame injection
- Do NOT create a new "perspective shifting agent." This violates the constraint of no new agents and adds unnecessary complexity
- Do NOT use perspective shifting on every episode. Reserve for episodes where the profiler detects understatement or where STAR `result` is weaker than expected given company scale
- Do NOT shift to perspectives the user can't plausibly reconstruct (e.g., "what would the CEO think?" for an intern-level episode)
### 5. Contradiction Detection
## 7. 모순 탐지
- 모순되는 두 claim (id 포함)
- 모순 유형
- 해석: 겸손에 의한 축소일 가능성 (한국인 유저 특성 고려)
- 복원 질문: 실제 역할을 확인하기 위한 구체적 질문
- Research (arxiv:2504.00180) shows Claude Sonnet with structured prompting achieves strong contradiction detection. The key is EXPLICIT claim extraction before comparison -- don't ask the LLM to find contradictions in raw conversation history
- Claim categorization (role_scope, time, scale, contribution) narrows comparison scope. Without categories, the LLM would need to compare N^2 claim pairs. With categories, it only compares within-category pairs
- The "likely cause: 겸손에 의한 축소" framing is critical for the Korean user context. The system should assume role-scope contradictions are usually under-reporting, not lying
- HIGH urgency is appropriate because contradictions directly indicate hidden/suppressed achievements
- Do NOT compare raw conversation text for contradictions. Extract structured claims first. Raw text comparison has high false-positive rates (research shows ~17% self-contradiction in general LLM text, but most are linguistic rather than factual)
- Do NOT flag every contradiction to the user immediately. Route through the profiler's findings system. Only role_scope contradictions get HIGH urgency. Time/scale contradictions may be MEDIUM
- Do NOT use accusatory framing ("you said X but then said Y"). Use curious framing ("아까 X라고 했는데 방금 Y라고 했잖아 -- 실제로는 어디까지 한 거야?")
- Do NOT build a separate NLI model or call an external API. Claude's built-in NLI capability is sufficient for 10-50 claim pairs
### 6. AskUserQuestion Select Box UX
- SKILL.md: Change orchestrator instructions from "에이전트가 리턴한 질문을 유저에게 그대로 전달" to "에이전트가 리턴한 질문과 선택지를 AskUserQuestion으로 변환하여 전달"
- Agent .md files: No change needed. They already output structured `1) ... 2) ... 3) ...` format. The orchestrator parses this and converts to AskUserQuestion parameters
- Parsing logic: Orchestrator extracts question text (before numbered list) and options (numbered items) from agent response
- 1-4 questions per call
- 2-4 options per question (plus automatic "Other" option)
- 60-second timeout per call
- `multiSelect: true` available but rarely needed (most interview questions are single-select)
- `question` = everything between `[에이전트명]` and the first `1)`
- `options` = items after each `N)` marker
- Last option "직접입력" is dropped (AskUserQuestion provides "Other" automatically)
- Zero overhead: agents don't need to change. The orchestrator handles the conversion
- Better UX: clicking > typing "2"
- Maintains "직접입력" functionality via AskUserQuestion's built-in "Other" option
- Consistent with Claude Code's native interaction patterns
- Do NOT have agents directly call AskUserQuestion. Agents are sub-agents invoked via Agent tool -- they can't call UI tools directly. The orchestrator is the only one that interacts with the user
- Do NOT use multiSelect for interview questions. One question, one answer. MultiSelect would confuse the episode extraction logic
- Do NOT change the agent output format. Keep the existing numbered list format as the agent-to-orchestrator protocol. Only change how the orchestrator presents it to the user
- Do NOT exceed 4 options per question. Currently agents output 2-3 + "직접입력". With AskUserQuestion's auto "Other", keep it at 2-3 substantive options
## Data Structure Summary
### Extensions to resume-source.json
### New Fields in .resume-panel/findings.json Types
| type | source | urgency | trigger |
|------|--------|---------|---------|
| `pattern_detected` | profiler | MEDIUM | 프로파일러 주기적 실행 |
| `contradiction_detected` | profiler | HIGH | 프로파일러 주기적 실행 |
| `timeline_gap_found` | profiler | MEDIUM | 프로파일러 주기적 실행 |
| `impact_shallow` | profiler | LOW | 에피소드 저장 시 impact_chain 없음 |
## Alternatives Considered
| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Contradiction detection | Claim extraction + NLI in profiler prompt | External NLI model (e.g., DeBERTa) | No external runtime in Claude Code plugin sandbox. Claude's built-in NLI is sufficient for <50 claims |
| Pattern detection | Structured comparison in profiler prompt | Embedding similarity (vectorize episodes) | Overkill for 10-30 episodes. LLM semantic comparison is more interpretable and actionable |
| Timeline gaps | Deterministic date math + LLM probing | Pure LLM analysis of dates | Date arithmetic should never be delegated to LLMs. They make arithmetic mistakes. Parse dates, compute gaps, let LLM generate the probing question |
| Impact chain | Recursive 3-level prompt template | Open-ended "tell me more" | Unstructured follow-up produces shallow/repetitive answers. Structured levels (direct->team->business) guide toward resume-worthy content |
| UX | AskUserQuestion native tool | Custom UI component | Custom UI doesn't exist in Claude Code plugin system. AskUserQuestion is the only option |
| Perspective shifting | Role injection into existing agents | New "perspective agent" | Violates no-new-agent constraint. Existing agents already have the domain expertise; they just need the perspective frame |
## No Installation Required
# No install commands. The "stack" is prompt engineering.
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
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, or `.github/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
