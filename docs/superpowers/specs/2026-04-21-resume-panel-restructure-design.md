# Resume Panel 구조 재설계 — Design Spec

**작성일**: 2026-04-21
**상태**: Draft (브레인스토밍 합의 완료 → 이행 계획 작성 대기)
**근거**: [`docs/retrospectives/20260420-073517.md`](../../retrospectives/20260420-073517.md) 및 [`...-improvements.md`](../../retrospectives/20260420-073517-improvements.md)

## 1. 문제 정의

2026-04-20 세션 회고에서 드러난 구조적 문제:

1. **SKILL.md 비대 (1094줄)**: `references/`가 이미 있는데 동일 내용이 SKILL.md에도 중복 존재. hook 메시지 처리 섹션 216줄이 `references/hook-messages.md` 252줄과 거의 동일. 동기화 실패 시점 문제.
2. **에이전트 프롬프트 boilerplate 60%**: senior/c-level/recruiter/hr/coffee-chat 5개가 "리서처 팩트 인용 / 선택지 4개 / 한 턴 1-3개 배치 / 대화 브리핑 / 열린 질문 금지" 규칙을 각자 복사. 규칙 하나 바꾸면 5곳 수정.
3. **오케스트레이터가 인터뷰어를 겸직**: SKILL.md가 오케스트레이터에게 AskUserQuestion을 자유롭게 쓸 권한을 광범위하게 부여. 결과적으로 sub-agent 호출 없이 오케스트레이터가 직접 13개 질문을 생성한 케이스 발생(2026-04-20).
4. **Hook 프로토콜이 자연어 키워드 파싱**: hook이 `[resume-panel:MEDIUM] 공백: ... 8개월` 같은 자연어를 보내고 오케스트레이터는 "공백+개월" / "패턴 발견" / "관점 전환" / "모순 발견" 같은 한국어 키워드로 분기. JSON 구조로 전환 가능.
5. **하드 게이트를 LLM 자기감시로 시행**: Round 1/2 게이트, 3회 연속 직접 질문 금지 등을 오케스트레이터가 스스로 감시. LLM 자기감시는 느슨하고, 회고가 지적한 실패의 원인이 정확히 이것.
6. **세션 카운터 분산**: `gap_probes_this_session`, `perspective_shifts_this_session`, `contradictions_presented_this_session`, `total_profiler_calls`, `reprobe_log` 등이 meta.json에 개별 필드로 흩어짐.

**재발 위험**: 각 회고 때마다 새 규칙을 SKILL.md / 에이전트 .md에 덧붙이는 패턴. 1년 동안 축적되어 1094줄이 됐고, 이대로 가면 2년 뒤 2000줄.

## 2. 설계 원칙

- **단일 출처**: 모든 규칙은 한 파일에만 존재. SKILL.md ↔ references 중복 금지.
- **역할 분리**: 오케스트레이터는 라우터, 에이전트는 인터뷰어, hook은 감시자. 겸직 금지.
- **Deterministic 가드레일**: 카운팅/게이트는 hook이 감시. LLM에게 자기감시 요구 금지.
- **구조화 프로토콜**: 에이전트↔오케스트레이터, hook↔오케스트레이터 모두 JSON. 자연어 파싱 금지.
- **화이트리스트**: 오케스트레이터가 AskUserQuestion을 직접 쓸 수 있는 경우를 명시적으로 나열. 그 외 모두 에이전트 경유.

## 3. 타겟 파일 레이아웃

```
plugins/resume/
├── skills/resume-panel/
│   ├── SKILL.md                      # ~250줄 (현재 1094줄)
│   └── references/
│       ├── agent-contract.md         # 신설 — 에이전트 공통 규칙
│       ├── askuserquestion.md        # 축소 — JSON → AskUserQuestion 변환
│       ├── hook-protocol.md          # rename (hook-messages.md) — JSON 타입 정의
│       ├── storage.md                # 유지
│       └── gates.md                  # 신설 — hook 게이트 명세
├── .claude/agents/
│   ├── senior.md                     # ~30줄 (현재 136줄)
│   ├── c-level.md                    # ~30줄 (현재 225줄)
│   ├── recruiter.md                  # ~30줄 (현재 122줄)
│   ├── hr.md                         # ~30줄 (현재 189줄)
│   ├── coffee-chat.md                # ~30줄 (현재 34줄, 유지)
│   ├── researcher.md                 # 유지
│   ├── project-researcher.md         # 유지
│   ├── profiler.md                   # 유지 (본질이 다름)
│   └── retrospective.md              # ~50줄 (현재 107줄)
├── hooks/hooks.json                  # matcher 확장
└── scripts/
    └── episode-watcher.mjs           # ~600줄 (현재 422줄)
```

## 4. SKILL.md 재구성

### 4.1 유지되는 섹션

- 호출 모드 (기본/추가탐색/자소서만/갭 재분석/모순 체크/리라이트)
- 핵심 원칙 (1~8번)
- 에이전트 구성 (백스테이지/프론트스테이지 표)
- 라운드 진행 (0/1/2/3)
- 포맷 템플릿 (자유양식/잡코리아형)

### 4.2 삭제되는 섹션 (→ references로 이동)

- "AskUserQuestion 변환 규칙" → `references/askuserquestion.md`
- "자율 오케스트레이션 — Hook 메시지 처리" (섹션 9개) → `references/hook-protocol.md`
- "resume-source.json 스키마 / 저장 방법" → `references/storage.md` (기존 유지)
- "에이전트 선택 기준" 상세 → `references/agent-contract.md` 참조

### 4.3 신설 섹션 — Orchestrator Direct AskUserQuestion 허용 목록

```markdown
## 오케스트레이터 직접 질문 허용 범위 (화이트리스트)

인터뷰 질문은 모두 에이전트가 생성한다. 오케스트레이터가 AskUserQuestion을 **직접 호출할 수 있는 경우**는 아래만:

1. Round 0 세팅:
   - 이어하기 / 새로 시작
   - 이력서 diff 확인
   - 기본 정보 확인 (이름/나이/경력/회사)
   - 직군 확인
2. Round 3 산출:
   - 출력 포맷 선택 (자유양식/잡코리아형/둘 다)
   - 자소서 항목 확인
3. Hook finding 메타질문:
   - HIGH finding — 관련 경험 있음 / 진짜 없음 / 넘어가기
   - MEDIUM finding — 더 자세히 / 다음으로
4. AskUserQuestion 폴백 모드 (재시도 실패 시 평문)

위 4가지 외 **모든 인터뷰 질문은 에이전트 경유**. 오케스트레이터가 직접 질문을 만들지 않는다.
```

이 화이트리스트가 현재 누적된 A1(Entry Gate) / 원칙 9(3회 연속 금지) / B1(서사형 평문) 규칙을 대체한다. 규칙의 양이 줄어드는 핵심.

## 5. Agent Contract (신설 `references/agent-contract.md`)

5개 인터뷰 에이전트(senior/c-level/recruiter/hr/coffee-chat)가 공통 준수하는 규칙을 한 파일로 통합.

### 5.1 내용 구성

```markdown
# Agent Contract — 인터뷰 에이전트 공통 규칙

모든 인터뷰 에이전트(시니어/C-Level/채용담당자/인사담당자/커피챗)는 첫 호출 시 이 파일을 Read하고 아래 규칙을 따른다.

## 1. 입력 구조
- 유저 프로파일 / 리서처 조사 / 에피소드 목록 / 타겟 JD / 대화 브리핑

## 2. 출력 포맷 (JSON 필수)
{ "questions": [{ "header", "question", "options": [...], "free_form": boolean }] }

- `questions` 배열 길이: 1~3 (배치)
- `options`: 최대 3개 (label 1-5단어 + description 원문)
- `free_form: true`면 options 생략 → 오케스트레이터가 평문 전달
- 분기형 질문(답이 다음 질문 전제)은 배치 금지

## 3. 반드시 지킬 것
- 리서처 팩트 1개 이상 직접 인용 (회사명/MAU/기술스택/기능명)
- 대화 브리핑의 '이미 다룬 영역' 재질문 금지
- 직접 답을 묻지 말고 구체적 행동을 묻기

## 4. 절대 하지 말 것
- 열린 질문 / 칭찬 감탄
- 조사 결과 없는 추상 질문
- **서사형 질문에 선택지 달기** — 계기/전환/공백서술/주관적동기는 free_form: true로
- **단독판단 유형인데 드라마틱 단일 사건만 선택지화** — "반복 일상 패턴" 옵션 1개 필수

## 5. 에이전트 모드

### 5.1 기본 모드 (질문 생성)
### 5.2 갭 프로빙 모드 (오케스트레이터가 갭 컨텍스트 전달 시)
### 5.3 관점 전환 모드
### 5.4 So What 체인 모드 (C-Level 전용)
### 5.5 과소평가 재프로빙 모드 (a) 경험 여부 / (b) 유형 선택

각 모드의 입력 / 선택지 제약 / 산출 JSON 예시.

## 6. JSON 출력 예시
```

### 5.2 각 에이전트 .md 축소 형태

```markdown
---
description: 도메인 깊이 발굴 전용 인터뷰어.
model: claude-sonnet
tools: Read
---

# 시니어

너는 유저 직군의 10년차 이상 시니어다.

**첫 호출 시 `skills/resume-panel/references/agent-contract.md`를 Read하고 모든 규칙을 준수한다.**

## 페르소나
옆자리 동료한테 묻듯이. 해당 직군 용어는 설명 없이 바로 씀.

## 도메인 특화 예시

### 도메인 깊이 발굴
{개발자/디자이너/마케터 3 예시}

### 스케일 파악
{예시}

### 문제 해결 발굴
{예시}

### 단독판단 유형 (반복 일상 패턴 규칙 적용)
{예시 — contract 섹션 4 참조}
```

## 6. Agent JSON 출력 프로토콜

### 6.1 에이전트 산출 형식

```json
{
  "questions": [
    {
      "header": "시니어",
      "question": "Kafka 도입한 거 봤는데, 이거 직접 밀었어 아니면 이미 있던 거야?",
      "options": [
        { "label": "제안 도입", "description": "내가 제안해서 도입" },
        { "label": "기존 활용", "description": "기존에 있었고 활용만" },
        { "label": "마이그레이션", "description": "마이그레이션 작업" }
      ],
      "free_form": false
    }
  ]
}
```

- 서사형/평문 질문: `{"header":..., "question":..., "free_form": true}` (options 없음)
- 배치: `questions` 배열에 여러 객체 (최대 3개, 분기형은 1개만)

### 6.2 오케스트레이터 처리

```
1. Agent 리턴을 JSON.parse
2. questions 배열 순회:
   - free_form: true → 평문 출력 (AskUserQuestion 생략)
   - free_form: false → AskUserQuestion question 변환
3. 배치 가능하면 한 번에 AskUserQuestion 호출
4. 유저 답변 → 에이전트 답변으로 기록 → 에피소드 추출
```

정규식 파싱(`[시니어] N)` 패턴) 제거.

### 6.3 폴백

에이전트가 JSON 파싱 실패 시:
1. 오케스트레이터가 "다시 생성해달라" 재호출 (1회)
2. 재실패 시 기존 레거시 텍스트 포맷(`[시니어] ... N) ...`)으로 폴백 + 회고에 기록

## 7. Hook 메시지 JSON 프로토콜

### 7.1 현재 (자연어)

```
[resume-panel:MEDIUM] 2018.09 ~ 2019.05 (8개월) 공백: ...
[resume-panel:MEDIUM] 패턴 발견: '도구 개발 반복' — ...
```

### 7.2 변경 후 (JSON)

```
[resume-panel]{"type":"profiler_trigger","delta":"에피소드 +3","score":6}
[resume-panel]{"type":"finding","urgency":"HIGH","finding_type":"contradiction_detected","id":"cd-123","message":"...","context":{...}}
[resume-panel]{"type":"finding","urgency":"MEDIUM","finding_type":"timeline_gap_found","id":"tg-456","context":{...}}
[resume-panel]{"type":"so_what","episode_title":"...","level":1}
[resume-panel]{"type":"gate_violation","gate":"r1_entry","company":"KB국민카드"}
```

### 7.3 오케스트레이터 분기

```javascript
// pseudo
const payload = JSON.parse(message.slice("[resume-panel]".length));
switch (payload.type) {
  case "profiler_trigger": invokeProfilerBackground(payload); break;
  case "finding": handleFinding(payload); break;
  case "so_what": startSoWhatChain(payload); break;
  case "gate_violation": handleGateViolation(payload); break;
}
```

- `finding_type` 기반 추가 분기 (contradiction_detected / timeline_gap_found / pattern_detected / perspective_shift / gap_detected / impact_shallow)
- 한국어 키워드 파싱 ("공백+개월", "패턴 발견", "모순 발견") **완전 제거**

## 8. Hook 게이트 감시

### 8.1 hooks.json matcher 확장

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Bash|Edit|Task|AskUserQuestion",
        "hooks": [{ "type": "command", "command": "node ...", "timeout": 10 }]
      }
    ]
  }
}
```

`Task` 와 `AskUserQuestion`을 추가하여 에이전트 호출 / 유저 질문을 hook이 관찰.

### 8.2 게이트 상태는 meta.json에 통합

별도 `gate-state.json`을 만들지 않고 meta.json에 `gate_state` 필드로 포함 — `current_round` / `current_company` 중복을 피함.

```json
{
  ...세션 필드들...,
  "gate_state": {
    "direct_askuserquestion_streak": 0,
    "agent_calls_in_current_round": { "senior": 0, "c-level": 0, "recruiter": 0, "hr": 0, "coffee-chat": 0 },
    "round_turn_counts": { "0": 45, "1": 38, "2": 12, "3": 0 },
    "retrospective_invoked": false,
    "last_askuserquestion_source": null
  }
}
```

hook은 meta.json을 읽어 게이트 판정. 오케스트레이터도 같은 파일을 읽어 상태 확인.

### 8.3 감시 로직

| 게이트 | 트리거 | 조건 | 발행 메시지 |
|---|---|---|---|
| R1 Entry | `current_round == 1` 상태의 첫 AskUserQuestion | 해당 회사에 senior+c-level 호출 합계 = 0 | `{type: gate_violation, gate: r1_entry, company}` |
| 직접 질문 폭주 | AskUserQuestion 호출 | 화이트리스트 외 + Agent 호출 없이 3회 연속 | `{type: gate_violation, gate: direct_question_burst, count}` |
| R2 Exit | Round 2 → 3 전환 시도 (오케스트레이터가 round 필드를 "3"으로 쓸 때) | recruiter=0 OR hr=0 OR turn<15 OR gap_analysis 미설정 | `{type: gate_violation, gate: r2_exit, missing}` |
| Retrospective skipped | `resume-draft.md` Write 발생 | retrospective_invoked=false + Step 9 에이전트 호출 없음 | `{type: gate_violation, gate: retrospective_skipped}` |

화이트리스트 식별: 오케스트레이터가 AskUserQuestion 호출 **직전**에 meta.json의 `gate_state.last_askuserquestion_source`를 업데이트 — `{source: "whitelist", case: "round0_basic_info"}` 또는 `{source: "agent", agent_name: "senior"}`. hook은 이 필드를 읽어 판정 후 null로 리셋.

안전 기본값: 필드가 null이거나 없으면 hook은 "orchestrator_direct"로 판정 → 게이트 감시 대상. 명시적 선언 누락 = 위반으로 간주.

### 8.4 위반 처리

오케스트레이터는 `gate_violation` 메시지를 수신하면:
1. 위반 내용을 유저에게 평문으로 고지 ("⚠️ Round 1 Entry Gate 미충족 — senior 에이전트 호출로 복귀")
2. 해당 에이전트 Agent 호출로 복귀
3. 게이트 감시 상태는 hook이 관리, 오케스트레이터는 상태 갱신 안 함

## 9. 세션 카운터 통합

### 9.1 현재 meta.json (분산)

```json
{
  "gap_probes_this_session": 0,
  "perspective_shifts_this_session": 0,
  "perspective_shifted_episodes": [],
  "contradictions_presented_this_session": 0,
  "reprobe_log": [],
  "daily_routine_explored_companies": [],
  "total_profiler_calls": 0,
  "intentional_gaps": [],
  ...
}
```

### 9.2 통합 meta.json

```json
{
  "session_started_at": "...",
  "current_round": 0,
  "current_company": null,
  "session_limits": {
    "gaps":          { "used": 0, "max": 3, "intentional": [] },
    "perspectives":  { "used": 0, "max": 2, "episode_refs": [] },
    "contradictions":{ "used": 0, "max": 2 },
    "reprobes":      { "used": 0, "log": [] }
  },
  "daily_routine_explored_companies": [],
  "profiler": { "total_calls": 0, "last_call_at": null, "last_episode_count": 0, "score": 0 },
  "so_what_active": null,
  "response_speed": { "recent_avg_seconds": null, "samples": [] }
}
```

### 9.3 체크 패턴 통일

```javascript
// pseudo
if (meta.session_limits[type].used >= meta.session_limits[type].max) {
  // silently skip
}
```

`contradictions_presented_this_session`, `perspective_shifts_this_session` 등 개별 체크 코드 삭제.

## 10. 회고 에이전트 축소

### 10.1 현재

`retrospective.md` (107줄) — 5개 분석 항목 각각에 집계/경고 로직 기술. LLM이 대화 이력에서 집계.

### 10.2 변경 후

- hook이 세션 내내 `session-stats.json`에 집계:
  ```json
  {
    "agent_invocations": { "senior": 3, "c-level": 2, "recruiter": 0, "hr": 0, "coffee-chat": 1, "researcher": 2 },
    "askuserquestion_direct_count": 4,
    "askuserquestion_agent_count": 25,
    "other_count_by_agent": { "senior": 1, ... },
    "gate_violations": [ { "gate": "r1_entry", "company": "...", "at": "..." } ],
    "round_turn_counts": { "0": 45, "1": 38, "2": 12, "3": 18 }
  }
  ```
- retrospective 에이전트는 session-stats.json을 Read하여 서술형 회고로 변환만. 집계 로직 제거.
- retrospective.md 107줄 → ~50줄.

## 11. 이행 Phase

### Phase 1 — 구조 정리 (무중단 리팩터)

단일 PR. 기존 동작 유지.

1. `references/agent-contract.md` 작성 (공통 규칙 추출)
2. `references/gates.md` 작성 (현재 게이트 스펙 기록, Phase 3에서 hook으로 이동)
3. SKILL.md 중복 섹션 삭제 → references로 위임
4. 5개 에이전트 .md 축소 (contract 참조)
5. 4.3 화이트리스트 섹션 추가
6. 테스트: 기존 세션 시나리오 수동 재생 (샘플 `resume-source.json` 로드하여 R0~R3 진행해 보기)

### Phase 2 — JSON 프로토콜 전환 (big bang, 이전 호환 깨짐)

7. `references/agent-contract.md`에 JSON 산출 포맷 정의
8. 5개 에이전트 .md의 "산출 형식" 섹션을 JSON으로 교체
9. SKILL.md "AskUserQuestion 변환 규칙" 재작성 (정규식 → JSON.parse)
10. `references/hook-protocol.md` — 메시지 JSON 타입 정의
11. episode-watcher.mjs: `additionalContext` 문자열을 JSON prefix로 변경 (7개 메시지 타입)
12. 테스트: 에이전트 JSON 리턴 파싱 성공률, 폴백 작동

### Phase 3 — Hook 게이트 감시 (가장 위험)

13. hooks.json matcher에 `Task|AskUserQuestion` 추가
14. episode-watcher.mjs: gate-state.json 유지 로직 추가
15. 4개 게이트 감시 로직 추가
16. meta.json 스키마 마이그레이션 (`session_limits` 통합). 기존 세션 파일은 자동 변환 스크립트로 1회 업그레이드
17. SKILL.md의 A1/A2/A3 하드 게이트 자연어 삭제
18. 오케스트레이터가 `gate_violation` 메시지 처리하는 분기 SKILL.md에 추가 (간결)
19. 테스트: 각 게이트 위반 시나리오 수동 재생

### Phase 4 — 회고 연동

20. episode-watcher.mjs: session-stats.json 집계 로직 추가
21. retrospective.md 축소 (session-stats.json Read 기반)
22. 샘플 세션으로 회고 생성 비교

각 Phase는 단일 커밋/PR 단위. Phase 2~3이 프로토콜과 state 스키마를 같이 건드려 서로 의존하므로 가까운 시점에 연달아 진행 권장.

## 12. 영향 / 리스크

### 12.1 코드 변화

- **삭제**: SKILL.md ~600줄 + 에이전트 .md ~500줄 = ~1100줄
- **추가**: agent-contract.md ~150줄 + hook 게이트 ~200줄 + hook JSON ~50줄 = ~400줄
- **순 감소**: ~700줄

### 12.2 리스크

1. **JSON 파싱 실패율**: 에이전트가 안정적으로 JSON을 리턴하는가? — Phase 2 폴백(레거시 텍스트) 유지로 완화. 실제 운영에서 3% 이상 실패 시 Phase 2 롤백 고려.
2. **Hook 게이트 오탐**: `AskUserQuestion`/`Task` matcher 확장 시 hook 호출 빈도 2배 이상. 10초 타임아웃 내 처리 가능한지 확인. 필요 시 stage 분리.
3. **meta.json 마이그레이션**: 기존 사용자의 meta.json이 새 스키마로 자동 변환되어야. episode-watcher.mjs에 "old schema 감지 → 업그레이드 → 저장" 로직 포함.
4. **에이전트 중복 Read**: 매 호출마다 agent-contract.md를 Read하면 토큰 비용 증가. 에이전트 캐시에 의존하거나, SKILL.md가 호출 시 contract 요약을 프롬프트에 인라인 삽입하는 방식 고려.
5. **화이트리스트 식별 메커니즘**: 오케스트레이터가 meta.json `gate_state.last_askuserquestion_source` 업데이트를 잊으면 hook이 "orchestrator_direct"로 안전 판정 — fail-loud. 첫 세션들에서 false-positive 발생하면 PhaseN 회고에서 조정.

### 12.3 기존 세션 호환

- `resume-source.json` 스키마 변경 없음 — 기존 파일 그대로 유효
- `meta.json`은 Phase 3에서 마이그레이션 — 자동 변환
- `findings.json` 포맷 유지

## 13. 성공 기준

- SKILL.md 400줄 이하
- 에이전트 .md 각 40줄 이하
- 공통 규칙 변경 시 수정 파일 1개
- 회고 "sub-agent 호출 0회" 같은 경고가 hook에서 실시간 감지
- 2026-04-20 회고의 P0/P1/P2 지적이 본 설계로 **구조적으로** 해소됨을 확인

## 14. Non-Goals

- 오케스트레이터 LLM 모델 변경
- resume-source.json 스키마 확장
- 새로운 라운드 추가 (Round 4 등)
- 웹 UI / 외부 도구 통합

## 15. Open Questions

다음 단계(writing-plans)에서 결정:

- Phase 1/2/3/4를 각각 독립 커밋할지, Phase 2+3을 한 커밋으로 묶을지
- 에이전트의 contract Read 캐시 전략
- 화이트리스트 식별 메커니즘의 최종 설계 (파일 기반 vs 프롬프트 메타)
