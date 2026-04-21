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
