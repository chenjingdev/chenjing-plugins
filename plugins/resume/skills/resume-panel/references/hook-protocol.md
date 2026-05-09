# Hook Protocol — additionalContext JSON 메시지

`episode-watcher.mjs`가 PostToolUse hook에서 `additionalContext`로 보내는 메시지는 **단일 라인 JSON**이고 `[resume-panel]` 프리픽스가 붙는다. 오케스트레이터는 프리픽스를 떼고 `JSON.parse` 후 `type` 필드로 분기.

## 메시지 구조

```
[resume-panel]{"type":"...", ...payload}
```

복수 메시지는 줄바꿈 2개로 구분.

## 메시지 타입

### 1. `profiler_trigger`

프로파일러 점수가 임계값을 넘으면 발행.

```json
{
  "type": "profiler_trigger",
  "delta": "에피소드 +3, 새 프로젝트",
  "score": 6,
  "episode_count": 12,
  "star_gaps": 2,
  "project_count": 4,
  "pattern_eligible": true
}
```

**처리**: 프로파일러를 백그라운드 Agent로 호출. `pattern_eligible: true`면 프롬프트에 "패턴 분석 가능" 포함. 인터뷰는 계속.

### 2. `finding`

프로파일러/리서처 등이 발견한 finding.

```json
{
  "type": "finding",
  "urgency": "HIGH|MEDIUM|LOW",
  "finding_type": "contradiction_detected|timeline_gap_found|pattern_detected|perspective_shift|gap_detected|impact_shallow",
  "id": "cd-abc123",
  "message": "역할 모순 발견: ...",
  "context": { }
}
```

**처리 분기 (finding_type)**:

- `contradiction_detected` (HIGH): 모순 복원 — 오케스트레이터가 AskUserQuestion으로 직접 복원 질문 (화이트리스트 case 3)
- `timeline_gap_found` (MEDIUM): hr 에이전트 갭 프로빙 모드 호출
- `pattern_detected` (MEDIUM): 패턴을 다음 에이전트 브리핑의 "발견된 패턴" 섹션에 포함 (즉시 질문 안 함). `context.target_agent`가 있으면 그 에이전트 우선.

  **발행 주체**: profiler agent — `plugins/resume/.claude/agents/profiler.md` §2 "크로스 컴퍼니 패턴 분석" 결과를 `findings-inbox.jsonl`에 append (Bash echo 패턴).
  **라우팅 주체**: episode-watcher hook (`scripts/episode-watcher.mjs` finding 라우팅 분기). MEDIUM은 `current_company` 변경 시점에 라우팅.
  **적재 위치**: `.resume-panel/findings.json` (delivered=true 플래그).
  **형식 정의**: profiler.md `pt-{timestamp}` 산출 형식 (이 문서의 §finding 정의와 일치).

- `perspective_shift` (MEDIUM): `context.target_agent`를 관점 전환 모드로 호출
- `gap_detected` (HIGH): 화이트리스트 메타질문 (관련 경험 있음 / 진짜 없음 / 넘어가기)
- `impact_shallow` (LOW): 전달 안 함. 유저가 "분석해줘" 시 Read.

**세션 한도**: 오케스트레이터는 `meta.json.session_limits[finding_type].used >= max`이면 조용히 무시.

### 3. `so_what`

임팩트 부족 에피소드 감지 시.

```json
{
  "type": "so_what",
  "episode_title": "...",
  "level": 1,
  "episode_ref": { "company": "...", "project": "..." }
}
```

**처리**: meta.json `so_what_active` 설정 → C-Level을 So What 체인 모드로 호출 (agent-contract §5.4). multi-turn이므로 체인 완료까지 일반 플로우 중단.

### 4. `gate_violation` (Phase 3부터 활성)

게이트 위반 감지 시.

```json
{
  "type": "gate_violation",
  "gate": "r1_entry|direct_question_burst|r2_exit|retrospective_skipped",
  "company": "...",
  "count": 3,
  "missing": ["hr", "turn_min"]
}
```

**처리**: `gates.md` §G1~G4 각각의 "복귀 액션" 수행.

### 5. LOW finding

hook에서 전달하지 않음. 유저가 "분석해줘/리뷰해줘" 요청 시 `.resume-panel/findings.json`을 Read하여 제시.

### 6. `compaction_warning` (2026-05-09~)

세션 컨텍스트가 250k+ 토큰을 넘었거나 PreCompact 시점에 발행. compact 전후 작업 흐름을 잇는 브릿지 트리거.

```json
{
  "type": "compaction_warning",
  "tokens_estimate": 280000,
  "threshold": 250000,
  "backstop": false,
  "message": "..."
}
```

**필드**:
- `tokens_estimate`: transcript 파일 크기 / 4 추정 토큰 수 (UserPromptSubmit 발행 시).
- `threshold`: 임계치 (현재 250000).
- `backstop`: PreCompact 시점에서 발행된 보조 알림이면 `true`. UserPromptSubmit 임계치 권고는 `false`.
- `message`: Claude에게 전달되는 행동 지시문.

**발행 주체**:
- UserPromptSubmit hook — `tokens_estimate >= 250000` AND `current-focus.md`의 `saved_at`이 5분 이내가 아닌 경우.
- PreCompact hook — `current-focus.md`가 없거나 5분 이상 stale인 경우.

**Claude 처리 의무**:
1. 다음 응답 직전에 `.resume-panel/current-focus.md`를 `references/storage.md` §current-focus.md 스키마대로 저장.
2. 사용자에게 "/compact 권고" 한 줄 안내.
3. 5분 이내 같은 경고가 또 와도 이미 저장된 파일이 있으면 hook 측 de-bounce로 suppress된다 (Claude는 매번 답할 필요 없음).

**재로드**: `/compact` 후 `SessionStart` hook의 `source === "compact"` 분기가 current-focus.md를 자동으로 additionalContext에 주입한다. Claude는 추가 동작 없이 다음 사용자 발화에 이어서 응답.

## 인터뷰 흐름 보호

- HIGH: 현재 질문-답변 사이클 완료 후 끼워넣기
- MEDIUM: 현재 프로젝트/회사 에피소드 수집 끝난 후 끼워넣기
- LOW: 전달 안 함
- SO-WHAT: 체인 완료(거기까지였음 또는 Level 3)까지 일반 플로우 중단
- 동시 도착 시 우선순위: `so_what` > `gate_violation` > `finding(HIGH)` > `finding(MEDIUM)`
- `so_what_active` 동안 추가 `so_what` 메시지 무시

## 세션 한도 참조

`meta.json.session_limits`:
- `gaps.max = 3`
- `perspectives.max = 2`
- `contradictions.max = 2`

초과 시 hook에서는 발행을 억제하지 않지만 오케스트레이터가 무시. (Phase 3 목표: hook에서도 발행 억제)

## 프로파일러 트리거 가중치 모델 (Model B, 2026-05-06~)

`episode-watcher.mjs`의 `addProfilerScore(meta, delta, reason)` 헬퍼가 다음 이벤트에 따라 `meta.profiler_score`에 가산. 임계 `THRESHOLD = 5` 도달 시 `profiler_trigger` 메시지 emit + score 0 리셋.

| 이벤트 | 점수 | 트리거 위치 |
|---|---|---|
| `resume-source.json` 에피소드 +N | +N | storage 분기 (기존) |
| 새 회사/프로젝트 추가 | +3 | storage 분기 (기존) |
| 빈 STAR result 증가 | +2 | storage 분기 (기존) |
| 역할 축소 키워드(도움/참여 등) | +2 | storage 분기 (기존) |
| meta(target_company/position) 변경 | +2 | storage 분기 (기존) |
| AskUserQuestion 호출 | +1 | AUQ 핸들러 (신규) |
| AUQ + 직전 60초 이내 HIGH finding delivered | +2 추가 (총 +3) | AUQ 핸들러, `meta._last_high_finding_at` 비교 (신규) |
| `so_what` 메시지 발행 | +3 | so_what 발행 분기 (신규) |
| `perspective_shift` finding 라우팅 | +3 | finding 라우팅 분기 (신규) |
| `contradiction_detected` finding 라우팅 | +3 | finding 라우팅 분기 (신규) |

`meta._score_reasons` 배열에 가산 사유 누적(rolling 10). 디버깅·회고 보조용.

`meta._last_high_finding_at` — HIGH finding 라우팅 직후 ISO timestamp 갱신. AUQ 핸들러가 60초 이내 여부를 비교해 importance 보너스 결정.

## 모순 복원 (HIGH contradiction_detected) 처리 패턴

오케스트레이터가 화이트리스트 case 3으로 AskUserQuestion 호출:

```javascript
AskUserQuestion({
  questions: [{
    question: "아까 이야기랑 연결해보면, {에피소드A}에서는 {claim_a.text 요약}라고 했는데 {에피소드B}에서는 {claim_b.text 요약}라고 했거든. 실제로는 어디까지 한 거야?",
    header: "연결 확인",
    options: [
      { label: "{큰 역할}", description: "{큰 역할 claim 본문}" },
      { label: "{작은 역할}", description: "{작은 역할 claim 본문}" },
      { label: "상황이 달랐음", description: "두 에피소드 맥락이 달라서 역할이 다른 것" }
    ],
    multiSelect: false
  }]
})
```

응답 처리:
- 큰 역할 선택 → 작은 claim 에피소드의 `claim_b.star_field` 필드를 큰 역할 내용으로 업데이트
- 작은 역할 선택 → 큰 claim 에피소드의 `claim_a.star_field` 필드를 작은 역할 내용으로 업데이트
- "상황이 달랐음" 선택 → 업데이트 없음

업데이트 방법은 `references/storage.md` §부분 업데이트 참조. `session_limits.contradictions.used++`.

## 갭 프로빙 (MEDIUM timeline_gap_found) 처리 패턴

1. `meta.json.intentional_gaps`에 이미 있으면 무시
2. hr 에이전트를 갭 프로빙 모드로 호출 (agent-contract §5.2)
3. 응답 처리:
   - 건너뛰기 → `intentional_gaps` 배열에 `{from, to, marked_at}` append
   - 실질 답변 → 에피소드 추출 저장 + hr 일반 모드 후속 1-2회

`session_limits.gaps.used++`.

## 관점 전환 (MEDIUM perspective_shift) 처리 패턴

1. `session_limits.perspectives.episode_refs`에 이미 있으면 무시
2. `context.target_agent`를 관점 전환 모드로 호출 (agent-contract §5.3)
3. 응답 처리:
   - 겸손 옵션 선택 → `episode_refs`에 `episode_ref` 추가
   - 업그레이드 옵션 → 일반 모드로 후속 1회 가능 + `episode_refs` 추가

`session_limits.perspectives.used++`.
