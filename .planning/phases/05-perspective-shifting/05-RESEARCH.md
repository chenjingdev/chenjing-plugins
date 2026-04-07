# Phase 5: Perspective Shifting - Research

**Researched:** 2026-04-08
**Domain:** LLM role-play perspective injection into existing agent prompts for Korean resume interview system
**Confidence:** HIGH

## Summary

Phase 5 adds perspective shifting capability to the resume panel interview system. When the profiler detects that a user is understating their contributions in leadership/collaboration episodes, it generates a `perspective_shift` finding that routes through the existing findings-inbox.jsonl pipeline. The orchestrator (SKILL.md) then invokes the appropriate front-stage agent (HR or C-Level) with a perspective context frame, causing the agent to ask questions from a third-person viewpoint (junior team member, PM, boss, customer) that bypasses the user's self-deprecation filter.

This phase modifies 4 files: (1) profiler.md gains a perspective shift detection section that identifies understatement signals and generates `perspective_shift` findings with target_perspective, target_agent, episode_ref, and scene_hint fields; (2) HR.md gains a perspective shifting mode section for leadership/collaboration perspectives; (3) C-Level.md gains a perspective shifting mode section for problem-solving/achievement perspectives; (4) SKILL.md gains a `perspective_shift` message handler (item 8) that routes findings to the designated agent with perspective context. No changes to episode-watcher.mjs are needed -- the profiler generates findings during its natural analysis cycle, and the existing findings-inbox.jsonl pipeline handles delivery.

The implementation follows the identical pattern established in Phase 3 (So What chain mode in C-Level) and Phase 4 (gap probing mode in HR, pattern analysis in profiler, orchestration rules in SKILL.md). Each modification is a prompt section addition, not a code change. The "stack" remains prompt engineering within the existing agent system.

**Primary recommendation:** Implement in 2 plans -- Plan 01 adds perspective shift detection to profiler.md + perspective shifting mode sections to HR.md and C-Level.md (prompt additions, no dependencies); Plan 02 adds perspective_shift handling rules to SKILL.md (depends on Plan 01 for finding format and agent mode definitions).

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- profiler finding-based trigger -- profiler flags undervaluation episodes via findings-inbox, routed to agents through existing pipeline (Phase 4 pattern)
- profiler's existing pattern analysis detects episodes where STAR result is weak relative to company scale, designates them for perspective shifting
- Only leadership/collaboration type episodes + profiler-detected undervaluation episodes are candidates (not all episodes)
- Maximum 2 perspective shift questions per session -- fatigue prevention
- CLAUDE.md mapping table: leadership -> junior (HR), collaboration -> PM (HR/senior), problem-solving -> boss (C-Level), achievement -> customer (C-Level)
- Concrete scene descriptions mandatory -- "팀 회식 자리에서 상사가 이 프로젝트 성과를 어떻게 설명할까?" format, abstract questions forbidden
- profiler.md generates perspective_shift finding -> SKILL.md routes to designated agent with perspective context (reuses Phase 4 findings pipeline)
- Curiosity + recognition tone -- "주니어 입장에서 보면, 네가 한 게 더 대단해 보일 수 있거든" -- bypasses user's self-diminishment filter
- profiler.md perspective shift detection section added (under pattern analysis section)
- type: perspective_shift, urgency: MEDIUM -- delivered via Conversation Briefing naturally
- HR.md + C-Level.md gain perspective shifting mode sections + profiler.md gains detection section + SKILL.md gains routing rules -- no new agents
- Finding context includes target_perspective, target_agent, episode_ref, scene_hint -> SKILL.md routes to designated agent

### Claude's Discretion
- profiler.md undervaluation detection prompt: specific judgment criteria and output format
- HR.md / C-Level.md perspective shifting mode: question generation prompt structure details
- scene_hint generation method (auto-inferred from episode STAR data)
- perspective_shift finding JSON schema details

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PERSP-01 | 리더십/협업 에피소드에서 타인 시점(PM, 주니어, 상사, 외부) 질문 자동 생성 | HR.md + C-Level.md perspective shifting mode sections with CLAUDE.md mapping table. HR handles leadership(junior perspective) + collaboration(PM perspective). C-Level handles problem-solving(boss/CTO perspective) + achievement(customer perspective). Triggered by profiler's perspective_shift finding routed through SKILL.md. |
| PERSP-02 | 관점 전환 질문이 구체적 장면 묘사를 포함 (추상적 질문 금지) | profiler.md generates scene_hint from episode STAR data (situation + action context). Agent mode sections enforce concrete scene framing: "팀 회식 자리에서...", "코드 리뷰 때...", "스프린트 회고에서..." format. Abstract "타인이 어떻게 볼까?" questions explicitly forbidden in prompt. |
| PERSP-03 | 프로파일러 패턴 데이터와 연동하여 전략적으로 트리거 | profiler.md perspective detection section uses existing pattern analysis data + 과소평가 signals (from Phase 2 minimization keywords). Triggers only when: (a) episode type is leadership/collaboration, (b) STAR result is vague/weak relative to company scale, OR (c) profiler behavioral profile flags user as "과소평가형". Maximum 2 per session tracked via meta.json counter. |
</phase_requirements>

## Standard Stack

### Core Approach: Prompt Engineering Within Existing Agent System

No external libraries or code changes needed. The "stack" is prompt section additions to existing markdown agent files, following patterns established in Phase 3 (So What mode) and Phase 4 (gap probing mode, pattern analysis).

| Component | Technique | Purpose | Confidence |
|-----------|-----------|---------|------------|
| Undervaluation Detection | Structured analysis criteria in profiler.md | Identify episodes where user understates contributions | HIGH |
| Perspective Assignment | CLAUDE.md mapping table in profiler finding | Match episode type to appropriate perspective + agent | HIGH |
| Scene Hint Generation | STAR data extraction in profiler prompt | Provide concrete scene context for question framing | HIGH |
| Perspective Questions (HR) | Role-framed prompt section in hr.md | Generate junior/PM perspective questions | HIGH |
| Perspective Questions (C-Level) | Role-framed prompt section in c-level.md | Generate boss/customer perspective questions | HIGH |
| Orchestration Routing | SKILL.md message handler item 8 | Route perspective_shift findings to designated agents | HIGH |
| Session Limiting | meta.json counter (perspective_shifts_this_session) | Enforce max 2 perspective shifts per session | HIGH |

[VERIFIED: codebase inspection of profiler.md, hr.md, c-level.md, SKILL.md, episode-watcher.mjs]

### No Installation Required

```
# No install commands. The "stack" is prompt engineering.
```

## Architecture Patterns

### File Modification Map

```
plugins/resume/
  .claude/agents/
    profiler.md      # ADD: perspective shift detection section (after pattern analysis)
    hr.md            # ADD: perspective shifting mode section (after gap probing mode)
    c-level.md       # ADD: perspective shifting mode section (after So What chain mode)
  skills/resume-panel/
    SKILL.md         # ADD: perspective_shift handler (item 8 in message handling rules)
```

### Pattern 1: Profiler Finding -> Agent Mode Pipeline (Reuse from Phase 4)

**What:** Profiler detects a condition during analysis, writes a finding to findings-inbox.jsonl, hook routes it to orchestrator, orchestrator invokes specific agent in a special mode.
**When to use:** This is the established pattern for all analytical features (So What, gap probing, pattern detection, and now perspective shifting).
**Flow:**
```
profiler.md analysis
  -> writes perspective_shift finding to findings-inbox.jsonl
  -> episode-watcher.mjs hook picks up, routes via urgency
  -> SKILL.md receives [resume-panel:MEDIUM] with perspective_shift content
  -> SKILL.md invokes HR or C-Level with perspective context
  -> Agent generates perspective-framed question
  -> AskUserQuestion conversion (existing rules)
```

[VERIFIED: codebase inspection shows this exact pipeline for timeline_gap_found and pattern_detected in Phase 4]

### Pattern 2: Agent Mode Section Structure (Reuse from Phase 3/4)

**What:** Each agent can operate in multiple "modes" -- each mode is a separate markdown section with its own input spec, question generation rules, and output format.
**Existing modes:**
- C-Level: normal mode + So What chain mode (Phase 3)
- HR: normal mode + gap probing mode (Phase 4)
**New modes added by this phase:**
- HR: + perspective shifting mode (leadership/collaboration perspectives)
- C-Level: + perspective shifting mode (problem-solving/achievement perspectives)

**Structure pattern (from existing modes):**
```markdown
## {Mode Name} 모드

오케스트레이터가 {trigger condition}으로 호출하면, {specific behavior}.

### 입력

오케스트레이터가 다음을 전달한다:
- {context fields}

### 질문 생성 규칙

{mode-specific rules}

### 질문 패턴

{example questions with concrete scenarios}

### 산출 형식

{output format following [에이전트명] convention}

### 핵심 규칙

- {critical constraints}
```

[VERIFIED: codebase inspection of c-level.md So What mode (lines 110-158) and hr.md gap probing mode (lines 79-122)]

### Pattern 3: Profiler Detection Section Structure

**What:** Profiler.md has structured analysis sections that output findings in specific JSON format.
**Existing sections:** Pattern analysis (Phase 4) with 4 categories + finding output format.
**New section:** Perspective shift detection with undervaluation criteria + finding output format.

**Detection section follows profiler.md's established pattern:**
1. Trigger condition (when to analyze)
2. Detection criteria (what signals to look for)
3. Output format (JSON finding structure)
4. Restrictions (when NOT to trigger)

[VERIFIED: profiler.md pattern analysis section structure at lines 92-124]

### Anti-Patterns to Avoid

- **Creating a new perspective agent:** Violates the no-new-agents constraint. HR and C-Level already have the domain expertise; they just need perspective frame injection. [CITED: CLAUDE.md]
- **Applying perspective shifting to every episode:** Only leadership/collaboration types + profiler-detected undervaluation. Indiscriminate application dilutes impact and increases fatigue. [CITED: CONTEXT.md]
- **Using perspectives the user cannot reconstruct:** CEO perspective for an intern episode, customer perspective for a pure backend engineer role. The user must be able to plausibly imagine the third-person viewpoint. [CITED: CLAUDE.md]
- **Abstract perspective questions:** "타인이 어떻게 볼까?" is too vague. Must include concrete scene: "스프린트 회고에서 팀장이 이 성과를 발표할 때..." [CITED: CONTEXT.md]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Finding routing | New message type or hook logic | Existing findings-inbox.jsonl + MEDIUM urgency | Pipeline already handles MEDIUM findings; perspective_shift is just a new finding type |
| Trigger mechanism | New hook trigger or score event | Profiler's natural analysis cycle | Profiler already runs periodically; add detection during existing analysis pass |
| Session limiting | Complex state machine | Simple meta.json counter | `perspective_shifts_this_session` counter with max 2, same pattern as `gap_probes_this_session` |
| Agent selection | New routing logic | CLAUDE.md mapping table hardcoded in finding | Profiler designates target_agent in finding; SKILL.md just reads it |

**Key insight:** Every mechanism needed for perspective shifting already exists from Phase 3/4. The only new work is prompt content (detection criteria, question templates, routing rules). Zero new infrastructure.

## Common Pitfalls

### Pitfall 1: Profiler Prompt Length Bloat
**What goes wrong:** Adding another analysis section to profiler.md increases prompt length, potentially degrading existing analysis quality (lost-in-the-middle effect).
**Why it happens:** profiler.md already has: base analysis (5 sections), autonomous orchestration mode (3 subsections), pattern analysis framework. Adding perspective detection is another section.
**How to avoid:** Keep the perspective detection section concise (under 40 lines). Use bullet-point criteria, not prose. Place it AFTER pattern analysis but BEFORE findings-inbox writing instructions (so it shares the existing output mechanism).
**Warning signs:** Profiler starts missing patterns it used to catch, or generates lower-quality profiles.

### Pitfall 2: Over-Triggering Perspective Shifts
**What goes wrong:** Too many episodes get flagged for perspective shifting, overwhelming the user with role-play questions that feel forced.
**Why it happens:** Undervaluation detection criteria too broad (e.g., any episode without quantified result gets flagged).
**How to avoid:** Require BOTH conditions: (a) episode type is leadership/collaboration AND (b) at least one undervaluation signal (minimization keywords, vague result, or profiler's 과소평가형 classification). Session limit of 2 provides hard cap.
**Warning signs:** User gets perspective questions for episodes where they clearly stated their full contribution.

### Pitfall 3: Abstract Scene Hints
**What goes wrong:** scene_hint is generic ("팀 미팅에서") rather than episode-specific ("Kafka 마이그레이션 완료 후 팀 회고에서").
**Why it happens:** Profiler generates scene_hint without referencing specific episode STAR data.
**How to avoid:** Prompt profiler to extract scene context from episode's situation + action fields. scene_hint must reference at least one concrete detail (technology, project name, team name, or specific event).
**Warning signs:** Multiple perspective questions use the same generic scene (e.g., all say "회의에서").

### Pitfall 4: Duplicate Perspective Shifts for Same Episode
**What goes wrong:** The same episode gets perspective-shifted multiple times across profiler cycles.
**Why it happens:** Profiler re-analyzes all episodes each cycle and re-flags the same ones.
**How to avoid:** Track perspective-shifted episode refs in meta.json (`perspective_shifted_episodes: ["episode_title_1", ...]`). Profiler checks this list before generating new findings.
**Warning signs:** User gets the same "주니어 입장에서 보면..." question for an episode they already answered.

### Pitfall 5: Perspective Mismatch with Episode Scale
**What goes wrong:** Junior perspective applied to a CTO-level decision, or customer perspective for internal tooling.
**Why it happens:** Mapping table applied mechanically without considering episode context.
**How to avoid:** Profiler's detection criteria include plausibility check: "유저가 재구성할 수 있는 관점인가?" If the episode involves no external interaction, customer perspective is inappropriate. If the user was the most senior person, junior perspective works but boss perspective does not.
**Warning signs:** User responds with confusion ("그 프로젝트에 주니어가 없었는데...").

## Code Examples

### Perspective Shift Finding Format (profiler.md output)

```json
{
  "id": "ps-{timestamp}",
  "type": "perspective_shift",
  "urgency": "MEDIUM",
  "source": "profiler",
  "message": "관점 전환 추천: '{에피소드 제목}' — {target_perspective} 시점에서 추가 발굴 가능. 과소평가 신호: {signal}.",
  "context": {
    "target_perspective": "주니어 팀원",
    "target_agent": "인사담당자",
    "episode_ref": "{에피소드 제목}",
    "company": "{회사명}",
    "project": "{프로젝트명}",
    "episode_type": "리더십",
    "scene_hint": "{Kafka 마이그레이션 완료 후 팀 회고 자리에서}",
    "undervaluation_signals": ["result 필드에 구체적 수치 없음", "역할 축소 키워드 '지원' 사용"]
  },
  "created_at": "{ISO timestamp}"
}
```

[ASSUMED] -- JSON schema is Claude's discretion per CONTEXT.md; this is a recommended structure based on established patterns from timeline_gap_found and pattern_detected findings.

### Profiler Perspective Detection Section (profiler.md addition)

```markdown
### 4. 관점 전환 탐지

에피소드 분석 시, 다음 조건을 만족하는 에피소드를 관점 전환 대상으로 탐지한다:

#### 탐지 조건 (AND)

1. **에피소드 타입**: 리더십 또는 협업
2. **과소평가 신호** (1개 이상):
   - result 필드가 비어있거나 구체적 수치/규모가 없음
   - action 필드에 역할 축소 키워드 포함 (도움, 참여, 지원, 보조, 서포트)
   - 회사 규모/MAU 대비 result가 지나치게 겸손함
   - 유저의 자기 평가 경향이 과소평가형 (커뮤니케이션 스타일 분석 결과)

#### 관점 매핑

| 에피소드 타입 | 관점 | 담당 에이전트 |
|-------------|------|-------------|
| 리더십 | 주니어 팀원 | 인사담당자 |
| 협업 | PM 또는 상대 팀 담당자 | 인사담당자 |
| 문제해결 | 상사 또는 CTO | C-Level |
| 성과 | 고객 또는 비즈니스 오너 | C-Level |

#### 금지

- 세션당 2개 초과 관점 전환 finding 생성 금지 (meta.json의 perspective_shifts_count 확인)
- 유저가 재구성할 수 없는 관점 사용 금지 (인턴 에피소드에 CEO 관점 등)
- 이미 관점 전환한 에피소드 재탐지 금지 (meta.json의 perspective_shifted_episodes 확인)
```

[ASSUMED] -- Prompt wording is Claude's discretion; structure follows established profiler.md pattern analysis section format.

### HR Perspective Shifting Mode (hr.md addition)

```markdown
## 관점 전환 모드

오케스트레이터가 관점 전환 컨텍스트를 전달하면 관점 전환 모드로 동작한다.

### 입력

오케스트레이터가 다음을 전달한다:
- 대상 에피소드 (title, situation, task, action, result)
- 관점 (주니어 팀원 또는 PM/상대 팀 담당자)
- 장면 힌트 (scene_hint)
- 유저 프로파일
- 해당 회사 리서처 조사 결과

### 질문 생성 규칙

1. **장면 묘사 필수** — scene_hint를 활용하여 구체적 장면을 설정한다. "{scene_hint}에서 {관점 인물}이 너에 대해 뭐라고 할 것 같아?"
2. **선택지에 업그레이드된 역할 포함** — 유저가 직접 말한 것보다 더 큰 역할을 선택지에 반드시 포함
3. **호기심 + 인정 톤** — "주니어 입장에서 보면, 네가 한 게 더 대단해 보일 수 있거든"

### 질문 패턴

**리더십 에피소드 (주니어 관점):**
```
[인사담당자] {scene_hint}에서, 팀에 새로 온 주니어가 너를 보고 뭐라고 했을 것 같아?
  1) "저 사람이 이 프로젝트 방향 잡은 사람이구나"
  2) "기술적으로 막힐 때마다 저 사람한테 가면 됐다"
  3) 딱히 그런 인상은 없었을 듯
```

**협업 에피소드 (PM 관점):**
```
[인사담당자] {project}에서 같이 일한 PM이 {scene_hint} 때 너에 대해 뭐라고 했을 것 같아?
  1) "이 사람 덕분에 일정이 당겨졌다"
  2) "기획 의도를 제일 잘 이해하고 구현해줬다"
  3) 특별히 언급할 정도는 아니었을 듯
```

### 핵심 규칙

- 마지막 선택지는 항상 "겸손 옵션" (특별히 없었을 듯) — 유저의 선택권 보장
- 앞선 선택지들이 유저 본인 인식보다 큰 역할을 표현해야 한다
- 장면이 추상적이면 안 된다 — 프로젝트명, 기술명, 팀명 등 구체적 디테일 포함
```

[ASSUMED] -- Prompt content is Claude's discretion; structure follows established hr.md gap probing mode format.

### SKILL.md Perspective Shift Handler (item 8)

```markdown
8. **`[resume-panel:MEDIUM]` (perspective_shift)** -> 관점 전환 질문
   - MEDIUM 메시지 내용에 "관점 전환"이 포함되어 있으면 perspective_shift finding으로 판단
   - meta.json의 `perspective_shifts_this_session` 카운터 확인 — 2 이상이면 무시
   - context에서 target_agent 확인 — 해당 에이전트를 관점 전환 모드로 호출:
     ```
     Agent(
       prompt: "관점 전환 모드. 대상 에피소드: {episode_ref}({company} {project}). 관점: {target_perspective}. 장면 힌트: {scene_hint}. 유저 프로파일: {프로파일 요약}. 리서처 조사: {관련 회사 조사 결과}."
     )
     ```
   - 에이전트 리턴을 AskUserQuestion으로 변환 (기존 변환 규칙 동일 적용)
   - 유저 응답 처리:
     - **겸손 옵션 선택** ("특별히 없었을 듯"): meta.json에 perspective_shifted_episodes 배열에 추가, 인터뷰 복귀
     - **업그레이드 역할 선택**: 해당 에피소드의 result 보강을 위한 후속 질문 1개 가능 (일반 모드로 전환), meta.json에 perspective_shifted_episodes 추가
   - meta.json `perspective_shifts_this_session` 카운터 증가
```

[ASSUMED] -- Handler structure is Claude's discretion; follows established pattern from items 5-7 in SKILL.md.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Generic "tell me more" follow-ups | Structured perspective-framed questions | Phase 5 | Questions bypass user's self-deprecation filter by asking from third-person viewpoint |
| All episodes treated equally | Type-based + signal-based selective perspective shifting | Phase 5 | Only leadership/collaboration episodes with undervaluation signals get perspective treatment |
| Abstract role-play ("imagine you're a CEO") | Concrete scene-based perspective ("스프린트 회고에서 팀장이...") | Phase 5 | Specific scenarios trigger concrete memories rather than abstract imagination |

**Research support for approach:**
- LLM role-play research confirms that assigning explicit perspectives produces genuinely different question angles, not just rephrased versions [CITED: openreview.net/forum?id=ybaK4asBT2]
- 2026 museum study shows LLM-powered personified characters with distinctive perspectives generate more varied and reflective questions [CITED: link.springer.com/chapter/10.1007/978-981-95-4861-3_7]
- Korean cultural context: users systematically understate contributions; third-person perspective bypasses self-deprecation filter [CITED: CLAUDE.md / PROJECT.md]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | perspective_shift finding JSON schema (target_perspective, target_agent, episode_ref, scene_hint, undervaluation_signals fields) | Code Examples | Low -- schema is explicitly under Claude's discretion per CONTEXT.md |
| A2 | Profiler detection criteria (AND logic: type + undervaluation signal) | Code Examples, Common Pitfalls | Medium -- if detection is too strict, few episodes get perspective shifted; if too loose, over-triggering |
| A3 | meta.json tracking fields (perspective_shifts_this_session, perspective_shifted_episodes) | Code Examples | Low -- follows established pattern from gap_probes_this_session |
| A4 | Scene hint generation quality depends on STAR data completeness | Common Pitfalls | Medium -- episodes with sparse STAR data may produce generic scene hints |

**All assumed items are within Claude's discretion areas per CONTEXT.md.** No user confirmation needed for locked decisions.

## Open Questions

1. **How should profiler handle episodes with mixed types?**
   - What we know: Episodes have a single type field ("성과|문제해결|리더십|협업|학습|기타")
   - What's unclear: What if an episode is both "리더십" and "성과"? The type field is single-valued.
   - Recommendation: Use the recorded type as-is. If type is "리더십" or "협업", apply perspective shifting. If "성과" or "문제해결", apply only if profiler also detects undervaluation signals.

2. **Session counter reset timing**
   - What we know: `perspective_shifts_this_session` caps at 2 per session
   - What's unclear: When does a "session" start/end? Does the counter persist in meta.json across Claude Code restarts?
   - Recommendation: Initialize counter to 0 when meta.json is created (Round 0). Do not reset during session -- counter persists until next full session start. This follows the same pattern as `gap_probes_this_session`.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Node.js assert module (built-in) |
| Config file | none -- direct script execution |
| Quick run command | `node plugins/resume/scripts/test-episode-watcher.mjs` |
| Full suite command | `node plugins/resume/scripts/test-episode-watcher.mjs` |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PERSP-01 | Perspective questions generated from appropriate agents | manual-only | N/A -- prompt behavior, not code | N/A |
| PERSP-02 | Questions include concrete scene descriptions | manual-only | N/A -- prompt quality, not code | N/A |
| PERSP-03 | Triggered by profiler pattern data strategically | manual-only | N/A -- profiler analysis behavior, not code | N/A |

### Sampling Rate
- **Per task commit:** Manual review of prompt changes for structural correctness
- **Per wave merge:** Read all modified files to verify section integration
- **Phase gate:** End-to-end trace through finding format -> SKILL.md handler -> agent mode

### Wave 0 Gaps

None -- this phase is pure prompt engineering (markdown file modifications). No test infrastructure needed. The existing test file (`test-episode-watcher.mjs`) only covers the JavaScript hook, which is NOT modified in this phase.

## Security Domain

Not applicable. This phase modifies only markdown prompt files within the Claude Code plugin system. No user input is processed by custom code, no external APIs are called, no data is stored in new locations. All changes are prompt content additions to existing agent files.

## Sources

### Primary (HIGH confidence)
- Codebase inspection: profiler.md (185 lines), hr.md (130 lines), c-level.md (167 lines), SKILL.md (608 lines), episode-watcher.mjs (421 lines) -- verified all integration points and established patterns
- CLAUDE.md perspective shifting specification -- verified mapping table, trigger conditions, anti-patterns
- Phase 4 RESEARCH.md -- verified findings pipeline pattern reuse

### Secondary (MEDIUM confidence)
- [LLM Discussion: Enhancing Creativity via Role-Play (OpenReview)](https://openreview.net/forum?id=ybaK4asBT2) -- diverse role assignment produces genuinely different question angles
- [Question-Based Viewing with LLM-Powered Personified Characters (Springer, 2026)](https://link.springer.com/chapter/10.1007/978-981-95-4861-3_7) -- role-playing dialogue systems facilitate perspective-shifting and reflective questions
- [Role play with large language models (Nature, 2023)](https://www.nature.com/articles/s41586-023-06647-8) -- foundational work on LLM role-play capabilities
- [Role-Play Paradox: Reasoning Performance Gains (arxiv, 2024)](https://arxiv.org/html/2409.13979v2) -- role-play enhances contextually relevant responses but needs careful framing

### Tertiary (LOW confidence)
- Korean cultural understatement patterns -- general cultural knowledge, not verified with academic research specific to resume interviews. CLAUDE.md's PROJECT.md reference is the authoritative source for this project.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- pure prompt engineering, no new libraries or tools; identical pattern to Phase 3/4
- Architecture: HIGH -- verified all 4 file touch points and their integration through codebase inspection
- Pitfalls: HIGH -- derived from actual patterns observed in Phase 3/4 implementation + profiler prompt length concern from STATE.md blockers

**Research date:** 2026-04-08
**Valid until:** 2026-05-08 (30 days -- stable domain, prompt engineering only)
