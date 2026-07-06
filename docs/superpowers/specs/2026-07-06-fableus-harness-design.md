# fableus 하네스 설계 (Fable-비의존 spec 파이프라인)

> status: draft — 사용자 리뷰 대기
> date: 2026-07-06
> plugin working name: `fableus` (개명 가능)

## 1. 배경과 목적

3일 후 Fable 5는 정액제에서 빠지고 종량제(크레딧)로만 접근 가능해진다. 이에 대비해 하루 동안 실측한 결과:

- **격리 A/B (llm-bench 방식, 하네스·설정 전부 차단, 3과제 × 2모델)**: 중간 난이도 단발 과제에서 Fable 5와 Opus 4.8은 사실상 무승부. 둘 다 심긴 모순을 자발적으로 잡았고, 같은 기술 해법에 독립 수렴했다. 비용은 Fable이 콜당 ~2배.
- **원본 세션 대조 (agrune 순수 Fable vs 순수 Opus, whisper 혼합)**: 세션에서 체감되는 큰 차이(사용자 개입 7회 vs 218회)는 대부분 superpowers 하네스와 과제 성격의 효과였다.
- **남는 차이의 실체**: 지능의 크기가 아니라 *모호함 아래에서 가정의 적중률* — ① 맥락에서 의도 복원 ② 물을지/가정할지 캘리브레이션 ③ 긴 호흡에서의 오차 복리. ("알잘딱"의 분해)

**결론: Fable을 파이프라인에서 완전히 제거한다.** 품질은 모델이 아니라 구조가 지킨다. 이 시스템의 단일 명제:

> **모델이 알아서 복원해야 했던 것을 구조가 실어 나르게 한다.**

부수 효과: 특정 모델 비의존이므로 모델 세대가 바뀌어도 그대로 동작한다.

## 2. 분업 원칙

| 역할 | 담당 | 근거 |
|---|---|---|
| 인터뷰·spec 작성 | Opus + 이 하네스 | A/B 무승부. 품질은 게이트가 보증 |
| spec 품질 판정 | Opus 콜드 리더 (서브에이전트) | 신선한 눈 > 작성자 지능 (작성자 자신이 낸 모순을 콜드 리더가 잡음 — 실측) |
| plan → tasks → 구현 | Opus 세션 | 기존 superpowers 체계와 연속 |
| 축이 갈리는 최종 판단 | **사용자 (의도의 주인)** | 에스컬레이션 대상은 더 비싼 모델이 아니라 인간. Opus도 "작성자 의도를 추측하기엔 위험하다"며 같은 행동을 보임 |

## 3. 파이프라인

```
[아이디어]
   ↓  /spec — 인터뷰(선택지+직접입력, 한 질문 룰) + spec 작성
   ↓         [NEEDS CLARIFICATION] 마커 → 선택지 질문으로 해소
[specs/NNN-slug/spec.md]
   ↓  /spec-gate — Opus 콜드 리더가 문서만 읽고 실측
   ↓         blocking 이슈 → 선택지 질문으로 사용자 환류 → spec 보강 → 재실행
[spec.md + gate-report.md, gate: passed]
   ↓  (Opus 구현 세션) plan → tasks → 구현    ← superpowers writing-plans 등 기존 체계
[코드]
```

역사적 실증: whisper 세션(2026-06-13)에서 Fable이 설계+계획서를 남기고 모델 중단으로 퇴장하자, Opus가 계획서만 읽고 구현을 완주했다. 이 파이프라인은 그 사건의 체계화다.

## 4. 컴포넌트

### 4.1 플러그인 구조 (chenjing-plugins 신규)

```
plugins/fableus/
├── .claude-plugin/plugin.json
└── skills/
    ├── spec/                    # spec-kit specify+clarify 흡수·통합판 (한국어화)
    │   ├── SKILL.md
    │   └── references/
    │       ├── spec-template.md         # 기능 단위 (brownfield 기본)
    │       ├── spec-template-system.md  # Symphony급 시스템 단위 (greenfield)
    │       ├── plan-template.md         # 참고용 — 기본 인계는 superpowers writing-plans
    │       └── tasks-template.md        # 〃 (spec-kit식 산출물을 원하는 세션만 사용)
    ├── spec-gate/               # 신규 개발 — 콜드 리드 실측 게이트
    │   ├── SKILL.md
    │   └── references/
    │       ├── reader-prompt.md         # 콜드 리더 프롬프트 (4분류+2축 지시)
    │       └── gate-report-template.md
    └── (운영 문서는 plugins/fableus/README.md)
```

spec-kit은 **설치하지 않는다**. 채용분만 흡수(MIT, README에 출처 표기), 프로젝트별 `specify init` 세리머니 제거 — 플러그인 스킬이 전역에서 동작하며 첫 실행 시 `specs/NNN-slug/`를 직접 만든다.

### 4.2 spec-kit 채택 결정 (2026-07-06 시운전 근거)

- **흡수**: specify(348줄)·clarify(288줄) 흐름, spec/plan/tasks 템플릿, `specs/NNN-slug/` 디렉터리 관례
- **버림**: checklist(정적 점검 — 게이트가 실측으로 대체), analyze(역할 중복), taskstoissues(이슈 운용 없음), implement(superpowers가 대체), extensions.yml(우리는 진짜 스킬 체계가 있음)
- **보류**: constitution(게이트에 "원칙 위반" 분류가 필요해지면), converge
- **Claude 전용 업그레이드**: spec-kit이 30개 에이전트 호환 때문에 못 쓴 프리미티브를 사용 — 콜드 리더의 맥락 격리를 프롬프트 관례가 아니라 **서브에이전트 스폰으로 구조적으로 보장**, 질문은 AskUserQuestion 네이티브 사용

### 4.3 /spec-gate 동작 규칙 (확정 사항)

시운전 게이트 spec(`~/dev/tmp-speckit-trial/specs/001-dryrun-gate/spec.md`)과 그에 대한 Opus 콜드 리드 라운드 1 결과를 반영한 확정치:

| # | 결정 | 내용 |
|---|---|---|
| G-1 | 대상 | spec.md 단일 문서. plan/tasks는 게이트 대상 아님 |
| G-2 | 격리 | 완전 텍스트 격리 — 콜드 리더는 spec 본문만 프롬프트로 받고 도구 사용 금지. 리포트 기록은 오케스트레이터(스킬)가 수행 |
| G-3 | 분류 | 독립 2축 — 카테고리 4종(질문/결정/용어/수락기준: *고치는 방법* 안내)과 심각도 2종(blocking/discretionary: *통과 판정*). 범위 밖(out-of-scope)은 제3의 표시 라벨 |
| G-4 | 통과 기준 | blocking 0건. discretionary는 정보성 표시만 |
| G-5 | 쓰기 경계 | 게이트는 읽기 전용 — gate-report.md에만 기록. spec frontmatter의 `gate:` 필드는 작성 세션이 통과 확인 후 도장 |
| G-6 | 제안 답변 | blocking 이슈마다 콜드 리더가 제안 A/B/C 첨부("실행자 추측" 라벨). 작성 세션이 AskUserQuestion으로 사용자에게 환류, 명시 채택 시만 spec 반영 |
| G-7 | waive | waive = 작성자가 spec 본문에 "이 항목은 구현자 재량" 한 줄을 추가하는 행위로 정의. 문서 안에 답이 생기므로 기억 없는 콜드 리더가 자연히 재제기하지 않음 (콜드 리드 순수성 유지) |
| G-8 | 수렴 상한 | 최대 3라운드. 도달 시 강제 종료 + 잔여 보고, 사용자가 waive 또는 보강 후 재시작 |
| G-9 | 리더 모델 | 일반 파라미터, 기본 `opus`. 특정 모델 전용 기능 없음 |

엣지 케이스: 파일 없음/빈 파일 → 실행 거부. 서브에이전트 스폰 실패 → 실패 기록, 부분 결과 없음. 문서가 컨텍스트 한도 초과 → 거부 + 축소 권고.

### 4.4 spec 템플릿 보강 (spec-kit 원본 대비 추가)

1. **Decision Ledger** 섹션 — 내린 결정 + 근거 + 기각한 대안. (전제 신선도 확인의 전제 조건: 근거가 기록돼야 나중에 유효성을 검증할 수 있다)
2. **Assumptions 강제** — 무단 가정 금지, 가정은 선언 (spec-kit 원본 유지·강조)
3. **greenfield 변형** (spec-template-system.md): Symphony SPEC.md 스타일 — 상태 모델/이벤트 흐름/데이터 모델(story-spec L6 스키마 이식), 에러 분류, "implementation-defined"(구현자 재량) 명시 위임 관례. 알고리즘 의사코드 수준은 쓰지 않는다(실측: Opus는 "값"은 재량으로 정하고 "축"만 필요로 함)

### 4.5 하네스 규칙 (운영 문서 + 사용자 CLAUDE.md 후보 2줄)

1. **전제 신선도**: 과거 결정을 상속하기 전에 그 근거가 지금도 유효한지 확인하라. (실측된 실패 모드: 낡은 문서의 철학을 신선도 검증 없이 프레임에 상속)
2. **가정 선언**: 무단 가정 금지 — 가정했으면 Assumptions에 기록하라.

### 4.6 Claude Code 전용 활용 (사용자 지시 2026-07-06: "클루드코드 제공 시스템을 최대한 활용")

spec-kit이 30개 에이전트 호환 제약으로 포기한 프리미티브를 전부 사용한다. 원칙: **모델의 순종에 맡기던 규칙을 하네스가 강제하는 구조로 승격.**

| 프리미티브 | 용도 | 버전 |
|---|---|---|
| 커스텀 서브에이전트 정의 (`agents/cold-reader.md`, tools 없음) | 콜드 리더의 맥락·도구 격리를 프롬프트 관례가 아니라 **정의 수준에서 보장** (G-2 구현체) | v1 |
| 백그라운드 서브에이전트 + 완료 알림 | 게이트 1라운드 실측 ~7분 — 작성 세션을 블로킹하지 않음 | v1 |
| AskUserQuestion | 인터뷰·clarify·게이트 환류의 선택지+직접입력 UX | v1 |
| Agent tool `model` 파라미터 | 리더 모델 지정 (G-9) | v1 |
| 플러그인 SessionStart 훅 | 하네스 규칙 2줄을 전 세션에 자동 주입 (CLAUDE.md 수정 불요) | v1 (D3) |
| PreToolUse 게이트 가드 (opt-in) | spec이 존재하는데 `gate: passed`가 없으면 구현 파일 쓰기를 경고/차단 — "게이트 통과 전 구현 금지"를 하네스가 강제 | v2 |

## 5. 테스트 계획

1. **도그푸딩**: /spec-gate 스킬 자체의 spec이 이미 존재(시운전 산출물). 이를 이 파이프라인의 첫 통과 spec으로 라운드 2 완주 → superpowers writing-plans로 인계 → Opus로 구현
2. **SC 검증**: 모호 항목 3개를 심은 벤치 spec으로 1라운드 전부 포착하는지 확인 (라운드 1 실측: Opus 콜드 리더가 작성자 미인지 모순 4건 발견 — 통과)
3. **사후 검증 루프 (후순위)**: "하네스 있는 Opus vs 맨몸 Opus"의 되묻기·오가정 수 비교 (알잘딱 벤치 — llm-bench 다중턴 러너 활용, v1 범위 밖)

## 6. v1 범위 (Fable 정액제 잔여 3일)

- D1: 본 설계 확정 → 플러그인 뼈대 + 템플릿 흡수·보강
- D2: /spec-gate 구현 + 도그푸딩 1회 완주
- D3: /spec (specify+clarify 통합판) + 운영 문서 + 하네스 규칙 배치

범위 밖: constitution/converge 흡수, 알잘딱 벤치, spec-kit 업스트림 추적 자동화.

## 7. 관련 자산

- story-spec 플러그인: 그대로 둠. L6 스키마만 greenfield 템플릿에 이식
- superpowers: 구현 단계 인계 대상 (writing-plans → executing-plans/subagent-driven)
- 시운전 산출물: `~/dev/tmp-speckit-trial/` (게이트 spec + 라운드 1 리포트 원문)
- 실험 원자료: A/B 출력 6건 (`~/.claude/jobs/620543eb/tmp/modelab/`), 세션 발췌 4건 (동 tmp)
