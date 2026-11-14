#!/bin/sh
# Installs mdbase connect for the current user, without root:
#
#   curl -fsSL https://raw.githubusercontent.com/mdbase-dev/mdbase-connect/main/apps/desktop/scripts/install-linux.sh | sh
#
# The app goes to ~/.local/opt/mdbase-connect, a folder the user owns, so it
# replaces itself from later releases (docs/desktop-updates.md). After the first
# install, running the script again installs the newest release the same way.
#
# 1. The release's .deb is downloaded and checked against the release's
#    SHA256SUMS, and against its Sigstore bundle when `cosign` is installed.
# 2. The app is unpacked from it beside the old one and swapped in; the old app
#    is kept as mdbase-connect.previous.
# 3. A launcher entry and icon are installed, and `mdbase-connect` and `mdbase`
#    commands are linked in ~/.local/bin unless those names are taken.
# 4. `mdbase-connect --mdbase-update` runs once: it installs and starts the mdbase
#    daemon the app bundles and registers the background update timer.
#
# Options:
#   --version VERSION  install this release (default: the newest one)
#   --deb FILE         install this package instead of downloading one
#   --prefix DIR       install under DIR instead of ~/.local
#   --no-update        skip step 4
set -eu

REPOSITORY=mdbase-dev/mdbase-connect
IDENTITY_PREFIX="https://github.com/$REPOSITORY/.github/workflows/desktop-release.yml@refs/tags/"
OIDC_ISSUER=https://token.actions.githubusercontent.com

say() { printf '%s\n' "$*" >&2; }
fail() { say "mdbase connect was not installed: $*"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "this needs \`$1\`."; }

version=
deb=
prefix="${HOME:?}/.local"
update=true
while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || fail "--version needs a value."; version="${2#v}"; shift 2 ;;
    --deb) [ $# -ge 2 ] || fail "--deb needs a file."; deb="$2"; shift 2 ;;
    --prefix) [ $# -ge 2 ] || fail "--prefix needs a directory."; prefix="$2"; shift 2 ;;
    --no-update) update=false; shift ;;
    -h|--help) sed -n '2,/^set -eu/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) fail "unknown option $1 (see --help)." ;;
  esac
done

[ "$(uname -s)" = Linux ] || fail "this script is for Linux."
[ "$(id -u)" != 0 ] || fail "run it as the user who uses mdbase connect, not as root."
need tar
need zstd
need mktemp
case "$prefix" in /*) ;; *) prefix="$(pwd)/$prefix" ;; esac
opt="$prefix/opt"
app="$opt/mdbase-connect"
mkdir -p "$opt"
work="$(mktemp -d "$opt/.mdbase-connect-install.XXXXXX")"
trap 'rm -rf "$work"' EXIT INT TERM

if [ -z "$deb" ]; then
  need curl
  need sha256sum
  [ "$(uname -m)" = x86_64 ] || fail "mdbase connect publishes Linux builds for x86_64 only."
  if [ -z "$version" ]; then
    # Newest first; the first release with a Linux package is the newest one.
    version="$(curl -fsSL "https://api.github.com/repos/$REPOSITORY/releases?per_page=30" \
      | sed -n 's|.*"browser_download_url": *"[^"]*/releases/download/v\([^/"]*\)/mdbase-connect-[^/"]*-linux-x64\.deb".*|\1|p' \
      | head -n 1)" || true
    [ -n "$version" ] || fail "no release with a Linux package was found. Try again with --version."
  fi
  name="mdbase-connect-$version-linux-x64.deb"
  base="https://github.com/$REPOSITORY/releases/download/v$version"
  say "Downloading mdbase connect $version..."
  curl -fL --progress-bar --proto '=https' -o "$work/$name" "$base/$name" || fail "$base/$name could not be downloaded."
  curl -fsSL --proto '=https' -o "$work/SHA256SUMS" "$base/SHA256SUMS-linux-x64" \
    || fail "the release's checksums could not be downloaded."
  grep " \*\{0,1\}$name\$" "$work/SHA256SUMS" | sed 's/ \*/  /' > "$work/SHA256SUMS.$name"
  [ -s "$work/SHA256SUMS.$name" ] || fail "the release's checksums do not list $name."
  (cd "$work" && sha256sum -c --quiet "SHA256SUMS.$name") || fail "$name does not match the release's checksum."
  if command -v cosign >/dev/null 2>&1; then
    curl -fsSL --proto '=https' -o "$work/$name.sigstore.json" "$base/$name.sigstore.json" \
      || fail "the release's signature could not be downloaded."
    cosign verify-blob --bundle "$work/$name.sigstore.json" \
      --certificate-identity "${IDENTITY_PREFIX}v$version" \
      --certificate-oidc-issuer "$OIDC_ISSUER" "$work/$name" >/dev/null 2>&1 \
      || fail "$name is not signed by the mdbase connect release workflow."
    say "Verified the release's checksum and signature."
  else
    say "Verified the release's checksum. Install cosign to also check its signature;"
    say "mdbase connect checks the signature of every later update itself."
  fi
  deb="$work/$name"
fi
[ -f "$deb" ] || fail "$deb is not a file."

# A .deb is an ar archive: an 8-byte magic, then members with 60-byte headers
# (name, 16 bytes; size, decimal at offset 48) and data padded to even length.
member() {
  offset=8
  total="$(wc -c < "$1")"
  [ "$(head -c 8 "$1")" = '!<arch>' ] || fail "$1 is not a Debian package."
  while [ "$offset" -lt "$total" ]; do
    header="$(tail -c +"$((offset + 1))" "$1" | head -c 60)"
    member_name="$(printf '%s' "$header" | cut -c1-16 | sed 's/ *$//; s|/$||')"
    size="$(printf '%s' "$header" | cut -c49-58 | tr -d ' ')"
    case "$size" in ''|*[!0-9]*) fail "$1 is not a valid Debian package." ;; esac
    if [ "$member_name" = "$2" ]; then
      tail -c +"$((offset + 61))" "$1" | head -c "$size"
      return 0
    fi
    offset=$((offset + 60 + size + size % 2))
  done
  fail "$1 has no $2."
}

root="$work/root"
mkdir -p "$root"
member "$deb" data.tar.zst | zstd -dc | tar -x -C "$root" || fail "the package could not be unpacked."
new="$root/usr/lib/mdbase-connect"
[ -x "$new/mdbase-connect" ] || fail "the package does not contain the mdbase connect app."

for process in /proc/[0-9]*; do
  [ "$(readlink "$process/exe" 2>/dev/null)" != "$app/mdbase-connect" ] \
    || fail "mdbase connect is running. Quit it first, or use Restart and update in the app."
done

# Two renames on one filesystem; anything the app staged for the replaced app goes.
rm -rf "$app.next" "$app.previous"
if [ -e "$app" ]; then mv "$app" "$app.previous"; fi
if ! mv "$new" "$app"; then
  if [ -e "$app.previous" ]; then mv "$app.previous" "$app"; fi
  fail "the app could not be moved into $app."
fi
say "Installed the app in $app."

applications="$prefix/share/applications"
icons="$prefix/share/icons/hicolor/512x512/apps"
mkdir -p "$applications" "$icons"
if [ -f "$root/usr/share/pixmaps/mdbase-connect.png" ]; then
  cp "$root/usr/share/pixmaps/mdbase-connect.png" "$icons/mdbase-connect.png"
fi
cat > "$applications/mdbase-connect.desktop.tmp" <<EOF
[Desktop Entry]
Type=Application
Name=mdbase connect
GenericName=mdbase connector
Comment=Connect applications to authorized mdbase collections
Exec="$app/mdbase-connect" %U
Icon=mdbase-connect
Terminal=false
Categories=Utility;
MimeType=x-scheme-handler/mdbase-connect;
StartupNotify=true
EOF
mv "$applications/mdbase-connect.desktop.tmp" "$applications/mdbase-connect.desktop"
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$applications" >/dev/null 2>&1 || true
fi

# Links a command unless the name is taken by something else.
link() {
  if [ -L "$2" ] && [ "$(readlink "$2")" = "$1" ]; then return 0; fi
  if [ -e "$2" ] || [ -L "$2" ]; then
    say "$2 already exists, so it was left as it is."
    return 0
  fi
  ln -s "$1" "$2"
}
mkdir -p "$prefix/bin"
link "$app/mdbase-connect" "$prefix/bin/mdbase-connect"

if [ "$update" = true ]; then
  say "Installing the mdbase daemon and background updates..."
  "$app/mdbase-connect" --mdbase-update || fail "\`mdbase-connect --mdbase-update\` failed (output above)."
  state="$("$app/resources/mdbase-next/mdbase" --json paths 2>/dev/null \
    | sed -n 's/.*"state_dir": *"\([^"]*\)".*/\1/p')" || true
  if [ -n "$state" ] && [ -x "$state/runtime/mdbase" ]; then
    link "$state/runtime/mdbase" "$prefix/bin/mdbase"
  fi
fi

case ":${PATH:-}:" in
  *":$prefix/bin:"*) ;;
  *) say "Add $prefix/bin to PATH to run mdbase-connect and mdbase from a terminal." ;;
esac
say "mdbase connect is installed. Open it from your launcher, or run $app/mdbase-connect."
