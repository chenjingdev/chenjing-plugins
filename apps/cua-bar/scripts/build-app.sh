#!/bin/zsh
# Builds CUABar.app next to Package.swift and signs it ad hoc (no notarization, like agent-bar).
# The app's version is the cua plugin's version: they ship together and the app compares them.
#
#   ./scripts/build-app.sh
#
# CUABAR_CODE_SIGN_IDENTITY picks another signing identity; the default is ad hoc ("-").

set -euo pipefail

script_dir=$(cd "$(dirname "$0")" && pwd)
package_dir=$(cd "$script_dir/.." && pwd)
plugin_manifest="$package_dir/../../plugins/cua/.claude-plugin/plugin.json"

bundle_name="CUABar.app"
bundle_path="$package_dir/$bundle_name"
executable_name="cua-bar"
bundle_identifier="dev.chenjing.cua-bar"
build_configuration="release"
signing_identity="${CUABAR_CODE_SIGN_IDENTITY:--}"

if [[ $# -gt 0 ]]; then
  echo "Unknown option: $1" >&2
  echo "Usage: ./scripts/build-app.sh" >&2
  exit 1
fi

if [[ ! -f "$plugin_manifest" ]]; then
  echo "Plugin manifest not found: $plugin_manifest" >&2
  exit 1
fi
version=$(plutil -extract version raw -o - "$plugin_manifest")
if [[ ! "$version" =~ '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$' ]]; then
  echo "Plugin version is not a plain version number: '$version'" >&2
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
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST
plutil -lint "$bundle_path/Contents/Info.plist" >/dev/null

printf 'APPL????' > "$bundle_path/Contents/PkgInfo"

echo "Signing with: $([[ "$signing_identity" == "-" ]] && echo "ad hoc" || echo "$signing_identity")"
codesign --force --deep -s "$signing_identity" "$bundle_path" >/dev/null
codesign --verify --deep --strict "$bundle_path"

echo "Built $bundle_path (version $version)"
