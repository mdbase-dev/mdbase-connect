import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AuthAdminUsageError,
  InvitationDeliveryError,
  runAuthAdminCommand
} from "./auth-admin.js";
import { createDatabase } from "./db.js";
import {
  EmailDeliveryError,
  type EmailTransport
} from "./features/email/email.js";
import { tokenHash } from "./security.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("authentication operator command", () => {
  it("creates, shows, tests and schedules a stored announcement", async () => {
    const context = await fixture();
    const account = async (name: string, beta = false) => {
      const id = randomUUID();
      await context.db.query("INSERT INTO users (id, email, name) VALUES ($1, NULL, $2)", [id, name]);
      await context.db.query(
        `INSERT INTO email_identities
           (id, user_id, email, normalized_email, normalization_version, verified_at, is_primary)
         VALUES ($1, $2, $3, $3, 1, now(), true)`,
        [randomUUID(), id, `${name}@example.com`]
      );
      if (beta) {
        await context.db.query(
          `INSERT INTO account_entitlement_grants (id, user_id, profile_code, source, source_reference)
           VALUES ($1, $2, 'beta_v1', 'operator', 'test')`,
          [randomUUID(), id]
        );
      }
    };
    await account("standard");
    await account("beta", true);
    const mutation = ["--operation-id", randomUUID(), "--actor", "operator:test", "--reason", "Announce Plus"];
    const run = (...argv: string[]) => runAuthAdminCommand(["announcements", ...argv], context);

    await expect(run("preview", "--announcement", "plus", "--all", "enabled"))
      .rejects.toThrow(/No announcement named plus/);
    expect(await run("create", "--announcement", "plus", "--subject", "mdbase Plus",
      "--body", "Hi {name},\n\nPlus is here.", "--beta-body", "Hi {name},\n\nYour beta allowance stays.",
      ...mutation)).toMatchObject({ created: true, announcement: { version: 1 } });
    expect(await run("show", "--announcement", "plus", "--user", "beta@example.com")).toEqual({
      version: 1, variant: "beta", subject: "mdbase Plus", text: "Hi beta,\n\nYour beta allowance stays."
    });
    expect(await run("show", "--announcement", "plus", "--user", "standard@example.com"))
      .toMatchObject({ variant: "standard", text: "Hi standard,\n\nPlus is here." });
    await expect(run("show", "--announcement", "plus", "--version", "2"))
      .rejects.toThrow(/at that version/);

    expect(await run("test-send", "--announcement", "plus", "--user", "beta@example.com", ...mutation))
      .toMatchObject({ version: 1, queued: true });
    expect(await run("preview", "--announcement", "plus", "--all", "enabled"))
      .toEqual({ version: 1, recipients: 2, already_scheduled: 0 });
    await expect(run("schedule", "--announcement", "plus", ...mutation))
      .rejects.toThrow(/--all/);
    expect(await run("schedule", "--announcement", "plus", "--all", "enabled", ...mutation))
      .toMatchObject({ version: 1, recipients: 2, already_scheduled: 0 });
    expect(await run("preview", "--announcement", "plus", "--user", "standard@example.com"))
      .toEqual({ version: 1, recipients: 0, already_scheduled: 1 });
    expect((await context.db.query(
      "SELECT message_kind, template_version, category FROM email_jobs GROUP BY message_kind, template_version, category"
    )).rows).toEqual([{ message_kind: "announcement.plus", template_version: 1, category: "onboarding" }]);
  });

  it("admits an explicit LAB legacy fixture invitation and refuses it elsewhere", async () => {
    const context = await fixture(); await configurePolicy(context);
    const argv = ["invite", "create", "--email", "admin-fixture@lab.invalid", "--actor", "operator:test",
      "--reason", "[test] migration rehearsal", "--entitlement-profile", "none", "--account-backend", "legacy"];
    for (const environment of [undefined, "dev", "staging", "production"]) {
      await expect(runAuthAdminCommand(argv, { ...context, ...(environment ? { environment } : {}) })).rejects.toThrow(/LAB \[test\] fixture/);
    }
    expect((await context.db.query("SELECT id FROM invitations")).rows).toEqual([]);
    const result = await runAuthAdminCommand(argv, { ...context, environment: "lab" }) as { invitation: { id: string; account_backend: string } };
    expect(result.invitation.account_backend).toBe("legacy");
    expect((await context.db.query("SELECT account_backend FROM invitations WHERE id = $1", [result.invitation.id])).rows)
      .toEqual([{ account_backend: "legacy" }]);
    await expect(runAuthAdminCommand([...argv.slice(0, -1), "next"], { ...context, environment: "lab" })).rejects.toThrow(/Only --account-backend legacy/);
  });
  it("admits a staging-marked legacy fixture through the same invitation command", async () => {
    const context = await fixture(); await configurePolicy(context);
    const argv = ["invite", "create", "--email", "seeder-admin-0@staging.invalid", "--actor", "operator:test",
      "--reason", "[test] staging migration fixture", "--entitlement-profile", "none", "--account-backend", "legacy"];
    for (const environment of [undefined, "dev", "lab", "production"]) {
      await expect(runAuthAdminCommand(argv, { ...context, environment })).rejects.toThrow(TypeError);
    }
    expect((await context.db.query("SELECT id FROM invitations")).rows).toEqual([]);
    const result = await runAuthAdminCommand(argv, { ...context, environment: "staging" }) as { invitation: { id: string; account_backend: string } };
    expect(result.invitation.account_backend).toBe("legacy");
    expect((await context.db.query("SELECT account_backend FROM invitations WHERE id = $1", [result.invitation.id])).rows)
      .toEqual([{ account_backend: "legacy" }]);
  });
  it("updates policy with optimistic concurrency and preserves omitted settings", async () => {
    const context = await fixture();
    const updated = await runAuthAdminCommand([
      "policy",
      "update",
      "--expected-revision",
      "0",
      "--registration",
      "invite",
      "--password-auth",
      "enabled",
      "--terms-version",
      "terms-2026-07-25",
      "--privacy-version",
      "privacy-2026-07-25",
      "--actor",
      "operator:test",
      "--reason",
      "Enable private beta invitations"
    ], context);
    expect(updated).toEqual({
      policy: expect.objectContaining({
        revision: 1,
        registrationMode: "invite",
        passwordAuthEnabled: true,
        emailDeliveryEnabled: false,
        termsVersion: "terms-2026-07-25",
        privacyVersion: "privacy-2026-07-25"
      })
    });
    expect(await runAuthAdminCommand([
      "policy",
      "history",
      "--limit",
      "1"
    ], context)).toEqual({
      revisions: [
        expect.objectContaining({
          revision: 1,
          updated_by: "operator:test",
          update_reason: "Enable private beta invitations"
        })
      ],
      next_before_revision: null
    });
    await expect(runAuthAdminCommand([
      "policy",
      "update",
      "--expected-revision",
      "0",
      "--email-delivery",
      "enabled",
      "--actor",
      "operator:stale",
      "--reason",
      "A stale concurrent change"
    ], context)).rejects.toThrow(/changed before/);
  });

  it("creates a one-time invitation URL without storing the raw token", async () => {
    const context = await fixture();
    await configurePolicy(context);
    const result = await runAuthAdminCommand([
      "invite",
      "create",
      "--email",
      "Person@Example.com",
      "--actor",
      "operator:test",
      "--reason",
      "Invite the first private beta account",
      "--entitlement-profile", "beta_v1"
    ], context) as {
      invitation: {
        token: string;
        invitation_url: string;
        email: string;
      };
      sensitive: boolean;
    };
    expect(result.sensitive).toBe(true);
    expect(result.invitation.email).toBe("Person@Example.com");
    expect(result.invitation.invitation_url).toBe(
      `https://connect.example/signup#invitation=${encodeURIComponent(result.invitation.token)}`
    );
    const stored = await context.db.query<{ token_hash: string }>(
      "SELECT token_hash FROM invitations"
    );
    expect(stored.rows[0]?.token_hash).toBe(tokenHash(result.invitation.token));
    expect(JSON.stringify(stored.rows)).not.toContain(result.invitation.token);
  });

  it("requires an explicit invitation entitlement before replacing or delivering anything", async () => {
    const context = await fixture();
    await configurePolicy(context);
    const command = [
      "invite", "create", "--email", "person@example.com",
      "--actor", "operator:test", "--reason", "Explicit local-only invitation"
    ];
    const created = await runAuthAdminCommand([
      ...command, "--entitlement-profile", "none"
    ], context) as { invitation: { id: string; entitlement_profile: string | null } };
    expect(created.invitation.entitlement_profile).toBeNull();
    // Exercise the same request-envelope entry point used by managed jobs.
    await expect(runAuthAdminCommand([
      "request", Buffer.from(JSON.stringify(command)).toString("base64url")
    ], context)).rejects.toThrow(/entitlement-profile/);
    const invitations = await context.db.query("SELECT id, revoked_at FROM invitations");
    expect(invitations.rows).toEqual([{ id: created.invitation.id, revoked_at: null }]);
    expect((await context.db.query("SELECT * FROM invitation_entitlements")).rows).toHaveLength(0);

  });

  it("does not silently resend a legacy invitation without a profile", async () => {
    const base = await fixture();
    await configurePolicy(base);
    const send = vi.fn().mockResolvedValue({ provider: "test", messageId: "replacement" });
    const context = { ...base, emailTransport: { send } };
    const created = await runAuthAdminCommand([
      "invite", "create", "--email", "person@example.com",
      "--entitlement-profile", "none", "--actor", "operator:test",
      "--reason", "Model a legacy invitation without storage"
    ], context) as { invitation: { id: string } };
    const resend = [
      "invite", "resend", "--id", created.invitation.id,
      "--actor", "operator:test", "--reason", "Repair invitation entitlement"
    ];
    await expect(runAuthAdminCommand(resend, context)).rejects.toThrow(/Resend requires --entitlement-profile/);
    expect(send).not.toHaveBeenCalled();
    expect((await context.db.query("SELECT id, revoked_at FROM invitations")).rows)
      .toEqual([{ id: created.invitation.id, revoked_at: null }]);
    const repaired = await runAuthAdminCommand([
      ...resend, "--entitlement-profile", "beta_v1"
    ], context) as { invitation: { entitlement_profile: string } };
    expect(repaired.invitation.entitlement_profile).toBe("beta_v1");
    expect(send).toHaveBeenCalledOnce();
  });

  it("lists beta requests and marks a matching request when invited", async () => {
    const context = await fixture();
    await context.db.query(
      `INSERT INTO beta_access_requests
         (id, email, normalized_email, email_normalization_version)
       VALUES ('10000000-0000-4000-8000-000000000071',
         'Person@Example.com', 'person@example.com', 1)`
    );
    expect(await runAuthAdminCommand([
      "beta",
      "list",
      "--status",
      "pending"
    ], context)).toEqual({
      requests: [expect.objectContaining({
        email: "Person@Example.com",
        status: "pending"
      })],
      next_cursor: null
    });

    await configurePolicy(context);
    const created = await runAuthAdminCommand([
      "invite",
      "create",
      "--email",
      "person@example.com",
      "--actor",
      "operator:test",
      "--reason",
      "Invite the next beta participant",
      "--entitlement-profile", "beta_v1"
    ], context) as { invitation: { id: string } };
    expect(await runAuthAdminCommand([
      "beta",
      "list",
      "--status",
      "pending"
    ], context)).toEqual({ requests: [], next_cursor: null });
    const invited = await runAuthAdminCommand([
      "beta",
      "list",
      "--status",
      "invited"
    ], context) as {
      requests: Array<{
        status: string;
        invitation_id: string;
        invited_at: string;
      }>;
    };
    expect(invited.requests[0]).toMatchObject({
      status: "invited",
      invitation_id: created.invitation.id,
      invited_at: expect.any(String)
    });
  });

  it("rejects ambiguous or unsafe command input", async () => {
    const context = await fixture();
    await expect(runAuthAdminCommand([
      "policy",
      "update",
      "--expected-revision",
      "0",
      "--actor",
      "operator:test",
      "--reason",
      "No actual change"
    ], context)).rejects.toThrow(/setting change/);
    await expect(runAuthAdminCommand([
      "invite",
      "create",
      "--email"
    ], context)).rejects.toBeInstanceOf(AuthAdminUsageError);
  });

  it("delivers an invitation explicitly and reports provider failure with the recoverable token", async () => {
    const base = await fixture();
    await configurePolicy(base);
    let delivered: Parameters<EmailTransport["send"]> | null = null;
    const context = {
      ...base,
      emailTransport: {
        async send(...input: Parameters<EmailTransport["send"]>) {
          delivered = input;
          return { provider: "test", messageId: "message-123" };
        }
      }
    };
    const result = await runAuthAdminCommand([
      "invite",
      "create",
      "--email",
      "person@example.com",
      "--actor",
      "operator:test",
      "--reason",
      "Deliver the private beta invitation",
      "--entitlement-profile", "beta_v1",
      "--send-email",
      "enabled"
    ], context) as {
      delivery: { status: string; provider: string; message_id: string };
    };
    expect(result.delivery).toEqual({
      status: "sent",
      provider: "test",
      message_id: "message-123"
    });
    expect(delivered?.[0]).toMatchObject({
      to: "person@example.com",
      subject: "Your mdbase connect invitation"
    });
    expect(delivered?.[1]).toMatch(/^invitation\//);
    const recorded = await base.db.query<{
      send_count: number;
      last_sent_at: Date;
    }>(
      `SELECT send_count, last_sent_at FROM invitations
       WHERE normalized_email = 'person@example.com'`
    );
    expect(recorded.rows[0]?.send_count).toBe(1);
    expect(recorded.rows[0]?.last_sent_at).toBeInstanceOf(Date);

    const failing = {
      ...base,
      emailTransport: {
        async send() {
          throw new EmailDeliveryError("rate_limit_exceeded", true, 429);
        }
      }
    };
    const error = await runAuthAdminCommand([
      "invite",
      "create",
      "--email",
      "second@example.com",
      "--actor",
      "operator:test",
      "--reason",
      "Exercise safe delivery failure",
      "--entitlement-profile", "beta_v1",
      "--send-email",
      "enabled"
    ], failing).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(InvitationDeliveryError);
    if (!(error instanceof InvitationDeliveryError)) throw error;
    expect(error.output).toEqual(expect.objectContaining({
      invitation: expect.objectContaining({
        email: "second@example.com",
        token: expect.stringMatching(/^inv_/)
      }),
      delivery: {
        status: "failed",
        code: "rate_limit_exceeded",
        retryable: true
      }
    }));
    const audit = await base.db.query<{ event_type: string }>(
      `SELECT event_type FROM audit_events
       WHERE event_type LIKE 'invitation.%'
       ORDER BY created_at`
    );
    expect(audit.rows.map(({ event_type }) => event_type)).toEqual(
      expect.arrayContaining([
        "invitation.created",
        "invitation.sent",
        "invitation.delivery_failed"
      ])
    );
  });

  it("omits invitation credentials from managed delivery and replacement output", async () => {
    const base = await fixture();
    await configurePolicy(base);
    const deliveredSubjects: string[] = [];
    const context = {
      ...base,
      emailTransport: {
        async send(message: Parameters<EmailTransport["send"]>[0]) {
          deliveredSubjects.push(message.subject);
          return { provider: "test", messageId: randomMessageId() };
        }
      }
    };
    const created = await runAuthAdminCommand([
      "invite",
      "create",
      "--email",
      "private@example.com",
      "--actor",
      "operator:test",
      "--reason",
      "Private beta participant",
      "--entitlement-profile", "beta_v1",
      "--send-email",
      "enabled",
      "--token-output",
      "omitted"
    ], context) as {
      invitation: { id: string; email: string };
      sensitive: boolean;
    };
    expect(created.sensitive).toBe(false);
    expect(JSON.stringify(created)).not.toContain("inv_");
    expect(JSON.stringify(created)).not.toContain("invitation_url");

    const resent = await runAuthAdminCommand([
      "invite",
      "resend",
      "--id",
      created.invitation.id,
      "--actor",
      "operator:test",
      "--reason",
      "Replace the previous delivery",
      "--email-template",
      "signup-recovery"
    ], context) as {
      invitation: {
        id: string;
        replaces_invitation_id: string;
        email_template: string;
      };
      sensitive: boolean;
    };
    expect(resent.sensitive).toBe(false);
    expect(resent.invitation.id).not.toBe(created.invitation.id);
    expect(resent.invitation.replaces_invitation_id).toBe(
      created.invitation.id
    );
    expect(resent.invitation.email_template).toBe("signup_recovery");
    expect(deliveredSubjects).toEqual([
      "Your mdbase connect invitation",
      "A fresh mdbase connect invitation"
    ]);
    expect(JSON.stringify(resent)).not.toContain("inv_");
  });

  it("accepts a bounded request envelope for private operator wrappers", async () => {
    const context = await fixture();
    const userId = "10000000-0000-4000-8000-000000000099";
    await context.db.query(
      `INSERT INTO users (id, email, name)
       VALUES ($1, 'operator-target@example.com', 'Operator target')`,
      [userId]
    );
    const args = [
      "users",
      "suspend",
      "--user",
      "operator-target@example.com",
      "--operation-id",
      "20000000-0000-4000-8000-000000000099",
      "--actor",
      "operator:test",
      "--reason",
      "Exercise the managed request envelope"
    ];
    const envelope = Buffer.from(JSON.stringify(args)).toString("base64url");

    expect(await runAuthAdminCommand([
      "request",
      envelope
    ], context)).toEqual(expect.objectContaining({
      user_id: userId,
      status: "suspended"
    }));
    const users = await runAuthAdminCommand([
      "users",
      "list",
      "--status",
      "suspended"
    ], context) as { users: Array<{ id: string }> };
    expect(users.users.map((user) => user.id)).toContain(userId);
    await expect(runAuthAdminCommand([
      "request",
      Buffer.from(JSON.stringify(["request", envelope])).toString("base64url")
    ], context)).rejects.toBeInstanceOf(AuthAdminUsageError);
  });

  it("grants and reports durable Beta entitlements idempotently", async () => {
    const context = await fixture();
    const userId = "10000000-0000-4000-8000-000000000089";
    await context.db.query(
      `INSERT INTO users (id, email, name)
       VALUES ($1, 'beta-target@example.com', 'Beta target')`,
      [userId]
    );
    const command = [
      "entitlements", "grant",
      "--user", "beta-target@example.com",
      "--profile", "beta_v1",
      "--operation-id", "20000000-0000-4000-8000-000000000089",
      "--actor", "operator:test",
      "--reason", "Private beta storage"
    ];
    expect(await runAuthAdminCommand(command, context)).toEqual(
      expect.objectContaining({
        user_id: userId,
        changed: true,
        entitlementRevision: 1,
        reconciliation: null
      })
    );
    expect(await runAuthAdminCommand(command, context)).toEqual(
      expect.objectContaining({ changed: false, entitlementRevision: 1 })
    );
    const shown = await runAuthAdminCommand([
      "entitlements", "show", "--user", userId
    ], context) as { effective: { hostedStorageBytes: number }; grants: unknown[] };
    expect(shown.effective.hostedStorageBytes).toBe(1024 * 1024 * 1024);
    expect(shown.grants).toHaveLength(1);
    const grantedAudit = await context.db.query<{
      user_id: string;
      subject_id: string;
    }>(
      `SELECT user_id, subject_id FROM audit_events
       WHERE event_type = 'entitlement.granted' ORDER BY created_at`
    );
    expect(grantedAudit.rows).toEqual([
      { user_id: userId, subject_id: userId },
      { user_id: userId, subject_id: userId }
    ]);
  });

  it("grants a next account the operator plan without the legacy provider", async () => {
    const context = await fixture();
    const userId = "10000000-0000-4000-8000-000000000087";
    await context.db.query(
      `INSERT INTO users (id, email, name, account_backend)
       VALUES ($1, 'operator@example.com', 'Operator', 'next')`,
      [userId]
    );
    const result = await runAuthAdminCommand([
      "entitlements", "grant", "--user", userId, "--profile", "operator_v1",
      "--operation-id", "20000000-0000-4000-8000-000000000087",
      "--actor", "operator:test", "--reason", "Operator account storage"
    ], context);
    expect(result).toMatchObject({ user_id: userId, changed: true, reconciliation: null });
    const shown = await runAuthAdminCommand([
      "entitlements", "show", "--user", userId
    ], context) as { effective: { hostedStorageBytes: number; maxHostedCollections: number; maxSingleFileBytes: number } };
    expect(shown.effective).toMatchObject({
      hostedStorageBytes: 50 * 1024 ** 3,
      maxHostedCollections: 100,
      maxSingleFileBytes: 1024 ** 3
    });
  });

  it("reports privacy-minimal compatibility usage and fail-closed sunset gates", async () => {
    const context = await fixture();
    const userId = "10000000-0000-4000-8000-000000000079";
    const connectorId = "20000000-0000-4000-8000-000000000079";
    const applicationId = "30000000-0000-4000-8000-000000000079";
    const collectionId = "40000000-0000-4000-8000-000000000079";
    const grantId = "50000000-0000-4000-8000-000000000079";
    const providerAccountId = "60000000-0000-4000-8000-000000000079";
    await context.db.query(
      `INSERT INTO users (id, email, name)
       VALUES ($1, 'compatibility@example.com', 'Compatibility user')`,
      [userId]
    );
    await context.db.query(
      `INSERT INTO connectors
         (id, user_id, name, token_hash, connector_version, last_seen_at)
       VALUES ($1, $2, 'legacy connector', 'legacy-connector-token',
         '0.1.0-beta.55', now())`,
      [connectorId, userId]
    );
    await context.db.query(
      `INSERT INTO applications
         (id, canonical_identity, name, homepage, redirect_uris)
       VALUES ($1, 'https://tasks.example/app', 'Tasks',
         'https://tasks.example', '[]'::jsonb)`,
      [applicationId]
    );
    await context.db.query(
      `INSERT INTO hosted_collections
         (id, user_id, display_name, template)
       VALUES ($1, $2, 'Tasks', 'blank')`,
      [collectionId, userId]
    );
    await context.db.query(
      `INSERT INTO grants
         (id, user_id, application_id, hosted_collection_id, operations,
          application_authorization, application_installation_id)
       VALUES ($1, $2, $3, $4, '[]'::jsonb,
         '{"binding":{"protocol_version":4}}'::jsonb,
         '70000000-0000-4000-8000-000000000079')`,
      [grantId, userId, applicationId, collectionId]
    );
    await context.db.query(
      `INSERT INTO protocol_usage_telemetry
         (user_id, surface, protocol_axis, protocol_version, sample_count)
       VALUES ($1, 'relay', 'operation_transport', 2, 3)`,
      [userId]
    );
    await context.db.query(
      `INSERT INTO account_storage_accounts
         (user_id, provider_account_id, entitlement_revision)
       VALUES ($1, $2, 1)`,
      [userId, providerAccountId]
    );
    await context.db.query(
      `UPDATE schema_migrations
       SET applied_at = now() - interval '31 days'
       WHERE id = '0020_protocol_usage_telemetry'`
    );
    const report = await runAuthAdminCommand([
      "compatibility", "report", "--days", "30"
    ], context) as {
      telemetry: Array<{
        surface: string;
        protocol_version: number;
        samples: number;
        users: number;
      }>;
      connectors: {
        beta55_or_earlier_users: number;
        pre_beta57_users: number;
      };
      grants: { legacy_v4_users: number; recovery_v2_users: number };
      hosted: {
        unbound_application_replicas: number;
        v2_recovery_application_replicas: number;
      };
      sunset_gates: Array<{ name: string; pass: boolean; value: unknown }>;
      ready_to_remove_compatibility: boolean;
    };
    expect(report.telemetry).toEqual(expect.arrayContaining([
      expect.objectContaining({
        surface: "relay",
        protocol_version: 2,
        samples: 3,
        users: 1
      })
    ]));
    expect(report.connectors).toMatchObject({
      beta55_or_earlier_users: 1,
      pre_beta57_users: 1
    });
    expect(report.grants.legacy_v4_users).toBe(1);
    expect(report.grants.recovery_v2_users).toBe(0);
    expect(report.sunset_gates).toEqual(expect.arrayContaining([
      { name: "observation_window_complete", pass: true, value: expect.any(String) },
      { name: "no_recent_v2_usage", pass: false, value: 3 },
      { name: "no_active_pre_beta57_connectors", pass: false, value: 1 },
      { name: "no_active_v4_or_unknown_grants", pass: false, value: 1 },
      { name: "no_active_v2_recovery_grants", pass: true, value: 0 }
    ]));
    expect(report.ready_to_remove_compatibility).toBe(false);
    expect(JSON.stringify(report)).not.toContain(userId);
    expect(JSON.stringify(report)).not.toContain(applicationId);
    expect(JSON.stringify(report)).not.toContain(collectionId);
    expect(JSON.stringify(report)).not.toContain(grantId);
  });
});

let messageSequence = 0;
function randomMessageId(): string {
  messageSequence += 1;
  return `message-${messageSequence}`;
}

async function fixture() {
  const db = await createDatabase("memory");
  resources.push(() => db.end());
  return {
    db,
    defaultRegistrationMode: "closed" as const,
    publicUrl: "https://connect.example"
  };
}

async function configurePolicy(
  context: Awaited<ReturnType<typeof fixture>>
): Promise<void> {
  await runAuthAdminCommand([
    "policy",
    "update",
    "--expected-revision",
    "0",
    "--registration",
    "invite",
    "--password-auth",
    "enabled",
    "--email-delivery",
    "enabled",
    "--terms-version",
    "terms-2026-07-25",
    "--privacy-version",
    "privacy-2026-07-25",
    "--actor",
    "operator:test",
    "--reason",
    "Configure invitation test"
  ], context);
}
