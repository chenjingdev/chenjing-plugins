# Agent Tool Scope + Playwright MCP Gate + Session Retrospective Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** resume-panel 8개 서브에이전트에 툴 화이트리스트를 적용하고, Playwright MCP 미설치 시 게이트 안내로 종료하며, Round 3 마무리에 세션 회고 md를 자동 출력한다.

**Architecture:** 모두 프롬프트/frontmatter 변경. 신규 코드 없음. 8개 기존 에이전트 frontmatter 수정 + 신규 retrospective 에이전트 1개 + SKILL.md의 Round 0/Round 3 두 섹션 수정 + `docs/retrospectives/` 디렉토리 신설.

**Tech Stack:** Claude Code 서브에이전트 (markdown + YAML frontmatter), Bash hooks (변경 없음).

**Spec:** `docs/superpowers/specs/2026-04-20-agent-scope-and-retrospective-design.md`

**Notes on undocumented behavior:**
- `tools: []` 와 글롭 패턴(`mcp__*playwright*__*`)은 Claude Code 공식 문서에 없음. 안전을 위해:
  - 프론트스테이지 5개 에이전트는 `tools: Read` 1개만 명시 (모든 툴 schema 상속 대비 큰 절감)
  - MCP 툴은 현재 환경의 정확한 이름을 명시적으로 나열 (`mcp__plugin_playwright_playwright__*`)

---

## File Structure

```
plugins/resume/skills/resume-panel/SKILL.md         # 수정: Round 0.1 신규, Round 3 마무리에 retro 단계 추가
plugins/resume/.claude/agents/researcher.md         # 수정: tools 추가, MCP 폴백 framing 정리
plugins/resume/.claude/agents/project-researcher.md # 수정: tools 추가
plugins/resume/.claude/agents/profiler.md           # 수정: tools 추가
plugins/resume/.claude/agents/senior.md             # 수정: tools 추가
plugins/resume/.claude/agents/c-level.md            # 수정: tools 추가
plugins/resume/.claude/agents/recruiter.md          # 수정: tools 추가
plugins/resume/.claude/agents/hr.md                 # 수정: tools 추가
plugins/resume/.claude/agents/coffee-chat.md        # 수정: tools 추가
plugins/resume/.claude/agents/retrospective.md      # 신규
docs/retrospectives/.gitkeep                        # 신규
```

---

### Task 1: 백스테이지 에이전트 3개에 tools 화이트리스트 추가

**Files:**
- Modify: `plugins/resume/.claude/agents/researcher.md` (frontmatter)
- Modify: `plugins/resume/.claude/agents/project-researcher.md` (frontmatter)
- Modify: `plugins/resume/.claude/agents/profiler.md` (frontmatter)

- [ ] **Step 1: researcher.md frontmatter에 tools 라인 추가**

기존 frontmatter:
```yaml
---
description: "Invoke when company or JD research is needed. Gathers company information, JD requirements, tech stack, etc. via web search."
model: claude-sonnet
---
```

변경 후:
```yaml
---
description: "Invoke when company or JD research is needed. Gathers company information, JD requirements, tech stack, etc. via web search."
model: claude-sonnet
tools: WebSearch, WebFetch, mcp__plugin_playwright_playwright__browser_navigate, mcp__plugin_playwright_playwright__browser_snapshot, mcp__plugin_playwright_playwright__browser_click, mcp__plugin_playwright_playwright__browser_wait_for, mcp__plugin_playwright_playwright__browser_close, mcp__plugin_playwright_playwright__browser_press_key
---
```

- [ ] **Step 2: project-researcher.md frontmatter에 tools 라인 추가**

기존 frontmatter:
```yaml
---
description: "Invoke when the user mentions a personal/side project. Explores local chat sessions (codex, claude code, open code, etc.) and assembles a structured project summary."
model: claude-sonnet
---
```

변경 후:
```yaml
---
description: "Invoke when the user mentions a personal/side project. Explores local chat sessions (codex, claude code, open code, etc.) and assembles a structured project summary."
model: claude-sonnet
tools: Read, Glob, Grep
---
```

- [ ] **Step 3: profiler.md frontmatter에 tools 라인 추가**

기존 frontmatter:
```yaml
---
description: "유저에 대한 모든 시그널을 종합하여 프로파일링할 때 호출. 다른 에이전트의 질문 품질을 높이기 위한 유저 프로파일을 생성한다."
model: claude-sonnet
---
```

변경 후:
```yaml
---
description: "유저에 대한 모든 시그널을 종합하여 프로파일링할 때 호출. 다른 에이전트의 질문 품질을 높이기 위한 유저 프로파일을 생성한다."
model: claude-sonnet
tools: Read, Bash
---
```

- [ ] **Step 4: YAML frontmatter 유효성 검증**

각 파일 첫 10줄을 출력해서 frontmatter 구문 확인:

Run:
```bash
head -10 plugins/resume/.claude/agents/researcher.md plugins/resume/.claude/agents/project-researcher.md plugins/resume/.claude/agents/profiler.md
```

Expected:
- 각 파일에 `---`로 둘러싸인 frontmatter
- `tools:` 라인 존재
- `description:`, `model:`, `tools:` 3개 필드 모두 있음

- [ ] **Step 5: Commit**

```bash
git add plugins/resume/.claude/agents/researcher.md plugins/resume/.claude/agents/project-researcher.md plugins/resume/.claude/agents/profiler.md
git commit -m "$(cat <<'EOF'
feat(agents): 백스테이지 3개 에이전트에 tools 화이트리스트 추가

부모 컨텍스트의 모든 툴 schema 상속 방지로 토큰 절감.
- researcher: WebSearch, WebFetch, playwright MCP 5종
- project-researcher: Read, Glob, Grep
- profiler: Read, Bash (findings-inbox.jsonl append용)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 프론트스테이지 에이전트 5개에 tools 최소 화이트리스트 추가

**Files:**
- Modify: `plugins/resume/.claude/agents/senior.md` (frontmatter)
- Modify: `plugins/resume/.claude/agents/c-level.md` (frontmatter)
- Modify: `plugins/resume/.claude/agents/recruiter.md` (frontmatter)
- Modify: `plugins/resume/.claude/agents/hr.md` (frontmatter)
- Modify: `plugins/resume/.claude/agents/coffee-chat.md` (frontmatter)

이들은 순수 텍스트 질문만 리턴하지만, `tools: []` 는 undocumented이므로 무해한 `Read` 1개만 명시한다. 모든 툴 schema 상속 대비 절감 효과는 충분히 크다.

- [ ] **Step 1: senior.md frontmatter 수정**

기존:
```yaml
---
description: "도메인 깊이를 발굴할 때 호출. 유저의 실무 디테일, 의사결정, 문제 해결 과정을 파헤친다."
model: claude-sonnet
---
```

변경 후:
```yaml
---
description: "도메인 깊이를 발굴할 때 호출. 유저의 실무 디테일, 의사결정, 문제 해결 과정을 파헤친다."
model: claude-sonnet
tools: Read
---
```

- [ ] **Step 2: c-level.md frontmatter 수정**

기존:
```yaml
---
description: "전략적 의사결정, 비즈니스 임팩트, 스케일 관점에서 경험을 발굴할 때 호출."
model: claude-sonnet
---
```

변경 후:
```yaml
---
description: "전략적 의사결정, 비즈니스 임팩트, 스케일 관점에서 경험을 발굴할 때 호출."
model: claude-sonnet
tools: Read
---
```

- [ ] **Step 3: recruiter.md frontmatter 수정**

기존:
```yaml
---
description: "JD 매칭, 시장 경쟁력 분석, 갭 분석이 필요할 때 호출. 이력이 부족하면 솔직하게 팩폭한다."
model: claude-sonnet
---
```

변경 후:
```yaml
---
description: "JD 매칭, 시장 경쟁력 분석, 갭 분석이 필요할 때 호출. 이력이 부족하면 솔직하게 팩폭한다."
model: claude-sonnet
tools: Read
---
```

- [ ] **Step 4: hr.md frontmatter 수정**

기존:
```yaml
---
description: "소프트스킬, 리더십, 협업, 갈등 해결 에피소드를 발굴할 때 호출. 시니어 포지션일수록 비중이 높아진다."
model: claude-sonnet
---
```

변경 후:
```yaml
---
description: "소프트스킬, 리더십, 협업, 갈등 해결 에피소드를 발굴할 때 호출. 시니어 포지션일수록 비중이 높아진다."
model: claude-sonnet
tools: Read
---
```

- [ ] **Step 5: coffee-chat.md frontmatter 수정**

기존:
```yaml
---
description: "커피챗 페르소나 템플릿. 오케스트레이터가 유저 직군에 맞는 유명인 페르소나를 생성해서 호출한다."
model: claude-sonnet
---
```

변경 후:
```yaml
---
description: "커피챗 페르소나 템플릿. 오케스트레이터가 유저 직군에 맞는 유명인 페르소나를 생성해서 호출한다."
model: claude-sonnet
tools: Read
---
```

- [ ] **Step 6: 5개 파일 frontmatter 검증**

Run:
```bash
head -6 plugins/resume/.claude/agents/senior.md plugins/resume/.claude/agents/c-level.md plugins/resume/.claude/agents/recruiter.md plugins/resume/.claude/agents/hr.md plugins/resume/.claude/agents/coffee-chat.md
```

Expected: 각 파일에 `tools: Read` 라인이 description, model 다음에 위치

- [ ] **Step 7: Commit**

```bash
git add plugins/resume/.claude/agents/senior.md plugins/resume/.claude/agents/c-level.md plugins/resume/.claude/agents/recruiter.md plugins/resume/.claude/agents/hr.md plugins/resume/.claude/agents/coffee-chat.md
git commit -m "$(cat <<'EOF'
feat(agents): 프론트스테이지 5개 에이전트 tools 최소 화이트리스트

senior, c-level, recruiter, hr, coffee-chat은 순수 질문 생성용이라
툴 호출 없음. tools: [] 가 undocumented라 안전하게 Read 1개만 명시.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: researcher.md의 "MCP 미설치 시 디그레이드" framing 정리

**Files:**
- Modify: `plugins/resume/.claude/agents/researcher.md` (line 39-51 영역)

Round 0 게이트로 MCP가 보장된다는 전제를 본문에 반영. 단, 런타임 일시 장애(권한 차단, 네트워크 에러)에 대한 폴백 체인은 유지.

- [ ] **Step 1: 본문 line 36-51 수정**

기존:
```markdown
## Research Methods

1. WebSearch by keyword (company + "기술 블로그", company + "채용", company + "MAU", etc.)
2. WebFetch the result pages.
3. For JS-rendered pages (recruiting platforms, SPA blogs, etc.), use Playwright MCP.
   - **Always run in headless mode** — never surface a browser window on the user's screen.
   - Use a separate session so browsers don't collide with other researcher instances.

### Playwright MCP Fallback for Blocked WebSearch/WebFetch

If WebSearch or WebFetch fails (permission block, network error, etc.), switch to Playwright MCP:

1. **Search**: use `mcp__playwright__browser_navigate` to hit Google/Naver search URLs directly.
   - Example: `https://www.google.com/search?q={회사명}+기술+블로그`
2. **Parse results**: use `mcp__playwright__browser_snapshot` to extract search-result text.
3. **Collect pages**: follow useful links via `browser_navigate` → `browser_snapshot`.
4. **If Playwright also fails**: mark the research output with "웹 조사 불가 — 유저에게 직접 확인 필요" and return only the confirmed fields.
```

변경 후:
```markdown
## Research Methods

Playwright MCP is guaranteed to be available (the orchestrator gates the session at Round 0.1). Use the following order:

1. WebSearch by keyword (company + "기술 블로그", company + "채용", company + "MAU", etc.)
2. WebFetch the result pages.
3. For JS-rendered pages (recruiting platforms, SPA blogs, etc.), use Playwright MCP.
   - **Always run in headless mode** — never surface a browser window on the user's screen.
   - Use a separate session so browsers don't collide with other researcher instances.

### Playwright MCP Fallback for Blocked WebSearch/WebFetch

WebSearch or WebFetch can fail at runtime (rate limit, permission block, network error). When that happens, switch to Playwright MCP:

1. **Search**: use `mcp__plugin_playwright_playwright__browser_navigate` to hit Google/Naver search URLs directly.
   - Example: `https://www.google.com/search?q={회사명}+기술+블로그`
2. **Parse results**: use `mcp__plugin_playwright_playwright__browser_snapshot` to extract search-result text.
3. **Collect pages**: follow useful links via `browser_navigate` → `browser_snapshot`.
4. **If Playwright also fails at runtime**: mark the research output with "웹 조사 불가 — 유저에게 직접 확인 필요" and return only the confirmed fields.
```

변경 요점:
- 첫 단락에 "MCP is guaranteed" 명시
- MCP 툴 이름을 환경 prefix(`mcp__plugin_playwright_playwright__*`)에 맞춰 정확히 표기
- "If WebSearch or WebFetch fails (permission block, ..." → "WebSearch or WebFetch can fail at runtime ..." 로 framing 변경 (설치 부재가 아닌 일시 장애)

- [ ] **Step 2: 변경 검증**

Run:
```bash
grep -n "guaranteed\|mcp__plugin_playwright_playwright__" plugins/resume/.claude/agents/researcher.md
```

Expected:
- "guaranteed" 1회 등장
- `mcp__plugin_playwright_playwright__` 최소 2회 등장 (browser_navigate, browser_snapshot)

- [ ] **Step 3: Commit**

```bash
git add plugins/resume/.claude/agents/researcher.md
git commit -m "$(cat <<'EOF'
docs(researcher): Playwright MCP 보장 전제 + 정확한 MCP 툴명 표기

Round 0.1 게이트로 MCP 설치는 보장됨. 본문에 명시.
런타임 일시 장애 폴백 체인은 유지.
MCP 툴명을 mcp__plugin_playwright_playwright__* prefix로 정정.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: SKILL.md Round 0에 환경 체크 단계 추가

**Files:**
- Modify: `plugins/resume/skills/resume-panel/SKILL.md:282` 직후

Round 0 첫 단계로 "0. 환경 체크" 추가. 기존 "0. 대화 컨텍스트 자동 스캔"은 "1. 대화 컨텍스트 자동 스캔"으로 번호 시프트하지 않고, 새 단계를 별도로 위에 끼워 넣는다.

- [ ] **Step 1: Round 0 헤더 직후 환경 체크 단계 삽입**

`### 라운드 0: 세팅` (line 282) 다음에 다음 블록을 삽입:

```markdown
### 라운드 0: 세팅

에이전트 호출 없이 오케스트레이터가 직접 진행한다. 빠르게 끝낸다.

**0.1 환경 체크 (하드 게이트)**

리서치 품질이 Playwright MCP에 의존하므로, 미설치 환경에서는 진행하지 않는다.

```bash
claude mcp list 2>&1 | grep -iE 'playwright'
```

- 종료 코드 0 (매칭 있음) → 다음 단계 진행
- 종료 코드 ≠ 0 → 아래 안내 메시지를 출력하고 스킬 종료 (Round 0.2 이후 절대 진행 금지):

```
⚠️ Playwright MCP이 필요합니다

회사/JD 조사 품질을 위해 필수입니다.
WebSearch만으로는 기업 정보 수집이 부족합니다.

설치 방법:
  1) `/plugin` 명령으로 playwright 플러그인 설치
  2) Claude Code 재시작 (또는 `/reload`)
  3) 다시 `resume` 시작
```

**0.2 대화 컨텍스트 자동 스캔** (기존 "0. 대화 컨텍스트 자동 스캔")
```

기존 `**0. 대화 컨텍스트 자동 스캔** (신규)` 라인은 `**0.2 대화 컨텍스트 자동 스캔**` 으로 변경 (번호만 0 → 0.2). 본문은 그대로 유지.

- [ ] **Step 2: 삽입 결과 검증**

Run:
```bash
grep -n "0.1 환경 체크\|0.2 대화 컨텍스트\|claude mcp list" plugins/resume/skills/resume-panel/SKILL.md
```

Expected:
- `0.1 환경 체크` 1회
- `0.2 대화 컨텍스트` 1회
- `claude mcp list` 1회
- 기존 `**0. 대화 컨텍스트` 라인은 사라져야 함 (변경됐으므로)

추가 확인:
```bash
grep -c "^\*\*0\." plugins/resume/skills/resume-panel/SKILL.md
```
Expected: 0 (모두 0.1 또는 0.2 형태)

- [ ] **Step 3: Commit**

```bash
git add plugins/resume/skills/resume-panel/SKILL.md
git commit -m "$(cat <<'EOF'
feat(skill): Round 0.1 Playwright MCP 하드 게이트 추가

리서치 품질이 MCP에 종속적이므로 미설치면 안내 후 종료.
WebSearch만으로는 회사 정보 커버리지 부족 (실사용 검증).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: retrospective.md 신규 에이전트 작성

**Files:**
- Create: `plugins/resume/.claude/agents/retrospective.md`

세션 메타피드백 분석 전담. 백스테이지(유저와 대화 안 함). 입력 컨텍스트를 받아 마크다운을 리턴하면, 오케스트레이터가 파일에 저장한다.

- [ ] **Step 1: retrospective.md 작성**

```markdown
---
description: "세션 마무리 시 호출. 메타피드백 회고 마크다운을 생성한다 (질문 품질, 직접입력 빈도, 미해결 findings, 라운드 시간 배분 등)."
model: claude-sonnet
tools: Read, Glob
---

# 회고 분석가

너는 resume-panel 세션의 메타피드백 분석가다. 유저와 직접 대화하지 않는다. 세션이 끝난 후 오케스트레이터가 호출하면, 이 세션에서 무엇이 잘 됐고 무엇을 다음 세션에서 개선할지 정리한 회고 마크다운을 리턴한다.

## 입력

오케스트레이터가 다음을 전달한다:

- **세션 대화 요약**: 라운드별 주요 turn (오케스트레이터가 정리한 텍스트). 어떤 에이전트가 어떤 질문을 했고, 유저가 어떻게 답했는지 포함.
- **`.resume-panel/findings.json` 내용**: 미해결 finding 목록 + urgency
- **`resume-source.json`의 episodes 요약**: 회사/프로젝트별 에피소드 개수, STAR 충실도
- **세션 메타데이터**: 시작 시각, 종료 시각, 라운드별 소요 turn 수

## 분석 항목 (5개 모두 출력)

각 항목마다 구체적 근거를 들어 작성한다. "전반적으로 좋았다" 같은 추상 평가 금지.

### 1. 질문 품질이 약했던 지점

- 유저가 "모르겠어", "특별히 없어", 한 줄 단답으로 답한 질문들
- 한 에이전트가 같은 주제로 재질문을 여러 번 했는데도 답이 안 나온 경우
- 리서처 팩트가 빠진 추상 질문 (대화 브리핑의 "리서처 활용 필수 팩트" 미인용)

### 2. "직접입력"으로 빠진 빈도가 높은 에이전트

- AskUserQuestion에서 유저가 "Other"를 선택한 횟수를 에이전트별로 집계
- 빈도가 높으면 해당 에이전트의 선택지 설계가 유저 현실에서 벗어났다는 신호

### 3. 미해결 findings (HIGH/MEDIUM)

- `findings.json`에서 status가 `pending` 또는 `presented` 상태에서 해결 안 된 항목
- 각 finding의 type (pattern_detected / contradiction_detected / timeline_gap_found / impact_shallow), 발견 시각, 마지막 액션
- 다음 세션에서 우선 처리할 항목 추천

### 4. 라운드별 시간/턴 배분 이상

- 라운드 0/1/2/3 각각이 전체에서 차지한 turn 비율
- 특정 라운드가 비대 (예: Round 1이 전체의 70%) → 분기 진단
- Round 3 마무리가 너무 짧아 자소서/갭분석이 얕게 끝났는지 체크

### 5. 다음 세션 개선 제안

- 위 1~4 항목에 기반해 구체적 액션 3~5개
- 예: "Round 1 시작 시 리서처를 먼저 호출해서 팩트 확보 후 시니어/HR 호출"
- 예: "쿠팡 관련 미해결 timeline_gap을 우선 처리"

## 출력 포맷

```markdown
# Resume Panel 세션 회고

**세션 일시**: {YYYY-MM-DD HH:MM ~ HH:MM}
**총 turn 수**: {N}

## 1. 질문 품질이 약했던 지점

- {구체적 근거 1}
- {구체적 근거 2}

## 2. "직접입력" 빈도

| 에이전트 | 직접입력 횟수 | 비율 |
|---|---|---|
| senior | N | x% |
| ... | ... | ... |

## 3. 미해결 findings

- **HIGH**: {count}건
  - {finding 요약}
- **MEDIUM**: {count}건
  - {finding 요약}

## 4. 라운드별 turn 배분

| 라운드 | turn 수 | 비율 |
|---|---|---|
| 0 | N | x% |
| 1 | N | x% |
| 2 | N | x% |
| 3 | N | x% |

특이사항: {있으면 기술}

## 5. 다음 세션 개선 제안

1. {구체 액션}
2. {구체 액션}
3. {구체 액션}
```

## Forbidden

- 절대로 유저에게 직접 말 걸지 않는다 (백스테이지)
- 막연한 평가 금지 ("좋았다", "잘했다", "노력 필요") — 모든 항목은 구체적 근거 인용
- 에피소드 내용 자체에 대한 평가 금지 — 이 회고는 **세션 진행 품질**에 대한 것이지 유저 커리어에 대한 것이 아님
```

- [ ] **Step 2: 파일 생성 검증**

Run:
```bash
test -f plugins/resume/.claude/agents/retrospective.md && head -5 plugins/resume/.claude/agents/retrospective.md
```

Expected:
- 파일 존재
- 첫 5줄에 frontmatter (`---`, description, model, tools, `---`)
- `tools: Read, Glob` 포함

Run:
```bash
grep -c "^### [1-5]\." plugins/resume/.claude/agents/retrospective.md
```

Expected: 5 (분석 항목 1~5번)

- [ ] **Step 3: Commit**

```bash
git add plugins/resume/.claude/agents/retrospective.md
git commit -m "$(cat <<'EOF'
feat(agents): retrospective 백스테이지 에이전트 신규

Round 3 마무리에 호출되어 세션 메타피드백 회고 md 생성.
분석 항목 5개: 질문 품질, 직접입력 빈도, 미해결 findings,
라운드별 turn 배분, 다음 세션 개선 제안.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: SKILL.md Round 3 마무리 시퀀스에 retrospective 단계 추가

**Files:**
- Modify: `plugins/resume/skills/resume-panel/SKILL.md` (Round 3 "최종 산출" 섹션, line 543~611 영역)

기존 8단계 마무리 시퀀스 뒤에 9, 10번을 추가.

- [ ] **Step 1: 단계 8 다음에 9, 10단계 삽입**

기존 `**8. resume-draft.md 파일(들) 쓰기**` 블록(line 606-611) 다음에 추가:

```markdown
**9. 회고 분석 호출**

`retrospective` 에이전트를 호출한다. 다음 컨텍스트를 함께 전달:

- 세션 대화 요약 (오케스트레이터가 라운드별 주요 turn을 정리한 텍스트)
- `.resume-panel/findings.json` 전체 내용
- `resume-source.json`의 episodes 요약 (회사별 개수, STAR 충실도)
- 세션 메타데이터:
  - 시작 시각: `.resume-panel/meta.json` 또는 첫 turn 시각
  - 종료 시각: 현재 시각
  - 라운드별 turn 수: 오케스트레이터가 카운트

리턴값은 마크다운 텍스트.

**10. 회고 파일 저장 + 안내**

세션 ID 생성: `YYYYMMDD-HHMMSS` 형식 (예: `20260420-143052`).

```bash
mkdir -p docs/retrospectives
```

리턴된 마크다운을 `docs/retrospectives/{date}-{session-id}.md`로 Write. 예: `docs/retrospectives/2026-04-20-20260420-143052.md`.

저장 후 유저에게 한 줄 안내:
```
세션 회고를 docs/retrospectives/{filename}.md에 저장했어. 다음 세션 시작 전에 한 번 훑어봐.
```
```

- [ ] **Step 2: 삽입 결과 검증**

Run:
```bash
grep -n "^\*\*9\.\|^\*\*10\." plugins/resume/skills/resume-panel/SKILL.md
```

Expected:
- `**9. 회고 분석 호출**` 1회
- `**10. 회고 파일 저장 + 안내**` 1회

Run:
```bash
grep -n "retrospective\|docs/retrospectives" plugins/resume/skills/resume-panel/SKILL.md
```

Expected: 최소 3회 등장 (에이전트 호출 + mkdir + Write 경로)

- [ ] **Step 3: Commit**

```bash
git add plugins/resume/skills/resume-panel/SKILL.md
git commit -m "$(cat <<'EOF'
feat(skill): Round 3 마무리에 retrospective 호출 단계 추가

기존 8단계 마무리 시퀀스 뒤에 9 (retrospective 호출)
+ 10 (docs/retrospectives/ 저장 + 안내) 추가.
세션 ID 형식: YYYYMMDD-HHMMSS.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: docs/retrospectives 디렉토리 신설

**Files:**
- Create: `docs/retrospectives/.gitkeep`

빈 디렉토리를 git이 추적할 수 있도록 `.gitkeep` 추가.

- [ ] **Step 1: 디렉토리 + .gitkeep 생성**

Run:
```bash
mkdir -p docs/retrospectives
touch docs/retrospectives/.gitkeep
```

- [ ] **Step 2: 디렉토리/파일 존재 검증**

Run:
```bash
ls -la docs/retrospectives/.gitkeep
```

Expected: 0바이트 파일 존재

- [ ] **Step 3: Commit**

```bash
git add docs/retrospectives/.gitkeep
git commit -m "$(cat <<'EOF'
chore: docs/retrospectives/ 디렉토리 신설

Round 3 마무리에서 회고 마크다운이 저장될 위치.
빈 디렉토리 git 추적용 .gitkeep.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: 통합 검증 (smoke check)

**Files:**
- Read-only 검증

LLM 동작에 의존하므로 풀 end-to-end는 별도 세션에서 수동으로 확인. 이 태스크는 정적 일관성만 점검한다.

- [ ] **Step 1: 9개 에이전트 모두 frontmatter `tools:` 보유**

Run:
```bash
for f in plugins/resume/.claude/agents/*.md; do
  echo "--- $f"
  awk '/^---$/{c++; next} c==1' "$f" | grep -E '^(description|model|tools):' || echo "MISSING FIELD"
done
```

Expected: 9개 파일 각각 description / model / tools 3줄 출력. "MISSING FIELD" 없음.

- [ ] **Step 2: SKILL.md 게이트/회고 단계 존재 확인**

Run:
```bash
grep -nE "0\.1 환경 체크|claude mcp list|9\. 회고 분석 호출|10\. 회고 파일 저장|docs/retrospectives" plugins/resume/skills/resume-panel/SKILL.md
```

Expected: 최소 5건 매칭

- [ ] **Step 3: docs/retrospectives 디렉토리 존재**

Run:
```bash
test -d docs/retrospectives && test -f docs/retrospectives/.gitkeep && echo "OK"
```

Expected: `OK`

- [ ] **Step 4: git log 마지막 7개 커밋 확인**

Run:
```bash
git log --oneline -7
```

Expected: Task 1~7의 커밋 7개가 위에서부터 역순으로 출력됨.

- [ ] **Step 5: 수동 smoke 안내 (이 단계는 다음 세션에서)**

다음 세션에서 새로 `resume`을 호출하여 다음을 수동 확인:
- Round 0 시작 시 환경 체크 단계가 실행되는지 (Bash 호출 발생)
- 짧은 인터뷰 후 Round 3 마무리에서 회고 파일이 `docs/retrospectives/`에 생성되는지
- 각 에이전트 호출 시 `tools:` 화이트리스트가 적용되는지 (Claude Code 런타임이 거부 처리)

이 검증은 본 플랜 범위 밖이며, 다음 세션의 책임.

---

## Self-Review Checklist (작성자 확인)

- [x] 스펙의 변경 1 (툴 화이트리스트) → Task 1, 2, 8
- [x] 스펙의 변경 2 (Playwright MCP 게이트) → Task 4
- [x] 스펙의 변경 3 (회고 md) → Task 5, 6, 7
- [x] researcher.md "degraded" 문구 정리 → Task 3
- [x] 모든 코드/명령은 placeholder 없이 실제 내용 포함
- [x] 각 task는 verify + commit 단계 포함
- [x] 파일 경로는 모두 절대 경로 또는 repo-relative 명시
