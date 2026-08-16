\set ON_ERROR_STOP on

-- Required invocation:
--   psql "$DATABASE_URL" -v collection_id='<uuid>' -f this-file.sql
-- Query admission must already be suspended. Exact ciphertext and all
-- projection evidence are retained; only the serving binding is removed.
BEGIN;
SELECT pg_advisory_xact_lock(
  hashtextextended('mdbase-hosted-query-admission-v1', 0)
);

CREATE FUNCTION pg_temp.candidate_b_collection_rollback_preflight(target_collection_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $candidate_b_collection_rollback_preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM hosted_provider_runtime_control
    WHERE singleton = true AND query_admission_suspended = true
  ) THEN
    RAISE EXCEPTION
      'candidate_b_collection_rollback_blocked: suspend hosted query admission first';
  END IF;
  IF EXISTS (
    SELECT 1 FROM hosted_provider_query_cursors
    WHERE collection_id = target_collection_id
      AND expires_at > now() AND hard_expires_at > now()
  ) THEN
    RAISE EXCEPTION
      'candidate_b_collection_rollback_blocked: live query cursors remain';
  END IF;
END;
$candidate_b_collection_rollback_preflight$;

SELECT pg_temp.candidate_b_collection_rollback_preflight(:'collection_id'::uuid);

SELECT id
FROM hosted_provider_collections
WHERE id = :'collection_id'::uuid AND state = 'active'
FOR UPDATE;

UPDATE hosted_provider_projection_generations
SET status = 'abandoned', abandoned_at = now(), completed_at = NULL,
    lease_owner = NULL, lease_expires_at = NULL,
    last_error_code = 'rollback', updated_at = now()
WHERE collection_id = :'collection_id'::uuid AND status = 'building';

UPDATE hosted_provider_collections
SET hosted_execution_model = 'legacy',
    active_catalog_revision = NULL,
    active_projection_format_version = NULL,
    active_semantic_engine_version = NULL,
    active_projection_generation_id = NULL,
    updated_at = now()
WHERE id = :'collection_id'::uuid AND state = 'active';

COMMIT;

SELECT 'candidate_b_collection_deactivated_for_rollback' AS result,
       :'collection_id'::uuid AS collection_id;
