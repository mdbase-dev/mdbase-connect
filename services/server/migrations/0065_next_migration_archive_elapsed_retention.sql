-- New admissions use an exact elapsed capture/retention budget. Historical
-- receipts remain immutable: NOT VALID deliberately does not relabel or rewrite
-- existing rows. Structural timing validity is not archive/provider authority.
-- mdbase:next-migration-archive-elapsed:v1
CREATE FUNCTION next_migration_archive_elapsed_valid(result jsonb, accepted timestamptz, trusted_now timestamptz)
RETURNS boolean LANGUAGE plpgsql STABLE STRICT AS $$
DECLARE
  started timestamptz;
  completed timestamptz;
  expiry timestamptz;
  value text;
BEGIN
  IF jsonb_typeof(result) IS DISTINCT FROM 'object'
     OR result->>'schema' IS DISTINCT FROM 'mdbase-recovery-set/v4'
     OR result#>>'{retention,mode}' IS DISTINCT FROM 'GOVERNANCE'
     OR result#>'{retention,days}' IS DISTINCT FROM '116'::jsonb
     OR NOT isfinite(accepted) OR NOT isfinite(trusted_now)
     OR extract(epoch FROM accepted)*1000 <> trunc(extract(epoch FROM accepted)*1000)
     OR extract(epoch FROM trusted_now)*1000 <> trunc(extract(epoch FROM trusted_now)*1000) THEN
    RETURN false;
  END IF;
  FOREACH value IN ARRAY ARRAY[result->>'archive_created_at',result->>'archive_completed_at',result#>>'{retention,retain_until}'] LOOP
    IF value IS NULL OR value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
       OR left(value,4) = '0000' THEN RETURN false; END IF;
    -- Parsing can otherwise normalize invalid leap-day/time fields. Round-trip
    -- in UTC, never the session's calendar or daylight-saving offset.
    IF to_char(value::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> value THEN RETURN false; END IF;
  END LOOP;
  started := (result->>'archive_created_at')::timestamptz;
  completed := (result->>'archive_completed_at')::timestamptz;
  expiry := (result#>>'{retention,retain_until}')::timestamptz;
  RETURN started <= completed AND completed <= started + interval '86400 seconds'
     AND completed <= accepted AND accepted <= trusted_now
     AND expiry = completed + interval '10022400 seconds';
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_parameter_value THEN
  RETURN false;
END $$;
ALTER TABLE next_migration_archive_acceptances
  ADD CONSTRAINT next_migration_archive_elapsed_retention
  CHECK (next_migration_archive_elapsed_valid(verified_result,accepted_at,date_trunc('milliseconds',clock_timestamp())) IS TRUE)
  NOT VALID;
