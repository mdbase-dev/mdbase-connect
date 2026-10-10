CREATE TABLE IF NOT EXISTS hosted_provider_operation_requests (
  replica_id uuid NOT NULL REFERENCES hosted_provider_replicas(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  operation text NOT NULL,
  request_hash bytea NOT NULL,
  prepared_mutation_ciphertext bytea,
  response_ciphertext bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (replica_id, request_id)
);

CREATE INDEX IF NOT EXISTS hosted_provider_operation_requests_created_idx
  ON hosted_provider_operation_requests (created_at);
