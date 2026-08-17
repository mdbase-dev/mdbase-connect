\set ON_ERROR_STOP on

-- Prepare the final additive Candidate B schema for the exact beta69 binaries.
-- Canonical authority, versions, changes, journals, grants, files and outbox rows
-- are untouched. Only ephemeral query state and incomplete derived generations
-- are retired. External traffic must remain in maintenance throughout rollback.
BEGIN;
SELECT pg_advisory_xact_lock(
  hashtextextended('mdbase-hosted-query-admission-v1', 0)
);

DO $beta69_rollback_preflight$
DECLARE
  migration_count bigint;
  maximum_version bigint;
  invalid_states bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM hosted_provider_runtime_control
    WHERE singleton = true AND query_admission_suspended = true
  ) THEN
    RAISE EXCEPTION
      'beta69_rollback_blocked: suspend hosted query admission first';
  END IF;

  SELECT count(*), max(version)
    INTO migration_count, maximum_version
  FROM _sqlx_migrations
  WHERE success;
  IF migration_count <> 36 OR maximum_version <> 36
     OR EXISTS (SELECT 1 FROM _sqlx_migrations WHERE NOT success OR version > 36) THEN
    RAISE EXCEPTION
      'beta69_rollback_blocked: expected exact successful final ledger 1-36';
  END IF;

  SELECT count(*) INTO invalid_states
  FROM hosted_provider_collections
  WHERE state NOT IN ('active', 'importing', 'transferring', 'transferred', 'deleting');
  IF invalid_states > 0 THEN
    RAISE EXCEPTION
      'beta69_rollback_blocked: % collection(s) are in a final-only lifecycle state',
      invalid_states;
  END IF;
END
$beta69_rollback_preflight$;

DELETE FROM hosted_provider_query_cursors;
DELETE FROM hosted_provider_base_query_invocations;
DELETE FROM hosted_provider_query_page_receipts;
DELETE FROM hosted_provider_query_receipt_usage;

UPDATE hosted_provider_projection_generations
SET status = 'abandoned', abandoned_at = now(), completed_at = NULL,
    lease_owner = NULL, lease_expires_at = NULL,
    last_error_code = 'rollback', updated_at = now()
WHERE status = 'building';

COMMIT;

SELECT 'beta69_rollback_prepared' AS result,
       (SELECT count(*) FROM hosted_provider_collections) AS collections,
       (SELECT count(*) FROM hosted_provider_projection_generations
        WHERE status = 'complete') AS retained_complete_generations;
