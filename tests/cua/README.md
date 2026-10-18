# Codex CUA 개발용 테스트

`plugins/cua`(0.7.0)의 회귀 시험이다. Python 시험 539개와 Node 시험 84개가 있고, 둘 다 저장소 루트에서 실행한다. 각각 1분쯤 걸린다.

```sh
python3 tests/cua/run.py       # Python 시험 539개
node --test tests/cua/relay    # Node 시험 84개 (중계기)
```

- Python 시험은 표준 라이브러리의 `unittest`만 쓰고 Python 3.9 이상이면 된다. `run.py`가 `plugins/cua`를 모듈 검색 경로에 추가한 뒤 이 폴더의 `test_*.py`를 찾아 실행한다. `bridge_case.py`, `fake_host.py`, `engine_support.py`, `fake_native_cli.py`, `toml_subset.py`는 시험이 쓰는 도우미라 수집되지 않는다.
- Node 시험은 `node:test`만 쓴다. 이 맥의 Node 26.8.1에서 확인했다. `relay/index.js`는 `node --test`에 폴더를 넘기면 그 폴더를 모듈 경로로 읽는 판(22, 24)에서 네 시험 파일을 대신 불러오는 입구다. 폴더를 직접 펼치는 판에서는 쓰이지 않는다.

## CUA를 쓰지 않을 때 돌린다

시험은 임시 폴더와 가짜 프로그램만 쓰지만, 이 맥의 실제 지원 폴더를 읽기만 하는 보호 장치가 시험 시작과 끝에 지문(종류·크기·수정 시각·inode)을 떠서 비교한다. 지켜보는 곳은 `~/.local/share/codex-cua`, `~/.local/bin/codex-cua`, `~/Library/Caches/codex-cua`, `~/Library/Caches/codex-host-cua`, 그리고 `~/Library/LaunchAgents`에서 이름이 `com.chenjingdev.`로 시작하는 항목이다. 시험 중에 이 곳들이 바뀌면 시험이 모두 통과해도 실패로 끝낸다.

시험이 쓰지 않아도 바뀐다. CUA를 쓰면 연결이 `~/Library/Caches/codex-cua`에 기록을 쓰고, Codex를 켜거나 플러그인을 설치해도 이 곳들이 바뀐다. 그래서 **시험은 CUA를 쓰지 않을 때 돌린다.** 보호 장치에 걸렸으면 CUA를 쓰지 않을 때 다시 돌리고, 아무것도 안 쓰는데도 계속 걸리면 시험이 거기에 쓰는 것이니 고친다.

| 종료 코드 | 뜻 |
|---|---|
| 0 | 모두 통과했다. |
| 1 | 시험이 실패했거나, 시험이 버리는 HOME에 썼다(자기 폴더를 주입하지 않았다). |
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
| 실행 스크립트와 대체 실행 | `test_launcher`(10), `test_desktop_cli_wrapper`(20) | 플러그인이나 실행 환경이 깨져도 Codex가 원본 CLI로 켜지는 경로 세 곳. 실제 `/bin/sh`로 도는 실행 스크립트(인터프리터 없음·실행 불가·끊어진 링크, `command.py` 없음, 원본 CLI를 모르는 경우), 백엔드를 시작하기 전에 실패하는 래퍼(상태 폴더·점유(끊어진 심볼릭 링크 포함)·시간 설정·메타데이터 쓰기·실행 실패에서 인자와 환경을 그대로 넘겨 exec), `--exec-wrapper` 사전 검사(래퍼와 전송 스크립트가 없거나 손상됨, 의존성이 준비되지 않았거나 다른 프로세스가 복구 중이어도 기다리거나 설치하지 않고 바로 원본 CLI). 백엔드가 시작된 뒤의 실패는 실패로 남는다. |
| 위임 | `test_delegation`(14) | `codex-cua`가 등록된 플러그인 판의 `setup.py`로 넘기는 것. 인자와 `--` 뒤 인자 보존, 이 복사본이 모르는 명령, 두 번 넘기지 않기, 0.7.0 이전 판에는 모르는 `--root-resolved`를 붙이지 않고 Codex에는 받은 인자 그대로 넘기기, 등록이 없거나 손상됐을 때 원본 CLI로 실행하기, 실제 프로세스로 실행 스크립트에서 새 판까지 이어지는 흐름. |
| 브리지 기록 | `test_bridge_records`(12) | 상태 폴더(`$CODEX_CUA_STATE_DIR`, 없으면 `~/Library/Caches/codex-cua`)의 위치와 비공개 권한, 프로세스 신원(pid와 시작 시각), 조작 기록(`activity.jsonl`)의 쓰기와 줄이기. |
| 제어와 수명 주기 | `test_bridge_control`(10), `test_bridge_lifecycle`(55), `test_bridge_process`(10) | Claude 브리지가 기록과 제어 소켓을 두는 것(자기 프로세스에만 답하고 잘못된 요청은 답 없이 끊는다), 턴 번호 바꾸기, 연 범위를 모두 놓아주기, 실행 중인 호출이 있을 때의 `request_in_flight`, Codex가 꺼졌다 켜진 뒤의 재연결(끊길 때 하던 호출은 다시 보내지 않고 `turn_ended`는 Codex를 다시 켜지 않는다). 실제 프로세스로는 stdin 끝과 종료 신호에서 어떻게 끝나는지, 강제 종료가 무엇을 남기는지. |
| 중계기 설치 | `test_relay_install`(50) | 고정 사본(`~/.local/share/codex-cua/relay/`)을 쓰고 새로 고치는 것, Codex를 켤 때 중계기를 끼울 계획(`cua_repl` 정의를 읽어 맞을 때만 끼우고 하나라도 어긋나면 거절)과 거절 이유들, 시험이 지정한 폴더 밖에 쓰지 못하는 것. |
| 시작(launch) | `test_relay_launch`(19) | Codex를 켤 때 중계기를 앞에 끼우거나, 끼울 수 없으면 원래대로 시작하는 것. `host.json`의 `relay`와 `relay_reason`, 백엔드가 시작 중에 죽으면 중계기 없이 한 번 더 시작하는 것. |
| 브리지와 통로 | `test_relay_bridge`(8), `test_unix_ws_stdio`(12) | 브리지가 번들 플러그인이 아닌 `cua_repl` 서버를 이 플러그인의 중계기일 때만 받아들이는 것, 데스크톱 통로가 바이트 그대로 전달하되 중계기를 가리키는 값 하나만 바꾸는 것(그 밖의 줄과 응답은 그대로). |
| 엔진 | `test_engine_inventory`(34), `test_engine_records`(27), `test_engine_status`(59), `test_engine_release`(36), `test_engine_actions`(60), `test_engine_cli`(21) | `codex-cua`의 엔진 명령. 프로세스와 기록을 읽어 연결·점유·조작 기록·화면 상태로 만드는 `status`(JSON의 모든 필드, 연결의 주인 가르기, 쉼과 끝남), `release`와 `release-session`(주인이 사라진 세션만, `--user`, `session_live`, `not_found`), `stop`과 묶음 종료(보호 목록, 신원 재확인, `unattributed`), `restart-codex`(정상 종료만), `diagnose`(홈은 `~`), 명령줄과 JSON 한 덩어리 출력. 가짜 프로세스 표와 임시 파일·소켓으로 세상을 만들고, 진짜 프로세스로는 임시 HOME에서 `status`, `diagnose`, `doctor`를 돌려 본다(실제 프로세스 목록을 읽기만 한다). |
| 보호 장치 | `test_guard`(15) | 지문이 같은 크기로 덮어쓴 파일과 원자적 교체, 새로 생기거나 사라진 항목을 보는 것, 링크를 따라가지 않는 것, 우리 로그인 항목만 지켜보는 것, 바뀐 경로의 출력, `run.py`의 종료 코드 0·1·2. |
| 기본(0.6.0부터) | `test_host_mcp`(24), `test_setup`(22), `test_autostart`(12), `test_registry`(5), `test_runtime_paths`(4) | MCP catalog·이미지·오류·승인 전달, 전용 thread 종료, 다른 client 유지, launcher의 인자·환경·stdio 보존, registry와 원본 앱 탐색, 설치 캐시 업데이트, 의존성 준비의 동시 실행과 부분 설치 복구, 닫힌 앱의 백그라운드 실행과 포커스 복귀, 켜져 있는 앱 보존, 동시 실행 시 한 번만 열기, 로그인 항목 설정·충돌 보존·제거. 릴리스 버전은 플러그인 manifest에서 읽어 실행 정보와 비교한다. 설치 캐시 업데이트를 흉내 내는 `0.4.0`과 `0.4.1`은 시험 데이터다. |

## Node 시험 (`tests/cua/relay`)

| 파일(시험 수) | 확인하는 것 |
|---|---|
| `relay.test.mjs`(23) | 런타임 앞의 중계기. 양쪽 모두 바이트 그대로 전달(JSON이 아닌 줄과 큰 메시지 포함), 런타임이 받는 인자와 환경, 열린 범위(호스트가 준 값에서만 만든다), `relay.json` 기록, 내용 없는 조작 기록, 상태 폴더를 쓸 수 없을 때, 런타임의 종료 코드. |
| `release.test.mjs`(25) | 제어 소켓(자기 프로세스에만 답하고 끝내지 않는 연결은 약 2초 뒤 끊는다), `turn_ended`로 범위를 끝내면서 계속 중계하기, 실행 중인 호출 기다리기와 `request_in_flight`, 멈출 때의 자동 놓아주기(3초 한도)와 신호가 겹칠 때. |
| `launcher.test.mjs`(22) | 실행기(`node-repl-relay`)와 `relay.mjs`가 어떤 경우에도 원래 런타임으로 되돌아가는 것. |
| `guard.test.mjs`(14) | 위의 보호 장치(`harness.mjs`)와 종료 코드 0·1·2. |

`harness.mjs`는 가짜 `node_repl`, 중계기 stdio 클라이언트, 제어 소켓 클라이언트를 모은 도우미다. `RELAY_DIR_UNDER_TEST`로 고의로 고장 낸 중계기 복사본을 가리켜 시험이 그 고장을 잡는지 확인할 수 있다.

## 격리

시험은 임시 폴더, fake CLI, mock 호스트를 사용한다. 실제 Codex·CUA·Chrome·GUI·계정이나 credential을 호출하지 않는다. 소켓과 subprocess를 사용하는 시험도 격리된 fake 대상만 생성하고 정리한다. 설치 시험은 가짜 앱을 쓰므로 이 맥에 설치된 Codex 앱을 읽지 않는다.

코드는 지원 폴더를 홈에서 찾는다. 그래서 `run.py`와 Node 도우미는 시험 전체를 버리는 HOME에서 돌린다. 시험이 자기 폴더를 주입하는 것을 잊으면 거기에 쓰게 되고, 거기에 뭔가 생기면 실패한다(종료 코드 1). 시험 파일과 fixture 코드는 고객 설치용 플러그인 폴더에 포함하지 않는다.

이 테스트 코드는 플러그인과 같은 [MIT 라이선스](../../plugins/cua/LICENSE)를 따른다.
