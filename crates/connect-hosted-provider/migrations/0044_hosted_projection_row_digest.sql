-- Projection integrity is checked inside candidate SQL so a readable row whose
-- payload or authorization envelope was substituted is treated as stale before
-- it can narrow selection. Keep the observed digest separate from the expected
-- application-set digest so ordinary SQL corruption changes only the observed
-- side. The nullable column is an expand-only metadata change; old rows remain
-- invalid until rebuilt rather than forcing a table rewrite in migration.
ALTER TABLE hosted_provider_record_projections
  ADD COLUMN projection_observed_digest bytea
    CHECK (
      projection_observed_digest IS NULL
      OR octet_length(projection_observed_digest) = 32
    );

-- PostgreSQL's canonical jsonb text is the one frozen byte representation for
-- this database-owned, unkeyed corruption check.
CREATE FUNCTION hosted_provider_projection_digest(
  projection_row hosted_provider_record_projections
) RETURNS bytea
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURN sha256(convert_to(jsonb_build_array(
  'mdbase/hosted-projection-row/v1',
  (projection_row).collection_id,
  (projection_row).record_id,
  (projection_row).record_sequence,
  (projection_row).valid_from_sequence,
  (projection_row).record_revision,
  (projection_row).catalog_revision,
  (projection_row).projection_format_version,
  (projection_row).semantic_engine_version,
  (projection_row).generation_id,
  (projection_row).canonical_path,
  (projection_row).matched_types,
  (projection_row).file_size_bytes,
  (projection_row).file_modified_at,
  (projection_row).semantic_complete,
  (projection_row).resolution_complete,
  (projection_row).semantic_projection,
  encode((projection_row).structural_digest, 'hex'),
  (projection_row).projection_bytes
)::text, 'UTF8'));

CREATE FUNCTION hosted_provider_projection_digest_valid(
  expected_digest bytea,
  observed_digest bytea
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURN coalesce(
  expected_digest = observed_digest,
  false
);

CREATE FUNCTION hosted_provider_observe_projection_digest()
RETURNS trigger
LANGUAGE plpgsql
AS $hosted_provider_observe_projection_digest$
BEGIN
  NEW.projection_observed_digest := hosted_provider_projection_digest(NEW);
  RETURN NEW;
END
$hosted_provider_observe_projection_digest$;

CREATE TRIGGER hosted_provider_record_projection_digest_observer
BEFORE INSERT OR UPDATE ON hosted_provider_record_projections
FOR EACH ROW
EXECUTE FUNCTION hosted_provider_observe_projection_digest();

-- Do not rewrite existing projection rows in this expand migration. No
-- production collection is activated on Candidate B before the rollout gate;
-- disposable/staging generations from earlier review builds deliberately fail
-- this corrected envelope and must be rebuilt from exact authority. That keeps
-- migration lock time and WAL independent of projection-table size.
