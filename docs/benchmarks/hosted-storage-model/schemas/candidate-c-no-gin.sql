CREATE SCHEMA candidate_c_no_gin;

CREATE TABLE candidate_c_no_gin.collections (
  collection_id uuid PRIMARY KEY,
  active_catalog_revision text NOT NULL,
  active_projection_format_version integer NOT NULL CHECK (active_projection_format_version > 0),
  active_generation_id uuid NOT NULL,
  resources_document jsonb NOT NULL,
  head bigint NOT NULL DEFAULT 0 CHECK (head >= 0),
  record_count bigint NOT NULL DEFAULT 0 CHECK (record_count >= 0),
  content_bytes bigint NOT NULL DEFAULT 0 CHECK (content_bytes >= 0)
);

CREATE TABLE candidate_c_no_gin.projection_generations (
  collection_id uuid NOT NULL REFERENCES candidate_c_no_gin.collections(collection_id) ON DELETE CASCADE,
  generation_id uuid NOT NULL,
  target_catalog_revision text NOT NULL,
  projection_format_version integer NOT NULL CHECK (projection_format_version > 0),
  status text NOT NULL CHECK (status IN ('building', 'complete', 'abandoned')),
  source_head bigint NOT NULL CHECK (source_head >= 0),
  checkpoint_record_id uuid,
  lease_owner uuid,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code text,
  last_error_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (collection_id, generation_id),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK ((status = 'complete') = (completed_at IS NOT NULL)),
  CHECK (status = 'building' OR lease_owner IS NULL)
);

ALTER TABLE candidate_c_no_gin.collections ADD CONSTRAINT collections_active_generation_fk
  FOREIGN KEY (collection_id, active_generation_id)
  REFERENCES candidate_c_no_gin.projection_generations(collection_id, generation_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE candidate_c_no_gin.records (
  collection_id uuid NOT NULL REFERENCES candidate_c_no_gin.collections(collection_id) ON DELETE CASCADE,
  record_id uuid NOT NULL,
  path text NOT NULL,
  record_revision text NOT NULL,
  content_bytes bigint NOT NULL CHECK (content_bytes >= 0),
  exact_markdown text NOT NULL,
  file_mtime timestamptz NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (collection_id, record_id),
  UNIQUE (collection_id, path)
);

CREATE TABLE candidate_c_no_gin.record_projections (
  collection_id uuid NOT NULL,
  record_id uuid NOT NULL,
  record_revision text NOT NULL,
  catalog_revision text NOT NULL,
  projection_format_version integer NOT NULL CHECK (projection_format_version > 0),
  generation_id uuid NOT NULL,
  path text NOT NULL,
  types text[] NOT NULL,
  file_size bigint NOT NULL CHECK (file_size >= 0),
  file_mtime timestamptz NOT NULL,
  semantic_projection jsonb NOT NULL,
  projection_digest text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (collection_id, record_id),
  FOREIGN KEY (collection_id, record_id)
    REFERENCES candidate_c_no_gin.records(collection_id, record_id) ON DELETE CASCADE,
  FOREIGN KEY (collection_id, generation_id)
    REFERENCES candidate_c_no_gin.projection_generations(collection_id, generation_id)
);

CREATE TABLE candidate_c_no_gin.record_versions (
  collection_id uuid NOT NULL REFERENCES candidate_c_no_gin.collections(collection_id) ON DELETE CASCADE,
  record_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  record_revision text NOT NULL,
  path text,
  exact_markdown text,
  projection jsonb,
  deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (collection_id, record_id, sequence),
  CHECK (deleted = (exact_markdown IS NULL))
);

CREATE TABLE candidate_c_no_gin.changes (
  collection_id uuid NOT NULL REFERENCES candidate_c_no_gin.collections(collection_id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence > 0),
  record_id uuid NOT NULL,
  before_record jsonb,
  after_record jsonb,
  record_revision text NOT NULL,
  PRIMARY KEY (collection_id, sequence)
);

-- Indexed columns are only primary/foreign identity constraints and
-- records(collection_id, path). Projection JSON has no index.
