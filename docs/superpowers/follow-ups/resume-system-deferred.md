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
