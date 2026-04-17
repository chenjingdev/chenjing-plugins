# Autonomous Orchestration — Hook Message Handling

Read this file when the PostToolUse hook (`episode-watcher.mjs`) sends a message via `additionalContext`. It documents every message type the hook emits, how to classify them, and how to route each one back into the interview loop.

## Message Handling Rules

### 1. `[resume-panel] 프로파일러 호출 필요`

Call the profiler immediately as a background Agent.

```
Agent(
  prompt: "[delta 정보] + resume-source.json 전체 + 타겟 JD"
  run_in_background: true
)
```

Don't interrupt the interview after dispatching — keep going.

### 2. `[resume-panel:HIGH]`

After the current question/answer cycle finishes, present via AskUserQuestion.

Wrap the findings content in a meta question and call AskUserQuestion:

```
AskUserQuestion({
  questions: [{
    question: "프로파일러 분석 결과: {findings 내용 요약}. 어떻게 할래요?",
    header: "분석 결과",
    options: [
      { label: "관련 경험 있음", description: "관련 경험이 있는데 아직 얘기 안 한 것" },
      { label: "진짜 없음", description: "해당 경험이 정말 없음, 갭으로 기록" },
      { label: "넘어가기", description: "이 피드백은 나중에 보기" }
    ],
    multiSelect: false
  }]
})
```

- Tailor the options to the concrete finding content.
- Return to the next interview question immediately after delivery.

### 3. `[resume-panel:MEDIUM]`

Deliver via AskUserQuestion once the current project/company's episode mining finishes. Blend the finding content into the next question naturally:

```
AskUserQuestion({
  questions: [{
    question: "여기까지 정리하면서 리뷰 결과도 같이 볼게 — {findings 요약}. 어떻게 할까?",
    header: "리뷰 결과",
    options: [
      { label: "더 자세히", description: "이 부분에 대해 더 자세히 듣기" },
      { label: "다음으로", description: "다음 주제로 넘어가기" }
    ],
    multiSelect: false
  }]
})
```

### 4. LOW

Not delivered by the hook. If the user asks "분석해줘" or "리뷰해줘", Read `.resume-panel/findings.json` and deliver.

### 5. `[resume-panel:SO-WHAT]`

Once the current question/answer cycle finishes, start a So What chain.

Set `so_what_active` in meta.json:
```json
{
  "so_what_active": {
    "active": true,
    "episode_title": "{메시지에서 추출한 에피소드 제목}",
    "current_level": 1,
    "accumulated_result": "{해당 에피소드의 기존 result 텍스트}"
  }
}
```

Call C-Level in So What chain mode (level=1, target episode data included):
```
Agent(
  prompt: "So What 체인 모드. Level 1. 대상 에피소드: {title, situation, task, action, result}. 리서처 조사: {해당 회사}."
)
```

Convert C-Level's return into an AskUserQuestion (same conversion rules as in `references/askuserquestion.md`).

Handle the user's response:
- **"거기까지였음" selected**: save `accumulated_result` to the episode's `result`, set `so_what_active` to null, return to interview.
- **substantive answer**: append to `accumulated_result`, increment `current_level`.
  - level < 3: re-invoke C-Level (next level, include previous answer).
  - level = 3: ask C-Level to synthesize the final result (merge `accumulated_result` + Level 3 answer into a coherent result), save synthesized result to the episode's `result`, set `so_what_active` to null, return to interview.

**Storage**: update the episode's `result` field directly inside `resume-source.json` (rewrite the full JSON via Bash tool — see `references/storage.md`).

**Preserve original**: the initial value of `accumulated_result` is the existing `result`. Deepening answers augment/merge into the existing `result` — never overwrite it.

### 6. `[resume-panel:MEDIUM]` (timeline_gap_found) — Gap Probing

If the MEDIUM message body contains both "공백" and "개월", treat it as a timeline-gap finding.

Check meta.json's `intentional_gaps` array — if the gap was already skipped, ignore and move to the next message.

Call the HR agent in gap-probing mode:
```
Agent(
  prompt: "갭 프로빙 모드. 공백: {from_company} {from_project} 종료({from_end}) ~ {to_company} {to_project} 시작({to_start}). {gap_months}개월 공백. 갭 유형: {gap_type}. 유저 프로파일: {프로파일 요약}. 리서처 조사: {관련 회사 조사 결과}."
)
```

Convert HR's return into AskUserQuestion (same conversion rules).

Handle the user response:
- **"건너뛰기" selected**:
  - Append to meta.json's `intentional_gaps` array:
    ```bash
    # meta.json 읽기 → intentional_gaps에 추가 → 다시 쓰기
    # { "from": "{from_end}", "to": "{to_start}", "marked_at": "{ISO timestamp}" }
    ```
  - Never re-ask about this gap — the hook also checks `intentional_gaps` to avoid regenerating findings.
  - Return to interview immediately.
- **Substantive answer**:
  - Extract an episode from the answer and save it to `resume-source.json` (same saving rules as before).
  - The HR agent may ask 1–2 follow-up questions in standard HR mode.
  - After follow-ups finish, return to interview.

**Gap-probing limit**: at most 3 gaps per session. Track with meta.json's `gap_probes_this_session` counter. Ignore extra gap findings beyond that.

### 7. `[resume-panel:MEDIUM]` (pattern_detected) — Pattern-Driven Mining

If the MEDIUM message body contains "패턴 발견", treat it as a pattern finding.

Include it as a dedicated section in the Conversation Briefing:
```
## 대화 브리핑
- 유저가 지금까지 강조한 키워드/주제: [...]
- 이미 다룬 영역: [...]
- 아직 안 다룬 영역: [...]
- 유저의 직전 답변 요약: [...]
- **발견된 패턴**: {패턴 이름} — {근거 에피소드 요약}. {미탐색 회사 추정 또는 심화 방향}.
```

Prefer the agent named in the pattern's `target_agent` field for the next agent selection.

If `suggested_question` is present, include it in the agent call context:
```
Agent(
  prompt: "{기존 컨텍스트}. 패턴 분석에서 제안된 질문: '{suggested_question}'. 이 질문을 기반으로 에피소드를 발굴해줘."
)
```

Don't deliver the pattern finding immediately — merge it naturally into the next agent call (follow MEDIUM urgency rules).

### 8. `[resume-panel:MEDIUM]` (perspective_shift) — Perspective-Shift Question

If the MEDIUM message body contains "관점 전환", treat it as a perspective_shift finding.

- Check meta.json's `perspective_shifts_this_session` counter — if ≥ 2, ignore.
- Check meta.json's `perspective_shifted_episodes` array — if the `episode_ref` is already there, ignore.

Read `target_agent` from context — invoke that agent in perspective-shift mode:
```
Agent(
  prompt: "관점 전환 모드. 대상 에피소드: {episode_ref}({company} {project}). 관점: {target_perspective}. 장면 힌트: {scene_hint}. 유저 프로파일: {프로파일 요약}. 리서처 조사: {관련 회사 조사 결과}."
)
```

Convert the agent's return into AskUserQuestion (same conversion rules).

Handle the user response:
- **Modesty option selected** ("특별히 없었을 듯", "딱히 그런 인상은 없었을 듯", etc.): append `episode_ref` to meta.json's `perspective_shifted_episodes` array, return to interview.
- **Upgraded-role option selected**: allow 1 follow-up question to reinforce the episode's `result` (standard mode), and append `episode_ref` to `perspective_shifted_episodes`.

Increment meta.json's `perspective_shifts_this_session` counter.

### 9. `[resume-panel:HIGH]` (contradiction_detected) — Contradiction Restoration

If the HIGH message body contains "모순 발견" or "역할 모순", treat it as a contradiction_detected finding (HIGH without these keywords falls under item 2).

Check meta.json's `contradictions_presented_this_session` counter — if ≥ 2, ignore.

Extract `claim_a`, `claim_b`, `contradiction_type`, `likely_cause`, `restoration_question` from context.

Present the restoration question via AskUserQuestion:
```
AskUserQuestion({
  questions: [{
    question: "아까 이야기랑 연결해보면, {에피소드A}에서는 {claim_a.text 요약}라고 했는데 {에피소드B}에서는 {claim_b.text 요약}라고 했거든. 실제로는 어디까지 한 거야?",
    header: "연결 확인",
    options: [
      { label: "{큰 역할 요약}", description: "{claim with bigger role/scale}" },
      { label: "{작은 역할 요약}", description: "{claim with smaller role/scale}" },
      { label: "상황이 달랐음", description: "두 에피소드의 맥락이 달라서 역할이 다른 것" }
    ],
    multiSelect: false
  }]
})
```

Handle the user response:
- **Larger-role selected**: update the STAR field (`claim_b.star_field`) of the episode holding the smaller claim with the larger-role content. Rewrite the full `resume-source.json` via Bash tool (see `references/storage.md`). Touch only that field; preserve the rest of the episode.
- **Smaller-role selected**: update the STAR field (`claim_a.star_field`) of the episode holding the larger claim with the smaller-role content. Same field-only update.
- **"상황이 달랐음" selected**: both episodes are valid. No STAR update. Return to interview immediately.

When updating a STAR field: touch only `star_field` and keep the rest of the episode. Correct/augment — never fully replace the original. Then rewrite `resume-source.json` via Bash tool:
```bash
cat <<'EOF' > ./resume-source.json
{ ... 전체 JSON (수정된 필드만 변경, 나머지 보존) ... }
EOF
```

Increment meta.json's `contradictions_presented_this_session` counter.

**MEDIUM-urgency contradiction** (message contains "모순 발견" and urgency is MEDIUM):
- Include as a dedicated section in the Conversation Briefing:
  ```
  ## 대화 브리핑
  - ...기존 항목...
  - **확인 필요**: {contradiction_type} 관련 — {에피소드A}에서 {claim_a 요약}, {에피소드B}에서 {claim_b 요약}. 다음 관련 질문 시 자연스럽게 확인.
  ```
- Don't present via AskUserQuestion immediately — include in the next agent call's briefing so it gets verified naturally.

## Message-Classification Priority

- HIGH message contains "모순 발견" or "역할 모순" → item 9 (contradiction_detected)
- HIGH message without those keywords → item 2 (generic HIGH findings)
- MEDIUM message keyword classification:
  - "공백" + "개월" → item 6 (gap)
  - "패턴 발견" → item 7 (pattern)
  - "관점 전환" → item 8 (perspective)
  - "모순 발견" → item 9 MEDIUM (briefing)

## Protecting the Interview Flow

- Even for HIGH feedback, **finish the current question/answer cycle** before inserting.
- Never interrupt the interview for MEDIUM/LOW feedback.
- After delivering feedback, return to the next interview question immediately.
- SO-WHAT chains are multi-turn, so pause the standard interview flow until the chain finishes. Resume when the chain completes ("거기까지였음" or Level 3 done).
- If SO-WHAT and profiler messages arrive at the same time, handle SO-WHAT first (run the profiler in the background after the chain finishes).
- While `so_what_active` is active, ignore additional SO-WHAT messages (the hook also filters, but the orchestrator double-checks).
- Gap probing is single-turn and doesn't disrupt flow much. If the user picks 건너뛰기, return immediately.
- If gap probing and SO-WHAT arrive together, handle SO-WHAT first (gap probe after the chain completes).
- When the gap-probe limit (3 per session) is reached, silently ignore remaining gap findings.
- Perspective shifting is single-turn and doesn't disrupt flow much. If the user picks the modesty option, return immediately.
- If perspective shifting and SO-WHAT arrive together, handle SO-WHAT first (perspective shift after the chain completes).
- When the perspective-shift limit (2 per session) is reached, silently ignore remaining findings.
- Contradiction restoration is single-turn and doesn't disrupt flow much. If the user picks "상황이 달랐음", return immediately.
- If contradiction restoration and SO-WHAT arrive together, handle SO-WHAT first (restoration after the chain completes).
- When the contradiction limit (2 per session) is reached, silently ignore remaining contradiction findings.
