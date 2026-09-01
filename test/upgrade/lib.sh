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

upgrade_verify_previous_release() {
  local repo_root=$1
  local release=${MDBASE_CONNECT_PREVIOUS_RELEASE:-}
  local commit=${MDBASE_CONNECT_PREVIOUS_RELEASE_COMMIT:-}
  local releases_json refs ref_hash ref_name peeled_commit=
  local -a curl_headers=()

  if [[ ! $release =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]]; then
    printf 'Malformed MDBASE_CONNECT_PREVIOUS_RELEASE: %s\n' "$release" >&2
    return 2
  fi
  if [[ ! $commit =~ ^[0-9a-f]{40}$ ]]; then
    printf 'Malformed MDBASE_CONNECT_PREVIOUS_RELEASE_COMMIT: %s\n' "$commit" >&2
    return 2
  fi
  if [[ -n ${GITHUB_TOKEN:-} ]]; then
    curl_headers=(--header "authorization: Bearer $GITHUB_TOKEN")
  fi
  if ! releases_json=$(curl --fail-with-body --silent --show-error \
    --connect-timeout 5 --max-time 20 --retry 2 --retry-all-errors \
    --header 'accept: application/vnd.github+json' \
    "${curl_headers[@]}" \
    'https://api.github.com/repos/mdbase-dev/mdbase-connect/releases?per_page=100'); then
    printf 'Could not query bounded GitHub release metadata.\n' >&2
    return 1
  fi
  if ! jq -e --arg expected "$release" '
    type == "array" and
    length <= 100 and
    all(.[]; type == "object" and (.draft | type) == "boolean" and (.tag_name | type) == "string") and
    ([.[] | select(.draft == false)] | length) > 0 and
    ([.[] | select(.draft == false)][0].tag_name == $expected) and
    ([.[] | select(.draft == false and .tag_name == $expected)] | length) == 1
  ' <<<"$releases_json" >/dev/null; then
    printf '%s is not the unique newest non-draft mdbase-connect GitHub release.\n' "$release" >&2
    return 1
  fi

  if ! refs=$(timeout 30s git -C "$repo_root" ls-remote --exit-code --tags origin \
    "refs/tags/$release" "refs/tags/$release^{}"); then
    printf 'Could not resolve annotated release tag %s from origin.\n' "$release" >&2
    return 1
  fi
  local tag_ref_count=0 peeled_ref_count=0
  while IFS=$'\t' read -r ref_hash ref_name; do
    if [[ ! $ref_hash =~ ^[0-9a-f]{40}$ ]]; then
      printf 'Malformed origin ref while resolving %s.\n' "$release" >&2
      return 1
    fi
    case "$ref_name" in
      "refs/tags/$release") ((tag_ref_count += 1)) ;;
      "refs/tags/$release^{}")
        ((peeled_ref_count += 1))
        peeled_commit=$ref_hash
        ;;
      *)
        printf 'Unexpected origin ref while resolving %s: %s\n' "$release" "$ref_name" >&2
        return 1
        ;;
    esac
  done <<<"$refs"
  if ((tag_ref_count != 1 || peeled_ref_count != 1)) || [[ $peeled_commit != "$commit" ]]; then
    printf 'Annotated origin tag %s does not peel exactly once to expected commit %s.\n' \
      "$release" "$commit" >&2
    return 1
  fi
}

upgrade_verify_previous_image() {
  local image=$1
  local commit=${MDBASE_CONNECT_PREVIOUS_RELEASE_COMMIT:-}
  local expected_source=https://github.com/mdbase-dev/mdbase-connect
  local inspection

  if [[ ! $image =~ ^ghcr\.io/mdbase-dev/mdbase-connect(-hosted-provider|-server)@sha256:[0-9a-f]{64}$ ]]; then
    printf 'Malformed previous image digest reference: %s\n' "$image" >&2
    return 2
  fi
  if [[ ! $commit =~ ^[0-9a-f]{40}$ ]]; then
    printf 'Malformed expected previous image revision: %s\n' "$commit" >&2
    return 2
  fi
  if ! inspection=$(docker image inspect "$image"); then
    printf 'Could not inspect pulled previous image: %s\n' "$image" >&2
    return 1
  fi
  if ! jq -e --arg source "$expected_source" --arg revision "$commit" '
    type == "array" and length == 1 and
    .[0].Config.Labels["org.opencontainers.image.source"] == $source and
    .[0].Config.Labels["org.opencontainers.image.revision"] == $revision
  ' <<<"$inspection" >/dev/null; then
    printf 'Previous image %s does not uniquely identify source %s at revision %s.\n' \
      "$image" "$expected_source" "$commit" >&2
    return 1
  fi
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
