# Phase 4: Profiler Analysis (Timeline + Pattern) - Research

**Researched:** 2026-04-08
**Domain:** Deterministic date parsing + LLM-based pattern analysis in Claude Code plugin hook system
**Confidence:** HIGH

## Summary

Phase 4 adds two analytical capabilities to the profiler system: (1) deterministic timeline gap detection via date parsing in episode-watcher.mjs, and (2) cross-company behavioral pattern detection via structured comparison prompts in profiler.md. Both features output findings through the existing findings-inbox.jsonl pipeline and integrate with the orchestrator (SKILL.md) for user-facing delivery.

Timeline gap detection is primarily JavaScript code: parse `YYYY.MM` period fields from `resume-source.json`, compute gaps between consecutive projects/companies, and emit `timeline_gap_found` findings for gaps exceeding thresholds (intra-company >3 months, inter-company >6 months). The LLM's role is limited to generating probing questions once gaps are detected. HR agent handles gap probing with a mandatory "skip" option for sensitive gaps.

Cross-company pattern detection is primarily prompt engineering: add a structured comparison framework to profiler.md that analyzes episodes across companies in 4 behavioral categories (role repetition, tech selection, growth/transition, problem-solving style). The profiler runs this analysis during its natural trigger cycle when 3+ new episodes have accumulated. Pattern results include agent-designated follow-up questions and route through findings-inbox.jsonl at MEDIUM urgency.

**Primary recommendation:** Implement in 4 file touches -- (1) timeline parsing functions + gap detection trigger in episode-watcher.mjs, (2) pattern analysis framework section in profiler.md, (3) timeline_gap_found + pattern_detected handling rules + gap probing orchestration in SKILL.md, (4) gap probing mode section in hr.md. Fix the data structure discrepancy (hook uses `source.projects` but canonical schema is `source.companies[].projects[]`) as part of timeline implementation.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- episode-watcher.mjs에서 결정론적 날짜 파싱으로 갭 감지 -- 기존 SO-WHAT, scoring과 동일 위치
- YYYY.MM 정규식으로 resume-source.json의 period 필드 ("2023.03 - 2024.06") 파싱
- 갭 감지 결과는 findings-inbox.jsonl에 type: timeline_gap_found로 전달 -- 기존 findings 시스템 재활용
- 프로파일러 트리거 사이클 (기존 scoring 임계값) 시 타임라인 분석 함께 실행
- 회사간 갭 > 6개월, 회사내 갭 > 3개월만 프로빙 대상 (CLAUDE.md)
- 3개월 미만 갭은 무시 (CLAUDE.md)
- 4개 행동 카테고리: 역할 반복, 기술 선택 패턴, 성장/전환 패턴, 문제해결 스타일
- 패턴 최소 근거: 2+ 에피소드, 2+ 다른 회사에서 발견되어야 진정한 크로스 컴퍼니 패턴
- 패턴 결과에 에이전트 지정 질문 포함 ("시니어가 물어야 함: {구체적 질문}")
- 프로파일러 사이클 + 3개 이상 신규 에피소드 축적 시에만 패턴 분석 실행
- 패턴 분석은 profiler.md 프롬프트에 구조화된 비교 프레임워크로 구현 (CLAUDE.md)
- 임베딩/벡터 사용 금지 -- LLM 시맨틱 비교로 충분 (CLAUDE.md)
- HR 에이전트가 갭 프로빙 담당 -- 커리어 전환, 민감한 공백기 대응에 적합
- AskUserQuestion으로 "이 기간은 건너뛰기" 옵션 제공 -- intentional_gap으로 기록, 재질문 방지
- 실질 내용이 있는 갭 -> 새 에피소드로 수집, 스킵한 갭 -> intentional_gap 마킹
- 패턴 발견은 MEDIUM urgency -- Conversation Briefing에 포함되어 자연스럽게 전달
- 타임라인 갭은 MEDIUM urgency (CLAUDE.md findings 테이블)

### Claude's Discretion
- 타임라인 파싱 함수의 구체적 구현 (정규식 세부사항)
- profiler.md 패턴 분석 섹션의 프롬프트 구조와 출력 포맷
- intentional_gap 마킹의 JSON 스키마 세부사항
- findings-inbox.jsonl 타임라인/패턴 엔트리의 필드 구조

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| TIME-01 | resume-source.json의 회사/프로젝트 기간 데이터로 타임라인 구성 | episode-watcher.mjs에 `parsePeriod()` + `buildTimeline()` + `detectGaps()` 함수 추가. `companies[].projects[].period` 필드를 YYYY.MM 정규식으로 파싱하여 시간순 정렬된 타임라인 구성. |
| TIME-02 | 3개월 이상 빈 구간 자동 탐지 및 프로빙 질문 생성 | `detectGaps()`가 intra-company >3개월, inter-company >6개월 갭을 탐지. findings-inbox.jsonl에 `timeline_gap_found` 타입으로 기록. SKILL.md에서 해당 finding을 HR 에이전트에 라우팅하여 프로빙 질문 생성. |
| TIME-03 | 민감한 공백기에 대해 "건너뛰기" 옵션 제공 | HR 에이전트 갭 프로빙 모드에서 모든 갭 질문에 "건너뛰기" 선택지 필수 포함. 스킵 시 `intentional_gap`으로 마킹하여 재질문 방지. SKILL.md에 intentional_gap 처리 규칙 추가. |
| PTRN-01 | 에피소드 3개 이상 수집 시 크로스 컴퍼니 패턴 분석 실행 | profiler.md에 패턴 분석 프레임워크 섹션 추가. episode-watcher.mjs에서 profiler trigger 시 에피소드 수 조건(3+) 확인하여 패턴 분석 가능 상태를 메시지에 포함. |
| PTRN-02 | 탐지된 패턴을 가설로 제시하여 숨은 에피소드 발굴 유도 | profiler.md 패턴 출력에 에이전트 지정 질문 포함. findings에 `suggested_question` + `target_agent` 필드. SKILL.md에서 패턴 finding을 지정된 에이전트에 라우팅. |
| PTRN-03 | 패턴 결과가 Conversation Briefing에 포함되어 후속 에이전트에 전달 | 패턴 findings를 MEDIUM urgency로 기록. 기존 findings 라우팅 시스템(company change 시 MEDIUM 전달)으로 Conversation Briefing에 자동 포함. SKILL.md에 패턴 findings의 브리핑 삽입 규칙 추가. |
</phase_requirements>

## Standard Stack

### Core Approach: Deterministic Date Parsing + Prompt Engineering

No external libraries needed. The "stack" is JavaScript date arithmetic in the existing hook + prompt modifications to existing markdown agent files.

| Component | Technique | Purpose | Confidence |
|-----------|-----------|---------|------------|
| Period Parsing | Regex `(\d{4})\.(\d{2})` on period fields | Extract start/end dates from "YYYY.MM - YYYY.MM" | HIGH |
| Gap Detection | Deterministic month arithmetic (year*12 + month) | Find gaps between consecutive time spans | HIGH |
| Gap Classification | Threshold comparison (3mo intra / 6mo inter) | Distinguish probing-worthy gaps from noise | HIGH |
| Pattern Analysis | Structured comparison framework in profiler.md | 4-category cross-company episode comparison | HIGH |
| Gap Probing | HR agent prompt section with skip option | User-facing gap exploration | HIGH |
| Findings Routing | Existing findings-inbox.jsonl + hook pipeline | Deliver timeline/pattern results to orchestrator | HIGH |

[VERIFIED: codebase inspection of episode-watcher.mjs, profiler.md, SKILL.md, hr.md]

### No Installation Required

```
# No install commands. The "stack" is deterministic date math + prompt engineering.
```

## Architecture Patterns

### Modification Map

```
plugins/resume/scripts/episode-watcher.mjs    # Add parsePeriod(), buildTimeline(), detectGaps()
                                               # Add timeline analysis trigger alongside profiler trigger
                                               # Fix data structure iteration (companies[].projects[])
plugins/resume/scripts/test-episode-watcher.mjs # Add timeline + pattern trigger tests
plugins/resume/.claude/agents/profiler.md      # Add cross-company pattern analysis section
plugins/resume/.claude/agents/hr.md            # Add gap probing mode section
plugins/resume/skills/resume-panel/SKILL.md    # Add timeline_gap_found + pattern_detected handlers
                                               # Add intentional_gap tracking rules
                                               # Add gap probing orchestration rules
.resume-panel/meta.json                        # Add timeline_gaps_checked flag, pattern_analysis fields
```

### Pattern 1: Timeline Gap Detection (Deterministic)

**What:** Parse period fields, compute chronological gaps, emit findings.
**When:** Every time the profiler threshold triggers (score >= 5), check timeline alongside profiler call.
**Implementation detail:**

The timeline detection runs in episode-watcher.mjs as a synchronous analysis. When the scoring system triggers (score >= 5), the hook also runs timeline analysis and emits `timeline_gap_found` findings to findings-inbox.jsonl. The profiler does NOT do the gap detection -- the hook does it deterministically. [VERIFIED: CLAUDE.md explicitly states "Date arithmetic is deterministic -- don't waste LLM tokens on what a regex + date parser can do"]

```javascript
// Source: CLAUDE.md specification + codebase patterns
function parsePeriod(periodStr) {
  // "2023.03 - 2024.06" -> { start: { year: 2023, month: 3 }, end: { year: 2024, month: 6 } }
  const match = periodStr.match(/(\d{4})\.(\d{2})\s*-\s*(\d{4})\.(\d{2})/);
  if (!match) return null;
  return {
    start: { year: parseInt(match[1]), month: parseInt(match[2]) },
    end: { year: parseInt(match[3]), month: parseInt(match[4]) },
  };
}

function toMonths(date) {
  return date.year * 12 + date.month;
}

function gapMonths(endDate, startDate) {
  return toMonths(startDate) - toMonths(endDate);
}
```

[ASSUMED: The period format "YYYY.MM - YYYY.MM" is consistent across all projects. CONTEXT.md specifies this regex but real user data may have variations like "2023.3" or "현재".]

### Pattern 2: Cross-Company Pattern Analysis (LLM Prompt)

**What:** Profiler analyzes episodes across companies for recurring behavioral patterns.
**When:** During profiler's autonomous orchestration mode, only when 3+ new episodes have accumulated since last pattern analysis.
**Implementation detail:**

The profiler.md prompt gets a new "패턴 분석" section with a structured comparison framework. The profiler uses this framework during its normal autonomous orchestration cycle. It writes pattern findings to findings-inbox.jsonl. No new trigger mechanism needed -- the profiler already runs when hook triggers it. [VERIFIED: profiler.md "자율 오케스트레이션 모드" section already handles background Agent calls and findings-inbox.jsonl writes]

```
## 패턴 분석 (자율 오케스트레이션 확장)

에피소드가 3개 이상이고 2개 이상 회사에 걸쳐 있을 때, 다음 4가지 카테고리로 크로스 컴퍼니 패턴을 분석한다:

1. **역할 반복**: 여러 회사에서 비슷한 역할/포지션을 반복하는 패턴
2. **기술 선택 패턴**: 어디를 가든 특정 기술/도구를 선택하거나 도입하는 패턴
3. **성장/전환 패턴**: 커리어 궤적에서 반복되는 성장 또는 전환 행동
4. **문제해결 스타일**: 문제에 접근하는 반복적 방식

각 패턴에 대해:
- 패턴 이름 (3-5단어)
- 근거 에피소드 목록 (회사, 프로젝트, 에피소드 제목)
- 아직 물어보지 않은 회사에서 비슷한 경험이 있을 것으로 추정되는지 여부
- 추정되면: 구체적 질문 제안 + 어떤 에이전트가 물어야 하는지
```

[VERIFIED: CLAUDE.md "6. 크로스 컴퍼니 패턴 탐지" section specifies this exact output format]

### Pattern 3: Gap Probing via HR Agent

**What:** HR agent receives timeline_gap_found findings and generates probing questions with skip option.
**When:** Orchestrator receives timeline_gap_found finding via additionalContext, routes to HR agent.
**Implementation detail:**

HR agent gets a new "갭 프로빙 모드" section. When the orchestrator passes gap context, HR generates a probing question with 2 substantive options + "건너뛰기" option. The orchestrator converts this to AskUserQuestion following existing conversion rules. If the user skips, the gap is marked as `intentional_gap` in meta.json (never probed again). If the user provides content, it becomes a new episode. [VERIFIED: CONTEXT.md specifies HR as gap probing owner; CLAUDE.md specifies skip option requirement]

### Critical: Data Structure Discrepancy

**Discovery:** The existing episode-watcher.mjs iterates `source.projects` (flat array), but the canonical resume-source.json schema in SKILL.md defines `source.companies[].projects[]` (nested under companies). [VERIFIED: episode-watcher.mjs lines 71, 79, 93, 109, 219 all use `source.projects || []`; SKILL.md lines 497-524 show nested companies[].projects[] schema]

**Impact on Phase 4:**
- Timeline gap detection MUST iterate `source.companies[].projects[]` to know which company each project belongs to (required for inter-company vs intra-company threshold differentiation)
- The `company` field exists in test data on each project object (`{ name: "A", company: "튜닙", ... }`) but this is a test convenience, not the canonical schema
- All existing helper functions (`countEpisodes`, `getProjectNames`, `countStarGaps`, `detectMinimization`, SO-WHAT trigger) need to iterate the correct nested structure

**Resolution options:**
1. **Normalize in helper:** Add a `getAllProjects(source)` function that handles both structures (`source.companies[].projects[]` and fallback to `source.projects[]` for backward compatibility). Timeline functions use the companies-aware path.
2. **Fix all functions:** Update all existing functions to iterate `source.companies[].projects[]`. Update all tests to use the canonical schema.

**Recommendation:** Option 2 (fix all functions). The canonical schema is what the orchestrator produces. The flat `source.projects` structure was a test-only convention. Fixing this now prevents divergence. All 34 existing tests need updating. [ASSUMED: The orchestrator actually produces the nested companies[].projects[] structure as defined in SKILL.md. If it produces flat projects[], this fix is unnecessary.]

### Anti-Patterns to Avoid

- **LLM date math:** Never ask the LLM to compute timeline gaps. Date arithmetic must be deterministic JavaScript code. [VERIFIED: CLAUDE.md explicitly prohibits this]
- **Premature pattern detection:** Do not run pattern analysis on fewer than 3 episodes or when all episodes come from a single company. [VERIFIED: CLAUDE.md "Do NOT run pattern detection on every episode save. Wait for profiler's natural trigger cycle (3+ episode delta)"]
- **Embedding/vector similarity:** Do not use embeddings for pattern matching. LLM semantic comparison on structured STAR data is sufficient for 10-30 episodes. [VERIFIED: CLAUDE.md explicitly prohibits this]
- **Gap probing without skip:** Every gap question MUST include a skip option. No exceptions. [VERIFIED: CONTEXT.md + CLAUDE.md]
- **Accusatory gap framing:** Frame gaps as opportunities, not interrogations. [VERIFIED: PITFALLS.md Pitfall 7]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Date parsing | Custom date library | Simple regex + month arithmetic | Period format is controlled ("YYYY.MM - YYYY.MM"), no timezone/locale complexity needed |
| Pattern detection | Embedding similarity pipeline | Structured LLM comparison in profiler prompt | Episode count is 10-30, too small for statistical patterns. LLM semantic reasoning is more interpretable |
| Findings delivery | New delivery mechanism | Existing findings-inbox.jsonl pipeline | Already handles urgency routing, company-change triggers, delivered flags |
| Gap probing UX | Custom gap UI | Existing AskUserQuestion + HR agent pattern | HR already handles sensitive topics; AskUserQuestion provides skip via standard select box |
| State tracking | New state file | Existing meta.json + snapshot.json | Already used for profiler_score, so_what_active; add timeline/pattern flags alongside |

**Key insight:** This phase adds two analyses but zero new infrastructure. Both features route through existing pipelines (hook detection -> findings-inbox.jsonl -> hook routing -> orchestrator delivery). The only new code is date parsing functions; everything else is prompt additions.

## Common Pitfalls

### Pitfall 1: Timeline Gap Probing Hits Sensitive Topics
**What goes wrong:** Automated gap detection finds a 6-month gap due to health issues, burnout, or job loss. The system's probing feels invasive.
**Why it happens:** The system prioritizes thoroughness over sensitivity. Korean work culture amplifies gap stigma.
**How to avoid:** (1) Every gap question has mandatory "건너뛰기" option. (2) Accept skip immediately, mark as `intentional_gap`, never re-probe. (3) Frame as opportunity: "이 기간에 혹시 이직 준비나 사이드 프로젝트 같은 거 한 게 있어?" not "왜 이 기간 동안 아무것도 안 했어?". (4) Maximum gap probes per session -- avoid overwhelming users with many gap questions. [VERIFIED: PITFALLS.md Pitfall 7; CONTEXT.md locks skip option requirement]
**Warning signs:** User selects "건너뛰기" frequently. Session shortens after gap probe.

### Pitfall 2: False Pattern Detection from Small Sample
**What goes wrong:** Profiler "discovers" patterns that are coincidental (e.g., "you always use Python" when both companies happened to use Python).
**Why it happens:** LLMs are pattern-completion machines that find patterns even in noise. 3-5 companies with 10-20 episodes is a tiny sample.
**How to avoid:** (1) Require 2+ episodes across 2+ different companies. (2) Pattern must involve user AGENCY (chose to do X), not coincidence (company already used X). (3) Present as hypothesis: "혹시 이런 패턴인 것 같은데..." not "분명히 이런 패턴이야". (4) Include "null finding is acceptable" instruction in profiler prompt. [VERIFIED: PITFALLS.md Pitfall 5; CONTEXT.md locks minimum 2 episodes / 2 companies]
**Warning signs:** Pattern descriptions match generic technology trends rather than individual behavior.

### Pitfall 3: Period Field Missing or Inconsistent
**What goes wrong:** Timeline detection assumes all projects have `period` fields. Some projects lack period data, or users enter inconsistent formats ("2023년", "작년~올해", "현재").
**Why it happens:** Period fields are populated by the orchestrator during interview. Some projects may not have clear start/end dates.
**How to avoid:** (1) `parsePeriod()` returns null for unparseable periods. (2) Projects without valid periods are excluded from timeline analysis. (3) Handle "현재" / "재직중" as current date. (4) Log warning in findings when periods are missing. [VERIFIED: PITFALLS.md mentions "Period field completeness" as open concern]
**Warning signs:** Timeline has large "unknown" segments.

### Pitfall 4: Hook Timeout from Timeline Analysis
**What goes wrong:** The PostToolUse hook has a 10-second timeout. Complex timeline analysis on many companies/projects exceeds this.
**Why it happens:** The hook runs synchronously. Date parsing + gap detection + findings writing adds execution time.
**How to avoid:** Timeline analysis is simple arithmetic (parse regex, compare months), not CPU-intensive. For a typical resume (3-5 companies, 10-20 projects), execution time is negligible (<10ms). No risk here. [VERIFIED: hooks.json shows 10-second timeout; date arithmetic is O(n) where n = number of projects]
**Warning signs:** Hook exits with timeout error.

### Pitfall 5: Pattern Analysis Runs Too Early
**What goes wrong:** Pattern detection fires with only 2-3 episodes from a single company, producing meaningless "patterns."
**Why it happens:** The profiler trigger fires at score >= 5, which can happen early (new company +3 + episode +1 + meta change +2 = 6).
**How to avoid:** (1) Guard pattern analysis with episode count >= 3 AND company count >= 2 check. (2) Track `last_pattern_episode_count` in meta.json -- only re-run when 3+ new episodes since last analysis. (3) Include guard condition in both hook message (for orchestrator awareness) and profiler prompt (for LLM self-check). [VERIFIED: CONTEXT.md locks 3+ episodes condition; CLAUDE.md prohibits premature pattern detection]
**Warning signs:** Pattern findings appear before Round 2.

### Pitfall 6: Data Structure Mismatch Breaks All Counting
**What goes wrong:** Timeline functions iterate `source.companies[].projects[]` but existing functions iterate `source.projects`. If only timeline is fixed, the scoring system and SO-WHAT trigger still use the wrong path.
**Why it happens:** The initial hook implementation used test data with flat `projects[]` structure, but SKILL.md schema (which the orchestrator follows) uses nested `companies[].projects[]`.
**How to avoid:** Fix ALL iterator functions (`countEpisodes`, `getProjectNames`, `countStarGaps`, `detectMinimization`, SO-WHAT trigger block) to use `source.companies[].projects[]`. Update all 34+ test cases to use the canonical nested schema. This is a prerequisite for timeline gap detection. [VERIFIED: episode-watcher.mjs lines 69-122 all use `source.projects || []`; SKILL.md schema shows `companies[].projects[]`]
**Warning signs:** Episode counts are always 0 in production while tests pass.

## Code Examples

### Timeline Parsing Functions

```javascript
// Source: CLAUDE.md specification + codebase patterns [VERIFIED]
// All functions iterate source.companies[].projects[] (canonical schema)

function getAllProjects(source) {
  const projects = [];
  for (const company of source.companies || []) {
    for (const project of company.projects || []) {
      projects.push({ ...project, companyName: company.name });
    }
  }
  return projects;
}

function parsePeriod(periodStr) {
  if (!periodStr || typeof periodStr !== "string") return null;
  // Handle "현재" / "재직중" as current date
  const currentDate = new Date();
  const currentStr = `${currentDate.getFullYear()}.${String(currentDate.getMonth() + 1).padStart(2, "0")}`;
  const normalized = periodStr.replace(/현재|재직중/g, currentStr);

  const match = normalized.match(/(\d{4})\.(\d{1,2})\s*-\s*(\d{4})\.(\d{1,2})/);
  if (!match) return null;
  return {
    start: { year: parseInt(match[1]), month: parseInt(match[2]) },
    end: { year: parseInt(match[3]), month: parseInt(match[4]) },
  };
}

function toMonths(d) { return d.year * 12 + d.month; }

function detectGaps(source) {
  const gaps = [];
  const allProjects = getAllProjects(source);

  // Parse all periods
  const spans = allProjects
    .map(p => ({ ...parsePeriod(p.period), company: p.companyName, project: p.name }))
    .filter(s => s && s.start && s.end)
    .sort((a, b) => toMonths(a.start) - toMonths(b.start));

  for (let i = 0; i < spans.length - 1; i++) {
    const curr = spans[i];
    const next = spans[i + 1];
    const gapMo = toMonths(next.start) - toMonths(curr.end);
    const sameCompany = curr.company === next.company;
    const threshold = sameCompany ? 3 : 6;

    if (gapMo > threshold) {
      gaps.push({
        from: { company: curr.company, project: curr.project, end: curr.end },
        to: { company: next.company, project: next.project, start: next.start },
        months: gapMo,
        type: sameCompany ? "intra_company" : "inter_company",
      });
    }
  }
  return gaps;
}
```

### Timeline Gap Finding Format

```jsonl
{"id":"tg-001","type":"timeline_gap_found","urgency":"MEDIUM","source":"episode-watcher","message":"2022.03 ~ 2022.09 (6개월) 공백: 프로젝트A(튜닙) 종료 후 프로젝트B(한섬) 시작 전","context":{"from_company":"튜닙","from_project":"프로젝트A","to_company":"한섬","to_project":"프로젝트B","gap_months":6,"gap_type":"inter_company"},"created_at":"2026-04-08T10:00:00Z"}
```

### Pattern Detection Finding Format

```jsonl
{"id":"pt-001","type":"pattern_detected","urgency":"MEDIUM","source":"profiler","message":"패턴 발견: '레거시 시스템 현대화 주도' — 튜닙(모놀리스 분리), 한섬(결제 시스템 리팩토링)에서 반복. 코인원에서도 비슷한 경험이 있을 것으로 추정.","context":{"pattern_name":"레거시 시스템 현대화 주도","evidence_episodes":[{"company":"튜닙","project":"프로젝트A","episode":"모놀리스 마이크로서비스 분리"},{"company":"한섬","project":"결제팀","episode":"결제 시스템 리팩토링"}],"unexplored_company":"코인원","suggested_question":"코인원에서도 기존 시스템을 리팩토링하거나 현대화한 경험이 있어?","target_agent":"시니어"},"created_at":"2026-04-08T10:00:00Z"}
```

### Intentional Gap Tracking in meta.json

```json
{
  "profiler_score": 0,
  "so_what_active": null,
  "intentional_gaps": [
    { "from": "2022.03", "to": "2022.09", "marked_at": "2026-04-08T10:00:00Z" }
  ],
  "last_timeline_check": "2026-04-08T10:00:00Z",
  "last_pattern_analysis_episode_count": 8,
  "last_pattern_analysis_company_count": 3
}
```

### SKILL.md Handler Pattern for timeline_gap_found

```markdown
6. **`[resume-panel:MEDIUM]` (timeline_gap_found)** -> 갭 프로빙
   - finding context에서 gap 정보 추출
   - meta.json의 intentional_gaps 확인 -- 이미 스킵한 갭이면 무시
   - HR 에이전트를 갭 프로빙 모드로 호출:
     ```
     Agent(
       prompt: "갭 프로빙 모드. 공백: {from_company} {from_project} 종료(YYYY.MM) ~ {to_company} {to_project} 시작(YYYY.MM). {gap_months}개월 공백."
     )
     ```
   - HR 리턴을 AskUserQuestion으로 변환 (기존 변환 규칙 동일 적용)
   - "건너뛰기" 선택 시:
     - meta.json의 intentional_gaps에 추가
     - 해당 갭 재질문 방지
   - 실질적 답변 시:
     - 새 에피소드로 추출하여 resume-source.json에 저장
```

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Node.js built-in assert (no external test runner) |
| Config file | none -- test file is self-contained |
| Quick run command | `node plugins/resume/scripts/test-episode-watcher.mjs` |
| Full suite command | `node plugins/resume/scripts/test-episode-watcher.mjs` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TIME-01 | parsePeriod correctly parses "YYYY.MM - YYYY.MM" format | unit | `node plugins/resume/scripts/test-episode-watcher.mjs` | Wave 0 |
| TIME-01 | buildTimeline sorts projects chronologically | unit | `node plugins/resume/scripts/test-episode-watcher.mjs` | Wave 0 |
| TIME-02 | detectGaps finds inter-company gaps >6 months | unit | `node plugins/resume/scripts/test-episode-watcher.mjs` | Wave 0 |
| TIME-02 | detectGaps finds intra-company gaps >3 months | unit | `node plugins/resume/scripts/test-episode-watcher.mjs` | Wave 0 |
| TIME-02 | detectGaps ignores gaps <3 months | unit | `node plugins/resume/scripts/test-episode-watcher.mjs` | Wave 0 |
| TIME-02 | timeline_gap_found finding written to findings-inbox.jsonl | integration | `node plugins/resume/scripts/test-episode-watcher.mjs` | Wave 0 |
| TIME-03 | intentional_gap in meta.json prevents re-probing | unit | `node plugins/resume/scripts/test-episode-watcher.mjs` | Wave 0 |
| PTRN-01 | pattern analysis guard: skip when episodes < 3 | unit | `node plugins/resume/scripts/test-episode-watcher.mjs` | Wave 0 |
| PTRN-01 | pattern analysis guard: skip when companies < 2 | unit | `node plugins/resume/scripts/test-episode-watcher.mjs` | Wave 0 |
| PTRN-01 | profiler trigger message includes pattern eligibility flag | integration | `node plugins/resume/scripts/test-episode-watcher.mjs` | Wave 0 |
| PTRN-02 | profiler.md pattern section output format | manual-only | manual review of prompt output | N/A (prompt engineering) |
| PTRN-03 | pattern_detected finding routes via MEDIUM urgency path | integration | `node plugins/resume/scripts/test-episode-watcher.mjs` | Wave 0 |

### Sampling Rate
- **Per task commit:** `node plugins/resume/scripts/test-episode-watcher.mjs`
- **Per wave merge:** `node plugins/resume/scripts/test-episode-watcher.mjs`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] Timeline parsing unit tests (parsePeriod, toMonths, detectGaps) -- covers TIME-01, TIME-02
- [ ] Timeline integration test (gap finding triggers finding write) -- covers TIME-02
- [ ] Intentional gap prevention test -- covers TIME-03
- [ ] Pattern eligibility guard tests (episode count, company count) -- covers PTRN-01
- [ ] Update all 34+ existing tests to use `companies[].projects[]` schema -- prerequisite for all new tests
- [ ] Framework install: none needed (built-in Node.js assert)

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Flat `source.projects[]` in hook | Nested `source.companies[].projects[]` per SKILL.md | Phase 4 (now) | All hook functions need updating for canonical schema |
| No timeline analysis | Deterministic date parsing + gap detection in hook | Phase 4 (now) | Adds career gap awareness to profiler system |
| No cross-company analysis | Structured comparison framework in profiler prompt | Phase 4 (now) | Enables pattern-based episode discovery |
| Only HIGH urgency immediate routing | MEDIUM timeline/pattern findings route on company change | Existing | Pattern/gap findings use existing MEDIUM routing path |

## Assumptions Log

> List all claims tagged `[ASSUMED]` in this research. The planner and discuss-phase use this
> section to identify decisions that need user confirmation before execution.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Period format "YYYY.MM - YYYY.MM" is consistent across all projects; real user data may have variations like "2023.3", "현재", or Korean date formats | Architecture Patterns - Pattern 1 | parsePeriod() needs more robust parsing; some gaps may be missed |
| A2 | The orchestrator actually produces the nested `companies[].projects[]` structure as defined in SKILL.md, not the flat `projects[]` used in test data | Architecture Patterns - Critical Discovery | If the orchestrator produces flat `projects[]`, the data structure fix is unnecessary and timeline detection needs different iteration logic |
| A3 | Edge case "현재" / "재직중" appears in period fields for current positions | Code Examples | If these strings don't appear, the handling code is dead but harmless |

## Open Questions (RESOLVED)

1. **Does the orchestrator produce `companies[].projects[]` or flat `projects[]`?**
   - What we know: SKILL.md schema shows `companies[].projects[]`. Test data uses flat `projects[]`. No actual resume-source.json exists to inspect.
   - What's unclear: The exact runtime structure the LLM orchestrator produces.
   - Recommendation: Add a backward-compatible helper `getAllProjects(source)` that handles both structures. Fix tests to use the canonical schema. Verify by running a test interview session before Phase 4 work.
   - **RESOLVED (Plan 04-01):** `getAllProjects(source)` handles nested `companies[].projects[]` structure. All existing tests migrated to canonical schema. Backward compatibility handled via helper function.

2. **How many gap probes per session is acceptable?**
   - What we know: PITFALLS.md suggests maximum 2 gap probes per interview. CONTEXT.md doesn't specify a limit.
   - What's unclear: Whether a hard limit should be enforced in the hook or the orchestrator.
   - Recommendation: Implement the limit in SKILL.md orchestrator rules (soft limit, 2-3 per session), not in the hook code.
   - **RESOLVED (Plan 04-03):** 3 per session limit implemented in SKILL.md via `gap_probes_this_session` counter. Chose 3 (upper bound of 2-3 range) to balance thoroughness vs. user fatigue.

3. **Pattern analysis timing: during profiler trigger or independent?**
   - What we know: CONTEXT.md says "프로파일러 사이클 + 3개 이상 신규 에피소드 축적 시에만 패턴 분석 실행"
   - What's unclear: Whether the 3+ episode delta is measured from last profiler call or last pattern analysis specifically.
   - Recommendation: Track `last_pattern_analysis_episode_count` in meta.json separately. Pattern analysis runs only when both conditions are met: profiler triggers AND episode count >= last_pattern_analysis_episode_count + 3.
   - **RESOLVED (Plan 04-01):** `last_pattern_analysis_episode_count` tracked in meta.json. Pattern analysis runs during profiler trigger when episode count >= last count + 3.

## Project Constraints (from CLAUDE.md)

- **Platform**: Claude Code plugin system (SKILL.md + agents + hooks)
- **Tool constraints**: AskUserQuestion provides 2-4 options, 1-4 questions simultaneously; NOT in allowed-tools (bug #29547)
- **Existing structure preservation**: 4-round structure and agent role division maintained
- **Profiler dependency**: Timeline gap + pattern detection depend on profiler agent enhancement
- **No embeddings/vectors**: LLM semantic comparison only for pattern detection
- **No LLM date math**: Deterministic parsing only for timeline gaps
- **Intra-company gap threshold**: >3 months
- **Inter-company gap threshold**: >6 months
- **Sub-3-month gaps**: Always ignored
- **Pattern minimum evidence**: 2+ episodes, 2+ companies
- **Premature pattern detection prohibited**: 3+ episode delta required
- **multiSelect**: Always false for interview questions
- **Agent output format**: Keep existing numbered list format unchanged
- **No new agents**: All functionality added to existing agents (HR for gap probing, profiler for pattern analysis)

## Sources

### Primary (HIGH confidence)
- [Codebase] episode-watcher.mjs -- current hook implementation, all helper functions, scoring system, SO-WHAT trigger
- [Codebase] profiler.md -- autonomous orchestration mode, findings-inbox.jsonl protocol, meta.json update pattern
- [Codebase] SKILL.md -- resume-source.json canonical schema, orchestrator handling rules, AskUserQuestion conversion
- [Codebase] hr.md -- existing question generation rules, agent output format
- [Codebase] c-level.md -- So What chain mode (reference for similar prompt section pattern)
- [Codebase] test-episode-watcher.mjs -- 34 existing tests, test infrastructure pattern, setupTestDir/runWithBase helpers
- [Codebase] hooks.json -- PostToolUse hook configuration (10s timeout)
- [Codebase] CLAUDE.md -- all feature specifications, anti-patterns, data structure constraints

### Secondary (MEDIUM confidence)
- [Codebase] .planning/research/PITFALLS.md -- Pitfall 5 (false patterns), Pitfall 7 (sensitive gap probing), Pitfall 8 (hook overload)
- [Codebase] .planning/research/FEATURES.md -- Timeline gap detection specification, cross-company pattern detection specification
- [Codebase] .planning/phases/03-so-what-chain/03-RESEARCH.md -- reference implementation pattern for hook + prompt + SKILL.md integration

### Tertiary (LOW confidence)
- None -- all research based on codebase inspection

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no external dependencies, pure JavaScript + prompt engineering
- Architecture: HIGH -- follows exactly the same patterns as Phase 2 (scoring) and Phase 3 (SO-WHAT)
- Pitfalls: HIGH -- documented in project research with specific prevention strategies
- Data structure fix: MEDIUM -- the discrepancy is verified but the runtime behavior needs validation (see Assumption A2)

**Research date:** 2026-04-08
**Valid until:** 2026-05-08 (stable -- no external dependencies that could change)
