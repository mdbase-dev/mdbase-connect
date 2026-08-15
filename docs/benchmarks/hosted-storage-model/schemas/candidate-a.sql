CREATE SCHEMA candidate_a;

CREATE TABLE candidate_a.collections (
  collection_id uuid PRIMARY KEY,
  active_catalog_revision text NOT NULL,
  resources_ciphertext bytea NOT NULL,
  wrapped_data_key bytea NOT NULL,
  head bigint NOT NULL DEFAULT 0 CHECK (head >= 0),
  record_count bigint NOT NULL DEFAULT 0 CHECK (record_count >= 0),
  content_bytes bigint NOT NULL DEFAULT 0 CHECK (content_bytes >= 0)
);

CREATE TABLE candidate_a.records (
  collection_id uuid NOT NULL REFERENCES candidate_a.collections(collection_id) ON DELETE CASCADE,
  record_id uuid NOT NULL,
  path_token bytea NOT NULL,
  record_revision text NOT NULL,
  content_bytes bigint NOT NULL CHECK (content_bytes >= 0),
  exact_ciphertext bytea NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (collection_id, record_id),
  UNIQUE (collection_id, path_token)
);

CREATE TABLE candidate_a.record_versions (
  collection_id uuid NOT NULL REFERENCES candidate_a.collections(collection_id) ON DELETE CASCADE,
  record_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  record_revision text NOT NULL,
  exact_ciphertext bytea,
  deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (collection_id, record_id, sequence),
  CHECK (deleted = (exact_ciphertext IS NULL))
);

CREATE TABLE candidate_a.changes (
  collection_id uuid NOT NULL REFERENCES candidate_a.collections(collection_id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence > 0),
  record_id uuid NOT NULL,
  before_ciphertext bytea,
  after_ciphertext bytea,
  record_revision text NOT NULL,
  PRIMARY KEY (collection_id, sequence)
);

-- Indexed columns: collections.collection_id; records(collection_id, record_id);
-- records(collection_id, path_token); record_versions(collection_id, record_id,
-- sequence); changes(collection_id, sequence). No semantic or body index exists.
