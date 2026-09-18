#!/bin/zsh
# 사용: cmux_send.sh <workspace:N> "<명령>" [surface:M]
# 입력 줄을 비운 뒤 명령을 \r 로 끝내 보내고, 1초 뒤 화면 마지막 줄을 출력한다.
set -e
export CMUX_QUIET=1
ws=$1; cmd=$2; surf=${3:-}
tgt=(--workspace "$ws"); [[ -n "$surf" ]] && tgt+=(--surface "$surf")
cmux send-key "${tgt[@]}" ctrl+u >/dev/null 2>&1 || true
cmux send "${tgt[@]}" "$cmd"$'\r' >/dev/null
sleep 1
echo "sent → $ws${surf:+ ($surf)}: $(cmux read-screen "${tgt[@]}" --lines 8 2>/dev/null | sed '/^[[:space:]]*$/d' | tail -n 1 | cut -c1-140)"
