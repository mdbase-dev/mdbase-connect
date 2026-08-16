\set ON_ERROR_STOP on

-- Providers predating migration 0056 cannot decode compressed query-page
-- receipts. Admission must remain fenced while callers release them or the
-- one-hour hard receipt lifetime and bounded maintenance drain them.
DO $candidate_b_pre_0056_rollback_preflight$
DECLARE
  compressed_receipts bigint;
BEGIN
  -- Databases that never applied 0056 have no compressed format to drain.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'hosted_provider_query_page_receipts'
      AND column_name = 'response_encoding'
  ) THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM hosted_provider_runtime_control
    WHERE singleton = true AND query_admission_suspended = true
  ) THEN
    RAISE EXCEPTION
      'candidate_b_pre_0056_rollback_blocked: suspend hosted query admission first';
  END IF;

  SELECT count(*)
    INTO compressed_receipts
  FROM hosted_provider_query_page_receipts
  WHERE response_encoding = 'zstd-json-v1';

  IF compressed_receipts > 0 THEN
    RAISE EXCEPTION
      'candidate_b_pre_0056_rollback_blocked: % compressed query receipt(s); release or drain them before rollback',
      compressed_receipts;
  END IF;
END
$candidate_b_pre_0056_rollback_preflight$;

SELECT 'candidate_b_pre_0056_rollback_ready' AS result;
