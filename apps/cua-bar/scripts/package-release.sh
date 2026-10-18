#!/bin/zsh
# Packages CUA Bar for a GitHub Release: builds CUABar.app (scripts/build-app.sh), zips it, writes
# the checksum file, checks both, and prints the tag and the command that would publish them.
#
#   ./scripts/package-release.sh [output-dir]     default: apps/cua-bar/dist/ (not tracked by git)
#
# Writes CUABar-v<version>-macos-arm64.zip and SHA256SUMS.txt into the output directory.
# It never creates a tag, pushes, or calls gh: publishing is yours to run, after asking (R22).

set -euo pipefail

script_dir=$(cd "$(dirname "$0")" && pwd)
package_dir=$(cd "$script_dir/.." && pwd)
bundle_name="CUABar.app"
bundle_path="$package_dir/$bundle_name"
executable_name="cua-bar"
repository="chenjingdev/chenjing-plugins"

if [[ $# -gt 1 ]]; then
  echo "Usage: ./scripts/package-release.sh [output-dir]" >&2
  exit 1
fi
output_dir="${1:-$package_dir/dist}"
mkdir -p "$output_dir"
output_dir=$(cd "$output_dir" && pwd)

"$script_dir/build-app.sh"

version=$(plutil -extract CFBundleShortVersionString raw -o - "$bundle_path/Contents/Info.plist")
# The app's update check only recognizes tags spelled cua-bar--v<x>.<y>.<z>.
if [[ ! "$version" =~ '^[0-9]+\.[0-9]+\.[0-9]+$' ]]; then
  echo "Version '$version' is not x.y.z; the update check would not recognize its tag. Nothing was packaged." >&2
  exit 1
fi
# The asset name says arm64; do not ship anything else under it.
architectures=$(lipo -archs "$bundle_path/Contents/MacOS/$executable_name")
if [[ "$architectures" != "arm64" ]]; then
  echo "The app is built for '$architectures', not arm64; nothing was packaged." >&2
  exit 1
fi

tag="cua-bar--v$version"
zip_name="CUABar-v$version-macos-arm64.zip"
sums_name="SHA256SUMS.txt"
rm -f "$output_dir/$zip_name" "$output_dir/$sums_name"

echo "Zipping $zip_name"
# No resource forks or extended attributes: they become ._ files in the zip, and those make a
# plain `unzip` leave an app whose signature no longer verifies.
ditto -c -k --keepParent --norsrc --noextattr "$bundle_path" "$output_dir/$zip_name"
(cd "$output_dir" && shasum -a 256 "$zip_name" > "$sums_name")

# Look at what was written the way a person who downloads it would: the checksum, then the app
# unpacked by Finder's tool (ditto) and by plain unzip must both still have a valid signature.
(cd "$output_dir" && shasum -a 256 -c "$sums_name" >/dev/null)
check_dir=$(mktemp -d "${TMPDIR:-/tmp}/cua-bar-package-check.XXXXXX")
trap 'rm -rf "$check_dir"' EXIT
mkdir "$check_dir/ditto" "$check_dir/unzip"
ditto -x -k "$output_dir/$zip_name" "$check_dir/ditto"
/usr/bin/unzip -q "$output_dir/$zip_name" -d "$check_dir/unzip"
codesign --verify --deep --strict "$check_dir/ditto/$bundle_name"
codesign --verify --deep --strict "$check_dir/unzip/$bundle_name"

echo
echo "Packaged CUA Bar $version"
echo "  ${output_dir}/${zip_name}"
echo "  ${output_dir}/${sums_name}"
echo "  checksum and the signature of the unzipped app verified (ditto and unzip)"

built_from=""
if git -C "$package_dir" rev-parse --short HEAD >/dev/null 2>&1; then
  built_from=$(git -C "$package_dir" rev-parse --short HEAD)
  if [[ -n "$(git -C "$package_dir" status --porcelain -- . 2>/dev/null)" ]]; then
    built_from="$built_from (with uncommitted changes)"
  fi
  echo "  built from commit $built_from"
fi

echo
echo "Release tag: $tag"
echo
echo "Nothing was tagged, pushed or uploaded. To publish (ask first: R22), push the commit this was"
echo "built from, then run:"
echo
zip_path="$output_dir/$zip_name"
sums_path="$output_dir/$sums_name"
release_title="CUA Bar $version"
release_notes="CUA Bar $version - ad-hoc signed, not notarized. Apple Silicon, macOS 14 or later."
echo "  gh release create ${(qq)tag} \\"
echo "    ${(qq)zip_path} ${(qq)sums_path} \\"
echo "    --repo $repository \\"
echo "    --title ${(qq)release_title} \\"
echo "    --notes ${(qq)release_notes}"
