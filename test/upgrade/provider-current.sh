#!/usr/bin/env bash
# Sourced by provider-from-previous; shares its container startup and SQL helpers.
current_provider_run() (
  set -euo pipefail
  umask 077
  local run_id work candidate previous postgres status=0
  run_id=$(node -e 'console.log(crypto.randomUUID())')
  work=$(mktemp -d "${RUNNER_TEMP:-/tmp}/mdbase-provider-upgrade.$run_id.XXXXXX")
  candidate=mdbase-v2-candidate-$run_id
  previous=mdbase-v2-previous-$run_id
  postgres=mdbase-v2-postgres-$run_id
  fixture_cleanup() {
    local name
    for name in "$candidate" "$previous" "$postgres"; do
      docker logs "$name" >"$work/$name.log" 2>&1 || true
      upgrade_remove_container "$name"
    done
    if [[ -n ${r2_pid:-} ]]; then kill "$r2_pid" 2>/dev/null || true; wait "$r2_pid" 2>/dev/null || true; fi
  }
  trap fixture_cleanup EXIT
  set +e
  (
    set -Eeuo pipefail
    trap 'printf "Provider upgrade fixture failed at %s:%s\n" "${BASH_SOURCE[0]}" "$LINENO" >&2' ERR
    # Every child log stays private, including Docker errors and HTTP bodies.
    docker info >/dev/null
    docker image inspect "$MDBASE_CONNECT_PREVIOUS_PROVIDER_IMAGE" >/dev/null
    upgrade_verify_previous_image "$MDBASE_CONNECT_PREVIOUS_PROVIDER_IMAGE"
    # Cached images only here; bounded public release metadata was checked before
    # any disposable resource creation. No registry credentials or tag pulls.
    if [[ ${SKIP_CANDIDATE_BUILD:-false} != true ]]; then
      CANDIDATE_IMAGE=mdbase-connect-hosted-provider:v2-$run_id
      # --load keeps the candidate local when CI selects a docker-container
      # builder for its restored Cargo cache mounts.
      docker buildx build --load --file "$repo_root/deploy/docker/Dockerfile.hosted-provider" \
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
    UPGRADE_PROVIDER_PORT=$(node "$repo_root/test/upgrade/provider-upgrade-probe.mjs" port)
    UPGRADE_PROVIDER_URL=http://127.0.0.1:$UPGRADE_PROVIDER_PORT
    R2_STUB_PORT=$(node "$repo_root/test/upgrade/provider-upgrade-probe.mjs" port)
    export R2_STUB_PORT
    MDBASE_CONNECT_R2_ENDPOINT=http://127.0.0.1:$R2_STUB_PORT
    export MDBASE_CONNECT_R2_ENDPOINT
    node "$repo_root/test/upgrade/r2-readiness-stub.mjs" >"$work/r2.log" 2>&1 &
    r2_pid=$!
    # This inner trap owns the child PID even when any phase fails.
    trap 'kill "$r2_pid" 2>/dev/null || true; wait "$r2_pid" 2>/dev/null || true' EXIT
    upgrade_wait_http "$MDBASE_CONNECT_R2_ENDPOINT" 'disposable S3 readiness stub' 30 1
    export UPGRADE_PROVIDER_URL PROVIDER_INTERNAL_TOKEN
    probe() { node "$repo_root/test/upgrade/provider-upgrade-probe.mjs" "$1" "$work/state.json"; }
    inventory() {
      local snapshot canonical_authority cancellations=absent
      if [[ $(rollback_sql "SELECT to_regclass('hosted_provider_authority_import_cancellations') IS NOT NULL") == t ]]; then
        cancellations=$(rollback_sql "SELECT md5(COALESCE(jsonb_agg(to_jsonb(c) ORDER BY transfer_id)::text, '[]')) FROM hosted_provider_authority_import_cancellations c")
        [[ $cancellations =~ ^[0-9a-f]{32}$ ]]
      fi
      canonical_authority=$(query_canonical_authority_inventory)
      [[ $canonical_authority =~ ^[0-9a-f]{64}$ ]]
      snapshot=$(rollback_sql "SELECT jsonb_build_object(
        'canonical_authority','$canonical_authority',
        'cancellations','$cancellations',
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
      # Migration 47 adds nullable ownership fields. Treat their absence in a
      # predecessor as NULL, retaining any actual ownership values. Full-schema
      # restart/rollback comparisons remain unchanged.
      printf '%s\n' "$snapshot" | jq -c --arg scope "${1:-full}" \
        '(.collections |= map(.id)) | if $scope == "authority" then del(.ledger, .cancellations) | (.replicas |= map({revoked_by_migration:null,migration_revoked_at:null} + .)) else . end' |
        sha256sum | cut -d ' ' -f 1
    }
    start_previous_provider "$previous" false
    current_provider_upgrade
  ) >"$work/fixture.log" 2>&1
  status=$?
  set -e
  if ((status != 0)); then
    printf 'Provider upgrade scenario FAILED (exit %s); private logs: %s\n' "$status" "$work" >&2
    return "$status"
  fi
  printf 'Provider upgrade passed: predecessor %s; image %s\n' \
    "$MDBASE_CONNECT_PREVIOUS_RELEASE_COMMIT" "$MDBASE_CONNECT_PREVIOUS_PROVIDER_IMAGE"
  printf 'Private evidence: %s; local binary qualification only, not signed publication or deployment.\n' "$work"
)

# Runs inside current_provider_run's owned disposable fixture.
current_provider_upgrade() {
  local baseline prefix predecessor_max candidate_max current_image=$CANDIDATE_IMAGE
  local rollback_result
  probe predecessor-v2
  UPGRADE_COLLECTION_ID=$(jq -er '.collection' "$work/state.json")
  [[ $UPGRADE_COLLECTION_ID =~ ^[0-9a-f-]{36}$ ]]
  probe issue
  probe enforce
  predecessor_max=$(rollback_sql 'SELECT max(version) FROM _sqlx_migrations WHERE success')
  [[ $predecessor_max =~ ^[0-9]+$ ]]
  prefix=$(rollback_sql 'SELECT md5(jsonb_agg(to_jsonb(m) ORDER BY version)::text) FROM _sqlx_migrations m')
  baseline=$(inventory authority)
  upgrade_remove_container "$previous"
  start_candidate_provider "$candidate"
  upgrade_wait_http "$UPGRADE_PROVIDER_URL/ready" 'current provider upgrade' 30 2
  candidate_max=$(rollback_sql 'SELECT max(version) FROM _sqlx_migrations WHERE success')
  [[ $candidate_max =~ ^[0-9]+$ && $candidate_max -ge $predecessor_max ]]
  # Upgrading existing replicas must not invent migration revocation ownership.
  [[ $(rollback_sql 'SELECT count(*) FROM hosted_provider_replicas WHERE revoked_by_migration IS NOT NULL OR migration_revoked_at IS NOT NULL') == 0 ]]
  [[ $(inventory authority) == "$baseline" ]]
  [[ $(rollback_sql "SELECT md5(jsonb_agg(to_jsonb(m) ORDER BY version)::text) FROM _sqlx_migrations m WHERE version <= $predecessor_max") == "$prefix" ]]
  probe replay
  probe enforce
  probe cancel-import
  [[ $(rollback_sql 'SELECT count(*) FROM hosted_provider_authority_import_cancellations') == 1 ]]
  baseline=$(inventory)
  upgrade_remove_container "$candidate"
  start_candidate_provider "$candidate"
  upgrade_wait_http "$UPGRADE_PROVIDER_URL/ready" 'current provider restart' 30 2
  [[ $(inventory) == "$baseline" ]]
  probe replay
  probe cancel-import-retry
  [[ $(inventory) == "$baseline" ]]
  upgrade_remove_container "$candidate"

  # Always try the actual published predecessor against the candidate database.
  # A known schema refusal is evidence of *incompatibility*, not rollback success.
  # Other failures (timeouts, R2, corrupted ledgers, crashes) fail this test.
  # A predecessor with the tolerant runner must instead serve beside newer
  # migrations that are all recorded rollback-compatible
  # (docs/hosted-provider-migrations.md).
  local tolerant_newer=false
  if ((candidate_max > predecessor_max)) &&
    git -C "$repo_root" show "$MDBASE_CONNECT_PREVIOUS_RELEASE_COMMIT:crates/connect-hosted-provider/src/provider.rs" |
      grep -xF 'pub const MIGRATION_ROLLBACK_TOLERANCE: &str = "marked-v1";' >/dev/null &&
    [[ $(rollback_sql "SELECT count(*) FROM _sqlx_migrations m WHERE m.version > $predecessor_max AND NOT (m.success AND EXISTS (SELECT 1 FROM hosted_provider_rollback_compatible_migrations r WHERE r.version = m.version AND r.checksum = m.checksum))") == 0 ]]
  then
    tolerant_newer=true
  fi
  CANDIDATE_IMAGE=$MDBASE_CONNECT_PREVIOUS_PROVIDER_IMAGE
  start_candidate_provider "$previous"
  if ((candidate_max > predecessor_max)) && [[ $tolerant_newer != true ]]; then
    [[ $(timeout 45s docker wait "$previous") == 1 ]]
    docker logs "$previous" >"$work/predecessor-refusal.private.log" 2>&1
    grep -Fq "hosted migration ledger is not an exact successful catalog prefix at $((predecessor_max + 1))" \
      "$work/predecessor-refusal.private.log"
    rollback_result=refused-unknown-migration
  else
    upgrade_wait_http "$UPGRADE_PROVIDER_URL/ready" 'same-schema or compatible-schema predecessor' 30 2
    probe replay
    probe enforce
    probe cancel-import-retry
    rollback_result=fixture-compatible
    [[ $tolerant_newer != true ]] || rollback_result=compatible-newer-migration
  fi
  [[ $(inventory) == "$baseline" ]]
  upgrade_remove_container "$previous"
  CANDIDATE_IMAGE=$current_image
  start_candidate_provider "$candidate"
  upgrade_wait_http "$UPGRADE_PROVIDER_URL/ready" 'candidate forward recovery' 30 2
  [[ $(inventory) == "$baseline" ]]
  probe replay
  probe cancel-import-retry
  probe retained-write
  probe narrow
  probe narrowed
  probe reupgrade
  probe revoke
  jq -n --arg predecessor_commit "$MDBASE_CONNECT_PREVIOUS_RELEASE_COMMIT" \
    --arg predecessor_image "$MDBASE_CONNECT_PREVIOUS_PROVIDER_IMAGE" \
    --arg candidate_image_id "$(docker image inspect --format '{{.Id}}' "$CANDIDATE_IMAGE")" \
    --arg checkout_commit "$(git -C "$repo_root" rev-parse HEAD)" \
    --arg rollback_result "$rollback_result" \
    --argjson predecessor_migration "$predecessor_max" --argjson candidate_migration "$candidate_max" \
    '{scenario:"current-provider-upgrade",predecessor_commit:$predecessor_commit,
      predecessor_image:$predecessor_image,candidate_image_id:$candidate_image_id,
      checkout_commit:$checkout_commit,predecessor_migration:$predecessor_migration,
      candidate_migration:$candidate_migration,rollback_result:$rollback_result,
      cancellation_fence_preserved:true,signed_publication_qualified:false,deployment_qualified:false}' >"$work/evidence.json"
  printf 'Current provider upgrade/recovery passed; predecessor outcome: %s (not deployment authorization).\n' "$rollback_result"
}
