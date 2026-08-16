-- The row-integrity envelope must bind the temporal end as well as the start;
-- otherwise a readable-store mutation can widen or narrow which snapshot sees
-- a projection without invalidating the row. Candidate B is not production-
-- active before this migration. Refuse an in-place prototype upgrade so no v1
-- row can silently retain the weaker envelope; disposable generations must be
-- rebuilt from encrypted exact authority first.
DO $hosted_provider_projection_temporal_digest_preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM hosted_provider_record_projections LIMIT 1) THEN
    RAISE EXCEPTION 'candidate_b_projection_rows_require_rebuild_before_temporal_digest'
      USING HINT = 'Remove only disposable Candidate B generations, apply the migration, then rebuild from encrypted exact authority.';
  END IF;
END
$hosted_provider_projection_temporal_digest_preflight$;

CREATE OR REPLACE FUNCTION hosted_provider_projection_digest(
  projection_row hosted_provider_record_projections
) RETURNS bytea
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURN sha256(convert_to(jsonb_build_array(
  'mdbase/hosted-projection-row/v2',
  (projection_row).collection_id,
  (projection_row).record_id,
  (projection_row).record_sequence,
  (projection_row).valid_from_sequence,
  (projection_row).valid_to_sequence,
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
