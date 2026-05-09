# Mid-Session Compaction Bridge — Design Spec

> **상태**: Draft (2026-05-09)
> **대상**: `plugins/resume` — 인터뷰 세션 중 컨텍스트가 250k+ 토큰을 넘어 `/compact`가 필요해질 때, compact를 가로질러 작업 흐름을 끊김 없이 이어가기 위한 브릿지 메커니즘.

---

## 1. 문제

인터뷰 세션이 길어지면 단일 conversation의 컨텍스트가 250k+ 토큰까지 부풀어 응답 품질이 떨어지고 비용이 증가한다. Claude Code는 `/compact`로 conversation을 요약·압축하지만, 압축 과정에서 다음이 손실된다:

- 직전 4-5턴의 흐름 (사용자가 마지막에 한 미묘한 정정, Claude가 다음 턴에 묻기로 결정한 follow-up 등)
- 지금 검증 중인 클레임 (STAR 보강 중간 상태, fact-check 대기)
- 활성 페르소나 / 활성 라운드 / 활성 회사 컨텍스트
- 미해결 sub-thread 리스트

기존 영속 파일(`meta.json` / `hook-state.json` / `findings.json` / episode log)은 **확정된 사실**만 담고 있어, **진행 중인 작업 메모리**는 잡지 못한다. compact 후 새 컨텍스트는 영속 파일을 다시 읽어 fact는 복원하지만, "어디서 끊겼지?"를 모른다.

## 2. 결정

3-layer 구조로 분리:

```
[휘발성 working memory]   Claude conversation context (compact 대상)
        ↓ 임계치 도달 시 추출
[브릿지: current-focus.md] compact를 가로지르는 단일 파일
        ↓ SessionStart:compact 시 자동 재주입
[영속 facts]              meta.json / hook-state.json / findings / episode log
                          (이미 존재, compact와 무관)
```

**핵심 원칙**: `current-focus.md`는 **영속 facts에 못 담는 휘발성 작업 메모리만** 담는다. STAR/회사 데이터 같은 확정된 fact는 기존 파일이 이미 잡고 있으니 중복 금지.

## 3. 트리거

### 3.1 임계치 권고 (primary)

`UserPromptSubmit` hook에 토큰 추정 분기 추가:

- 추정 토큰 ≥ **250,000** 도달 시 → hook이 additionalContext에 `compaction_warning` 메시지 주입:
  > "⚠️ 컨텍스트 250k+ 도달. 다음 응답 직전에 `.resume-panel/current-focus.md`를 (§4 스키마)대로 저장하고, 사용자에게 '/compact 권고' 한 줄 안내해라."
- Claude는 그 턴에 current-focus.md를 작성한 뒤 사용자에게 압축 권고. 사용자가 `/compact` 입력하면 Layer 3(영속) + Layer 2(브릿지) 양쪽이 다음 세션을 받쳐준다.
- **De-bounce**: current-focus.md가 이미 존재하고 `saved_at`이 5분 이내면 권고 suppress. 사용자가 /compact를 늦게 누르더라도 매 턴 같은 경고가 반복되지 않는다.

### 3.2 토큰 추정 방식

- 1차: 매 UserPromptSubmit 시 hook에 전달되는 transcript JSONL 경로의 파일 크기를 4로 나눈 값 (rough byte/token proxy).
- 2차: `session-stats.json`에 누적된 turn 수 × 평균 turn 크기 보강 (선택, 정확도 향상용).
- ±10% 정확도면 충분 (250k는 hard limit이 아니라 권고 임계치).

### 3.3 안전망 (backstop)

`PreCompact` hook 신설. compact가 시작되는 시점에:

- `current-focus.md`가 없거나 `saved_at`이 5분 이상 stale → additionalContext에 "지금 마지막 기회로 current-focus.md 작성하라" 한 번 더 주입.
- 이미 5분 이내에 작성됐으면 noop.

이중 안전망이라 임계치 권고를 Claude가 무시하더라도 compact 직전에 한 번 더 잡힌다.

## 4. current-focus.md 스키마

저장 경로: `<base>/.resume-panel/current-focus.md`

```markdown
# Current Focus

session_id: <Claude Code session UUID>
saved_at: <ISO8601 timestamp>
turn: <누적 턴 수>

## 활성 컨텍스트
- round: <0|1|1.5|2|3>
- 회사: <현재 다루는 회사명 또는 null>
- 활성 페르소나: <senior|c-level|recruiter|hr|coffee-chat|null>

## 검증 중인 클레임
- <지금 사용자한테 fact-check 중이거나 STAR 보강 중인 1-3개 항목>

## 다음 턴 액션
- <다음 사용자 발화에 어떻게 반응하려 했는지 1-2줄>

## 미해결 sub-thread
- [ ] <예: 버넥트 STAR 보강 미완>
- [ ] <예: Reverse Proxy 사실 확인 대기>

## 직전 흐름 (4-5턴 압축)
<자유 텍스트 200-400자>
```

### 4.1 필드 의도

| 필드 | 책임 |
|---|---|
| `session_id` | compact 후 같은 세션 진입인지 매칭 키 |
| `saved_at` | stale 판정 기준 (30분 초과 시 무시) |
| `turn` | 디버깅용. 어느 턴에 저장됐는지 추적 |
| `활성 컨텍스트` | round/회사/페르소나 — meta.json에도 일부 있지만 페르소나는 휘발 |
| `검증 중인 클레임` | findings에 안 잡힌, 다음 턴 즉시 needed |
| `다음 턴 액션` | Claude의 자기 메모. compact가 끊은 사고 흐름 복원 |
| `미해결 sub-thread` | 회고/follow-up 문서로 가기엔 너무 짧고 즉시 처리 가능한 것 |
| `직전 흐름 압축` | 4-5턴 자연어 요약, 200-400자 |

### 4.2 작성 책임

- **Claude (primary)**: §3.1 권고 받으면 그 턴에 작성.
- **Claude (backstop)**: §3.3 PreCompact 알림 받으면 그 시점에 작성.
- **Hook은 절대 자동 작성하지 않음** — 컨텍스트를 모르므로 정확한 휘발 메모리 추출 불가. Hook은 요청만 하고 작성은 Claude가.

## 5. 재로드 (SessionStart:compact)

`episode-watcher.mjs`의 `SessionStart` 분기 추가:

```js
if (input.hook_event_name === "SessionStart") {
  if (input.source === "compact") {
    const focus = readCurrentFocus(currentFocusPath);
    if (focus && focus.session_id === input.session_id) {
      const ageMin = (Date.now() - new Date(focus.saved_at).getTime()) / 60000;
      if (ageMin <= 30) {
        // additionalContext에 통째로 주입
        return { hookSpecificOutput: { additionalContext: focus.raw } };
      }
    }
  }
  // 그 외: 영속 파일만으로 진행, current-focus.md 무시
}
```

### 5.1 매칭 규칙

| 조건 | 처리 |
|---|---|
| `source !== "compact"` | 무시 (일반 세션 시작은 mode 라우팅 따라감) |
| current-focus.md 없음 | 무시 |
| `session_id` 불일치 | 무시 (다른 세션의 잔재) |
| `saved_at` 30분 초과 | 무시 (오래됨) |
| 위 모두 통과 | additionalContext에 주입 |

다른 회사 전환, 다른 라운드, 며칠 후 재진입 등은 모두 위 조건에서 자연스럽게 걸러진다. 명시적 삭제 로직 불필요.

### 5.2 stale 정리

current-focus.md는 다음 정상 compact-resume 시 덮어쓰여진다. 명시적으로 삭제하지 않는 이유:

- 디버깅 가치: 마지막으로 어떤 상태였는지 사후 확인 가능
- 부담 없음: 단일 파일, 작은 크기

라운드 전환 hook이나 session-end hook에서 명시적 삭제는 하지 않는다 (스코프 외).

## 6. 컴포넌트

| 변경 대상 | 변경 내용 |
|---|---|
| `plugins/resume/scripts/episode-watcher.mjs` | (a) UserPromptSubmit 분기에 토큰 추정 + 임계치 권고 메시지 주입. (b) `PreCompact` 분기 신설 (backstop). (c) `SessionStart` 분기에 `source==="compact"` 시 current-focus.md 재주입. |
| `plugins/resume/skills/resume-panel/references/hook-protocol.md` | 새 메시지 타입 `compaction_warning` 섹션 추가. trigger / payload / Claude 처리 의무 명시. |
| `plugins/resume/skills/resume-panel/references/storage.md` | `current-focus.md` 스키마 표 추가. 다른 영속 파일과 책임 경계 명시. |
| `plugins/resume/skills/resume-panel/SKILL.md` 또는 별도 reference | 임계치 도달 시 Claude의 의무 — 작성 형식, 사용자 안내 문구 정형화. |
| `plugins/resume/scripts/test-episode-watcher.mjs` | 임계치 권고 발화 / SessionStart:compact 재주입 / session_id mismatch 무시 / 30분 초과 무시 테스트. |
| `plugins/resume/.claude/settings.json` (또는 hook 등록 위치) | `PreCompact` 이벤트 등록 추가. |

## 7. 에러 처리

| 시나리오 | 처리 |
|---|---|
| `current-focus.md` 파일은 있으나 JSON/마크다운 파싱 실패 | 백업(`current-focus.md.bak.<ts>`) 후 무시 |
| Claude가 임계치 권고를 무시하고 그냥 답변 | PreCompact backstop이 한 번 더 시도 |
| Claude가 PreCompact backstop도 무시 | compact 진행, 다음 세션은 영속 파일만으로 재구성 (이전과 동일 동작, 회복 가능) |
| 토큰 추정이 부정확해서 임계치 너무 일찍/늦게 발화 | 권고 메시지일 뿐이므로 운영 영향 없음. 추정 알고리즘은 회고 후 보정 |
| `session_id`가 비어 있음 (Claude Code 환경 변수 문제) | 안전을 위해 매칭 실패로 처리, 무시 |

## 8. 테스트

`test-episode-watcher.mjs`에 추가할 테스트 블록:

| 테스트 | 검증 |
|---|---|
| Phase 7.1 — 임계치 미달 | 토큰 < 250k → `compaction_warning` 미발화 |
| Phase 7.2 — 임계치 도달 | 토큰 ≥ 250k → additionalContext에 `compaction_warning` 메시지 포함 |
| Phase 7.2b — de-bounce | 토큰 ≥ 250k이지만 current-focus.md가 5분 이내 작성됨 → 미발화 |
| Phase 7.3 — PreCompact backstop (focus 없음) | current-focus.md 없으면 backstop 메시지 발화 |
| Phase 7.4 — PreCompact backstop (focus 신선) | 5분 이내 작성된 focus 있으면 backstop 메시지 noop |
| Phase 7.5 — SessionStart:compact 재주입 (정상) | session_id 일치 + 30분 이내 → additionalContext에 focus.raw 포함 |
| Phase 7.6 — SessionStart:compact session_id 불일치 | additionalContext에 focus 미포함 |
| Phase 7.7 — SessionStart:compact 30분 초과 | additionalContext에 focus 미포함 |
| Phase 7.8 — SessionStart 일반 (source !== compact) | focus 무시 (mode 라우팅과 충돌 없음) |
| Phase 7.9 — focus 파일 파싱 실패 | bak 파일 생성 + focus 미주입 |

## 9. 부록 — 비스코프

다음은 의도적으로 본 spec에서 제외:

- **자동 `/compact` 실행**: 사용자 결정 영역. hook은 권고만, 실행은 사용자.
- **토큰 추정 정확도 ±10% 이상 보장**: proxy 추정으로 충분. 진짜 부정확하면 회고 후 별도 spec.
- **current-focus.md 명시적 삭제/회전**: 다음 compact-resume 사이클이 자동으로 덮어씀. 라운드 전환 시 정리 로직은 스코프 외.
- **다중 동시 세션 충돌**: resume-panel은 단일 사용자/단일 세션 가정. 동시 세션은 가정 외.
- **compact 후 사용자가 다른 모드로 진입한 경우**: `source === "compact"`는 충족하지만 사용자가 의도적으로 다른 회사/라운드로 가려는 경우. 일단 focus 주입하되, 사용자 명시적 발화가 우선 (Claude가 알아서 무시할 수 있음).

## 10. 부록 — Cross-reference

| 주제 | 위치 |
|---|---|
| 토큰 추정 알고리즘 | `episode-watcher.mjs` `estimateTokens()` (구현 시 신설) |
| `compaction_warning` 메시지 포맷 | `references/hook-protocol.md` (구현 시 추가) |
| current-focus.md 스키마 | `references/storage.md` (구현 시 추가) |
| Claude 의무 (작성 형식, 사용자 안내 문구) | `SKILL.md` 또는 신설 reference (구현 시 결정) |
| 영속 파일과 휘발 메모리 분리 원칙 | 본 spec §2, `references/storage.md` |
