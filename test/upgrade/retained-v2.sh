#!/usr/bin/env bash
# Sourced by provider-from-previous; shares its binary startup and HTTP helpers.

retained_v2_inputs() {
  local supplied_image=${MDBASE_CONNECT_PREVIOUS_PROVIDER_IMAGE:-}
  source "$repo_root/.github/previous-release.env"
  [[ $MDBASE_CONNECT_PREVIOUS_RELEASE == v0.1.0-beta.95 &&
     $MDBASE_CONNECT_PREVIOUS_RELEASE_COMMIT == 408c67bc10f128e0833f0da62cb3efb9d94657d7 ]] || {
    printf 'Retained-v2 enablement qualification requires the exact beta95 predecessor.\n' >&2; return 2;
  }
  [[ -z $supplied_image || $supplied_image == "$MDBASE_CONNECT_PREVIOUS_PROVIDER_IMAGE" ]] || {
    printf 'Caller image disagrees with the checked-in beta95 predecessor.\n' >&2; return 2;
  }
  upgrade_require MDBASE_CONNECT_PREVIOUS_PROVIDER_IMAGE
  [[ $MDBASE_CONNECT_PREVIOUS_PROVIDER_IMAGE =~ ^ghcr\.io/mdbase-dev/mdbase-connect-hosted-provider@sha256:[0-9a-f]{64}$ ]] || {
    printf 'Retained-v2 requires an immutable beta.95 provider digest.\n' >&2; return 2;
  }
  [[ $(git -C "$repo_root" rev-parse "$MDBASE_CONNECT_PREVIOUS_RELEASE^{commit}") == "$MDBASE_CONNECT_PREVIOUS_RELEASE_COMMIT" ]]
  upgrade_verify_previous_release "$repo_root"
  git -C "$repo_root" show "$MDBASE_CONNECT_PREVIOUS_RELEASE_COMMIT:config/application-issuance-policy.json" |
    jq -e '.phase == "compatibility-prelude" and .fresh_semantic_versions == [1]' >/dev/null
  jq -e '.phase == "v2-enablement" and .fresh_semantic_versions == [1,2]' \
    "$repo_root/config/application-issuance-policy.json" >/dev/null
  # Retained reader/engine and schema bytes are immutable across this pair.
  local contract
  for contract in deploy/docker/mdbase-rs-revision \
      packages/protocol/schemas/application-capability-catalog.v1.json \
      packages/protocol/schemas/application-capability-catalog.v2.json \
      packages/protocol/schemas/operation-catalog.v1.json; do
    cmp <(git -C "$repo_root" show "$MDBASE_CONNECT_PREVIOUS_RELEASE_COMMIT:$contract") "$repo_root/$contract"
  done
  [[ -z $(git -C "$repo_root" status --porcelain --untracked-files=all -- crates/connect-hosted-provider/migrations) ]]
  git -C "$repo_root" diff --exit-code "$MDBASE_CONNECT_PREVIOUS_RELEASE_COMMIT" HEAD -- crates/connect-hosted-provider/migrations
  # This mode owns its database; never accept a caller's database or R2 target.
  [[ -z ${DATABASE_URL:-} && -z ${MDBASE_CONNECT_R2_ENDPOINT:-} ]] || {
    printf 'Retained-v2 owns disposable PostgreSQL and R2; unset external targets.\n' >&2; return 2;
  }
  PROVIDER_INTERNAL_TOKEN=retained-v2-disposable-internal-token-only
  PROVIDER_MASTER_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
  MDBASE_CONNECT_R2_BUCKET=upgrade-canary
  MDBASE_CONNECT_R2_ACCESS_KEY_ID=upgrade-canary
  MDBASE_CONNECT_R2_SECRET_ACCESS_KEY=upgrade-canary-secret
  MDBASE_CONNECT_ALLOW_INSECURE_R2=true
  DATABASE_URL=disposable-not-started
}

retained_v2_run() (
  set -euo pipefail
  umask 077
  local run_id work candidate previous postgres status=0
  run_id=$(node -e 'console.log(crypto.randomUUID())')
  work=$(mktemp -d "${RUNNER_TEMP:-/tmp}/mdbase-retained-v2.$run_id.XXXXXX")
  candidate=mdbase-v2-candidate-$run_id
  previous=mdbase-v2-previous-$run_id
  postgres=mdbase-v2-postgres-$run_id
  retained_cleanup() {
    local name
    for name in "$candidate" "$previous" "$postgres"; do
      docker logs "$name" >"$work/$name.log" 2>&1 || true
      upgrade_remove_container "$name"
    done
    if [[ -n ${r2_pid:-} ]]; then kill "$r2_pid" 2>/dev/null || true; wait "$r2_pid" 2>/dev/null || true; fi
  }
  trap retained_cleanup EXIT
  set +e
  (
    set -Eeuo pipefail
    trap 'printf "Retained-v2 fixture failed at %s:%s\n" "${BASH_SOURCE[0]}" "$LINENO" >&2' ERR
    # Every child log stays private, including Docker errors and HTTP bodies.
    docker info >/dev/null
    docker image inspect "$MDBASE_CONNECT_PREVIOUS_PROVIDER_IMAGE" >/dev/null
    upgrade_verify_previous_image "$MDBASE_CONNECT_PREVIOUS_PROVIDER_IMAGE"
    # Cached images only here; bounded public release metadata was checked before
    # any disposable resource creation. No registry credentials or tag pulls.
    if [[ ${SKIP_CANDIDATE_BUILD:-false} != true ]]; then
      CANDIDATE_IMAGE=mdbase-connect-hosted-provider:v2-$run_id
      docker build --file "$repo_root/deploy/docker/Dockerfile.hosted-provider" \
        --tag "$CANDIDATE_IMAGE" "$repo_root"
    fi
    # Ports are reserved by Docker for the DB and dynamically selected for host
    # networking. A collision fails startup; it never triggers resource cleanup
    # outside the three UUID names above.
    docker run --detach --name "$postgres" -p 127.0.0.1::5432 \
      --env POSTGRES_DB=mdbase_provider_upgrade --env POSTGRES_USER=mdbase \
      --env POSTGRES_PASSWORD=previous-provider-upgrade postgres:18-alpine >/dev/null
    UPGRADE_DATABASE_PORT=$(docker port "$postgres" 5432/tcp | cut -d : -f 2)
    DATABASE_URL="postgres://mdbase:previous-provider-upgrade@127.0.0.1:$UPGRADE_DATABASE_PORT/mdbase_provider_upgrade"
    export DATABASE_URL
    # The initdb temporary server accepts Unix sockets before its shutdown.
    # Require the final TCP listener, without lengthening the readiness budget.
    for _ in {1..30}; do
      if docker exec "$postgres" pg_isready -h 127.0.0.1 -U mdbase -d mdbase_provider_upgrade >/dev/null; then break; fi
      sleep 1
    done
    docker exec "$postgres" pg_isready -h 127.0.0.1 -U mdbase -d mdbase_provider_upgrade >/dev/null
    UPGRADE_PROVIDER_PORT=$(node "$repo_root/test/upgrade/retained-v2-probe.mjs" port)
    UPGRADE_PROVIDER_URL=http://127.0.0.1:$UPGRADE_PROVIDER_PORT
    R2_STUB_PORT=$(node "$repo_root/test/upgrade/retained-v2-probe.mjs" port)
    export R2_STUB_PORT
    MDBASE_CONNECT_R2_ENDPOINT=http://127.0.0.1:$R2_STUB_PORT
    export MDBASE_CONNECT_R2_ENDPOINT
    node "$repo_root/test/upgrade/r2-readiness-stub.mjs" >"$work/r2.log" 2>&1 &
    r2_pid=$!
    # This inner trap owns the child PID even when any phase fails.
    trap 'kill "$r2_pid" 2>/dev/null || true; wait "$r2_pid" 2>/dev/null || true' EXIT
    upgrade_wait_http "$MDBASE_CONNECT_R2_ENDPOINT" 'disposable S3 readiness stub' 30 1
    export UPGRADE_PROVIDER_URL PROVIDER_INTERNAL_TOKEN
    probe() { node "$repo_root/test/upgrade/retained-v2-probe.mjs" "$1" "$work/state.json"; }
    inventory() {
      local snapshot canonical_authority
      canonical_authority=$(query_canonical_authority_inventory)
      [[ $canonical_authority =~ ^[0-9a-f]{64}$ ]]
      snapshot=$(rollback_sql "SELECT jsonb_build_object(
        'canonical_authority','$canonical_authority',
        'replicas',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM hosted_provider_replicas r),
        'journal',(SELECT jsonb_agg(to_jsonb(j) ORDER BY replica_id,request_id) FROM hosted_provider_mutation_journal j),
        'collections',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM hosted_provider_collections c),
        'resources',(SELECT jsonb_agg(to_jsonb(r) ORDER BY collection_id,path) FROM hosted_provider_resources r),
        'records',(SELECT jsonb_agg(to_jsonb(r) ORDER BY collection_id,record_id) FROM hosted_provider_records r),
        'ledger',(SELECT jsonb_agg(to_jsonb(m) ORDER BY version) FROM _sqlx_migrations m))")
      # Retain private owned-fixture snapshots to diagnose a failed equality;
      # never weaken the comparison merely because a restart changed something.
      printf '%s\n' "$snapshot" >"$work/inventory-$(date +%s%N).private.json"
      # The shared canonical inventory covers collection authority plus record,
      # resource, file/version/change and outbox bytes. Full collection snapshots
      # above additionally retain operational projection-publication diagnostics;
      # their first materialization and updated_at are not authority rewriting.
      printf '%s\n' "$snapshot" | jq -c '.collections |= map(.id)' | sha256sum | cut -d ' ' -f 1
    }
    start_previous_provider "$previous" false
    probe predecessor
    UPGRADE_COLLECTION_ID=$(jq -er '.collection' "$work/state.json")
    [[ $UPGRADE_COLLECTION_ID =~ ^[0-9a-f-]{36}$ ]]
    upgrade_remove_container "$previous"
    start_candidate_provider "$candidate"
    upgrade_wait_http "$UPGRADE_PROVIDER_URL/ready" 'candidate provider' 30 2
    probe issue
    probe enforce
    [[ $(rollback_sql "SELECT count(*) FROM hosted_provider_replicas WHERE application_semantic_version=2 AND application_setup_evidence IS NOT NULL AND revoked_at IS NULL") == 1 ]]
    local baseline
    baseline=$(inventory)
    upgrade_remove_container "$candidate"
    start_candidate_provider "$candidate"
    upgrade_wait_http "$UPGRADE_PROVIDER_URL/ready" 'restarted candidate provider' 30 2
    [[ $(inventory) == "$baseline" ]]
    probe replay
    [[ $(inventory) == "$baseline" ]]
    upgrade_remove_container "$candidate"
    upgrade_verify_previous_image "$MDBASE_CONNECT_PREVIOUS_PROVIDER_IMAGE"
    start_previous_provider "$previous" false
    [[ $(inventory) == "$baseline" ]]
    probe retained
    [[ $(inventory) == "$baseline" ]]
    probe retained-write
    probe narrow
    baseline=$(inventory)
    probe narrowed
    [[ $(inventory) == "$baseline" ]]
    upgrade_remove_container "$previous"
    start_candidate_provider "$candidate"
    upgrade_wait_http "$UPGRADE_PROVIDER_URL/ready" 'reupgraded candidate provider' 30 2
    [[ $(inventory) == "$baseline" ]]
    probe narrowed
    [[ $(inventory) == "$baseline" ]]
    probe reupgrade
    probe revoke
    jq -n --arg predecessor_release "$MDBASE_CONNECT_PREVIOUS_RELEASE" \
      --arg predecessor_commit "$MDBASE_CONNECT_PREVIOUS_RELEASE_COMMIT" \
      --arg predecessor_image "$MDBASE_CONNECT_PREVIOUS_PROVIDER_IMAGE" \
      --arg candidate_image_id "$(docker image inspect --format '{{.Id}}' "$CANDIDATE_IMAGE")" \
      --arg checkout_commit "$(git -C "$repo_root" rev-parse HEAD)" \
      '{scenario:"retained-v2-provider",predecessor_release:$predecessor_release,
        predecessor_commit:$predecessor_commit,predecessor_image:$predecessor_image,
        candidate_image_id:$candidate_image_id,checkout_commit:$checkout_commit,
        candidate_fresh_semantics:[1,2],predecessor_fresh_semantics:[1],
        signed_publication_qualified:false,deployment_qualified:false}' >"$work/evidence.json"
  ) >"$work/fixture.log" 2>&1
  status=$?
  set -e
  if ((status != 0)); then
    printf 'Retained-v2 provider scenario FAILED (exit %s); private logs: %s\n' "$status" "$work" >&2
    return "$status"
  fi
  printf 'Retained-v2 provider scenario passed: beta.95 %s; predecessor %s\n' \
    "$MDBASE_CONNECT_PREVIOUS_RELEASE_COMMIT" "$MDBASE_CONNECT_PREVIOUS_PROVIDER_IMAGE"
  printf 'Private evidence: %s; local binary qualification only, not signed publication or deployment.\n' "$work"
)
