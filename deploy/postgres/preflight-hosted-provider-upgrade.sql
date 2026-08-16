\set ON_ERROR_STOP on

-- Run from the candidate provider image before starting its web process. The
-- advisory lock is the same one held by Candidate B page transactions. Once
-- migration 0047 exists, persistently suspend admission so no new page can race
-- the quiescent 0049/0050 checks before the candidate starts.
BEGIN;
SELECT pg_advisory_xact_lock(
  hashtextextended('mdbase-hosted-query-admission-v1', 0)
);

DO $candidate_b_upgrade_preflight$
DECLARE
  migration_applied boolean;
  populated boolean;
  fenced boolean := false;
  active_candidate_b bigint := 0;
  updated_controls bigint := 0;
BEGIN
  IF to_regclass('hosted_provider_runtime_control') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'hosted_provider_runtime_control'
         AND column_name = 'query_admission_suspended'
     ) THEN
    EXECUTE $sql$
      UPDATE hosted_provider_runtime_control
      SET query_admission_suspended = true,
          suspension_reason = 'controlled_provider_upgrade',
          updated_at = now()
      WHERE singleton = true
    $sql$;
    GET DIAGNOSTICS updated_controls = ROW_COUNT;
    IF updated_controls <> 1 THEN
      RAISE EXCEPTION
        'candidate_b_upgrade_preflight_blocked: runtime-control singleton is missing';
    END IF;
    fenced := true;
  END IF;

  -- A database predating the durable fence is permitted only for the first,
  -- inactive Candidate B rollout. It must not already carry activated traffic.
  IF NOT fenced
     AND to_regclass('hosted_provider_collections') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'hosted_provider_collections'
         AND column_name = 'hosted_execution_model'
     ) THEN
    EXECUTE $sql$
      SELECT count(*) FROM hosted_provider_collections
      WHERE state = 'active' AND hosted_execution_model = 'candidate_b'
    $sql$ INTO active_candidate_b;
    IF active_candidate_b > 0 THEN
      RAISE EXCEPTION
        'candidate_b_upgrade_preflight_blocked: % active Candidate B collection(s) without a durable admission fence',
        active_candidate_b;
    END IF;
  END IF;

  migration_applied := false;
  IF to_regclass('_sqlx_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM _sqlx_migrations WHERE version = 46 AND success)'
      INTO migration_applied;
  END IF;
  IF NOT migration_applied
     AND to_regclass('hosted_provider_record_projections') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM hosted_provider_record_projections LIMIT 1)'
      INTO populated;
    IF populated THEN
      RAISE EXCEPTION
        'candidate_b_upgrade_preflight_blocked: projection rows must be rebuilt before migration 0046';
    END IF;
  END IF;

  migration_applied := false;
  IF to_regclass('_sqlx_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM _sqlx_migrations WHERE version = 49 AND success)'
      INTO migration_applied;
  END IF;
  IF NOT migration_applied
     AND to_regclass('hosted_provider_query_page_receipts') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM hosted_provider_query_page_receipts LIMIT 1)'
      INTO populated;
    IF populated THEN
      RAISE EXCEPTION
        'candidate_b_upgrade_preflight_blocked: query page receipts must be drained before migration 0049';
    END IF;
  END IF;

  migration_applied := false;
  IF to_regclass('_sqlx_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM _sqlx_migrations WHERE version = 50 AND success)'
      INTO migration_applied;
  END IF;
  IF NOT migration_applied
     AND to_regclass('hosted_provider_query_cursors') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM hosted_provider_query_cursors LIMIT 1)'
      INTO populated;
    IF populated THEN
      RAISE EXCEPTION
        'candidate_b_upgrade_preflight_blocked: query cursors must be drained before migration 0050';
    END IF;
  END IF;
END
$candidate_b_upgrade_preflight$;
COMMIT;

SELECT 'candidate_b_upgrade_preflight_ready' AS result;
