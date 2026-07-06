# System Specification: [SYSTEM NAME]

**Created**: [DATE]
**Status**: Draft
**Gate**: not-run

<!-- Symphony SPEC.md 스타일의 시스템 단위 구현 계약.
     원칙: "축"(상태·경계·계약·에러 분류)은 전부 박고, "값"(알고리즘 세부·
     필드명·포맷)은 implementation-defined로 위임한다. 의사코드 금지. -->

## 1. Purpose & Scope
[이 시스템이 존재하는 이유 한 문단. Out of scope 목록 필수.]

## 2. Domain Model
[핵심 엔티티와 관계. 엔티티별: 필드 목록 + 타입 + 제약 + 영속/휘발 여부.
 story-spec L6 Data model 작성 룰 준용: "todo는 텍스트와 시간을 갖는다"(нет) →
 "text: string, trim 후 1-200자"(да)]

## 3. State Model
[유한 상태 목록과 전이 조건. 모든 상태가 어떻게 진입하고 어떻게 떠나는지 빠짐없이.]

## 4. Event Flow
[이벤트 → 유효 상태 → 효과(순서 있는 목록) → 실패 시 동작. 번호 매김.]

## 5. Error Taxonomy
[타입화된 에러 목록 (예: missing_config, parse_error)과 각각의 처리 방침.]

## 6. Invariants (MUST) / Defaults (SHOULD) / Choices (MAY)
[RFC 2119 스타일. MAY 항목은 "implementation-defined:" 접두로 위임을 명시.]

## 7. Acceptance Criteria
[Given/When/Then, 외부 관찰 가능, 자동화 테스트로 옮길 수 있는 정밀도. 3개 이상.]

## Decision Ledger *(mandatory)*

| # | 결정 | 근거 (당시 사실) | 기각한 대안 |
|---|---|---|---|

## Deferred to Implementer *(waive 기록)*

## Assumptions
[명시되지 않아 합리적 기본값으로 채운 것들. 무단 가정 금지 — 전부 여기 선언.]
