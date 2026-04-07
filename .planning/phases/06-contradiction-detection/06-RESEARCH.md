# Phase 6: Contradiction Detection - Research

**Researched:** 2026-04-08
**Domain:** NLI-style pairwise claim comparison in Claude Code plugin profiler prompt + orchestrator handling
**Confidence:** HIGH

## Summary

Phase 6 adds contradiction detection to the resume panel interview system. The profiler extracts structured role/contribution claims from episodes during its analysis cycle, categorizes them into 4 types (role_scope, time, scale, contribution), and performs pairwise NLI-style comparison within each category to detect contradictions. Detected contradictions are written to findings-inbox.jsonl as `contradiction_detected` findings and routed through the existing hook pipeline. The orchestrator (SKILL.md) handles HIGH urgency role_scope contradictions immediately via AskUserQuestion with a curious/connecting tone, and MEDIUM urgency contradictions via Conversation Briefing. User responses trigger STAR field updates in resume-source.json.

This phase modifies 2 files: (1) profiler.md gains claim tracking + contradiction detection sections (claim extraction per analysis cycle, pairwise comparison within categories, finding generation with structured context); (2) SKILL.md gains a `contradiction_detected` handler (item 9) that converts findings to AskUserQuestion with restoration questions. No changes to episode-watcher.mjs are needed -- the profiler generates contradiction findings during its natural analysis cycle, and the existing findings-inbox.jsonl pipeline handles delivery. No changes to front-stage agents are needed -- the orchestrator handles contradiction presentation directly without delegating to agents.

The implementation follows the identical pattern established in Phase 4 (pattern analysis in profiler.md, pattern_detected handler in SKILL.md) and Phase 5 (perspective shift detection in profiler.md, perspective_shift handler in SKILL.md). Each modification is a prompt section addition, not a code change. The "stack" remains prompt engineering within the existing agent system.

**Primary recommendation:** Implement in 2 plans -- Plan 01 adds claim tracking + contradiction detection sections to profiler.md (prompt additions); Plan 02 adds contradiction_detected handling rules + STAR field update logic to SKILL.md (depends on Plan 01 for finding format).

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- profiler.md 자율 오케스트레이션에 claim 추적 섹션 추가 -- 프로파일러 사이클마다 역할/기여도 claim을 구조화 추출
- 4개 카테고리: role_scope, time, scale, contribution -- 같은 카테고리 내에서만 pairwise 비교 (N^2 방지)
- NLI-스타일 프롬프트로 pairwise claim 비교 -- Claude 내장 NLI 능력 활용, 외부 API/모델 금지 (CLAUDE.md)
- role_scope 모순 -> HIGH urgency (즉시), time/scale/contribution 모순 -> MEDIUM urgency (Conversation Briefing)
- 연결 톤 -- "아까 이야기랑 연결해보면..." 형태, 비난/지적 톤 금지 (CLAUDE.md)
- "likely cause: 겸손에 의한 축소" 태그 -- role_scope 모순은 기본적으로 과소보고로 추정 (한국 문화 특성)
- AskUserQuestion으로 "실제로 어디까지 했어?" 형태 복원 질문 -> 유저 응답에 따라 STAR 필드 업데이트
- 세션당 최대 2개 모순 제시 -- 과도한 모순 지적은 신뢰 손상, 역효과
- profiler.md에 claim 추적 + 모순 탐지 섹션 추가 + SKILL.md에 contradiction_detected 핸들러 추가 (2개 파일)
- type: contradiction_detected, context에 claim_a, claim_b, contradiction_type, likely_cause, restoration_question 포함
- SKILL.md 오케스트레이터가 직접 AskUserQuestion으로 변환하여 유저에게 제시 -- 별도 에이전트 호출 불필요
- 유저 응답 기반으로 오케스트레이터가 resume-source.json 해당 에피소드 STAR 필드 직접 업데이트

### Claude's Discretion
- profiler.md claim 추출 프롬프트의 구체적 구조와 출력 형식
- NLI comparison 프롬프트의 세부 판단 기준
- contradiction_detected finding의 JSON 스키마 세부사항
- STAR 필드 업데이트 시 어떤 필드를 수정할지 (action, result, situation 등)

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CONTR-01 | 인터뷰 전체에 걸쳐 역할/기여도 관련 클레임 추적 | profiler.md에 claim 추적 섹션 추가. 프로파일러 사이클마다 에피소드 STAR 데이터에서 역할/기여도 claim을 구조화 추출. 4개 카테고리(role_scope, time, scale, contribution)로 분류. 같은 카테고리 내에서만 pairwise NLI 비교로 모순 탐지. |
| CONTR-02 | 모순 발견 시 비난이 아닌 연결 톤으로 제시 | SKILL.md에 contradiction_detected 핸들러 추가. "아까 이야기랑 연결해보면..." 형태의 연결 톤 프레이밍. "likely cause: 겸손에 의한 축소" 태그로 한국 문화 특성 반영. AskUserQuestion으로 복원 질문 제시 (겸손 옵션 포함). 세션당 최대 2개 모순 제시로 신뢰 보호. |
| CONTR-03 | False positive 최소화를 위해 컨텍스트(회사/프로젝트/기간) 기반 스코핑 | claim 추출 시 회사/프로젝트/기간 컨텍스트를 함께 추출. 같은 카테고리 + 같은 또는 유사한 컨텍스트 내에서만 비교하여 false positive 방지. 서로 다른 역할/기간의 정당한 차이를 모순으로 오분류하지 않음. |
</phase_requirements>

## Standard Stack

### Core Approach: Prompt Engineering Within Existing Agent System

No external libraries or code changes needed. The "stack" is prompt section additions to existing markdown agent files, following patterns established in Phase 4 (pattern analysis) and Phase 5 (perspective shift detection).

| Component | Technique | Purpose | Confidence |
|-----------|-----------|---------|------------|
| Claim Extraction | Structured extraction prompt in profiler.md | Extract role/contribution claims from STAR data | HIGH |
| Claim Categorization | 4-category taxonomy (role_scope, time, scale, contribution) | Narrow comparison scope, prevent N^2 explosion | HIGH |
| Context Scoping | Company/project/period metadata per claim | Prevent false positives from cross-context comparison | HIGH |
| Pairwise NLI Comparison | Within-category entailment/contradiction/neutral judgment | Detect genuine contradictions | HIGH |
| Finding Generation | contradiction_detected JSON to findings-inbox.jsonl | Route through existing pipeline | HIGH |
| Orchestrator Handling | SKILL.md handler item 9 with AskUserQuestion | Present contradictions with connecting tone | HIGH |
| STAR Update | Bash tool JSON rewrite of resume-source.json | Update corrected information after resolution | HIGH |

[VERIFIED: codebase inspection of profiler.md, SKILL.md, episode-watcher.mjs, c-level.md, hr.md]

### No Installation Required

```
# No install commands. The "stack" is prompt engineering.
```

## Architecture Patterns

### File Modification Map

```
plugins/resume/
  .claude/agents/
    profiler.md          # ADD: claim tracking + contradiction detection sections
  skills/resume-panel/
    SKILL.md             # ADD: contradiction_detected handler (item 9)
```

### Pattern 1: Claim Extraction in Profiler Analysis Cycle

**What:** The profiler extracts structured claims from episode STAR data during each analysis cycle, categorizes them, and stores them in a structured format within its analysis output.

**When to use:** Every profiler cycle (triggered by episode-watcher.mjs scoring threshold).

**Key Design:**

Claims are extracted from episodes' STAR fields (primarily action and result) with context metadata:

```json
{
  "claim_id": "cl-{episode_ref}-{seq}",
  "category": "role_scope",
  "text": "Kafka 마이그레이션을 직접 주도했다",
  "episode_ref": "카프카 마이그레이션",
  "company": "A사",
  "project": "데이터 파이프라인",
  "period": "2023.03 - 2024.06",
  "star_field": "action"
}
```

[ASSUMED] -- The specific claim JSON schema is Claude's discretion per CONTEXT.md. This is a recommended structure based on the locked decision fields.

**Why structured extraction first:** Research (arxiv:2504.00180) shows that comparing raw conversation text produces ~17% false positive rate from linguistic rather than factual contradictions. Explicit claim extraction before comparison is the established best practice. [CITED: arxiv.org/html/2504.00180v1]

### Pattern 2: Within-Category Pairwise NLI Comparison

**What:** After claim extraction, the profiler compares claims within the same category using NLI-style judgment (entailment/contradiction/neutral).

**When to use:** After claims are extracted and categorized.

**Key Design:**

- Only compare claims in the SAME category (role_scope vs role_scope, not role_scope vs time)
- Apply context scoping: same or overlapping company/project/period context
- For each contradicting pair, determine likely_cause (겸손에 의한 축소 for role_scope)

NLI judgment prompt structure:
```
Claim A: "{claim_a_text}" (에피소드: {episode_a}, 회사: {company_a})
Claim B: "{claim_b_text}" (에피소드: {episode_b}, 회사: {company_b})

관계 판단:
- ENTAILMENT: A와 B가 일관됨
- CONTRADICTION: A와 B가 모순됨
- NEUTRAL: 비교 불가능 (다른 맥락)

CONTRADICTION이면:
- 모순 유형: {role_scope|time|scale|contribution}
- 축소 방향: 어느 쪽이 더 큰 역할/기여를 주장하는가
- 추정 원인: 겸손에 의한 축소 / 기억 오류 / 맥락 차이
```

**Why within-category only:** Without categories, N claims would need N*(N-1)/2 pairwise comparisons. With 4 categories, each category has ~N/4 claims, reducing comparisons to 4 * (N/4 * (N/4-1)/2) = roughly N^2/8. For typical interview volumes (10-30 episodes, maybe 20-60 claims), this is well within LLM prompt capacity. [VERIFIED: CLAUDE.md explicitly requires within-category comparison]

**Research finding:** Claude-3 Sonnet with CoT prompting achieved 0.710 accuracy on contradiction detection, with 0.951 precision and 0.566 recall. The HIGH precision / lower recall characteristic is actually ideal for this use case -- we prefer to miss some contradictions rather than present false positives that damage user trust. [CITED: arxiv.org/html/2504.00180v1]

### Pattern 3: Context-Based Scoping for False Positive Prevention

**What:** Claims carry company/project/period metadata and are only compared when their contexts overlap or are comparable.

**When to use:** During pairwise comparison step.

**Key Design:**

The profiler must distinguish between:
1. **Genuine contradiction:** "A사에서 Kafka 마이그레이션 주도" vs "같은 프로젝트에서 도움만 줬다" (same context, conflicting roles)
2. **Legitimate difference:** "A사에서 주니어" vs "B사에서 리드" (different companies, natural career growth)
3. **Context gap:** "2023년 초에 참여" vs "2024년에 리드" (different time, role evolution)

Scoping rules:
- Same company + same project: direct comparison valid
- Same company + different project: compare only if overlapping periods
- Different companies: compare only for cross-company consistency claims (rare, mostly patterns)
- Different time periods with >1 year gap: flag as possible growth, not contradiction

[VERIFIED: CONTEXT.md locks "컨텍스트(회사/프로젝트/기간) 기반 스코핑으로 false positive 최소화"]

### Pattern 4: Contradiction Finding Format (Following Established Pipeline)

**What:** Contradiction findings follow the exact same JSONL format as pattern_detected and perspective_shift findings.

**Key Design:**

```json
{
  "id": "cd-{timestamp}",
  "type": "contradiction_detected",
  "urgency": "HIGH",
  "source": "profiler",
  "message": "역할 모순 발견: '{에피소드A}'에서 '{claim_a 요약}', '{에피소드B}'에서 '{claim_b 요약}'. 추정: 겸손에 의한 축소.",
  "context": {
    "claim_a": {
      "claim_id": "cl-...",
      "text": "...",
      "episode_ref": "...",
      "company": "...",
      "star_field": "action"
    },
    "claim_b": {
      "claim_id": "cl-...",
      "text": "...",
      "episode_ref": "...",
      "company": "...",
      "star_field": "result"
    },
    "contradiction_type": "role_scope",
    "likely_cause": "겸손에 의한 축소",
    "restoration_question": "아까 {에피소드A}에서 {claim_a} 했다고 했잖아. 근데 {에피소드B}에서는 {claim_b}라고 했거든. 실제로는 어디까지 한 거야?"
  },
  "created_at": "{ISO timestamp}"
}
```

[VERIFIED: CONTEXT.md locks "type: contradiction_detected, context에 claim_a, claim_b, contradiction_type, likely_cause, restoration_question 포함"]

### Pattern 5: SKILL.md Handler with AskUserQuestion + STAR Update

**What:** The orchestrator receives contradiction findings and presents them to the user with a connecting/curious tone using AskUserQuestion. After user response, updates the relevant STAR fields.

**Key Design:**

Handler placement: Item 9 in the message handling rules (after perspective_shift handler item 8).

For HIGH urgency (role_scope):
```
AskUserQuestion({
  questions: [{
    question: "아까 이야기랑 연결해보면, {에피소드A}에서는 {claim_a_summary}라고 했는데 {에피소드B}에서는 {claim_b_summary}라고 했거든. 실제로는 어디까지 한 거야?",
    header: "연결 확인",
    options: [
      { label: "{큰 역할}", description: "{claim with bigger role}" },
      { label: "{작은 역할}", description: "{claim with smaller role}" },
      { label: "상황이 달랐음", description: "두 경험의 맥락이 달라서 역할이 다른 거야" }
    ],
    multiSelect: false
  }]
})
```

For MEDIUM urgency (time/scale/contribution): include in Conversation Briefing at next natural breakpoint, following existing MEDIUM delivery rules.

STAR update after user response:
- If user selects the larger role: update the episode with the smaller claim to reflect the larger role
- If user selects the smaller role: update the episode with the larger claim to reflect the smaller role
- If user says "상황이 달랐음": mark both as valid in their respective contexts, no update needed

[VERIFIED: CONTEXT.md locks "SKILL.md 오케스트레이터가 직접 AskUserQuestion으로 변환" and "유저 응답 기반으로 오케스트레이터가 resume-source.json 해당 에피소드 STAR 필드 직접 업데이트"]

### Anti-Patterns to Avoid

- **Raw text comparison:** Do NOT compare raw conversation history for contradictions. Extract structured claims first. Raw text has ~17% false positive rate from linguistic artifacts. [CITED: CLAUDE.md, openreview.net/forum?id=EmQSOi1X2f]
- **Cross-category comparison:** Do NOT compare claims across different categories (e.g., role_scope claim vs time claim). This produces meaningless comparisons. [VERIFIED: CONTEXT.md]
- **Accusatory framing:** Do NOT use "앞뒤가 안 맞는데" or "아까 X라고 했는데 왜 Y라고 해?" tone. Use curious/connecting tone only. [VERIFIED: CLAUDE.md]
- **Over-flagging:** Do NOT present more than 2 contradictions per session. Excessive contradiction flagging damages user trust and interview flow. [VERIFIED: CONTEXT.md]
- **External NLI model:** Do NOT import DeBERTa or call external NLI APIs. Claude's built-in NLI capability is sufficient for <50 claim pairs. [VERIFIED: CLAUDE.md]
- **New agent creation:** Do NOT create a contradiction agent. The orchestrator handles presentation directly. [VERIFIED: CONTEXT.md]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Findings pipeline | Custom event system | findings-inbox.jsonl + episode-watcher.mjs routing | Already handles HIGH/MEDIUM/LOW urgency routing |
| User interaction | Direct text output | AskUserQuestion via SKILL.md orchestrator | Consistent UX with all other findings |
| NLI comparison | External NLI model or API | Claude's built-in NLI via prompt | No external runtime in Claude Code plugin sandbox |
| Session limiting | Custom counter system | meta.json counter pattern | Already used for perspective_shifts_this_session, gap_probes_this_session |
| Claim storage | Separate database/file | Profiler prompt output + findings-inbox.jsonl | Profiler already maintains state per analysis cycle |

**Key insight:** Every infrastructure component needed for contradiction detection already exists in the codebase. The only work is adding prompt sections to profiler.md and handling rules to SKILL.md.

## Common Pitfalls

### Pitfall 1: Career Growth Misclassified as Contradiction

**What goes wrong:** User says "I was a junior at Company A" and "I led the team at Company B" -- these are not contradictions but career growth across companies.
**Why it happens:** Without temporal and company context scoping, any difference in role description looks contradictory.
**How to avoid:** Context scoping rules must explicitly account for time progression and company changes. Claims from different companies AND different time periods should be marked NEUTRAL unless they reference the same specific event/project.
**Warning signs:** High rate of "상황이 달랐음" responses from users indicates false positives.

### Pitfall 2: Korean Self-Deprecation Pattern as False Contradiction

**What goes wrong:** User describes the same event differently in two conversations -- initially saying "I helped" (도움) and later saying "I led" after the system prompted for more detail. System flags this as contradiction.
**Why it happens:** Korean cultural context leads to initial understatement that gets corrected through the interview process. The "correction" is actually the truth emerging.
**How to avoid:** The profiler should track claim evolution direction. If claim_b (later) is LARGER in scope than claim_a (earlier) AND category is role_scope, the likely_cause should be "겸손에 의한 축소" and the restoration_question should validate the LARGER claim, not question it.
**Warning signs:** Most "contradictions" are always in the direction of initial understatement -> later correction.

### Pitfall 3: Prompt Length Inflation in profiler.md

**What goes wrong:** Adding claim tracking + contradiction detection sections significantly increases profiler.md prompt length, potentially degrading existing profiler capabilities (pattern analysis, perspective shift detection).
**Why it happens:** "Lost in the middle" effect -- LLMs lose focus on instructions in the middle of very long prompts.
**How to avoid:** Keep the new sections concise and place them strategically. Claim tracking can piggyback on existing episode analysis (the profiler already reads all episodes). Contradiction detection section should be at the end, after existing sections, with clear section headers.
**Warning signs:** Profiler stops generating pattern or perspective shift findings after contradiction sections are added. STATE.md already flags this concern: "Phase 4 profiler.md 프롬프트 길이 증가로 인한 기존 기능 품질 저하 가능성".

### Pitfall 4: Immediate Contradiction Flagging Disrupts Interview Flow

**What goes wrong:** A role_scope contradiction is flagged (HIGH urgency) in the middle of a deep-dive conversation, jarring the user out of their recall context.
**Why it happens:** HIGH urgency findings are delivered after the current question-answer cycle, which can break conversational momentum.
**How to avoid:** SKILL.md handler must respect the established interview flow protection rules (line 533-546 of current SKILL.md). Contradiction presentation happens after the current Q&A cycle completes but before the next agent question, not interrupting multi-turn flows like So What chain.
**Warning signs:** User seems confused or defensive after contradiction presentation.

### Pitfall 5: STAR Field Update Overwrites Valid Data

**What goes wrong:** After contradiction resolution, the orchestrator overwrites the wrong STAR field or replaces nuanced content with simplified text.
**Why it happens:** The STAR update logic must identify which specific field(s) to modify based on the claim context (action vs result vs situation) and update only the relevant parts.
**How to avoid:** Claims carry `star_field` metadata indicating which STAR field they were extracted from. Update only the referenced field in the referenced episode. Preserve existing content and amend/correct rather than replacing entirely.
**Warning signs:** Episodes lose detail after contradiction resolution.

## Code Examples

Verified patterns from the existing codebase:

### Profiler Finding Generation (Existing Pattern)

```markdown
# From profiler.md -- pattern_detected finding format (already in codebase)
{"id":"pt-{timestamp}","type":"pattern_detected","urgency":"MEDIUM","source":"profiler",
 "message":"패턴 발견: '{패턴 이름}' -- {회사1}({에피소드1}), {회사2}({에피소드2})에서 반복.",
 "context":{"pattern_name":"{패턴 이름}","category":"{역할반복|기술선택|성장전환|문제해결}",
 "evidence_episodes":[...],"suggested_question":"{질문}","target_agent":"{에이전트}"},
 "created_at":"{ISO timestamp}"}
```
Source: [VERIFIED: plugins/resume/.claude/agents/profiler.md lines 107-112]

### SKILL.md Handler Pattern (Existing Pattern)

```markdown
# From SKILL.md -- perspective_shift handler (item 8, already in codebase)
8. **`[resume-panel:MEDIUM]` (perspective_shift)** -> 관점 전환 질문
   - MEDIUM 메시지 내용에 "관점 전환"이 포함되어 있으면 perspective_shift finding으로 판단
   - meta.json의 `perspective_shifts_this_session` 카운터 확인 -- 2 이상이면 무시
   - context에서 target_agent 확인 -- 해당 에이전트를 관점 전환 모드로 호출
```
Source: [VERIFIED: plugins/resume/skills/resume-panel/SKILL.md lines 517-531]

### AskUserQuestion with Connecting Tone (Recommended for Contradiction)

```markdown
# Recommended: contradiction_detected handler AskUserQuestion format
AskUserQuestion({
  questions: [{
    question: "아까 이야기랑 연결해보면, {에피소드A}에서 {Kafka 마이그레이션 직접 주도}했다고 했잖아. 근데 {에피소드B}에서는 {팀에서 도움만 줬다}고 했거든. 실제로는 어디까지 한 거야?",
    header: "연결 확인",
    options: [
      { label: "직접 주도", description: "내가 직접 제안하고 실행까지 리드했음" },
      { label: "도움 역할", description: "다른 사람이 리드하고 나는 도움을 줬음" },
      { label: "상황이 달랐음", description: "두 에피소드의 상황이 달라서 역할이 다른 것" }
    ],
    multiSelect: false
  }]
})
```
[ASSUMED] -- Specific wording is Claude's discretion. The pattern follows established AskUserQuestion usage in SKILL.md.

### STAR Field Update via Bash (Existing Pattern)

```bash
# From SKILL.md -- resume-source.json update pattern (already in codebase)
cat <<'EOF' > ./resume-source.json
{ ... 전체 JSON ... }
EOF
```
Source: [VERIFIED: plugins/resume/skills/resume-panel/SKILL.md line 624]

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Raw text contradiction detection | Structured claim extraction -> NLI comparison | 2024-2025 research | 17% reduction in false positives from linguistic artifacts |
| General NLI models (DeBERTa etc.) | LLM-native NLI with CoT prompting | 2024-2025 | Claude Sonnet achieves 0.71 accuracy with 0.95 precision on contradiction detection |
| Accusatory contradiction framing | Curious/connecting tone framing | Interview coaching best practice | Better user engagement and truth disclosure |

**Key insight from research:** Claude Sonnet with CoT prompting has HIGH precision (0.951) but lower recall (0.566) for contradiction detection. This is actually ideal for this use case -- we prefer to miss some contradictions rather than present false positives that damage user trust. [CITED: arxiv.org/html/2504.00180v1]

## Assumptions Log

> List all claims tagged [ASSUMED] in this research.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Recommended claim JSON schema structure (claim_id, category, text, episode_ref, company, project, period, star_field) | Architecture Patterns - Pattern 1 | Low -- schema is Claude's discretion per CONTEXT.md. Planner can adjust field names without impact. |
| A2 | AskUserQuestion wording for contradiction presentation | Code Examples | Low -- specific wording is Claude's discretion. The pattern and tone constraints are locked. |
| A3 | "상황이 달랐음" as third option in restoration question | Architecture Patterns - Pattern 5 | Low -- provides escape hatch for context differences. Specific wording adjustable. |

**All critical architectural decisions are verified from CONTEXT.md and CLAUDE.md. Assumed items are limited to discretionary implementation details.**

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Node.js assert (native) |
| Config file | None -- direct script execution |
| Quick run command | `node plugins/resume/scripts/test-episode-watcher.mjs` |
| Full suite command | `node plugins/resume/scripts/test-episode-watcher.mjs` |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CONTR-01 | Claim tracking across episodes | manual-only | N/A -- prompt engineering, no code to test | N/A |
| CONTR-02 | Connecting tone in contradiction presentation | manual-only | N/A -- prompt output quality, not code | N/A |
| CONTR-03 | Context-based scoping for false positive prevention | manual-only | N/A -- prompt engineering logic, not code | N/A |

**Justification for manual-only:** Phase 6 modifies only markdown prompt files (profiler.md, SKILL.md). There are no code changes to episode-watcher.mjs or any JavaScript files. The existing test suite tests hook behavior, not prompt quality. Prompt engineering changes are validated through manual interview testing, not automated tests.

### Wave 0 Gaps

None -- no new test infrastructure needed. Phase 6 is entirely prompt engineering with no code changes.

## Open Questions

1. **Profiler prompt length budget**
   - What we know: profiler.md is already 225 lines with pattern analysis + perspective shift detection. Claim tracking + contradiction detection will add significant content.
   - What's unclear: Exact threshold where "lost in the middle" effect degrades existing capabilities.
   - Recommendation: Keep new sections concise. Claim extraction can be brief instructions since the profiler already reads episode data. Contradiction detection section can be a focused prompt block. Monitor existing pattern/perspective functionality after adding contradiction sections.

2. **Contradiction resolution ambiguity**
   - What we know: When user selects "상황이 달랐음", no STAR update is needed. When user selects bigger/smaller role, the other episode's STAR field should be updated.
   - What's unclear: What if the contradiction spans multiple STAR fields (e.g., action says one thing, result says another within the same episode)?
   - Recommendation: The claim's `star_field` metadata identifies which field to update. If contradictions span fields within one episode, update only the field referenced by the claim being corrected.

3. **Session counter persistence**
   - What we know: meta.json already tracks `perspective_shifts_this_session` and `gap_probes_this_session`.
   - What's unclear: How "session" is defined -- is it reset on each SKILL.md invocation or persists across invocations within the same user conversation?
   - Recommendation: Follow the same session definition as perspective shifts. Add `contradictions_presented_this_session` counter to meta.json following the identical pattern.

## Project Constraints (from CLAUDE.md)

Actionable directives extracted from CLAUDE.md relevant to Phase 6:

1. **Raw text comparison forbidden:** "Do NOT compare raw conversation text for contradictions. Extract structured claims first. Raw text comparison has high false-positive rates."
2. **Structured claim extraction required:** "The key is EXPLICIT claim extraction before comparison."
3. **4 categories for comparison:** "Claim categorization (role_scope, time, scale, contribution) narrows comparison scope."
4. **Korean cultural context default:** "The system should assume role-scope contradictions are usually under-reporting, not lying."
5. **HIGH urgency for role_scope only:** "Only role_scope contradictions get HIGH urgency. Time/scale contradictions may be MEDIUM."
6. **Accusatory framing forbidden:** "Do NOT use accusatory framing. Use curious framing."
7. **No external NLI:** "Do NOT build a separate NLI model or call an external API."
8. **No immediate flagging of all contradictions:** "Do NOT flag every contradiction to the user immediately. Route through the profiler's findings system."
9. **No new agents:** "기존 9개 에이전트에 기능 통합 방식으로 진행" (integrate into existing agents).
10. **AskUserQuestion constraints:** 질문당 최대 4개 옵션, multiSelect always false.
11. **Tone constraint:** 칭찬/감탄 금지, 팩폭 허용, 연결 톤 사용.

## Sources

### Primary (HIGH confidence)
- [Codebase inspection] -- profiler.md (225 lines, autonomous orchestration mode with pattern analysis + perspective shift detection, findings-inbox.jsonl pipeline)
- [Codebase inspection] -- SKILL.md (628+ lines, 8 message handlers, AskUserQuestion conversion rules, meta.json state tracking)
- [Codebase inspection] -- episode-watcher.mjs (420 lines, PostToolUse hook with scoring, gap detection, findings routing)
- [Codebase inspection] -- c-level.md (So What chain mode, perspective shift mode patterns)
- [Codebase inspection] -- hr.md (gap probing mode, perspective shift mode patterns)

### Secondary (MEDIUM confidence)
- [Contradiction Detection in RAG Systems (arxiv:2504.00180)](https://arxiv.org/html/2504.00180v1) -- Claude Sonnet with CoT achieves 0.710 accuracy, 0.951 precision, 0.566 recall on contradiction detection
- [Self-contradictory Hallucinations of LLMs (OpenReview)](https://openreview.net/forum?id=EmQSOi1X2f) -- 17.7% self-contradiction rate in raw text; structured prompting reduces this
- [ALICE: Automated Logic for Identifying Contradictions](https://link.springer.com/article/10.1007/s10515-024-00452-x) -- Formal logic + LLM hybrid outperforms LLM-only by detecting 60% of contradictions

### Tertiary (LOW confidence)
- None -- all claims verified against codebase or cited research

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- entirely prompt engineering in established codebase patterns
- Architecture: HIGH -- follows identical Phase 4/5 patterns (profiler section + SKILL.md handler)
- Pitfalls: HIGH -- identified from CLAUDE.md explicit warnings + codebase structure analysis + research findings

**Research date:** 2026-04-08
**Valid until:** 2026-05-08 (30 days -- stable prompt engineering domain, no external dependencies)
