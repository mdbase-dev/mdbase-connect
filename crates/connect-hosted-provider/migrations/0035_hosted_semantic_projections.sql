-- Final Candidate B projection/relationship model for the production beta.69
-- cutover. Exact encrypted tables remain untouched. Existing active collections
-- begin unbound and are indexed before the new runtime is admitted; there is no
-- durable legacy execution mode.
ALTER TABLE hosted_provider_collections
  DROP CONSTRAINT hosted_provider_collections_state_check;

ALTER TABLE hosted_provider_collections
  ADD CONSTRAINT hosted_provider_collections_state_check CHECK (
    state IN (
      'active', 'indexing', 'importing', 'transferring', 'transferred', 'deleting'
    )
  );

ALTER TABLE hosted_provider_authority_imports
  DROP CONSTRAINT hosted_provider_authority_imports_state_check;

ALTER TABLE hosted_provider_authority_imports
  ADD CONSTRAINT hosted_provider_authority_imports_state_check CHECK (
    state IN ('receiving', 'uploaded', 'indexing', 'completed', 'aborted')
  );

ALTER TABLE hosted_provider_collections
  ADD COLUMN active_catalog_revision text,
  ADD COLUMN active_projection_format_version integer,
  ADD COLUMN active_semantic_engine_version text,
  ADD COLUMN active_projection_generation_id uuid,
  ADD COLUMN active_projection_head bigint CHECK (active_projection_head >= 0),
  ADD CONSTRAINT hosted_provider_collections_projection_binding_check CHECK (
    (
      active_catalog_revision IS NULL
      AND active_projection_format_version IS NULL
      AND active_semantic_engine_version IS NULL
      AND active_projection_generation_id IS NULL
      AND active_projection_head IS NULL
    ) OR (
      active_catalog_revision IS NOT NULL
      AND active_projection_format_version > 0
      AND active_semantic_engine_version IS NOT NULL
      AND active_projection_generation_id IS NOT NULL
      AND active_projection_head IS NOT NULL
    )
  );

CREATE TABLE hosted_provider_projection_generations (
  collection_id uuid NOT NULL
    REFERENCES hosted_provider_collections(id) ON DELETE CASCADE,
  generation_id uuid NOT NULL,
  target_catalog_revision text NOT NULL,
  projection_format_version integer NOT NULL
    CHECK (projection_format_version > 0),
  semantic_engine_version text NOT NULL,
  source_resource_revision text NOT NULL
    CHECK (length(source_resource_revision) BETWEEN 1 AND 1024),
  source_head bigint NOT NULL CHECK (source_head >= 0),
  phase text NOT NULL DEFAULT 'projection'
    CHECK (phase IN ('projection', 'resolution')),
  status text NOT NULL DEFAULT 'building'
    CHECK (status IN ('building', 'complete', 'abandoned')),
  checkpoint_record_id uuid,
  projected_records bigint NOT NULL DEFAULT 0 CHECK (projected_records >= 0),
  resolved_records bigint NOT NULL DEFAULT 0 CHECK (resolved_records >= 0),
  lease_owner uuid,
  lease_expires_at timestamptz,
  lease_fencing_generation bigint NOT NULL DEFAULT 0
    CHECK (lease_fencing_generation >= 0),
  integrity_epoch bigint NOT NULL DEFAULT 1 CHECK (integrity_epoch > 0),
  integrity_verified_epoch bigint NOT NULL DEFAULT 0
    CHECK (integrity_verified_epoch >= 0)
    CHECK (integrity_verified_epoch <= integrity_epoch),
  last_error_code text CHECK (
    last_error_code IS NULL OR (
      length(last_error_code) BETWEEN 1 AND 128
      AND last_error_code ~ '^[a-z0-9_]+$'
    )
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  abandoned_at timestamptz,
  PRIMARY KEY (collection_id, generation_id),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK (
    (status = 'building' AND completed_at IS NULL AND abandoned_at IS NULL)
    OR (status = 'complete' AND completed_at IS NOT NULL AND abandoned_at IS NULL)
    OR (status = 'abandoned' AND completed_at IS NULL AND abandoned_at IS NOT NULL)
  ),
  CHECK (status <> 'complete' OR phase = 'resolution')
);

ALTER TABLE hosted_provider_collections
  ADD CONSTRAINT hosted_provider_collections_active_projection_generation_fk
  FOREIGN KEY (id, active_projection_generation_id)
  REFERENCES hosted_provider_projection_generations (collection_id, generation_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX hosted_provider_collections_projection_backfill_idx
  ON hosted_provider_collections (updated_at, id)
  WHERE state = 'active' AND active_projection_generation_id IS NULL;

CREATE INDEX hosted_provider_projection_generation_work_idx
  ON hosted_provider_projection_generations (
    status,
    lease_expires_at,
    collection_id,
    generation_id
  )
  WHERE status = 'building';

CREATE TABLE hosted_provider_record_projections (
  collection_id uuid NOT NULL
    REFERENCES hosted_provider_collections(id) ON DELETE CASCADE,
  record_id uuid NOT NULL,
  record_sequence bigint NOT NULL CHECK (record_sequence > 0),
  valid_from_sequence bigint NOT NULL CHECK (valid_from_sequence >= 0),
  valid_to_sequence bigint CHECK (
    valid_to_sequence IS NULL OR valid_to_sequence > valid_from_sequence
  ),
  record_revision text NOT NULL,
  catalog_revision text NOT NULL,
  projection_format_version integer NOT NULL
    CHECK (projection_format_version > 0),
  semantic_engine_version text NOT NULL,
  generation_id uuid NOT NULL,
  canonical_path text COLLATE "C" NOT NULL,
  matched_types text[] NOT NULL DEFAULT '{}',
  file_size_bytes bigint NOT NULL CHECK (file_size_bytes >= 0),
  file_modified_at timestamptz,
  semantic_complete boolean NOT NULL,
  resolution_complete boolean NOT NULL,
  semantic_projection jsonb NOT NULL
    CHECK (jsonb_typeof(semantic_projection) = 'object'),
  projection_digest bytea NOT NULL CHECK (octet_length(projection_digest) = 32),
  projection_observed_digest bytea NOT NULL
    CHECK (octet_length(projection_observed_digest) = 32),
  structural_digest bytea NOT NULL CHECK (octet_length(structural_digest) = 32),
  projection_bytes integer NOT NULL
    CHECK (projection_bytes >= 0 AND projection_bytes <= 262144),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, generation_id, record_id, valid_from_sequence),
  FOREIGN KEY (collection_id, generation_id)
    REFERENCES hosted_provider_projection_generations (collection_id, generation_id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (resolution_complete OR NOT semantic_complete)
);

CREATE UNIQUE INDEX hosted_provider_record_projections_current_record_idx
  ON hosted_provider_record_projections (collection_id, generation_id, record_id)
  WHERE valid_to_sequence IS NULL;

CREATE UNIQUE INDEX hosted_provider_record_projections_current_path_idx
  ON hosted_provider_record_projections (
    collection_id,
    generation_id,
    canonical_path COLLATE "C"
  )
  WHERE valid_to_sequence IS NULL;

-- Completion proof, stale/absent unioning, and UUID-keyset rebuild all begin with
-- the active generation. No general JSONB GIN is created.
CREATE INDEX hosted_provider_record_projections_generation_idx
  ON hosted_provider_record_projections (
    collection_id,
    generation_id,
    valid_to_sequence,
    record_id
  );

CREATE INDEX hosted_provider_record_projections_snapshot_path_cursor_idx
  ON hosted_provider_record_projections (
    collection_id,
    generation_id,
    canonical_path COLLATE "C",
    record_id,
    valid_from_sequence,
    valid_to_sequence
  );

-- The Editor's measured broad listing orders by mtime descending. This is the
-- sole non-path projection ordering index in the initial physical design.
CREATE INDEX hosted_provider_record_projections_snapshot_mtime_cursor_idx
  ON hosted_provider_record_projections (
    collection_id,
    generation_id,
    file_modified_at DESC NULLS FIRST,
    canonical_path COLLATE "C" ASC,
    record_id ASC,
    valid_from_sequence,
    valid_to_sequence
  );

-- mdbase-rs emits the complete closed key set used by link resolution. SQL may
-- look up these exact keys, but it does not invent basename, ID, or title rules.
CREATE TABLE hosted_provider_record_resolution_keys (
  collection_id uuid NOT NULL
    REFERENCES hosted_provider_collections(id) ON DELETE CASCADE,
  record_id uuid NOT NULL,
  key_kind text NOT NULL CHECK (key_kind IN ('path', 'basename', 'id', 'title')),
  lookup_key text COLLATE "C" NOT NULL,
  record_revision text NOT NULL,
  record_sequence bigint NOT NULL CHECK (record_sequence > 0),
  catalog_revision text NOT NULL,
  projection_format_version integer NOT NULL
    CHECK (projection_format_version > 0),
  semantic_engine_version text NOT NULL,
  generation_id uuid NOT NULL,
  valid_from_sequence bigint NOT NULL CHECK (valid_from_sequence >= 0),
  valid_to_sequence bigint CHECK (
    valid_to_sequence IS NULL OR valid_to_sequence > valid_from_sequence
  ),
  PRIMARY KEY (
    collection_id,
    generation_id,
    record_id,
    key_kind,
    lookup_key,
    valid_from_sequence
  ),
  FOREIGN KEY (collection_id, generation_id)
    REFERENCES hosted_provider_projection_generations (collection_id, generation_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX hosted_provider_record_resolution_keys_lookup_idx
  ON hosted_provider_record_resolution_keys (
    collection_id,
    generation_id,
    key_kind,
    lookup_key COLLATE "C",
    valid_from_sequence,
    valid_to_sequence,
    record_id
  );

CREATE UNIQUE INDEX hosted_provider_record_resolution_keys_current_idx
  ON hosted_provider_record_resolution_keys (
    collection_id,
    generation_id,
    record_id,
    key_kind,
    lookup_key COLLATE "C"
  )
  WHERE valid_to_sequence IS NULL;

CREATE TABLE hosted_provider_record_relationships (
  collection_id uuid NOT NULL
    REFERENCES hosted_provider_collections(id) ON DELETE CASCADE,
  source_record_id uuid NOT NULL,
  occurrence_key bytea NOT NULL CHECK (octet_length(occurrence_key) = 32),
  valid_from_sequence bigint NOT NULL CHECK (valid_from_sequence >= 0),
  valid_to_sequence bigint CHECK (
    valid_to_sequence IS NULL OR valid_to_sequence > valid_from_sequence
  ),
  source_record_revision text NOT NULL,
  source_record_sequence bigint NOT NULL CHECK (source_record_sequence > 0),
  catalog_revision text NOT NULL,
  projection_format_version integer NOT NULL
    CHECK (projection_format_version > 0),
  semantic_engine_version text NOT NULL,
  generation_id uuid NOT NULL,
  relationship_kind text NOT NULL CHECK (
    relationship_kind IN (
      'wikilink',
      'markdown_link',
      'embed',
      'frontmatter_link'
    )
  ),
  source_field text,
  raw_target text NOT NULL,
  normalized_target text NOT NULL,
  alias text,
  anchor text,
  is_relative boolean NOT NULL,
  resolution_state text NOT NULL CHECK (
    resolution_state IN (
      'resolved',
      'missing',
      'ambiguous',
      'external',
      'unsafe'
    )
  ),
  target_record_id uuid,
  target_path text COLLATE "C",
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (
    collection_id,
    generation_id,
    source_record_id,
    occurrence_key,
    valid_from_sequence
  ),
  FOREIGN KEY (collection_id, generation_id)
    REFERENCES hosted_provider_projection_generations (collection_id, generation_id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (
    (resolution_state = 'resolved' AND target_record_id IS NOT NULL AND target_path IS NOT NULL)
    OR (resolution_state <> 'resolved' AND target_record_id IS NULL)
  )
);

-- The source index is provided by the primary key. These two indexes support
-- bounded inverse backlinks and unresolved-target re-resolution respectively.
CREATE INDEX hosted_provider_record_relationships_target_idx
  ON hosted_provider_record_relationships (
    collection_id,
    generation_id,
    target_record_id,
    relationship_kind,
    valid_from_sequence,
    valid_to_sequence,
    source_record_id
  )
  WHERE target_record_id IS NOT NULL;

CREATE INDEX hosted_provider_record_relationships_unresolved_idx
  ON hosted_provider_record_relationships (
    collection_id,
    generation_id,
    normalized_target COLLATE "C",
    valid_from_sequence,
    valid_to_sequence,
    source_record_id
  )
  WHERE target_record_id IS NULL
    AND resolution_state IN ('missing', 'ambiguous');

CREATE UNIQUE INDEX hosted_provider_record_relationships_current_idx
  ON hosted_provider_record_relationships (
    collection_id,
    generation_id,
    source_record_id,
    occurrence_key
  )
  WHERE valid_to_sequence IS NULL;

-- Database-owned observed digests detect provider-readable row corruption. The
-- expected digest is application-authored only through a transaction-local
-- trusted marker. This is an unkeyed consistency envelope, not authenticity.
CREATE FUNCTION hosted_provider_projection_digest(
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

CREATE FUNCTION hosted_provider_projection_digest_valid(
  expected_digest bytea,
  observed_digest bytea
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURN coalesce(expected_digest = observed_digest, false);

CREATE FUNCTION hosted_provider_observe_projection_digest()
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

CREATE TRIGGER hosted_provider_record_projection_digest_observer
BEFORE INSERT OR UPDATE ON hosted_provider_record_projections
FOR EACH ROW
EXECUTE FUNCTION hosted_provider_observe_projection_digest();

-- Statement-level epochs invalidate projected reduction proofs if a complete
-- generation changes outside its verified ordinary-write transaction.
CREATE FUNCTION hosted_provider_bump_projection_epoch_after_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $hosted_provider_bump_projection_epoch_after_insert$
BEGIN
  UPDATE hosted_provider_projection_generations generation
  SET integrity_epoch = generation.integrity_epoch + 1
  FROM (
    SELECT DISTINCT collection_id, generation_id FROM new_projection_rows
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
    SELECT DISTINCT collection_id, generation_id FROM old_projection_rows
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

-- Resolution keys and relationship edges are part of the same derived
-- generation contract as their projection row. Any out-of-band change to a
-- complete generation invalidates its verified epoch until the canonical
-- writer or the index verifier proves the whole generation again.
CREATE TRIGGER hosted_provider_resolution_key_epoch_after_insert
AFTER INSERT ON hosted_provider_record_resolution_keys
REFERENCING NEW TABLE AS new_projection_rows
FOR EACH STATEMENT
EXECUTE FUNCTION hosted_provider_bump_projection_epoch_after_insert();

CREATE TRIGGER hosted_provider_resolution_key_epoch_after_update
AFTER UPDATE ON hosted_provider_record_resolution_keys
REFERENCING OLD TABLE AS old_projection_rows NEW TABLE AS new_projection_rows
FOR EACH STATEMENT
EXECUTE FUNCTION hosted_provider_bump_projection_epoch_after_update();

CREATE TRIGGER hosted_provider_resolution_key_epoch_after_delete
AFTER DELETE ON hosted_provider_record_resolution_keys
REFERENCING OLD TABLE AS old_projection_rows
FOR EACH STATEMENT
EXECUTE FUNCTION hosted_provider_bump_projection_epoch_after_delete();

CREATE TRIGGER hosted_provider_relationship_epoch_after_insert
AFTER INSERT ON hosted_provider_record_relationships
REFERENCING NEW TABLE AS new_projection_rows
FOR EACH STATEMENT
EXECUTE FUNCTION hosted_provider_bump_projection_epoch_after_insert();

CREATE TRIGGER hosted_provider_relationship_epoch_after_update
AFTER UPDATE ON hosted_provider_record_relationships
REFERENCING OLD TABLE AS old_projection_rows NEW TABLE AS new_projection_rows
FOR EACH STATEMENT
EXECUTE FUNCTION hosted_provider_bump_projection_epoch_after_update();

CREATE TRIGGER hosted_provider_relationship_epoch_after_delete
AFTER DELETE ON hosted_provider_record_relationships
REFERENCING OLD TABLE AS old_projection_rows
FOR EACH STATEMENT
EXECUTE FUNCTION hosted_provider_bump_projection_epoch_after_delete();
