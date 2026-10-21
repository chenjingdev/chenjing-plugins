#!/bin/sh
# CUA Bar 설치 (맥): curl -fsSL https://cua.chenjing.org/install.sh | sh
# 받는 곳의 /version에서 최신 판과 dmg의 SHA-256을 읽고, dmg를 받아 확인한 뒤 CUABar.app을 /Applications에
# 깐다(쓸 수 없으면 ~/Applications). 이미 같거나 새 판이 깔려 있으면 받지 않는다. 끝에 앱을 켠다.
# 깔기 전에 앱의 서명과 팀(S3KC8R8VDL)을 확인한다: 받는 곳이 바뀌어도 다른 사람의 앱은 깔지 않는다.
# 이 스크립트가 지우거나 덮어쓰는 것은 앱 자리(CUABar.app) 하나뿐이다. 켜져 있던 옛 판은 끄고 바꾼다.
# 시험용: CUABAR_SITE=<주소>는 받는 곳을, CUABAR_INSTALL_DIR=<폴더>는 깔 폴더를 바꾸고, CUABAR_NO_OPEN=1은 앱을 켜지 않는다.
set -eu

SITE="${CUABAR_SITE:-https://cua.chenjing.org}"
APP_NAME='CUABar.app'
TEAM='S3KC8R8VDL'

WORK=
STAGE=
OLD=

fail() {
  echo "설치하지 못했습니다: $1" >&2
  exit 1
}

cleanup() {
  if [ -n "$WORK" ]; then
    hdiutil detach -quiet "$WORK/mnt" 2>/dev/null || true
    rm -rf "$WORK"
  fi
  if [ -n "$STAGE" ]; then rm -rf "$STAGE"; fi
  if [ -n "$OLD" ]; then rm -rf "$OLD"; fi
}

field() { printf '%s' "$INFO" | plutil -extract "$1" raw -o - - 2>/dev/null; }

# a가 b보다 새 판인지(major.minor.patch).
newer() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    split(a, x, "."); split(b, y, ".")
    for (i = 1; i <= 3; i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 }
    exit 1
  }'
}

# 깔 폴더: 시험용 값, 이미 앱이 있는(쓸 수 있는) 쪽, /Applications, 안 되면 ~/Applications.
pick_dir() {
  if [ -n "${CUABAR_INSTALL_DIR:-}" ]; then
    mkdir -p "$CUABAR_INSTALL_DIR" || return 1
    printf '%s' "$CUABAR_INSTALL_DIR"
  elif [ -d "/Applications/$APP_NAME" ] && [ -w /Applications ]; then
    printf '%s' /Applications
  elif [ -d "$HOME/Applications/$APP_NAME" ] && [ -w "$HOME/Applications" ]; then
    printf '%s' "$HOME/Applications"
  elif [ -w /Applications ]; then
    printf '%s' /Applications
  else
    mkdir -p "$HOME/Applications" || return 1
    printf '%s' "$HOME/Applications"
  fi
}

# 이 자리의 앱이 돌고 있는지.
running() {
  ps -axo command= | awk -v a="$1/Contents/MacOS/cua-bar" 'index($0, a) == 1 { found = 1 } END { exit !found }'
}

# 새 판으로 바꾸기 전에만 부른다. 한 번에 한 앱만 도니, 옛 판이 돌면 새 판은 켜지자마자 끝난다.
stop_running() {
  pkill -f "^$1/Contents/MacOS/cua-bar" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    running "$1" || return 0
    sleep 0.5
  done
  fail "켜져 있는 CUA Bar가 꺼지지 않았습니다. 메뉴 막대 창의 [끝내기]로 끈 뒤 다시 실행하세요."
}

# 전부 main 안에 둔다: 받다가 끊긴 스크립트는 마지막 줄이 없어 아무것도 하지 않는다.
main() {
  [ "$(uname -s)" = Darwin ] || fail "맥에서 쓰는 한 줄입니다."
  [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ] || fail "CUA Bar는 Apple Silicon 맥에서만 돌아갑니다."
  OS=$(sw_vers -productVersion)
  [ "${OS%%.*}" -ge 14 ] || fail "macOS 14 이상이 필요합니다(이 맥은 $OS)."

  INFO=$(curl -fsS "$SITE/version") || fail "받는 곳에서 판 정보를 받지 못했습니다($SITE/version)."
  LATEST=$(field version) || fail "판 정보를 읽지 못했습니다."
  FILE=$(field file) || fail "판 정보를 읽지 못했습니다."
  SHA=$(field sha256) || fail "판 정보를 읽지 못했습니다."

  DIR=$(pick_dir) || fail "앱을 깔 폴더를 만들지 못했습니다."
  APP="$DIR/$APP_NAME"
  INSTALLED=$(plutil -extract CFBundleShortVersionString raw -o - "$APP/Contents/Info.plist" 2>/dev/null) || INSTALLED=

  if [ -n "$INSTALLED" ] && ! newer "$LATEST" "$INSTALLED"; then
    echo "이미 설치됨: 판 $INSTALLED ($APP)."
  else
    trap cleanup EXIT
    WORK=$(mktemp -d "${TMPDIR:-/tmp}/cua-bar-install.XXXXXX") || fail "임시 폴더를 만들지 못했습니다."
    echo "CUA Bar 판 ${LATEST}을 받습니다."
    curl -fsS -o "$WORK/$FILE" "$SITE/$FILE" || fail "dmg를 받지 못했습니다."
    GOT=$(shasum -a 256 "$WORK/$FILE" | awk '{ print $1 }')
    [ "$GOT" = "$SHA" ] || fail "받은 dmg가 알려 준 SHA-256과 다릅니다."
    mkdir "$WORK/mnt"
    hdiutil attach -quiet -nobrowse -readonly -noautoopen -mountpoint "$WORK/mnt" "$WORK/$FILE" || fail "dmg를 열지 못했습니다."
    [ -d "$WORK/mnt/$APP_NAME" ] || fail "dmg에 앱이 없습니다."
    STAGE="$DIR/.cua-bar-install.$$"
    rm -rf "$STAGE"
    ditto "$WORK/mnt/$APP_NAME" "$STAGE/$APP_NAME" || fail "앱을 복사하지 못했습니다(${DIR}에 쓸 수 없습니다)."
    hdiutil detach -quiet "$WORK/mnt" || true
    codesign --verify --deep --strict "$STAGE/$APP_NAME" 2>/dev/null || fail "받은 앱의 서명이 맞지 않습니다."
    codesign -dv "$STAGE/$APP_NAME" 2>&1 | grep -qx "TeamIdentifier=$TEAM" || fail "받은 앱의 개발자가 CUA Bar의 개발자($TEAM)가 아닙니다."
    if [ -e "$APP" ]; then
      if running "$APP"; then
        echo "켜져 있는 CUA Bar 판 ${INSTALLED}을 끕니다."
        stop_running "$APP"
      fi
      OLD="$DIR/.cua-bar-old.$$"
      mv "$APP" "$OLD" || fail "옛 앱을 비켜 두지 못했습니다($APP)."
    fi
    mv "$STAGE/$APP_NAME" "$APP" || {
      [ -z "$OLD" ] || mv "$OLD" "$APP"
      OLD=
      fail "앱을 제자리에 두지 못했습니다($APP)."
    }
    echo "설치했습니다: $APP (판 $LATEST)"
  fi

  if [ "${CUABAR_NO_OPEN:-}" = 1 ]; then
    echo "앱은 켜지 않았습니다(CUABAR_NO_OPEN=1)."
    return 0
  fi
  open "$APP" || fail "앱을 켜지 못했습니다($APP)."
  echo "CUA Bar를 켰습니다. 메뉴 막대에 아이콘이 생깁니다."
}

main "$@"
