import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseQueryable } from "./db.js";

export function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

export function tokenHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("The MCP master key must decode to exactly 32 bytes.");
  }

  static fromBase64Url(value: string): SecretBox {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("MDBASE_MCP_MASTER_KEY must be base64url encoded.");
    return new SecretBox(Buffer.from(value, "base64url"));
  }

  /** Accept a high-entropy deployment secret and derive a fixed AES-256 key. */
  static fromSecret(value: string): SecretBox {
    if (value.length < 32) throw new Error("MDBASE_MCP_MASTER_KEY must contain at least 32 characters.");
    return new SecretBox(createHash("sha256").update(value, "utf8").digest());
  }

  encrypt(value: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${nonce.toString("base64url")}.${Buffer.concat([ciphertext, tag]).toString("base64url")}`;
  }

  decrypt(value: string): string {
    const [version, nonceText, sealedText] = value.split(".");
    if (version !== "v1" || !nonceText || !sealedText) throw new Error("Unsupported encrypted secret format.");
    const nonce = Buffer.from(nonceText, "base64url");
    const sealed = Buffer.from(sealedText, "base64url");
    if (nonce.length !== 12 || sealed.length < 17) throw new Error("Encrypted secret is malformed.");
    const ciphertext = sealed.subarray(0, -16);
    const tag = sealed.subarray(-16);
    const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }
}

export async function verifyMasterKey(db: DatabaseQueryable, secrets: SecretBox): Promise<void> {
  const marker = "mdbase-mcp-master-key-check-v1";
  await db.query(
    `INSERT INTO mcp_settings (key, value) VALUES ('master_key_check', $1)
     ON CONFLICT(key) DO NOTHING`,
    [secrets.encrypt(marker)]
  );
  const result = await db.query<{ value: string }>(
    "SELECT value FROM mcp_settings WHERE key = 'master_key_check'"
  );
  try {
    if (!result.rows[0] || secrets.decrypt(result.rows[0].value) !== marker) throw new Error();
  } catch {
    throw new Error("MDBASE_MCP_MASTER_KEY does not match the gateway database.");
  }
}
