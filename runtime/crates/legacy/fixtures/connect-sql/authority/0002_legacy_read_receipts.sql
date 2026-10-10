ALTER TABLE grant_crypto_requests
  ADD COLUMN response_receipt TEXT;

ALTER TABLE grant_crypto_requests
  ADD COLUMN response_bytes INTEGER
  CHECK (response_bytes IS NULL OR response_bytes >= 0);

ALTER TABLE grant_crypto_requests
  ADD COLUMN response_completed_at_ms INTEGER;

ALTER TABLE grant_crypto_requests
  ADD COLUMN response_expired INTEGER NOT NULL DEFAULT 0
  CHECK (response_expired IN (0, 1));

CREATE INDEX grant_crypto_requests_legacy_receipt_retention
  ON grant_crypto_requests (
    replay_class,
    response_expired,
    response_completed_at_ms
  )
  WHERE response_receipt IS NOT NULL;
