# Changelog

resume 플러그인의 주요 변경사항을 기록한다.

## Gotchas

다음 작업 시 주의할 사항. 코드/설계 변경 시 반드시 확인.

- **resume-source.json 스키마**: flat 구조 `source.projects[].episodes[]`. 설계문서는 `companies[].projects[]`로 되어 있지만 코드는 flat. 설계문서가 틀림.
- **STAR 필드 위치**: `ep.star.situation` (ep 직속이 아님)
- **서브에이전트 hook 전파 안 됨**: 백그라운드 Agent 도구 호출의 additionalContext가 메인에 안 옴. 메인의 다음 도구 호출 시 inbox 처리 (1턴 지연).
- **프로파일러 findings.json 직접 수정 금지**: inbox에만 append. profiler.md에 명시했지만 LLM이 무시할 수 있음.
- **플러그인 캐시**: GitHub에서 가져옴. push 후 Claude Code 재시작 필요.

## [Unreleased]

## [2026-04-06]

### Fixed
- **스키마 불일치 수정** — episode-watcher가 `companies[].projects[]`를 기대했으나 실제 데이터는 flat `projects[]`. `countEpisodes`, `getProjectNames`, `countStarGaps` 3개 함수 수정.
- **Bash self-trigger 방지** — 프로파일러가 Bash로 `.resume-panel/`에 쓸 때 hook이 inbox를 소비하는 문제. Bash 명령어에서도 `.resume-panel/` 경로 감지하도록 확장.
- **profiler.md 금지 강화** — findings.json 직접 읽기/수정 절대 금지 명시.

## [2026-04-03]

### Added
- **자율 오케스트레이션** — PostToolUse hook(episode-watcher.mjs)이 resume-source.json 변경을 감지하여 프로파일러를 트리거하고, findings를 긴급도별로 라우팅.
- **hooks.json** — PostToolUse → Write|Bash|Edit 매칭.
- **episode-watcher.mjs** — delta 감지(에피소드 +3, 새 프로젝트, meta 변경, 쿨다운) + findings 라우팅(HIGH/MEDIUM/LOW).
- **SKILL.md hook 메시지 처리 규칙** — `[resume-panel]` 태그별 오케스트레이터 행동 정의.
- **profiler.md 자율 모드** — 전문 에이전트 디스패치 + findings-inbox.jsonl append 지시.
- **.resume-panel/ 초기화** — 라운드 0에서 meta.json 자동 생성.

## [2026-04-02 ~ 04-03]

### Added
- **에이전트 12개** — 리서처, 프로젝트리서처, 프로파일러, 시니어개발자, CTO, 채용담당자, HR, 커피챗봇 5종.
- **오케스트레이터 SKILL.md** — 라운드 0~3 진행 규칙, 에이전트 선택 기준, 저장 스키마.

## [2026-04-02]

### Added
- **resume-panel 설계** — 12개 전문가 에이전트 패널 구조 설계문서.

## [2026-04-01]

### Added
- **마켓플레이스 초기 구조** — chenjing-plugins 마켓플레이스 + resume 플러그인 등록.
- **resume-source 스킬 (v1)** — 인터뷰 기반 이력서 소스 수집 (이후 resume-panel로 대체).

### Changed
- **인터뷰 방식 개선** — 선택지 제시, 응원 제거, 중복질문 금지.
