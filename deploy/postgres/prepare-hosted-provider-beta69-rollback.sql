\set ON_ERROR_STOP on

-- Prepare the final additive Candidate B schema for the exact beta69 binaries.
-- Canonical authority, versions, changes, journals, grants, files and outbox rows
-- are untouched. Only ephemeral query state and incomplete derived generations
-- are retired. External traffic must remain in maintenance throughout rollback.
BEGIN;
SET LOCAL search_path = public, pg_catalog;
SELECT set_config('mdbase.expected_migration_max', '37', true);
\ir attest-hosted-provider-migration-ledger.sql
SELECT set_config('mdbase.admission_fence_token', :'fence_token', true);
SELECT pg_advisory_xact_lock(
  hashtextextended('mdbase-hosted-query-admission-v1', 0)
);

DO $beta69_rollback_preflight$
DECLARE
  migration_count bigint;
  minimum_version bigint;
  maximum_version bigint;
  failed_migrations bigint;
  missing_migrations bigint;
  invalid_states bigint;
  requested_token uuid := current_setting('mdbase.admission_fence_token')::uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM hosted_provider_runtime_control
    WHERE singleton = true
      AND query_admission_suspended = true
      AND admission_fence_token = requested_token
      AND admission_fence_kind = 'rollback'
  ) THEN
    RAISE EXCEPTION
      'beta69_rollback_blocked: matching rollback admission fence is absent';
  END IF;

  SELECT count(*), min(version), max(version),
         count(*) FILTER (WHERE NOT success)
    INTO migration_count, minimum_version, maximum_version, failed_migrations
  FROM _sqlx_migrations;
  SELECT count(*)
    INTO missing_migrations
  FROM generate_series(1, 42) AS required(version)
  WHERE NOT EXISTS (
    SELECT 1 FROM _sqlx_migrations applied
    WHERE applied.version = required.version AND applied.success
  );
  IF migration_count <> 42 OR minimum_version <> 1 OR maximum_version <> 42
     OR failed_migrations <> 0 OR missing_migrations <> 0 THEN
    RAISE EXCEPTION
      'beta69_rollback_blocked: expected exact successful final ledger 1-42';
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
