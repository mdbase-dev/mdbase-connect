-- Timer source identity belongs to the adapter, not the release train.
-- The exact current timer contract first shipped in beta.27. Only its owned
-- beta.27..beta.104 identities are eligible. Unknown sources/contracts remain
-- unchanged and fail normal exact admission; this is not a runtime fallback.
--
-- Preserve generations, schedules, terminal states and all admitted
-- events/runs. Updating terminal timer metadata also prevents reconciliation
-- from treating an already-fired timer as a new generation solely for version.
-- This changes the ledger: predecessor binaries must not be restored on it.
DO $$
BEGIN
  -- Fresh installations have not initialized the optional runtime store yet.
  IF to_regclass('mdbase_runtime_timers') IS NULL THEN
    RETURN;
  END IF;

  -- Exclude new claims and wait for transactions already changing timers.
  -- A committed active claim is not safe to rewrite: stop, do not steal it.
  LOCK TABLE mdbase_runtime_timers IN EXCLUSIVE MODE;
  IF EXISTS (
    SELECT 1 FROM mdbase_runtime_timers
    WHERE namespace LIKE 'connect-hosted:%:notifications'
      AND lease_token IS NOT NULL
      AND (lease_expires_at IS NULL OR lease_expires_at > clock_timestamp())
  ) THEN
    RAISE EXCEPTION 'notification_timer_source_migration_busy' USING ERRCODE = '55P03';
  END IF;

  UPDATE mdbase_runtime_timers
  -- Fence even an expired worker: expiry alone does not stop a late commit.
  SET record_json = jsonb_set(record_json, '{event_source,version}', '"1.0.0"'),
      lease_token = NULL, lease_worker = NULL, lease_expires_at = NULL
  WHERE namespace = 'connect-hosted:' || (record_json #>> '{event_source,instance_id}') || ':notifications'
    AND record_json #>> '{event_source,instance_id}' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND record_json #>> '{event_source,application}' = 'mdbase.connect'
    AND record_json #>> '{event_source,implementation}' = 'notification-timer'
    AND record_json #>> '{event_source,version}' IN (
      SELECT '0.1.0-beta.' || release FROM generate_series(27, 104) AS release
    )
    AND record_json -> 'event_contract' = '{"id":"mdbase.runtime.timer.fired","version":"1.0.0","digest":"sha256:41105be7a7abf33b31ced47e1e1965242236e40ccaea286b959b0a8c591f5642"}'::jsonb
    AND record_json ->> 'source_uri' = 'urn:mdbase:connect:hosted:' || (record_json #>> '{event_source,instance_id}')
    AND record_json ->> 'subject' = record_json #>> '{event_source,instance_id}';

  -- A rolling predecessor may still accept a timer request after this commits.
  -- Refuse reintroduction of retired release identities rather than allowing
  -- that request to strand a timer or reschedule an already-fired generation.
  -- NOT VALID leaves unknown/pre-contract historical records untouched; their
  -- ordinary exact admission still fails. It never blesses an unknown source.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'mdbase_runtime_timers'::regclass
      AND conname = 'hosted_notification_timer_release_source_retired') THEN
    ALTER TABLE mdbase_runtime_timers ADD CONSTRAINT hosted_notification_timer_release_source_retired
    CHECK (NOT (
      namespace LIKE 'connect-hosted:%:notifications'
      AND record_json #>> '{event_source,application}' = 'mdbase.connect'
      AND record_json #>> '{event_source,implementation}' = 'notification-timer'
      AND record_json #>> '{event_source,version}' ~ '^0[.]1[.]0-beta[.](2[7-9]|[3-9][0-9]|10[0-4])$'
    )) NOT VALID;
  END IF;
END
$$;
