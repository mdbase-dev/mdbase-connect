import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { MDBASE_RECORD_MODIFIED_CONTRACT } from "@mdbase-dev/connect-protocol";
import { buildApp } from "./app.js";
import { createDatabase, type DatabasePool } from "./db.js";
import { HostedProviderClient } from "./hosted-provider.js";
import type {
  FcmPushTarget,
  FcmPushTransport,
  NotificationSigningKey,
  PushSubscriptionTarget,
  PushTransport,
  WebhookDeliveryTarget,
  WebhookDeliveryTransport
} from "./notifications.js";
import { tokenHash } from "./security.js";

class RecordingPushTransport implements PushTransport {
  readonly deliveries: Array<{ target: PushSubscriptionTarget; payload: string }> = [];

  async send(target: PushSubscriptionTarget, payload: string): Promise<void> {
    this.deliveries.push({ target, payload });
  }
}

class RecordingFcmTransport implements FcmPushTransport {
  readonly deliveries: Array<{ target: FcmPushTarget; payload: string }> = [];

  async send(target: FcmPushTarget, payload: string): Promise<void> {
    this.deliveries.push({ target, payload });
  }
}

class RecordingWebhookTransport implements WebhookDeliveryTransport {
  readonly deliveries: Array<{ target: WebhookDeliveryTarget; payload: string }> = [];

  async send(target: WebhookDeliveryTarget, payload: string): Promise<void> {
    this.deliveries.push({ target, payload });
  }

  publicKeys(): NotificationSigningKey[] {
    return [{
      kty: "OKP",
      crv: "Ed25519",
      x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      kid: "connect-test"
    }];
  }
}

const resources: Array<{ app: Awaited<ReturnType<typeof buildApp>>["app"]; db: DatabasePool }> = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.app.close();
    await resource.db.end();
  }
});

describe("Web Push notifications", () => {
  it("registers declared criteria and durably deduplicates opaque authority signals", async () => {
    const fixture = await notificationFixture();
    const channel = await fixture.app.inject({
      method: "POST",
      url: "/v1/notifications/channels",
      headers: { authorization: `Bearer ${fixture.applicationToken}` },
      payload: {
        installation_id: "installation_0123456789",
        criteria: ["task.ready"],
        subscription: {
          endpoint: "https://push.example/subscription/one",
          expirationTime: null,
          keys: {
            p256dh: "p256dh_012345678901234567890123456789",
            auth: "auth_0123456789012345"
          }
        }
      }
    });
    expect(channel.statusCode).toBe(201);
    expect(channel.json().criteria).toEqual(["task.ready"]);

    const signal = {
      signal_id: "signal_01234567890123456789",
      grant_id: fixture.grantId,
      criterion_id: "task.ready",
      cursor: "42"
    };
    const accepted = await fixture.app.inject({
      method: "POST",
      url: "/v1/connectors/notification-signals",
      headers: { authorization: `Bearer ${fixture.connectorToken}` },
      payload: signal
    });
    expect(accepted.statusCode).toBe(202);
    await eventually(() => fixture.transport.deliveries.length === 1);

    const payload = JSON.parse(fixture.transport.deliveries[0].payload);
    expect(payload).toEqual({
      type: "mdbase.notification",
      version: 1,
      signal_id: signal.signal_id,
      criterion_id: signal.criterion_id,
      cursor: "42",
      presentation: {
        title: "A task changed",
        body: "Open Tasks to see the latest update.",
        tag: "task-change"
      }
    });
    expect(JSON.stringify(payload)).not.toContain("private");
    expect(JSON.stringify(payload)).not.toContain("record");

    const duplicate = await fixture.app.inject({
      method: "POST",
      url: "/v1/connectors/notification-signals",
      headers: { authorization: `Bearer ${fixture.connectorToken}` },
      payload: signal
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().duplicate).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fixture.transport.deliveries).toHaveLength(1);
  }, 15_000);

  it("rejects undeclared criteria and revoked grants", async () => {
    const fixture = await notificationFixture();
    const undeclared = await fixture.app.inject({
      method: "POST",
      url: "/v1/connectors/notification-signals",
      headers: { authorization: `Bearer ${fixture.connectorToken}` },
      payload: {
        signal_id: "signal_undeclared_012345",
        grant_id: fixture.grantId,
        criterion_id: "private.exfiltrate",
        cursor: "1"
      }
    });
    expect(undeclared.statusCode).toBe(403);

    await fixture.db.query(
      `UPDATE applications
       SET notifications = $2::jsonb
       WHERE id = (SELECT application_id FROM grants WHERE id = $1)`,
      [
        fixture.grantId,
        JSON.stringify({
          criteria: [
            {
              id: "task.ready",
              event: MDBASE_RECORD_MODIFIED_CONTRACT,
              presentation: { title: "A task changed" }
            },
            {
              id: "private.exfiltrate",
              event: MDBASE_RECORD_MODIFIED_CONTRACT,
              presentation: { title: "Newly declared" }
            }
          ]
        })
      ]
    );
    const silentlyBroadened = await fixture.app.inject({
      method: "POST",
      url: "/v1/connectors/notification-signals",
      headers: { authorization: `Bearer ${fixture.connectorToken}` },
      payload: {
        signal_id: "signal_manifest_broadened_012345",
        grant_id: fixture.grantId,
        criterion_id: "private.exfiltrate",
        cursor: "2"
      }
    });
    expect(silentlyBroadened.statusCode).toBe(403);
    const registration = await fixture.app.inject({
      method: "POST",
      url: "/v1/notifications/channels",
      headers: { authorization: `Bearer ${fixture.applicationToken}` },
      payload: {
        installation_id: "installation_broadening_012345",
        criteria: ["private.exfiltrate"],
        subscription: {
          endpoint: "https://push.example/subscription/broadened",
          keys: {
            p256dh: "p256dh_012345678901234567890123456789",
            auth: "auth_0123456789012345"
          }
        }
      }
    });
    expect(registration.statusCode).toBe(400);
    expect(registration.json().error.code).toBe(
      "notification_reauthorization_required"
    );

    await fixture.db.query("UPDATE grants SET revoked_at = now() WHERE id = $1", [fixture.grantId]);
    const revoked = await fixture.app.inject({
      method: "POST",
      url: "/v1/connectors/notification-signals",
      headers: { authorization: `Bearer ${fixture.connectorToken}` },
      payload: {
        signal_id: "signal_revoked_012345678",
        grant_id: fixture.grantId,
        criterion_id: "task.ready",
        cursor: "2"
      }
    });
    expect(revoked.statusCode).toBe(403);
  });

  it("accepts only authenticated hosted-authority signals for active hosted grants", async () => {
    const fixture = await notificationFixture(true);
    const channel = await fixture.app.inject({
      method: "POST",
      url: "/v1/notifications/channels",
      headers: { authorization: `Bearer ${fixture.applicationToken}` },
      payload: {
        installation_id: "hosted_installation_012345",
        criteria: ["task.ready"],
        subscription: {
          endpoint: "https://push.example/subscription/hosted",
          expirationTime: null,
          keys: {
            p256dh: "p256dh_012345678901234567890123456789",
            auth: "auth_0123456789012345"
          }
        }
      }
    });
    expect(channel.statusCode, channel.body).toBe(201);
    const signal = {
      signal_id: "hosted_signal_012345678901",
      grant_id: fixture.grantId,
      criterion_id: "task.ready",
      cursor: "77"
    };
    const denied = await fixture.app.inject({
      method: "POST",
      url: "/internal/v1/hosted/notification-signals",
      headers: { authorization: "Bearer incorrect-token" },
      payload: signal
    });
    expect(denied.statusCode).toBe(401);

    const accepted = await fixture.app.inject({
      method: "POST",
      url: "/internal/v1/hosted/notification-signals",
      headers: { authorization: `Bearer ${fixture.hostedInternalToken}` },
      payload: signal
    });
    expect(accepted.statusCode, accepted.body).toBe(202);
    await eventually(() => fixture.transport.deliveries.length === 1);
    expect(JSON.parse(fixture.transport.deliveries[0].payload)).toMatchObject({
      signal_id: signal.signal_id,
      criterion_id: "task.ready",
      cursor: "77"
    });
  });

  it("registers a managed FCM installation against the manifest project", async () => {
    const fixture = await notificationFixture(false, {
      nativeDelivery: {
        mode: "managed_fcm",
        firebase_project_id: "tasks-production"
      }
    });
    const registered = await fixture.app.inject({
      method: "POST",
      url: "/v1/notifications/channels",
      headers: { authorization: `Bearer ${fixture.applicationToken}` },
      payload: {
        installation_id: "native_installation_012345",
        criteria: ["task.ready"],
        transport: "fcm",
        token: "fcm_registration_token_012345678901234567890123"
      }
    });
    expect(registered.statusCode, registered.body).toBe(201);
    expect(registered.json()).toMatchObject({
      transport: "fcm",
      criteria: ["task.ready"]
    });

    const accepted = await fixture.app.inject({
      method: "POST",
      url: "/v1/connectors/notification-signals",
      headers: { authorization: `Bearer ${fixture.connectorToken}` },
      payload: {
        signal_id: "managed_fcm_signal_0123456789",
        grant_id: fixture.grantId,
        criterion_id: "task.ready",
        cursor: "88"
      }
    });
    expect(accepted.statusCode, accepted.body).toBe(202);
    await eventually(() => fixture.fcm.deliveries.length === 1);
    expect(fixture.fcm.deliveries[0].target).toEqual({
      projectId: "tasks-production",
      token: "fcm_registration_token_012345678901234567890123"
    });
    expect(JSON.parse(fixture.fcm.deliveries[0].payload)).toMatchObject({
      signal_id: "managed_fcm_signal_0123456789",
      cursor: "88"
    });
  });

  it("delivers one signed-webhook route without requiring a device channel", async () => {
    const fixture = await notificationFixture(false, {
      nativeDelivery: {
        mode: "webhook",
        url: "https://hooks.tasks.example/mdbase"
      }
    });
    const accepted = await fixture.app.inject({
      method: "POST",
      url: "/v1/connectors/notification-signals",
      headers: { authorization: `Bearer ${fixture.connectorToken}` },
      payload: {
        signal_id: "webhook_signal_012345678901",
        grant_id: fixture.grantId,
        criterion_id: "task.ready",
        cursor: "99"
      }
    });
    expect(accepted.statusCode, accepted.body).toBe(202);
    expect(accepted.json().deliveries).toBe(1);
    await eventually(() => fixture.webhook.deliveries.length === 1);
    const delivery = fixture.webhook.deliveries[0];
    expect(delivery.target.url).toBe("https://hooks.tasks.example/mdbase");
    expect(JSON.parse(delivery.payload)).toEqual({
      type: "mdbase.notification.webhook",
      version: 1,
      delivery_id: delivery.target.deliveryId,
      connection_id: fixture.grantId,
      notification: {
        type: "mdbase.notification",
        version: 1,
        signal_id: "webhook_signal_012345678901",
        criterion_id: "task.ready",
        cursor: "99",
        presentation: {
          title: "A task changed",
          body: "Open Tasks to see the latest update.",
          tag: "task-change"
        }
      }
    });
    expect(delivery.payload).not.toContain("path");
    expect(delivery.payload).not.toContain("frontmatter");
  });
});

async function notificationFixture(
  hosted = false,
  options: {
    nativeDelivery?:
      | { mode: "managed_fcm"; firebase_project_id: string }
      | { mode: "webhook"; url: string };
  } = {}
) {
  const db = await createDatabase("memory");
  const transport = new RecordingPushTransport();
  const fcm = new RecordingFcmTransport();
  const webhook = new RecordingWebhookTransport();
  const hostedInternalToken = "hosted_internal_token_012345678901234567890123";
  const built = await buildApp({
    db,
    devAuth: true,
    publicUrl: "http://127.0.0.1:8787",
    ...(hosted
      ? {
          hostedProvider: new HostedProviderClient({
            url: "http://127.0.0.1:8790",
            internalToken: hostedInternalToken
          })
        }
      : {}),
    notifications: {
      publicKey: "public_vapid_key",
      transports: { webPush: transport, fcm, webhook },
      pollIntervalMs: 10
    }
  });
  resources.push({ app: built.app, db });
  const userId = randomUUID();
  const connectorId = randomUUID();
  const collectionId = randomUUID();
  const localCollectionId = randomUUID();
  const applicationId = randomUUID();
  const grantId = randomUUID();
  const connectorToken = "connector_token_012345678901234567890123";
  const applicationToken = "application_token_0123456789012345678901";
  await db.query("INSERT INTO users (id, email, name) VALUES ($1, $2, $3)", [
    userId,
    "user@example.test",
    "User"
  ]);
  await db.query(
    "INSERT INTO connectors (id, user_id, name, token_hash) VALUES ($1, $2, $3, $4)",
    [connectorId, userId, "Computer", tokenHash(connectorToken)]
  );
  await db.query(
    `INSERT INTO collections
       (id, user_id, connector_id, local_id, display_name, spec_version, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, true)`,
    [collectionId, userId, connectorId, localCollectionId, "Tasks", "0.3.0"]
  );
  if (hosted) {
    await db.query(
      `INSERT INTO hosted_collections
         (id, user_id, display_name, template, provider_url)
       VALUES ($1, $2, $3, $4, $5)`,
      [collectionId, userId, "Hosted Tasks", "blank", "http://127.0.0.1:8790"]
    );
  }
  await db.query(
    `INSERT INTO applications
       (id, canonical_identity, manifest_version, name, homepage,
        redirect_uris, notifications)
     VALUES ($1, $2, 1, $3, $4, $5::jsonb, $6::jsonb)`,
    [
      applicationId,
      "bundle:dev.mdbase.tasks:sha256:test",
      "Tasks",
      "https://tasks.example/",
      JSON.stringify(["https://tasks.example/callback"]),
      JSON.stringify({
        ...(options.nativeDelivery
          ? { native_delivery: options.nativeDelivery }
          : {}),
        criteria: [{
          id: "task.ready",
          event: MDBASE_RECORD_MODIFIED_CONTRACT,
          presentation: {
            title: "A task changed",
            body: "Open Tasks to see the latest update.",
            tag: "task-change"
          }
        }]
      })
    ]
  );
  await db.query(
    `INSERT INTO grants
      (id, user_id, application_id, ${hosted ? "hosted_collection_id" : "collection_id"},
        operations, scope, application_origin, notification_criteria,
        application_authorization, application_installation_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb,
             '{"binding":{"protocol_version":2}}'::jsonb, $9)`,
    [
      grantId,
      userId,
      applicationId,
      collectionId,
      JSON.stringify(["changes", "read"]),
      JSON.stringify({ contracts: [] }),
      "https://tasks.example",
      JSON.stringify([{
        id: "task.ready",
        event: MDBASE_RECORD_MODIFIED_CONTRACT,
        presentation: {
          title: "A task changed",
          body: "Open Tasks to see the latest update.",
          tag: "task-change"
        }
      }]),
      randomUUID()
    ]
  );
  await db.query(
    `INSERT INTO access_tokens (id, token_hash, grant_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [
      randomUUID(),
      tokenHash(applicationToken),
      grantId,
      new Date(Date.now() + 60_000).toISOString()
    ]
  );
  return {
    app: built.app,
    db,
    transport,
    fcm,
    webhook,
    grantId,
    connectorToken,
    applicationToken,
    hostedInternalToken
  };
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for notification delivery.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
