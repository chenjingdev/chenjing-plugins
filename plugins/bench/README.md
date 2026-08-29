# bench

내 앱을 **순정 하네스**에서 돌려 보는 벤치. Claude Code / Codex / agy 를 사용자 MCP·스킬·플러그인·훅(Honcho 포함) 없는 깨끗한 프로필로 띄우고, 벤치 대상 앱의 MCP 하나만 붙인다.

```zsh
ariabench claude                        # 대화형 (첫 1회 /login)
ariabench codex --effort low -- "…"     # 비대화형 1회
ariabench agy                           # agy
ariabench skill on                      # 앱 스킬(aria-compose)을 벤치 프로필에 설치 — 기본은 미설치(raw). off 로 제거
bench status                            # 앱·프로필·스킬 설치 상태·CLI 버전
```

새 앱 등록은 Claude Code에 **"myapp 벤치 만들어줘"** 라고 말하면 된다 — `bench-profile` 스킬이 실제 프로필의 MCP 정의를 찾아 `~/.bench/apps/<app>.json`을 쓰고 프로필을 만들고 격리를 검증한다. 새 `<app>bench` 함수는 `source ~/.zshrc` 뒤에 생긴다.

셸 설정(`~/.zshrc`)에 한 번 넣는다:

```zsh
# bench 플러그인 (chenjing-plugins) — 러너 탐색: BENCH_MJS > 설치된 플러그인 캐시의 최신 버전 > 개발 리포
bench() {
  local mjs="${BENCH_MJS:-}"
  if [[ -z "$mjs" ]]; then local -a cands; cands=("$HOME"/.claude/plugins/cache/chenjing-plugins/bench/*/(N)); (( ${#cands} )) && mjs="$(print -l "${cands[@]}" | sort -V | tail -1)scripts/bench.mjs"; fi
  [[ -f "$mjs" ]] || mjs="$HOME/dev/chenjing-plugins/plugins/bench/scripts/bench.mjs"
  [[ -f "$mjs" ]] || { echo "bench: 러너를 찾지 못했습니다 (bench 플러그인 설치 또는 BENCH_MJS 지정)" >&2; return 1; }
  node "$mjs" "$@"
}
for _app in "$HOME"/.bench/apps/*.json(N:t:r); do eval "${_app}bench() { bench run $_app \"\$@\"; }"; done; unset _app
```

내부 구조·앱 JSON 스키마·하네스별 함정은 `skills/bench-profile/references/`에 있다(에이전트가 읽는 문서).
