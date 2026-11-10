import { generateKeyPairSync } from "node:crypto";
import { verifyNotificationWebhook } from "@mdbase-dev/connect-webhooks";
import { describe, expect, it } from "vitest";
import { SignedWebhookTransport } from "./webhook.js";

describe("signed webhook transport", () => {
  it("publishes the matching Ed25519 verification key", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const transport = new SignedWebhookTransport({
      keyId: "connect-2026-07",
      privateKeyPem: privateKey.export({
        format: "pem",
        type: "pkcs8"
      }).toString()
    });

    expect(transport.publicKeys()).toEqual([
      expect.objectContaining({
      kty: "OKP",
      crv: "Ed25519",
      kid: "connect-2026-07",
      alg: "EdDSA",
      use: "sig"
      })
    ]);
  });

  it("rejects non-Ed25519 signing material", () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048
    });
    expect(() => new SignedWebhookTransport({
      keyId: "wrong-key",
      privateKeyPem: privateKey.export({
        format: "pem",
        type: "pkcs8"
      }).toString()
    })).toThrow("Ed25519");
  });

  it("publishes retained verification keys during rotation", () => {
    const current = generateKeyPairSync("ed25519");
    const previous = generateKeyPairSync("ed25519");
    const previousJwk = {
      ...previous.publicKey.export({ format: "jwk" }),
      kid: "connect-previous",
      alg: "EdDSA",
      use: "sig"
    };
    const transport = new SignedWebhookTransport({
      keyId: "connect-current",
      privateKeyPem: current.privateKey.export({
        format: "pem",
        type: "pkcs8"
      }).toString(),
      previousPublicKeys: [previousJwk]
    });
    expect(transport.publicKeys().map((key) => key.kid)).toEqual([
      "connect-current",
      "connect-previous"
    ]);
  });

  it("signs the exact body with replay-bounded verification headers", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const captured: Array<{
      body: string;
      headers: Record<string, string>;
    }> = [];
    const now = Date.parse("2026-07-24T06:00:00Z");
    const transport = new SignedWebhookTransport({
      keyId: "connect-2026-07",
      privateKeyPem: privateKey.export({
        format: "pem",
        type: "pkcs8"
      }).toString()
    }, {
      now: () => now,
      post: async (_url, body, _agent, headers) => {
        captured.push({ body, headers });
        return { status: 204 };
      }
    });
    const body = JSON.stringify({
      type: "mdbase.notification.webhook",
      version: 1,
      delivery_id: "01911111-1111-7111-8111-111111111111",
      connection_id: "01922222-2222-7222-8222-222222222222",
      notification: {
        type: "mdbase.notification",
        version: 1,
        signal_id: "opaque",
        criterion_id: "task.changed",
        cursor: "42",
        presentation: { title: "Tasks changed" }
      }
    });

    await transport.send({
      deliveryId: "01911111-1111-7111-8111-111111111111",
      url: "https://hooks.tasks.example/mdbase"
    }, body);

    expect(verifyNotificationWebhook({
      body: captured[0].body,
      headers: captured[0].headers,
      keys: transport.publicKeys(),
      now
    })).toMatchObject({
      delivery_id: "01911111-1111-7111-8111-111111111111",
      notification: { cursor: "42" }
    });
  });
});
