#!/usr/bin/env bash

# shellcheck shell=bash

upgrade_phase() {
  printf '\n== %s\n' "$1"
}

upgrade_require() {
  local name
  for name in "$@"; do
    if [[ -z ${!name:-} ]]; then
      printf 'Required upgrade-test environment variable is missing: %s\n' "$name" >&2
      return 2
    fi
  done
}

upgrade_wait_http() {
  local url=$1
  local description=$2
  local attempts=${3:-30}
  local delay_seconds=${4:-2}
  local attempt
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if curl --fail --silent "$url" >/dev/null; then
      return 0
    fi
    sleep "$delay_seconds"
  done
  printf '%s did not become ready at %s.\n' "$description" "$url" >&2
  return 1
}

upgrade_remove_container() {
  docker rm --force "$1" >/dev/null 2>&1 || true
}
