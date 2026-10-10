-- Evidence of the exact atomic migration-owned restore + active transition.
-- Correlation IDs are not authorization. A new provider run supersedes replay of
-- old receipts without deleting the historical evidence.
CREATE TABLE hosted_provider_legacy_rollback_receipts (
  collection_id uuid NOT NULL REFERENCES hosted_provider_collections(id) ON DELETE CASCADE,
  provider_migration_id uuid NOT NULL,
  owner_account_id uuid NOT NULL,
  authority_epoch bigint NOT NULL CHECK (authority_epoch > 0),
  fixed_head bigint NOT NULL CHECK (fixed_head >= 0),
  driver_id uuid NOT NULL,
  action_id uuid NOT NULL,
  requested_ids uuid[] NOT NULL CHECK (cardinality(requested_ids) <= 1000),
  restored_ids uuid[] NOT NULL CHECK (restored_ids <@ requested_ids),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  superseded_at timestamptz,
  PRIMARY KEY (collection_id, provider_migration_id),
  UNIQUE (driver_id, action_id)
);
