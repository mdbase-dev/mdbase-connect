\set ON_ERROR_STOP on

-- Reuse the complete relation/index/column/trigger/function/constraint and
-- lifecycle attestation used by rollback. The fence kind parameter makes the
-- shared read-only contract verify this cutover's exact durable fence.
\set fence_kind cutover
\ir preflight-hosted-provider-final-rollback.sql

-- Final read-only gate while external maintenance and the operation-bound
-- cutover fence are both closed. Full record/edge verification is performed by
-- the bounded projection indexer immediately before this database invariant.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path = public, pg_catalog;
SELECT set_config('mdbase.expected_migration_max', '37', true);
\ir attest-hosted-provider-migration-ledger.sql
SELECT set_config('mdbase.admission_fence_token', :'fence_token', true);

DO $final_cutover_preflight$
DECLARE
  requested_token uuid := current_setting('mdbase.admission_fence_token')::uuid;
  runtime_rows bigint;
  unready_collections bigint;
BEGIN
  SELECT count(*)
    INTO runtime_rows
  FROM hosted_provider_runtime_control
  WHERE singleton = true
    AND query_admission_suspended = true
    AND suspension_reason = 'controlled_provider_cutover'
    AND admission_fence_token = requested_token
    AND admission_fence_kind = 'cutover'
    AND admission_lease_expires_at IS NULL
    AND admission_owner_expires_at > clock_timestamp();
  IF runtime_rows <> 1 OR (SELECT count(*) FROM hosted_provider_runtime_control) <> 1 THEN
    RAISE EXCEPTION
      'final_cutover_blocked: expected exactly one matching cutover admission fence';
  END IF;

  SELECT count(*)
    INTO unready_collections
  FROM hosted_provider_collections collection_row
  LEFT JOIN hosted_provider_projection_generations generation
    ON generation.collection_id = collection_row.id
   AND generation.generation_id = collection_row.active_projection_generation_id
  WHERE collection_row.state = 'active'
    AND (
      collection_row.active_projection_generation_id IS NULL
      OR generation.status IS DISTINCT FROM 'complete'
      OR generation.source_head IS DISTINCT FROM collection_row.head
      OR generation.source_resource_revision
           IS DISTINCT FROM collection_row.resource_revision
      OR generation.target_catalog_revision
           IS DISTINCT FROM collection_row.active_catalog_revision
      OR generation.projection_format_version
           IS DISTINCT FROM collection_row.active_projection_format_version
      OR generation.semantic_engine_version
           IS DISTINCT FROM collection_row.active_semantic_engine_version
    );
  IF unready_collections <> 0 THEN
    RAISE EXCEPTION
      'final_cutover_blocked: % active collection(s) lack a complete current projection',
      unready_collections;
  END IF;
END
$final_cutover_preflight$;

COMMIT;
SELECT 'final_cutover_preflight_ready' AS result;
