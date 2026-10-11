# Codex Computer Use for Claude Code

Mac에서 Claude Code가 설치된 Codex의 브라우저·앱 제어 기능을 호출하는 MCP 플러그인입니다. **macOS 전용 · 비공식 실험 버전**입니다.

원본 Codex 앱과 CUA 실행 파일은 사용자가 직접 설치합니다. 이 패키지에는 연결기와 설정 도구만 들어 있습니다.

## 설치

```sh
claude plugin marketplace add chenjingdev/chenjing-plugins
claude plugin install codex-computer-use@chenjing-plugins --scope user
```

Claude Code의 새 세션에서 다음을 실행합니다.

```text
/codex-computer-use:setup
```

설정 스킬이 설치본의 `setup.sh install`을 실행합니다. Python 3.9 이상이 필요하며, `websockets==12.0`을 전용 가상 환경에 설치합니다. 첫 설치에는 패키지 다운로드가 필요합니다. Codex는 Computer Use를 사용할 수 있는 상태여야 합니다.

설정 후 연결을 확인하고, 필요하면 준비된 실행 명령으로 Codex를 엽니다.

```sh
~/.local/bin/codex-cua doctor --probe
~/.local/bin/codex-cua start
```

Codex가 일반 실행 방식으로 이미 켜져 있다면 진행 중인 작업을 마치고 정상 종료한 뒤 `codex-cua start`를 실행합니다. 이 명령은 앱을 강제 종료하지 않습니다. 연결된 호스트가 이미 준비됐다면 그대로 사용합니다.

이후 Claude Code의 새 세션에서 `/mcp`의 `codex-computer-use` 연결을 확인하고, "Codex CUA로 이 Mac 앱을 확인해 줘"처럼 작업을 요청합니다. 설치·업데이트 전에 열어 둔 세션은 이전 MCP 연결을 유지할 수 있습니다.

## 동작 방식

```text
Claude Code → MCP 연결기 → 실행 중인 Codex 서버 → 원본 CUA → Mac 앱·브라우저
                                  ↑
                             Codex 데스크톱 앱
```

`codex-cua start`는 원본 Codex 서버에 사용자 전용 Unix 소켓을 추가하는 실행 경로로 앱을 엽니다. 앱과 서버 사이의 JSONL/WebSocket 통신을 중계합니다. 원본 앱·CUA 파일은 수정하거나 복사하지 않으며 모델/API 설정도 변경하지 않습니다.

Claude 연결마다 Codex 서버가 발급한 전용 임시 대화를 만듭니다. Claude가 작성한 명령을 이 대화에서 실행하므로, 기존 Codex 채팅이나 전체 하네스 프롬프트를 공유하는 것은 아닙니다.

도구 목록과 사용 설명은 실행 중인 원본 CUA에서 읽습니다. `js`·`js_reset` 등은 원본 형식과 결과를 전달합니다. 종료 도구 `turn_ended`만 **빈 인자 `{}`**로 노출하며, 연결기가 자신의 대화·턴 식별자를 채워 전달합니다.

## 업데이트와 연결 복구

```sh
claude plugin marketplace update chenjing-plugins
claude plugin update codex-computer-use@chenjing-plugins --scope user
~/.local/bin/codex-cua setup
~/.local/bin/codex-cua doctor --probe
```

`codex-cua`는 설치된 공개 플러그인 위치를 찾아 실행하므로 버전별 캐시 경로를 직접 입력할 필요가 없습니다. Codex 앱 업데이트 후에는 작업을 마치고 앱을 정상 종료한 뒤 `codex-cua start`로 다시 시작합니다. Claude Code도 새 세션에서 연결합니다.

내부 인터페이스가 바뀌면 연결기 업데이트가 필요할 수 있습니다. 연결 실패 시 GUI 동작을 자동으로 재실행하지 않습니다.

## 지원 범위

- macOS와 로컬 Claude Code. Codex 앱은 `/Applications`와 사용자 `~/Applications`에서 탐색하며, 별도 위치는 [설치 안내](docs/installation.md)를 참고합니다.
- 원본 CUA가 제공하는 앱·브라우저 제어. 실제 대상별 접근 권한과 거부는 원본 런타임에서 처리합니다.
- 표준 MCP form 승인 전달. 확장 승인·URL 승인·사용자 인증 흐름은 미지원이며 자동 승인하지 않습니다.
- 명시적 `turn_ended {}`와 연결 종료 시 자체 대화 정리. Claude 매 턴의 Stop hook과 MCP cancellation 중계는 지원하지 않습니다.
- 선택적인 Portwarden 정리 연동. Portwarden 없이 bundled CUA에 직접 연결할 수 있습니다.

제한된 원본 REPL에서 실행되므로 일반 Node.js의 `process`나 Claude의 임시 저장 폴더를 그대로 사용할 수 있다고 가정하면 안 됩니다. 스크린샷은 도구가 안내하는 이미지 반환 방식으로 전달합니다.

## 제거

진행 중인 Codex 작업을 마친 뒤 앱을 정상 종료합니다. 연결용 명령과 전용 실행 환경도 지우려면 플러그인을 제거하기 전에 실행합니다.

```sh
~/.local/bin/codex-cua uninstall
claude plugin uninstall codex-computer-use@chenjing-plugins --scope user
```

Codex는 이후 평소 방식으로 열 수 있습니다. 다른 플러그인이 같은 마켓을 사용하므로 마켓 전체를 제거할 필요는 없습니다.

## 개발 및 라이선스

```sh
./setup.sh install
~/.local/share/codex-cua/venv/bin/python -m unittest discover -p 'test_*.py'
claude plugin validate .
```

연결기 코드는 [MIT](LICENSE)입니다. 원본 Codex·CUA와 외부 서비스의 권리는 포함하지 않습니다. [라이선스 범위](LEGAL.md) · [설치 안내](docs/installation.md) · [호환성 및 검증 범위](docs/distribution.md)
