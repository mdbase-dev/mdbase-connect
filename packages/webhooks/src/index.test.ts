import {
  createPublicKey,
  generateKeyPairSync,
  sign
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  NotificationWebhookVerificationError,
  verifyNotificationWebhook
} from "./index.js";

const webhook = {
  type: "mdbase.notification.webhook",
  version: 1,
  delivery_id: "01911111-1111-7111-8111-111111111111",
  connection_id: "01922222-2222-7222-8222-222222222222",
  notification: {
    type: "mdbase.notification",
    version: 1,
    signal_id: "signal_opaque",
    criterion_id: "task.changed",
    cursor: "42",
    presentation: {
      title: "Tasks changed",
      body: "Open Worklog to refresh."
    }
  }
} as const;

describe("notification webhook verification", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const keyId = "connect-test";
  const publicKey = {
    ...createPublicKey(privateKey).export({ format: "jwk" }),
    kid: keyId,
    alg: "EdDSA",
    use: "sig"
  } as const;
  const now = Date.parse("2026-07-24T06:00:00Z");
  const timestamp = String(now / 1_000);

  function request(body = JSON.stringify(webhook)) {
    const signature = sign(
      null,
      Buffer.from(`${webhook.delivery_id}.${timestamp}.${body}`),
      privateKey
    ).toString("base64url");
    return {
      body,
      headers: {
        "mdbase-webhook-id": webhook.delivery_id,
        "mdbase-webhook-timestamp": timestamp,
        "mdbase-webhook-key-id": keyId,
        "mdbase-webhook-signature": `v1=${signature}`
      },
      keys: [publicKey],
      now
    };
  }

  it("returns a verified, typed notification envelope", () => {
    expect(verifyNotificationWebhook(request())).toEqual(webhook);
  });

  it("rejects body tampering and replayed timestamps", () => {
    const valid = request();
    expect(() => verifyNotificationWebhook({
      ...valid,
      body: valid.body.replace("Tasks changed", "Reset your password")
    })).toThrowError(NotificationWebhookVerificationError);
    expect(() => verifyNotificationWebhook({
      ...valid,
      now: now + 301_000
    })).toThrowError(expect.objectContaining({ code: "stale_timestamp" }));
  });

  it("rejects signed envelopes that contain undeclared collection data", () => {
    const body = JSON.stringify({
      ...webhook,
      notification: {
        ...webhook.notification,
        path: "tasks/private.md"
      }
    });
    expect(() => verifyNotificationWebhook(request(body))).toThrowError(
      expect.objectContaining({ code: "invalid_payload" })
    );
  });
});
