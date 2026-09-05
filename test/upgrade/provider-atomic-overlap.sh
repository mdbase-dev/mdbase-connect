#!/usr/bin/env bash
# shellcheck shell=bash
# Variables and callbacks are shared with the sourcing harness.
# shellcheck disable=SC2034,SC2154
# Sourced by provider-from-previous. Only a uniquely owned synthetic clone is
# changed. The trigger is test synchronization, never deployment/rollback logic.
provider_atomic_overlap() (
  set -euo pipefail
  local UPGRADE_ROLLBACK_APPLICATION_ID=$UPGRADE_ROLLBACK_APPLICATION_ID
  local UPGRADE_ROLLBACK_MIRROR_ID=$UPGRADE_ROLLBACK_MIRROR_ID
  local UPGRADE_ROLLBACK_GRANT_ID=$UPGRADE_ROLLBACK_GRANT_ID
  local UPGRADE_ROLLBACK_APPLICATION_TOKEN=$UPGRADE_ROLLBACK_APPLICATION_TOKEN
  local UPGRADE_ROLLBACK_MIRROR_TOKEN=$UPGRADE_ROLLBACK_MIRROR_TOKEN
  local expected="postgres://mdbase:previous-provider-upgrade@127.0.0.1:$UPGRADE_DATABASE_PORT/mdbase_provider_upgrade"
  [[ $DATABASE_URL == "$expected" ]] || {
    printf 'Atomic overlap requires the disposable upgrade database URL.\n' >&2
    exit 2
  }
  local suffix="${BASHPID}_${RANDOM}" db owned=false work holder candidate previous
  db="mdbase_upgrade_overlap_$suffix"
  holder="mdbase-overlap-lock-$suffix"
  candidate="mdbase-overlap-candidate-$suffix"
  previous="mdbase-overlap-previous-$suffix"
  work=$(mktemp -d "${RUNNER_TEMP:-/tmp}/mdbase-overlap.XXXXXX")
  local -a curls=()
  overlap_sql() {
    docker run --rm --network host --env PGPASSWORD=previous-provider-upgrade \
      postgres:18-alpine psql --host 127.0.0.1 --port "$UPGRADE_DATABASE_PORT" \
      --username mdbase --dbname "${2:-$db}" --set ON_ERROR_STOP=1 \
      --tuples-only --no-align --command "$1"
  }
  # Invoked by the EXIT trap, including assertion failures.
  # shellcheck disable=SC2329
  overlap_cleanup() {
    local pid
    for pid in "${curls[@]}"; do kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; done
    upgrade_remove_container "$candidate"
    upgrade_remove_container "$previous"
    upgrade_remove_container "$holder"
    if [[ $owned == true ]]; then
      overlap_sql "DROP DATABASE $db WITH (FORCE)" postgres >/dev/null
    fi
    rm -rf -- "$work"
  }
  trap overlap_cleanup EXIT
  overlap_sql "CREATE DATABASE $db TEMPLATE mdbase_provider_upgrade" postgres >/dev/null
  owned=true
  DATABASE_URL="postgres://mdbase:previous-provider-upgrade@127.0.0.1:$UPGRADE_DATABASE_PORT/$db"
  export DATABASE_URL
  # Reuse exact legacy HTTP/policy helpers, with SQL confined to this clone.
  rollback_sql() { overlap_sql "$1"; }
  local port
  port=$(node --input-type=module -e 'import net from "node:net"; const s=net.createServer(); s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});')
  [[ $port != "$UPGRADE_PROVIDER_PORT" ]]
  local rollback_application rollback_mirror rollback_narrowed receipts ledger schema
  receipts=$(rollback_receipt_inventory)
  ledger=$(rollback_sql 'SELECT md5(string_agg(row_to_json(m)::text, chr(10) ORDER BY version)) FROM _sqlx_migrations m')
  [[ $(rollback_sql 'SELECT max(version) FROM _sqlx_migrations WHERE success') == 38 ]]
  overlap_schema() {
    rollback_sql "SELECT jsonb_build_object(
      'columns',(SELECT jsonb_agg(to_jsonb(c) ORDER BY table_name,ordinal_position) FROM information_schema.columns c WHERE table_schema='public'),
      'constraints',(SELECT jsonb_agg(jsonb_build_array(conname,pg_get_constraintdef(oid)) ORDER BY conname) FROM pg_constraint WHERE connamespace='public'::regnamespace),
      'indexes',(SELECT jsonb_agg(to_jsonb(i) ORDER BY indexname) FROM pg_indexes i WHERE schemaname='public'))" | sha256sum | cut -d ' ' -f 1
  }
  schema=$(overlap_schema)
  rollback_sql "CREATE FUNCTION upgrade_test_pause40() RETURNS trigger LANGUAGE plpgsql AS \$\$
    DECLARE prior_timeout text;
    BEGIN
      IF NEW.version = 40 THEN
        prior_timeout := current_setting('lock_timeout');
        PERFORM set_config('lock_timeout', '0', true);
        PERFORM pg_advisory_xact_lock(194038, 41);
        PERFORM set_config('lock_timeout', prior_timeout, true);
      END IF;
      RETURN NEW;
    END \$\$;
    CREATE TRIGGER upgrade_test_pause40 AFTER INSERT ON _sqlx_migrations
      FOR EACH ROW EXECUTE FUNCTION upgrade_test_pause40();" >/dev/null
  DATABASE_URL="$DATABASE_URL?application_name=$previous" start_previous_provider "$previous" false
  overlap_poll() {
    local sql=$1 label=$2 attempt
    for ((attempt=0; attempt<30; attempt++)); do
      if [[ $(rollback_sql "$sql") == t ]]; then return 0; fi
      sleep 0.1
    done
    printf 'Atomic overlap observation failed: %s\n' "$label" >&2
    projection_diagnostic_text "$(docker logs --tail 30 "$candidate" 2>&1)"
    return 1
  }
  overlap_hold() {
    docker run --detach --name "$holder" --network host \
      --env PGPASSWORD=previous-provider-upgrade --env PGAPPNAME="$holder" \
      postgres:18-alpine psql --host 127.0.0.1 --port "$UPGRADE_DATABASE_PORT" \
      --username mdbase --dbname "$db" --set ON_ERROR_STOP=1 \
      --command 'SELECT pg_advisory_lock(194038, 41); SELECT pg_sleep(60)' >/dev/null
    overlap_poll "SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a USING(pid) WHERE a.datname='$db' AND a.application_name='$holder' AND l.locktype='advisory' AND l.classid=194038 AND l.objid=41 AND l.granted)" 'owned hold'
    DATABASE_URL="$DATABASE_URL?application_name=$candidate" start_candidate_provider "$candidate" "$port"
    # A paused migrator cannot be ready. Observe its actual backend first.
    overlap_poll "SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a USING(pid) WHERE a.datname='$db' AND a.application_name='$candidate' AND l.locktype='advisory' AND l.classid=194038 AND l.objid=41 AND NOT l.granted)" 'candidate after nested migration40'
    [[ $(rollback_sql 'SELECT max(version) FROM _sqlx_migrations WHERE success') == 38 ]] || {
      printf 'Atomicity failure: external connection sees migration39/40 before41.\n' >&2
      return 1
    }
    [[ $(rollback_sql "SELECT count(*) FROM pg_attribute WHERE attrelid='hosted_provider_replicas'::regclass AND attname IN ('application_setup_evidence','application_semantic_version') AND NOT attisdropped") == 0 ]]
    printf 'Observed candidate paused after40; external ledger and DDL remain38.\n'
  }
  overlap_release() {
    rollback_sql "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$db' AND application_name='$holder'" >/dev/null
    upgrade_remove_container "$holder"
    overlap_poll "SELECT NOT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a USING(pid) WHERE a.datname='$db' AND a.application_name='$holder' AND l.locktype='advisory')" 'helper locks released'
  }
  overlap_launch() {
    local kind body rc
    for kind in application mirror; do
      if [[ $kind == application ]]; then body=$rollback_application; else body=$rollback_mirror; fi
      curl --silent --show-error --connect-timeout 5 --max-time 8 \
        --request POST --header 'content-type: application/json' \
        --header "authorization: Bearer $PROVIDER_INTERNAL_TOKEN" --data "$body" \
        --output "$work/$kind.body" --write-out '%{http_code}' \
        "$UPGRADE_PROVIDER_URL/internal/v1/collections/$UPGRADE_COLLECTION_ID/replicas" \
        >"$work/$kind.status" 2>"$work/$kind.stderr" &
      curls+=("$!")
      # Observe each request while it overlaps the paused binary, then allow
      # beta.94's existing five-second lock timeout (or the shorter-than-normal
      # eight-second HTTP deadline) bounds unavailability. No timeout increases.
      if ! overlap_poll "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname='$db' AND application_name='$previous' AND wait_event_type='Lock')" "old HTTP $kind blocked during cutover"; then
        projection_diagnostic_text "$(<"$work/$kind.body")"
        return 1
      fi
      rc=0
      wait "${curls[-1]}" || rc=$?
      printf '%s' "$rc" >"$work/$kind.exit"
      unset 'curls[-1]'
    done
    # Reject a holder expiry or candidate failure during the HTTP observations.
    overlap_poll "SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a USING(pid) WHERE a.datname='$db' AND a.application_name='$candidate' AND l.locktype='advisory' AND l.classid=194038 AND l.objid=41 AND NOT l.granted)" 'candidate still held after old HTTP'
    [[ $(rollback_sql 'SELECT max(version) FROM _sqlx_migrations WHERE success') == 38 ]]
  }
  overlap_join() {
    local kind status
    for kind in application mirror; do
      status=$(<"$work/$kind.status")
      case "$status:$(<"$work/$kind.exit")" in
        201:0) ;;
        000:28) ;; # Observed database wait exceeded the bounded HTTP deadline.
        500:0|503:0)
          # No authorization denial, constraint failure, or arbitrary 5xx is
          # accepted as transient. Require the database lock-timeout cause.
          if ! jq -e '.error.code == "provider_database_timeout" and .error.details.timeout_class == "lock"' "$work/$kind.body" >/dev/null; then
            projection_diagnostic_text "$(<"$work/$kind.body")"
            return 1
          fi
          ;;
        *) printf 'Overlap HTTP unexpected status: %s\n' "$status" >&2; return 1 ;;
      esac
      printf 'Old HTTP %s overlap result: status=%s, curl=%s; requiring successful exact retry.\n' \
        "$kind" "$status" "$(<"$work/$kind.exit")"
    done
    # Every outcome must converge via the unchanged old binary to exact policy.
    rollback_http POST "/internal/v1/collections/$UPGRADE_COLLECTION_ID/replicas" "$rollback_application" 201 >/dev/null
    rollback_http POST "/internal/v1/collections/$UPGRADE_COLLECTION_ID/replicas" "$rollback_mirror" 201 >/dev/null
    rollback_assert_policy "$rollback_application" 1
  }
  overlap_bodies() {
    rollback_application=$(rollback_application_body)
    rollback_mirror=$(jq -cn --arg id "$UPGRADE_ROLLBACK_MIRROR_ID" --arg token "$UPGRADE_ROLLBACK_MIRROR_TOKEN" \
      '{replica_id:$id,name:"Upgrade rollback mirror",purpose:"mirror",mode:"read_write",allowed_types:[],contract_scope:[],full_collection:false,allowed_operations:[],grant_id:null,token:$token}')
  }
  upgrade_phase 'interrupting actual candidate after40 with concurrent predecessor provisioning'
  overlap_bodies
  overlap_hold
  overlap_launch
  upgrade_remove_container "$candidate"
  # PostgreSQL can discover a dead client only after its advisory wait ends.
  # Release the owned holder after the binary is gone; no client can COMMIT.
  overlap_release
  overlap_poll "SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname='$db' AND application_name='$candidate')" 'candidate sessions and locks released'
  [[ $(rollback_sql 'SELECT md5(string_agg(row_to_json(m)::text, chr(10) ORDER BY version)) FROM _sqlx_migrations m') == "$ledger" ]]
  [[ $(overlap_schema) == "$schema" ]]
  overlap_join
  [[ $(rollback_receipt_inventory) == "$receipts" ]]
  printf 'Interrupted candidate rolled back all39–41 DDL/ledger; old HTTP writes succeeded.\n'

  # Fresh rows make the successful cutover prove new legacy INSERTs, not only
  # idempotent retries of the interrupted phase's rows.
  UPGRADE_ROLLBACK_APPLICATION_ID=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1
  UPGRADE_ROLLBACK_MIRROR_ID=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2
  UPGRADE_ROLLBACK_GRANT_ID=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3
  UPGRADE_ROLLBACK_APPLICATION_TOKEN=upgrade-overlap-second-application
  UPGRADE_ROLLBACK_MIRROR_TOKEN=upgrade-overlap-second-mirror-fixed-test-token
  overlap_bodies
  upgrade_phase 'releasing actual atomic38-to41 with concurrent predecessor provisioning'
  overlap_hold
  overlap_launch
  overlap_release
  overlap_join
  # Only now may candidate readiness be awaited, on its independent port.
  UPGRADE_PROVIDER_URL="http://127.0.0.1:$port" wait_candidate_provider
  [[ $(rollback_sql 'SELECT max(version) FROM _sqlx_migrations WHERE success') == 41 ]]
  [[ $(rollback_sql 'SELECT count(*) FROM _sqlx_migrations WHERE version BETWEEN 39 AND 41 AND success') == 3 ]]
  rollback_narrowed=$(jq -c '.allowed_operations = ["assess_collection_setup"]' <<<"$rollback_application")
  rollback_http PATCH "/internal/v1/replicas/$UPGRADE_ROLLBACK_APPLICATION_ID/policy" "$rollback_narrowed" 204 >/dev/null
  rollback_assert_policy "$rollback_narrowed" 2
  rollback_http PATCH "/internal/v1/replicas/$UPGRADE_ROLLBACK_APPLICATION_ID/policy" "$rollback_narrowed" 204 >/dev/null
  rollback_http POST "/internal/v1/collections/$UPGRADE_COLLECTION_ID/replicas" "$rollback_narrowed" 201 >/dev/null
  rollback_assert_policy "$rollback_narrowed" 2
  rollback_assess_binding
  [[ $(rollback_receipt_inventory) == "$receipts" ]]
  [[ $(provider_application_operation "$application_operation_request") == "$predecessor_application_receipt" ]]
  [[ $(rollback_receipt_inventory) == "$receipts" ]]
  printf 'Concurrent beta.94 provisioning, exact policy/retry epochs and terminal receipt passed.\n'
)
