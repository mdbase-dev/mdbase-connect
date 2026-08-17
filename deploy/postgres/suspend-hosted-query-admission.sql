\set ON_ERROR_STOP on

BEGIN;
SELECT set_config('mdbase.admission_fence_token', :'fence_token', true);
SELECT set_config('mdbase.admission_fence_kind', :'fence_kind', true);
SELECT set_config('mdbase.admission_owner_lease_seconds', :'owner_lease_seconds', true);
SELECT pg_advisory_xact_lock(
  hashtextextended('mdbase-hosted-query-admission-v1', 0)
);
DO $suspend_admission$
DECLARE
  affected_rows bigint;
  requested_token uuid := current_setting('mdbase.admission_fence_token')::uuid;
  requested_kind text := current_setting('mdbase.admission_fence_kind');
  owner_lease_seconds integer := current_setting('mdbase.admission_owner_lease_seconds')::integer;
BEGIN
  IF requested_kind NOT IN ('cutover', 'rollback') THEN
    RAISE EXCEPTION
      'hosted_admission_suspend_failed: unsupported fence kind %', requested_kind;
  END IF;
  IF requested_kind = 'cutover'
     AND (owner_lease_seconds < 300 OR owner_lease_seconds > 86400) THEN
    RAISE EXCEPTION
      'hosted_admission_suspend_failed: cutover owner lease must be between 300 and 86400 seconds';
  END IF;
  UPDATE hosted_provider_runtime_control
  SET query_admission_suspended = true,
      suspension_reason = 'controlled_provider_' || requested_kind,
      admission_fence_token = requested_token,
      admission_fence_kind = requested_kind,
      admission_lease_expires_at = NULL,
      admission_owner_expires_at = CASE
        WHEN requested_kind = 'cutover'
          THEN clock_timestamp() + make_interval(secs => owner_lease_seconds)
        ELSE NULL
      END,
      updated_at = now()
  WHERE singleton = true
    AND (
      admission_fence_token IS NULL
      OR (
        admission_fence_token = requested_token
        AND admission_fence_kind = requested_kind
      )
      OR (
        admission_fence_kind = 'cutover'
        AND admission_owner_expires_at <= clock_timestamp()
        AND (
          query_admission_suspended
          OR admission_lease_expires_at <= clock_timestamp()
        )
      )
    );
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 1 THEN
    RAISE EXCEPTION
      'hosted_admission_suspend_failed: expected exactly one compatible runtime control row, updated %',
      affected_rows;
  END IF;
END
$suspend_admission$;
COMMIT;

SELECT 'hosted_query_admission_suspended' AS result,
       admission_fence_kind AS fence_kind
FROM hosted_provider_runtime_control
WHERE singleton = true;
