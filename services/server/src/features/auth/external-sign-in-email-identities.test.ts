import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { DatabasePool } from "../../database-types.js";
import { createDatabase } from "../../db.js";

const MIGRATION = new URL(
  "../../../migrations/0107_external_sign_in_email_identities.sql",
  import.meta.url
);
const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("migration 0107: email identities for early external sign-in accounts", () => {
  it("gives each account its claimed, verified sign-in address once", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());

    // Created through GitHub sign-in before public signup: no email identity.
    const early = await account(db, "early@example.com");
    await signIn(db, early, "github", "Early@Example.com", { claimed: true });
    // Two sign-ins with different addresses: the one matching users.email wins.
    const twoProviders = await account(db, "second@example.com");
    await signIn(db, twoProviders, "github", "first@example.com", { claimed: true, at: "2026-07-01" });
    await signIn(db, twoProviders, "google", "second@example.com", { claimed: true, at: "2026-08-01" });
    // Another account holds this address's claim.
    const claimedElsewhere = await account(db, "shared@example.com");
    await signIn(db, claimedElsewhere, "github", "shared@example.com", { claimed: false });
    await db.query(
      `INSERT INTO account_creation_email_claims (normalized_email, user_id, source)
       VALUES ('shared@example.com', $1, 'legacy_user')`,
      [early]
    );
    // The provider didn't verify the address.
    const unverified = await account(db, "unverified@example.com");
    await signIn(db, unverified, "github", "unverified@example.com", { claimed: true, verified: false });
    // Already has an identity, even an unverified one.
    const hasIdentity = await account(db, "has@example.com");
    await signIn(db, hasIdentity, "google", "has@example.com", { claimed: true });
    await db.query(
      `INSERT INTO email_identities (id, user_id, email, normalized_email, normalization_version, is_primary)
       VALUES ($1, $2, 'pending@example.com', 'pending@example.com', 1, true)`,
      [randomUUID(), hasIdentity]
    );

    const sql = await readFile(MIGRATION, "utf8");
    await db.query(sql);
    await db.query(sql);

    const identities = await db.query<{
      user_id: string; email: string; normalized_email: string; verified: boolean; is_primary: boolean;
    }>(
      `SELECT user_id, email, normalized_email, verified_at IS NOT NULL AS verified, is_primary
       FROM email_identities ORDER BY normalized_email`
    );
    expect(identities.rows).toEqual([
      { user_id: early, email: "early@example.com", normalized_email: "early@example.com", verified: true, is_primary: true },
      { user_id: hasIdentity, email: "pending@example.com", normalized_email: "pending@example.com", verified: false, is_primary: true },
      { user_id: twoProviders, email: "second@example.com", normalized_email: "second@example.com", verified: true, is_primary: true }
    ]);
  });
});

async function account(db: DatabasePool, email: string): Promise<string> {
  const id = randomUUID();
  await db.query("INSERT INTO users (id, email, name) VALUES ($1, $2, 'Person')", [id, email]);
  return id;
}

async function signIn(
  db: DatabasePool,
  userId: string,
  provider: string,
  email: string,
  options: { claimed: boolean; verified?: boolean; at?: string }
): Promise<void> {
  const normalized = email.toLowerCase();
  await db.query(
    `INSERT INTO external_identities
       (provider, subject, user_id, email, email_verified, normalized_email,
        email_normalization_version, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 1, $7)`,
    [provider, randomUUID(), userId, email, options.verified ?? true, normalized,
      new Date(options.at ?? "2026-07-21")]
  );
  if (options.claimed) {
    await db.query(
      `INSERT INTO account_creation_email_claims (normalized_email, user_id, source)
       VALUES ($1, $2, 'external_identity')`,
      [normalized, userId]
    );
  }
}
