-- The all-zero digest is an application instruction to bind the canonical row
-- digest in the observer trigger. Require the production projection writer to
-- opt into that instruction transaction-locally. Ordinary SQL edits continue
-- to invalidate the expected/observed pair, and an accidental zero-marker
-- write can no longer bless arbitrary projection changes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION hosted_provider_observe_projection_digest()
RETURNS trigger
LANGUAGE plpgsql
AS $hosted_provider_observe_projection_digest$
BEGIN
  NEW.projection_observed_digest := hosted_provider_projection_digest(NEW);
  IF NEW.projection_digest = decode(repeat('00', 32), 'hex') THEN
    IF COALESCE(
         current_setting('mdbase.projection_digest_write', true), ''
       ) <> 'on' THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'projection digest marker requires the trusted projection write path';
    END IF;
    NEW.projection_digest := NEW.projection_observed_digest;
  END IF;
  RETURN NEW;
END
$hosted_provider_observe_projection_digest$;
