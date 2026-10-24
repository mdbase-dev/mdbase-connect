ALTER TABLE hosted_provider_replicas
  ADD COLUMN IF NOT EXISTS proof_public_key text;

UPDATE hosted_provider_replicas
SET revoked_at = COALESCE(revoked_at, now())
WHERE purpose = 'application'
  AND allowed_origin = 'null'
  AND proof_public_key IS NULL;

CREATE TABLE IF NOT EXISTS hosted_provider_request_proofs (
  replica_id uuid NOT NULL REFERENCES hosted_provider_replicas(id) ON DELETE CASCADE,
  nonce uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (replica_id, nonce)
);

CREATE INDEX IF NOT EXISTS hosted_provider_request_proofs_created_idx
  ON hosted_provider_request_proofs(created_at);
