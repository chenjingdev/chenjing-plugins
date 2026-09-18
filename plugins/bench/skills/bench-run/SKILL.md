---
name: bench-run
description: Run a model×harness×effort benchmark matrix on the user's app through the bench runner, driving each run from its own cmux terminal, watching for completion, recovering interrupted runs, and collecting the results into a shareable package with per-run tool-call timelines. Use this whenever the user wants to "run the bench", compare models or efforts on an MCP app (aria or any registered bench app), has opened cmux terminals named after models ("fable xhigh", "sol medium", "grok xhigh"), asks to send a prompt to those terminals, wants to know whether runs finished or why one stopped, wants to resume or redo an interrupted run, or wants results (audio, screenshots, song data, metrics) gathered and packaged for a blog or thread. Also use it when the user asks how a model "worked" (order of tool calls, batch vs incremental) — the transcript extraction here is how you answer that.
---

# bench-run — 벤치 매트릭스를 터미널에서 돌리고 결과를 거두기

`bench-profile` 스킬이 앱을 벤치에 **등록**하는 스킬이라면, 이 스킬은 등록된 앱을 여러 모델·하네스·effort로 **실제로 돌리고 결과를 거두는** 스킬이다.
한 라운드는 "같은 프롬프트 × 조합 N개"이고, 조합마다 cmux 터미널 하나에서 `<app>bench <harness> …` 한 줄이 돈다.

이 문서는 흐름과 판단 기준만 담는다. 세부는 참고 문서로 간다.

- `references/cmux.md` — cmux CLI로 터미널을 읽고 입력하는 법과 함정(인덱스 vs 참조, 포커스 도둑 브라우저 패널, 키 이름).
- `references/harnesses.md` — 하네스별 모델 플래그·effort 어휘·트랜스크립트 위치와 형식(도구 호출을 어디서 어떻게 뽑는지).
- `references/failures.md` — 런이 끊기는 다섯 가지 방식과 각각의 대처(재실행·세션 재개·대화형 입력), 그리고 결과에 붙일 각주.
- `references/aria.md` — aria 앱 전용: 인스턴스 찾기, 곡 JSON·MP3·화면 수집, 작곡 방식 지표, 공유 패키지 구성.

## 시작 전에 확인할 것

1. **러너 버전.** 셸의 `bench` 함수는 설치된 플러그인 캐시를 먼저 잡는다. 개발 중인 러너를 써야 하면 `export BENCH_MJS=~/dev/chenjing-plugins/plugins/bench/scripts/bench.mjs`를 명령 앞에 붙인다. `bench run <app> <harness> --dry-run -- x`로 실제 실행될 명령을 먼저 본다.
2. **런 사이 격리.** 같은 하네스를 두 개 이상 동시에 돌리면 앱 인스턴스를 공유하지 않는지 확인한다(aria는 `ARIA_DATA_DIR_PER_SESSION=1`, 다른 앱은 앱 정의 env의 `{harness}` 치환). 공유되면 두 모델이 한 곡을 함께 편집해 결과가 못 쓰게 된다.
3. **공유 작업 디렉터리 청소.** `~/.bench/<app>/work`는 모든 런이 cwd로 쓰는 디렉터리라 이전 라운드의 스크립트·산출물이 남는다(Grok은 노트 생성 Python을 여기 쓴다). 라운드 전에 비운다. 앞 런의 흔적이 다음 모델의 선택에 새어 들어가면 벤치가 아니다.
4. **프롬프트 파일.** `~/.bench/<app>/prompts/<이름>.txt`에 두고 `{run}` 자리표시자를 넣는다. 런 태그(예 `sol-xhigh`)가 곡 제목·파일명에 들어가야 결과를 나중에 어느 런인지 알 수 있다. 측정하려는 성향을 프롬프트에서 이름 붙이지 않는다("반복하지 마" 같은 말은 성향 대신 지시 이행을 재게 만든다).

## 1. 매트릭스 읽기

사용자가 cmux 워크스페이스 이름을 모델·effort로 붙여 놓는 경우가 많다(`fable xhigh`, `sol medium`, `agy 3.8 high`, `gpt-oss-120b medium`). `cmux workspace list`로 이름을 읽고 `references/harnesses.md`의 표로 하네스·모델 플래그·effort를 확정한다. 모를 이름은 각 CLI의 모델 목록(`grok models`, `agy models`, Codex 설정의 `model =`, 이전 벤치 트랜스크립트의 `"model":`)으로 확인하고, 그래도 모르면 사용자에게 묻는다. 추측한 모델 ID로 돌리면 라운드 하나가 버려진다.

각 워크스페이스의 터미널 surface를 `cmux tree --workspace workspace:N`으로 확인해 두라. 나중에 브라우저 패널이 생기면 `--surface`를 명시해야 한다.

## 2. 보내기

터미널마다 입력 줄을 비우고(`send-key ctrl+u`) 명령을 `\r`로 끝내 보낸다. 명령 형태:

```
export BENCH_MJS=…; ariabench <harness> [--model M] --effort E -- "$(sed 's/{run}/<태그>/' ~/.bench/aria/prompts/<이름>.txt)"
```

`scripts/cmux_send.sh workspace:N "<명령>"`이 이 두 단계를 한다. 보낸 직후 각 화면의 마지막 줄을 읽어 `[bench] …` 헤더가 찍혔는지 확인한다. 한 라운드의 조합을 전부 같은 시각에 보낸다. 시작 시각이 다르면 소요 시간 비교가 흐려진다.

## 3. 감시

직접 폴링하지 말고 Monitor 도구로 스크립트를 돌린다.

- 비대화형 런: `scripts/monitor_runs.py 11:fable-medium 15:fable-xhigh …` — 화면 마지막 줄이 셸 프롬프트로 돌아오면 `DONE <이름> +Nm :: <마지막 줄들>`을 내고, 5분마다 heartbeat를 낸다.
- 대화형 TUI(agy 등): `scripts/monitor_tui.py workspace:N surface:M <이름>` — 실행 중("esc to cancel")에서 유휴("? for shortcuts")로 바뀌는 순간마다 화면 꼬리를 낸다. 유휴가 "끝"이 아니라 "질문하고 기다림"일 수도 있으니 꼬리를 읽고 판단한다.

DONE 꼬리에 오류 문구가 보이면 곧바로 `references/failures.md`로 간다. 첫 DONE이 너무 빨리(1~2분 안에) 오면 거의 항상 실패다.

완료 신호만으로 충분하다고 믿지 말고, 앱 쪽 상태도 함께 본다(aria면 인스턴스의 `get_song` 요약). 모델이 "내보냈다"고 말해도 파일이 없는 경우가 실제로 있었다.

## 4. 끊긴 런 이어가기

원칙: **조건이 같은 재실행이 최선, 세션 재개가 차선, 새 지시는 최후**이고, 어느 쪽이든 그 런의 `conditions`에 남긴다. 사용자가 "이어서 해"라고 하면 세션 재개를 먼저 시도하고, 하네스가 재개를 지원하지 않거나 상태가 사라졌으면 새 지시를 쓴다. 각 상황의 절차는 `references/failures.md`.

## 5. 거두기

런이 모두 끝나면 세 층을 모은다.

1. **결과물**: 앱이 내보낸 파일(MP3 등)과 화면. 모델이 경로를 스스로 정하므로 `~/Music/<app>`와 `~/.bench/<app>/work` 양쪽을 다 뒤진다. 파일명은 `<라운드>_<모델>_<effort>` slug로 통일하고 표시 이름은 메타데이터에 둔다.
2. **과정**: 하네스별 트랜스크립트에서 도구 호출 순서를 뽑는다. `scripts/extract_calls.py --harness <h> --match "<제목 태그>" --tools ~/.bench/apps/<app>.json --out <slug>.calls.jsonl`. 앱 자체의 편집 이력(aria `edit_history`)도 같이 저장한다. 트랜스크립트에 페이로드가 잘려 있을 때(agy) 작곡 방식을 판정하는 근거가 된다.
3. **메타데이터**: 런마다 하네스·모델·effort·조건·지표를 `runs.json` 한 파일에. 표·글의 모든 숫자는 여기서만 나온다.

aria라면 `scripts/aria_collect.py <runs-spec.json> <출력 디렉터리>`가 1~3을 한 번에 한다(스펙 형식은 `references/aria.md`).

## 6. 보고

사용자에게는 표 하나와 각주로 끝낸다. 표는 런별 곡 규모(마디·트랙·노트)·결과물 길이·도구 호출 수·소요 시간·작곡 방식. 각주는 조건이 달랐던 런과 하네스 간 비교가 안 되는 수치(effort 어휘, 메타 도구 호출 포함 여부, HTTP 직접 호출). 평가 어휘(지루하다·창의적이다) 대신 구조 지표를 보여 준다. 인스턴스가 떠 있으면 GUI 포트 목록과 정리 명령을 붙인다.

## 스크립트

| 파일 | 역할 |
|---|---|
| `scripts/cmux_send.sh` | 워크스페이스(또는 surface)의 입력 줄을 비우고 명령을 보낸다 |
| `scripts/monitor_runs.py` | 비대화형 런 완료 감시(Monitor 도구용) |
| `scripts/monitor_tui.py` | 대화형 TUI 유휴 전이 감시(Monitor 도구용) |
| `scripts/extract_calls.py` | 하네스별 트랜스크립트 → 도구 호출 순서 jsonl + 요약 지표 |
| `scripts/aria_collect.py` | aria 런 수집·패키징(곡 JSON·결과물·화면·지표·runs.json·summary.md) |
| `scripts/aria_screenshot.sh` | 헤드리스 Chrome으로 aria 화면 저장 |
