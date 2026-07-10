# salvo (v0.12.0)

salvo의 첫 크로스호스트 실행 표면은 **Leg**다. 호스트별 명시 호출 이름만 다르다.

| 호스트 | 호출 |
|---|---|
| Codex | `$leg` |
| Claude Code | `/salvo:leg` |

두 호출 모두 같은 외부 Node 상태기계를 사용한다. 상태기계는 비대화식 Codex 또는
Claude Code를 task 하나씩 호출하고, 모델의 "완료했습니다"가 아니라 선언된 파일
변화와 검증 명령의 실제 성공만으로 다음 번호를 연다. `N..M` 범위는 시작할 때
동결되며, 범위 생략이나 옵션 오타는 전체 plan 실행으로 확대되지 않고 즉시
거절된다. 모든 task가 통과한 뒤에도 task별 검증과 전체 회귀 검증을 다시 실행한다.

`/goal`은 부모 세션을 오래 살려 두는 보조 장치로 함께 쓸 수 있지만 완료 권한은
없다. worker는 `candidate`만 제출하며, 외부 ledger와 evidence receipt를 소유한
controller만 `passed`를 기록한다. 첫 blocker 자기보고도 정지 권한이 없다. 새
컨텍스트가 같은 구체적 사용자 필요를 독립적으로 확인해야 멈춘다.

검증기가 artifact를 변경하면 workspace를 오염시킨 것으로 보고 즉시 봉쇄한다.
오염 전 스냅숏이 복원되기 전에는 resume할 수 없고, 최종 검증 receipt는 시도별로
보존된다. acceptance test와 verifier program은 plan의 `protected`에 넣어 worker가
약화하지 못하게 해야 한다.

라우팅 문+엔진은 2026-07-10 `plugins/psepha`로 분리 (이름 salvo는 numen 생태계 행동 계층으로 반납).
