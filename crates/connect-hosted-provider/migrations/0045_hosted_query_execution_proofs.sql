-- Projected query count/group proofs may be reused only while the exact
-- generation rows they summarize remain unchanged. Building generations do
-- not serve queries, so statement-level triggers advance the epoch only after
-- a generation is complete. This avoids per-row rebuild contention while
-- still detecting ordinary writes and direct row tampering.
ALTER TABLE hosted_provider_projection_generations
  ADD COLUMN integrity_epoch bigint NOT NULL DEFAULT 1
    CHECK (integrity_epoch > 0);

CREATE FUNCTION hosted_provider_bump_projection_epoch_after_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $hosted_provider_bump_projection_epoch_after_insert$
BEGIN
  UPDATE hosted_provider_projection_generations generation
  SET integrity_epoch = generation.integrity_epoch + 1
  FROM (
    SELECT DISTINCT collection_id, generation_id
    FROM new_projection_rows
  ) changed
  WHERE generation.collection_id = changed.collection_id
    AND generation.generation_id = changed.generation_id
    AND generation.status = 'complete';
  RETURN NULL;
END
$hosted_provider_bump_projection_epoch_after_insert$;

CREATE FUNCTION hosted_provider_bump_projection_epoch_after_update()
RETURNS trigger
LANGUAGE plpgsql
AS $hosted_provider_bump_projection_epoch_after_update$
BEGIN
  UPDATE hosted_provider_projection_generations generation
  SET integrity_epoch = generation.integrity_epoch + 1
  FROM (
    SELECT collection_id, generation_id FROM old_projection_rows
    UNION
    SELECT collection_id, generation_id FROM new_projection_rows
  ) changed
  WHERE generation.collection_id = changed.collection_id
    AND generation.generation_id = changed.generation_id
    AND generation.status = 'complete';
  RETURN NULL;
END
$hosted_provider_bump_projection_epoch_after_update$;

CREATE FUNCTION hosted_provider_bump_projection_epoch_after_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $hosted_provider_bump_projection_epoch_after_delete$
BEGIN
  UPDATE hosted_provider_projection_generations generation
  SET integrity_epoch = generation.integrity_epoch + 1
  FROM (
    SELECT DISTINCT collection_id, generation_id
    FROM old_projection_rows
  ) changed
  WHERE generation.collection_id = changed.collection_id
    AND generation.generation_id = changed.generation_id
    AND generation.status = 'complete';
  RETURN NULL;
END
$hosted_provider_bump_projection_epoch_after_delete$;

CREATE TRIGGER hosted_provider_projection_epoch_after_insert
AFTER INSERT ON hosted_provider_record_projections
REFERENCING NEW TABLE AS new_projection_rows
FOR EACH STATEMENT
EXECUTE FUNCTION hosted_provider_bump_projection_epoch_after_insert();

CREATE TRIGGER hosted_provider_projection_epoch_after_update
AFTER UPDATE ON hosted_provider_record_projections
REFERENCING OLD TABLE AS old_projection_rows NEW TABLE AS new_projection_rows
FOR EACH STATEMENT
EXECUTE FUNCTION hosted_provider_bump_projection_epoch_after_update();

CREATE TRIGGER hosted_provider_projection_epoch_after_delete
AFTER DELETE ON hosted_provider_record_projections
REFERENCING OLD TABLE AS old_projection_rows
FOR EACH STATEMENT
EXECUTE FUNCTION hosted_provider_bump_projection_epoch_after_delete();

-- Existing cursors cannot safely infer a proof. Version zero remains readable
-- only long enough to return a typed upgrade conflict; all new cursors use an
-- encrypted v1 proof bound to their opaque cursor identity and capability.
ALTER TABLE hosted_provider_query_cursors
  ADD COLUMN execution_proof_version integer NOT NULL DEFAULT 0
    CHECK (execution_proof_version IN (0, 1)),
  ADD COLUMN execution_proof_ciphertext bytea,
  ADD COLUMN execution_proof_bytes bigint NOT NULL DEFAULT 0
    CHECK (execution_proof_bytes >= 0 AND execution_proof_bytes <= 67108864),
  ADD COLUMN snapshot_record_count bigint NOT NULL DEFAULT 0
    CHECK (snapshot_record_count >= 0),
  ADD COLUMN scan_budget_records bigint NOT NULL DEFAULT 0
    CHECK (scan_budget_records >= 0),
  ADD COLUMN projection_integrity_epoch bigint
    CHECK (projection_integrity_epoch IS NULL OR projection_integrity_epoch > 0),
  ADD COLUMN cursor_bytes bigint NOT NULL DEFAULT 0
    CHECK (cursor_bytes >= 0 AND cursor_bytes <= 67108864),
  ADD CONSTRAINT hosted_provider_query_cursors_execution_proof_check CHECK (
    (
      execution_proof_version = 0
      AND execution_proof_ciphertext IS NULL
      AND execution_proof_bytes = 0
      AND projection_integrity_epoch IS NULL
    ) OR (
      execution_proof_version = 1
      AND execution_proof_ciphertext IS NOT NULL
      AND execution_proof_bytes = octet_length(execution_proof_ciphertext)
      AND execution_proof_bytes > 0
    )
  );
