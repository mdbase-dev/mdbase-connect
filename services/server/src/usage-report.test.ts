import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { AuthAdminUsageError, runAuthAdminCommand } from "./auth-admin.js";
import { createDatabase, type DatabasePool } from "./db.js";
import type { HostedProviderClient } from "./hosted-provider.js";
import { pruneUsageHistory, USAGE_RETENTION_DAYS } from "./usage-report.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("usage report", () => {
  it("derives the activation funnel, consent outcomes, and per-application usage without identities", async () => {
    const db = await database();
    const alice = await user(db, "alice@example.com", 60);
    const bob = await user(db, "bob@example.com", 2);
    const carol = await user(db, "carol@example.com", 1);
    const dana = await user(db, "dana@example.com", 100);

    const invitation = randomUUID();
    await db.query(
      `INSERT INTO invitations
         (id, email, normalized_email, token_hash, created_by, expires_at,
          accepted_by_user_id, accepted_at)
       VALUES ($1, 'alice@example.com', 'alice@example.com', 'invite-token',
         'operator:test', now() + interval '7 days', $2, now())`,
      [invitation, alice]
    );
    await betaRequest(db, "alice@example.com", 70, invitation);
    await betaRequest(db, "bob@example.com", 5);
    await betaRequest(db, "dana@example.com", 10);
    await betaRequest(db, "waiting@example.com", 3);

    const connector = randomUUID();
    await db.query(
      `INSERT INTO connectors (id, user_id, name, token_hash)
       VALUES ($1, $2, 'Laptop', 'connector-token')`,
      [connector, alice]
    );
    const localCollection = randomUUID();
    await db.query(
      `INSERT INTO collections
         (id, user_id, connector_id, local_id, display_name, spec_version, created_at)
       VALUES ($1, $2, $3, $4, 'Notes', '0.3.0', NULL)`,
      [localCollection, alice, connector, randomUUID()]
    );
    const hostedCollection = randomUUID();
    await db.query(
      `INSERT INTO hosted_collections (id, user_id, display_name, template)
       VALUES ($1, $2, 'Hosted', 'blank')`,
      [hostedCollection, bob]
    );

    const tasksV1 = await application(db, "dev.tasks", "v1", "Tasks", 30);
    const tasksV2 = await application(db, "dev.tasks", "v2", "TaskNotes", 1);
    const reader = await application(db, "dev.reader", "v1", "Reader", 1);

    const aliceTasks = await grant(db, alice, tasksV1, { collectionId: localCollection, ageDays: 50 });
    await grant(db, bob, tasksV2, { hostedCollectionId: hostedCollection, ageDays: 2, revokedDaysAgo: 1 });
    await grant(db, bob, reader, { hostedCollectionId: hostedCollection, ageDays: 2 });
    await db.query(
      `INSERT INTO access_tokens (id, token_hash, grant_id, expires_at)
       VALUES ($1, 'access-token', $2, now() + interval '1 hour')`,
      [randomUUID(), aliceTasks]
    );
    await db.query(
      `INSERT INTO protocol_usage_telemetry
         (user_id, surface, protocol_axis, protocol_version, sample_count)
       VALUES ($1, 'direct', 'operation_transport', 3, 12)`,
      [alice]
    );

    const retryingBrowser = randomUUID();
    const abandoningBrowser = randomUUID();
    await authorization(db, tasksV1, {
      userId: alice, expiresInMinutes: -60, outcome: "completed", installationId: retryingBrowser
    });
    await authorization(db, reader, { userId: bob, expiresInMinutes: -60, outcome: "denied" });
    await authorization(db, tasksV2, {
      userId: carol, expiresInMinutes: -60, installationId: retryingBrowser
    });
    await authorization(db, tasksV2, {
      userId: null, expiresInMinutes: -60, installationId: abandoningBrowser
    });
    await authorization(db, tasksV2, {
      userId: null, expiresInMinutes: 10, installationId: abandoningBrowser, flow: "device_code"
    });
    await authorization(db, tasksV1, { userId: alice, expiresInMinutes: -60 * 24 * 60 });

    await pairing(db, { ageMinutes: 60, approved: true, consumed: true });
    await pairing(db, { ageMinutes: 60, approved: false, consumed: false });
    await pairing(db, { ageMinutes: 60 * 24 * 60, approved: false, consumed: false });

    const report = await runAuthAdminCommand(
      ["usage", "report", "--days", "30"],
      { db, defaultRegistrationMode: "closed" }
    ) as Record<string, any>;

    expect(report.accounts).toEqual({ total: 4, suspended: 0, created_in_window: 2 });
    expect(report.activation).toEqual({
      all_accounts: {
        accounts: 4, paired_computer: 1, collection: 2, grant: 2, active_in_window: 1
      },
      created_in_window: {
        accounts: 2, paired_computer: 0, collection: 1, grant: 1, active_in_window: 0
      }
    });
    expect(report.beta).toMatchObject({
      requests: { total: 4, pending: 3, invited: 1 },
      invitations: { active: 0, accepted: 1, revoked: 0, expired: 0, missing: 0 },
      accounts: {
        created_from_beta: 2,
        created_in_window: 1,
        preexisting: 1,
        request_to_signup_percent: 50,
        invited_to_signup_percent: 100
      },
      activation: {
        accounts: 2, paired_computer: 1, collection: 2, grant: 2, active_in_window: 1
      },
      recent_signups: [{
        created_at: expect.any(String),
        paired_computer: false,
        collection: true,
        grant: true,
        active_in_window: false
      }]
    });
    expect(report.consent).toEqual({
      started: 5, approved: 1, denied: 1, abandoned: 2, abandoned_before_sign_in: 1, pending: 1,
      installations: 3,
      installations_approved: 1,
      installations_abandoned_only: 1,
      abandoned_from_installations_that_approved: 1
    });
    expect(report.consent_by_flow).toEqual({
      authorization_code: {
        started: 4, approved: 1, denied: 1, abandoned: 2, abandoned_before_sign_in: 1, pending: 0,
        installations: 3,
        installations_approved: 1,
        installations_abandoned_only: 1,
        abandoned_from_installations_that_approved: 1
      },
      device_code: {
        started: 1, approved: 0, denied: 0, abandoned: 0, abandoned_before_sign_in: 0, pending: 1,
        installations: 1,
        installations_approved: 0,
        installations_abandoned_only: 0,
        abandoned_from_installations_that_approved: 0
      }
    });
    expect(report.pairing).toEqual({
      started: 2, approved: 1, completed: 1, expired_unapproved: 1, pending: 0
    });
    expect(report.collections).toEqual({
      local: { registered: 1, registered_in_window: 0, registration_time_unknown: 1 },
      hosted: { total: 1, created_in_window: 1 }
    });
    // Without a configured provider, hosted use is unknown rather than zero.
    expect(report.transport_users_in_window).toEqual({ direct: 1, relay: 0, hosted: null });
    expect(report.applications).toEqual([
      {
        family: "bundle:dev.tasks",
        name: "TaskNotes",
        distribution: "portable",
        active_users_in_window: 1,
        users_with_active_grant: 1,
        active_grants: 1,
        local_active_grants: 1,
        hosted_active_grants: 0,
        approved_in_window: 1,
        revoked_in_window: 1,
        consent: {
          started: 4, approved: 1, denied: 0, abandoned: 2,
          abandoned_before_sign_in: 1, pending: 1,
          installations: 2,
          installations_approved: 1,
          installations_abandoned_only: 1,
          abandoned_from_installations_that_approved: 1
        }
      },
      {
        family: "bundle:dev.reader",
        name: "Reader",
        distribution: "portable",
        active_users_in_window: 0,
        users_with_active_grant: 1,
        active_grants: 1,
        local_active_grants: 0,
        hosted_active_grants: 1,
        approved_in_window: 1,
        revoked_in_window: 0,
        consent: {
          started: 1, approved: 0, denied: 1, abandoned: 0,
          abandoned_before_sign_in: 0, pending: 0,
          installations: 1,
          installations_approved: 0,
          installations_abandoned_only: 0,
          abandoned_from_installations_that_approved: 0
        }
      }
    ]);

    const serialized = JSON.stringify(report);
    for (const hidden of [
      alice, bob, carol, dana, aliceTasks, localCollection, hostedCollection,
      retryingBrowser, abandoningBrowser
    ]) {
      expect(serialized).not.toContain(hidden);
    }
    expect(serialized).not.toContain("@example.com");
  });

  it("tracks weekly signup cohorts by token activity in each following week", async () => {
    const db = await database();
    const app = await application(db, "dev.tasks", "v1", "Tasks", 30);
    const returning = await user(db, "returning@example.com", 10);
    const lapsed = await user(db, "lapsed@example.com", 10);
    const recent = await user(db, "recent@example.com", 2);
    await user(db, "outside@example.com", 40);
    for (const [owner, tokenDaysAgo] of [
      [returning, [9, 0]],
      [lapsed, [9]],
      [recent, [0]]
    ] as const) {
      const collection = randomUUID();
      await db.query(
        `INSERT INTO hosted_collections (id, user_id, display_name, template)
         VALUES ($1, $2, 'Hosted', 'blank')`,
        [collection, owner]
      );
      const grantId = await grant(db, owner, app, { hostedCollectionId: collection, ageDays: 10 });
      for (const daysAgo of tokenDaysAgo) {
        await db.query(
          `INSERT INTO access_tokens (id, token_hash, grant_id, expires_at, created_at)
           VALUES ($1, $2, $3, now(), now() - ($4::text || ' days')::interval)`,
          [randomUUID(), randomUUID(), grantId, daysAgo]
        );
      }
    }

    const report = await runAuthAdminCommand(
      ["usage", "report", "--days", "21"],
      { db, defaultRegistrationMode: "closed" }
    ) as Record<string, any>;

    // Three whole weeks ending today; signups 10 days ago fall in the middle
    // cohort, whose second week is the current one.
    expect(report.retention.cohorts).toEqual([
      { starts_on: expect.any(String), accounts: 0, active_by_week: [0, 0, 0] },
      { starts_on: expect.any(String), accounts: 2, active_by_week: [2, 1] },
      { starts_on: expect.any(String), accounts: 1, active_by_week: [1] }
    ]);
    const starts = report.retention.cohorts.map((cohort: { starts_on: string }) =>
      Date.parse(`${cohort.starts_on}T00:00:00Z`)
    );
    expect(starts[1] - starts[0]).toBe(7 * 24 * 60 * 60 * 1_000);
    expect(starts[2] - starts[1]).toBe(7 * 24 * 60 * 60 * 1_000);
  });

  it("counts hosted users from provider telemetry mapped through storage accounts", async () => {
    const db = await database();
    const hostedUser = await user(db, "hosted@example.com", 3);
    const staleUser = await user(db, "stale@example.com", 90);
    const hostedAccount = randomUUID();
    const staleAccount = randomUUID();
    for (const [owner, account] of [[hostedUser, hostedAccount], [staleUser, staleAccount]]) {
      await db.query(
        `INSERT INTO account_storage_accounts
           (user_id, provider_account_id, entitlement_revision)
         VALUES ($1, $2, 1)`,
        [owner, account]
      );
    }
    const now = new Date();
    const long = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1_000);
    const hostedProvider = {
      async protocolUsage() {
        return {
          entries: [
            { account_id: hostedAccount, protocol_version: 3, sample_count: 4,
              first_seen_at: now.toISOString(), last_seen_at: now.toISOString() },
            { account_id: staleAccount, protocol_version: 3, sample_count: 1,
              first_seen_at: long.toISOString(), last_seen_at: long.toISOString() }
          ],
          unbound_application_replicas: 0,
          v2_recovery_application_replicas: 0
        };
      }
    } as unknown as HostedProviderClient;

    const report = await runAuthAdminCommand(
      ["usage", "report", "--days", "30"],
      { db, defaultRegistrationMode: "closed", hostedProvider }
    ) as Record<string, any>;

    expect(report.transport_users_in_window).toEqual({ direct: 0, relay: 0, hosted: 1 });
    expect(report.activation.all_accounts.active_in_window).toBe(1);
    expect(JSON.stringify(report)).not.toContain(hostedAccount);
  });

  it("rejects an unsupported window", async () => {
    const db = await database();
    await expect(runAuthAdminCommand(
      ["usage", "report", "--days", "366"],
      { db, defaultRegistrationMode: "closed" }
    )).rejects.toBeInstanceOf(AuthAdminUsageError);
  });
});

describe("usage retention", () => {
  it("deletes account-linked usage history only after the retention window", async () => {
    const db = await database();
    const owner = await user(db, "owner@example.com", 800);
    const app = await application(db, "dev.tasks", "v1", "Tasks", 800);
    const collection = randomUUID();
    await db.query(
      `INSERT INTO hosted_collections (id, user_id, display_name, template)
       VALUES ($1, $2, 'Hosted', 'blank')`,
      [collection, owner]
    );
    const grantId = await grant(db, owner, app, { hostedCollectionId: collection, ageDays: 800 });
    const old = `now() - interval '${USAGE_RETENTION_DAYS + 1} days'`;
    const recent = "now() - interval '1 day'";
    for (const expiry of [old, recent]) {
      await db.query(
        `INSERT INTO access_tokens (id, token_hash, grant_id, expires_at)
         VALUES ($1, $2, $3, ${expiry})`,
        [randomUUID(), randomUUID(), grantId]
      );
      await db.query(
        `INSERT INTO refresh_tokens (id, token_hash, grant_id, expires_at)
         VALUES ($1, $2, $3, ${expiry})`,
        [randomUUID(), randomUUID(), grantId]
      );
      await db.query(
        `INSERT INTO pairing_requests (id, secret_hash, connector_name, expires_at)
         VALUES ($1, $2, 'Laptop', ${expiry})`,
        [randomUUID(), randomUUID()]
      );
    }
    await authorization(db, app, { userId: owner, expiresInMinutes: -(USAGE_RETENTION_DAYS + 1) * 24 * 60 });
    await authorization(db, app, { userId: owner, expiresInMinutes: -60 });
    await authorization(db, app, {
      userId: owner,
      expiresInMinutes: -(USAGE_RETENTION_DAYS + 1) * 24 * 60,
      grantId
    });
    await db.query(
      `INSERT INTO protocol_usage_telemetry
         (user_id, surface, protocol_axis, protocol_version, sample_count, last_seen_at)
       VALUES ($1, 'relay', 'operation_transport', 3, 1, ${old}),
              ($1, 'direct', 'operation_transport', 3, 1, ${recent})`,
      [owner]
    );

    expect(await pruneUsageHistory(db)).toEqual({
      protocol_usage_telemetry: 1,
      access_tokens: 1,
      refresh_tokens: 1,
      authorization_requests: 1,
      pairing_requests: 1
    });
    expect(await pruneUsageHistory(db)).toEqual({
      protocol_usage_telemetry: 0,
      access_tokens: 0,
      refresh_tokens: 0,
      authorization_requests: 0,
      pairing_requests: 0
    });
    const remaining = await db.query<{ count: string | number }>(
      "SELECT count(*) AS count FROM authorization_requests WHERE grant_id = $1",
      [grantId]
    );
    expect(Number(remaining.rows[0]!.count)).toBe(1);
  });
});

async function database(): Promise<DatabasePool> {
  const db = await createDatabase("memory");
  resources.push(() => db.end());
  return db;
}

async function user(db: DatabasePool, email: string, ageDays: number): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO users (id, email, name, created_at)
     VALUES ($1, $2, 'Person', now() - ($3::text || ' days')::interval)`,
    [id, email, ageDays]
  );
  await db.query(
    `INSERT INTO email_identities
       (id, user_id, email, normalized_email, verified_at, is_primary)
     VALUES ($1, $2, $3, $3, now(), true)`,
    [randomUUID(), id, email]
  );
  return id;
}

async function betaRequest(
  db: DatabasePool,
  email: string,
  ageDays: number,
  invitationId?: string
): Promise<void> {
  await db.query(
    `INSERT INTO beta_access_requests
       (id, email, normalized_email, invitation_id, invited_at, requested_at)
     VALUES ($1, $2, $2, $3::uuid,
       CASE WHEN $3::uuid IS NULL THEN NULL ELSE now() END,
       now() - ($4::text || ' days')::interval)`,
    [randomUUID(), email, invitationId ?? null, ageDays]
  );
}

async function application(
  db: DatabasePool,
  declaration: string,
  version: string,
  name: string,
  updatedDaysAgo: number
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO applications
       (id, canonical_identity, family_identity, distribution, name, homepage,
        redirect_uris, updated_at)
     VALUES ($1, $2, $3, 'portable', $4, '', '[]'::jsonb,
       now() - ($5::text || ' days')::interval)`,
    [id, `bundle:${declaration}:sha256:${version}`, `bundle:${declaration}`, name, updatedDaysAgo]
  );
  return id;
}

async function grant(
  db: DatabasePool,
  userId: string,
  applicationId: string,
  input: {
    collectionId?: string;
    hostedCollectionId?: string;
    ageDays: number;
    revokedDaysAgo?: number;
  }
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO grants
       (id, user_id, application_id, collection_id, hosted_collection_id,
        operations, application_authorization, application_installation_id,
        created_at, revoked_at)
     VALUES ($1, $2, $3, $4, $5, '[]'::jsonb,
       '{"binding":{"protocol_version":5}}'::jsonb, $6,
       now() - ($7::text || ' days')::interval,
       CASE WHEN $8::integer IS NULL THEN NULL
         ELSE now() - ($8::text || ' days')::interval END)`,
    [
      id,
      userId,
      applicationId,
      input.collectionId ?? null,
      input.hostedCollectionId ?? null,
      randomUUID(),
      input.ageDays,
      input.revokedDaysAgo ?? null
    ]
  );
  return id;
}

async function authorization(
  db: DatabasePool,
  applicationId: string,
  input: {
    userId: string | null;
    expiresInMinutes: number;
    outcome?: "completed" | "denied";
    grantId?: string;
    installationId?: string;
    flow?: "authorization_code" | "device_code";
  }
): Promise<void> {
  await db.query(
    `INSERT INTO authorization_requests
       (id, user_id, application_id, requested_operations,
        application_authorization, application_installation_id, grant_id,
        expires_at, completed_at, denied_at, flow)
     VALUES ($1, $2, $3, '[]'::jsonb,
       '{"binding":{"protocol_version":5}}'::jsonb, $4, $5,
       now() + ($6::text || ' minutes')::interval,
       CASE WHEN $7 = 'completed' THEN now() ELSE NULL END,
       CASE WHEN $7 = 'denied' THEN now() ELSE NULL END, $8)`,
    [
      randomUUID(),
      input.userId,
      applicationId,
      input.installationId ?? randomUUID(),
      input.grantId ?? null,
      input.expiresInMinutes,
      input.outcome ?? "none",
      input.flow ?? "authorization_code"
    ]
  );
}

async function pairing(
  db: DatabasePool,
  input: { ageMinutes: number; approved: boolean; consumed: boolean }
): Promise<void> {
  await db.query(
    `INSERT INTO pairing_requests
       (id, secret_hash, connector_name, created_at, expires_at, approved_at, consumed_at)
     VALUES ($1, $2, 'Laptop',
       now() - ($3::text || ' minutes')::interval,
       now() - ($3::text || ' minutes')::interval + interval '10 minutes',
       CASE WHEN $4 THEN now() ELSE NULL END,
       CASE WHEN $5 THEN now() ELSE NULL END)`,
    [randomUUID(), randomUUID(), input.ageMinutes, input.approved, input.consumed]
  );
}
