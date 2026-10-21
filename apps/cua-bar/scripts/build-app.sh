#!/bin/zsh
# Builds CUABar.app next to Package.swift and signs it with the hardened runtime, ad hoc by default.
# The app's version is the cua plugin's version: they ship together and the app compares them.
#
#   ./scripts/build-app.sh             build only
#   ./scripts/build-app.sh --install   build, then copy it into ~/Applications the way agent-bar does:
#                                      back up what is there, refuse while the app runs, verify the
#                                      signature of the copy before it replaces anything
#
# CUABAR_CODE_SIGN_IDENTITY picks another signing identity (a release uses its Developer ID one,
# which also gets a secure timestamp); the default is ad hoc ("-").

set -euo pipefail

script_dir=$(cd "$(dirname "$0")" && pwd)
package_dir=$(cd "$script_dir/.." && pwd)
plugin_manifest="$package_dir/engine/.claude-plugin/plugin.json"

bundle_name="CUABar.app"
bundle_path="$package_dir/$bundle_name"
executable_name="cua-bar"
bundle_identifier="dev.chenjing.cua-bar"
build_configuration="release"
signing_identity="${CUABAR_CODE_SIGN_IDENTITY:--}"
install_dir="$HOME/Applications"
install_path="$install_dir/$bundle_name"
should_install=0

for arg in "$@"; do
  case "$arg" in
    --install)
      should_install=1
      ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Usage: ./scripts/build-app.sh [--install]" >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "$plugin_manifest" ]]; then
  echo "Plugin manifest not found: $plugin_manifest" >&2
  exit 1
fi
version=$(plutil -extract version raw -o - "$plugin_manifest")
if [[ ! "$version" =~ '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$' ]]; then
  echo "Plugin version is not a plain version number: '$version'" >&2
  exit 1
fi

# Replacing the files of a running app would leave the old copy running, and a new copy leaves at
# once because only one copy runs at a time. So an install waits until it has been quit.
app_is_running() {
  pgrep -x "$executable_name" >/dev/null
}
if [[ "$should_install" -eq 1 ]] && app_is_running; then
  echo "CUA Bar is still running; nothing was built or installed. Quit it (끝내기 in its popover) and run this again." >&2
  exit 1
fi

cd "$package_dir"
echo "Building $executable_name $version ($build_configuration)..."
swift build -c "$build_configuration" --product "$executable_name"

bin_dir=$(swift build -c "$build_configuration" --show-bin-path)
binary_path="$bin_dir/$executable_name"
if [[ ! -x "$binary_path" ]]; then
  echo "Built binary not found: $binary_path" >&2
  exit 1
fi

echo "Creating app bundle at $bundle_path"
rm -rf "$bundle_path"
mkdir -p "$bundle_path/Contents/MacOS"
mkdir -p "$bundle_path/Contents/Resources"
cp "$binary_path" "$bundle_path/Contents/MacOS/$executable_name"
# Drawn by code at every build. Without it the notification question showed a blank icon.
swift "$script_dir/make-icon.swift" "$bundle_path/Contents/Resources/AppIcon.icns"

cat > "$bundle_path/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>ko</string>
  <key>CFBundleDisplayName</key>
  <string>CUA Bar</string>
  <key>CFBundleExecutable</key>
  <string>$executable_name</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>$bundle_identifier</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>CUA Bar</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$version</string>
  <key>CFBundleVersion</key>
  <string>$version</string>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.utilities</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSAppleEventsUsageDescription</key>
  <string>Codex를 다시 켤 때 Codex에 정상 종료를 요청해요.</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST
plutil -lint "$bundle_path/Contents/Info.plist" >/dev/null

printf 'APPL????' > "$bundle_path/Contents/PkgInfo"

# Every build runs under the hardened runtime, so what is tried here is what notarization ships. Its
# one exception: restart-codex asks Codex to quit through osascript, an Apple event this app answers for.
sign_options=(--force --deep --options runtime --entitlements "$script_dir/CUABar.entitlements")
if [[ "$signing_identity" != "-" ]]; then
  sign_options+=(--timestamp)
fi
echo "Signing with: $([[ "$signing_identity" == "-" ]] && echo "ad hoc" || echo "$signing_identity")"
codesign "${sign_options[@]}" -s "$signing_identity" "$bundle_path" >/dev/null
codesign --verify --deep --strict "$bundle_path"

if [[ "$should_install" -eq 1 ]]; then
  umask 077
  mkdir -p "$install_dir"
  backup_dir="$HOME/Library/Application Support/CUABar/Backups/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$backup_dir"
  if [[ -d "$install_path" ]]; then
    ditto "$install_path" "$backup_dir/$bundle_name"
  fi
  defaults export "$bundle_identifier" "$backup_dir/settings.plist" >/dev/null 2>&1 || true

  staging_dir=$(mktemp -d "$install_dir/.CUABar-install.XXXXXX")
  ditto "$bundle_path" "$staging_dir/new.app"
  if ! codesign --verify --deep --strict "$staging_dir/new.app"; then
    rm -rf "$staging_dir"
    echo "The copy failed signature verification; nothing was replaced. Backup: $backup_dir" >&2
    exit 1
  fi
  if [[ -d "$install_path" ]]; then
    # Checked again right before the swap: it may have been opened while this script was building.
    if app_is_running; then
      rm -rf "$staging_dir"
      echo "CUA Bar is running; installation stopped. Backup: $backup_dir" >&2
      exit 1
    fi
    mv "$install_path" "$staging_dir/previous.app"
  fi
  if ! mv "$staging_dir/new.app" "$install_path"; then
    if [[ -d "$staging_dir/previous.app" ]]; then mv "$staging_dir/previous.app" "$install_path"; fi
    echo "Installation failed; previous app restored. Backup: $backup_dir" >&2
    exit 1
  fi
  rm -rf "$staging_dir"
  echo "Backup: $backup_dir"
  echo "Installed to $install_path (version $version)"
  echo "You can launch it with:"
  echo "open \"$install_path\""
else
  echo "Built $bundle_path (version $version)"
  echo "You can launch it with:"
  echo "open \"$bundle_path\""
fi
