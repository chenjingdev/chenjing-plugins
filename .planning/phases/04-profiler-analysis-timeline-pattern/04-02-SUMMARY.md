---
phase: 04-profiler-analysis-timeline-pattern
plan: 02
subsystem: profiler-pattern-analysis, hr-gap-probing
tags: [prompt-engineering, pattern-detection, gap-probing, agent-enhancement]
dependency_graph:
  requires: []
  provides: [profiler-pattern-framework, hr-gap-probing-mode]
  affects: [SKILL.md-orchestration-rules, findings-inbox-pipeline]
tech_stack:
  added: []
  patterns: [structured-comparison-framework, opportunity-framing, mandatory-skip-option]
key_files:
  created: []
  modified:
    - plugins/resume/.claude/agents/profiler.md
    - plugins/resume/.claude/agents/hr.md
decisions:
  - "Pattern analysis uses 4 behavioral categories with 2+ episode / 2+ company minimum evidence"
  - "Gap probing always includes mandatory skip option as last choice"
  - "Pattern target_agent routing based on category type"
metrics:
  duration: 4min
  completed: "2026-04-07T16:26:00Z"
  tasks: 2
  files: 2
---

# Phase 04 Plan 02: Agent Prompt Enhancement (Pattern + Gap Probing) Summary

Cross-company 4-category pattern analysis framework in profiler.md with structured JSON output format, plus gap probing mode in hr.md with mandatory skip option and opportunity framing

## What Was Done

### Task 1: Add cross-company pattern analysis section to profiler.md
**Commit:** 03f4f38

Added `### 2. 크로스 컴퍼니 패턴 분석` section inside `## 자율 오케스트레이션 모드`, between agent dispatch and findings recording. The section includes:

- 4 behavioral analysis categories: 역할 반복, 기술 선택 패턴, 성장/전환 패턴, 문제해결 스타일
- Guard condition: only executes when orchestrator message contains "패턴 분석 가능" and episodes >= 3 across 2+ companies
- Pattern judgment criteria requiring user agency (not coincidental company choices)
- Structured JSON output format (`pattern_detected` type) with `target_agent`, `suggested_question`, `evidence_episodes`, `unexplored_company` fields
- Target agent routing rules by pattern category
- Prohibition section (no embeddings, no premature analysis, no generic trends)
- Updated meta.json example with `last_pattern_analysis_episode_count`, `last_pattern_analysis_company_count`, `last_timeline_check` fields
- Renumbered existing subsections: 1->1, new->2, 2->3, 3->4

### Task 2: Add gap probing mode section to hr.md
**Commit:** 9304032

Added `## 갭 프로빙 모드` section between `## 산출 형식` and `## 금지사항`. The section includes:

- Input specification (gap period, gap type, user profile, researcher data)
- Question generation rules with opportunity framing ("이 기간에 혹시 이런 거 했어?" not "왜 비었어?")
- Mandatory 3-option structure: 2 substantive options + "이 기간은 건너뛰기"
- Inter-company gap pattern (이직 준비, 프리랜서/컨설팅)
- Intra-company gap pattern (부서 이동, 내부 프로젝트)
- Core rules: mandatory skip, immediate acceptance of skip, contextual questions with company/project names
- New prohibition in 금지사항: 심문조 금지, opportunity framing only

## Deviations from Plan

None -- plan executed exactly as written.

## Decisions Made

1. **Pattern analysis uses 4 behavioral categories** -- 역할 반복, 기술 선택 패턴, 성장/전환 패턴, 문제해결 스타일 as specified in RESEARCH.md and CONTEXT.md
2. **Mandatory skip option always last** -- "이 기간은 건너뛰기" is always the 3rd (last) option in gap probing questions
3. **Target agent routing by pattern category** -- 역할반복/기술선택 -> 시니어, 성장전환 -> C-Level, 문제해결 -> 시니어 or C-Level

## Verification Results

All verification checks passed:
1. profiler.md contains 4-category pattern analysis section between agent dispatch and findings recording
2. profiler.md pattern output format matches findings-inbox.jsonl schema (pattern_detected type)
3. hr.md gap probing generates questions with 2 substantive + 1 skip option
4. hr.md uses opportunity framing, not interrogation framing
5. Both files maintain existing section structure (no deletions, only additions)

## Self-Check: PASSED
