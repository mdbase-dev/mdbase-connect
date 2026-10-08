-- Replica-applied strict completion evidence. The CP only aggregates signed
-- attestations; log admission is NOT application. One current witness per target.
CREATE TABLE IF NOT EXISTS next_strict_witnesses (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  collection_id uuid NOT NULL REFERENCES next_collections(collection_id) ON DELETE CASCADE,
  recovery_device uuid NOT NULL,
  strict_version bigint NOT NULL CHECK (strict_version > 0),
  reporter uuid NOT NULL,
  revoked_at bigint NOT NULL CHECK (revoked_at > 0),
  applied_at bigint NOT NULL CHECK (applied_at >= revoked_at),
  epoch bigint NOT NULL CHECK (epoch > 0),
  signature bytea NOT NULL CHECK (octet_length(signature) = 64),
  PRIMARY KEY (user_id, collection_id, recovery_device)
);
