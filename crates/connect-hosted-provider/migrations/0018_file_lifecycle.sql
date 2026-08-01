CREATE TABLE IF NOT EXISTS hosted_provider_file_mutations (
  mutation_id uuid PRIMARY KEY,
  collection_id uuid NOT NULL REFERENCES hosted_provider_collections(id) ON DELETE CASCADE,
  replica_id uuid NOT NULL REFERENCES hosted_provider_replicas(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('move', 'delete')),
  request_ciphertext bytea NOT NULL,
  receipt_ciphertext bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hosted_provider_file_mutations_collection_idx
  ON hosted_provider_file_mutations (collection_id, created_at);
