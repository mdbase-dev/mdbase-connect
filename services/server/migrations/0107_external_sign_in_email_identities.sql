-- Accounts created through Google or GitHub sign-in before public signup
-- (2026-09-11) have no email identity, so no account email reaches them.
-- Each such account gets its verified sign-in address as its verified primary
-- identity, when the account holds that address's account-creation claim and
-- no account has the address as an identity. An account with any unretired
-- identity is left alone. Where an account has several verified sign-in
-- addresses, the one matching users.email wins, then the oldest sign-in.
-- Like external signup, the identity stores the normalized address.
INSERT INTO email_identities
  (id, user_id, email, normalized_email, normalization_version, verified_at, is_primary)
SELECT DISTINCT ON (account.id)
  gen_random_uuid(), account.id, external.normalized_email, external.normalized_email,
  external.email_normalization_version, external.created_at, true
FROM users account
JOIN external_identities external
  ON external.user_id = account.id
 AND external.email_verified = true
 AND external.normalized_email IS NOT NULL
 AND external.email_normalization_version = 1
JOIN account_creation_email_claims claim
  ON claim.normalized_email = external.normalized_email
 AND claim.user_id = account.id
LEFT JOIN email_identities existing
  ON existing.user_id = account.id AND existing.retired_at IS NULL
LEFT JOIN email_identities taken
  ON taken.normalized_email = external.normalized_email AND taken.retired_at IS NULL
WHERE existing.id IS NULL AND taken.id IS NULL
ORDER BY account.id,
  COALESCE(external.normalized_email = lower(account.email), false) DESC,
  external.created_at, external.provider;
