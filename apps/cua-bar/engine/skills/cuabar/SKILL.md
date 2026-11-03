---
name: cuabar
description: 사용자가 CUA(화면 조작) 연결 상태를 묻거나("CUA 돼?", "cuabar 상태"), CUA가 남긴 브라우저 탭·점유를 정리해 달라거나, CUA 때문에 Codex를 다시 켜 달라거나, 잠긴 Mac에서 CUA가 막힌 까닭을 묻거나, CUA Bar 앱과 cuabar 플러그인 사이를 옮기려 할 때, CUA가 조작하는 동안의 화면 가장자리 빛을 끄거나 켜려 할 때. CUA로 앱을 조작하는 법은 cuabar MCP가 연결할 때 알려 주므로 이 스킬이 아니다.
---

# cuabar

cuabar 플러그인은 메뉴 막대 앱 CUA Bar 없이 Claude Code에서 Codex CUA를 쓰게 한다. 앱이 하던 일 가운데 저절로 되는 것은 플러그인이 알아서 하고, 사람이 누르던 버튼은 이 스킬이 사용자의 말을 받아 명령으로 한다. 명령은 모두 `~/.local/bin/codex-cua <명령>`이고 JSON 하나로 답한다.

## 저절로 되는 것 (따로 할 일 없음)

- 새 Claude 대화에서 cuabar MCP가 뜰 때 엔진 사본, Codex 래퍼·로그인 환경, 중계기를 맞추고, 끝난 연결의 점유를 푼다.
- Codex가 꺼져 있으면 첫 CUA 호출이 뒤에서 켠다.
- 작업이 끝나거나 대화를 닫으면 훅이 그 대화의 CUA 범위를 끝낸다.
- CUA 호출이 도는 동안 화면 가장자리에 빛이 숨 쉬듯 켜지고, 끝나면 사라진다. 포인터는 Codex의 가상 커서가 움직인다.
- 잠긴 Mac에서 자동 잠금 해제가 실패하면 엔진이 CUA 서비스를 다시 켠다(잠금 한 번에 다섯 번까지). AI는 30초쯤 뒤 보기만 하는 호출로 다시 부르고, 그래도 안 되면 사용자에게 잠금을 풀어 달라고 한다. "physical input was detected"는 사람이 Mac 앞에 있다는 뜻이라 다시 켜지 않는다.

## 사용자가 말하면 하는 것

- **상태**: cuabar MCP의 `status` 도구를 `{}`로 부르고, `codex-cua status --json`에서 Codex·호스트·설정(`setup`), 연결 목록(`connections`), 남았을 수 있는 점유(`leases.maybe_left`)만 추려 말한다. 문제가 보이면 `codex-cua diagnose`의 글을 덧붙인다. MCP가 아예 없거나 도구가 없으면 `/mcp`에서 `plugin:cuabar:cuabar`의 상태를 보라고 한다.
- **탭·점유 정리**: 사용자가 이 대화에서 정리를 부탁했을 때만 `codex-cua release --ended --json`. 끝난 연결과 주인이 사라진 Claude 대화의 점유만 푼다. Codex 대화의 점유는 사용자가 그 세션을 콕 집었을 때만 `codex-cua release-session --session <ID> --user --json`으로 푼다. 답이 `browser_blocked`이면 Codex가 엔진의 대화에 브라우저를 막은 것이라 다시 해도 같다고 말한다.
- **Codex 다시 켜기**: `status`나 진단이 "Codex가 연결 없이 켜져 있다", "다시 켜면 새 설정이 적용된다", "다시 켜면 중계기가 붙는다"고 할 때 쓴다. 하던 Codex 작업이 끊긴다는 것을 먼저 말하고, 사용자가 그래도 하라고 하면 `codex-cua restart-codex --json`. `quit_pending`이면 Codex 창의 종료 확인을 사용자가 눌러야 하고, 꺼진 뒤에는 다음 CUA 호출이 Codex를 뒤에서 켠다. `quit_cancelled`면 그대로 둔다.
- **빛 끄기·켜기**: 사용자가 화면 가장자리 빛을 끄라고 하면 `codex-cua settings --overlay off --json`, 다시 켜라고 하면 `--overlay on`. 다음 호출부터 적용된다.
- **업데이트 뒤 끊김**: `status`가 `reconnect_mcp`를 내면 사용자에게 `/mcp reconnect plugin:cuabar:cuabar`를 실행해 달라고 한다(`reconnect all`은 옛 서버를 건너뛸 수 있다). 플러그인 새 판은 `claude plugin update cuabar@chenjing-plugins`로 받는다.

AI가 스스로 하지 않는 것: Codex 끄기, `stop`, `unlock-reset`, `dismiss-session`, 권한 바꾸기, 잠금을 직접 풀기.

## CUA Bar 앱과 같이 있을 때

한 Mac에 둘이 붙으면 CUA가 두 번 붙으므로, CUA Bar가 떠 있거나 앱이 등록한 user MCP `cuabar`가 있으면 플러그인이 도구 없이 비켜 선다(MCP 안내에 그 까닭이 나온다).

- 앱에서 플러그인으로: CUA Bar를 끝내고, 시스템 설정 → 일반 → 로그인 항목에서 CUA Bar를 끈 뒤, `claude mcp remove -s user cuabar`. 앱이 깐 작업 종료 훅은 남아 있어도 플러그인이 알아서 비켜 서지만, 치우려면 `~/.claude/settings.json`의 `engine/current/claude-hook.sh` 항목을 지운다. 그다음 새 Claude 대화를 연다.
- 플러그인에서 앱으로: CUA Bar를 다시 켜면 앱이 자기 엔진·MCP·훅을 다시 깔고, 플러그인은 다음 대화부터 비켜 선다. 플러그인을 아예 빼려면 `claude plugin uninstall cuabar@chenjing-plugins --scope user`.
