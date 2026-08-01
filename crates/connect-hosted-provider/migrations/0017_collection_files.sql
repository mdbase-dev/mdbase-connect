ALTER TABLE hosted_provider_collections
  ADD COLUMN IF NOT EXISTS file_count bigint NOT NULL DEFAULT 0 CHECK (file_count >= 0),
  ADD COLUMN IF NOT EXISTS file_bytes bigint NOT NULL DEFAULT 0 CHECK (file_bytes >= 0),
  ADD COLUMN IF NOT EXISTS stored_file_bytes bigint NOT NULL DEFAULT 0 CHECK (stored_file_bytes >= 0),
  ADD COLUMN IF NOT EXISTS max_files bigint NOT NULL DEFAULT 10000 CHECK (max_files > 0),
  ADD COLUMN IF NOT EXISTS max_file_bytes bigint NOT NULL DEFAULT 5368709120 CHECK (max_file_bytes > 0),
  ADD COLUMN IF NOT EXISTS max_stored_file_bytes bigint NOT NULL DEFAULT 10737418240 CHECK (max_stored_file_bytes > 0),
  ADD COLUMN IF NOT EXISTS max_single_file_bytes bigint NOT NULL DEFAULT 1073741824 CHECK (max_single_file_bytes > 0);

ALTER TABLE hosted_provider_replicas
  ADD COLUMN IF NOT EXISTS file_capability jsonb;

ALTER TABLE hosted_provider_snapshot_leases
  ADD COLUMN IF NOT EXISTS records_complete boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS files_complete boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS hosted_provider_files (
  collection_id uuid NOT NULL REFERENCES hosted_provider_collections(id) ON DELETE CASCADE,
  file_id uuid NOT NULL,
  path_token bytea NOT NULL,
  revision text NOT NULL,
  size bigint NOT NULL CHECK (size >= 0),
  object_key text NOT NULL,
  payload_ciphertext bytea NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, file_id),
  UNIQUE (collection_id, path_token),
  UNIQUE (object_key)
);

CREATE TABLE IF NOT EXISTS hosted_provider_file_versions (
  collection_id uuid NOT NULL REFERENCES hosted_provider_collections(id) ON DELETE CASCADE,
  file_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  revision text NOT NULL,
  size bigint CHECK (size >= 0),
  object_key text,
  payload_ciphertext bytea,
  deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, file_id, sequence),
  CHECK (deleted = (object_key IS NULL)),
  CHECK (deleted = (payload_ciphertext IS NULL)),
  CHECK (deleted = (size IS NULL))
);

CREATE INDEX IF NOT EXISTS hosted_provider_file_versions_snapshot_idx
  ON hosted_provider_file_versions (collection_id, file_id, sequence DESC);

CREATE TABLE IF NOT EXISTS hosted_provider_file_changes (
  collection_id uuid NOT NULL REFERENCES hosted_provider_collections(id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence > 0),
  file_id uuid NOT NULL,
  revision text NOT NULL,
  before_size bigint CHECK (before_size >= 0),
  before_object_key text,
  before_ciphertext bytea,
  after_size bigint CHECK (after_size >= 0),
  after_object_key text,
  after_ciphertext bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, sequence),
  CHECK ((before_object_key IS NULL) = (before_ciphertext IS NULL)),
  CHECK ((after_object_key IS NULL) = (after_ciphertext IS NULL))
);

CREATE TABLE IF NOT EXISTS hosted_provider_file_transfers (
  id uuid PRIMARY KEY,
  collection_id uuid NOT NULL REFERENCES hosted_provider_collections(id) ON DELETE CASCADE,
  replica_id uuid NOT NULL REFERENCES hosted_provider_replicas(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('upload', 'download')),
  state text NOT NULL CHECK (state IN ('open', 'completing', 'committed', 'aborted', 'expired')),
  strategy text NOT NULL CHECK (strategy IN ('object_put', 'object_multipart', 'object_ranges')),
  file_id uuid NOT NULL,
  expected_size bigint NOT NULL CHECK (expected_size >= 0),
  intent_ciphertext bytea NOT NULL,
  staging_object_key text,
  committed_object_key text NOT NULL,
  multipart_upload_id text,
  completion_parts jsonb,
  receipt_ciphertext bytea,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((direction = 'upload') = (staging_object_key IS NOT NULL)),
  CHECK ((strategy = 'object_multipart') = (multipart_upload_id IS NOT NULL)),
  CHECK ((state = 'committed') = (receipt_ciphertext IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS hosted_provider_file_transfers_expiry_idx
  ON hosted_provider_file_transfers (expires_at)
  WHERE state IN ('open', 'completing');

CREATE TABLE IF NOT EXISTS hosted_provider_file_transfer_parts (
  transfer_id uuid NOT NULL REFERENCES hosted_provider_file_transfers(id) ON DELETE CASCADE,
  part_number integer NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  content_length bigint NOT NULL CHECK (content_length >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (transfer_id, part_number)
);

CREATE TABLE IF NOT EXISTS hosted_provider_blob_deletions (
  object_key text PRIMARY KEY,
  byte_length bigint NOT NULL DEFAULT 0 CHECK (byte_length >= 0),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at timestamptz
);
