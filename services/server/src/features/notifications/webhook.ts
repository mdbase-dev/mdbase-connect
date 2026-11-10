import {
  createPrivateKey,
  createPublicKey,
  sign
} from "node:crypto";
import { Agent, request } from "node:https";
import {
  PushDeliveryError,
  type NotificationSigningKey,
  type WebhookDeliveryTarget,
  type WebhookDeliveryTransport
} from "./notifications.js";
import { publicHttpsLookup } from "./public-network.js";

export interface WebhookSigningConfig {
  keyId: string;
  privateKeyPem: string;
  previousPublicKeys?: NotificationSigningKey[];
}

interface WebhookResponse {
  status: number;
  retryAfter?: string;
}

export interface SignedWebhookTransportOptions {
  now?: () => number;
  post?: (
    url: URL,
    payload: string,
    agent: Agent,
    headers: Record<string, string>
  ) => Promise<WebhookResponse>;
}

export class SignedWebhookTransport implements WebhookDeliveryTransport {
  private readonly privateKey;
  private readonly publicJwk: NotificationSigningKey;
  private readonly agent = new Agent({
    keepAlive: true,
    lookup: publicHttpsLookup
  });

  constructor(
    private readonly config: WebhookSigningConfig,
    private readonly options: SignedWebhookTransportOptions = {}
  ) {
    this.privateKey = createPrivateKey(config.privateKeyPem);
    if (this.privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error("Webhook signing key must be an Ed25519 private key.");
    }
    for (const key of config.previousPublicKeys ?? []) {
      const publicKey = createPublicKey({
        key: key as unknown as import("node:crypto").JsonWebKey,
        format: "jwk"
      });
      if (publicKey.asymmetricKeyType !== "ed25519") {
        throw new Error("Previous webhook verification keys must use Ed25519.");
      }
    }
    this.publicJwk = {
      ...createPublicKey(this.privateKey).export({ format: "jwk" }),
      kid: config.keyId,
      alg: "EdDSA",
      use: "sig"
    } as NotificationSigningKey;
  }

  publicKey(): NotificationSigningKey {
    return { ...this.publicJwk };
  }

  publicKeys(): NotificationSigningKey[] {
    return [
      this.publicKey(),
      ...(this.config.previousPublicKeys ?? []).map((key) => ({ ...key }))
    ];
  }

  async send(target: WebhookDeliveryTarget, payload: string): Promise<void> {
    const url = new URL(target.url);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.hash
    ) {
      throw new PushDeliveryError("Webhook target must be an HTTPS URL.", true);
    }
    const timestamp = String(Math.floor((this.options.now?.() ?? Date.now()) / 1_000));
    const signed = `${target.deliveryId}.${timestamp}.${payload}`;
    const signature = sign(null, Buffer.from(signed), this.privateKey)
      .toString("base64url");
    const response = await (this.options.post ?? postJson)(url, payload, this.agent, {
      "mdbase-webhook-id": target.deliveryId,
      "mdbase-webhook-timestamp": timestamp,
      "mdbase-webhook-key-id": this.config.keyId,
      "mdbase-webhook-signature": `v1=${signature}`
    });
    if (response.status >= 200 && response.status < 300) return;
    const permanent = response.status >= 300
      && response.status < 500
      && ![408, 409, 425, 429].includes(response.status);
    throw new PushDeliveryError(
      `Webhook returned HTTP ${response.status}.`,
      permanent,
      retryAfter(response.retryAfter)
    );
  }
}

async function postJson(
  url: URL,
  payload: string,
  agent: Agent,
  headers: Record<string, string>
): Promise<WebhookResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, {
      method: "POST",
      agent,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        "user-agent": "mdbase-connect-notifications/1",
        ...headers
      }
    }, (response) => {
      let received = 0;
      response.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > 64 * 1024) response.destroy();
      });
      response.on("end", () => resolve({
        status: response.statusCode ?? 502,
        ...(typeof response.headers["retry-after"] === "string"
          ? { retryAfter: response.headers["retry-after"] }
          : {})
      }));
    });
    outgoing.setTimeout(15_000, () => {
      outgoing.destroy(new Error("Webhook request timed out."));
    });
    outgoing.on("error", (error) => reject(
      new PushDeliveryError(`Webhook request failed: ${error.message}`)
    ));
    outgoing.end(payload);
  });
}

function retryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (/^[0-9]+$/.test(value)) return Number(value) * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}
