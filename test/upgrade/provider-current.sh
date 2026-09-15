#!/usr/bin/env bash
# Called inside retained_v2_run's owned disposable fixture. This is current
# candidate evidence, separate from the immutable historical rollback pair.
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
  CANDIDATE_IMAGE=$MDBASE_CONNECT_PREVIOUS_PROVIDER_IMAGE
  start_candidate_provider "$previous"
  if ((candidate_max > predecessor_max)); then
    [[ $(timeout 45s docker wait "$previous") == 1 ]]
    docker logs "$previous" >"$work/predecessor-refusal.private.log" 2>&1
    grep -Fq "hosted migration ledger is not an exact successful catalog prefix at $((predecessor_max + 1))" \
      "$work/predecessor-refusal.private.log"
    rollback_result=refused-unknown-migration
  else
    upgrade_wait_http "$UPGRADE_PROVIDER_URL/ready" 'same-schema predecessor' 30 2
    probe replay
    probe enforce
    probe cancel-import-retry
    rollback_result=fixture-compatible
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
