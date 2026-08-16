-- Candidate B is additive and opt-in. Existing collections keep all semantic
-- fields NULL and continue to use the encrypted exact authority until an explicit
-- activation transaction creates and binds a projection generation.
ALTER TABLE hosted_provider_collections
  ADD COLUMN active_catalog_revision text,
  ADD COLUMN active_projection_format_version integer,
  ADD COLUMN active_semantic_engine_version text,
  ADD COLUMN active_projection_generation_id uuid,
  ADD CONSTRAINT hosted_provider_collections_projection_binding_check CHECK (
    (
      active_catalog_revision IS NULL
      AND active_projection_format_version IS NULL
      AND active_semantic_engine_version IS NULL
      AND active_projection_generation_id IS NULL
    ) OR (
      active_catalog_revision IS NOT NULL
      AND active_projection_format_version > 0
      AND active_semantic_engine_version IS NOT NULL
      AND active_projection_generation_id IS NOT NULL
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

CREATE INDEX hosted_provider_record_projections_path_cursor_idx
  ON hosted_provider_record_projections (
    collection_id,
    generation_id,
    canonical_path COLLATE "C",
    valid_from_sequence,
    valid_to_sequence,
    record_id
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

-- Query cursors retain only a closed mdbase-rs plan and a keyset boundary.
-- Projection history pins the logical collection head, so no PostgreSQL
-- transaction or exported MVCC snapshot survives between page requests.
CREATE TABLE hosted_provider_query_cursors (
  cursor_id uuid PRIMARY KEY,
  collection_id uuid NOT NULL
    REFERENCES hosted_provider_collections(id) ON DELETE CASCADE,
  replica_id uuid NOT NULL
    REFERENCES hosted_provider_replicas(id) ON DELETE CASCADE,
  scope_epoch bigint NOT NULL CHECK (scope_epoch > 0),
  snapshot_head bigint NOT NULL CHECK (snapshot_head >= 0),
  generation_id uuid NOT NULL,
  catalog_revision text NOT NULL,
  projection_format_version integer NOT NULL
    CHECK (projection_format_version > 0),
  semantic_engine_version text NOT NULL,
  query_plan_version integer NOT NULL CHECK (query_plan_version > 0),
  query_digest bytea NOT NULL CHECK (octet_length(query_digest) = 32),
  query_plan jsonb NOT NULL CHECK (
    jsonb_typeof(query_plan) = 'object'
    AND pg_column_size(query_plan) <= 262144
  ),
  last_order_values jsonb CHECK (
    last_order_values IS NULL OR jsonb_typeof(last_order_values) = 'array'
  ),
  last_record_id uuid,
  emitted_rows bigint NOT NULL DEFAULT 0 CHECK (emitted_rows >= 0),
  remaining_rows bigint CHECK (remaining_rows IS NULL OR remaining_rows >= 0),
  expires_at timestamptz NOT NULL,
  hard_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (collection_id, generation_id)
    REFERENCES hosted_provider_projection_generations (collection_id, generation_id),
  CHECK (expires_at <= hard_expires_at),
  CHECK ((last_order_values IS NULL) = (last_record_id IS NULL))
);

CREATE INDEX hosted_provider_query_cursors_expiry_idx
  ON hosted_provider_query_cursors (expires_at, cursor_id);

CREATE INDEX hosted_provider_query_cursors_replica_idx
  ON hosted_provider_query_cursors (replica_id, collection_id, cursor_id);
