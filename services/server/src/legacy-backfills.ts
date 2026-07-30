import {
  EMAIL_NORMALIZATION_VERSION,
  normalizeEmailAddress
} from "./email-identity.js";
import type { DatabaseQueryable } from "./database-types.js";

export async function backfillSessionProviders(db: DatabaseQueryable): Promise<void> {
  await db.query(
    `UPDATE sessions SET provider = 'github'
     FROM external_identities
     WHERE sessions.provider = 'session'
       AND external_identities.user_id = sessions.user_id
       AND external_identities.provider = 'github'`
  );
}

export async function backfillExternalIdentityEmails(
  db: DatabaseQueryable
): Promise<void> {
  const identities = await db.query<{
    provider: string;
    subject: string;
    email: string;
  }>(
    `SELECT provider, subject, email FROM external_identities
     WHERE email_verified = true
       AND email IS NOT NULL
       AND COALESCE(normalized_email, '') = ''`
  );
  for (const identity of identities.rows) {
    let normalizedEmail: string;
    try {
      normalizedEmail = normalizeEmailAddress(identity.email);
    } catch {
      // Invalid provider presentation data is not an account-linking key.
      continue;
    }
    await db.query(
      `UPDATE external_identities
       SET normalized_email = $3, email_normalization_version = $4
       WHERE provider = $1 AND subject = $2
         AND COALESCE(normalized_email, '') = ''`,
      [
        identity.provider,
        identity.subject,
        normalizedEmail,
        EMAIL_NORMALIZATION_VERSION
      ]
    );
  }
}

export async function revokeLegacyHostedBearerGrants(
  db: DatabaseQueryable
): Promise<void> {
  await db.query(
    `UPDATE grants
     SET revoked_at = COALESCE(revoked_at, now())
     WHERE hosted_collection_id IS NOT NULL
       AND application_origin = 'null'
       AND proof_public_key IS NULL`
  );
  await db.query(
    `UPDATE access_tokens
     SET revoked_at = COALESCE(revoked_at, now())
     WHERE grant_id IN (
       SELECT id FROM grants
       WHERE hosted_collection_id IS NOT NULL
         AND application_origin = 'null'
         AND proof_public_key IS NULL
     )`
  );
  await db.query(
    `UPDATE refresh_tokens
     SET revoked_at = COALESCE(revoked_at, now())
     WHERE grant_id IN (
       SELECT id FROM grants
       WHERE hosted_collection_id IS NOT NULL
         AND application_origin = 'null'
         AND proof_public_key IS NULL
     )`
  );
}
