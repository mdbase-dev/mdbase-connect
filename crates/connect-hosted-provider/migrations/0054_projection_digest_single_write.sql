-- Candidate B writes use an all-zero expected digest as an explicit
-- application marker. Bind that marker to the database-canonical row digest in
-- the same tuple version. Unmarked SQL changes continue to update only the
-- observed side and therefore invalidate the row. This avoids one UPDATE, one
-- dead tuple, and its WAL for every imported or ordinarily written projection.
CREATE OR REPLACE FUNCTION hosted_provider_observe_projection_digest()
RETURNS trigger
LANGUAGE plpgsql
AS $hosted_provider_observe_projection_digest$
BEGIN
  NEW.projection_observed_digest := hosted_provider_projection_digest(NEW);
  IF NEW.projection_digest = decode(repeat('00', 32), 'hex') THEN
    NEW.projection_digest := NEW.projection_observed_digest;
  END IF;
  RETURN NEW;
END
$hosted_provider_observe_projection_digest$;

