# Storage — Schema, Timing, and Methods

Read this file when initializing `resume-source.json`, saving an episode, or updating a STAR field (contradiction restoration, So What chain synthesis).

## resume-source.json Schema

```json
{
  "meta": {
    "target_company": "",
    "target_position": "",
    "jd_summary": "",
    "created_at": "",
    "updated_at": ""
  },
  "profile": {
    "name": "",
    "age": 0,
    "years_of_experience": 0,
    "companies": []
  },
  "companies": [
    {
      "name": "",
      "research": {
        "mau": "",
        "tech_stack": [],
        "team_size": "",
        "notes": ""
      },
      "projects": [
        {
          "name": "",
          "period": "",
          "role": "",
          "tech_stack": [],
          "episodes": [
            {
              "type": "성과|문제해결|리더십|협업|학습|기타",
              "title": "",
              "situation": "",
              "task": "",
              "action": "",
              "result": ""
            }
          ]
        }
      ]
    }
  ],
  "gap_analysis": {
    "met": [],
    "gaps": [
      {
        "requirement": "",
        "verdict": "",
        "market_standard": "",
        "suggestion": ""
      }
    ]
  }
}
```

## Save Timing

| Timing | Content |
|------|------|
| End of Round 0 | Initial `resume-source.json` (skeleton: meta + profile + companies) |
| On episode capture | Append to the owning company/project |
| End of Round 2 | Add `gap_analysis` |
| End of Round 3 | Final save + generate `resume-draft.md` |

## Save Method

Use the Bash tool with a `cat` heredoc (instead of the Write tool, for token efficiency):

```bash
cat <<'EOF' > ./resume-source.json
{ ... 전체 JSON ... }
EOF
```

## Initial State Directory Setup

Right after `resume-source.json` is first created (end of Round 0), initialize `.resume-panel/`:

```bash
mkdir -p .resume-panel
cat <<'EOF' > .resume-panel/meta.json
{
  "last_profiler_call": null,
  "last_profiler_episode_count": 0,
  "current_company": null,
  "total_profiler_calls": 0,
  "gap_probes_this_session": 0,
  "perspective_shifts_this_session": 0,
  "perspective_shifted_episodes": [],
  "contradictions_presented_this_session": 0
}
EOF
```

`snapshot.json` is auto-created on first run by the episode-watcher hook, so manual initialization is not needed.

### `hook-state.json` (신규, 2026-05-07~)

episode-watcher hook이 단독 관리하는 메커니즘 상태. profiler/orchestrator는 read-only로만 참조.

| 필드 | 용도 |
|---|---|
| `session_limits.gaps` | gap probe 카운터 + 의도된 gap 목록 (`{used, max, intentional}`) |
| `session_limits.perspectives` | 관점 전환 사용 수 + episode_refs (`{used, max, episode_refs}`) |
| `session_limits.contradictions` | 모순 제시 카운터 (`{used, max}`) |
| `session_limits.reprobes` | 재프로빙 로그 (`{used, log}`) |
| `gate_state.direct_askuserquestion_streak` | G2 burst 감지 |
| `gate_state.agent_calls_in_current_round` | 라운드별 에이전트 호출 카운터 |
| `gate_state.round_turn_counts` | UserPromptSubmit 1회 = 1 turn |
| `gate_state.retrospective_invoked` | G4 회고 누락 감지 |
| `gate_state.last_askuserquestion_source` | AUQ 출처 (whitelist/agent/orchestrator_direct) |
| `profiler_score` | 모델 B 점수 (THRESHOLD=5) |
| `_score_reasons` | rolling 10 가산 사유 |
| `_last_high_finding_at` | HIGH finding 60s 보너스 윈도 |
| `last_timeline_check` | timeline gap 분석 시점 |
| `last_pattern_analysis_episode_count` | 패턴 분석 trigger 시점 에피소드 수 |
| `last_pattern_analysis_company_count` | 패턴 분석 trigger 시점 회사 수 |

writer: episode-watcher hook 단독. 다른 주체 write 금지.

### `current-focus.md` (신규, 2026-05-09~)

세션 중 컨텍스트가 250k+ 토큰을 넘어 `/compact`가 임박했을 때, compact를 가로질러 활성 작업 메모리를 잇기 위한 브릿지 파일. 위치: `<base>/.resume-panel/current-focus.md`.

**스키마** (markdown):

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
- <fact-check 중이거나 STAR 보강 중인 1-3개 항목>

## 다음 턴 액션
- <다음 사용자 발화에 어떻게 반응하려 했는지 1-2줄>

## 미해결 sub-thread
- [ ] <짧고 즉시 처리 가능한 미완 항목>

## 직전 흐름 (4-5턴 압축)
<자유 텍스트 200-400자>
```

**필수 필드**: `session_id`, `saved_at`. 둘 중 하나라도 누락되면 hook이 파싱 실패로 간주하고 `.bak.<ts>`로 백업 후 무시.

**writer**: Claude (오케스트레이터). hook은 절대 작성하지 않는다 — 휘발 메모리는 Claude만 알기 때문.

**reader**: episode-watcher hook의 SessionStart:compact 분기. 매칭 조건 (session_id 일치 + saved_at 30분 이내) 통과 시 raw 본문을 additionalContext로 주입.

**라이프사이클**:
1. UserPromptSubmit hook이 250k 토큰 임계치 도달 시 `compaction_warning` 발행 → Claude가 작성.
2. 사용자가 `/compact` 입력 → compact 실행 → 새 컨텍스트.
3. SessionStart:compact hook이 자동 재로드.
4. 다음 정상 compact-resume 사이클이 자동으로 덮어쓴다.

**영속 facts와의 책임 분리**:
- `meta.json` / `hook-state.json` / `findings.json` / episode log는 **확정된 사실** 보관.
- `current-focus.md`는 **휘발성 작업 메모리만** 보관.
- 중복 금지: STAR 데이터, 회사 메타, finding 같은 fact는 영속 파일에 이미 있으니 current-focus.md에 다시 적지 않는다.

## resume-draft.md Structure (End of Round 3)

```markdown
# {이름} — {타겟 포지션}

## 프로필
{경력 요약 — MAU, 기술스택, 핵심 강점}

## 경력

### {회사} ({기간})
**{프로젝트}** | {역할}
- {에피소드 기반 성과 bullet}
- {에피소드 기반 성과 bullet}

## ⚠️ 갭 분석 (타겟: {회사} {포지션})

### 충족
- {요구사항}: ✓

### 부족 — 이 레벨에 기대되는 경험
- {요구사항}: {시장 기준선}

### 추천 액션
- {구체적 제안}
```
