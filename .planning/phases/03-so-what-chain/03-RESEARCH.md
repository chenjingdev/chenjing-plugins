# Phase 3: So What Chain - Research

**Researched:** 2026-04-07
**Domain:** Prompt engineering + hook orchestration for impact deepening in Claude Code plugin
**Confidence:** HIGH

## Summary

Phase 3 adds an automated "So What Chain" that triggers when an episode is saved with a weak `result` field. The implementation touches three existing files: `episode-watcher.mjs` (trigger detection), `c-level.md` (chain question generation), and `SKILL.md` (orchestration rules + flow interruption handling). No new files, no new agents, no external dependencies. The entire feature is prompt engineering + deterministic regex in JavaScript.

The core mechanism is: episode-watcher detects a save to `resume-source.json`, checks the newly saved episode's `result` field for quantified impact (numbers + units via regex), and if absent, sends a `[resume-panel:SO-WHAT]` additionalContext message. The orchestrator (SKILL.md) receives this, pauses the normal interview flow, invokes C-Level agent in "So What mode" with the target episode context, and walks the user through up to 3 levels of deepening. The user can exit at any level via "I'm done" option. The deepened result gets written back to the episode's `result` field.

**Primary recommendation:** Implement in 3 touches -- (1) `hasQuantifiedImpact()` function + SO-WHAT trigger in episode-watcher.mjs, (2) So What chain mode section in c-level.md, (3) `[resume-panel:SO-WHAT]` handling rules + chain state management in SKILL.md and meta.json.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- episode-watcher.mjs에서 에피소드 저장 시 result 필드를 즉시 검사하여 임팩트 부족 감지
- 임팩트 부족 판단: 정규식으로 수치+단위 패턴 (%, 원, 명, 건, 배, 시간 등) 검사 -- 없으면 부족
- 수치 패턴이 이미 있는 에피소드는 자동 스킵 (결정론적 체크, LLM 불필요)
- additionalContext 메시지로 `[resume-panel:SO-WHAT] 에피소드 "{title}" 임팩트 부족` 전송 -- 기존 hook->오케스트레이터 파이프라인 활용
- C-Level 에이전트가 심화 질문 담당 (비즈니스 임팩트 전문, CLAUDE.md에서 지정)
- 3단계 구조: Level 1 "직접적으로 뭐가 바뀌었어?" -> Level 2 "팀/조직에 어떤 영향?" -> Level 3 "비즈니스 지표로는?"
- 매 레벨마다 "거기까지였음" 선택지를 포함하여 유저가 언제든 체인 탈출 가능
- 에피소드 저장 직후 즉시 트리거 -- 현재 질문-답변 사이클 완료 후 끼워넣기 (HIGH 우선순위와 동일 패턴)
- 심화된 결과를 해당 에피소드의 result 필드에 직접 업데이트 -- 별도 필드/스키마 변경 없음
- .resume-panel/meta.json에 `so_what_active` 플래그 + 대상 에피소드 정보 저장 -- 체인 진행 중 추가 트리거 방지
- 중간 탈출 시 (거기까지였음) 현재 레벨까지의 답변을 result에 반영 -- 부분 결과도 가치 있음

### Claude's Discretion
- C-Level 에이전트 프롬프트에 So What 체인 모드 섹션 추가 방식
- 각 레벨별 구체적 선택지 텍스트 구성
- so_what_active 플래그의 JSON 구조 세부사항

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| IMPACT-01 | 에피소드 저장 시 임팩트 심화 후속 질문이 자동 트리거됨 | episode-watcher.mjs에 `hasQuantifiedImpact()` 함수 추가 + `[resume-panel:SO-WHAT]` 메시지 발송 로직. SKILL.md에 SO-WHAT 메시지 처리 규칙 추가. |
| IMPACT-02 | 최대 3단계 깊이로 파고들음 (액션 -> 직접 결과 -> 비즈니스 임팩트) | c-level.md에 So What 체인 모드 섹션. SKILL.md에서 레벨 추적 + C-Level 반복 호출 + 결과 누적 로직. |
| IMPACT-03 | 이미 충분히 구체적인 에피소드는 So What 체인을 건너뜀 | `hasQuantifiedImpact()` 정규식이 수치+단위 패턴 탐지하여 true 리턴 시 SO-WHAT 메시지 미발송. |
</phase_requirements>

## Standard Stack

### Core Approach: Prompt Engineering + Deterministic Detection

No external libraries needed. The "stack" is prompt modifications to existing markdown files + JavaScript regex logic in the existing hook.

| Component | Technique | Purpose | Confidence |
|-----------|-----------|---------|------------|
| Impact Detection | Regex: 수치+단위 패턴 in `result` field | Deterministic skip of already-quantified episodes | HIGH |
| So What Trigger | `[resume-panel:SO-WHAT]` additionalContext message | Reuses existing hook->orchestrator pipeline | HIGH |
| Chain Execution | C-Level agent with So What mode prompt section | 3-level structured deepening questions | HIGH |
| Chain State | `so_what_active` flag in meta.json | Prevents re-trigger during active chain | HIGH |
| Result Update | Direct write to episode `result` field in resume-source.json | No schema changes needed | HIGH |

[VERIFIED: codebase inspection of episode-watcher.mjs, SKILL.md, c-level.md]

### No Installation Required

```
# No install commands. The "stack" is prompt engineering + regex.
```

## Architecture Patterns

### Modification Map

```
plugins/resume/scripts/episode-watcher.mjs    # Add hasQuantifiedImpact() + SO-WHAT trigger
plugins/resume/.claude/agents/c-level.md       # Add So What chain mode section
plugins/resume/skills/resume-panel/SKILL.md    # Add [resume-panel:SO-WHAT] handling rules
.resume-panel/meta.json                        # Add so_what_active state field
```

### Pattern 1: Hook Trigger Detection (episode-watcher.mjs)

**What:** After the existing weighted scoring block (Phase 2), add a new detection block that checks the `result` field of newly saved episodes for quantified impact.

**When to use:** Every `resume-source.json` save event (already handled by `isResumeSourceChange` flag).

**Key insight:** The existing code already has `countStarGaps()` which checks STAR field *existence*. The new `hasQuantifiedImpact()` checks result field *quality* -- these are orthogonal checks. [VERIFIED: codebase inspection of episode-watcher.mjs lines 91-102]

**Implementation approach:**

```javascript
// Source: CONTEXT.md locked decision -- regex for 수치+단위
function hasQuantifiedImpact(resultText) {
  if (!resultText || resultText.trim() === "") return false;
  // Korean number+unit patterns: 30%, 100만원, 50명, 200건, 3배, 2시간, 10억
  // Also catches digit-only metrics: "응답 시간 200ms", "DAU 5만"
  const IMPACT_PATTERN = /\d+(\.\d+)?\s*(명|건|%|원|만|억|배|시간|분|초|ms|개월|일|주|달|회|번|개|위|등|위|배|톤|km|kg|L|대|편|권|통|점|곳|팀)/;
  return IMPACT_PATTERN.test(resultText);
}
```

**Trigger message format (locked decision):**

```
[resume-panel:SO-WHAT] 에피소드 "{title}" 임팩트 부족
```

[VERIFIED: CONTEXT.md decisions section]

### Pattern 2: So What Chain Mode in C-Level Agent (c-level.md)

**What:** A new section in c-level.md that activates when the orchestrator passes "So What 체인 모드" context. The agent generates level-appropriate deepening questions with concrete scene cues (per MEMORY.md: recognition over recall).

**Key design decision:** The C-Level agent does NOT track chain state. The orchestrator tells it which level (1/2/3) and what the user said so far. The agent just generates one question per invocation.

**Level structure (locked decision):**

| Level | Focus | Question Frame | Example |
|-------|-------|----------------|---------|
| 1 | 직접 결과 | "이 작업 결과 뭐가 바뀌었어?" | "{action} 했다고 했는데, 이거 하고 나서 바로 뭐가 달라졌어?" |
| 2 | 팀/조직 영향 | "팀이나 조직 차원에서는?" | "그 결과가 팀 전체로 보면 어떤 차이가 있었어?" |
| 3 | 비즈니스 지표 | "비즈니스 수치로는?" | "결국 매출/비용/전환율 같은 비즈니스 숫자로 찍히는 거 있어?" |

**Critical:** Each level's question must include concrete scene cues from the episode context, not abstract prompts. Per the user feedback memory: "recognition over recall" -- provide specific situational details from the episode to help the user remember. [VERIFIED: MEMORY.md feedback_interview_skill_recognition.md]

**Exit option (locked decision):** Every level includes "거기까지였음" as a select option. When selected, chain terminates and accumulated answers are written to `result`.

### Pattern 3: Orchestrator Chain Management (SKILL.md)

**What:** New `[resume-panel:SO-WHAT]` message handling rule in SKILL.md's "자율 오케스트레이션 -- Hook 메시지 처리" section. Follows the same pattern as `[resume-panel:HIGH]` but with chain-specific behavior.

**Flow (locked decision):**

```
1. Hook sends [resume-panel:SO-WHAT] 에피소드 "{title}" 임팩트 부족
2. Orchestrator completes current Q&A cycle
3. Orchestrator sets so_what_active in meta.json
4. Orchestrator calls C-Level with So What mode context (level=1, episode data)
5. C-Level returns question -> Orchestrator converts to AskUserQuestion (including "거기까지였음")
6. User answers:
   a. "거기까지였음" -> write accumulated result, clear so_what_active, resume interview
   b. Substantive answer -> accumulate, if level < 3 goto step 4 with level+1
   c. Level 3 answer -> write final result, clear so_what_active, resume interview
7. Update episode result field in resume-source.json
```

**Interview flow protection (critical):** The SO-WHAT chain interrupts the normal flow but must complete before resuming. Unlike HIGH findings (which are one-shot), SO-WHAT is multi-turn. The `so_what_active` flag prevents the hook from firing additional SO-WHAT triggers during the chain. [VERIFIED: CONTEXT.md locked decision on so_what_active flag]

### Pattern 4: State Management (meta.json)

**Recommended `so_what_active` structure (Claude's discretion):**

```json
{
  "profiler_score": 0,
  "so_what_active": {
    "active": true,
    "episode_path": "companies[0].projects[0].episodes[2]",
    "episode_title": "검색 성능 최적화",
    "current_level": 1,
    "accumulated_result": ""
  }
}
```

When chain is inactive: `"so_what_active": null`

**Rationale for this structure:**
- `episode_path` enables deterministic episode lookup for result update without searching
- `current_level` lets the orchestrator tell C-Level which level to generate
- `accumulated_result` stores partial results for mid-chain exit writes
- Using `null` vs object makes active/inactive check trivial

[ASSUMED] -- the exact JSON structure is Claude's discretion per CONTEXT.md

### Anti-Patterns to Avoid

- **Do NOT use LLM to judge impact sufficiency.** The regex check is deterministic and cheap. LLM judgment would add latency and inconsistency for a binary decision. [VERIFIED: CONTEXT.md locked decision]
- **Do NOT create a new agent for So What chain.** C-Level already specializes in business impact. Adding a mode section is sufficient. [VERIFIED: CLAUDE.md constraint "기존 구조 유지"]
- **Do NOT change resume-source.json schema.** The result field is updated in-place. No new fields like `impact_chain` or `so_what_depth`. [VERIFIED: CONTEXT.md locked decision]
- **Do NOT trigger So What on every episode save.** Only on episodes where `result` lacks quantified impact. Episodes with numbers+units skip automatically. [VERIFIED: CONTEXT.md locked decision]
- **Do NOT use generic/cheerleading prompts.** Each level must reference the specific episode's action/situation to trigger recognition memory. [VERIFIED: MEMORY.md feedback]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Impact sufficiency detection | LLM-based quality assessment | Regex for number+unit patterns | Deterministic, fast, consistent. LLM would add latency for a simple binary check |
| Hook-to-orchestrator communication | New messaging system | Existing `additionalContext` pipeline | Pattern already established in Phase 2. Reuse it |
| User interaction during chain | Direct text prompts | AskUserQuestion select box (Phase 1) | Consistent with Phase 1's established UX pattern |
| Chain state tracking | In-memory state or conversation history parsing | `meta.json` so_what_active flag | Persistent across hook invocations, survives session interruption |

## Common Pitfalls

### Pitfall 1: Re-trigger Loop During Active Chain

**What goes wrong:** User answers a So What question, orchestrator saves the (still incomplete) result to resume-source.json, hook fires again and detects "impact insufficient", sends another SO-WHAT message, creating an infinite loop.

**Why it happens:** episode-watcher.mjs fires on every resume-source.json write, and mid-chain result writes still lack full quantification.

**How to avoid:** Check `so_what_active` flag in meta.json before sending SO-WHAT message. If active, skip. The hook must read meta.json and check this flag before the impact check.

**Warning signs:** User sees "임팩트 부족" message while already answering a So What question.

### Pitfall 2: Hook Ordering -- SO-WHAT vs Profiler Trigger

**What goes wrong:** An episode save triggers both the profiler score increment AND the SO-WHAT check. If the profiler triggers simultaneously, the orchestrator receives two messages and may try to handle both.

**Why it happens:** Both checks are in the same `isResumeSourceChange` block, and both fire on the same event.

**How to avoid:** SO-WHAT message should be separate from and independent of the profiler trigger message. The orchestrator already handles multiple messages in a single `additionalContext` (they're joined with `\n\n`). SKILL.md should specify that SO-WHAT takes priority over profiler when both arrive simultaneously (complete the So What chain first, then profiler runs in background).

**Warning signs:** User gets profiler findings interspersed with So What chain questions.

### Pitfall 3: Result Field Overwrite vs Append

**What goes wrong:** The So What chain writes a new result that overwrites the original (possibly useful) result text, losing context.

**Why it happens:** Direct `result` field update without considering existing content.

**How to avoid:** The accumulated result should INCLUDE the original result text. Chain answers should be appended/integrated, not replace. The orchestrator should construct the final result as: `{original result} + {level 1 answer} + {level 2 answer} + {level 3 answer}` in a coherent way. C-Level agent can be instructed to synthesize the final result incorporating all levels.

**Warning signs:** After So What chain, the original context of the result is lost.

### Pitfall 4: Identifying the Specific Episode That Was Just Saved

**What goes wrong:** The hook knows resume-source.json changed but doesn't know WHICH episode was added/modified. It can't tell the orchestrator which specific episode needs deepening.

**Why it happens:** episode-watcher.mjs currently tracks counts and project names but not individual episode identity.

**How to avoid:** Compare the current source against the snapshot to identify new/changed episodes. The episode count delta tells us how many new episodes exist. For new episodes (count went up), iterate to find the ones beyond the previous count. For modified episodes (count same but content changed), compare result fields. The simplest approach: when `episodeDelta > 0`, check the LAST episode in the last project (episodes are appended sequentially during an interview). This covers the common case. For edge cases (bulk edit), check all episodes beyond `snapshot.episode_count`.

**Warning signs:** SO-WHAT message says "에피소드 undefined 임팩트 부족".

### Pitfall 5: AskUserQuestion Option Count Constraint

**What goes wrong:** C-Level generates 3 substantive options + "거기까지였음" = 4 options. AskUserQuestion adds automatic "Other" = 5 total. But the constraint is max 4 options per question.

**Why it happens:** The "거기까지였음" option counts toward the 4-option limit, and AskUserQuestion adds "Other" on top.

**How to avoid:** C-Level generates 2 substantive options + "거기까지였음" = 3 options. "Other" auto-added makes 4 total. This stays within the AskUserQuestion constraint (2-4 options per CLAUDE.md). Alternatively, "거기까지였음" can be one of the substantive options, keeping total at 3 + Other = 4.

**Warning signs:** AskUserQuestion call fails or truncates options.

## Code Examples

### Example 1: hasQuantifiedImpact() Function

```javascript
// Source: CONTEXT.md locked decision + CLAUDE.md stack recommendation
// Location: episode-watcher.mjs, new helper function

function hasQuantifiedImpact(resultText) {
  if (!resultText || resultText.trim() === "") return false;
  // Matches: 30%, 100만원, 50명, 200건, 3배, 2시간, 200ms, DAU 5만
  const IMPACT_PATTERN = /\d+(\.\d+)?\s*(명|건|%|원|만|억|배|시간|분|초|ms|개월|일|주|달|회|번|개|위|등|배|톤|km|kg|L|대|편|권|통|점|곳|팀)/;
  return IMPACT_PATTERN.test(resultText);
}
```

### Example 2: SO-WHAT Trigger in episode-watcher.mjs

```javascript
// Source: CONTEXT.md locked decision
// Location: episode-watcher.mjs, inside isResumeSourceChange block, AFTER scoring logic

// So What chain trigger -- check for impact-shallow episodes
const metaForSoWhat = readJSON(metaPath) || {};
if (!metaForSoWhat.so_what_active?.active) {
  // Find newly added episodes and check impact
  const prevCount = snapshot?.episode_count || 0;
  let checked = 0;
  for (const company of source.companies || []) {
    for (const project of company.projects || []) {
      for (const ep of project.episodes || []) {
        checked++;
        if (checked <= prevCount) continue; // skip already-seen
        if (!hasQuantifiedImpact(ep.result)) {
          messages.push(
            `[resume-panel:SO-WHAT] 에피소드 "${ep.title || "(제목 없음)"}" 임팩트 부족`
          );
          break; // one trigger per hook call
        }
      }
    }
  }
}
```

**Note:** The data structure in episode-watcher.mjs uses `source.projects[].episodes[]` (flat projects), but SKILL.md's schema uses `source.companies[].projects[].episodes[]` (nested under companies). The hook code must match whichever structure is actually in resume-source.json. [VERIFIED: episode-watcher.mjs uses `source.projects`, but SKILL.md schema shows `companies[].projects[].episodes[]` -- this needs clarification during implementation. The hook currently iterates `source.projects` but the SKILL.md schema nests projects under companies.]

### Example 3: C-Level So What Mode Section

```markdown
<!-- Source: Claude's discretion for prompt structure -->
<!-- Location: c-level.md, new section after existing content -->

## So What 체인 모드

오케스트레이터가 So What 체인 모드로 호출하면, 에피소드의 임팩트를 단계별로 심화하는 질문을 생성한다.

### 입력

오케스트레이터가 다음을 전달한다:
- So What 체인 레벨 (1, 2, 또는 3)
- 대상 에피소드 (title, situation, task, action, result)
- 이전 레벨 답변 (레벨 2/3일 때)
- 리서처 조사 결과 (해당 회사)

### 레벨별 질문 생성

**Level 1: 직접 결과**
에피소드의 action을 참조하여 "그래서 뭐가 바뀌었어?" 수준의 질문을 생성한다.
- 에피소드의 구체적 action 내용을 질문에 반드시 포함 (추상적 질문 금지)
- 선택지는 해당 도메인에서 나올 수 있는 구체적 결과 유형으로 구성

**Level 2: 팀/조직 영향**
Level 1 답변을 참조하여 팀/조직 스케일로 확장하는 질문을 생성한다.
- Level 1에서 유저가 말한 결과를 질문에 반드시 포함
- 팀 규모, 프로세스 변화, 다른 팀 영향 등으로 선택지 구성

**Level 3: 비즈니스 지표**
Level 2 답변을 참조하여 비즈니스 임팩트 수치를 묻는 질문을 생성한다.
- 가능한 비즈니스 지표 유형을 선택지로 제시 (매출, 비용, 전환율, 시간 절감 등)
- "측정은 안 했지만 체감은 있었다" 수준의 선택지도 포함

### 산출 형식

모든 레벨에서 동일:
```
[C-Level] {에피소드 컨텍스트 참조한 질문}
  1) {구체적 결과/영향 선택지}
  2) {구체적 결과/영향 선택지}
  3) 거기까지였음
```

### 금지사항 (기존 + 추가)

- "대단하다", "오 그래?" 등 평가/감탄 절대 금지
- "더 자세히 말해줘" 같은 열린 질문 금지 -- 항상 구체적 방향 제시
- 에피소드 action에 없는 내용을 추측하여 질문하지 않음
```

### Example 4: SKILL.md SO-WHAT Message Handling

```markdown
<!-- Source: CONTEXT.md locked decision + existing [resume-panel:HIGH] pattern -->
<!-- Location: SKILL.md, "메시지 처리 규칙" section, new item -->

5. **`[resume-panel:SO-WHAT]`** -> 현재 질문-답변 사이클 완료 후 So What 체인 시작
   - meta.json에 `so_what_active` 설정:
     ```json
     {
       "so_what_active": {
         "active": true,
         "episode_title": "{메시지에서 추출}",
         "current_level": 1,
         "accumulated_result": "{기존 result 텍스트}"
       }
     }
     ```
   - C-Level을 So What 체인 모드로 호출 (level=1, 대상 에피소드 데이터 전달)
   - C-Level 리턴을 AskUserQuestion으로 변환 (기존 변환 규칙 동일)
   - 유저 응답 처리:
     - "거기까지였음" 선택: accumulated_result를 에피소드 result에 저장, so_what_active를 null로, 인터뷰 복귀
     - 실질적 답변: accumulated_result에 추가, current_level 증가
       - level < 3: C-Level 재호출 (다음 레벨)
       - level = 3: 최종 결과를 에피소드 result에 저장, so_what_active를 null로, 인터뷰 복귀
   - 결과 저장 시 resume-source.json의 해당 에피소드 result 필드를 직접 업데이트
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| "더 자세히 말해줘" 열린 질문 | Structured 3-level chain with exit conditions | 2025 CoT research | Prevents shallow/repetitive follow-ups, guides toward resume-worthy content |
| LLM-based impact assessment | Regex number+unit pattern matching | Design decision | Deterministic, zero-latency detection. LLM saved for question generation only |
| Separate impact_chain field | In-place result field update | Design decision | No schema migration, simpler data model |

## Assumptions Log

> List all claims tagged `[ASSUMED]` in this research.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `so_what_active` JSON structure with active/episode_title/current_level/accumulated_result fields | Architecture Patterns, Pattern 4 | LOW -- structure is Claude's discretion per CONTEXT.md; if planner chooses different structure, same logic applies |

**If this table is nearly empty:** Almost all claims in this research were verified against codebase inspection or locked CONTEXT.md decisions.

## Data Structure Discrepancy

**Critical finding:** episode-watcher.mjs iterates `source.projects[].episodes[]` (flat project list), but SKILL.md's schema shows `source.companies[].projects[].episodes[]` (projects nested under companies). [VERIFIED: episode-watcher.mjs lines 70-75 use `source.projects`, SKILL.md lines 452-491 show `companies[].projects[].episodes[]`]

**Impact on So What chain:** The hook's episode iteration logic must match the actual data structure. If resume-source.json uses the `companies[].projects[]` structure (as SKILL.md specifies), then episode-watcher.mjs's `countEpisodes()` and the new So What detection must traverse `source.companies[].projects[].episodes[]`, not `source.projects[]`.

**Recommendation:** During implementation, verify the actual resume-source.json structure and align the hook code accordingly. The existing `countEpisodes()` function in episode-watcher.mjs uses `source.projects` -- if this is correct (i.e., the actual data uses flat projects), then So What detection should follow the same pattern. If SKILL.md's `companies[]` nesting is the truth, then the existing `countEpisodes()` may also be wrong.

## Open Questions

1. **Episode identification across hook calls**
   - What we know: The hook receives the full resume-source.json and a snapshot of the previous state. It can compute episode count deltas.
   - What's unclear: When multiple episodes are saved in one write (e.g., orchestrator saves after batch extraction), should So What trigger for all of them or just the first?
   - Recommendation: Trigger for the FIRST impact-insufficient episode only per hook call. Queue additional episodes for next cycle. This prevents overwhelming the user with multiple simultaneous So What chains.

2. **Result synthesis after multi-level chain**
   - What we know: Each level's answer gets accumulated. The final result must be a coherent single text.
   - What's unclear: Should the orchestrator synthesize the result text, or should C-Level agent be asked to produce a final synthesized result at chain end?
   - Recommendation: Orchestrator accumulates raw answers. At chain completion, ask C-Level one more time to synthesize accumulated answers into a single coherent result text (one additional agent call). This produces better quality than concatenation.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Node.js custom test runner (assert + console.log) |
| Config file | None -- tests are standalone scripts |
| Quick run command | `node plugins/resume/scripts/test-episode-watcher.mjs` |
| Full suite command | `node plugins/resume/scripts/test-episode-watcher.mjs` |

[VERIFIED: test-episode-watcher.mjs uses Node assert module, no test framework]

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| IMPACT-01 | Episode save with weak result triggers SO-WHAT message | unit | `node plugins/resume/scripts/test-episode-watcher.mjs` | Wave 0 -- new test needed |
| IMPACT-02 | Chain progresses through 3 levels | manual-only | Prompt behavior in c-level.md -- not testable by hook tests | N/A (prompt test) |
| IMPACT-03 | Episode with quantified impact skips SO-WHAT | unit | `node plugins/resume/scripts/test-episode-watcher.mjs` | Wave 0 -- new test needed |

### Sampling Rate
- **Per task commit:** `node plugins/resume/scripts/test-episode-watcher.mjs`
- **Per wave merge:** Full suite (same command)
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `hasQuantifiedImpact()` unit tests -- test various result strings (with/without numbers+units)
- [ ] SO-WHAT trigger test -- episode save with empty result produces SO-WHAT message
- [ ] SO-WHAT skip test -- episode save with "매출 30% 증가" result produces NO SO-WHAT message
- [ ] SO-WHAT suppression test -- when `so_what_active.active === true` in meta.json, no SO-WHAT message even for weak result
- [ ] SKILL.md and c-level.md changes are prompt-only (manual validation during interview)

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | N/A -- local CLI tool |
| V3 Session Management | No | N/A |
| V4 Access Control | No | N/A |
| V5 Input Validation | Minimal | Regex pattern validates result field content; no user-supplied code execution |
| V6 Cryptography | No | N/A |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Re-trigger loop (hook fires during chain) | Denial of Service | `so_what_active` flag check before sending SO-WHAT message |
| Result field corruption on concurrent writes | Tampering | Single-writer model (orchestrator is sole writer of resume-source.json) |

This phase has minimal security surface -- all operations are local file reads/writes within the user's own project directory, no network calls, no secrets involved.

## Sources

### Primary (HIGH confidence)
- Codebase inspection: `episode-watcher.mjs` (293 lines), `c-level.md` (115 lines), `SKILL.md` (527 lines), `profiler.md` (135 lines)
- `03-CONTEXT.md` -- locked decisions from user discussion
- `CLAUDE.md` -- project constraints and technical stack recommendations
- `MEMORY.md` -- user feedback on interview skill design (recognition over recall)

### Secondary (MEDIUM confidence)
- Phase 1/Phase 2 plan structures -- established patterns for task structure and file modification approach

### Tertiary (LOW confidence)
- None -- all findings verified against codebase

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no external dependencies, all prompt engineering on existing files
- Architecture: HIGH -- follows established hook->orchestrator->agent patterns from Phase 1/2
- Pitfalls: HIGH -- identified through codebase analysis of actual execution flow

**Research date:** 2026-04-07
**Valid until:** 2026-05-07 (stable -- no external dependencies that change)
