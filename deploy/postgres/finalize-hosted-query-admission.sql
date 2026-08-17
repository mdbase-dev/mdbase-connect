\set ON_ERROR_STOP on

BEGIN;
SELECT set_config('mdbase.admission_fence_token', :'fence_token', true);
SELECT pg_advisory_xact_lock(
  hashtextextended('mdbase-hosted-query-admission-v1', 0)
);
DO $finalize_admission$
DECLARE
  affected_rows bigint;
  requested_token uuid := current_setting('mdbase.admission_fence_token')::uuid;
BEGIN
  UPDATE hosted_provider_runtime_control
  SET admission_fence_token = NULL,
      admission_fence_kind = NULL,
      admission_lease_expires_at = NULL,
      updated_at = now()
  WHERE singleton = true
    AND query_admission_suspended = false
    AND admission_fence_token = requested_token
    AND admission_fence_kind = 'cutover'
    AND admission_lease_expires_at > clock_timestamp();
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 1 THEN
    RAISE EXCEPTION
      'hosted_admission_finalize_failed: expected one live matching provisional lease, updated %',
      affected_rows;
  END IF;
END
$finalize_admission$;
COMMIT;

SELECT 'hosted_query_admission_finalized' AS result;
