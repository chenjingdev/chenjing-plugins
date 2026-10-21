#!/bin/zsh
# Builds the download site (download/, served at cua.chenjing.org by a Cloudflare Worker) from the packaged
# release: copies the dmg and SHA256SUMS.txt that scripts/package-release.sh wrote, and install.sh, into
# download/public/, and writes download/release.json for the worker. Both are generated and not tracked.
#
#   ./scripts/build-download-site.sh [dist-dir]      default: apps/cua-bar/dist/
#
# It never deploys: publishing is yours to run, after asking (R22).

set -euo pipefail

script_dir=$(cd "$(dirname "$0")" && pwd)
package_dir=$(cd "$script_dir/.." && pwd)
site_dir="$package_dir/download"
plugin_manifest="$package_dir/engine/.claude-plugin/plugin.json"
repository="chenjingdev/chenjing-plugins"

if [[ $# -gt 1 ]]; then
  echo "Usage: ./scripts/build-download-site.sh [dist-dir]" >&2
  exit 1
fi
dist_dir="${1:-$package_dir/dist}"

version=$(plutil -extract version raw -o - "$plugin_manifest")
dmg_name="CUABar-v$version-macos-arm64.dmg"
sums_name="SHA256SUMS.txt"
if [[ ! -f "$dist_dir/$dmg_name" || ! -f "$dist_dir/$sums_name" ]]; then
  echo "$dist_dir has no $dmg_name and $sums_name: run scripts/package-release.sh first." >&2
  exit 1
fi
(cd "$dist_dir" && shasum -a 256 -c "$sums_name" >/dev/null)
sha=$(awk -v f="$dmg_name" '$2 == f { print $1 }' "$dist_dir/$sums_name")
size=$(stat -f %z "$dist_dir/$dmg_name")

rm -rf "$site_dir/public"
mkdir -p "$site_dir/public"
cp "$dist_dir/$dmg_name" "$dist_dir/$sums_name" "$site_dir/install.sh" "$site_dir/public/"
cat > "$site_dir/release.json" <<JSON
{
  "version": "$version",
  "file": "$dmg_name",
  "sha256": "$sha",
  "size": $size,
  "release": "https://github.com/$repository/releases/tag/cua-bar--v$version"
}
JSON

echo "Built the download site for CUA Bar $version in $site_dir"
echo "Nothing was deployed. To publish (ask first: R22):"
echo "  (cd ${(qq)site_dir} && wrangler deploy)"
