# salvo

혼자 한 발 쏘는 대신, 독립된 여러 문이 일제히 쏘고 순수 규칙으로 모은다 —
교집합(`/spec-gate`)·합집합(`/sweep`)·합의(`/vet`)의 Claude Code 하네스.
그리고 그 무기고를 쥐는 팔(`/leg`) — 대략적 미션을 자율 주행하다 취향 갈림에서
멈춰 인계한다. 원리: **모델이 알아서 복원해야 했던 것을 구조가 실어 나르게 한다.**

## 파이프라인

아이디어 → `/spec` (인터뷰·작성) → `/spec-gate` (콜드 리드 실측, 확정 blocking 0까지)
→ 구현 세션에 인계 (superpowers writing-plans 권장) → 코드

규칙: **게이트 통과(`Gate: passed`) 전에는 구현을 시작하지 않는다.**

## 스킬

- `/spec <아이디어>` — 모드 자동 판별(기능/시스템), 한 질문 인터뷰,
  Decision Ledger 기록, `specs/NNN-slug/SPEC.md` 생성
- `/spec-gate <spec 경로> [--reader <model>] [--readers <N>]` — 도구 없는
  cold-reader **N명(기본 3)이 병렬** 콜드 리드 → 앵커 기반 합의 집계(2인 이상
  = 확정 blocking) → 확정 0건까지 선택지 인터뷰 환류. 콜드 리드 전 기계
  린트(필수 섹션 공백·마커 잔존 시 반려)가 바닥 검사. `gate-report.md` 기록
- `/vet <질문>` — 옵트인 답변 게이트(자동 발동 없음). C-n 초안 → 렌즈 3검증자
  (opus) 병렬 반박 → **2표 합의만 확정 반박** → 확정 반박 있으면 수정+1회 재검증.
  단일 답변의 정밀도 도구
- `/sweep <찾을 대상>` — "전부 찾아라·빠짐없이·audit·커버리지"형 요청용. 독립
  파인더 **N명(기본 2)을 병렬** 스폰 → 앵커+메커니즘 기준 **기계적 합집합**으로
  리콜 극대화(무상관 누락이 서로를 메움. B7 실측: 단일 패스 11~12/12 → 2패스
  합집합 12/12, 3패스 한계 수확 0). 패스 간 이견 없으면 N=2에서 종료. vet=정밀도,
  sweep=리콜의 직교 도구
- `/leg <대략적 미션>` — 원샷과 루프 엔지니어링 사이. 러프한 미션을 받아 top-level
  task **3~4개(기본 상한 4)를 선언**하고 **자율 주행(각 task에 검증 포함)** →
  **제품 취향 갈림(변주 지점)에서 멈춰** `legs/NNN.md`에 **30초 복구용 평문
  보고서**를 남긴다. 무기고를 쥐는 팔: leg 안에서 `/sweep`·`/vet`·`/spec-gate`를
  스스로 호출. 체크포인트("task N까지만")와 다이얼(top-level task 상한) 지원

## 설계 문서

`docs/superpowers/specs/2026-07-06-fableus-harness-design.md` (G-1~G-12 계약 포함)

## 출처

spec 템플릿과 specify/clarify 흐름은 [github/spec-kit](https://github.com/github/spec-kit)
(MIT)에서 흡수해 Claude Code 전용으로 개작했다.
