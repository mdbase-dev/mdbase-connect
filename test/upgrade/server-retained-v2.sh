#!/usr/bin/env bash
# Sourced only by server-from-previous --retained-v2-pending.
server_retained_v2_inputs() {
  [[ $MDBASE_CONNECT_PREVIOUS_RELEASE == v0.1.0-beta.95 &&
     $MDBASE_CONNECT_PREVIOUS_RELEASE_COMMIT == 408c67bc10f128e0833f0da62cb3efb9d94657d7 ]] || {
    printf 'Server retained-v2 requires exact beta.95 source 408c67bc10f128e0833f0da62cb3efb9d94657d7.\n' >&2; return 2;
  }
  [[ $MDBASE_CONNECT_PREVIOUS_SERVER_IMAGE =~ ^ghcr\.io/mdbase-dev/mdbase-connect-server@sha256:[0-9a-f]{64}$ ]] || return 2
  [[ -z ${DATABASE_URL:-} && -z ${UPGRADE_SERVER_URL:-} ]] || {
    printf 'Server retained-v2 owns its disposable database and loopback target; unset external targets.\n' >&2; return 2;
  }
  git -C "$repo_root" show "$MDBASE_CONNECT_PREVIOUS_RELEASE_COMMIT:config/application-issuance-policy.json" |
    jq -e '.policy_version == 1 and .phase == "compatibility-prelude" and .fresh_semantic_versions == [1]' >/dev/null
  jq -e '.policy_version == 1 and .phase == "v2-enablement" and .fresh_semantic_versions == [1,2]' \
    "$repo_root/config/application-issuance-policy.json" >/dev/null
  upgrade_verify_retained_v2_release "$repo_root"
}

server_retained_v2_run() (
  set -euo pipefail
  umask 077
  server_retained_v2_inputs
  local run_id work postgres server status candidate_id previous_id baseline
  run_id=$(node -e 'console.log(crypto.randomUUID())')
  work=$(mktemp -d "/tmp/mdbase-server-retained-v2.$run_id.XXXXXX")
  postgres=mdbase-server-v2-db-$run_id
  server=mdbase-server-v2-$run_id
  cleanup_server_retained() {
    local name
    for name in "$server" "$postgres"; do
      docker logs "$name" >"$work/$name.log" 2>&1 || true
      upgrade_remove_container "$name"
    done
  }
  trap cleanup_server_retained EXIT
  set +e
  (
    set -Eeuo pipefail
    trap 'printf "Server retained-v2 fixture failed at %s:%s\n" "${BASH_SOURCE[0]}" "$LINENO" >&2' ERR
    docker info >/dev/null
    # Preload immutable predecessor and PostgreSQL outside this credential-free lane.
    upgrade_verify_previous_image "$MDBASE_CONNECT_PREVIOUS_SERVER_IMAGE"
    docker image inspect postgres:17-alpine >/dev/null
    CANDIDATE_IMAGE=${CANDIDATE_IMAGE:-mdbase-connect-server:v2-$run_id}
    if [[ ${SKIP_CANDIDATE_BUILD:-false} != true ]]; then
      docker build --file "$repo_root/deploy/docker/Dockerfile.server" --tag "$CANDIDATE_IMAGE" "$repo_root"
    fi
    candidate_id=$(docker image inspect --format '{{.Id}}' "$CANDIDATE_IMAGE")
    previous_id=$(docker image inspect --format '{{.Id}}' "$MDBASE_CONNECT_PREVIOUS_SERVER_IMAGE")
    # Check the binaries' generated policy, not merely the checkout's JSON.
    for pair in "$candidate_id:1,2" "$previous_id:1"; do
      image=${pair%:*}; versions=${pair##*:}
      docker run --rm "$image" node --input-type=module -e \
        "import assert from 'node:assert/strict'; import {FRESH_APPLICATION_AUTHORIZATION_VERSIONS as versions} from '/app/packages/protocol/dist/index.js'; assert.deepEqual(versions,[$versions]);"
    done
    docker run --detach --name "$postgres" -p 127.0.0.1::5432 \
      --env POSTGRES_DB=mdbase_server_upgrade --env POSTGRES_USER=mdbase \
      --env POSTGRES_PASSWORD=disposable-server-upgrade postgres:17-alpine >/dev/null
    port=$(docker port "$postgres" 5432/tcp | cut -d : -f 2)
    DATABASE_URL="postgres://mdbase:disposable-server-upgrade@127.0.0.1:$port/mdbase_server_upgrade"
    export DATABASE_URL
    for _ in {1..30}; do
      if docker exec "$postgres" pg_isready -h 127.0.0.1 -U mdbase -d mdbase_server_upgrade >/dev/null; then break; fi
      sleep 1
    done
    docker exec "$postgres" pg_isready -h 127.0.0.1 -U mdbase -d mdbase_server_upgrade >/dev/null
    UPGRADE_SERVER_PORT=$(docker run --rm --network host \
      --volume "$repo_root/test/upgrade:/app/test/upgrade:ro" "$candidate_id" \
      node test/upgrade/server-retained-v2-probe.mjs port)
    UPGRADE_SERVER_URL=http://127.0.0.1:$UPGRADE_SERVER_PORT
    export UPGRADE_SERVER_URL
    docker run --rm --network host --env DATABASE_URL "$previous_id" node services/server/dist/migrate.js
    start_server() {
      docker run --detach --name "$server" --network host --env DATABASE_URL \
        --env PUBLIC_URL="$UPGRADE_SERVER_URL" --env PORT="$UPGRADE_SERVER_PORT" \
        --env MDBASE_CONNECT_DEV_AUTH=1 --env MDBASE_CONNECT_ALLOW_INSECURE_MANIFESTS=1 "$1" >/dev/null
      upgrade_wait_http "$UPGRADE_SERVER_URL/ready" 'server rollback fixture'
    }
    stop_server() {
      docker logs "$server" >>"$work/server-phases.log" 2>&1
      upgrade_remove_container "$server"
    }
    probe() {
      docker run --rm --network host --user "$(id -u):$(id -g)" --env UPGRADE_SERVER_URL \
        --volume "$repo_root/test/upgrade:/app/test/upgrade:ro" --volume "$work:/fixture" \
        "$candidate_id" node test/upgrade/server-retained-v2-probe.mjs "$1" /fixture/state.json
    }
    sql() { docker exec "$postgres" psql -X -U mdbase -d mdbase_server_upgrade -Atqc "$1"; }
    inventory() {
      sql "SELECT jsonb_build_object(
        'ledger',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM schema_migrations m),
        'requests',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM authorization_requests r),
        'grants',(SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM grants g),
        'access',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM access_tokens t),
        'refresh',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM refresh_tokens t))" | sha256sum | cut -d ' ' -f 1
    }
    docker run --rm --network host --env DATABASE_URL "$candidate_id" node services/server/dist/migrate.js
    start_server "$candidate_id"
    probe candidate
    [[ $(sql 'SELECT count(*) FROM grants') == 0 ]]
    [[ $(sql 'SELECT count(*) FROM authorization_requests') == 2 ]]
    baseline=$(inventory)
    stop_server
    start_server "$candidate_id"
    probe restart
    [[ $(inventory) == "$baseline" ]]
    stop_server
    upgrade_verify_previous_image "$MDBASE_CONNECT_PREVIOUS_SERVER_IMAGE"
    start_server "$previous_id"
    probe rollback
    [[ $(inventory) == "$baseline" ]]
    stop_server
    start_server "$candidate_id"
    [[ $(inventory) == "$baseline" ]]
    probe reupgrade
    [[ $(sql 'SELECT count(*) FROM authorization_requests') == 4 ]]
    [[ $(sql 'SELECT count(*) FROM grants') == 0 ]]
    jq -n --arg predecessor "$MDBASE_CONNECT_PREVIOUS_SERVER_IMAGE" \
      --arg candidate "$candidate_id" --arg checkout "$(git -C "$repo_root" rev-parse HEAD)" \
      '{scenario:"server-retained-v2-pending", predecessor_source:"408c67bc10f128e0833f0da62cb3efb9d94657d7",
        predecessor_image:$predecessor,candidate_image_id:$candidate,checkout_commit:$checkout,
        qualified:["authenticated-pending-requests","pending-restart-rollback","fresh-v2-request-and-approval-gate","fresh-requests-after-reupgrade"],
        activated_grants_qualified:false,token_refresh_adoption_qualified:false,authority_replay_recovery_qualified:false,
        revocation_qualified:false,signed_publication_qualified:false,deployment_qualified:false}' >"$work/evidence.json"
  ) >"$work/fixture.log" 2>&1
  status=$?
  set -e
  if ((status != 0)); then
    printf 'Server retained-v2 pending scenario FAILED (exit %s); private logs: %s\n' "$status" "$work" >&2
    return "$status"
  fi
  printf 'Server pending-state rollback checks passed. Activated authority/token/replay/revocation remain UNQUALIFIED.\nPrivate evidence: %s\n' "$work"
)
