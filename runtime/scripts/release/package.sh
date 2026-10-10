#!/usr/bin/env bash
# Package release binaries into per-target archives.
#
#   scripts/release/package.sh IN_DIR OUT_DIR VERSION
#
# IN_DIR holds one directory per build, as the daemon-release workflow downloads
# them: bin-<target>/mdbase[.exe], and bin-universal-apple-darwin/{mdbase,macos-mode}.
# Writes OUT_DIR/mdbase-next-<VERSION>-<target>.{tar.gz,zip}. A macOS build that
# was not signed and notarized gets UNSIGNED in its name, as in mdbase-connect.
#
# Each archive holds <stem>/mdbase[.exe] and <stem>/VERSION, nothing else.
# Archives are reproducible for given inputs: sorted entries, fixed owner and
# mtime (SOURCE_DATE_EPOCH, default the commit time), no extended attributes.
set -euo pipefail
umask 022

(($# == 3)) || { echo "usage: $0 IN_DIR OUT_DIR VERSION" >&2; exit 2; }
in=$1 out=$2 version=$3
python3 "$(dirname "$0")/validate_version.py" "$version"
mkdir -p "$out"
out=$(cd "$out" && pwd)
epoch=${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct 2>/dev/null || echo 0)}

stage() { # stage <dir> <file>...: a clean directory holding the files plus VERSION
  # The archive holds exactly <stem>/mdbase[.exe] and <stem>/VERSION: that is the
  # contract mdbase-cloud-ops' bin/verify-desktop-release checks.
  local dir=$1; shift
  rm -rf "$dir"; mkdir -p "$dir"
  cp -- "$@" "$dir/"
  printf '%s\n' "$version" > "$dir/VERSION"
  touch -d "@$epoch" "$dir" "$dir"/*
}

tarball() { # tarball <name> <dir>
  tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$epoch" \
    --format=gnu -C "$(dirname "$2")" -cf - "$(basename "$2")" | gzip -n -9 > "$out/$1.tar.gz"
}

count=0
work=$(mktemp -d "${RUNNER_TEMP:-$PWD}/package.XXXXXX")
trap 'rm -rf "$work"' EXIT

for d in "$in"/bin-*; do
  [[ -d $d ]] || continue
  target=${d##*/bin-}
  case $target in
    *-apple-darwin)
      # Per-arch macOS builds ship only inside the universal binary.
      [[ $target == universal-apple-darwin ]] || continue
      mode=$(cat "$d/macos-mode")
      suffix=; [[ $mode == signed ]] || suffix=-UNSIGNED
      name="mdbase-next-$version-$target$suffix"
      stage "$work/$name" "$d/mdbase"; chmod 755 "$work/$name/mdbase"
      tarball "$name" "$work/$name"
      ;;
    *-windows-*)
      # Not Authenticode-signed (mdbase-connect's direct downloads are not either).
      name="mdbase-next-$version-$target-UNSIGNED"
      stage "$work/$name" "$d/mdbase.exe"
      (cd "$work" && find "$name" -print0 | LC_ALL=C sort -z | TZ=UTC xargs -0 zip -X -q -D "$out/$name.zip")
      ;;
    *)
      name="mdbase-next-$version-$target"
      stage "$work/$name" "$d/mdbase"; chmod 755 "$work/$name/mdbase"
      tarball "$name" "$work/$name"
      ;;
  esac
  count=$((count + 1))
done

((count)) || { echo "no binaries under $in" >&2; exit 1; }
ls -l "$out"
