-- Named scoped zero-hosted archive: two genuine encrypted inventory/provenance
-- artifacts, never omitted hosted payloads or a three-database restore claim.
-- Existing immutable receipts and historical migration bytes are unchanged.
-- mdbase:next-migration-archive-elapsed:v1
-- pg-mem remains schema-only; only real PostgreSQL qualifies these guards.
ALTER TABLE next_migration_archive_acceptances
  DROP CONSTRAINT next_migration_archive_acceptances_verified_result_check;
ALTER TABLE next_migration_archive_acceptances
  ADD CONSTRAINT next_migration_archive_acceptances_verified_result_check
  CHECK ((verified_result->>'schema' = 'mdbase-recovery-set/v4'
    OR (verified_result->>'schema' = 'mdbase-recovery-set/lab-cohort-v1'
        AND verified_result->>'environment' = 'lab'
        AND jsonb_typeof(verified_result->'runtime_provenance') = 'object')
    OR (verified_result->>'schema' = 'mdbase-recovery-set/zero-hosted-v1'
        AND verified_result->>'environment' IN ('lab','staging')
        AND verified_result#>'{retention,count}' = '"2"'::jsonb)) IS TRUE)
  NOT VALID;

-- Extend the SAME exact elapsed-time validator; do not rewrite old receipts,
-- loosen existing profiles, or replace the immutable acceptance trigger.
CREATE OR REPLACE FUNCTION next_migration_archive_elapsed_valid(result jsonb, accepted timestamptz, trusted_now timestamptz)
RETURNS boolean LANGUAGE plpgsql STABLE STRICT AS $$
DECLARE
  started timestamptz;
  completed timestamptz;
  expiry timestamptz;
  value text;
  provenance jsonb;
BEGIN
  IF jsonb_typeof(result) IS DISTINCT FROM 'object'
     OR (result->>'schema' IS DISTINCT FROM 'mdbase-recovery-set/v4'
         AND result->>'schema' IS DISTINCT FROM 'mdbase-recovery-set/lab-cohort-v1'
         AND result->>'schema' IS DISTINCT FROM 'mdbase-recovery-set/zero-hosted-v1')
     OR result#>>'{retention,mode}' IS DISTINCT FROM 'GOVERNANCE'
     OR result#>'{retention,days}' IS DISTINCT FROM '116'::jsonb
     OR NOT isfinite(accepted) OR NOT isfinite(trusted_now)
     OR extract(epoch FROM accepted)*1000 <> trunc(extract(epoch FROM accepted)*1000)
     OR extract(epoch FROM trusted_now)*1000 <> trunc(extract(epoch FROM trusted_now)*1000) THEN
    RETURN false;
  END IF;
  IF result->>'schema' = 'mdbase-recovery-set/lab-cohort-v1' THEN
    provenance := result->'runtime_provenance';
    IF result->>'environment' IS DISTINCT FROM 'lab'
       OR jsonb_typeof(provenance) IS DISTINCT FROM 'object'
       OR NOT provenance ?& ARRAY['connect','hosted_provider','relay','mcp']
       OR provenance - ARRAY['connect','hosted_provider','relay','mcp'] <> '{}'::jsonb THEN
      RETURN false;
    END IF;
  END IF;
  IF result->>'schema' = 'mdbase-recovery-set/zero-hosted-v1' THEN
    IF (result->>'environment' IN ('lab','staging')) IS NOT TRUE
       OR result#>'{retention,count}' IS DISTINCT FROM '"2"'::jsonb THEN
      RETURN false;
    END IF;
  END IF;
  FOREACH value IN ARRAY ARRAY[result->>'archive_created_at',result->>'archive_completed_at',result#>>'{retention,retain_until}'] LOOP
    IF value IS NULL OR value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
       OR left(value,4) = '0000' THEN RETURN false; END IF;
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
