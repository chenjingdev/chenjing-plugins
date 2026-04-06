# TODO

## 1. Round 0 순서 변경: 기존 자료 먼저 받기

**현재**: 기본 정보 수집(이름/나이/경력/회사/타겟) → 기존 자료 수집  
**변경**: 기존 자료 수집 → 파싱 → 자동 채움 → 빈 칸만 확인

### 이유

이력서/포트폴리오에 이름, 나이, 다녔던 회사, 기술 스택이 이미 있다.
먼저 받으면 기본 정보 질문을 대부분 건너뛸 수 있어서 체감 속도가 확 다르다.

### 변경 대상

- `plugins/resume/skills/resume-panel/SKILL.md` — Round 0 섹션
  - Step 1: 세션 시작 (기존 resume-source.json 확인) — 유지
  - Step 2: **기존 자료 수집** (현재 Step 3) → Step 2로 이동
  - Step 3: **기본 정보 확인** — 자료에서 추출한 값을 보여주고 맞는지 확인. 빈 칸만 묻기
  - Step 4~6: 리서처 실행, 초기 저장, 상태 초기화 — 유지

### 구현 포인트

- 이력서 파싱 시 추출할 항목: 이름, 나이/생년월일, 경력 연수, 회사 이름들, 기술 스택, 직무/직급
- PDF/DOCX/텍스트/URL 다 커버해야 함 (현재 "파일 경로, URL, 텍스트 붙여넣기" 지원 명시됨)
- 타겟 회사/포지션은 이력서에 없으므로 반드시 직접 수집

---

## 2. 리서처 브라우저 fallback: Playwright MCP

**상황**: WebSearch/WebFetch가 차단되거나 실패할 때 리서처가 조사를 못 함

### 변경 대상

- `plugins/resume/.claude/agents/researcher.md` — 조사 실패 시 Playwright MCP fallback 로직 추가

### 구현 포인트

- WebSearch → 실패 시 `mcp__playwright__browser_navigate` + `mcp__playwright__browser_snapshot`으로 대체
- 검색엔진 직접 접근: Google/Naver 검색 URL 구성 → navigate → snapshot에서 결과 파싱
- 회사 홈페이지/채용 페이지 직접 크롤링
- Playwright 브라우저도 안 될 경우 유저에게 수동 정보 요청으로 graceful degradation
