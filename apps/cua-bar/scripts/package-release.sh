#!/bin/zsh
# Packages CUA Bar for release: builds CUABar.app (scripts/build-app.sh) with a Developer ID
# identity, has Apple notarize it, puts it in a disk image that is signed and notarized as well,
# writes the checksum file, checks all of it, and prints the tag and the command that would publish it as a
# GitHub Release. The app and install.sh do not look at GitHub: they take the dmg from the download site,
# which scripts/build-download-site.sh builds from the files this writes.
#
#   CUABAR_NOTARY_PROFILE=<profile> ./scripts/package-release.sh [output-dir]
#                                    default output-dir: apps/cua-bar/dist/ (not tracked by git)
#
# CUABAR_NOTARY_PROFILE names a `xcrun notarytool store-credentials` profile. CUABAR_CODE_SIGN_IDENTITY
# names the Developer ID Application identity; without it the only one in the keychain is used.
# Writes CUABar-v<version>-macos-arm64.dmg and SHA256SUMS.txt into the output directory.
# It never creates a tag, pushes, or calls gh: publishing is yours to run, after asking (R22).

set -euo pipefail

script_dir=$(cd "$(dirname "$0")" && pwd)
package_dir=$(cd "$script_dir/.." && pwd)
bundle_name="CUABar.app"
bundle_path="$package_dir/$bundle_name"
executable_name="cua-bar"
repository="chenjingdev/chenjing-plugins"

if [[ $# -gt 1 ]]; then
  echo "Usage: CUABAR_NOTARY_PROFILE=<profile> ./scripts/package-release.sh [output-dir]" >&2
  exit 1
fi
output_dir="${1:-$package_dir/dist}"
mkdir -p "$output_dir"
output_dir=$(cd "$output_dir" && pwd)

# Both are looked at before anything is built: without them what is built could not be shipped.
notary_profile="${CUABAR_NOTARY_PROFILE:-}"
if [[ -z "$notary_profile" ]]; then
  echo "CUABAR_NOTARY_PROFILE is not set: name a profile made by 'xcrun notarytool store-credentials'. Nothing was built." >&2
  exit 1
fi
identity="${CUABAR_CODE_SIGN_IDENTITY:-}"
identity_name="$identity"
if [[ -z "$identity" ]]; then
  # By its SHA-1, so a renewed certificate under the same name cannot make the choice ambiguous.
  candidates=$(security find-identity -v -p codesigning \
    | sed -n -E 's/^ *[0-9]+\) ([0-9A-F]{40}) "(Developer ID Application: .*)"$/\1 \2/p' | sort -u)
  count=$(print -r -- "$candidates" | grep -c . || true)
  if [[ "$count" -ne 1 ]]; then
    echo "Found $count Developer ID Application identities in the keychain; set CUABAR_CODE_SIGN_IDENTITY to the one to use. Nothing was built." >&2
    exit 1
  fi
  identity=${candidates%% *}
  identity_name=${candidates#* }
fi
if [[ "$identity" == "-" ]]; then
  echo "A release is signed with a Developer ID identity, not ad hoc. Nothing was built." >&2
  exit 1
fi

CUABAR_CODE_SIGN_IDENTITY="$identity" "$script_dir/build-app.sh"

version=$(plutil -extract CFBundleShortVersionString raw -o - "$bundle_path/Contents/Info.plist")
# The app's own update only takes a file spelled CUABar-v<x>.<y>.<z>-macos-arm64.dmg (what the site's /version names).
if [[ ! "$version" =~ '^[0-9]+\.[0-9]+\.[0-9]+$' ]]; then
  echo "Version '$version' is not x.y.z; the app's update would not accept its file name. Nothing was packaged." >&2
  exit 1
fi
# The asset name says arm64; do not ship anything else under it.
architectures=$(lipo -archs "$bundle_path/Contents/MacOS/$executable_name")
if [[ "$architectures" != "arm64" ]]; then
  echo "The app is built for '$architectures', not arm64; nothing was packaged." >&2
  exit 1
fi

tag="cua-bar--v$version"
dmg_name="CUABar-v$version-macos-arm64.dmg"
sums_name="SHA256SUMS.txt"
dmg_path="$output_dir/$dmg_name"
sums_path="$output_dir/$sums_name"
rm -f "$dmg_path" "$sums_path"

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/cua-bar-package.XXXXXX")
mount_dir=""
cleanup() {
  if [[ -n "$mount_dir" ]]; then
    hdiutil detach -quiet "$mount_dir" 2>/dev/null || true
  fi
  rm -rf "$work_dir"
}
trap cleanup EXIT

# Sends the app (zipped for the upload) or the dmg to Apple, waits for the answer and staples the
# ticket on, so Gatekeeper can accept it without asking Apple. A refusal prints Apple's log.
notarize() {
  local target=$1 upload=$1 result="" exit_code=0 submission=""
  if [[ "$target" == *.app ]]; then
    # No resource forks or extended attributes: they would become ._ files in the zip.
    upload="$work_dir/${target:t:r}.zip"
    ditto -c -k --keepParent --norsrc --noextattr "$target" "$upload"
  fi
  echo "Notarizing ${target:t}: waiting for Apple, usually a few minutes..."
  result=$(xcrun notarytool submit "$upload" --keychain-profile "$notary_profile" --wait 2>&1) || exit_code=$?
  submission=$(print -r -- "$result" | sed -n -E 's/^ *id: //p' | head -n 1)
  if [[ "$exit_code" -ne 0 ]] || ! print -r -- "$result" | grep -q 'status: Accepted'; then
    print -r -- "$result" >&2
    echo "Notarization of ${target:t} failed (exit $exit_code, submission ${submission:-none}). Nothing was packaged." >&2
    if [[ -n "$submission" ]]; then
      xcrun notarytool log "$submission" --keychain-profile "$notary_profile" >&2 || true
    fi
    exit 1
  fi
  echo "  accepted (submission $submission)"
  xcrun stapler staple -q "$target"
  xcrun stapler validate -q "$target"
}

notarize "$bundle_path"

echo "Making $dmg_name"
# The stapled app next to a shortcut to Applications to drag it onto.
mkdir "$work_dir/image"
ditto --norsrc --noextattr "$bundle_path" "$work_dir/image/$bundle_name"
ln -s /Applications "$work_dir/image/Applications"
hdiutil create -volname "CUA Bar" -srcfolder "$work_dir/image" -format UDZO -ov "$dmg_path" >/dev/null
codesign --force --sign "$identity" --timestamp "$dmg_path"
notarize "$dmg_path"
(cd "$output_dir" && shasum -a 256 "$dmg_name" > "$sums_name")

# Look at what was written the way a person who downloads it would: the checksum, then Gatekeeper's
# verdict on the dmg and on the app inside it, each with its own stapled ticket.
gatekeeper_accepts() {
  local target=${@[-1]} verdict=""
  if verdict=$(spctl --assess -vv "$@" 2>&1) && [[ "$verdict" == *"source=Notarized Developer ID"* ]]; then
    return 0
  fi
  print -r -- "$verdict" >&2
  echo "Gatekeeper does not accept ${target:t} as notarized Developer ID software." >&2
  return 1
}
(cd "$output_dir" && shasum -a 256 -c "$sums_name" >/dev/null)
gatekeeper_accepts --type open --context context:primary-signature "$dmg_path"
mount_dir="$work_dir/mount"
mkdir "$mount_dir"
hdiutil attach -quiet -nobrowse -readonly -noautoopen -mountpoint "$mount_dir" "$dmg_path"
codesign --verify --deep --strict "$mount_dir/$bundle_name"
xcrun stapler validate -q "$mount_dir/$bundle_name"
gatekeeper_accepts --type execute "$mount_dir/$bundle_name"
hdiutil detach -quiet "$mount_dir"
mount_dir=""

echo
echo "Packaged CUA Bar $version"
echo "  ${dmg_path}"
echo "  ${sums_path}"
echo "  signed by $identity_name; the app and the dmg are notarized and stapled, and Gatekeeper accepts both"

# The full id of the commit this was built from: the tag must point at it, not at whatever the
# default branch has when the release is made.
commit=""
uncommitted=""
if commit=$(git -C "$package_dir" rev-parse --verify HEAD 2>/dev/null); then
  # The version comes from the engine manifest (engine/.claude-plugin/plugin.json), so an uncommitted bump there counts too.
  if [[ -n "$(git -C "$package_dir" status --porcelain -- . 2>/dev/null)" ]]; then
    uncommitted=" (with uncommitted changes)"
  fi
  echo "  built from commit $commit$uncommitted"
else
  commit=""
fi

echo
echo "Release tag: $tag"
echo
if [[ -z "$commit" ]]; then
  echo "This was not built from a git checkout, so there is no commit for the tag to point at."
  echo "Package it from the repository before publishing."
  exit 0
fi
if [[ -n "$uncommitted" ]]; then
  echo "Warning: the build has uncommitted changes, so commit ${commit[1,12]} is not what was packaged."
  echo "Commit them and package again before publishing."
  echo
fi
echo "Nothing was tagged, pushed or uploaded. To publish (ask first: R22), push the commit this was"
echo "built from, then run:"
echo
release_title="CUA Bar $version"
release_notes="CUA Bar $version - signed with Developer ID and notarized by Apple. Apple Silicon, macOS 14 or later."
echo "  gh release create ${(qq)tag} \\"
echo "    ${(qq)dmg_path} ${(qq)sums_path} \\"
echo "    --repo $repository \\"
echo "    --target $commit \\"
echo "    --title ${(qq)release_title} \\"
echo "    --notes ${(qq)release_notes}"
