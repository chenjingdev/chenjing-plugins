# fableus

Fable 없이 Opus만으로 "알잘딱" spec을 만드는 Claude Code 하네스.
원리: **모델이 알아서 복원해야 했던 것을 구조가 실어 나르게 한다.**

## 파이프라인

아이디어 → `/spec` (인터뷰·작성) → `/spec-gate` (콜드 리드 실측, blocking 0까지)
→ 구현 세션에 인계 (superpowers writing-plans 권장) → 코드

규칙: **게이트 통과(`Gate: passed`) 전에는 구현을 시작하지 않는다.**

## 스킬

- `/spec <아이디어>` — 모드 자동 판별(기능/시스템), 한 질문 인터뷰,
  Decision Ledger 기록, `specs/NNN-slug/spec.md` 생성
- `/spec-gate <spec 경로> [--reader <model>]` — 도구 없는 cold-reader
  서브에이전트가 문서만 읽고 blocking/discretionary 판정,
  `gate-report.md` 기록, blocking은 선택지 질문으로 환류

## 설계 문서

`docs/superpowers/specs/2026-07-06-fableus-harness-design.md` (G-1~G-9 계약 포함)

## 출처

spec 템플릿과 specify/clarify 흐름은 [github/spec-kit](https://github.com/github/spec-kit)
(MIT)에서 흡수해 Claude Code 전용으로 개작했다.
