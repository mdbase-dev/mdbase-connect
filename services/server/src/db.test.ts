import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  backfillSessionProviders,
  createDatabase,
  revokeLegacyHostedBearerGrants
} from "./db.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("database migrations", () => {
  it("backfills existing GitHub sessions with their authentication provider", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const userId = randomUUID();

    await db.query("INSERT INTO users (id, email, name) VALUES ($1, $2, $3)", [
      userId,
      "existing@example.com",
      "Existing User"
    ]);
    await db.query(
      `INSERT INTO external_identities (provider, subject, user_id, login)
       VALUES ('github', '12558714', $1, 'existing')`,
      [userId]
    );
    await db.query(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, 'existing-token', now() + interval '30 days')`,
      [randomUUID(), userId]
    );

    await backfillSessionProviders(db);

    const session = await db.query<{ provider: string }>(
      "SELECT provider FROM sessions WHERE user_id = $1",
      [userId]
    );
    expect(session.rows[0]?.provider).toBe("github");
  });

  it("revokes legacy opaque-origin hosted grants that have no proof key", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const userId = randomUUID();
    const collectionId = randomUUID();
    const applicationId = randomUUID();
    const grantId = randomUUID();
    await db.query("INSERT INTO users (id, email, name) VALUES ($1, $2, $3)", [
      userId,
      "portable@example.com",
      "Portable User"
    ]);
    await db.query(
      `INSERT INTO hosted_collections (id, user_id, display_name, template)
       VALUES ($1, $2, 'Portable notes', 'mdbase')`,
      [collectionId, userId]
    );
    await db.query(
      `INSERT INTO applications
         (id, canonical_identity, distribution, name, homepage, redirect_uris)
       VALUES ($1, 'portable-legacy', 'portable', 'Portable', '', '[]'::jsonb)`,
      [applicationId]
    );
    await db.query(
      `INSERT INTO grants
         (id, user_id, application_id, hosted_collection_id, operations, scope,
          application_origin)
       VALUES ($1, $2, $3, $4, '["query"]'::jsonb,
               '{"contracts":[],"access":"full_collection"}'::jsonb, 'null')`,
      [grantId, userId, applicationId, collectionId]
    );
    await db.query(
      `INSERT INTO access_tokens (id, token_hash, grant_id, expires_at)
       VALUES ($1, 'legacy-access', $2, now() + interval '1 hour')`,
      [randomUUID(), grantId]
    );
    await db.query(
      `INSERT INTO refresh_tokens (id, token_hash, grant_id, expires_at)
       VALUES ($1, 'legacy-refresh', $2, now() + interval '30 days')`,
      [randomUUID(), grantId]
    );

    await revokeLegacyHostedBearerGrants(db);

    const grant = await db.query<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM grants WHERE id = $1",
      [grantId]
    );
    const access = await db.query<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM access_tokens WHERE grant_id = $1",
      [grantId]
    );
    const refresh = await db.query<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM refresh_tokens WHERE grant_id = $1",
      [grantId]
    );
    expect(grant.rows[0]?.revoked_at).not.toBeNull();
    expect(access.rows[0]?.revoked_at).not.toBeNull();
    expect(refresh.rows[0]?.revoked_at).not.toBeNull();
  });
});
