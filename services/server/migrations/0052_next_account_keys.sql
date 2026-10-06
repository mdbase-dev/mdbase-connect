-- AK1 (mdbase-next docs/ship/interfaces/2026-10-06-private-account-key.md §5):
-- one account key per account for private (e2e) multi-device enrolment.
--
-- `bundle` is the user's account secret R sealed client-side under their encryption
-- password (Argon2id, XChaCha20-Poly1305, AAD-bound to the account and key id). The
-- server never sees R or the password and never decrypts this. `key_id` is public:
-- H("mdbase/v1/account-key-id", R). Strict mode keeps no bundle at all.
CREATE TABLE next_account_keys (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('password', 'strict')),
  version bigint NOT NULL CHECK (version >= 1 AND version <= 9007199254740991),
  key_id bytea CHECK (key_id IS NULL OR octet_length(key_id) = 32),
  bundle bytea CHECK (bundle IS NULL OR octet_length(bundle) BETWEEN 1 AND 512),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((mode = 'password') = (bundle IS NOT NULL)),
  CHECK ((bundle IS NULL) = (key_id IS NULL))
);
