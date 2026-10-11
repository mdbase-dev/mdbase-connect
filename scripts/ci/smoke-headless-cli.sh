#!/usr/bin/env bash
# Package the mdbase daemon release build (MDBN_DAEMON_BIN, built from runtime/)
# as the standalone headless archive, then exercise the extracted entry point in
# a throwaway isolated profile.
set -euo pipefail

platform=${1:?usage: smoke-headless-cli.sh PLATFORM ARCH}
arch=${2:?usage: smoke-headless-cli.sh PLATFORM ARCH}

binary=${MDBN_DAEMON_BIN:?set MDBN_DAEMON_BIN to the daemon release build}
executable_name=mdbase
filename_mode=standard
if [[ $platform == windows ]]; then
  executable_name=mdbase.exe
  filename_mode=unsigned-preview
elif [[ $platform == macos ]]; then
  filename_mode=unsigned-preview
fi
version="$(node -p "require('./package.json').version")"
node scripts/package-headless-cli.mjs \
  --platform "$platform" \
  --arch "$arch" \
  --version "$version" \
  --binary "$binary" \
  --output-directory headless-artifacts \
  --filename-mode "$filename_mode"
archive="$(find headless-artifacts -type f -name '*.tar.gz' -print -quit)"
test -n "$archive"
mkdir headless-extracted
tar -xzf "$archive" -C headless-extracted
packaged_binary="$(find headless-extracted -type f -name "$executable_name" -print -quit)"
test -n "$packaged_binary"
"$packaged_binary" --help >/dev/null
"$packaged_binary" daemon run --help >/dev/null
"$packaged_binary" --version | grep -qF "${MDBN_DAEMON_VERSION:?}"
"$packaged_binary" --state-dir "$PWD/headless-profile" paths >/dev/null
