# chenjing-plugins 히스토리

## 현재 상태 (2026-04-06)

resume 플러그인 — 전문가 패널 기반 이력서 빌더. 자율 오케스트레이션까지 구현 완료, 라이브 테스트 통과.

### 구조

- 에이전트 12개 (리서처, 프로파일러, 시니어개발자, CTO, 채용담당자, HR, 커피챗봇 5종)
- 오케스트레이터 SKILL.md (라운드 0~3 진행 규칙)
- PostToolUse hook (episode-watcher.mjs) — delta 감지 + findings 라우팅

### 자율 오케스트레이션 흐름

```
유저 ↔ 오케스트레이터
        │ resume-source.json 저장
        ▼
   [hook: episode-watcher.mjs]
        ├─ delta 감지 → "프로파일러 호출 필요" → 백그라운드 프로파일러
        └─ findings-inbox 확인 → HIGH는 즉시, LOW는 보관
```

## 함정 / 제약 (다음 작업 시 주의)

1. **resume-source.json 스키마**: flat 구조 `source.projects[].episodes[]` 사용. 설계문서(`resume-panel-orchestration-design.md`)는 `companies[].projects[]`로 되어 있지만 **코드는 flat**. 설계문서가 틀림.

2. **STAR 필드 위치**: `ep.star.situation` (ep 직속이 아님)

3. **서브에이전트 hook 전파 안 됨**: 프로파일러(백그라운드 Agent)의 도구 호출에서 hook이 발동해도 additionalContext가 메인에 안 옴. 메인의 다음 도구 호출 시 inbox가 처리되므로 1턴 지연.

4. **프로파일러 findings.json 직접 수정 금지**: inbox에만 append. findings.json은 hook이 관리. profiler.md에 명시했지만 LLM이 무시할 수 있음.

5. **플러그인 캐시**: GitHub에서 가져옴. 로컬 커밋만으로는 반영 안 됨. push 후 Claude Code 재시작 필요.

## 경과 요약

| 날짜 | 작업 |
|------|------|
| 04-01 | 마켓플레이스 초기 구조 + resume-source 스킬 (v1) |
| 04-02 | resume-panel 설계 (12개 에이전트 패널 구조) |
| 04-02~03 | 에이전트 12개 + 오케스트레이터 SKILL.md 구현 |
| 04-03 | 자율 오케스트레이션 구현 (hook + episode-watcher) |
| 04-06 | 실 데이터 E2E 검증, 스키마 불일치/self-trigger 버그 수정 |
