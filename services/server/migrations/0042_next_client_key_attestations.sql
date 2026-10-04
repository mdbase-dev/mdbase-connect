-- An app's Noise static key, attested at consent with the grant signing key its
-- authorization binding certifies (mdbase-next interface note
-- 2026-10-04-control-client-noise-key-attestation.md). Held per request until approval,
-- then copied to the grant with its attestation for daemons to verify.
-- New table and a nullable column on a table the previous release never reads.
CREATE TABLE next_authorization_client_keys (
  request_id uuid PRIMARY KEY REFERENCES authorization_requests(id) ON DELETE CASCADE,
  client_pk bytea NOT NULL,
  signature bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE next_grant_client_keys ADD COLUMN signature bytea;
