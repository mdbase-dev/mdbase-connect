ALTER TABLE hosted_provider_collections
  DROP CONSTRAINT IF EXISTS hosted_provider_collections_state_check;

ALTER TABLE hosted_provider_collections
  ADD CONSTRAINT hosted_provider_collections_state_check
  CHECK (state IN ('active', 'importing', 'transferring', 'transferred', 'deleting'));

CREATE TABLE IF NOT EXISTS hosted_provider_authority_transfers (
  id uuid PRIMARY KEY,
  collection_id uuid NOT NULL
    REFERENCES hosted_provider_collections(id) ON DELETE CASCADE,
  replica_id uuid NOT NULL
    REFERENCES hosted_provider_replicas(id) ON DELETE CASCADE,
  final_head bigint NOT NULL CHECK (final_head >= 0),
  next_authority_epoch bigint NOT NULL CHECK (next_authority_epoch > 1),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'prepared'
    CHECK (state IN ('prepared', 'completed', 'aborted')),
  expires_at timestamptz NOT NULL,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  aborted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS hosted_provider_authority_transfer_active_idx
  ON hosted_provider_authority_transfers(collection_id)
  WHERE state = 'prepared';

CREATE INDEX IF NOT EXISTS hosted_provider_authority_transfer_expiry_idx
  ON hosted_provider_authority_transfers(expires_at)
  WHERE state = 'prepared';
