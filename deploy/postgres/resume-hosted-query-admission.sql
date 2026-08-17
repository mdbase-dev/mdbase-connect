\set ON_ERROR_STOP on

BEGIN;
SELECT pg_advisory_xact_lock(
  hashtextextended('mdbase-hosted-query-admission-v1', 0)
);
DO $resume_admission$
DECLARE
  affected_rows bigint;
BEGIN
  UPDATE hosted_provider_runtime_control
  SET query_admission_suspended = false,
      suspension_reason = NULL,
      updated_at = now()
  WHERE singleton = true;
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 1 THEN
    RAISE EXCEPTION
      'hosted_admission_resume_failed: expected exactly one runtime control row, updated %',
      affected_rows;
  END IF;
END
$resume_admission$;
COMMIT;

SELECT 'hosted_query_admission_resumed' AS result;
