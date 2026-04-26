# Agent Tool Scope + Playwright MCP Gate + Session Retrospective

## 배경

resume-panel은 8개 서브에이전트로 구성된다. 운영 중 다음 세 가지 비효율과 품질 문제가 관찰됐다.

1. **컨텍스트 낭비** — 서브에이전트 frontmatter에 `tools:` 화이트리스트가 없어, 부모(오케스트레이터)의 모든 툴/스킬 schema가 상속된다. 프론트스테이지 에이전트(senior, c-level, recruiter, hr, coffee-chat)는 텍스트 질문만 리턴하므로 어떤 툴도 필요 없는데, 매 호출마다 전체 툴 schema가 컨텍스트에 들어와 토큰을 잡아먹는다.
2. **리서처 폴백 품질 저하** — researcher.md는 WebSearch → WebFetch → Playwright MCP 폴백 체인을 가정하지만, 실사용에서 WebSearch만으로는 회사 정보 커버리지가 거의 잡히지 않는다(SPA·로그인·봇 차단 페이지 다수). MCP 미설치 환경에서 진행하면 리서처 산출물이 빈약해지고, 그 결과 인터뷰 질문 품질도 같이 무너진다.
3. **세션 메타피드백 부재** — 한 세션이 끝나도 어떤 에이전트의 질문이 약했는지, 유저가 어디서 "직접입력"으로 빠졌는지, 어떤 finding이 미해결로 남았는지 자동 기록되지 않는다. 다음 세션에서 같은 문제가 반복된다.

## 변경 1 — 에이전트 툴 화이트리스트

8개 에이전트 frontmatter에 `tools:` 추가. 실제 사용 툴 분석 결과 기반.

### 화이트리스트

| Agent | tools | 근거 |
|---|---|---|
| `researcher` | `WebSearch, WebFetch, mcp__*playwright*__*` | 외부 웹 조사, MCP 폴백 |
| `project-researcher` | `Read, Glob, Grep` | 로컬 채팅 세션 파일 탐색 (Map-Reduce Stage 1-2) |
| `profiler` | `Read, Bash` | 입력 시그널 읽기, `findings-inbox.jsonl` append |
| `senior` | `[]` | 순수 질문 생성, 툴 사용 없음 |
| `c-level` | `[]` | 동일 |
| `recruiter` | `[]` | 동일 |
| `hr` | `[]` | 동일 |
| `coffee-chat` | `[]` | 동일 |

### MCP 이름 글롭 패턴

Playwright MCP의 툴 이름은 환경마다 prefix가 다르다(예: `mcp__plugin_playwright_playwright__*` vs `mcp__playwright__*`). 화이트리스트는 글롭 `mcp__*playwright*__*`로 선언하여 양쪽 환경 모두 커버한다.

## 변경 2 — Playwright MCP 하드 게이트

리서치 품질이 MCP에 종속적이므로, 미설치 시 진행하지 않고 안내 후 종료.

### Round 0.1: 환경 체크 (신규)

Round 0의 첫 단계로 추가:

1. `Bash`: `claude mcp list 2>&1 | grep -iE 'playwright'`
2. rc=0 → Round 0.2(기존 세팅) 진행
3. rc≠0 → 안내 메시지 출력 후 스킬 종료:

```
⚠️ Playwright MCP이 필요합니다

회사/JD 조사 품질을 위해 필수입니다.
WebSearch만으로는 기업 정보 수집이 부족합니다.

설치 방법:
  1) `/plugin` 명령으로 playwright 플러그인 설치
  2) Claude Code 재시작 (또는 `/reload`)
  3) 다시 `resume` 시작
```

### 비채택 대안 (참고)

- **자동 설치 (`claude mcp add ...` Bash 실행)**: 가능하지만 MCP는 세션 시작 시 로드되므로 재시작이 필수다. 자동화의 이득이 작고, 부트스트랩 상태 파일·SessionStart 훅 등 복잡도가 늘어남
- **degraded 모드 (WebSearch만으로 진행)**: 리서치 품질이 무너지면 인터뷰 품질도 같이 무너지므로 의미 없음
- **AskUserQuestion으로 설치/스킵 선택**: 스킵 옵션이 degraded와 동일해서 실질 무의미

### researcher.md 정리

기존의 "Playwright MCP Fallback for Blocked WebSearch/WebFetch" 섹션은 **유지**한다 — 런타임 일시 장애(네트워크 에러, 권한 차단)에 대한 폴백으로서의 의미는 여전하다. 다만 "MCP 미설치 시 디그레이드" 가정 문구는 제거(설치는 사전에 보장됨).

## 변경 3 — 세션 회고 md 자동 출력

Round 3 마무리 단계에 메타피드백 회고 생성을 편입.

### 트리거 — 훅이 아닌 오케스트레이터 단계

회고 생성은 LLM 분석이 필요한데 hooks는 shell 실행이라 LLM을 호출할 수 없다. hooks로 marker 파일을 쓰고 다음 턴에 처리하는 방식은 "마지막 동작" 정의상 어색하다(다음 턴이 없음). 따라서 **오케스트레이터의 Round 3 마무리 단계 마지막 액션**으로 편입한다.

### 신규 에이전트 `retrospective.md`

- **역할**: 세션 메타피드백 분석가 (백스테이지)
- **입력**:
  - 현재 세션의 대화 로그 (오케스트레이터가 요약 전달)
  - `.resume-panel/findings.json`
  - `resume-source.json`의 episodes
- **분석 항목**:
  - 질문 품질이 낮았던 지점 (유저 응답이 "모르겠어"·짧은 답·재질문 유발)
  - 유저가 "직접입력"으로 빠진 빈도가 높은 에이전트
  - 미해결 findings (HIGH urgency 중 응답 못 받은 것)
  - 라운드별 시간/턴 배분 이상 (특정 라운드가 비대해진 경우)
  - 다음 세션 개선 제안
- **출력**: 마크다운 텍스트 (오케스트레이터가 파일에 저장)
- **tools**: `Read, Glob`

### 출력 위치

`docs/retrospectives/YYYY-MM-DD-<session-id>.md`

`session-id`는 `.resume-panel/state.json` 등 기존 세션 식별자를 재활용. 없으면 timestamp(`HHMMSS`)로 대체.

### 호출 시점

SKILL.md Round 3 마무리 시퀀스:

```
Round 3 마무리:
  1. resume-draft.md 최종 저장 (기존)
  2. coffee-chat 페르소나 요약 (기존)
  3. [NEW] retrospective 에이전트 호출
  4. [NEW] 산출 마크다운을 docs/retrospectives/{date}-{session-id}.md로 저장
  5. 유저에게 회고 파일 경로 안내
```

## 변경되는 파일

```
plugins/resume/skills/resume-panel/SKILL.md       # Round 0.1, Round 3 마무리 수정
plugins/resume/.claude/agents/researcher.md       # frontmatter tools, "degraded" 문구 정리
plugins/resume/.claude/agents/project-researcher.md  # frontmatter tools
plugins/resume/.claude/agents/profiler.md         # frontmatter tools
plugins/resume/.claude/agents/senior.md           # frontmatter tools: []
plugins/resume/.claude/agents/c-level.md          # frontmatter tools: []
plugins/resume/.claude/agents/recruiter.md        # frontmatter tools: []
plugins/resume/.claude/agents/hr.md               # frontmatter tools: []
plugins/resume/.claude/agents/coffee-chat.md      # frontmatter tools: []
plugins/resume/.claude/agents/retrospective.md    # NEW
docs/retrospectives/.gitkeep                      # NEW
```

훅(`hooks/hooks.json`, `scripts/episode-watcher.mjs`)은 변경 없음.

## 검증 기준

1. **툴 화이트리스트 적용 검증**: 각 에이전트가 `tools:` 외 호출을 시도하면 거부되는지 (Claude Code agent runner 동작에 의존). 적어도 frontmatter syntax는 valid해야 함
2. **MCP 게이트 검증**: playwright MCP 미설치 환경에서 `resume` 호출 시 안내 메시지 출력 후 즉시 종료, Round 0.2로 진행하지 않음
3. **회고 출력 검증**: 짧은 인터뷰(2~3턴)로 Round 3까지 진행 후 `docs/retrospectives/`에 파일 생성 확인. 파일 내용에 분석 항목 5개가 모두 등장

## 비범위

- 다른 플러그인/스킬에 동일 패턴 적용 (knou-crawl 등) — 추후 별도
- 회고 결과를 다음 세션 부팅 시 자동 학습/주입 — 추후 별도
- 자동 설치 + 세션 관리 자동화 — 비채택

## 참고

- 직전 스펙: `docs/superpowers/specs/2026-04-06-resume-panel-question-quality-design.md`
- 에이전트 정의 위치: `plugins/resume/.claude/agents/`
- 현재 훅: `plugins/resume/hooks/hooks.json` (PostToolUse only)
