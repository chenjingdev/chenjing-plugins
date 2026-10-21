# Codex CUA 개발용 테스트

CUA Bar에 담는 연결 엔진 `apps/cua-bar/engine`(0.7.0)의 회귀 시험이다. Python 시험 819개와 Node 시험 97개가 있고, 둘 다 저장소 루트에서 실행한다. Python 시험과 `node --test`는 1분쯤 걸리고, `node tests/cua/relay`로 직접 돌리면 네 파일이 한 프로세스에서 차례로 돌아 1분 20초쯤 걸린다.

```sh
python3 tests/cua/run.py       # Python 시험 819개
node --test tests/cua/relay    # Node 시험 97개 (중계기)
```

- Python 시험은 표준 라이브러리의 `unittest`만 쓰고 Python 3.9 이상이면 된다. `run.py`가 `apps/cua-bar/engine`을 모듈 검색 경로에 추가한 뒤 이 폴더의 `test_*.py`를 찾아 실행한다. `bridge_case.py`, `fake_host.py`, `engine_support.py`, `fake_native_cli.py`, `toml_subset.py`는 시험이 쓰는 도우미라 수집되지 않는다.
- Node 시험은 `node:test`만 쓴다. 이 맥의 Node 26.8.1에서 확인했다. `relay/index.js`는 네 시험 파일을 한 프로세스에서 불러오는 입구다. `node tests/cua/relay`로 직접 돌리면 어느 판에서나 이 입구를 거친다. `node --test tests/cua/relay`는 폴더를 모듈 경로로 읽는 판(22, 24)에서만 이 입구를 거치고, 폴더를 직접 펼치는 판(이 맥의 26)에서는 `index.js` 없이 네 파일을 각각 따로 돌린다.

## CUA를 쓰지 않을 때 돌린다

시험은 임시 폴더와 가짜 프로그램만 쓰지만, 이 맥의 실제 지원 폴더를 읽기만 하는 보호 장치가 시험 시작과 끝에 지문(종류·크기·수정 시각·inode)을 떠서 비교한다. 지켜보는 곳은 `~/.local/share/codex-cua`, `~/.local/bin/codex-cua`, `~/Library/Caches/codex-cua`, `~/Library/Caches/codex-host-cua`, 그리고 `~/Library/LaunchAgents`에서 이름이 `com.chenjingdev.`로 시작하는 항목이다. 시험 중에 이 곳들이 바뀌면 시험이 모두 통과해도 실패로 끝낸다.

시험이 쓰지 않아도 바뀐다. CUA를 쓰면 연결이 `~/Library/Caches/codex-cua`에 기록을 쓰고, Codex를 켜거나 플러그인을 설치해도 이 곳들이 바뀐다. 그래서 **시험은 CUA를 쓰지 않을 때 돌린다.** 보호 장치에 걸렸으면 CUA를 쓰지 않을 때 다시 돌리고, 아무것도 안 쓰는데도 계속 걸리면 시험이 거기에 쓰는 것이니 고친다.

| 종료 코드 | 뜻 |
|---|---|
| 0 | 모두 통과했다. |
| 1 | 시험이 실패했거나, 시험이 버리는 HOME에 썼거나(자기 폴더를 주입하지 않았다), 인자를 잘못 줬다(argparse는 이때 2로 끝나지만 2는 보호 장치의 코드라 1로 바꿨다). |
| 2 | 보호 장치가 실제 지원 폴더의 변화를 봤다. 시험 결과도 같이 출력되지만 1보다 우선한다. |

바뀐 경로는 하나씩, 무엇이 일어났는지(`new`, `changed`, `removed`)와 새 수정 시각(로컬 시간, 오프셋 포함)과 함께 출력한다. 30개를 넘으면 나머지는 개수만 적는다.

```text
.local/share/codex-cua/command.py  changed, modified 2026-10-19 00:12:34 +0900
Library/Caches/codex-cua  new, modified 2026-10-19 00:12:34 +0900
```

Node 시험도 같은 출력과 종료 코드를 시험 프로세스가 낸다. 다만 `node --test`는 실패한 시험 파일을 늘 1로 보고하므로, 2를 보려면 `node tests/cua/relay`로 직접 돌린다. `run.py`의 `--tests`와 `--real-home`은 러너 자체의 시험(`test_guard.py`)이 가짜 시험 묶음과 가짜 홈을 가리킬 때 쓰는 옵션이라 평소에는 쓰지 않는다.

## Python 시험

| 묶음 | 파일(시험 수) | 확인하는 것 |
|---|---|---|
| 실행 스크립트와 대체 실행 | `test_launcher`(10), `test_desktop_cli_wrapper`(24) | 플러그인이나 실행 환경이 깨져도 Codex가 원본 CLI로 켜지는 경로 세 곳. 실제 `/bin/sh`로 도는 실행 스크립트(인터프리터 없음·실행 불가·끊어진 링크, `command.py` 없음, 원본 CLI를 모르는 경우), 백엔드를 시작하기 전에 실패하는 래퍼(상태 폴더·점유(끊어진 심볼릭 링크 포함)·시간 설정·메타데이터 쓰기·실행 실패에서 인자와 환경을 그대로 넘겨 exec), `--exec-wrapper` 사전 검사(래퍼와 전송 스크립트가 없거나 손상됨, 의존성이 준비되지 않았거나 다른 프로세스가 복구 중이어도 기다리거나 설치하지 않고 바로 원본 CLI). 백엔드가 시작된 뒤의 실패는 실패로 남는다. 래퍼가 `host.json`에 자기 엔진의 매니페스트 판을 `engine_version`으로 적는 것(시작 중·준비·종료 기록에 그대로 남고, 매니페스트를 못 읽으면 null을 적되 Codex는 그대로 켠다). |
| 위임 | `test_delegation`(15) | `codex-cua`가 `source.json` 묶음이 가리키는 엔진 사본의 `setup.py`로 넘기는 것. 인자와 `--` 뒤 인자 보존, 이 복사본이 모르는 명령, 두 번 넘기지 않기, 0.7.0 이전 판에는 모르는 `--root-resolved`를 붙이지 않고 Codex에는 받은 인자 그대로 넘기기, 묶음이 없거나 사본이 손상됐을 때 원본 CLI로 실행하기, Claude Code의 플러그인 등록부가 있어도 보지 않기, 실제 프로세스로 실행 스크립트에서 새 판까지 이어지는 흐름. |
| 브리지 기록 | `test_bridge_records`(12) | 상태 폴더(`$CODEX_CUA_STATE_DIR`, 없으면 `~/Library/Caches/codex-cua`)의 위치와 비공개 권한, 프로세스 신원(pid와 시작 시각), 조작 기록(`activity.jsonl`)의 쓰기와 줄이기. |
| 제어와 수명 주기 | `test_bridge_control`(10), `test_bridge_lifecycle`(55), `test_bridge_process`(10) | Claude 브리지가 기록과 제어 소켓을 두는 것(자기 프로세스에만 답하고 잘못된 요청은 답 없이 끊는다), 턴 번호 바꾸기, 연 범위를 모두 놓아주기, 실행 중인 호출이 있을 때의 `request_in_flight`, Codex가 꺼졌다 켜진 뒤의 재연결(끊길 때 하던 호출은 다시 보내지 않고 `turn_ended`는 Codex를 다시 켜지 않는다). 실제 프로세스로는 stdin 끝과 종료 신호에서 어떻게 끝나는지, 강제 종료가 무엇을 남기는지. |
| 중계기 설치 | `test_relay_install`(50) | 고정 사본(`~/.local/share/codex-cua/relay/`)을 쓰고 새로 고치는 것, Codex를 켤 때 중계기를 끼울 계획(`cua_repl` 정의를 읽어 맞을 때만 끼우고 하나라도 어긋나면 거절)과 거절 이유들, 시험이 지정한 폴더 밖에 쓰지 못하는 것. |
| 시작(launch) | `test_relay_launch`(19) | Codex를 켤 때 중계기를 앞에 끼우거나, 끼울 수 없으면 원래대로 시작하는 것. `host.json`의 `relay`와 `relay_reason`, 백엔드가 시작 중에 죽으면 중계기 없이 한 번 더 시작하는 것. |
| 브리지와 통로 | `test_relay_bridge`(8), `test_unix_ws_stdio`(12) | 브리지가 번들 플러그인이 아닌 `cua_repl` 서버를 이 플러그인의 중계기일 때만 받아들이는 것, 데스크톱 통로가 바이트 그대로 전달하되 중계기를 가리키는 값 하나만 바꾸는 것(그 밖의 줄과 응답은 그대로). |
| 엔진 | `test_engine_inventory`(44), `test_engine_records`(28), `test_engine_status`(114), `test_engine_release`(39), `test_engine_actions`(113), `test_engine_cli`(31) | `codex-cua`의 엔진 명령. 프로세스와 기록을 읽어 연결·점유·조작 기록·화면 상태로 만드는 `status`(JSON의 모든 필드와 `engine` 판·자리·launcher, `host.started_before_setup`이 참인 세 경우(`relay_config` 칸이 없음, `engine_version`이 없거나 문자열이 아님, 지금 엔진 판과 문자 그대로 다름 — 0.8.x끼리도)와 `host.engine_version`(호스트가 살아 있을 때만), 엔진 사본(`engine/<판>/`)에서 도는 옛 판 브리지까지 알아보기, 연결의 주인 가르기, 쉼과 끝남, Codex가 다시 켠 빈 런타임을 켜질 때 본 것으로 가르기), `release`와 `release-session`(주인이 사라진 세션만, `--user`, `session_live`, `not_found`), `stop`과 묶음 종료(보호 목록, 신원 재확인, `unattributed`), `restart-codex`(정상 종료만), `diagnose`(홈은 `~`), 명령줄과 JSON 한 덩어리 출력. 가짜 프로세스 표와 임시 파일·소켓으로 세상을 만들고, 진짜 프로세스로는 임시 HOME에서 `status`, `diagnose`, `doctor`, 호스트 없는 `doctor --probe`를 돌려 본다(실제 프로세스 목록을 읽기만 한다). |
| 엔진 설치 | `test_install_engine`(47) | `install-engine`. 어느 루트에서 불러도(앱 번들 안 포함) 그 루트를 같은 부모의 임시 폴더로 풀어 `~/.local/share/codex-cua/engine/<매니페스트 판>/`로 rename하는 것(비공개 권한, 풀다 실패하면 폴더도 임시 폴더도 안 남음), 같은 판 사본이 온전하면 그대로 쓰고 깨졌거나 열려 있으면 바꾸는 것, 그 사본으로 `setup`을 돌려 `source.json`·`command.py`·중계기가 사본을 가리키는 것. `engine/current`는 판을 가리키는 상대 링크로, setup이 끝난 뒤 임시 링크를 rename으로 바꿔 항상 어딘가를 가리키고(setup이 실패하면 그대로, 길을 막은 것은 옆으로 치움) `launcher`(`engine/current/start-mcp.sh`)가 `--json`·글 출력에 나온다. 정리는 어떤 프로세스의 명령 줄에도 없는 옛 판만 지우고 `current`가 가리키는 판·지금 판·숫자로 낮다고 확실하지 않은 판(더 높은 판, 숫자가 같은 이름)·판 모양이 아닌 항목·링크는 건드리지 않으며(프로세스 목록을 못 읽으면 판은 안 지움), 10분 넘은 `.install-*`·`.replaced-*`는 지우고 갓 만든 것은 남긴다. 풀기부터 정리까지 `.setup.lock`을 잡고(다른 쪽이 잡고 있으면 기다리고 계속 잡혀 있으면 한 줄로 실패, 안에서 도는 의존성 준비는 자기 잠금을 기다리지 않음), `--json` 한 줄과 글 출력, 실패는 0이 아닌 종료 코드와 stderr 한 줄(pip 출력은 싣지 않음). `setup.sh`와 `start-mcp.sh`가 링크로 불려도(`..`가 낀 경로 포함) 실제 판 폴더를 쓰는 것. |
| 연결 시험 | `test_engine_probe`(27) | `doctor --probe`. 호스트가 준비되지 않았으면(기록 없음·시작 중·종료 중·닫힘·프로세스 없음) 아무것도 켜거나 끄거나 묻지 않고 파일도 만들지 않은 채 `host_unavailable`로 끝나는 것, 준비된 호스트에는 `await cua.getState();` 한 번을 새 비공개 폴더(`codex-cua-probe-…`, 0700)에서 일하는 임시 스레드로 부르고 끝나면 그 폴더에서 일하는 런타임만(호스트의 app-server 바로 아래에서 시험 뒤에 뜬 것) 끝내고 폴더를 지우는 것(호출이 실패하거나 답이 없어도, 연결이 안 돼도 같고, 정리가 실패해도 시험 결과는 그대로), 폴더를 못 만들면 시험 없이 `failed`, 시험이 기록·활동 줄을 하나도 쓰지 않는 것, 시험 폴더에서 도는 런타임·중계기 기록·활동 줄이 `status`의 연결·화면 상태·활동·점유(끝난 연결 포함)에 나타나지 않는 것(죽은 중계기 기록은 점유로 올리지 않고 1분 뒤 지운다, 이름만 비슷한 폴더는 연결로 남는다), 중계기와 엔진이 같은 폴더 이름 규칙을 쓰는 것. 가짜 호스트·가짜 프로세스 표만 쓴다. |
| 보호 장치 | `test_guard`(16) | 지문이 같은 크기로 덮어쓴 파일과 원자적 교체, 새로 생기거나 사라진 항목을 보는 것, 링크를 따라가지 않는 것, 우리 로그인 항목만 지켜보는 것, 바뀐 경로의 출력, `run.py`의 종료 코드 0·1·2(잘못된 인자는 1). |
| 기본(0.6.0부터) | `test_host_mcp`(32), `test_setup`(23), `test_autostart`(12), `test_registry`(5), `test_runtime_paths`(4) | MCP catalog·이미지·오류·승인 전달, 전용 thread 종료(닫힌 stderr에서도 끝까지), 다른 client 유지, launcher의 인자·환경·stdio 보존, registry와 원본 앱 탐색, 설치 캐시 업데이트, 의존성 준비의 동시 실행과 부분 설치 복구, 닫힌 앱의 백그라운드 실행과 포커스 복귀, 켜져 있는 앱 보존, 동시 실행 시 한 번만 열기, 로그인 항목 설정·충돌 보존·제거. 엔진 폴더는 `source.json` 묶음에서만 찾고 플러그인 등록부는 읽지 않는다. 릴리스 버전은 플러그인 manifest에서 읽어 실행 정보와 비교한다. 설치 캐시 업데이트를 흉내 내는 `0.4.0`과 `0.4.1`은 시험 데이터다. |

## Node 시험 (`tests/cua/relay`)

| 파일(시험 수) | 확인하는 것 |
|---|---|
| `relay.test.mjs`(33) | 런타임 앞의 중계기. 양쪽 모두 바이트 그대로 전달(JSON이 아닌 줄과 큰 메시지 포함), 런타임이 받는 인자와 환경, 열린 범위(호스트가 준 값에서만 만든다), `relay.json` 기록, 내용 없는 조작 기록(Claude 다리가 이름을 달아 준 런타임이면 줄마다 그 이름 `owner`, 아니면 없다), 켜질 때 그 다리가 돌고 있었는지 `owner_running`(이름이 있을 때만, 확인이 실패해도 기록은 생긴다), 상태 폴더를 쓸 수 없을 때, 런타임의 종료 코드. 연결 시험의 스레드 폴더(`codex-cua-probe-…`)에서 도는 중계기는 활동 줄도 `last_call_at`도 남기지 않고 범위는 그대로 열고 닫으며, 이름만 비슷한 폴더는 평소대로 기록한다. |
| `release.test.mjs`(25) | 제어 소켓(자기 프로세스에만 답하고 끝내지 않는 연결은 약 2초 뒤 끊는다), `turn_ended`로 범위를 끝내면서 계속 중계하기, 실행 중인 호출 기다리기와 `request_in_flight`, 멈출 때의 자동 놓아주기(3초 한도)와 신호가 겹칠 때. |
| `launcher.test.mjs`(22) | 실행기(`node-repl-relay`)와 `relay.mjs`가 어떤 경우에도 원래 런타임으로 되돌아가는 것. |
| `guard.test.mjs`(14) | 위의 보호 장치(`harness.mjs`)와 종료 코드 0·1·2. |

`harness.mjs`는 가짜 `node_repl`, 중계기 stdio 클라이언트, 제어 소켓 클라이언트를 모은 도우미다. `RELAY_DIR_UNDER_TEST`로 고의로 고장 낸 중계기 복사본을 가리켜 시험이 그 고장을 잡는지 확인할 수 있다.

## 격리

시험은 임시 폴더, fake CLI, mock 호스트를 사용한다. 실제 Codex·CUA·Chrome·GUI·계정이나 credential을 호출하지 않는다. 소켓과 subprocess를 사용하는 시험도 격리된 fake 대상만 생성하고 정리한다. 설치 시험은 가짜 앱을 쓰므로 이 맥에 설치된 Codex 앱을 읽지 않는다.

코드는 지원 폴더를 홈에서 찾는다. 그래서 `run.py`와 Node 도우미는 시험 전체를 버리는 HOME에서 돌린다. 시험이 자기 폴더를 주입하는 것을 잊으면 거기에 쓰게 되고, 거기에 뭔가 생기면 실패한다(종료 코드 1). 시험 파일과 fixture 코드는 고객 설치용 플러그인 폴더에 포함하지 않는다.

이 테스트 코드는 플러그인과 같은 [MIT 라이선스](../../apps/cua-bar/engine/LICENSE)를 따른다.
