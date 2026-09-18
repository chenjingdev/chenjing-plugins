#!/bin/zsh
# 사용: aria_screenshot.sh <baseUrl> <out.png> [높이=1900]
# aria GUI 는 SSE 때문에 load 가 끝나지 않아 --timeout 으로 강제 캡처한다. Chrome 이 종료되지 않아도 파일은 나온다.
url=$1; out=$2; h=${3:-1900}
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
prof=$(mktemp -d /tmp/aria-shot-XXXXXX)
timeout 45 "$CH" --headless=new --disable-gpu --hide-scrollbars --no-first-run --user-data-dir="$prof" --window-size=1800,$h --timeout=12000 --screenshot="$out" "$url/" >/dev/null 2>&1
pkill -f "$prof" 2>/dev/null; rm -rf "$prof"
[[ -s "$out" ]] && echo "OK $out" || { echo "FAIL $out" >&2; exit 1; }
