#!/usr/bin/env bash
# Check that a shipped package, built on its own (`cargo build -p <package>`),
# enables no test-only feature of any workspace crate.
#
#   scripts/check-release-features.sh [--target TRIPLE] [--features LIST]
#       [--no-default-features | --all-features] PACKAGE...
# Pass the same feature flags to the subsequent per-package build.
#
# Cargo unifies features within one build, so a workspace-wide build lets a
# test crate (e.g. mdbn-sim) switch on mdbn-replica's `testing` feature
# (PlainSealer, the gated snapshot install) inside shipped crates. Release
# workflows therefore build each shipped package with `-p`, and run this check
# on exactly the package graph they build: normal and build dependencies, no
# dev-dependencies, for the release target. It resolves metadata only; it does
# not compile anything.
set -euo pipefail

# Features that must never reach a shipped artifact, in any workspace crate.
denied='^(lab|testing|testkit|test[-_].*|debug[-_]hooks|insecure.*)$'

target=
feature_args=()
packages=()
while (($#)); do
  case $1 in
    --target) (($# >= 2)) && [[ -n $2 ]] || { echo "--target needs a triple" >&2; exit 2; }; target=$2; shift 2 ;;
    --features) (($# >= 2)) && [[ -n $2 ]] || { echo "--features needs a list" >&2; exit 2; }; feature_args+=(--features "$2"); shift 2 ;;
    --no-default-features|--all-features) feature_args+=("$1"); shift ;;
    -*) echo "unsupported release graph option: $1" >&2; exit 2 ;;
    *) packages+=("$1"); shift ;;
  esac
done
((${#packages[@]})) || { echo "usage: $0 [--target TRIPLE] PACKAGE..." >&2; exit 2; }

members=$(cargo metadata --format-version 1 --no-deps --locked | jq -r '.packages[].name')
target_args=()
[[ -n $target ]] && target_args=(--target "$target")

status=0
for package in "${packages[@]}"; do
  grep -qx -- "$package" <<<"$members" || { printf '%s is not a workspace member.\n' "$package" >&2; status=1; continue; }
  # One package per invocation: features are resolved exactly as `cargo build -p <package>`.
  # Read resolved features on EVERY node, including the root. Feature-edge
  # output alone omits a root feature explicitly enabled by the build caller.
  enabled=$(cargo tree -p "$package" "${target_args[@]}" "${feature_args[@]}" --locked \
      -e normal,build --prefix none --no-dedupe --format '{p}|{f}' |
    awk -F'|' '{ split($1, p, " "); n = split($2, f, ",");
      for (i = 1; i <= n; i++) if (f[i] != "") print p[1], f[i] }' | sort -u)
  bad=$(while read -r crate feature; do
      [[ -n $crate ]] || continue
      grep -qx -- "$crate" <<<"$members" || continue
      if [[ $feature =~ $denied ]]; then printf '%s/%s\n' "$crate" "$feature"; fi
    done <<<"$enabled")
  if [[ -n $bad ]]; then
    printf '%s%s enables test-only features: %s\n' "$package" "${target:+ ($target)}" "$(tr '\n' ' ' <<<"$bad")" >&2
    status=1
  else
    printf '%s%s: no LAB/test-only features\n' "$package" "${target:+ ($target)}"
  fi
done
exit "$status"
