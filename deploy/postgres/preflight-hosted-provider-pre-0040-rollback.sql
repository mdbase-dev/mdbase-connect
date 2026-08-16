\set ON_ERROR_STOP on

-- A provider binary predating migration 0040 cannot decode Base cursors whose
-- immutable invocation state has moved out of the cursor row. This preflight is
-- intentionally fail-closed: release those cursors through the query API or
-- wait for their one-hour hard expiry and maintenance cleanup, then rerun.
DO $candidate_b_rollback_preflight$
DECLARE
  live_invocation_cursors bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM hosted_provider_runtime_control
    WHERE singleton = true AND query_admission_suspended = true
  ) THEN
    RAISE EXCEPTION
      'candidate_b_pre_0040_rollback_blocked: suspend hosted query admission first';
  END IF;

  SELECT count(*)
    INTO live_invocation_cursors
  FROM hosted_provider_query_cursors
  WHERE request_kind = 'obsidian_base'
    AND base_invocation_id IS NOT NULL
    AND expires_at > now()
    AND hard_expires_at > now();

  IF live_invocation_cursors > 0 THEN
    RAISE EXCEPTION
      'candidate_b_pre_0040_rollback_blocked: % live invocation-backed Base cursor(s); release or drain them before rollback',
      live_invocation_cursors;
  END IF;
END
$candidate_b_rollback_preflight$;

SELECT 'candidate_b_pre_0040_rollback_ready' AS result;
