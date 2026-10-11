# 설치와 운영

## 요구 사항

- macOS, Python 3.9 이상과 venv/pip, Claude Code.
- Computer Use를 사용할 수 있는 Codex 데스크톱 앱. 최초 macOS 접근성·화면 기록 권한 등은 원본 앱에서 설정합니다.
- 최초 의존성 설치 시 Python 패키지 저장소에 접근할 수 있는 네트워크.

## 공개 마켓 설치

```sh
claude plugin marketplace add chenjingdev/chenjing-plugins
claude plugin install codex-computer-use@chenjing-plugins --scope user
```

Claude에서 `/codex-computer-use:setup`을 실행합니다. 또는 설치된 플러그인의 루트에서 `./setup.sh install`을 실행합니다. 스킬은 `${CLAUDE_PLUGIN_ROOT}`를 사용하므로 사용자 이름이나 버전별 캐시 경로를 하드코딩하지 않습니다.

설치 후 `~/.local/bin/codex-cua` 명령을 사용합니다. `~/.local/bin`이 PATH에 있으면 `codex-cua`만 입력해도 됩니다.

- `codex-cua setup`: 전용 Python 환경과 명령을 준비하거나 갱신합니다.
- `codex-cua doctor`: 설치 위치와 호스트 준비 상태를 읽기 전용으로 진단합니다.
- `codex-cua doctor --probe --json`: 원본 호스트 연결을 검사하고 요약 JSON을 반환합니다.
- `codex-cua start`: 연결 가능한 방식으로 Codex를 실행합니다. 이미 연결된 호스트는 유지하고, 일반 방식으로 실행 중인 앱은 정상 종료 안내를 반환합니다.
- `codex-cua uninstall`: 실행 중인 호스트가 없는 상태에서 연결용 명령과 실행 환경을 제거합니다.

설정 명령은 Codex 앱을 강제 종료하지 않습니다. 기존 작업을 마친 뒤 앱을 정상 종료하고 다시 시작해야 할 수 있습니다. 원본 앱·모델 설정·사용자 권한 파일은 수정하지 않습니다.

## 로컬 시험판에서 전환

공개 마켓 설치본을 검증한 뒤 예전 로컬 ID만 제거합니다.

```sh
claude plugin uninstall codex-computer-use@chenjing-computer-use-local --scope user
claude plugin marketplace remove chenjing-computer-use-local
```

이전 Claude 세션은 이미 불러온 MCP 프로세스를 유지할 수 있습니다. 작업을 마친 후 새 세션으로 연결합니다. 전체 Claude 프로세스나 공용 Codex 서버를 종료하지 않습니다.

## 설치 위치와 고급 설정

기본 호스트 상태는 `~/Library/Caches/codex-host-cua` 아래에 보관합니다. 디렉터리는 현재 사용자 소유의 비공개 경로여야 합니다. 설정 시 출력되는 전용 가상 환경을 사용하며 시스템 Python에 패키지를 설치하지 않습니다.

기본 탐색 위치 밖에 앱이 있으면 `CODEX_CUA_APP_PATH`에 원본 `.app`의 절대 경로를 지정합니다. 호스트 상태 경로는 `CODEX_HOST_CUA_STATE_DIR`로 바꿀 수 있습니다. 환경을 바꾼 경우 호스트와 Claude MCP가 같은 상태 경로를 사용해야 합니다. 임의의 소켓·다른 사용자의 호스트·실행 파일로 연결 검사를 우회하지 않습니다.

## 연결이 끊겼을 때

1. `codex-cua doctor --probe`로 설치된 앱, 호스트 준비 상태와 연결을 확인합니다.
2. 앱 업데이트 또는 일반 실행으로 호스트가 사라졌다면 작업을 마치고 정상 종료한 뒤 `codex-cua start`를 실행합니다.
3. Claude Code의 새 세션에서 `/mcp`를 확인합니다.
4. 원본 catalog 또는 내부 RPC가 변경됐다는 오류라면 플러그인 업데이트를 확인합니다.

실패한 클릭·입력·전송을 자동으로 재실행하지 않습니다. `file://` 같은 URL 거부와 원본 REPL 파일 접근 오류는 연결 재시도로 해결되는 문제가 아닙니다.
