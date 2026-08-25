import type { DatabaseQueryable } from "./database-types.js";
import { normalizeEmailAddress } from "./email-identity.js";

export type AccountCreationEmailClaimSource =
  | "email_identity"
  | "external_identity"
  | "legacy_user";

export async function accountCreationEmailClaimed(
  db: DatabaseQueryable,
  normalizedEmail: string
): Promise<boolean> {
  const result = await db.query(
    `SELECT user_id FROM account_creation_email_claims
     WHERE normalized_email = $1
     UNION ALL
     SELECT user_id FROM email_identities
     WHERE normalized_email = $1 AND retired_at IS NULL
     UNION ALL
     SELECT user_id FROM external_identities
     WHERE normalized_email = $1 AND email_verified = true
     LIMIT 1`,
    [normalizedEmail]
  );
  if (result.rows[0]) return true;

  const legacyUsers = await db.query<{ email: string }>(
    "SELECT email FROM users WHERE email IS NOT NULL"
  );
  return legacyUsers.rows.some(({ email }) => {
    try {
      return normalizeEmailAddress(email) === normalizedEmail;
    } catch {
      return false;
    }
  });
}

export async function backfillLegacyAccountCreationEmailClaims(
  db: DatabaseQueryable
): Promise<void> {
  const legacyUsers = await db.query<{ id: string; email: string }>(
    "SELECT id, email FROM users WHERE email IS NOT NULL ORDER BY id"
  );
  for (const user of legacyUsers.rows) {
    let normalizedEmail: string;
    try {
      normalizedEmail = normalizeEmailAddress(user.email);
    } catch {
      continue;
    }
    await reserveAccountCreationEmail(db, {
      normalizedEmail,
      userId: user.id,
      source: "legacy_user"
    });
  }
}

export async function reserveAccountCreationEmail(
  db: DatabaseQueryable,
  input: {
    normalizedEmail: string;
    userId: string;
    source: AccountCreationEmailClaimSource;
  }
): Promise<boolean> {
  const claimed = await db.query<{ user_id: string }>(
    `INSERT INTO account_creation_email_claims
       (normalized_email, user_id, source)
     VALUES ($1, $2, $3)
     ON CONFLICT(normalized_email) DO UPDATE SET
       normalized_email = excluded.normalized_email
     WHERE account_creation_email_claims.user_id = excluded.user_id
     RETURNING user_id`,
    [input.normalizedEmail, input.userId, input.source]
  );
  return claimed.rows[0]?.user_id === input.userId;
}
