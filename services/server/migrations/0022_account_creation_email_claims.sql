CREATE TABLE account_creation_email_claims (
  normalized_email text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('email_identity', 'external_identity', 'legacy_user')),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO account_creation_email_claims (normalized_email, user_id, source)
SELECT normalized_email, (min(user_id::text))::uuid, 'email_identity'
FROM email_identities
WHERE retired_at IS NULL
GROUP BY normalized_email
ON CONFLICT(normalized_email) DO NOTHING;

INSERT INTO account_creation_email_claims (normalized_email, user_id, source)
SELECT normalized_email, (min(user_id::text))::uuid, 'external_identity'
FROM external_identities
WHERE email_verified = true AND normalized_email IS NOT NULL
GROUP BY normalized_email
ON CONFLICT(normalized_email) DO NOTHING;
