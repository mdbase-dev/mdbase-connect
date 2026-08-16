-- Existing binaries continue to write and read json-v1 through the default.
-- Candidate B writers may opt into pre-encryption compression; the format is
-- explicit because encrypted bytes are otherwise intentionally opaque and
-- incompressible to PostgreSQL TOAST.
ALTER TABLE hosted_provider_query_page_receipts
  ADD COLUMN response_encoding text NOT NULL DEFAULT 'json-v1'
    CHECK (response_encoding IN ('json-v1', 'zstd-json-v1'));
