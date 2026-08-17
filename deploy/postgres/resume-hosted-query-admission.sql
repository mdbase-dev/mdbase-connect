\set ON_ERROR_STOP on

BEGIN;
SELECT set_config('mdbase.admission_fence_token', :'fence_token', true);
SELECT set_config('mdbase.admission_fence_kind', :'fence_kind', true);
SELECT pg_advisory_xact_lock(
  hashtextextended('mdbase-hosted-query-admission-v1', 0)
);
DO $resume_admission$
DECLARE
  affected_rows bigint;
  requested_token uuid := current_setting('mdbase.admission_fence_token')::uuid;
  requested_kind text := current_setting('mdbase.admission_fence_kind');
BEGIN
  IF requested_kind NOT IN ('cutover', 'rollback') THEN
    RAISE EXCEPTION
      'hosted_admission_resume_failed: unsupported fence kind %', requested_kind;
  END IF;
  UPDATE hosted_provider_runtime_control
  SET query_admission_suspended = false,
      suspension_reason = NULL,
      admission_fence_token = NULL,
      admission_fence_kind = NULL,
      admission_lease_expires_at = NULL,
      updated_at = now()
  WHERE singleton = true
    AND query_admission_suspended = true
    AND admission_fence_token = requested_token
    AND admission_fence_kind = requested_kind;
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 1 THEN
    RAISE EXCEPTION
      'hosted_admission_resume_failed: expected exactly one matching fenced runtime control row, updated %',
      affected_rows;
  END IF;
END
$resume_admission$;
COMMIT;

SELECT 'hosted_query_admission_resumed' AS result;
