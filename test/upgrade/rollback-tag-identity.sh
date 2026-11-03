
# Appended only by rollback-read-compat from its workflow ref. The candidate's
# older harness invokes this function without supporting an identity opt-out.
upgrade_verify_previous_release() {
  local repo_root=$1 release=${MDBASE_CONNECT_PREVIOUS_RELEASE:-}
  local commit=${MDBASE_CONNECT_PREVIOUS_RELEASE_COMMIT:-} refs hash name
  local tag_count=0 peeled_count=0 peeled=
  [[ $release =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]] || return 2
  [[ $commit =~ ^[0-9a-f]{40}$ ]] || return 2
  if ! refs=$(timeout 30s git -C "$repo_root" ls-remote --exit-code --tags origin \
    "refs/tags/$release" "refs/tags/$release^{}"); then
    printf 'Could not resolve origin tag %s.\n' "$release" >&2
    return 1
  fi
  while IFS=$'\t' read -r hash name; do
    [[ $hash =~ ^[0-9a-f]{40}$ ]] || return 1
    case "$name" in
      "refs/tags/$release") ((tag_count += 1)) ;;
      "refs/tags/$release^{}") ((peeled_count += 1)); peeled=$hash ;;
      *) return 1 ;;
    esac
  done <<<"$refs"
  if ((tag_count != 1 || peeled_count != 1)) || [[ $peeled != "$commit" ]]; then
    printf 'Origin tag %s is not annotated and peeled exactly once to %s.\n' "$release" "$commit" >&2
    return 1
  fi
  printf 'Verified origin annotated tag %s peels to %s; GitHub Release metadata not checked.\n' "$release" "$commit"
}
