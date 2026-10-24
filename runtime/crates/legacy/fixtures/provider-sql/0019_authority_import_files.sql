ALTER TABLE hosted_provider_authority_imports
  ADD COLUMN IF NOT EXISTS expected_file_count bigint NOT NULL DEFAULT 0
    CHECK (expected_file_count >= 0);

CREATE TABLE IF NOT EXISTS hosted_provider_authority_import_file_transfers (
  id uuid PRIMARY KEY,
  import_id uuid NOT NULL
    REFERENCES hosted_provider_authority_imports(id) ON DELETE CASCADE,
  file_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('open', 'completing', 'committed', 'aborted', 'expired')),
  strategy text NOT NULL CHECK (strategy IN ('object_put', 'object_multipart')),
  expected_size bigint NOT NULL CHECK (expected_size >= 0),
  intent_token bytea NOT NULL,
  intent_ciphertext bytea NOT NULL,
  staging_object_key text NOT NULL,
  committed_object_key text NOT NULL UNIQUE,
  multipart_upload_id text,
  completion_parts jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((strategy = 'object_multipart') = (multipart_upload_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS hosted_provider_authority_import_file_transfer_idx
  ON hosted_provider_authority_import_file_transfers(import_id, file_id, intent_token);

CREATE INDEX IF NOT EXISTS hosted_provider_authority_import_file_transfer_expiry_idx
  ON hosted_provider_authority_import_file_transfers(expires_at)
  WHERE state IN ('open', 'completing');

CREATE TABLE IF NOT EXISTS hosted_provider_authority_import_file_parts (
  transfer_id uuid NOT NULL
    REFERENCES hosted_provider_authority_import_file_transfers(id) ON DELETE CASCADE,
  part_number integer NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  content_length bigint NOT NULL CHECK (content_length >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (transfer_id, part_number)
);
