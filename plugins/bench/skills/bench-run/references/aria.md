# aria 전용 절차

## 인스턴스 찾기

벤치 런은 `ARIA_DATA_DIR_PER_SESSION=1`로 돌아 런마다 `~/.bench/aria/data-<harness>/sessions/<시각>-<pid>/` 아래에 자기 인스턴스를 갖는다. 그 안의 `runtime.json`에 `baseUrl`, `pid`, `bridgeToken`이 있다.
**살아 있는 pid로 골라라.** 죽은 인스턴스의 runtime.json도 남아 있고 포트 번호가 재사용되므로 포트로 찾으면 잘못 짚는다.

```
curl -s -H "Authorization: Bearer <bridgeToken>" -H "Content-Type: application/json" -X POST <baseUrl>/api/rpc -d '{"tool":"get_song","args":{}}'
```

`get_song` 결과는 요약 줄들 + 빈 줄 + 곡 JSON이다. `edit_history`는 마지막 30단계의 편집 종류("곡 통째 교체", "노트 추가 (Violin)", "구간 복제" …)를 준다. 트랜스크립트에 페이로드가 없을 때 작곡 방식을 판정하는 근거다.

런 사이 상태: 인스턴스는 런이 끝나도 남는다. 사용자가 GUI(`baseUrl`)에서 들어 볼 수 있게 두고, 정리는 `sessions/*/runtime.json`의 pid에 SIGTERM.

## 결과물 모으기

- MP3: 모델이 `export`에 경로를 주면 그 경로(Codex는 cwd인 `~/.bench/aria/work`에 썼다), 안 주면 `~/Music/aria/<제목 정리본>.mp3`. 양쪽을 런 태그로 찾는다. `ffprobe -show_entries format=duration`으로 길이를 기록한다.
- 화면: `scripts/aria_screenshot.sh <baseUrl> <out.png> [높이]`. 헤드리스 Chrome은 aria의 SSE 때문에 load가 끝나지 않아 `--timeout=12000`으로 강제 캡처하고 `timeout 45`로 감싼다(Chrome이 종료되지 않아도 파일은 나온다). 1800×1900이 기본, 트랙이 25개를 넘으면 2600. Playwright MCP는 응답이 없었다.
- 곡 JSON: `get_song`의 JSON 부분. 필드는 `title, bpm, timeSig, tempoMap[{bar,bpm,ramp}], tracks[{name,preset,volume,pan,reverb,velRange,gains[],articulation,articulationRegions[],notes[{bar,beat,pitch,dur,vel}]}], sections[{bar,label}]`. `pitch`는 `"C4"` 같은 음이름(C4=60) 또는 타악 피스 이름 문자열.
- 타이밍 수식: 웹 플레이어가 재생 막대를 MP3에 맞추려면 aria `src/song.js`의 `tempoSegments/beatToSec/secToBeat/noteToMidi`가 필요하다. 프리셋 의존 함수(`notePlaybackEndBeat`)와 import를 떼고 `songs/aria-timing.js`로 넣는다(`aria_collect.py`가 aria 저장소가 있으면 자동으로 만든다).

## 작곡 방식 지표 (`aria_collect.py`가 계산)

도구 호출 순서에서:

- `first_note_call_index` — 처음으로 노트가 들어간 호출의 순번. 편성 탐색이 긴 모델은 크다(Claude 17~46, Codex 3~9).
- `add_notes_calls`, `add_notes_avg` — 점진형의 배치 크기(Claude 40~70노트, Grok 17~78, Codex Sol xhigh 114).
- `set_song_calls`, `set_song_max_notes` — 통째 배치형. `set_song`은 곡 전체 JSON을 넣으므로 한 번의 노트 수가 곡 전체다.
- `biggest_call_share` — 가장 큰 단일 호출의 노트 수 / 최종 노트 수. 1.0이면 통째 배치.
- `build_style` — 위로 판정: `whole-song batch (set_song)`, `incremental (add_notes per track/section)`, `mixed`, 그리고 페이로드가 잘린 agy는 편집 이력의 "곡 통째 교체"로 보정.
- `direct_http_api_calls` — 셸 명령 인자에 `api/rpc`가 있는 수. MCP를 우회한 조작.
- `listen_calls`(play), `mix_calls`(set_region_gain·set_velocity·humanize), `articulation_calls`, `section_calls`, `tempo_calls`, `self_check_calls`(get_song·check_key·edit_history).
- `active_min` — 연속 호출 사이 20분 넘는 공백을 뺀 실제 작업 시간. 세션 재개 런은 `elapsed_min`이 몇 시간이 되므로 이것을 쓴다.

## runs-spec.json 형식 (`aria_collect.py` 입력)

```json
{
  "app": "aria",
  "rounds": {"harbor": "새벽 항구", "free": "자유곡"},
  "models": {
    "fable": {"harness": "claude", "harness_display": "Claude Code", "model_id": "claude-fable-5-1", "display": "Claude Fable 5.1", "slug": "claude-fable-5.1"}
  },
  "runs": [
    {"round": "harbor", "tag": "fable-medium", "model": "fable", "effort": "medium", "conditions": ""}
  ],
  "mp3_dirs": ["~/Music/aria", "~/.bench/aria/work"],
  "aria_repo": "~/dev/aria"
}
```

런의 인스턴스는 곡 제목 `"<라운드 제목> (<tag>)"`을 가진 **살아 있는** 인스턴스로 자동 매칭한다. 트랜스크립트도 같은 제목 문자열로 찾는다. 출력은 `audio/ screenshots/ songs/ process/ prompts/ runs.json README.md`이며, 결과물 파일은 slug `<round>_<model slug>_<effort>`로 복사된다.

## 공유용 패키지에 넣을 지시문

블로그·스레드 공개용 페이지를 다른 에이전트에게 맡길 때는 목표만 준다: (1) 곡 JSON으로 피아노롤을 그리고 MP3 `currentTime`을 `secToBeat`로 바꿔 재생 막대를 움직이는 플레이어, (2) 도구 호출 순서 데이터로 쓴 작곡 방식 분석, (3) 프롬프트와 실행 조건 공개, (4) 조건이 달랐던 런의 표시와 N=1 스냅숏이라는 소개. 데이터에 없는 수치를 만들지 말라는 한 줄을 붙인다. 구현 방법을 길게 지시할 필요는 없다.
