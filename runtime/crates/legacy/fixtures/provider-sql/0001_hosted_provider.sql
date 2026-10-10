CREATE TABLE IF NOT EXISTS hosted_provider_metadata (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  key_check bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hosted_provider_collections (
  id uuid PRIMARY KEY,
  template text NOT NULL,
  spec_version text NOT NULL,
  authority_epoch bigint NOT NULL DEFAULT 1 CHECK (authority_epoch > 0),
  head bigint NOT NULL DEFAULT 0 CHECK (head >= 0),
  retained_after bigint NOT NULL DEFAULT 0 CHECK (retained_after >= 0),
  record_count bigint NOT NULL DEFAULT 0 CHECK (record_count >= 0),
  content_bytes bigint NOT NULL DEFAULT 0 CHECK (content_bytes >= 0),
  max_records bigint NOT NULL CHECK (max_records > 0),
  max_content_bytes bigint NOT NULL CHECK (max_content_bytes > 0),
  max_document_bytes bigint NOT NULL CHECK (max_document_bytes > 0),
  max_replicas bigint NOT NULL CHECK (max_replicas > 0),
  resource_revision text NOT NULL,
  wrapped_data_key bytea NOT NULL,
  resources_ciphertext bytea NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'importing', 'deleting')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hosted_provider_resources (
  collection_id uuid NOT NULL REFERENCES hosted_provider_collections(id) ON DELETE CASCADE,
  path text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('configuration', 'type')),
  revision text NOT NULL,
  document_ciphertext bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, path)
);

CREATE TABLE IF NOT EXISTS hosted_provider_records (
  collection_id uuid NOT NULL REFERENCES hosted_provider_collections(id) ON DELETE CASCADE,
  record_id uuid NOT NULL,
  path_token bytea NOT NULL,
  revision text NOT NULL,
  types text[] NOT NULL DEFAULT '{}',
  content_bytes bigint NOT NULL CHECK (content_bytes >= 0),
  payload_ciphertext bytea NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, record_id),
  UNIQUE (collection_id, path_token)
);

CREATE TABLE IF NOT EXISTS hosted_provider_record_versions (
  collection_id uuid NOT NULL REFERENCES hosted_provider_collections(id) ON DELETE CASCADE,
  record_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  revision text NOT NULL,
  types text[] NOT NULL DEFAULT '{}',
  payload_ciphertext bytea,
  deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, record_id, sequence)
);

CREATE INDEX IF NOT EXISTS hosted_provider_versions_snapshot_idx
  ON hosted_provider_record_versions (collection_id, record_id, sequence DESC);

CREATE TABLE IF NOT EXISTS hosted_provider_changes (
  collection_id uuid NOT NULL REFERENCES hosted_provider_collections(id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence > 0),
  record_id uuid NOT NULL,
  before_types text[] NOT NULL DEFAULT '{}',
  after_types text[] NOT NULL DEFAULT '{}',
  before_ciphertext bytea,
  after_ciphertext bytea,
  revision text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, sequence)
);

CREATE TABLE IF NOT EXISTS hosted_provider_replicas (
  id uuid PRIMARY KEY,
  collection_id uuid NOT NULL REFERENCES hosted_provider_collections(id) ON DELETE CASCADE,
  name text NOT NULL,
  purpose text NOT NULL DEFAULT 'mirror' CHECK (purpose IN ('mirror', 'application')),
  mode text NOT NULL CHECK (mode IN ('read_only', 'read_write')),
  allowed_types text[] NOT NULL DEFAULT '{}',
  allowed_operations text[] NOT NULL DEFAULT '{}',
  allowed_origin text,
  scope_epoch bigint NOT NULL DEFAULT 1 CHECK (scope_epoch > 0),
  token_hash bytea NOT NULL UNIQUE,
  token_expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  acknowledged_sequence bigint NOT NULL DEFAULT 0 CHECK (acknowledged_sequence >= 0),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hosted_provider_replicas_collection_idx
  ON hosted_provider_replicas (collection_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS hosted_provider_mutation_receipts (
  replica_id uuid NOT NULL REFERENCES hosted_provider_replicas(id) ON DELETE CASCADE,
  mutation_id uuid NOT NULL,
  mutation_hash bytea NOT NULL,
  receipt_ciphertext bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (replica_id, mutation_id)
);

CREATE TABLE IF NOT EXISTS hosted_provider_snapshot_leases (
  id uuid PRIMARY KEY,
  collection_id uuid NOT NULL REFERENCES hosted_provider_collections(id) ON DELETE CASCADE,
  replica_id uuid NOT NULL REFERENCES hosted_provider_replicas(id) ON DELETE CASCADE,
  scope_epoch bigint NOT NULL CHECK (scope_epoch > 0),
  cursor bigint NOT NULL CHECK (cursor >= 0),
  resource_revision text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hosted_provider_snapshot_expiry_idx
  ON hosted_provider_snapshot_leases (expires_at);
