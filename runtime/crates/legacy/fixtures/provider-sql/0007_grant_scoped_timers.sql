ALTER TABLE hosted_provider_replicas
  ADD COLUMN IF NOT EXISTS grant_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS hosted_provider_replicas_grant_idx
  ON hosted_provider_replicas(grant_id)
  WHERE grant_id IS NOT NULL;
