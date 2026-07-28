import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  backfillExternalIdentityEmails,
  backfillSessionProviders,
  createDatabase,
  revokeLegacyHostedBearerGrants
} from "./db.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("database migrations", () => {
  it("creates the account and operator foundation without changing existing data", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const userId = randomUUID();
    const sessionId = randomUUID();
    const connectorId = randomUUID();
    await db.query(
      "INSERT INTO users (id, email, name) VALUES ($1, 'existing@example.com', 'Existing')",
      [userId]
    );
    await db.query(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, 'legacy-session', now() + interval '30 days')`,
      [sessionId, userId]
    );
    await db.query(
      `INSERT INTO connectors (id, user_id, name, token_hash)
       VALUES ($1, $2, 'Existing computer', 'legacy-connector')`,
      [connectorId, userId]
    );

    const user = await db.query<{
      email: string;
      suspended_at: Date | null;
      session_epoch: number;
    }>(
      "SELECT email, suspended_at, session_epoch FROM users WHERE id = $1",
      [userId]
    );
    const session = await db.query<{
      account_session_epoch: number;
      revoked_at: Date | null;
      last_seen_at: Date;
    }>(
      `SELECT account_session_epoch, revoked_at, last_seen_at
       FROM sessions WHERE id = $1`,
      [sessionId]
    );
    const connector = await db.query<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM connectors WHERE id = $1",
      [connectorId]
    );
    expect(user.rows[0]).toMatchObject({
      email: "existing@example.com",
      suspended_at: null,
      session_epoch: 1
    });
    expect(session.rows[0]).toMatchObject({
      account_session_epoch: 1,
      revoked_at: null
    });
    expect(session.rows[0]?.last_seen_at).toBeInstanceOf(Date);
    expect(connector.rows[0]?.revoked_at).toBeNull();

    const authTables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_name IN (
         'email_identities',
         'password_credentials',
         'invitations',
         'authentication_challenges',
         'auth_rate_limit_buckets',
         'authentication_settings',
         'authentication_settings_history',
         'account_agreements',
         'operator_operations'
       )`
    );
    expect(new Set(authTables.rows.map(({ table_name }) => table_name))).toEqual(
      new Set([
        "email_identities",
        "password_credentials",
        "invitations",
        "authentication_challenges",
        "auth_rate_limit_buckets",
        "authentication_settings",
        "authentication_settings_history",
        "account_agreements",
        "operator_operations"
      ])
    );
  });

  it("enforces active email identity and primary identity uniqueness", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const firstUserId = randomUUID();
    const secondUserId = randomUUID();
    await db.query(
      `INSERT INTO users (id, email, name)
       VALUES ($1, NULL, 'First'), ($2, NULL, 'Second')`,
      [firstUserId, secondUserId]
    );
    const firstIdentityId = randomUUID();
    await db.query(
      `INSERT INTO email_identities
         (id, user_id, email, normalized_email, is_primary, verified_at)
       VALUES ($1, $2, 'Person@example.com', 'person@example.com', true, now())`,
      [firstIdentityId, firstUserId]
    );

    await expect(db.query(
      `INSERT INTO email_identities
         (id, user_id, email, normalized_email, is_primary)
       VALUES ($1, $2, 'person@example.com', 'person@example.com', true)`,
      [randomUUID(), secondUserId]
    )).rejects.toThrow();
    await expect(db.query(
      `INSERT INTO email_identities
         (id, user_id, email, normalized_email, is_primary)
       VALUES ($1, $2, 'other@example.com', 'other@example.com', true)`,
      [randomUUID(), firstUserId]
    )).rejects.toThrow();

    await db.query(
      "UPDATE email_identities SET retired_at = now() WHERE id = $1",
      [firstIdentityId]
    );
    await expect(db.query(
      `INSERT INTO email_identities
         (id, user_id, email, normalized_email, is_primary, verified_at)
       VALUES ($1, $2, 'person@example.com', 'person@example.com', true, now())`,
      [randomUUID(), secondUserId]
    )).resolves.toBeDefined();
  });

  it("keeps one active invitation and challenge per normalized email", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const invitationId = randomUUID();
    await db.query(
      `INSERT INTO invitations
         (id, email, normalized_email, token_hash, created_by, expires_at)
       VALUES ($1, 'Person@example.com', 'person@example.com', 'invite-one',
               'operator:test', now() + interval '7 days')`,
      [invitationId]
    );
    await expect(db.query(
      `INSERT INTO invitations
         (id, email, normalized_email, token_hash, created_by, expires_at)
       VALUES ($1, 'person@example.com', 'person@example.com', 'invite-two',
               'operator:test', now() + interval '7 days')`,
      [randomUUID()]
    )).rejects.toThrow();

    await db.query(
      "UPDATE invitations SET revoked_at = now() WHERE id = $1",
      [invitationId]
    );
    const replacementInvitationId = randomUUID();
    await db.query(
      `INSERT INTO invitations
         (id, email, normalized_email, token_hash, created_by, expires_at)
       VALUES ($1, 'person@example.com', 'person@example.com', 'invite-two',
               'operator:test', now() + interval '7 days')`,
      [replacementInvitationId]
    );
    const challengeId = randomUUID();
    await db.query(
      `INSERT INTO authentication_challenges
         (id, purpose, token_hash, normalized_email, invitation_id, expires_at)
       VALUES ($1, 'invitation_acceptance', 'challenge-one',
               'person@example.com', $2, now() + interval '30 minutes')`,
      [challengeId, replacementInvitationId]
    );
    await expect(db.query(
      `INSERT INTO authentication_challenges
         (id, purpose, token_hash, normalized_email, invitation_id, expires_at)
       VALUES ($1, 'invitation_acceptance', 'challenge-two',
               'person@example.com', $2, now() + interval '30 minutes')`,
      [randomUUID(), replacementInvitationId]
    )).rejects.toThrow();

    await db.query(
      "UPDATE authentication_challenges SET consumed_at = now() WHERE id = $1",
      [challengeId]
    );
    await expect(db.query(
      `INSERT INTO authentication_challenges
         (id, purpose, token_hash, normalized_email, invitation_id, expires_at)
       VALUES ($1, 'invitation_acceptance', 'challenge-two',
               'person@example.com', $2, now() + interval '30 minutes')`,
      [randomUUID(), replacementInvitationId]
    )).resolves.toBeDefined();
  });

  it("stores versioned credentials, agreements, settings, and privacy-safe rate keys", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const userId = randomUUID();
    await db.query(
      "INSERT INTO users (id, email, name) VALUES ($1, NULL, 'Beta User')",
      [userId]
    );
    await db.query(
      `INSERT INTO password_credentials (user_id, password_hash)
       VALUES ($1, '$argon2id$example')`,
      [userId]
    );
    await db.query(
      `INSERT INTO account_agreements
         (user_id, document, version, acceptance_method)
       VALUES ($1, 'terms', '2026-07-28', 'invitation')`,
      [userId]
    );
    await db.query(
      `INSERT INTO authentication_settings
         (registration_mode, password_auth_enabled, email_delivery_enabled,
          updated_by, update_reason)
       VALUES ('invite', true, true, 'operator:test', 'staging acceptance')`
    );
    await db.query(
      `INSERT INTO auth_rate_limit_buckets
         (scope, key_digest, window_started_at, attempt_count)
       VALUES ('signup:email', 'hmac-digest', now(), 1)`
    );

    const credential = await db.query<{ credential_version: number }>(
      "SELECT credential_version FROM password_credentials WHERE user_id = $1",
      [userId]
    );
    const settings = await db.query<{
      registration_mode: string;
      password_auth_enabled: boolean;
      email_delivery_enabled: boolean;
      revision: number;
    }>("SELECT * FROM authentication_settings");
    expect(credential.rows[0]?.credential_version).toBe(1);
    expect(settings.rows[0]).toMatchObject({
      registration_mode: "invite",
      password_auth_enabled: true,
      email_delivery_enabled: true,
      revision: 1
    });
    await expect(db.query(
      `INSERT INTO authentication_settings
         (registration_mode, updated_by, update_reason)
       VALUES ('closed', 'operator:test', 'duplicate')`
    )).rejects.toThrow();
  });

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

  it("backfills only valid verified external email linking keys", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const validUserId = randomUUID();
    const invalidUserId = randomUUID();
    await db.query(
      `INSERT INTO users (id, email, name)
       VALUES ($1, NULL, 'Valid'), ($2, NULL, 'Invalid')`,
      [validUserId, invalidUserId]
    );
    await db.query(
      `INSERT INTO external_identities
         (provider, subject, user_id, email, email_verified)
       VALUES
         ('google', 'valid', $1, 'Person@Example.com', true),
         ('google', 'invalid', $2, 'not-an-email', true)`,
      [validUserId, invalidUserId]
    );

    await backfillExternalIdentityEmails(db);

    const identities = await db.query<{
      subject: string;
      normalized_email: string | null;
      email_normalization_version: number | null;
    }>(
      `SELECT subject, normalized_email, email_normalization_version
       FROM external_identities ORDER BY subject`
    );
    expect(identities.rows).toEqual([
      {
        subject: "invalid",
        normalized_email: null,
        email_normalization_version: null
      },
      {
        subject: "valid",
        normalized_email: "person@example.com",
        email_normalization_version: 1
      }
    ]);
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
