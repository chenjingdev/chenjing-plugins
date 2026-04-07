# Phase 1: AskUserQuestion UX - Research

**Researched:** 2026-04-07
**Domain:** Claude Code AskUserQuestion tool integration, prompt engineering for orchestrator
**Confidence:** HIGH

## Summary

Phase 1 replaces the text-based number selection ("1) option 2) option") with Claude Code's native AskUserQuestion select box UI. The core technical challenge is **prompt engineering in SKILL.md** -- instructing the orchestrator to parse agent text output and convert it to AskUserQuestion tool calls. No code files need to change; only markdown prompt files are modified.

AskUserQuestion has a well-defined JSON schema (1-4 questions, 2-4 options each, auto "Other" for free text). The current agent output format (`[에이전트명] 질문\n  1) 선택지\n  2) 선택지\n  3) 직접입력`) maps cleanly to this schema. The "직접입력" option in agent output should be **dropped** during conversion since AskUserQuestion automatically adds "Other" which serves the same purpose.

**Primary recommendation:** Modify SKILL.md orchestrator instructions to: (1) parse agent return text into question + options, (2) call AskUserQuestion with the parsed data, (3) pass the user's selection back to the conversation flow. Keep agent prompts unchanged except for updating option count guidance (max 4 substantive options).

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- 에이전트 출력 포맷 변경 없음 -- 기존대로 "1) 뭐뭐 2) 뭐뭐" 텍스트 출력, 오케스트레이터가 파싱
- 변환 로직은 SKILL.md 오케스트레이터 프롬프트에 기술 (프롬프트 엔지니어링만, 별도 스크립트 없음)
- 에이전트별 프롬프트 수정 최소화 -- "선택지 필수" 룰 유지, 렌더링만 변경
- 라운드 0(세팅)도 AskUserQuestion으로 통일
- AskUserQuestion이 자동 추가하는 "Other" 옵션을 직접입력으로 활용
- Other 선택 시 유저의 자유 텍스트를 그대로 에이전트에 전달
- 한 턴에 질문 수는 에이전트 재량 (AskUserQuestion은 1-4개 질문 가능)
- 선택지 수 상한: 에이전트 재량으로 최대 4개 + 자동 Other = 5개
- AskUserQuestion 실패 시 에러 표시 후 재시도, 2차 실패 시 텍스트 번호 방식 폴백
- 에이전트가 선택지 없이 서술형 질문 던질 때 셀렉트 박스 없이 평문 전달
- 프로파일러 findings 긴급 삽입 시에도 AskUserQuestion으로 감싸기

### Claude's Discretion
None specified -- all decisions were locked.

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| UX-01 | 모든 에이전트 질문이 AskUserQuestion 셀렉트 박스로 렌더링됨 | AskUserQuestion API schema verified; parsing pattern for `[에이전트명]` + numbered list documented; Round 0 orchestrator questions also covered |
| UX-02 | 에이전트가 질문당 최대 5개 옵션을 재량껏 구성함 | Schema allows 2-4 options + automatic "Other" = max 5; agent prompts currently output 2-3 + 직접입력, need update to max 4 |
| UX-03 | 모든 질문에 직접입력 가능한 빈 셀렉트 옵션이 포함됨 | AskUserQuestion auto-adds "Other" option; agents should drop "직접입력" from their output since it's redundant |
</phase_requirements>

## Standard Stack

### Core
| Component | Version/Type | Purpose | Why Standard |
|-----------|-------------|---------|--------------|
| AskUserQuestion | Claude Code 2.1.92 built-in | Select box UI for user questions | Only native option for structured input in Claude Code plugins [VERIFIED: code.claude.com/docs/en/tools-reference] |
| SKILL.md prompt engineering | N/A | Orchestrator instructions for parsing + conversion | Locked decision -- no scripts, prompt only |

### No Installation Required

This phase is pure prompt engineering. No packages, no scripts, no code. Only markdown files are modified.

## Architecture Patterns

### Conversion Flow (Agent Output -> AskUserQuestion)

```
Agent returns:
  "[시니어] Kafka 도입한 거 봤는데, 이거 직접 밀었어 아니면 이미 있던 거야?
    1) 내가 제안해서 도입
    2) 기존에 있었고 활용만
    3) 마이그레이션 작업
    4) 직접입력"

Orchestrator parses and converts to:
  AskUserQuestion({
    questions: [{
      question: "[시니어] Kafka 도입한 거 봤는데, 이거 직접 밀었어 아니면 이미 있던 거야?",
      header: "시니어",
      options: [
        { label: "제안해서 도입", description: "내가 제안해서 도입" },
        { label: "기존 활용", description: "기존에 있었고 활용만" },
        { label: "마이그레이션", description: "마이그레이션 작업" }
      ],
      multiSelect: false
    }]
  })
  // "직접입력" dropped -- AskUserQuestion auto-adds "Other"
```

### AskUserQuestion JSON Schema (Verified)

[VERIFIED: github.com/bgauryy gist - internal tools implementation]

```json
{
  "questions": {
    "type": "array",
    "minItems": 1,
    "maxItems": 4,
    "items": {
      "required": ["question", "header", "options", "multiSelect"],
      "properties": {
        "question": { "type": "string" },
        "header": { "type": "string", "description": "max 12 chars" },
        "multiSelect": { "type": "boolean" },
        "options": {
          "type": "array",
          "minItems": 2,
          "maxItems": 4,
          "items": {
            "required": ["label", "description"],
            "properties": {
              "label": { "type": "string", "description": "1-5 words, concise" },
              "description": { "type": "string" }
            }
          }
        }
      }
    }
  }
}
```

### Key Schema Constraints

| Field | Constraint | Implication |
|-------|-----------|-------------|
| `questions` | 1-4 items | Agents currently output 1 question per turn; orchestrator can batch up to 4 |
| `header` | max 12 chars | Must derive from agent name: "시니어", "C-Level", "채용담당자" (6 chars), "인사담당자" (5 chars), "커피챗" (3 chars) -- all fit within 12 chars |
| `options` | 2-4 items | Agents output 2-3 substantive + "직접입력"; drop 직접입력, keep 2-3 substantive. Can increase to max 4 substantive. |
| `label` | 1-5 words, concise | Agent option text like "내가 제안해서 도입" needs condensation to label (e.g., "제안 도입") with full text in description |
| `description` | string, no limit documented | Full agent option text goes here |
| `multiSelect` | boolean, required | Always `false` for interview questions (locked decision) |

### Files to Modify

```
plugins/resume/skills/resume-panel/
└── SKILL.md              # PRIMARY -- orchestrator prompt (all conversion logic)

plugins/resume/.claude/agents/
├── senior.md             # MINOR -- update option count from "2~3개" to "최대 4개"
├── c-level.md            # MINOR -- same
├── recruiter.md          # MINOR -- same  
├── hr.md                 # MINOR -- same
└── coffee-chat.md        # MINOR -- same
```

### SKILL.md Modification Points

1. **"에이전트 호출 방법" section** (line ~73-96) -- Replace "에이전트가 리턴한 질문을 유저에게 그대로 전달" with AskUserQuestion conversion instructions
2. **"유저 응답 처리" section** (line ~108-112) -- Replace "유저가 번호를 입력하면 해당 선택지로 처리" with AskUserQuestion answer handling
3. **"핵심 원칙 #2" section** (line ~14) -- Update "2~3개 선택지" to "최대 4개 선택지"
4. **"라운드 0" section** (line ~116-220) -- Convert hardcoded examples (이어하기/새로시작, 직군 확인) to AskUserQuestion format
5. **"자율 오케스트레이션" section** (line ~307-335) -- Add AskUserQuestion wrapping for findings delivery
6. **New fallback section** -- Add error handling: retry once, then fall back to text numbers

### Round 0 Orchestrator Questions (No Agent Involved)

These questions come from the orchestrator itself, not from agents:

| Question | Header | Options |
|----------|--------|---------|
| "이전에 작업하던 이력서 소스가 있네요." | "세션" | ["이어하기", "새로 시작"] |
| "JD 보니까 {직군} 포지션인데, 본인 직군도 {직군}이 맞아?" | "직군 확인" | ["맞아", "다른 직군"] |
| 기존 자료 확인 ("맞아요? 수정할 거 있으면 알려주세요.") | "정보 확인" | ["맞아", "수정할 거 있음"] |

Note: "기존 자료 수집" step ("기존 이력서, 포트폴리오...") is a file/text collection prompt -- no select box needed here (no options to choose from). Use plain text prompt.

### Narrative/Descriptive Questions (No Select Box)

When agents return narrative text without numbered options (e.g., "이 에피소드 더 자세히 얘기해줘"), the orchestrator should pass it through as plain text without AskUserQuestion. The SKILL.md parsing instruction must include this edge case: **if no `N)` pattern is found, deliver as plain text**.

### Anti-Patterns to Avoid

- **DO NOT add AskUserQuestion to SKILL.md frontmatter `allowed-tools`** -- Bug #29547 causes empty responses when AskUserQuestion is in allowed-tools. The tool works correctly when called through normal permission flow. [VERIFIED: github.com/anthropics/claude-code/issues/29547]
- **DO NOT use multiSelect** -- Interview questions are single-select. MultiSelect would confuse episode extraction logic. [Locked decision from CONTEXT.md]
- **DO NOT have agents call AskUserQuestion directly** -- Sub-agents cannot call UI tools; only the orchestrator can. [VERIFIED: github.com/anthropics/claude-code/issues/12890]
- **DO NOT include "직접입력" in AskUserQuestion options** -- It becomes redundant with auto "Other". Including it wastes one of the 4 option slots.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Select box UI | Custom text parsing + rendering | AskUserQuestion native tool | Only native option in Claude Code; select box rendering is built-in |
| "직접입력" option | Manual Other option in agent output | AskUserQuestion auto "Other" | Built into the tool; agents should drop 직접입력 from their output |
| Numbered option parsing | External script/tool | Orchestrator prompt instruction | Locked decision: prompt engineering only, no scripts |

## Common Pitfalls

### Pitfall 1: AskUserQuestion Returns Empty in Skill Context (Bug #29547)
**What goes wrong:** AskUserQuestion silently auto-completes with empty answers when listed in skill's `allowed-tools` frontmatter.
**Why it happens:** Permission evaluator bypasses `requiresUserInteraction()` check when tool is in `alwaysAllowRules`.
**How to avoid:** Do NOT add AskUserQuestion to `allowed-tools` in SKILL.md frontmatter. Leave it to normal permission flow.
**Warning signs:** Tool returns immediately with "User has answered your questions: ." (empty answer).
[VERIFIED: github.com/anthropics/claude-code/issues/29547]

### Pitfall 2: Header Exceeding 12 Characters
**What goes wrong:** AskUserQuestion call fails or truncates if header exceeds 12 characters.
**Why it happens:** Schema enforces max 12 char header.
**How to avoid:** Map agent names to short headers: "시니어" (3), "C-Level" (7), "채용담당자" (5), "인사담당자" (5), "커피챗" (3), "세팅" (2).
**Warning signs:** Tool call rejection or malformed UI.
[VERIFIED: bgauryy gist - schema maxLength for header]

### Pitfall 3: Option Label Too Long
**What goes wrong:** Agent option text like "내가 제안해서 도입했고 팀원 5명 교육까지 맡음" exceeds "1-5 words" label constraint.
**Why it happens:** Agent outputs are conversational Korean text, not UI labels.
**How to avoid:** Instruct orchestrator to use condensed text for `label` and full agent text for `description`. Example: label="제안 도입" description="내가 제안해서 도입".
**Warning signs:** Overly long labels that break UI layout.
[VERIFIED: bgauryy gist - schema constraint on label]

### Pitfall 4: 60-Second Timeout
**What goes wrong:** User doesn't respond within 60 seconds; AskUserQuestion times out.
**Why it happens:** AskUserQuestion has a built-in 60-second timeout per call.
**How to avoid:** This is a known UX issue. The fallback mechanism (retry + text fallback) should handle this case. Workaround for users: select "Other" to pause the timer and type freely.
**Warning signs:** Tool auto-submits an empty or default response.
[CITED: torqsoftware.com/blog/2026/2026-01-14-claude-ask-user-question/]

### Pitfall 5: Agent Returns Narrative Without Options
**What goes wrong:** Orchestrator tries to parse numbered options from text that has none, producing malformed AskUserQuestion call.
**Why it happens:** Some agent responses are narrative follow-ups or confirmations without numbered lists.
**How to avoid:** Orchestrator must detect whether `N)` pattern exists. If not, deliver as plain text.
**Warning signs:** AskUserQuestion with 0 options (below minItems: 2) causing tool call failure.

### Pitfall 6: Profiler Findings Without Natural Options
**What goes wrong:** Findings like "WebSocket 실시간 경험 완전 공백" don't naturally map to select options.
**Why it happens:** Findings are declarative observations, not questions with choices.
**How to avoid:** Wrap findings with a meta-question: "프로파일러 분석 결과가 나왔어요. 이 피드백을 보고 어떻게 할래?" with options like "더 자세히 듣기", "다음으로 넘어가기". Or present as context before the next agent question.
**Warning signs:** Forced/unnatural options that don't help the user.

## Code Examples

### Example 1: Agent Question Conversion

```
# Agent returns this text:
[시니어] Kafka 도입한 거 봤는데, 이거 직접 밀었어 아니면 이미 있던 거야?
  1) 내가 제안해서 도입
  2) 기존에 있었고 활용만
  3) 마이그레이션 작업
  4) 직접입력

# Orchestrator converts to AskUserQuestion:
questions: [{
  question: "[시니어] Kafka 도입한 거 봤는데, 이거 직접 밀었어 아니면 이미 있던 거야?",
  header: "시니어",
  options: [
    { label: "제안 도입", description: "내가 제안해서 도입" },
    { label: "기존 활용", description: "기존에 있었고 활용만" },
    { label: "마이그레이션", description: "마이그레이션 작업" }
  ],
  multiSelect: false
}]
```

### Example 2: Round 0 Session Start

```
# Current SKILL.md text:
이전에 작업하던 이력서 소스가 있네요.
  1) 이어하기
  2) 새로 시작

# Converted to AskUserQuestion:
questions: [{
  question: "이전에 작업하던 이력서 소스가 있네요. 이어할까요?",
  header: "세션",
  options: [
    { label: "이어하기", description: "이전에 작업하던 이력서 소스에서 이어서 진행" },
    { label: "새로 시작", description: "이전 데이터를 무시하고 처음부터 새로 시작" }
  ],
  multiSelect: false
}]
```

### Example 3: Round 0 Job Role Confirmation

```
# Current SKILL.md text:
JD 보니까 {직군} 포지션인데, 본인 직군도 {직군}이 맞아?
1) 맞아
2) 아니, 다른 직군인데 이 포지션에 지원하려는 거
3) 직접입력

# Converted to AskUserQuestion:
questions: [{
  question: "JD 보니까 {직군} 포지션인데, 본인 직군도 {직군}이 맞아?",
  header: "직군 확인",
  options: [
    { label: "맞아", description: "본인 직군과 JD 포지션이 같음" },
    { label: "다른 직군", description: "다른 직군인데 이 포지션에 지원하려는 것" }
  ],
  multiSelect: false
}]
# "직접입력" dropped -- auto "Other" covers it
```

### Example 4: Findings Delivery with AskUserQuestion

```
# Hook delivers: [resume-panel:HIGH] WebSocket 실시간 경험 완전 공백. AX 팀 핵심 갭.

# Orchestrator wraps in AskUserQuestion:
questions: [{
  question: "프로파일러 분석 결과: WebSocket 실시간 경험이 아직 없어요. AX 팀 핵심 갭이에요. 어떻게 할래요?",
  header: "분석 결과",
  options: [
    { label: "관련 경험 있음", description: "실시간 관련 경험이 있는데 아직 얘기 안 한 것" },
    { label: "진짜 없음", description: "실시간 경험이 정말 없음, 갭으로 기록" },
    { label: "넘어가기", description: "이 피드백은 나중에 보기" }
  ],
  multiSelect: false
}]
```

### Example 5: Fallback on Failure

```
# Orchestrator pseudocode for fallback:
1. Parse agent output → call AskUserQuestion
2. If AskUserQuestion fails (empty response, error, timeout):
   a. Show error: "셀렉트 박스 로딩에 문제가 생겼어요. 다시 시도할게요."
   b. Retry AskUserQuestion once
3. If second attempt also fails:
   a. Show fallback: "텍스트로 답변해주세요."
   b. Display original agent text with numbers: "[시니어] 질문\n  1) ...\n  2) ..."
   c. Process user's numbered text response as before
```

## Parsing Rules (Orchestrator Prompt Content)

The orchestrator must follow these parsing rules when converting agent output to AskUserQuestion:

### Extraction Algorithm

1. **Question text**: Everything from `[에이전트명]` up to (but not including) the first `\n  1)` or `\n1)` pattern
2. **Options**: Each `N) text` line becomes an option, where N is sequential
3. **직접입력 removal**: If the last option text is exactly "직접입력", drop it (AskUserQuestion auto-adds "Other")
4. **Header derivation**: Extract agent name from `[에이전트명]` tag. Map to header:
   - `[시니어]` -> "시니어"
   - `[C-Level]` -> "C-Level"
   - `[채용담당자]` -> "채용담당자"
   - `[인사담당자]` -> "인사담당자"
   - `[커피챗: {이름}]` -> "{이름}" (truncate to 12 chars if needed)
5. **Label generation**: Condense option text to 1-5 words for label; use full text as description
6. **No options detected**: If no `N)` pattern found, deliver as plain text (no AskUserQuestion)

### Agent Output Patterns Found in Codebase

All 5 frontstage agents follow this output format:

```
[에이전트명] {질문 텍스트}
  1) {선택지1}
  2) {선택지2}
  3) {선택지3} (optional)
  4) 직접입력
```

Variants:
- 2 options + 직접입력 (recruiter: "1) 있는데... 2) 진짜 없음 3) 직접입력")
- 3 options + 직접입력 (senior, c-level, hr: "1) ... 2) ... 3) ... 4) 직접입력")
- Phase 1 needs to support 2-4 substantive options (after dropping 직접입력)

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Text number selection ("1", "2") | AskUserQuestion select box | Claude Code 2.0+ | Clickable UI instead of typing numbers |
| AskUserQuestion in allowed-tools | AskUserQuestion through normal permission flow | Bug #29547 discovered | Must NOT add to allowed-tools |
| 60-second hard timeout | "Type something else..." pauses timer | Already in current version | Users can take time on complex questions |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | AskUserQuestion answer comes back as `Record<string, string>` mapping question text to selected option label or free text | Architecture Patterns | Orchestrator might misinterpret user response format |
| A2 | When user selects "Other", the free text they type is the value in the answers record | Code Examples | 직접입력 behavior might not work as expected |
| A3 | AskUserQuestion works correctly in current Claude Code 2.1.92 when NOT in allowed-tools | Pitfall 1 | Phase 1 is entirely blocked if tool doesn't work |
| A4 | Header field accepts Korean characters and counts them within 12-char limit | Pitfall 2 | Korean headers might be rejected or truncated differently |
| A5 | The 60-second timeout returns an empty/default response (not an error) | Pitfall 4 | Fallback logic might need different trigger condition |

**A3 is the highest risk assumption.** STATE.md already flags this: "AskUserQuestion이 현재 Claude Code 버전에서 정상 동작하는지 Phase 1 초기에 스파이크 검증 필요". The planner should include a spike/smoke test task as Wave 0.

## Open Questions

1. **AskUserQuestion response format when user selects Other**
   - What we know: "Other" allows free text input [VERIFIED: multiple sources]
   - What's unclear: Exact string format returned (is it the raw text? prefixed with "Other: "?)
   - Recommendation: Spike test in Wave 0 to verify exact format

2. **Timeout behavior**
   - What we know: 60-second timeout exists [CITED: torqsoftware.com]
   - What's unclear: Does timeout return empty answers, an error, or auto-select a default?
   - Recommendation: Include in spike test; fallback handles all cases

3. **Multiple questions in a single AskUserQuestion call**
   - What we know: Schema supports 1-4 questions [VERIFIED: bgauryy gist]
   - What's unclear: Is it better UX to batch questions or send one at a time?
   - Recommendation: Start with 1 question per call (matching current agent behavior), can optimize later

## Project Constraints (from CLAUDE.md)

- **Platform**: Claude Code plugin system (SKILL.md + agents + hooks)
- **Tool constraint**: AskUserQuestion supports 1-4 questions, 2-4 options per question
- **Existing structure preserved**: 4-round structure and agent roles maintained
- **No new agents**: All features integrated into existing agents
- **AskUserQuestion NOT in skill allowed-tools**: bug #29547 prevention (STATE.md decision)
- **GSD workflow**: Use GSD commands for all repo edits

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Manual testing (prompt-driven system, no automated unit tests possible) |
| Config file | N/A -- prompt-only changes |
| Quick run command | Invoke skill: `/resume:resume-panel` and complete one question cycle |
| Full suite command | Complete Round 0 + one Round 1 question with each agent type |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| UX-01 | All agent questions rendered as select box | manual | Invoke skill, verify select box appears for agent question | N/A |
| UX-02 | 2-5 options per question | manual | Count options in select box during interview | N/A |
| UX-03 | All questions include free text option | manual | Verify "Other" option present in every select box | N/A |
| FALLBACK | AskUserQuestion failure triggers text fallback | manual | Unclear how to trigger failure deliberately | N/A |

### Sampling Rate
- **Per task commit:** Manual walkthrough of one Round 0 -> Round 1 cycle
- **Per wave merge:** Full Round 0 + multiple agent question cycles
- **Phase gate:** Complete interview flow through Round 0 + at least 3 agent questions

### Wave 0 Gaps
- [ ] Spike test: Verify AskUserQuestion works in skill context on Claude Code 2.1.92
- [ ] Verify "Other" response format and answer record structure
- [ ] Verify Korean text in header/label/description renders correctly

## Security Domain

This phase involves no authentication, session management, access control, input validation against untrusted data, or cryptography. All changes are prompt engineering within a local CLI tool.

| ASVS Category | Applies | Rationale |
|---------------|---------|-----------|
| V2 Authentication | No | Local CLI tool, no auth |
| V3 Session Management | No | Session managed by Claude Code |
| V4 Access Control | No | No access control changes |
| V5 Input Validation | No | User input is select box choices, handled by Claude Code |
| V6 Cryptography | No | No crypto operations |

## Sources

### Primary (HIGH confidence)
- [Claude Code Tools Reference](https://code.claude.com/docs/en/tools-reference) -- AskUserQuestion listed as built-in tool, "Asks multiple-choice questions to gather requirements or clarify ambiguity", no permission required
- [Internal Claude Code Tools Implementation (bgauryy gist)](https://gist.github.com/bgauryy/0cdb9aa337d01ae5bd0c803943aa36bd) -- Full JSON schema: questions array 1-4, options 2-4, header max 12 chars, label 1-5 words, auto "Other"
- [Bug #29547: AskUserQuestion empty in skill allowed-tools](https://github.com/anthropics/claude-code/issues/29547) -- Root cause: permission evaluator bypasses requiresUserInteraction. Workaround: do NOT add to allowed-tools.
- [Bug #12890: AskUserQuestion not available to subagents](https://github.com/anthropics/claude-code/issues/12890) -- Confirmed: sub-agents cannot call AskUserQuestion regardless of configuration.
- [Claude Code AskUserQuestion System Prompt](https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/tool-description-askuserquestion.md) -- Usage guidance: "Other" always available, "(Recommended)" for suggested options, multiSelect support.
- Codebase: All 5 frontstage agent files verified for output format pattern `[에이전트명] 질문\n  N) 선택지\n  ... 직접입력`

### Secondary (MEDIUM confidence)
- [Claude Code AskUserQuestion First Impressions (torqsoftware)](https://torqsoftware.com/blog/2026/2026-01-14-claude-ask-user-question/) -- 60-second timeout; "Type something else..." pauses timer
- [SmartScope AskUserQuestion Guide](https://smartscope.blog/en/generative-ai/claude/claude-code-askuserquestion-tool-guide/) -- Cannot be used from sub-agents; 4-6 questions per session practical limit
- [Claude Code Changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) -- v2.1.85: PreToolUse hooks can satisfy AskUserQuestion

### Tertiary (LOW confidence)
- [Bug #29773: AskUserQuestion UI not rendered after Skill invocation](https://github.com/anthropics/claude-code/issues/29773) -- Streaming execution flag issue; may or may not be fixed in 2.1.92
- [Bug #33564: AskUserQuestion cards don't render in Cowork](https://github.com/anthropics/claude-code/issues/33564) -- Cowork-specific, likely not affecting standard Claude Code CLI

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- AskUserQuestion is the only native option, schema verified from source
- Architecture: HIGH -- Agent output patterns verified across all 5 agents, parsing rules are straightforward
- Pitfalls: HIGH -- Multiple bugs verified from GitHub issues, workarounds documented
- Spike verification needed: MEDIUM -- A3 assumption (tool works in 2.1.92) needs manual verification

**Research date:** 2026-04-07
**Valid until:** 2026-05-07 (30 days -- AskUserQuestion API is stable built-in tool)
