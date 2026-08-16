-- Query cursors bind the public invocation independently from the closed query
-- plan. Exact `this` context is optional and remains collection-encrypted.
ALTER TABLE hosted_provider_query_cursors
  ADD COLUMN request_kind text NOT NULL DEFAULT 'query'
    CHECK (request_kind IN ('query', 'canonical_view')),
  ADD COLUMN request_digest bytea,
  ADD COLUMN result_meta jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(result_meta) = 'object' AND pg_column_size(result_meta) <= 16384),
  ADD COLUMN exact_context_ciphertext bytea
    CHECK (
      exact_context_ciphertext IS NULL
      OR octet_length(exact_context_ciphertext) <= 2200000
    );

UPDATE hosted_provider_query_cursors SET request_digest = query_digest;

ALTER TABLE hosted_provider_query_cursors
  ALTER COLUMN request_digest SET NOT NULL,
  ADD CONSTRAINT hosted_provider_query_cursors_request_digest_check
    CHECK (octet_length(request_digest) = 32);
