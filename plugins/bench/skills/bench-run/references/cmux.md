# cmux 터미널 제어

cmux는 소켓 CLI(`/opt/homebrew/bin/cmux`)로 제어한다. `CMUX_QUIET=1`을 환경에 두면 alias 안내문이 사라진다.

## 대상 지정 — 숫자 하나는 인덱스다

`--workspace 11`은 **목록 순서 11번째**(0부터)이고, 이름표의 번호가 아니다. 사용자가 "workspace:11"이라 부르는 것은 참조(ref)다.
항상 `--workspace workspace:11`처럼 `workspace:` 접두를 붙인다. 2026-09-05에 인덱스로 읽어 다른 워크스페이스 화면을 보고도 이름표는 맞게 찍혀 있어서 한참 눈치 못 챘다.

```
cmux workspace list                       # "workspace:11  fable medium" 형식. 이름이 모델·effort
cmux tree --workspace workspace:11        # 패널·surface 구조. 어떤 surface 가 [terminal] 인지
cmux read-screen --workspace workspace:11 --lines 40 [--scrollback] [--surface surface:14]
cmux send --workspace workspace:11 $'명령\r'      # \r 로 끝내야 실행된다
cmux send-key --workspace workspace:11 ctrl+u     # 입력 줄 비우기. 키 이름은 ctrl+u 형식(C-u 는 Unknown key)
```

## 포커스 도둑

agy 같은 하네스는 실행 중 로컬 서버 URL을 열어 cmux 가 같은 워크스페이스에 **브라우저 surface**를 만들고 그쪽으로 포커스가 간다. 그 뒤 `--workspace`만 주면 `read-screen`은 "Surface is not a terminal", `send`는 브라우저로 간다.
런을 보내기 전에 `cmux tree`로 터미널 surface 참조(`surface:30` 등)를 적어 두고, 감시·입력은 `--surface`를 명시한다. `monitor_tui.py`는 그래서 surface 를 인자로 받는다.

## 완료 판정

비대화형 런은 화면 마지막 비어 있지 않은 줄이 셸 프롬프트(`… dev % `)로 돌아오면 끝이다. 프롬프트 문자열은 사용자마다 다르니 `monitor_runs.py`의 정규식(`MacStudio dev % *$`)을 그 컴퓨터에 맞게 고친다. 명령 echo 줄(`… dev % ariabench …`)은 프롬프트 뒤에 글자가 있어 매치되지 않는다.

대화형 TUI는 프롬프트가 늘 있으니 상태 줄로 본다. agy: 실행 중 `esc to cancel`, 유휴 `? for shortcuts`. 끝나면 만족도 설문(`[1] Good … [0] Skip`)이 뜨는데 `0`을 보내 넘긴다.

## 입력 줄 청소

터미널에 사용자가 쳐 둔 글자가 남아 있을 수 있다(예: `g`). 그 위에 명령을 보내면 `gexport …`가 된다. 보내기 전에 `send-key ctrl+u`.

## 여러 줄 프롬프트

TUI에 여러 줄을 보내면 첫 줄에서 제출된다. 대화형에 넣을 때는 줄을 공백으로 이어 한 줄로 만든다. 비대화형 `-- "$(sed … 파일)"` 형태는 셸이 처리하니 여러 줄이어도 된다.
