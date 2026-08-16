-- Query-page delivery is idempotent across a lost HTTP response. The exact
-- response may contain decrypted Markdown, so it is encrypted with the
-- collection data key and bound to the replica/request identity.
CREATE TABLE hosted_provider_query_page_receipts (
  replica_id uuid NOT NULL REFERENCES hosted_provider_replicas(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  collection_id uuid NOT NULL REFERENCES hosted_provider_collections(id) ON DELETE CASCADE,
  scope_epoch bigint NOT NULL CHECK (scope_epoch >= 1),
  request_kind text NOT NULL CHECK (request_kind IN ('query', 'canonical_view', 'obsidian_base')),
  input_digest bytea NOT NULL CHECK (octet_length(input_digest) = 32),
  response_ciphertext bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (replica_id, request_id)
);

CREATE INDEX hosted_provider_query_page_receipts_expiry_idx
  ON hosted_provider_query_page_receipts (collection_id, expires_at);
