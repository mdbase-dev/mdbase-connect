CREATE TABLE IF NOT EXISTS hosted_provider_authority_imports (
  id uuid PRIMARY KEY,
  collection_id uuid NOT NULL UNIQUE
    REFERENCES hosted_provider_collections(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  next_authority_epoch bigint NOT NULL CHECK (next_authority_epoch > 1),
  restore_state text CHECK (restore_state IS NULL OR restore_state = 'transferred'),
  state text NOT NULL DEFAULT 'receiving'
    CHECK (state IN ('receiving', 'uploaded', 'completed', 'aborted')),
  manifest_ciphertext bytea,
  manifest_digest text,
  source_revision text,
  source_head bigint,
  expected_record_count bigint,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  uploaded_at timestamptz,
  completed_at timestamptz,
  aborted_at timestamptz
);

CREATE INDEX IF NOT EXISTS hosted_provider_authority_import_expiry_idx
  ON hosted_provider_authority_imports(expires_at)
  WHERE state IN ('receiving', 'uploaded');

CREATE TABLE IF NOT EXISTS hosted_provider_authority_import_records (
  import_id uuid NOT NULL
    REFERENCES hosted_provider_authority_imports(id) ON DELETE CASCADE,
  page bigint NOT NULL CHECK (page >= 0),
  record_id uuid NOT NULL,
  path_token bytea NOT NULL,
  payload_ciphertext bytea NOT NULL,
  content_bytes bigint NOT NULL CHECK (content_bytes >= 0),
  PRIMARY KEY (import_id, record_id),
  UNIQUE (import_id, path_token)
);

CREATE INDEX IF NOT EXISTS hosted_provider_authority_import_records_page_idx
  ON hosted_provider_authority_import_records(import_id, page);
