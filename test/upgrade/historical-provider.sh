#!/usr/bin/env bash
# Historical schema-41 regressions have a fixed successor as well as a fixed
# predecessor. They are not candidate/deployment rollback qualification.
HISTORICAL_PROVIDER_RELEASE=v0.1.0-beta.99
HISTORICAL_PROVIDER_COMMIT=c8b565f7dfbba6259e413b2c3bf2046325cde290
HISTORICAL_PROVIDER_IMAGE=ghcr.io/mdbase-dev/mdbase-connect-hosted-provider@sha256:a8f017ec8a45dc83c5e5cb25feb44d4a78c6c061668b04c2be41832bf116e36c

historical_provider_candidate() {
  local MDBASE_CONNECT_PREVIOUS_RELEASE=$HISTORICAL_PROVIDER_RELEASE
  local MDBASE_CONNECT_PREVIOUS_RELEASE_COMMIT=$HISTORICAL_PROVIDER_COMMIT
  local metadata
  local -a headers=()
  [[ -z ${GITHUB_TOKEN:-} ]] || headers=(--header "authorization: Bearer $GITHUB_TOKEN")
  metadata=$(curl --fail --silent --show-error --connect-timeout 5 --max-time 20 \
    --retry 2 --retry-all-errors "${headers[@]}" \
    "https://api.github.com/repos/mdbase-dev/mdbase-connect/releases/tags/$HISTORICAL_PROVIDER_RELEASE")
  jq -e --arg tag "$HISTORICAL_PROVIDER_RELEASE" \
    'type == "object" and .tag_name == $tag and .draft == false and
     (.id | type) == "number" and (.published_at | type) == "string" and (.published_at | length) > 0' <<<"$metadata" >/dev/null
  upgrade_verify_annotated_release_tag "$repo_root"
  [[ $(git -C "$repo_root" rev-parse "$HISTORICAL_PROVIDER_RELEASE^{commit}") == "$HISTORICAL_PROVIDER_COMMIT" ]]
  docker pull "$HISTORICAL_PROVIDER_IMAGE" >/dev/null
  upgrade_verify_previous_image "$HISTORICAL_PROVIDER_IMAGE"
  CANDIDATE_IMAGE=$HISTORICAL_PROVIDER_IMAGE
}
