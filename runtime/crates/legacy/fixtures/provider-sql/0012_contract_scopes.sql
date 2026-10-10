ALTER TABLE hosted_provider_replicas
  ADD COLUMN IF NOT EXISTS contract_scope jsonb NOT NULL DEFAULT '[]'::jsonb;
