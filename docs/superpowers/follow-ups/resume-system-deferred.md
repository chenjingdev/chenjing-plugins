# Resume Plugin — Deferred System Issues

회고 `playground/docs/retrospectives/20260504-185751.md`에서 식별됐으나 본 라운드 spec(`docs/superpowers/specs/2026-05-06-resume-plugin-counter-reliability-design.md`) 스코프에서 제외된 시스템 이슈 메모. 다음 라운드 spec 후보.

---

## 이슈 4 — `pattern_detected` finding 발행 경로 미정립

### 증상
- `references/hook-protocol.md` §finding은 `pattern_detected` (MEDIUM) 타입을 명시하고 처리 패턴을 규정.
- 그러나 `scripts/episode-watcher.mjs` 어디에도 `pattern_detected` finding을 발행하는 코드가 없음.
- 회고는 패턴 finding 4건(`pt-...01,02,03,04`)을 미해결 항목으로 언급. 실제로 어디서 어떻게 생성됐는지 불명확.

### 원인 가설
- 프로파일러 에이전트(`.claude/agents/profiler.md`)가 산출물에 패턴 분석을 포함하고, 오케스트레이터가 그 결과를 `findings-inbox.jsonl`에 직접 append하는 흐름이 의도였으나 명세화 안 됨.
- 또는 episode-watcher가 직접 패턴 탐지를 해야 하지만 구현이 빠짐.

### 다음 라운드 작업
1. 프로파일러 에이전트 산출물 형식 표준화 (JSON 스키마 정의).
2. 산출물 → `findings-inbox.jsonl` 라우팅 책임자 결정 (오케스트레이터 vs hook).
3. `pattern_detected` finding 발행 코드 작성.
4. `references/hook-protocol.md`와 `references/agent-contract.md` 양쪽에 명세 동기화.

**상태 (2026-05-07)**: `2026-05-07-resume-state-isolation-design.md` spec으로 처리 완료. 다음 라이브 세션에서 검증.

---

## 이슈 5 — `migrateMeta` 단방향 (구필드 잔존)

### 증상
`scripts/episode-watcher.mjs:349-388` `migrateMeta`는 `delete migrated.gap_probes_this_session` 같은 구필드 삭제를 수행. 그러나 실제 `playground/.resume-panel/meta.json` 파일에는 `perspective_shifts_this_session`, `perspective_shifted_episodes`, `contradictions_presented_this_session` 같은 구필드가 그대로 남아 있음.

### 원인 가설
- `migrateMeta`는 신구 공존 객체를 입력으로 받아 구필드를 삭제한 결과를 반환하지만, 실제 호출 부에서 반환값을 다시 파일에 쓰지 않거나, 일부 호출 경로만 마이그레이션 적용 후 다른 경로가 구필드 그대로 다시 씀.
- 또는 `migrateMeta` 자체가 idempotent하지 않아 두 번째 호출 시 구필드를 다시 인식 못 하고 패스.

### 다음 라운드 작업
1. 모든 `meta.json` write 경로가 `migrateMeta(meta)` 결과를 사용하는지 감사.
2. `migrateMeta` idempotency 보장 — 두 번 호출해도 같은 결과.
3. 구필드 잔존 시 자동 정리 로직 추가 또는 1회성 cleanup script 제공.

**상태 (2026-05-07)**: `2026-05-07-resume-state-isolation-design.md` spec으로 처리 완료. 다음 라이브 세션에서 검증.

---

## 회고 §5 콘텐츠 회수 항목 (시스템 이슈 아님)

다음 인터뷰 세션 진입 시 처리. 본 follow-up 문서 관할 외:

- 버넥트 VIRNECT Make STAR 보강
- Reverse Proxy Mocking 사실 확인
- Kafka 토픽/스키마/검증 도구 STAR 보강
- CJ 만 10년+ 절대 갭 — 추천/직접 컨택 병행 전략
- 와이즈와이어즈 일상 루틴 보강
- 표현 정정 11건 일괄 적용 검증

`/resume:resume-panel explore` 또는 일반 진입으로 다음 세션에서 처리 예정.

---

## 다음 라이브 세션 검증 체크리스트 (2026-05-06 spec 후속)

`docs/superpowers/specs/2026-05-06-resume-plugin-counter-reliability-design.md` 시행 효과를 다음 실제 resume 세션의 회고에서 확인:

- [ ] `session-stats.json._debug.observed_tool_names` — Agent/Task 둘 중 어느 쪽이 실제 도착했는지 확인 (가설: Agent 우세).
- [ ] `session-stats.json._debug.observed_hook_events.UserPromptSubmit` — 0이 아닌 값. UserPromptSubmit hook 정상 발화 확인.
- [ ] `meta.json.gate_state.round_turn_counts` — 라운드별 분포가 0이 아닌 값으로 기록.
- [ ] `meta.json.gate_state.agent_calls_in_current_round` — senior/c-level 등 실제 호출 수 반영(수동 동기화 없이).
- [ ] `session-stats.json.agent_invocations` — 위와 동일 일관성.
- [ ] `meta.json.total_profiler_calls` — 직전 세션 3회 대비 5회 이상 증가 (가중치 모델 B 효과).
- [ ] `meta.json._score_reasons` — 최근 점수 가산 사유 10개 보존, 다양한 reason("AUQ", "에피소드 +N", "so_what (+3)" 등) 존재.
- [ ] `gate_violations` 배열 — `r2_exit / turn_min` 위반이 부적절하게 발행되지 않는지 (round 2 정상 진행 시).
- [ ] `.resume-panel/hook-state.json` 파일 존재. session_limits, gate_state, profiler_score 모두 hook-state.json에 위치 (meta.json엔 없음).
- [ ] profiler 호출 후에도 `hook-state.json.profiler_score`, `_score_reasons`, `_last_high_finding_at` 보존 (이전엔 매 사이클 리셋).
- [ ] `findings.json`에 `pattern_detected` (pt-) finding이 라우팅된 흔적 존재 (delivered=true). 회사 전환 시점에 발생.
- [ ] `meta.json`에 `session_limits`, `gate_state` 같은 hook 필드가 잔존하지 않음 (loadState idempotent 검증).

위 항목 중 하나라도 비정상이면 후속 라운드 spec(이슈 4·5 + 추가 발견)에 포함.
