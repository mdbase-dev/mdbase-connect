-- Draft v1 uses independent ECDH agreement and ECDSA signing keypairs.
-- Existing pre-release authorization requests are intentionally not migrated:
-- they must restart authorization and prove possession of both new keys.
ALTER TABLE authorization_requests
  ADD COLUMN IF NOT EXISTS application_agreement_public_key text;

ALTER TABLE authorization_requests
  ADD COLUMN IF NOT EXISTS application_signing_public_key text;
