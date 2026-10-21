# CUA 연결 엔진

CUA Bar에 담겨 다니는 연결 엔진입니다. Claude Code가 Mac의 앱과 브라우저를 Codex CUA로 조작하게 이어 주는 코드(MCP 서버, Codex 래퍼, 중계기, 상태·정리 명령)입니다. **macOS 전용 · 비공식 실험 버전**입니다. 이 문서는 0.8.0 기준입니다.

플러그인이 아닙니다. Claude 플러그인이나 마켓플레이스로 나누어 주지 않고, 앱 하나(CUA Bar)가 이 엔진을 번들에 담아 깔고 부립니다. 쓰는 방법과 화면은 [앱 README](../README.md)에 있고, 이 문서는 엔진이 어떻게 깔리고 무엇을 하는지 적습니다. 폴더 안의 `.claude-plugin/plugin.json`은 엔진 매니페스트(이름 `cua`와 판)로 그대로 씁니다.

## 준비

- Claude Code와 Computer Use를 사용할 수 있는 Codex 데스크톱 앱이 필요합니다.
- Python 3.9 이상이 필요합니다(`/usr/bin/python3`는 개발자 도구에 들어 있습니다). 첫 설정에서 필요한 패키지를 전용 환경에 내려받습니다.
- macOS 접근성·화면 기록 권한은 원본 Codex 앱의 안내에 따라 설정합니다.
- 엔진을 까는 것은 CUA Bar입니다. 앱 없이 엔진만 따로 까는 길은 제공하지 않습니다. 아래 명령은 개발과 진단에 씁니다.

## 사본과 current 링크

원본은 앱 번들의 `Contents/Resources/engine`입니다(개발 중에는 이 폴더). 앱은 켜질 때 번들의 `setup.sh install-engine`을 불러 원본을 판마다 사본으로 풀어 씁니다. Claude 대화는 시작할 때의 엔진 파일을 계속 실행하고 Codex 호스트도 그렇기 때문에, 앱이 업데이트돼도 쓰던 파일을 치우지 않도록 판마다 폴더를 따로 둡니다.

```text
~/.local/share/codex-cua/
  engine/
    0.8.0/                엔진 사본 (폴더 이름은 매니페스트의 version)
    current -> 0.8.0      마지막으로 깐 판을 가리키는 상대 링크
  venv/                   전용 파이썬 환경
  relay/                  중계기 고정 사본
  source.json             codex-cua가 따르는 엔진 사본
  command.py              codex-cua 실행 파일의 사본
  start-desktop-cli.sh    Codex가 CLI로 켜는 스크립트(래퍼)
```

- 사본은 소유자만 쓰는 비공개 폴더입니다(폴더 0700, 파일 0600, 실행 파일 0700). 같은 판 사본이 온전하면 그대로 씁니다. 온전함은 매니페스트 판, 파일 목록과 크기, 소유자와 권한으로 보고 내용은 비교하지 않으므로, 같은 판 번호로 다시 빌드한 코드는 사본에 반영되지 않습니다. 깨졌거나 다른 사용자가 쓸 수 있게 열려 있으면 옆으로 치우고 새로 풉니다. 원본 안의 링크·특수 파일은 거절하고 `__pycache__`·`*.pyc`·`.DS_Store`는 복사하지 않습니다.
- `engine/current`는 상대 링크이고, setup이 끝난 뒤 임시 링크를 rename으로 바꿔 놓아서 어느 순간에도 어딘가를 가리킵니다. 바꾸지 못하면 `install-engine`이 실패합니다.
- Claude Code의 MCP는 `~/.local/share/codex-cua/engine/current/start-mcp.sh` 한 경로로 한 번만 등록합니다. `start-mcp.sh`와 `setup.sh`는 링크를 따라가 실제 판 폴더의 코드를 쓰므로, 판이 바뀌어도 등록은 그대로이고 정리가 등록된 판을 지우는 틈이 없습니다. 앱은 이 경로를 풀지 않고 그대로 등록하고 비교합니다.
- 옛 판 사본은 어떤 프로세스의 명령 줄에도 경로가 없을 때만 지웁니다. 지금 판, `current`가 가리키는 판, 바꾸기 직전에 `current`가 가리키던 판(그 판으로 들어가는 중인 대화가 있을 수 있습니다), 숫자로 더 높거나 숫자가 같은 다른 이름의 판, 판 모양이 아닌 항목과 링크는 남깁니다. 프로세스 목록을 읽지 못하면 아무것도 지우지 않습니다. 10분 넘은 `.install-*`·`.replaced-*` 찌꺼기도 지웁니다.
- 풀기부터 정리까지 `~/.local/share/codex-cua/.setup.lock`을 잡습니다. 다른 쪽이 잡고 있으면 기다리고(최대 320초), 계속 잡혀 있으면 한 줄로 실패합니다. 원본 루트가 root 소유면 실패합니다(dmg로 끌어 놓은 앱은 사용자 소유입니다).

## 명령

`setup.sh <명령>`(원본이나 사본의 `setup.sh`)으로 부르고, 설정이 끝난 뒤에는 `~/.local/bin/codex-cua <명령>`이 같은 일을 합니다. `codex-cua`는 `source.json`이 가리키는 엔진 사본의 `setup.py`로 넘기므로 늘 묶인 사본의 코드를 실행합니다. 놓아주기·끄기·다시 켜기는 사람이 직접 부르거나 CUA Bar에서 누르는 명령이고, AI는 `doctor`·`status --json`·`diagnose`만 씁니다.

- `install-engine [--json]`: 위의 일을 하고, 사본 위에서 `setup`을 돌리고, `current`를 옮기고, 옛 판을 정리합니다. 앱이 켜질 때 부르는 설치입니다. 성공하면 결과를 한 덩어리로 냅니다(`--json`이면 JSON 객체 한 줄): `version`, `root`(사본 폴더), `launcher`(`engine/current/start-mcp.sh`), `removed`(지운 옛 판 이름 배열), `setup`(`command`는 `status`의 `setup.command`와 같은 낱말, `login_environment`는 `ready`·`conflict`·`failed`, `relay`는 중계기 파일 상태 `ready`·`missing`·`invalid`). 실패하면 0이 아닌 종료 코드와 stderr 한 줄이고, pip·venv가 낸 말은 싣지 않습니다.
- `status --json`: 지금 상태를 JSON 한 덩어리로 냅니다(아래 [고급 명령](#고급-명령)). 앱이 읽는 계약입니다. 엔진 판과 관련된 칸은 아래에 있습니다.
- `doctor [--probe] [--json] [--timeout 초]`: 설치 상태를 보고하고, `--probe`를 주면 연결 시험을 합니다(아래).
- `setup`(`install`): 이 폴더의 엔진으로 `codex-cua` 명령, Codex 래퍼 스크립트, 로그인 항목, 중계기 사본을 설정합니다. `install-engine`이 사본 위에서 부르므로 직접 부를 일은 개발 때뿐입니다.
- `start`: 연결 가능한 방식으로 Codex를 실행합니다(보통은 필요 없습니다).
- `uninstall`: 아래 [제거](#제거).

### status의 엔진 칸

- `engine`: `version`(이 엔진의 매니페스트 판), `root`(이 엔진이 도는 폴더), `launcher`(MCP를 등록하는 경로). `plugin.version`은 `engine.version`과 같은 값을 이전 이름으로 한 번 더 냅니다.
- `host.engine_version`, `host.started_before_setup`: 아래 [host.json의 engine_version](#hostjson의-engine_version).
- `setup`: `command`, `dependencies`, `login_environment`, `wrapper`, `relay`.

### host.json의 engine_version

Codex 래퍼(`desktop_cli_wrapper.py`)는 호스트를 켤 때 상태 폴더(`~/Library/Caches/codex-host-cua`, `CODEX_HOST_CUA_STATE_DIR`로 바꿀 수 있습니다)의 `host.json`에 자기 엔진의 매니페스트 판을 `engine_version`으로 적습니다. 시작 중·준비·종료·닫힘 기록에 모두 남습니다. 매니페스트를 읽지 못하면 `null`을 적되 Codex는 그대로 켭니다.

`status`는 호스트가 준비 상태일 때 이 값을 지금 엔진의 판과 문자열 그대로 비교합니다. `relay_config` 칸이 없거나, `engine_version`이 없거나 문자열이 아니거나, 지금 판과 다르면 `host.started_before_setup`이 `true`입니다(0.8.x끼리의 차이도 잡습니다). CUA Bar는 이때 Codex를 끄지 않고 카드에 "Codex를 다시 켜면 새 설정이 적용돼요"를 씁니다. `host.engine_version`은 호스트가 준비·시작 중·종료 중일 때만 내고, 닫힌 기록의 판은 낡은 정보라서 내지 않습니다. 같은 판 번호로 코드만 다시 빌드한 경우는 이 비교로 잡히지 않습니다.

### 연결 시험 (doctor --probe)

`doctor`는 `installation`, `dependencies`, `login_environment`, `relay`, `host`를 보고합니다. `--probe`를 주면 연결 시험을 하고, 결과가 `probe.status`와 최상위 `status`에 같은 낱말로 나옵니다: `checked`(성공), `failed`, `timeout`, `approval_required`(Codex의 승인이 필요합니다), `cleanup_unconfirmed`(됐지만 정리를 확인하지 못했습니다), `host_unavailable`, `dependencies_missing`. `--timeout`은 기본 15초, 최대 60초이고, 시험이 끝난 뒤 정리에 몇 초 더 걸릴 수 있습니다. 종료 코드는 `registered` 또는 `checked`일 때만 0입니다.

- 호스트가 준비 상태가 아니면(기록 없음·시작 중·종료 중·닫힘·프로세스 없음) 아무것도 켜거나 끄거나 묻지 않고 파일도 만들지 않은 채 `host_unavailable`로 곧장 끝납니다. Codex가 꺼져 있어도 켜지 않습니다.
- 준비된 호스트에는 `await cua.getState();` 한 번을 임시 스레드로 부릅니다. 이 스레드는 새 비공개 폴더(0700)에서 일하고, 폴더 이름이 시험의 유일한 표시입니다. 이름은 `codex-cua-probe-` 뒤에 무작위 6~32자(영문·숫자·밑줄)입니다.
- 끝나면(호출이 실패하거나 답이 없어도 같습니다) 그 폴더에서 일하는 런타임만(호스트의 app-server 바로 아래에서 시험 뒤에 뜬 것) 끝내고 폴더를 지웁니다. 정리가 실패해도 시험 결과는 그대로입니다. 폴더를 만들지 못하면 시험 없이 `failed`입니다.
- `status`는 작업 폴더가 이 이름인 연결·중계기 기록·활동 줄을 연결 목록, 화면 상태(작업 중), 활동 기록, 점유(끝난 연결 포함)에서 뺍니다. 중계기도 같은 이름 규칙(`engine_core.py`의 `is_probe_folder`와 `relay/relay.mjs`)으로 그 폴더에서는 활동 줄을 남기지 않습니다. 이름만 비슷한 폴더는 평소대로 연결로 칩니다.

## Codex와 Claude가 붙는 방식

설정이 끝나면 Codex를 따로 준비하지 않아도 됩니다.

- **Codex를 평소처럼 켜도 됩니다.** 설정 때 로그인 항목(`~/Library/LaunchAgents/com.chenjingdev.codex-cua.env.plist`)이 등록돼, Dock이나 Spotlight로 연 Codex도 연결 가능한 방식으로 켜집니다. 시스템 설정의 로그인 항목에는 이 항목이 실행하는 스크립트 이름 `codex-cua-login-env`로 보입니다.
- **Codex가 꺼져 있어도 됩니다.** Claude가 CUA에 연결할 때 Codex를 뒤에서 열고, 앞에 있던 앱으로 포커스를 돌려줍니다. Codex를 켜는 것은 새 Claude 대화가 CUA에 연결할 때와, 연결이 끊긴 뒤의 다음 CUA 호출뿐입니다. 대화 끝 정리(`turn_ended`)는 켜지 않습니다.
- **설정 전부터 켜져 있던 Codex는 한 번 다시 켜야 합니다.** CUA Bar는 이런 Codex를 끄지 않고 알림으로 다시 켤지 묻고, **다시 켜기**를 누르면 정상 종료한 뒤 다시 켭니다. 직접 하려면 진행 중인 작업을 마치고 Codex를 정상 종료(⌘Q)한 뒤 다시 엽니다. 어느 쪽도 강제로 종료하지 않지만, 다시 켜면 하던 Codex 작업은 끊깁니다. 다시 켠 뒤에도 Claude Code에서 cua가 연결되지 않은 것으로 보이면 `/mcp`로 다시 연결합니다.
- **Codex가 꺼졌다 켜져도(앱 갱신 포함) 열려 있던 Claude 대화는 이어집니다.** 다음 CUA 호출 때 새 호스트에 다시 붙습니다. 연결이 끊길 때 하던 조작은 다시 보내지 않으므로 그 조작이 실제로 됐는지는 알 수 없습니다. 화면을 확인한 뒤에 이어 갑니다.
- Codex가 뒤에서 열리는 동안 로그인·권한·업데이트 창이 떠 있으면, 기다리다가 Codex를 앞으로 띄우고 안내합니다.
- **엔진에 문제가 있어도 Codex는 켜집니다.** 연결용 파이썬 환경이나 `command.py`가 없을 때, 환경이 아직 준비되지 않았을 때(Codex를 켜는 동안에는 복구하지도 기다리지도 않습니다), 묶인 엔진 사본(`source.json`)이 없거나 필요한 파일이 빠졌거나 손상됐을 때, 연결을 시작하기 전에 상태 폴더·점유 같은 설정이 막혔을 때 Codex는 연결 없이 원래대로 켜집니다. CUA 연결만 빠지므로 CUA Bar의 **고치기**로 복구합니다(손으로는 사본 폴더의 `setup.sh install-engine`).
- 다음은 이 보호 밖입니다. `~/.local/share/codex-cua` 폴더 전체를 `codex-cua uninstall` 없이 지운 경우, `command.py` 자체에 문법 오류가 있는 경우, 설정 때 Codex 실행 파일 경로를 기록하지 못했거나 기록한 경로가 앱 업데이트로 바뀐 경우(CUA Bar의 **고치기**나 `codex-cua setup`으로 다시 기록), 연결 가능한 방식으로 시작한 뒤에 생긴 오류입니다.

## 중계기

0.7.0부터 Codex를 켤 때 Codex가 CUA 런타임을 띄우는 자리에 중계기를 끼웁니다. `codex-cua setup`이 `~/.local/share/codex-cua/relay/`에 고정 사본을 두고, Codex를 켤 때마다 이 사본을 쓰며 필요하면 새로 고칩니다. 중계기는 런타임과 주고받는 내용을 그대로 전달하면서 세 가지를 더합니다.

- **끄기 전에 탭을 놓아줍니다.** 열린 대화의 범위를 알고 있어서, 연결을 끄기 전에 AI가 정상 종료 때 하는 정리와 같은 놓아주기를 합니다. AI가 만든 임시 탭은 닫히고, 사용자 탭과 넘겨주려고 남긴 탭은 그대로 둡니다.
- **Codex 연결이 목록에 보입니다.** Codex 대화의 런타임이 작업 폴더, 작업 중·쉼, 세션 ID와 함께 연결 목록에 올라옵니다.
- **조작 기록을 남깁니다.** 시각, 연결, 세션 ID, 도구 이름, 성공 여부, 걸린 시간만 `activity.jsonl`에 한 줄씩 적습니다. Claude 대화의 런타임이면 그 대화를 연 다리의 이름(다리의 pid와 시작 시각)도 줄마다 적어서, 대화가 끝나 연결이 사라진 뒤에도 기록 탭이 그 줄을 Claude의 것으로 보입니다. 파일이 256KB를 넘으면 최근 200줄만 남기고 줄이며, 상태에는 최근 200개가 보입니다(아래 [개인정보](#개인정보)).

중계기는 `~/.codex/config.toml`을 고치지 않습니다. Claude 대화의 런타임에는 Codex를 켜는 래퍼가 원래 `cua_repl` 정의를 읽어 그 앞에 끼웁니다. Codex 앱이 대화마다 보내는 `cua_repl` 설정에서는 런타임 경로 한 값만 중계기로 바꿔 전달하고, 예상한 값일 때만 바꾸며 나머지는 그대로 넘깁니다. 모델·권한·승인 설정은 건드리지 않습니다.

중계기가 없어도 Codex는 켜집니다. 원래 정의를 읽지 못하거나 중계기가 깨졌으면 Codex는 중계기 없이 원래대로 켜집니다. 그때는 Codex 대화의 연결을 끄기 전에 탭을 놓지 못하고, 작업 중·쉼·세션 ID도 알 수 없습니다. 중계기 사본이 없거나 깨졌으면 CUA Bar가 문제로 알리고 **고치기**로 고칩니다(`codex-cua setup`도 같은 일을 합니다). 원래 정의를 읽지 못해 중계기 없이 켜진 경우는 `status --json`의 `setup.relay`가 `inactive`로만 보이고 CUA Bar는 문제로 알리지 않습니다. 이유는 `codex-cua diagnose`의 `relay left out …` 줄에 나옵니다. 이번 설정보다 먼저 켜진 Codex는 `host.started_before_setup`이 `true`이고, CUA Bar 카드가 "Codex를 다시 켜면 새 설정이 적용돼요"라고 안내합니다. 그 전에는 연결 상태를 모르거나 놓아주지 못할 수 있습니다.

## 제거

CUA Bar의 **앱 지우기…**가 이 엔진의 제거까지 합니다([앱 README](../README.md#지우기)). 직접 하려면 진행 중인 Codex 작업을 마치고 Codex 앱을 정상 종료한 다음 실행합니다. Codex 호스트가 살아 있으면 거절하고 아무것도 바꾸지 않습니다.

```sh
~/.local/bin/codex-cua uninstall
```

로그인 항목, 등록한 설정값, 중계기 사본, 설치한 명령, 엔진 사본과 파이썬 환경(`~/.local/share/codex-cua` 전체)을 함께 지웁니다. 연결 기록 폴더(`~/Library/Caches/codex-cua`)와 호스트 상태 폴더(`~/Library/Caches/codex-host-cua`)는 지우지 않으니 필요 없으면 직접 지웁니다. 앱이 Claude Code에 깐 `cua` MCP와 스킬은 이 명령이 건드리지 않아서, 앱 지우기가 따로 지웁니다.

## 업데이트와 옛 플러그인

엔진은 CUA Bar가 새 판으로 올라갈 때 함께 올라갑니다([앱 README](../README.md#새-판은-스스로-올라가요)). 이전에 Claude 플러그인 `cua@chenjing-plugins`(그 전에는 `codex-computer-use`)로 깔았다면 [앱 README의 옮기는 법](../README.md#옛-플러그인에서-옮기기)을 따릅니다.

## 고급 명령

CUA Bar가 쓰는 명령을 직접 부를 수도 있습니다. 모두 `~/.local/bin/codex-cua` 뒤에 붙입니다. 이 명령들은 JSON 객체 하나만 출력하고(`diagnose`는 글), 동작이 실패해도(`"ok": false`) 종료 코드는 0입니다. 종료 코드가 0이 아니면 명령을 실행하지 못한 것입니다. 연결 id(`<ID>`)는 `status --json`의 `connections`에서 찾고, cmux-cua 연결의 id는 `other_tools[].clients[].id`에서 찾습니다. 놓아주기·끄기·다시 켜기는 사람이 직접 부르거나 CUA Bar에서 누르는 명령이고, AI는 `doctor`·`status --json`·`diagnose`만 씁니다.

- `status --json`: 지금 상태(Codex·호스트·설정, 연결 목록, 남았을 수 있는 점유, 다른 도구, 최근 조작 기록)를 보여 줍니다. 아무것도 놓거나 끄지 않습니다(끝난 기록만 정리).
- `release --connection <ID>` 또는 `release --ended`: 연결 하나의 탭을, 또는 끝난 연결의 탭을 놓아줍니다. `--ended`는 주인이 사라진 Claude 세션도 세션 ID로 풀어 보는데, 이때 살아 있는 런타임을 거쳐 브라우저를 한 번 부릅니다. 연결의 놓아주기가 확인되면(`stop`의 놓아주기 단계도 같습니다) 그 연결이 맡던 세션은 죽은 브리지 기록에서도 지워서, 이미 풀린 세션이 `status --json`의 남았을 수 있는 점유에 남지 않습니다. 중계기나 브리지가 "끝났는지 확인하지 못했다"(`cleanup_not_confirmed`)고 답하면 같은 연결에 한 번 더 묻습니다(런타임이 한도보다 조금 늦게 끝냈을 수 있어서 탭은 닫혔는데 범위만 열려 있는 일이 있습니다). 두 번째 물음에서야 확인된 놓아주기는 죽은 브리지 기록에서 바로 지우지 않습니다. 두 번째 답은 런타임이 그 턴의 끝을 이미 받았다는 뜻일 수 있어서, 그 세션은 `--ended`가 이어서 세션 ID로 브라우저를 불러 풀어 봅니다. 다른 까닭(`timeout`, `request_in_flight`, `no_trusted_scope` 등)에는 다시 묻지 않습니다.
- `release-session --session <세션ID> [--user]`: 주인이 사라진 세션의 점유를 세션 ID로 콕 집어 풉니다.
- `stop --connection <ID> [--force]`: 연결 하나를 끕니다. 먼저 탭을 놓아주고(cmux-cua 연결은 놓아줄 점유가 없어 곧바로) 정상 종료를 요청하며, `--force`는 그래도 남은 연결 프로세스만 강제로 종료합니다.
- `stop --group all|claude|codex [--force]`: Claude·Codex 연결을 묶음으로 끕니다. cmux-cua 연결은 어느 묶음에도 들어가지 않습니다.
- `restart-codex`: Codex를 정상 종료한 뒤 다시 엽니다.
- `diagnose`: 대화에 붙여넣어도 되는 진단 글을 출력합니다. Codex가 이미 끝난 대화의 스레드를 스스로 다시 켠 빈 런타임은 `status --json`의 연결 목록에 넣지 않고 이 글에 개수와 메모리 한 줄로만 적습니다. 죽은 다리의 이름을 달았는데 그 다리의 기록이 없고 한 번도 불리지 않았고 열린 범위도 없는 런타임 가운데, 중계기가 켜지며 그 다리가 이미 돌고 있지 않은 것을 본 것(대화가 18초 만에 끝났어도 같습니다)과, 그렇게 기록하지 않은 것(다리가 돌고 있었다고 적었거나, 확인하지 못했거나, 기록이 없는 옛 중계기)이면 그 다리보다 2분 넘게 늦게 켜진 것입니다. Codex가 그 스레드를 내릴 때(마지막 사용 뒤 약 30분) 같이 사라집니다. 한 번이라도 불렸거나 범위를 가졌으면 지금처럼 끝난 연결입니다.

안전 규칙은 다음과 같습니다.

- `release-session`은 주인이 사라진 세션만 풉니다. 살아 있는 연결이 쓰는 세션은 `session_live`로, 기록에 없는 세션은 `not_found`로 거절합니다. Codex 대화의 세션은 나중에 다시 열 수 있으므로 `--user`(사용자가 직접 누른 일)를 붙일 때만 풀고, 안 붙이면 `needs_user`로 거절합니다. 다만 기록의 `owner`가 다리 이름인 중계기가 적은 세션은 Claude 다리가 연 일회용 대화의 것이라 다시 이을 수 없으므로 Codex 대화로 보지 않고 `--user` 없이 풉니다(그 다리가 살아 있는 동안은 `session_live`). AI는 `--user`를 붙이지 않고, AI가 쓰는 MCP 도구에는 이 기능이 없습니다.
- `release --ended`는 살아 있는 연결이 지금 쓰는 점유를 건드리지 않습니다. `release --connection`을 일하는 중인 연결에 쓰면 하던 브라우저 작업의 탭이 닫히고, Codex 대화는 그 턴의 다음 브라우저 조작이 시간 초과까지 멈춥니다. CUA Bar는 이럴 때 한 번 묻습니다.
- `stop`은 연결 프로세스(Claude의 브리지, Codex 대화의 런타임, cmux-cua 연결의 `cmux-cua mcp`)만 끕니다. Codex 앱, AI 클라이언트, Chrome, cmux-cua 데몬(`serve`)은 어떤 경우에도 끄지 않습니다. cmux-cua 연결은 `stop --connection cmux-…`로 하나씩만, 놓아주기 없이 끄며 묶음 종료에는 들어가지 않습니다. 끄면 그 AI 대화의 cmux-cua 도구는 다시 붙을 때까지 끊깁니다.
- `stop --group codex`는 주인을 알 수 없는 연결을 건너뜁니다(`unattributed`). Claude 대화의 런타임일 수 있기 때문이며, 그런 연결은 하나씩 끄거나 `--group all`로 끕니다.
- `restart-codex`는 정상 종료(⌘Q와 같은 종료 요청)만 하고 강제로 종료하지 않습니다. Codex가 꺼져 있으면 `not_running`이고 아무것도 켜지 않으며, 종료 창에서 사용자가 취소하면 `quit_cancelled`입니다. Codex가 종료 요청을 받고도 30초 안에 꺼지지 않으면 `quit_pending`이고, 메뉴 막대 앱이 Codex가 꺼지기를 기다렸다가 다시 엽니다. 하던 Codex 작업이 끊기므로 사용자가 직접 부를 때만 씁니다.

## 개인정보

- 연결과 조작 기록은 이 맥의 `~/Library/Caches/codex-cua`에만 남습니다(폴더는 본인만 쓸 수 있고 파일은 0600). 들어 있는 것은 프로세스 번호(pid)와 시작 시각, 작업 폴더, 세션 ID와 턴 ID(아직 끝나지 않은 범위의 짝), 제어 소켓 경로, 작업 중·정리 상태(busy, cleanup), 중계기가 켜질 때 그것을 연 다리가 돌고 있었는지(예·아니오·확인 못 함), 시각, 도구 이름, 성공 여부(ok)와 걸린 시간(ms)뿐입니다. 이 맥 밖으로 보내지 않습니다.
- 도구에 넘긴 인자와 결과, js 코드와 제목, URL, 화면, 환경 값, 시크릿은 기록하지 않습니다. 점유를 세션 ID로 풀 때도 탭 개수만 셉니다.
- `codex-cua diagnose`의 글은 붙여넣어도 되도록 홈 폴더를 `~`로 쓰고, URL을 지우고, 작업 폴더와 환경 값은 넣지 않습니다.
- `~/Library/Caches/codex-cua`는 `codex-cua uninstall`이 지우지 않습니다. 필요 없으면 직접 지웁니다.

## 알아둘 점

- Codex의 원본 CUA를 호출합니다. Codex 앱 파일과 모델 설정은 수정하지 않으며, Claude 연결마다 별도의 임시 대화를 사용합니다.
- 원본 CUA의 접근 권한·브라우저 정책·파일 제한이 적용됩니다. 표준 form 승인만 전달하며, 지원하지 않는 승인 흐름은 실패를 알립니다.
- 내부 Codex 인터페이스를 사용하므로 Codex 앱 업데이트 뒤에 엔진 업데이트(CUA Bar의 새 판)나 재연결이 필요할 수 있습니다. Claude 매 턴 자동 종료와 MCP cancellation 중계는 지원하지 않습니다.
- Codex가 `cua_repl` 서버를 Codex의 번들 CUA 플러그인으로도, 이 엔진의 중계기로도 식별하지 못하면(설정으로 바꾼 다른 중계기 등) 연결하지 않고 오류를 알립니다.
- 앱이 기본 위치에 없다면 `CODEX_CUA_APP_PATH`에 원본 `.app`의 절대 경로를 지정합니다. 상태 폴더를 `CODEX_HOST_CUA_STATE_DIR`로 바꾸는 경우 호스트와 MCP에 같은 값을 지정하고, 현재 사용자 소유의 비공개 폴더를 사용합니다.

엔진 코드는 [MIT](LICENSE)로 제공됩니다. 원본 Codex·CUA는 포함하지 않으며 해당 소프트웨어와 서비스에는 각 제공자의 이용 조건이 적용됩니다. OpenAI 또는 Anthropic의 공식 제품이 아닙니다.
