import { randomUUID } from "node:crypto";
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

export async function retireLegacyContractScopedGrants(
  db: DatabaseQueryable
): Promise<number> {
  await db.query("BEGIN");
  try {
    const grants = await db.query<{
      id: string;
      hosted_collection_id: string | null;
      hosted_replica_id: string | null;
    }>(
      `SELECT id, hosted_collection_id, hosted_replica_id
       FROM grants
       WHERE revoked_at IS NULL
         AND activated_at IS NOT NULL
         AND (
           COALESCE(scope->>'access', '') <> 'full_collection'
           OR COALESCE(scope->'contracts', 'null'::jsonb) <> '[]'::jsonb
         )
       ORDER BY id
       FOR UPDATE`
    );
    for (const grant of grants.rows) {
      if (grant.hosted_collection_id && grant.hosted_replica_id) {
        await db.query(
          `UPDATE hosted_replicas
           SET revoked_at = COALESCE(revoked_at, now()), token_hash = NULL
           WHERE id = $1`,
          [grant.hosted_replica_id]
        );
      }
      await db.query(
        `UPDATE access_tokens
         SET revoked_at = COALESCE(revoked_at, now())
         WHERE grant_id = $1`,
        [grant.id]
      );
      await db.query(
        `UPDATE refresh_tokens
         SET revoked_at = COALESCE(revoked_at, now())
         WHERE grant_id = $1`,
        [grant.id]
      );
      await db.query(
        `UPDATE grants
         SET revoked_at = COALESCE(revoked_at, now()),
             reauthorization_required_at = COALESCE(reauthorization_required_at, now()),
             reauthorization_reason = 'collection_level_authorization'
         WHERE id = $1`,
        [grant.id]
      );
      if (grant.hosted_collection_id && grant.hosted_replica_id) {
        const existing = await db.query<{ id: string }>(
          `SELECT id FROM provider_revocation_jobs
           WHERE replica_id = $1 AND completed_at IS NULL`,
          [grant.hosted_replica_id]
        );
        if (existing.rows[0]) {
          await db.query(
            `UPDATE provider_revocation_jobs
             SET grant_id = COALESCE(grant_id, $2)
             WHERE id = $1`,
            [existing.rows[0].id, grant.id]
          );
        } else {
          await db.query(
            `INSERT INTO provider_revocation_jobs
               (id, replica_id, grant_id, collection_id, reason)
             VALUES ($1, $2, $3, $4, 'collection_level_authorization')`,
            [
              randomUUID(),
              grant.hosted_replica_id,
              grant.id,
              grant.hosted_collection_id
            ]
          );
        }
      }
    }
    await db.query("COMMIT");
    return grants.rows.length;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
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
