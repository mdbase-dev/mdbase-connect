-- Outside actor SQL/R2 rollback. These rows are registration data, not a native
-- caller, drain acknowledgement or permission to serve. No deletion cascades.
CREATE TABLE next_prekey_http_nonce_floors (
  collection_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL,
  cutoff_ms bigint NOT NULL CHECK (cutoff_ms BETWEEN 0 AND 9007199254675991),
  not_before_ms bigint NOT NULL CHECK (not_before_ms = cutoff_ms + 65000),
  last_cp_now_ms bigint NOT NULL CHECK (last_cp_now_ms BETWEEN cutoff_ms AND 9007199254740991)
);

CREATE TABLE next_prekey_http_nonce_uses (
  collection_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  http_nonce bytea NOT NULL CHECK (octet_length(http_nonce) = 32 AND http_nonce <> '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea),
  transcript_hash bytea NOT NULL CHECK (octet_length(transcript_hash) = 32 AND transcript_hash <> '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea),
  challenge bytea NOT NULL CHECK (octet_length(challenge) = 32 AND challenge <> '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea),
  nonce_expires_ms bigint NOT NULL CHECK (nonce_expires_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (collection_id, http_nonce)
);
CREATE INDEX next_prekey_http_nonce_uses_collection_live
  ON next_prekey_http_nonce_uses (collection_id, nonce_expires_ms, http_nonce);
CREATE INDEX next_prekey_http_nonce_uses_owner_live
  ON next_prekey_http_nonce_uses (owner_user_id, nonce_expires_ms);
