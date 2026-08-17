\set ON_ERROR_STOP on

BEGIN;
SELECT pg_advisory_xact_lock(
  hashtextextended('mdbase-hosted-query-admission-v1', 0)
);
DO $suspend_admission$
DECLARE
  affected_rows bigint;
BEGIN
  UPDATE hosted_provider_runtime_control
  SET query_admission_suspended = true,
      suspension_reason = 'controlled_provider_rollback',
      updated_at = now()
  WHERE singleton = true;
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 1 THEN
    RAISE EXCEPTION
      'hosted_admission_suspend_failed: expected exactly one runtime control row, updated %',
      affected_rows;
  END IF;
END
$suspend_admission$;
COMMIT;

SELECT 'hosted_query_admission_suspended' AS result;
