-- Migration rollback restores only revocations made by the same provider run.
-- Existing revocations are intentionally left without ownership.
ALTER TABLE hosted_provider_collections ADD COLUMN legacy_migration_id uuid;
ALTER TABLE hosted_provider_replicas
  ADD COLUMN revoked_by_migration uuid,
  ADD COLUMN migration_revoked_at timestamptz,
  ADD CONSTRAINT hosted_replica_migration_revocation_owned CHECK (
    (revoked_by_migration IS NULL AND migration_revoked_at IS NULL)
    OR (revoked_by_migration IS NOT NULL AND migration_revoked_at IS NOT NULL AND revoked_at IS NOT NULL)
  );
