\set ON_ERROR_STOP on

-- Read-only gate for a production beta69 database before the final Candidate B
-- migrations are allowed to run. The service maintenance fence is external at
-- this point because beta69 predates the durable query-admission control row.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path = public, pg_catalog;
SELECT set_config('mdbase.expected_migration_max', '34', true);
\ir attest-hosted-provider-migration-ledger.sql

DO $beta69_cutover_preflight$
DECLARE
  migration_count bigint;
  minimum_version bigint;
  maximum_version bigint;
  failed_migrations bigint;
  missing_migrations bigint;
BEGIN
  IF to_regclass('public._sqlx_migrations') IS NULL THEN
    RAISE EXCEPTION
      'beta69_cutover_blocked: SQLx migration ledger is absent';
  END IF;

  SELECT count(*), min(version), max(version),
         count(*) FILTER (WHERE NOT success)
    INTO migration_count, minimum_version, maximum_version, failed_migrations
  FROM public._sqlx_migrations;
  SELECT count(*)
    INTO missing_migrations
  FROM generate_series(1, 34) AS required(version)
  WHERE NOT EXISTS (
    SELECT 1 FROM public._sqlx_migrations applied
    WHERE applied.version = required.version AND applied.success
  );
  IF migration_count <> 34 OR minimum_version <> 1 OR maximum_version <> 34
     OR failed_migrations <> 0 OR missing_migrations <> 0 THEN
    RAISE EXCEPTION
      'beta69_cutover_blocked: expected exact successful migration ledger 1-34';
  END IF;

  IF to_regclass('public.hosted_provider_projection_generations') IS NOT NULL
     OR to_regclass('public.hosted_provider_record_projections') IS NOT NULL
     OR to_regclass('public.hosted_provider_record_resolution_keys') IS NOT NULL
     OR to_regclass('public.hosted_provider_record_relationships') IS NOT NULL
     OR to_regclass('public.hosted_provider_query_cursors') IS NOT NULL
     OR to_regclass('public.hosted_provider_base_query_invocations') IS NOT NULL
     OR to_regclass('public.hosted_provider_query_page_receipts') IS NOT NULL
     OR to_regclass('public.hosted_provider_query_receipt_usage') IS NOT NULL
     OR to_regclass('public.hosted_provider_runtime_control') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'hosted_provider_collections'
         AND (
           column_name LIKE 'active_projection_%'
           OR column_name IN (
             'active_catalog_revision',
             'active_semantic_engine_version'
           )
         )
     ) THEN
    RAISE EXCEPTION
      'beta69_cutover_blocked: Candidate B schema already exists';
  END IF;
END
$beta69_cutover_preflight$;

SELECT count(*) AS collections,
       count(*) FILTER (WHERE state = 'active') AS active_collections,
       coalesce(sum(record_count), 0) AS current_records,
       coalesce(sum(content_bytes), 0) AS exact_content_bytes,
       coalesce(max(record_count), 0) AS largest_collection_records
FROM hosted_provider_collections;

COMMIT;

SELECT 'beta69_cutover_preflight_ready' AS result;
