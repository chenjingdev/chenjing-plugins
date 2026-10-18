# CUA for Claude Code

Claude Code에서 Mac의 앱과 브라우저를 Codex CUA로 조작하는 플러그인입니다. **macOS 전용 · 비공식 실험 버전**입니다.

## 준비

- Claude Code와 Computer Use를 사용할 수 있는 Codex 데스크톱 앱이 필요합니다.
- Python 3.9 이상이 필요합니다. 첫 설정에서 필요한 패키지를 전용 환경에 내려받습니다.
- macOS 접근성·화면 기록 권한은 원본 Codex 앱의 안내에 따라 설정합니다.

## 설치와 사용

```sh
claude plugin marketplace add chenjingdev/chenjing-plugins
claude plugin install cua@chenjing-plugins --scope user
```

Claude Code의 새 대화에서 다음을 실행합니다.

```text
/cua:setup
```

Claude가 설치와 연결을 점검합니다. 이후 **“cua 써서 이 앱을 확인해 줘”**처럼 요청하면 됩니다. 연결이 끊겼다면 **“CUA 연결 복구해 줘”**라고 요청합니다.

설정이 끝나면 Codex를 따로 준비하지 않아도 됩니다.

- **앱을 평소처럼 켜도 됩니다.** 설정 때 로그인 항목(`~/Library/LaunchAgents/com.chenjingdev.codex-cua.env.plist`)이 등록돼, Dock이나 Spotlight로 연 Codex도 연결 가능한 방식으로 켜집니다.
- **앱이 꺼져 있어도 됩니다.** Claude가 CUA에 연결할 때 Codex를 뒤에서 열고, 앞에 있던 앱으로 포커스를 돌려줍니다. 끄려면 `CODEX_HOST_CUA_AUTOSTART=0`을 지정합니다.
- **설정 전부터 켜져 있던 Codex는 한 번 다시 켜야 합니다.** 진행 중인 작업을 마치고 앱을 정상 종료(⌘Q)한 뒤 다시 열고, Claude Code에서 `/mcp`로 cua를 다시 연결합니다. 앱을 강제로 종료하지 않습니다.
- Codex가 뒤에서 열리는 동안 로그인·권한·업데이트 창이 떠 있으면, 기다리다가 Codex를 앞으로 띄우고 안내합니다.
- **플러그인이 없거나 깨져도 Codex는 켜집니다.** 연결용 실행 환경이나 플러그인이 지워졌거나 손상됐다면 Codex는 연결 없이 원래대로 켜집니다. 이때는 CUA 연결만 빠지므로 `/cua:setup`으로 복구합니다.

## 관리

이전 `codex-computer-use` 플러그인에서 옮길 때는 마켓플레이스를 갱신하고 이전 플러그인을 제거한 뒤 새 이름으로 설치합니다. 연결용 로컬 명령 `codex-cua`는 그대로 사용하며, 새 설정을 실행하면 연결 대상이 `cua`로 갱신됩니다.

```sh
claude plugin marketplace update chenjing-plugins
claude plugin uninstall codex-computer-use@chenjing-plugins --scope user
claude plugin install cua@chenjing-plugins --scope user
```

새 Claude Code 대화에서 `/cua:setup`을 실행합니다.

설정 스킬이 설치한 명령은 AI가 사용할 수 있으며, 직접 실행할 수도 있습니다. `codex-cua`는 언제나 지금 설치된 플러그인 판의 코드를 실행하므로, 플러그인이 자동으로 갱신돼도 새 명령이 바로 나타납니다.

```sh
~/.local/bin/codex-cua doctor --probe  # 연결 확인
~/.local/bin/codex-cua start           # 연결 가능한 방식으로 Codex 실행(보통은 필요 없음)
```

업데이트는 다음 명령으로 적용합니다. 이미 열려 있던 Claude 대화는 작업을 마친 뒤 새로 엽니다.

```sh
claude plugin marketplace update chenjing-plugins
claude plugin update cua@chenjing-plugins --scope user
~/.local/bin/codex-cua setup
```

0.6.0 이하에서 올릴 때는 마지막 줄 대신 새 Claude Code 대화에서 `/cua:setup`을 실행합니다. 이전 판의 `codex-cua`는 새 판의 설정을 모두 알지 못해서, 이 한 번만 필요합니다.

제거할 때는 진행 중인 Codex 작업을 마치고 앱을 정상 종료한 다음 실행합니다. 로그인 항목과 등록한 설정값도 함께 지웁니다.

```sh
~/.local/bin/codex-cua uninstall
claude plugin uninstall cua@chenjing-plugins --scope user
```

## 알아둘 점

- Codex의 원본 CUA를 호출합니다. Codex 앱 파일과 모델 설정은 수정하지 않으며, Claude 연결마다 별도의 임시 대화를 사용합니다.
- 원본 CUA의 접근 권한·브라우저 정책·파일 제한이 적용됩니다. 표준 form 승인만 전달하며, 지원하지 않는 승인 흐름은 실패를 알립니다.
- 내부 Codex 인터페이스를 사용하므로 앱 업데이트 후 플러그인 업데이트나 재연결이 필요할 수 있습니다. Claude 매 턴 자동 종료와 MCP cancellation 중계는 지원하지 않습니다.
- Codex가 `cua_repl` 서버를 번들 CUA 플러그인으로도, 이 플러그인의 중계기로도 식별하지 못하면(설정으로 바꾼 다른 중계기 등) 연결하지 않고 오류를 알립니다.
- 앱이 기본 위치에 없다면 `CODEX_CUA_APP_PATH`에 원본 `.app`의 절대 경로를 지정합니다. 상태 폴더를 `CODEX_HOST_CUA_STATE_DIR`로 바꾸는 경우 호스트와 MCP에 같은 값을 지정하고, 현재 사용자 소유의 비공개 폴더를 사용합니다.

연결기 코드는 [MIT](LICENSE)로 제공됩니다. 원본 Codex·CUA는 포함하지 않으며 해당 소프트웨어와 서비스에는 각 제공자의 이용 조건이 적용됩니다. OpenAI 또는 Anthropic의 공식 제품이 아닙니다.
