\set ON_ERROR_STOP on

BEGIN;
SELECT set_config('mdbase.admission_fence_token', :'fence_token', true);
SELECT set_config('mdbase.admission_lease_seconds', :'lease_seconds', true);
SELECT pg_advisory_xact_lock(
  hashtextextended('mdbase-hosted-query-admission-v1', 0)
);
DO $open_provisional_admission$
DECLARE
  affected_rows bigint;
  requested_token uuid := current_setting('mdbase.admission_fence_token')::uuid;
  lease_seconds integer := current_setting('mdbase.admission_lease_seconds')::integer;
BEGIN
  IF lease_seconds < 30 OR lease_seconds > 600 THEN
    RAISE EXCEPTION
      'hosted_admission_provisional_open_failed: lease must be between 30 and 600 seconds';
  END IF;
  UPDATE hosted_provider_runtime_control
  SET query_admission_suspended = false,
      suspension_reason = NULL,
      admission_lease_expires_at = clock_timestamp() + make_interval(secs => lease_seconds),
      updated_at = now()
  WHERE singleton = true
    AND query_admission_suspended = true
    AND admission_fence_token = requested_token
    AND admission_fence_kind = 'cutover';
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 1 THEN
    RAISE EXCEPTION
      'hosted_admission_provisional_open_failed: expected exactly one matching cutover fence, updated %',
      affected_rows;
  END IF;
END
$open_provisional_admission$;
COMMIT;

SELECT 'hosted_query_admission_provisionally_open' AS result,
       admission_lease_expires_at AS expires_at
FROM hosted_provider_runtime_control
WHERE singleton = true;
