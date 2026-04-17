# AskUserQuestion — Conversion Rules and Fallback

Read this file before the first AskUserQuestion call of the session, or whenever the conversion/fallback behavior is unclear.

## Conversion Rules

Parse the agent's returned text and call AskUserQuestion:

1. **Extract question text**: everything from `[에이전트명]` up to (but not including) the first `\n  1)` or `\n1)` becomes the `question`.
2. **Extract options**: each `N) text` line becomes an option, in order.
3. **Drop 직접입력**: if the last option is "직접입력", drop it (AskUserQuestion auto-adds "Other").
4. **Header mapping**: extract the name from the `[에이전트명]` tag.
   - `[시니어]` → "시니어"
   - `[C-Level]` → "C-Level"
   - `[채용담당자]` → "채용담당자"
   - `[인사담당자]` → "인사담당자"
   - `[커피챗: {이름}]` → "{이름}" (truncate to 12 chars)
5. **Label generation**: shorten each option's text to 1–5 words for `label`; put the full original text in `description`.
6. **Free-form detection**: if there is no `N)` pattern, skip AskUserQuestion and pass the agent's text through as plain text.
7. **multiSelect**: always `false`.

## Conversion Example

```
# 에이전트 리턴:
[시니어] Kafka 도입한 거 봤는데, 이거 직접 밀었어 아니면 이미 있던 거야?
  1) 내가 제안해서 도입
  2) 기존에 있었고 활용만
  3) 마이그레이션 작업
  4) 직접입력

# AskUserQuestion 호출:
questions: [{
  question: "Kafka 도입한 거 봤는데, 이거 직접 밀었어 아니면 이미 있던 거야?",
  header: "시니어",
  options: [
    { label: "제안 도입", description: "내가 제안해서 도입" },
    { label: "기존 활용", description: "기존에 있었고 활용만" },
    { label: "마이그레이션", description: "마이그레이션 작업" }
  ],
  multiSelect: false
}]
// "직접입력" 드롭 — "Other"가 자동 추가됨
```

## Known Bug: allowed-tools

**Never add AskUserQuestion to `allowed-tools` in the SKILL.md frontmatter** (bug #29547 — placing it in allowed-tools causes auto-completed empty responses).

## Fallback Procedure

If the AskUserQuestion call fails (empty response, error, timeout):

1. Show the message "셀렉트 박스 로딩에 문제가 생겼어요. 다시 시도할게요."
2. Retry AskUserQuestion with the same parameters (1 retry).
3. If the second attempt also fails:
   - Show "텍스트로 답변해주세요."
   - Display the agent's original text, including the numbered options, as-is:
     ```
     [시니어] 질문 텍스트
       1) 선택지1
       2) 선택지2
       3) 선택지3
     번호를 입력하거나 자유롭게 답변해주세요.
     ```
   - Handle the user's text as either a number selection or a free-form answer (the legacy flow).

## User Response Handling

- User clicks an option → use that option's `description` text as the agent's answer.
- User picks "Other" and types free text → use the entered text as the agent's answer.
- Fallback mode (numbered text) → if the user types a number, treat it as the matching option; otherwise treat as free text.

If an episode can be extracted from the user's answer, save it to `resume-source.json` immediately.
