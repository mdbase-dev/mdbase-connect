import { afterEach, describe, expect, it } from "vitest";
import {
  AuthAdminUsageError,
  InvitationDeliveryError,
  runAuthAdminCommand
} from "./auth-admin.js";
import { createDatabase } from "./db.js";
import {
  EmailDeliveryError,
  type EmailTransport
} from "./email.js";
import type {
  HostedAccountLimits,
  HostedAccountUsage,
  HostedProviderClient
} from "./hosted-provider.js";
import { tokenHash } from "./security.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("authentication operator command", () => {
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
      "Invite the first private beta account"
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
      "Invite the next beta participant"
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

    const provider = fakeHostedProvider();
    const reconciled = await runAuthAdminCommand([
      "entitlements", "reconcile",
      "--user", userId,
      "--operation-id", "20000000-0000-4000-8000-000000000090",
      "--actor", "operator:test",
      "--reason", "Reconcile private beta storage"
    ], { ...context, hostedProvider: provider }) as {
      reconciled: Array<{ user_id: string; reconciled_collections: number }>;
    };
    expect(reconciled.reconciled).toEqual([{
      user_id: userId,
      provider_account_id: expect.any(String),
      entitlement_revision: 1,
      reconciled_collections: 0,
      usage: expect.objectContaining({ account_id: expect.any(String) })
    }]);
    const reconciledAudit = await context.db.query<{
      user_id: string;
      subject_id: string;
    }>(
      `SELECT user_id, subject_id FROM audit_events
       WHERE event_type = 'entitlement.reconciled'`
    );
    expect(reconciledAudit.rows).toEqual([
      { user_id: userId, subject_id: userId }
    ]);
  });
});

function fakeHostedProvider(): HostedProviderClient {
  let usage: HostedAccountUsage | undefined;
  return {
    async upsertAccount(
      accountId: string,
      entitlementRevision: number,
      limits: HostedAccountLimits
    ) {
      usage = {
        account_id: accountId,
        entitlement_revision: entitlementRevision,
        collection_count: 0,
        live_content_bytes: 0,
        live_file_bytes: 0,
        retained_file_bytes: 0,
        ...limits
      };
      return usage;
    },
    async reconcileCollectionAccount() {},
    async accountUsage() {
      if (!usage) throw new Error("Hosted account was not reconciled.");
      return usage;
    }
  } as unknown as HostedProviderClient;
}

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
