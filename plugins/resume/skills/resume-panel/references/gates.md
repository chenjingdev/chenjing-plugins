# Round Gates — 하드 게이트 명세

본 파일은 오케스트레이터와 hook이 공통으로 참조하는 게이트 명세다. **Phase 3 완료 후 감시 주체는 hook(`episode-watcher.mjs`)이고, 오케스트레이터는 `gate_violation` 메시지를 받으면 지시대로 복귀만 한다.**

Phase 1~2 동안은 오케스트레이터가 자체적으로 이 명세에 따라 자기 감시한다 (임시).

## G1. R1 Entry

**조건**: Round 1에서 특정 회사의 첫 AskUserQuestion **이전**에 해당 회사에 대한 senior 또는 c-level Agent 호출이 있어야 한다.

**위반 메시지**: `{ "type": "gate_violation", "gate": "r1_entry", "company": "{회사명}" }`

**복귀 액션**: "⚠️ Round 1 Entry Gate 미충족 — senior/c-level 호출로 복귀" 평문 출력 후 즉시 해당 에이전트 호출.

## G2. 직접 질문 폭주

**조건**: 오케스트레이터가 화이트리스트(SKILL.md 참조) 외의 AskUserQuestion을 Agent 호출 없이 **3회 연속** 호출.

**위반 메시지**: `{ "type": "gate_violation", "gate": "direct_question_burst", "count": 3 }`

**복귀 액션**: "⚠️ sub-agent 호출 없이 3회 직접 질문 — 에이전트 호출로 복귀" 평문 출력 후 현재 라운드 주도 에이전트 호출.

## G3. R2 Exit

**조건**: Round 2에서 Round 3로 전환하기 직전, 다음 4개 중 하나라도 미충족:

- recruiter 에이전트 1회 이상 호출
- hr 에이전트 1회 이상 호출
- Round 2 turn 수 ≥ 15
- gap_analysis.met 또는 gap_analysis.gaps 미설정(빈 배열이라도 배열로 기록)

**위반 메시지**: `{ "type": "gate_violation", "gate": "r2_exit", "missing": ["hr", "turn_min"] }`

**복귀 액션**: "⚠️ Round 2 Exit Gate 미충족 — {missing} 보강 필요" 평문 출력 후 부족한 에이전트 호출.

## G4. Retrospective Skipped

**조건**: `resume-draft.md` Write 발생 이후 세션 종료 신호(다음 유저 턴이 새 세션 or 세션 idle) 시점에 retrospective Agent 호출 이력 없음.

**위반 메시지**: `{ "type": "gate_violation", "gate": "retrospective_skipped" }`

**복귀 액션**: retrospective 에이전트를 즉시 호출하여 Step 9~10 수행.

## Phase 1 임시 자기감시

Phase 3 이전까지 오케스트레이터는 다음을 스스로 점검:

- Round 1 진입 → 해당 회사의 첫 AskUserQuestion 직전에 agent 호출 이력을 대화 맥락에서 확인
- AskUserQuestion 호출 시 직전 N개 이력을 대화 맥락에서 확인
- Round 2 → 3 전환 직전 recruiter/hr 호출 여부 및 turn 수를 대화 맥락에서 카운트
- draft 생성 후 retrospective 호출 여부 확인

Phase 3 완료 시 위 자기감시는 제거되고, hook이 meta.json 상태를 보고 판정한다.
