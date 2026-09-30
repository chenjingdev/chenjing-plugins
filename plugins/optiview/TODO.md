# OptiView 할 일

## 지금(0.8.0 개발판)

- [ ] cmux에서 사람이 직접 확인
  - 같은 워크스페이스의 두 분할을 클릭해 오가기
  - 워크스페이스 바꾸기
  - 셸 분할을 눌렀을 때 마지막 대화가 남는지
  - `/optiview:open --dock`: Dock에 한 번만 붙는지, 워크스페이스를 옮겨도 보이는지(창 전체 Dock인지). 괜찮으면 cmux 안에서의 기본값을 Dock으로 바꾼다
- [ ] 분할 본문 클릭이 `surface.focused` 이벤트로 모두 잡히는지 확인한다. 못 잡는 경우가 있으면 "보이는 워크스페이스에서 친 질문" 규칙이 보완한다.
- [ ] Dock 브라우저의 주소창 숨기기. CLI에는 옵션이 없고 `dock.json`의 `"chrome": false`로만 된다.

## 다음

- [ ] **Orca 포커스 연동**(`lib/hosts/orca.mjs`)
  - 세션과 칸 잇기는 이미 된다(`ORCA_PANE_KEY`).
  - 포커스는 런타임 소켓에 직접 붙어 가져온다.
    - 인증: `~/Library/Application Support/orca/orca-runtime.json`의 소켓 경로와 토큰. 토큰은 Orca를 켤 때마다 바뀐다.
    - 순서: `worktree.ps`에서 `isActive`인 워크트리 → `session.tabs.list`에서 `isActive`인 터미널 행의 `leafId`.
    - 주기는 0.5~1초, 읽기 창이 보일 때만.
  - Orca가 설치된 맥에서 확인해야 한다.
- [ ] Orca에 기여 제안: `terminal.focused` RPC와 포커스 변경 이벤트(long-poll). 들어가면 폴링을 없앨 수 있다.
- [ ] **구조 2단계**: 실제 답(본인·동료)을 분석해 케이스를 나눈다.
  - 예: 완료 보고, 실패·원인, 선택 요청, 파일 목록, 긴 조사.
  - 케이스별 컴포넌트를 디자이너와 정한다.
  - 문장 보존 검사는 그대로 유지한다.
- [ ] 답 속 파일 경로를 누르면 편집기나 cmux로 열기.
