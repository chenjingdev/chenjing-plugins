# Resume Panel — 자율 오케스트레이션 설계

> 2026-04-03 브레인스토밍 결과. resume-panel 스킬의 에이전트 자동 트리거 + 긴급도 기반 라우팅 설계.

## 1. 문제

현재 resume-panel 스킬은 12개 에이전트가 정의되어 있지만, 모든 에이전트 호출이 **유저 또는 오케스트레이터의 명시적 판단**에 의존한다. 모델이 "지금 프로파일러를 돌려야지"를 까먹으면 돌아가지 않는다.

**목표**: 메인 오케스트레이터는 유저와 인터뷰에 집중하고, 뒷단에서 에이전트들이 자율적으로 조사/분석/피드백하는 구조.

## 2. 아키텍처

```
┌─────────────────────────────────────┐
│           유저 대화 레이어            │
│  오케스트레이터(메인) ↔ 유저          │
│  - 인터뷰 진행                      │
│  - 에이전트 질문 중계               │
│  - 긴급 피드백 끼워넣기              │
└──────────┬──────────────────────────┘
           │ resume-source.json 저장 (Write/Bash)
           ▼
┌─────────────────────────────────────┐
│      Hook 레이어 (Node.js)          │
│  episode-watcher.mjs                │
│  - 역할 1: delta 감지 → 프로파일러   │
│    호출 여부 판단                    │
│  - 역할 2: findings 읽기 → 긴급도별  │
│    systemMessage 라우팅              │
└──────────┬──────────────────────────┘
           │ systemMessage
           ▼
┌─────────────────────────────────────┐
│      감시 레이어 (프로파일러)         │
│  - 전체 상태 분석 (LLM 기반)         │
│  - 긴급도 판단                      │
│  - 전문 에이전트 디스패치             │
│  - 결과를 findings 파일에 쓰기       │
└──────────┬──────────────────────────┘
           │ 디스패치 (Agent tool)
           ▼
┌─────────────────────────────────────┐
│      전문 에이전트 레이어             │
│                                     │
│  [발굴] 시니어개발자 / CTO / HR      │
│  [평가] 채용담당자                   │
│  [조사] 리서처 / 프로젝트리서처       │
│  [발견] 커피챗봇                     │
└─────────────────────────────────────┘
```

### 기존 resume-panel 대비 변경점

| 항목 | 기존 (라운드 기반) | 신규 (상태 기반) |
|------|-------------------|-----------------|
| 에이전트 선택 | 라운드별 고정 배정 | 프로파일러가 현재 갭/상태에 따라 동적 결정 |
| 트리거 | 모델이 라운드 전환을 판단 | hook이 상태 변화를 감지하여 외부 트리거 |
| 리뷰 타이밍 | 라운드 2에서 1회 | 유의미한 변화마다 자동 |
| 결과 전달 | 즉시 전부 전달 | 긴급도별 타이밍 분리 |

## 3. Hook 레이어: episode-watcher.mjs

### 위치

```
resume/
├── .claude-plugin/
│   └── plugin.json
├── .claude/
│   └── agents/
│       └── (12개 에이전트 .md)
├── hooks/
│   └── hooks.json
├── scripts/
│   └── episode-watcher.mjs
└── skills/
    └── resume-panel/
        └── SKILL.md
```

### hooks.json

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node ${CLAUDE_PLUGIN_ROOT}/scripts/episode-watcher.mjs",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

### episode-watcher.mjs 동작

매 Write/Bash 도구 호출 후 실행된다. 2가지 역할을 순차 수행:

#### 역할 1: delta 감지 → 프로파일러 호출 판단

1. stdin으로 hook 입력 JSON 수신 (tool_name, tool_input 등)
2. resume-source.json 변경인지 확인 (파일 경로 매칭)
3. 변경이면 `.resume-panel/snapshot.json` (이전 스냅샷)과 diff
4. 아래 임계치 중 하나라도 충족하면 프로파일러 호출 지시

| 임계치 | 설명 |
|--------|------|
| 에피소드 +3개 | 이전 스냅샷 대비 에피소드 3개 이상 추가 |
| 새 프로젝트 등장 | companies/projects에 새 항목 |
| meta 변경 | 타겟 회사/포지션 변경 |
| 마지막 프로파일러 호출 이후 에피소드 +5개 | 절대 쿨다운 |

5. 충족 시 현재 스냅샷을 `.resume-panel/snapshot.json`에 저장
6. stdout으로 systemMessage 반환:

```json
{
  "continue": true,
  "systemMessage": "[resume-panel] 프로파일러 호출 필요. delta: 에피소드 +3 (proj-5). 현재 총 에피소드 15개, 빈 STAR 4개, 프로젝트 8개."
}
```

#### 역할 2: findings 라우팅

0. **self-trigger 방지**: stdin의 tool_input 경로가 `.resume-panel/` 내부이면 즉시 exit (프로파일러의 파일 쓰기가 hook을 재트리거하는 것을 방지)
1. `.resume-panel/findings-inbox.jsonl` 존재 확인
2. 있으면 `fs.renameSync`로 원자적으로 가져오기 (→ `findings-inbox.processing.jsonl`)
3. processing 파일의 각 라인(JSON)을 파싱하여 `findings.json`에 병합
4. urgency별 처리:

| urgency | 처리 |
|---------|------|
| HIGH | 즉시 systemMessage에 포함 |
| MEDIUM | `.resume-panel/snapshot.json`의 현재 프로젝트와 이전 프로젝트가 다르면 (전환 감지) systemMessage에 포함. 아니면 skip |
| LOW | skip (메인이 필요 시 직접 읽음) |

5. 전달한 항목은 findings.json에 `delivered: true`로 저장. processing 파일 삭제

> **경쟁 조건 방지**: 프로파일러는 `findings-inbox.jsonl`에 append만 한다. hook은 renameSync로 원자적으로 inbox를 가져와 처리한다. 두 프로세스가 같은 파일을 동시에 read-modify-write하는 상황이 발생하지 않는다.

#### 출력 예시

```json
{
  "continue": true,
  "systemMessage": "[resume-panel] 프로파일러 호출 필요. delta: 에피소드 +3.\n\n[resume-panel:HIGH] WebSocket 실시간 경험 완전 공백. AX 팀 핵심 갭. 채용담당자 에이전트가 지적함.\n\n[resume-panel:MEDIUM] ep-8 Result 수치 부족. 프로젝트 전환 감지됨."
}
```

### 상태 파일 구조

```
.resume-panel/
├── snapshot.json              ← resume-source.json의 마지막 분석 시점 스냅샷
├── findings.json              ← 전달 완료된 항목 포함 전체 findings
├── findings-inbox.jsonl       ← 프로파일러가 append하는 inbox (1라인 = 1 finding)
└── meta.json                  ← 쿨다운 타이머, 마지막 호출 시각 등
```

#### findings.json 스키마

```json
{
  "findings": [
    {
      "id": "f-001",
      "urgency": "HIGH",
      "source": "recruiter",
      "type": "gap_detected",
      "message": "WebSocket 실시간 경험 완전 공백. AX 팀 핵심 갭.",
      "context": {
        "related_episodes": [],
        "target_requirement": "실시간 데이터 처리"
      },
      "delivered": false,
      "created_at": "2026-04-03T15:30:00Z"
    }
  ]
}
```

#### meta.json 스키마

```json
{
  "last_profiler_call": "2026-04-03T15:25:00Z",
  "last_profiler_episode_count": 12,
  "current_company": "튜닙",
  "total_profiler_calls": 3
}
```

## 4. 감시 레이어: 프로파일러

### 호출 방식

오케스트레이터가 systemMessage를 받으면 프로파일러를 **백그라운드 Agent**로 호출:

```
Agent(
  subagent_type: "profiler"  (또는 프로파일러 에이전트 .md 참조)
  run_in_background: true
  prompt: "[delta 정보] + [현재 resume-source.json 요약] + [타겟 JD]"
)
```

### 프로파일러가 하는 일

1. resume-source.json 전체 읽기
2. 타겟 JD 대비 상태 분석:
   - 카테고리 커버리지 (AI/문제해결/리더십/협업 등)
   - STAR 완성도
   - 프레이밍 이슈
3. 필요한 전문 에이전트 디스패치 (Agent tool):
   - 갭 발견 → 채용담당자
   - 기술 깊이 부족 → 시니어개발자/CTO
   - 소프트스킬 부족 → HR
   - 회사 정보 필요 → 리서처
4. 전문 에이전트 결과를 종합하여 `.resume-panel/findings-inbox.jsonl`에 **append** (1라인 = 1 finding JSON). findings.json을 직접 수정하지 않는다.
5. `.resume-panel/meta.json` 갱신

### 긴급도 판단 기준

| urgency | 기준 |
|---------|------|
| HIGH | 타겟 JD 핵심 요구사항과 직결되는 갭 / 치명적 프레이밍 오류 / "이력서에서 빼야 할 것" |
| MEDIUM | 특정 카테고리 에피소드 부족 / STAR 수치 보강 필요 / 에피소드 등급 C |
| LOW | 사소한 표현 개선 / 추가하면 좋을 키워드 / 선택적 보강 |

## 5. 오케스트레이터 동작 변경

SKILL.md에 추가할 지시:

### systemMessage 처리 규칙

```
[resume-panel] 태그가 포함된 systemMessage를 받으면:

1. "프로파일러 호출 필요" → 프로파일러를 백그라운드 Agent로 즉시 호출
2. "[resume-panel:HIGH]" → 현재 질문 후 바로 유저에게 전달
   - "아 그리고 방금 분석 결과가 나왔는데 — {내용}"
   - 인터뷰 흐름을 크게 끊지 않는 선에서 자연스럽게 끼워넣기
3. "[resume-panel:MEDIUM]" → 현재 프로젝트/회사 에피소드 수집이 끝나면 전달
   - "여기까지 정리하면서 리뷰 결과도 같이 볼게 — {내용}"
4. LOW는 systemMessage로 안 옴. 유저가 "분석해줘", "리뷰해줘" 요청 시
   .resume-panel/findings.json을 Read해서 전달
```

### 인터뷰 흐름 보호

- HIGH 피드백이 와도 **현재 진행 중인 질문-답변 사이클은 완료**한 후 끼워넣기
- MEDIUM/LOW 피드백 때문에 인터뷰를 중단하지 않음
- 피드백 전달 후 바로 다음 인터뷰 질문으로 복귀

## 6. 전체 흐름 예시

```
유저: "튜닙에서 SSE 스트리밍 채팅 만들었어"
  ↓
오케스트레이터: 에피소드 추출 → resume-source.json 저장 (Bash)
  ↓
[PostToolUse hook 발동]
episode-watcher.mjs:
  - delta: 에피소드 +1 (아직 임계치 미달)
  - findings.json: delivered=false인 HIGH 항목 없음
  → skip (systemMessage 없음)
  ↓
오케스트레이터: "SSE 말고 유저 향 채팅 UI도 만들었어? 타이핑 인디케이터, 무한스크롤 같은 거"
유저: "응 다 했지"
  ↓
오케스트레이터: 에피소드 보강 → resume-source.json 저장 (Bash)
  ↓
[PostToolUse hook 발동]
episode-watcher.mjs:
  - delta: 에피소드 +3 (임계치 충족!)
  - findings.json: 없음
  → systemMessage: "[resume-panel] 프로파일러 호출 필요. delta: 에피소드 +3."
  ↓
오케스트레이터: 프로파일러 백그라운드 호출
  ↓ (동시에 인터뷰 계속)
오케스트레이터: "디어메이트 유저 수가 대략 어느 정도였어?"
  ↓
[프로파일러 백그라운드 완료]
프로파일러: 채용담당자 디스패치 → 갭 분석 → findings.json에 쓰기:
  { urgency: "HIGH", message: "사용자향 AI 제품 경험이 추가됐지만 WebSocket 경험은 여전히 공백" }
  ↓
[다음 PostToolUse hook 발동 (유저 답변 저장 시)]
episode-watcher.mjs:
  - findings.json에 HIGH 항목 발견
  → systemMessage: "[resume-panel:HIGH] 사용자향 AI 제품 경험 추가됨. 하지만 WebSocket 실시간 경험은 여전히 공백. 코인원 거래소 핵심 갭."
  ↓
오케스트레이터: 유저 답변 처리 후 →
  "MAU 1,000명이구나. 알겠어, 저장해둘게.
   아 그리고 방금 분석 결과 — WebSocket 실시간 경험이 아직 빈 상태야.
   혹시 듀얼넷에서 실시간 통신 처리한 적 있어?"
```

## 7. 구현 우선순위

| 순서 | 항목 | 난이도 |
|------|------|--------|
| 1 | episode-watcher.mjs (역할 1: delta 감지) | 중 |
| 2 | hooks/hooks.json 설정 | 하 |
| 3 | SKILL.md에 systemMessage 처리 규칙 추가 | 하 |
| 4 | .resume-panel/ 상태 파일 초기화 로직 | 하 |
| 5 | episode-watcher.mjs (역할 2: findings 라우팅) | 중 |
| 6 | 프로파일러 에이전트 .md 수정 (findings.json 쓰기 지시 추가) | 중 |
| 7 | 전문 에이전트 .md들에 산출물 형식 표준화 | 중 |
| 8 | 쿨다운/임계치 튜닝 | 실사용 후 조정 |
