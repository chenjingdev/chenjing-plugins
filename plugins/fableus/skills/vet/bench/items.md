# vet 벤치 — 10문항 + 정답 키

**상태**: 초안 — 저자 검수 대기  <!-- 초안 | 확정 (저자 검수 완료 후에만 벤치 실행) -->
**근거**: FR-018 (10문항·정답 키·실측 근거), I-11 (채점 = 일치/모순/무언급, 모순만 확정 오류), 2026-07-07 결정 (도메인 혼합, 구현 세션 출제 + 저자 검수)

## 형식
- **질문**: /vet에 그대로 넣을 한 문단.
- **도메인**: repo (chenjing-plugins 사실) | public (공개 기술 사실).
- **정답 키**: 핵심 사실 3~6항목, 각 항목에 실측 근거(파일:라인 또는 공식 출처).
- 하위 문자 항목(예: 3a/3b)은 각각 독립적으로 일치/모순/무언급을 판정한다 — 주 항목 번호 수는 3~6 규칙의 기준이고, 하위 항목은 그 세부 채점 단위다.
- 채점 절차는 `protocol.md` 참조.

---

## Q1 (repo)
**질문**: fableus 플러그인의 /spec-gate는 콜드 리더를 어떻게 격리하고, 통과 판정 기준과 라운드 상한은 어떻게 되어 있어?

**정답 키**:
| # | 핵심 사실 | 근거 |
|---|---|---|
| 1 | 리더에게 도구·저장소 접근을 주지 않고, spec 본문을 프롬프트에 직접 포함한다(파일 경로 금지) | plugins/fableus/skills/spec-gate/SKILL.md:53-60 |
| 2a | 확정 집계의 "같은 지점" = 앵커 일치 AND 논지 일치 — 동일 앵커라도 논지가 다르면 별개 이슈로 분리 집계 | plugins/fableus/skills/spec-gate/SKILL.md:71-73 |
| 2b | 확정 blocking = 같은 지점을 2인 이상이 제기한 것, 통과 = 확정 blocking 0건(1인 단독·discretionary는 정보성 표시만) | plugins/fableus/skills/spec-gate/SKILL.md:79-81,88 |
| 3 | 라운드 상한은 없다 — 중단은 사용자 몫 | plugins/fableus/skills/spec-gate/SKILL.md:32-34 |
| 4 | 집계에 별도 LLM 심판을 두지 않는다 | plugins/fableus/skills/spec-gate/SKILL.md:77-78 |

## Q2 (repo)
**질문**: tiers 플러그인의 deep-research 엔진은 검증(Verify) 단계에서 주장 하나를 몇 표로 판정하고, 판정 결과는 몇 가지로 나뉘어?

**정답 키**:
| # | 핵심 사실 | 근거 |
|---|---|---|
| 1 | 주장당 3표(VOTES_PER_CLAIM=3), 반박 2표(REFUTATIONS_REQUIRED=2) 이상이면 기각 | plugins/tiers/skills/deep-research/engine.js:40-41 |
| 2 | 판정은 3가지: survives / isRefuted / unverified(유효표 부족) | plugins/tiers/skills/deep-research/engine.js:290-303 |
| 3 | 인프라 실패(검증자 에러)는 "반박됨"으로 세지 않고 unverified로 분리한다 | plugins/tiers/skills/deep-research/engine.js:292,316-328 |

## Q3 (repo)
**질문**: resume-panel 플러그인에서 이력서 자료가 바뀔 때 프로파일러 에이전트가 자동으로 호출되는 조건이 궁금해. episode-watcher 훅이 어떤 변화 이벤트에 각각 몇 점을 매기고, 어느 누적 점수에 도달하면 프로파일러를 트리거하며, 트리거한 뒤 그 점수는 어떻게 처리돼?

**정답 키**:
| # | 핵심 사실 | 근거 |
|---|---|---|
| 1 | 누적 점수 임계값 THRESHOLD=5 — 도달 시 profiler_trigger를 emit하고 점수를 0으로 리셋한다 | plugins/resume/scripts/episode-watcher.mjs:702-703,709,759 |
| 2 | 에피소드 N개 증가 → +N, 새 프로젝트 이름 추가 → +3 (getProjectNames로 프로젝트 이름 집합만 비교 — "새 회사"를 독립적으로 감지하지는 않는다) | plugins/resume/scripts/episode-watcher.mjs:667-679 · 345-347 |
| 3a | 빈 STAR 증가 시 +2 (countStarGaps는 situation/task/action/result 중 하나라도 비면 gap으로 센다 — result만이 아니다) | plugins/resume/scripts/episode-watcher.mjs:681-687 · 355-368 |
| 3b | 역할 축소 키워드(도움/참여/지원/보조/서포트) 감지 시 +2 | plugins/resume/scripts/episode-watcher.mjs:689-691,371 |
| 3c | meta(target_company/position) 변경(해시 불일치) 시 +2 | plugins/resume/scripts/episode-watcher.mjs:695-697 · 349-352 |
| 4 | AskUserQuestion 호출은 별도 핸들러에서 +1 (그 핸들러도 5점 도달 시 emit + 리셋) | plugins/resume/scripts/episode-watcher.mjs:240,252,259 |
| 5 | 가산은 addProfilerScore 헬퍼가 하고 사유는 _score_reasons에 rolling(최근 10개) 누적 | plugins/resume/scripts/episode-watcher.mjs:483-492 |

## Q4 (repo)
**질문**: story-spec 플러그인의 인터뷰 방법론은 몇 개의 층으로 나뉘고 각 층은 어떻게 운영돼? 항상 적용되는 층과 사용자가 매번 고르는 층이 각각 몇 개고, 후자는 어떤 식으로 사용자에게 제시되는지 설명해줘.

**정답 키**:
| # | 핵심 사실 | 근거 |
|---|---|---|
| 1 | 방법론은 2층: Layer 1 메타 자세(전 단계 상시 적용) + Layer 2 전문 도구(매 LOD 진입 시 선택) | plugins/story-spec/skills/story-spec/methodologies/INDEX.md:3-6 |
| 2 | Layer 1은 5개(Clean Language·OARS·Yes-And·Bloom 게이지·System 1/2), 사용자에게 옵션으로 노출하지 않는다 | plugins/story-spec/skills/story-spec/methodologies/INDEX.md:12-22 |
| 3 | Layer 2는 17개이며 매 LOD 진입 시 1-3순위 + "직접 입력"으로 제시, 1순위에 ⭐ | plugins/story-spec/skills/story-spec/methodologies/INDEX.md:26 · 6 · 67-69 |
| 4 | LOD별 추천 1-3순위는 카테고리 가중치(category-weights.md)로 동적 조정된다 | plugins/story-spec/skills/story-spec/methodologies/INDEX.md:8 |
| 5 | AI는 자기 판단으로 방법론을 멋대로 전환하지 않고, 사용자가 "다른 방법으로" 요청할 때만 전환 | plugins/story-spec/skills/story-spec/methodologies/INDEX.md:81 |

## Q5 (repo)
**질문**: tiers 플러그인의 /tiers:ultracode 스킬은 멀티 에이전트 오케스트레이션에서 서브에이전트 모델을 어떻게 정해? 역할별로 티어를 다르게 두는지, 티어 값은 어디서 읽고 설정이 없으면 무엇으로 폴백하는지, 그리고 각 agent 호출이 지켜야 하는 계약이 뭔지 알려줘.

**정답 키**:
| # | 핵심 사실 | 근거 |
|---|---|---|
| 1a | 모든 서브에이전트가 하나의 고정 티어로 실행 — 세션 모델도, 자기 비용 판단도 아니다 | plugins/tiers/skills/ultracode/SKILL.md:10 |
| 1b | 역할별 티어 구분이 없다 — worker·verifier·synthesizer 모두 동일 티어 | plugins/tiers/skills/ultracode/SKILL.md:10 |
| 2 | 티어는 ${CLAUDE_PLUGIN_DATA}/ultracode.json의 {model, effort}에서 읽는다 | plugins/tiers/skills/ultracode/SKILL.md:14 |
| 3 | 파일이 없거나 못 읽으면 {"model":"opus","effort":"xhigh"}로 폴백 | plugins/tiers/skills/ultracode/SKILL.md:15 |
| 4 | 모든 agent() 호출은 정확히 {model, effort} 두 키를 실어야 하며, model 누락 시 값비싼 세션 모델을 조용히 상속한다 | plugins/tiers/skills/ultracode/SKILL.md:31 |
| 5 | 균일성이 핵심 — 단계별로 티어를 올리거나 내리지 않는다 | plugins/tiers/skills/ultracode/SKILL.md:32 |

## Q6 (repo)
**질문**: resume-panel 플러그인은 세션 컨텍스트가 커져 compact가 임박했을 때 작업 맥락이 끊기지 않도록 어떤 훅 장치를 두고 있어? 어떤 훅 이벤트에서 무슨 기준으로 경고를 발행하고, 토큰 양은 어떻게 추정하며, 중복 경고는 어떻게 억제하고, compact 직후에는 저장해둔 맥락을 어떻게 다시 불러오는지 설명해줘.

**정답 키**:
| # | 핵심 사실 | 근거 |
|---|---|---|
| 1 | UserPromptSubmit 훅에서 추정 토큰이 TOKEN_THRESHOLD=250,000 이상이면 compaction_warning을 emit | plugins/resume/scripts/episode-watcher.mjs:68-94 |
| 2 | 토큰 추정은 transcript 파일 크기 ÷ 4 (statSync size / 4) | plugins/resume/scripts/episode-watcher.mjs:624-633 |
| 3 | current-focus.md가 5분 이내에 저장돼 있으면 경고를 suppress(디바운스) | plugins/resume/scripts/episode-watcher.mjs:73-78 |
| 4 | PreCompact 훅은 backstop — current-focus.md가 없거나 5분 이상 stale이면 경고 발행 | plugins/resume/scripts/episode-watcher.mjs:99-125 |
| 5a | SessionStart 훅은 source=="compact"일 때만 재주입을 진행한다(아니면 즉시 종료) | plugins/resume/scripts/episode-watcher.mjs:129 |
| 5b | 저장된 focus의 session_id가 현재 세션 session_id와 일치해야 한다 | plugins/resume/scripts/episode-watcher.mjs:136 |
| 5c | 저장(saved_at) 후 30분 이내일 때만 유효(age > 30분이면 종료) | plugins/resume/scripts/episode-watcher.mjs:139-140 |
| 5d | 위 조건 충족 시 current-focus.md 원문(raw markdown)을 additionalContext로 재주입하되 [resume-panel] 프리픽스는 붙이지 않는다 | plugins/resume/scripts/episode-watcher.mjs:143-149 · plugins/resume/skills/resume-panel/references/hook-protocol.md:129 |

## Q7 (public)
**질문**: Claude Code의 훅(hooks) 시스템에 대해 설명해줘. 훅은 설정에서 어떤 구조로 등록하고, command 타입 훅은 이벤트 데이터를 어떻게 전달받아? 훅이 어떤 종료 코드로 동작을 차단하는지, 그리고 PreToolUse·PostToolUse·UserPromptSubmit·SessionStart·PreCompact가 각각 언제 발화하는지 알려줘.

**정답 키**:
| # | 핵심 사실 | 근거 |
|---|---|---|
| 1 | 훅은 설정의 최상위 "hooks" 객체 아래 이벤트 이름별로 등록하고, PreToolUse/PostToolUse는 matcher로 대상 도구를 선택한다 | https://code.claude.com/docs/en/hooks (Hook configuration) |
| 2 | command 타입 훅은 셸 명령을 실행하며 이벤트 데이터를 JSON으로 stdin에서 받는다 | https://code.claude.com/docs/en/hooks (Hook Types) |
| 3 | command 훅의 종료 코드 2는 blocking error — stderr가 Claude에 피드백되고 동작이 차단된다(exit 0 = 성공) | https://code.claude.com/docs/en/hooks (Exit Codes) |
| 4 | PreToolUse는 도구 호출 실행 전, PostToolUse는 도구 호출 성공 후에 발화한다 | https://code.claude.com/docs/en/hooks (All Hook Events) |
| 5 | UserPromptSubmit는 프롬프트 제출 직후·Claude 처리 전, SessionStart는 세션 시작/재개 시, PreCompact는 컨텍스트 compaction 직전에 발화 | https://code.claude.com/docs/en/hooks (All Hook Events) |

## Q8 (public)
**질문**: Claude Code가 읽는 settings.json은 어떤 위치들에 있고 각각 어떤 범위에 적용돼? 사용자·프로젝트·로컬·관리(managed) 설정 파일의 경로를 각각 알려주고, 같은 설정이 여러 곳에 있을 때 어느 것이 우선하는지 우선순위 순서를 설명해줘.

**정답 키**:
| # | 핵심 사실 | 근거 |
|---|---|---|
| 1 | 사용자 설정: ~/.claude/settings.json (모든 프로젝트 적용) | https://code.claude.com/docs/en/settings (File Locations) |
| 2 | 프로젝트: .claude/settings.json (소스 컨트롤 공유), 로컬: .claude/settings.local.json (gitignore, 커밋 안 함) | https://code.claude.com/docs/en/settings (File Locations) |
| 3 | 관리(managed) 경로: macOS /Library/Application Support/ClaudeCode/managed-settings.json, Linux /etc/claude-code/managed-settings.json, Windows C:\Program Files\ClaudeCode\managed-settings.json | https://code.claude.com/docs/en/settings (File Locations) |
| 4 | 우선순위(높음→낮음): Managed > 명령줄 인자 > Local > Project > User | https://code.claude.com/docs/en/settings (Precedence Order) |
| 5 | Managed 설정은 최상위이며 무엇으로도 덮어쓸 수 없다 | https://code.claude.com/docs/en/settings (Precedence Order) |

## Q9 (public)
**질문**: Claude Code 플러그인은 어떤 구성 요소를 담을 수 있고 디렉터리 구조는 어떻게 돼? 매니페스트 파일의 이름과 위치, 스킬·에이전트·훅·MCP 서버가 각각 어디에 놓이는지, 그리고 플러그인 스킬이 어떻게 이름 지어지는지 알려줘.

**정답 키**:
| # | 핵심 사실 | 근거 |
|---|---|---|
| 1 | 매니페스트는 플러그인 루트의 .claude-plugin/plugin.json이고, .claude-plugin/ 안에는 plugin.json만 둔다 | https://code.claude.com/docs/en/plugins (Plugin structure overview) |
| 2 | 구성 디렉터리는 .claude-plugin/이 아니라 플러그인 루트에 둔다: skills/, agents/, hooks/, commands/ | https://code.claude.com/docs/en/plugins (Plugin structure overview) |
| 3 | 스킬은 skills/ 아래 <name>/SKILL.md 디렉터리로 둔다 | https://code.claude.com/docs/en/plugins (structure table) |
| 4 | 훅은 hooks/hooks.json에, MCP 서버는 루트의 .mcp.json에 설정한다 | https://code.claude.com/docs/en/plugins (structure table) |
| 5 | 플러그인 스킬은 항상 네임스페이스가 붙는다: /plugin-name:skill-name | https://code.claude.com/docs/en/plugins (Why namespacing) |

## Q10 (public)
**질문**: Claude Code의 CLAUDE.md 메모리 파일은 어떤 범위(스코프)들에 놓일 수 있고 각 경로는 어디야? 여러 CLAUDE.md가 발견되면 서로 덮어쓰는지 아니면 합쳐지는지, @ 임포트 문법과 그 재귀 깊이 한계, 그리고 AGENTS.md와의 관계까지 설명해줘.

**정답 키**:
| # | 핵심 사실 | 근거 |
|---|---|---|
| 1 | 스코프별 경로: 사용자 ~/.claude/CLAUDE.md, 프로젝트 ./CLAUDE.md 또는 ./.claude/CLAUDE.md, 로컬 ./CLAUDE.local.md(gitignore), 관리 정책 macOS /Library/Application Support/ClaudeCode/CLAUDE.md · Linux/WSL /etc/claude-code/CLAUDE.md · Windows C:\Program Files\ClaudeCode\CLAUDE.md | https://code.claude.com/docs/en/memory (Choose where to put CLAUDE.md) |
| 2 | 발견된 CLAUDE.md들은 서로 덮어쓰지 않고 모두 context에 이어 붙는다(broad→specific 순서 로드) | https://code.claude.com/docs/en/memory (How CLAUDE.md files load) |
| 3 | CLAUDE.md는 @path/to/import 문법으로 다른 파일을 임포트하며, 임포트된 파일은 launch 시 함께 로드된다 | https://code.claude.com/docs/en/memory (Import additional files) |
| 4 | 임포트 재귀 최대 깊이는 4 hops이고, 상대 경로는 working directory가 아니라 임포트하는 파일 기준으로 해석 | https://code.claude.com/docs/en/memory (Import additional files) |
| 5 | Claude Code는 AGENTS.md가 아니라 CLAUDE.md를 읽는다 — AGENTS.md 재사용은 CLAUDE.md에서 @AGENTS.md로 임포트 | https://code.claude.com/docs/en/memory (AGENTS.md) |
