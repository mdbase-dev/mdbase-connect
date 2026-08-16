\set ON_ERROR_STOP on

-- Providers predating migration 0058 use the zero digest marker without the
-- transaction-local writer capability. They remain safe only while Candidate B
-- is unactivated and no projection rows exist for them to maintain.
DO $candidate_b_pre_0058_rollback_preflight$
DECLARE
  candidate_b_collections bigint;
  projection_rows bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = current_schema()
      AND procedure.proname = 'hosted_provider_observe_projection_digest'
      AND pg_get_functiondef(procedure.oid) LIKE '%mdbase.projection_digest_write%'
  ) THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM hosted_provider_runtime_control
    WHERE singleton = true AND query_admission_suspended = true
  ) THEN
    RAISE EXCEPTION
      'candidate_b_pre_0058_rollback_blocked: suspend hosted query admission first';
  END IF;

  SELECT count(*) INTO candidate_b_collections
  FROM hosted_provider_collections
  WHERE hosted_execution_model = 'candidate_b';

  SELECT count(*) INTO projection_rows
  FROM hosted_provider_record_projections;

  IF candidate_b_collections > 0 OR projection_rows > 0 THEN
    RAISE EXCEPTION
      'candidate_b_pre_0058_rollback_blocked: % Candidate B collection(s), % projection row(s); use a digest-guard-aware binary',
      candidate_b_collections, projection_rows;
  END IF;
END
$candidate_b_pre_0058_rollback_preflight$;

SELECT 'candidate_b_pre_0058_rollback_ready' AS result;
