import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  backfillExternalIdentityEmails,
  backfillSessionProviders,
  createDatabase,
  bootstrapLegacyBaseline,
  openDatabase,
  revokeLegacyHostedBearerGrants
} from "./db.js";
import { InstanceAdminService } from "./instance-admin.js";
import {
  assertControlPlaneMigrationsCurrent,
  runControlPlaneMigrations
} from "./migrations.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("database migrations", () => {
  it("records the legacy baseline and applies ordered SQL migrations once", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());

    const applied = await db.query<{ id: string }>(
      "SELECT id FROM schema_migrations ORDER BY id"
    );
    expect(applied.rows.map(({ id }) => id)).toEqual([
      "0000_legacy_baseline",
      "0001_collaboration_foundations",
      "0001a_authentication_foundations",
      "0002_instance_administration",
      "0003_authorization_request_collection",
      "0004_separate_application_keys",
      "0005_notification_contract_versions",
      "0006_notification_event_ids",
      "0007_beta_access_requests",
      "0007_oauth_login_state_foundation",
      "0008_account_management",
      "0009_grant_file_capabilities",
      "0010_beta_entitlements_and_email",
      "0011_application_authorization_trust"
    ]);
    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'hosted_replicas'
         AND column_name = 'authorized_user_id'`
    );
    expect(columns.rows).toHaveLength(1);
    const fileCapability = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'grants'
         AND column_name = 'file_capability'`
    );
    expect(fileCapability.rows).toHaveLength(1);

    await expect(assertControlPlaneMigrationsCurrent(db)).resolves.toBeUndefined();
    await runControlPlaneMigrations(db);
    const repeated = await db.query<{ id: string }>(
      "SELECT id FROM schema_migrations ORDER BY id"
    );
    expect(repeated.rows).toEqual(applied.rows);
  });

  it("upgrades a beta legacy schema before instance administration runs", async () => {
    const db = await openDatabase("memory");
    resources.push(() => db.end());
    await bootstrapLegacyBaseline(db);
    const userId = randomUUID();
    const connectorId = randomUUID();
    await db.query(
      "INSERT INTO users (id, email, name) VALUES ($1, $2, 'Existing user')",
      [userId, "existing@example.com"]
    );
    await db.query(
      `INSERT INTO connectors (id, user_id, name, token_hash)
       VALUES ($1, $2, 'Existing computer', 'existing-connector')`,
      [connectorId, userId]
    );
    const service = new InstanceAdminService(db);

    await expect(service.listUsers())
      .rejects.toThrow("revoked_at");

    await runControlPlaneMigrations(db);

    await expect(service.listUsers()).resolves.toMatchObject({
      users: [{
        id: userId,
        status: "active",
        active_connectors: 1
      }]
    });
    await expect(service.suspendUser(userId, {
      operationId: randomUUID(),
      actor: "operator:test",
      reason: "Exercise the upgraded containment schema"
    })).resolves.toMatchObject({
      user_id: userId,
      status: "suspended",
      changed: true,
      revoked: {
        connectors: 1
      }
    });
    const upgradedColumns = await db.query<{
      table_name: string;
      column_name: string;
    }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE (table_name = 'sessions' AND column_name = 'client_name')
          OR (table_name IN (
            'connectors',
            'pairing_requests',
            'mirror_pairing_requests',
            'authority_adoption_requests'
          ) AND column_name = 'revoked_at')
       ORDER BY table_name, column_name`
    );
    expect(upgradedColumns.rows).toEqual([
      { table_name: "authority_adoption_requests", column_name: "revoked_at" },
      { table_name: "connectors", column_name: "revoked_at" },
      { table_name: "mirror_pairing_requests", column_name: "revoked_at" },
      { table_name: "pairing_requests", column_name: "revoked_at" },
      { table_name: "sessions", column_name: "client_name" }
    ]);
    const migration = await db.query<{ id: string }>(
      "SELECT id FROM schema_migrations WHERE id = '0002_instance_administration'"
    );
    expect(migration.rows).toEqual([{ id: "0002_instance_administration" }]);
  });

  it("upgrades a beta.8 schema without losing existing accounts or sessions", async () => {
    const db = await openDatabase("memory");
    resources.push(() => db.end());
    await db.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY,
        email text UNIQUE,
        name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE external_identities (
        provider text NOT NULL,
        subject text NOT NULL,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        login text,
        email text,
        email_verified boolean NOT NULL DEFAULT false,
        avatar_url text,
        last_login_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(provider, subject),
        UNIQUE(provider, user_id)
      );
      CREATE TABLE sessions (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash text NOT NULL UNIQUE,
        provider text NOT NULL DEFAULT 'session',
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE connectors (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name text NOT NULL,
        token_hash text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE pairing_requests (
        id uuid PRIMARY KEY,
        user_id uuid REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE mirror_pairing_requests (
        id uuid PRIMARY KEY,
        user_id uuid REFERENCES users(id) ON DELETE CASCADE,
        replica_id uuid
      );
      CREATE TABLE hosted_collections (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE hosted_replicas (
        id uuid PRIMARY KEY,
        collection_id uuid NOT NULL REFERENCES hosted_collections(id) ON DELETE CASCADE,
        revoked_at timestamptz
      );
      CREATE TABLE grants (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        hosted_replica_id uuid
      );
      CREATE TABLE audit_events (
        id uuid PRIMARY KEY,
        user_id uuid REFERENCES users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE authorization_requests (
        id uuid PRIMARY KEY
      );
    `);
    const userId = randomUUID();
    const sessionId = randomUUID();
    await db.query(
      "INSERT INTO users (id, email, name) VALUES ($1, $2, 'Existing user')",
      [userId, "Person@Example.com"]
    );
    await db.query(
      `INSERT INTO external_identities
         (provider, subject, user_id, email, email_verified)
       VALUES ('google', 'existing-subject', $1, $2, true)`,
      [userId, "Person@Example.com"]
    );
    await db.query(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, 'existing-session', now() + interval '30 days')`,
      [sessionId, userId]
    );

    await runControlPlaneMigrations(db);

    const account = await db.query<{
      email: string;
      suspended_at: Date | null;
      session_epoch: number;
    }>(
      "SELECT email, suspended_at, session_epoch FROM users WHERE id = $1",
      [userId]
    );
    expect(account.rows[0]).toMatchObject({
      email: "Person@Example.com",
      suspended_at: null,
      session_epoch: 1
    });
    const identity = await db.query<{
      normalized_email: string;
      email_normalization_version: number;
    }>(
      `SELECT normalized_email, email_normalization_version
       FROM external_identities WHERE user_id = $1`,
      [userId]
    );
    expect(identity.rows[0]).toEqual({
      normalized_email: "person@example.com",
      email_normalization_version: 1
    });
    const session = await db.query<{
      account_session_epoch: number;
      revoked_at: Date | null;
      last_seen_at: Date;
    }>(
      `SELECT account_session_epoch, revoked_at, last_seen_at
       FROM sessions WHERE id = $1`,
      [sessionId]
    );
    expect(session.rows[0]).toMatchObject({
      account_session_epoch: 1,
      revoked_at: null
    });
    expect(session.rows[0]?.last_seen_at).toBeInstanceOf(Date);
    const authTables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_name IN (
         'email_identities',
         'password_credentials',
         'account_agreements',
         'invitations',
         'authentication_challenges',
         'auth_rate_limit_buckets',
         'authentication_settings',
         'authentication_settings_history',
         'oauth_login_states',
         'account_action_tokens',
         'authority_adoption_requests',
         'operator_operations'
       )`
    );
    expect(new Set(authTables.rows.map(({ table_name }) => table_name))).toEqual(
      new Set([
        "email_identities",
        "password_credentials",
        "account_agreements",
        "invitations",
        "authentication_challenges",
        "auth_rate_limit_buckets",
        "authentication_settings",
        "authentication_settings_history",
        "oauth_login_states",
        "account_action_tokens",
        "authority_adoption_requests",
        "operator_operations"
      ])
    );
    const applied = await db.query<{ id: string }>(
      "SELECT id FROM schema_migrations ORDER BY id"
    );
    expect(applied.rows.map(({ id }) => id)).toEqual([
      "0000_legacy_baseline",
      "0001_collaboration_foundations",
      "0001a_authentication_foundations",
      "0002_instance_administration",
      "0003_authorization_request_collection",
      "0004_separate_application_keys",
      "0005_notification_contract_versions",
      "0006_notification_event_ids",
      "0007_beta_access_requests",
      "0007_oauth_login_state_foundation",
      "0008_account_management",
      "0009_grant_file_capabilities",
      "0010_beta_entitlements_and_email",
      "0011_application_authorization_trust"
    ]);
  });

  it("repairs the beta.13 production authorization schema additively", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    await db.query(
      "ALTER TABLE authorization_requests DROP COLUMN collection_id"
    );
    await db.query(
      `DELETE FROM schema_migrations
       WHERE id = '0003_authorization_request_collection'`
    );

    await runControlPlaneMigrations(db);

    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'authorization_requests'
         AND column_name = 'collection_id'`
    );
    expect(columns.rows).toEqual([{ column_name: "collection_id" }]);
    await expect(assertControlPlaneMigrationsCurrent(db)).resolves.toBeUndefined();
  });

  it("upgrades persisted notification contracts before they are read", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const userId = randomUUID();
    const applicationId = randomUUID();
    const collectionId = randomUUID();
    const grantId = randomUUID();
    const criterion = {
      id: "task.created",
      event: { id: "timer.fired", version: 1 },
      presentation: { title: "Task reminder" }
    };
    await db.query(
      "INSERT INTO users (id, email, name) VALUES ($1, $2, 'Owner')",
      [userId, `${userId}@example.com`]
    );
    await db.query(
      `INSERT INTO applications
         (id, canonical_identity, name, homepage, redirect_uris, notifications)
       VALUES ($1, $2, 'Tasks', 'https://tasks.example', '[]'::jsonb, $3::jsonb)`,
      [
        applicationId,
        `https://tasks.example/${applicationId}`,
        JSON.stringify({ criteria: [criterion] })
      ]
    );
    await db.query(
      `INSERT INTO hosted_collections (id, user_id, display_name, template)
       VALUES ($1, $2, 'Tasks', 'mdbase')`,
      [collectionId, userId]
    );
    await db.query(
      `INSERT INTO grants
         (id, user_id, application_id, hosted_collection_id, operations,
          notification_criteria)
       VALUES ($1, $2, $3, $4, '[]'::jsonb, $5::jsonb)`,
      [grantId, userId, applicationId, collectionId, JSON.stringify([criterion])]
    );
    await db.query(
      `DELETE FROM schema_migrations
       WHERE id IN (
         '0005_notification_contract_versions',
         '0006_notification_event_ids'
       )`
    );

    await runControlPlaneMigrations(db);

    const application = await db.query<{
      notifications: {
        criteria: Array<{ event: { id: string; version: unknown } }>;
      };
    }>("SELECT notifications FROM applications WHERE id = $1", [applicationId]);
    const grant = await db.query<{
      notification_criteria: Array<{
        event: { id: string; version: unknown };
      }>;
    }>("SELECT notification_criteria FROM grants WHERE id = $1", [grantId]);
    expect(application.rows[0]?.notifications.criteria[0]?.event.version)
      .toBe("1.0.0");
    expect(application.rows[0]?.notifications.criteria[0]?.event.id)
      .toBe("mdbase.runtime.timer.fired");
    expect(grant.rows[0]?.notification_criteria[0]?.event.version)
      .toBe("1.0.0");
    expect(grant.rows[0]?.notification_criteria[0]?.event.id)
      .toBe("mdbase.runtime.timer.fired");
  });

  it("fails closed when an application starts before pre-deploy migration", async () => {
    const db = await openDatabase("memory");
    resources.push(() => db.end());
    await expect(assertControlPlaneMigrationsCurrent(db))
      .rejects.toThrow();
  });

  it("backfills the authorizing user for replicas created before attribution", async () => {
    const db = await openDatabase("memory");
    resources.push(() => db.end());
    await bootstrapLegacyBaseline(db);
    const userId = randomUUID();
    const collectionId = randomUUID();
    const replicaId = randomUUID();
    await db.query(
      "INSERT INTO users (id, email, name) VALUES ($1, $2, 'Owner')",
      [userId, "replica-owner@example.com"]
    );
    await db.query(
      `INSERT INTO hosted_collections (id, user_id, display_name, template)
       VALUES ($1, $2, 'Existing', 'mdbase')`,
      [collectionId, userId]
    );
    await db.query(
      `INSERT INTO hosted_replicas (id, collection_id, name, mode)
       VALUES ($1, $2, 'Old mirror', 'read_only')`,
      [replicaId, collectionId]
    );

    await runControlPlaneMigrations(db);

    const replica = await db.query<{ authorized_user_id: string }>(
      "SELECT authorized_user_id FROM hosted_replicas WHERE id = $1",
      [replicaId]
    );
    expect(replica.rows[0].authorized_user_id).toBe(userId);
  });

  it("rejects an applied migration whose contents changed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "connect-migrations-"));
    resources.push(() => rm(directory, { recursive: true, force: true }));
    await writeFile(
      join(directory, "0001_test.sql"),
      "CREATE TABLE migration_fixture (id text PRIMARY KEY);\n"
    );
    const db = await openDatabase("memory");
    resources.push(() => db.end());
    await runControlPlaneMigrations(db, { directory });
    await writeFile(
      join(directory, "0001_test.sql"),
      "CREATE TABLE changed_fixture (id text PRIMARY KEY);\n"
    );

    await expect(runControlPlaneMigrations(db, { directory }))
      .rejects.toThrow("changed after it was applied");
  });

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
