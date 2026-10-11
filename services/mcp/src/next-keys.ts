// The per-connection X25519 Noise key an mdbase-next replica authenticates the MCP
// connector by. It lives beside the grant key in `mcp_grant_keys` (handle
// `mcp-noise:<grant key handle>`, existing columns), and is attested by the grant
// signing key, at consent (`client_noise_key`) or by the one-time attach route.
import { randomBytes } from "node:crypto";
import { keyPairFromSecret, type KeyPair } from "@mdbase-dev/sdk";
import type { GrantKeyRecord } from "@mdbase-dev/connect/crypto";
import type { DatabasePool } from "./db.js";
import { SecretBox } from "./security.js";

const field = (bytes: Uint8Array) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
};
const uuidBytes = (id: string) => {
  const hex = id.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/iu.test(hex)) throw new Error("Invalid UUID.");
  return Buffer.from(hex, "hex");
};

/** Matches the control plane's `clientNoiseKeyMessage`. */
export function clientNoiseKeyMessage(authorizationId: string, publicKey: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from("mdbase-next client noise key v1\0", "utf8"), field(uuidBytes(authorizationId)), field(publicKey)]);
}

/** Matches the control plane's `clientKeyAttachMessage`. */
export function clientKeyAttachMessage(grantId: string, publicKey: Uint8Array, expiresAt: string, nonce: Uint8Array): Buffer {
  return Buffer.concat([
    Buffer.from("mdbase-next client noise key attach v1\0", "utf8"),
    field(uuidBytes(grantId)), field(publicKey), field(Buffer.from(expiresAt, "utf8")), field(nonce)
  ]);
}

async function signP1363(grantKey: GrantKeyRecord, message: Buffer): Promise<string> {
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, grantKey.signingPrivateKey, Uint8Array.from(message));
  return Buffer.from(signature).toString("base64url");
}

export const noiseHandle = (grantKeyHandle: string) => `mcp-noise:${grantKeyHandle}`;

export class NoiseKeyStore {
  constructor(private readonly db: DatabasePool, private readonly secrets: SecretBox) {}

  async create(grantKeyHandle: string): Promise<KeyPair> {
    const secret = randomBytes(32);
    const pair = keyPairFromSecret(Uint8Array.from(secret));
    await this.db.query(
      `INSERT INTO mcp_grant_keys (handle, public_key, private_key_ciphertext) VALUES ($1, $2, $3)
       ON CONFLICT (handle) DO UPDATE SET public_key = excluded.public_key, private_key_ciphertext = excluded.private_key_ciphertext`,
      [noiseHandle(grantKeyHandle), Buffer.from(pair.publicKey).toString("base64url"), this.secrets.encrypt(secret.toString("base64url"))]
    );
    secret.fill(0);
    return pair;
  }

  async get(grantKeyHandle: string): Promise<KeyPair | null> {
    const row = (await this.db.query<{ public_key: string; private_key_ciphertext: string }>(
      "SELECT public_key, private_key_ciphertext FROM mcp_grant_keys WHERE handle = $1", [noiseHandle(grantKeyHandle)]
    )).rows[0];
    if (!row) return null;
    const pair = keyPairFromSecret(Uint8Array.from(Buffer.from(this.secrets.decrypt(row.private_key_ciphertext), "base64url")));
    if (Buffer.from(pair.publicKey).toString("base64url") !== row.public_key) throw new Error("The stored Noise key is inconsistent.");
    return pair;
  }

  async delete(grantKeyHandle: string): Promise<void> {
    await this.db.query("DELETE FROM mcp_grant_keys WHERE handle = $1", [noiseHandle(grantKeyHandle)]);
  }
}

/** `client_noise_key` form field for an authorization request. */
export async function clientNoiseKeyField(grantKey: GrantKeyRecord, authorizationId: string, noise: KeyPair): Promise<string> {
  return JSON.stringify({
    public_key: Buffer.from(noise.publicKey).toString("base64url"),
    signature: await signP1363(grantKey, clientNoiseKeyMessage(authorizationId, noise.publicKey))
  });
}

/** Body for `POST /v1/next/grants/client-key`. */
export async function clientKeyAttachBody(grantKey: GrantKeyRecord, grantId: string, authorizationId: string, noise: KeyPair, now = Date.now()) {
  const nonce = randomBytes(32), expiresAt = new Date(now + 2 * 60_000).toISOString();
  return {
    grant_id: grantId,
    public_key: Buffer.from(noise.publicKey).toString("base64url"),
    attestation: await signP1363(grantKey, clientNoiseKeyMessage(authorizationId, noise.publicKey)),
    nonce: nonce.toString("base64url"),
    expires_at: expiresAt,
    signature: await signP1363(grantKey, clientKeyAttachMessage(grantId, noise.publicKey, expiresAt, nonce))
  };
}
