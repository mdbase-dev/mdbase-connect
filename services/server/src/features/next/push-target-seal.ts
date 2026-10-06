import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { DatabasePool } from "../../database-types.js";

/**
 * Push targets (Web Push endpoint and keys, FCM token) sealed at rest with
 * AES-256-GCM. The associated data binds a sealed target to its grant and
 * installation, so a sealed value copied onto another channel row fails to open.
 *
 * Format: `v1.<key id>.<base64url(iv ‖ ciphertext ‖ tag)>`.
 */
export interface PushTarget {
  endpoint?: string | null;
  p256dh?: string | null;
  auth?: string | null;
  fcm_token?: string | null;
}

export interface PushTargetSealerConfig {
  keyId: string;
  key: Buffer;
  previousKeys: Record<string, Buffer>;
}

const AAD_PREFIX = "mdbase/v1/push-target";
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

export class PushTargetKeyUnavailable extends Error {}

export class PushTargetSealer {
  constructor(private readonly config: PushTargetSealerConfig) {}

  get keyId(): string {
    return this.config.keyId;
  }

  seal(grantId: string, installationId: string, target: PushTarget): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.config.key, iv);
    cipher.setAAD(aad(this.config.keyId, grantId, installationId));
    const body = Buffer.concat([
      cipher.update(JSON.stringify(normalize(target)), "utf8"),
      cipher.final()
    ]);
    return `v1.${this.config.keyId}.${Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url")}`;
  }

  open(grantId: string, installationId: string, sealed: string): PushTarget {
    const [version, keyId, payload, extra] = sealed.split(".");
    if (version !== "v1" || !keyId || !payload || extra !== undefined) {
      throw new Error("Sealed push target has an unknown format.");
    }
    const key = keyId === this.config.keyId
      ? this.config.key
      : this.config.previousKeys[keyId];
    if (!key) throw new PushTargetKeyUnavailable(`Push target key ${keyId} is not configured.`);
    const bytes = Buffer.from(payload, "base64url");
    if (bytes.length < 12 + 16) throw new Error("Sealed push target is truncated.");
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAAD(aad(keyId, grantId, installationId));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    const plain = Buffer.concat([
      decipher.update(bytes.subarray(12, bytes.length - 16)),
      decipher.final()
    ]).toString("utf8");
    return normalize(JSON.parse(plain) as PushTarget);
  }
}

function aad(keyId: string, grantId: string, installationId: string): Buffer {
  return Buffer.from(JSON.stringify([AAD_PREFIX, keyId, grantId, installationId]), "utf8");
}

function normalize(target: PushTarget): PushTarget {
  return {
    endpoint: target.endpoint ?? null,
    p256dh: target.p256dh ?? null,
    auth: target.auth ?? null,
    fcm_token: target.fcm_token ?? null
  };
}

/**
 * `MDBASE_NEXT_PUSH_TOKEN_KEY` (base64url, 32 bytes) with
 * `MDBASE_NEXT_PUSH_TOKEN_KEY_ID`, plus `MDBASE_NEXT_PUSH_TOKEN_PREVIOUS_KEYS`
 * (JSON `{key id: base64url key}`) for rotation. Absent key: no sealing.
 */
export function parsePushTargetSealerEnv(env: NodeJS.ProcessEnv): PushTargetSealerConfig | null {
  const raw = env.MDBASE_NEXT_PUSH_TOKEN_KEY?.trim() ?? "";
  if (!raw) return null;
  const keyId = env.MDBASE_NEXT_PUSH_TOKEN_KEY_ID?.trim() ?? "";
  if (!KEY_ID.test(keyId)) {
    throw new Error("MDBASE_NEXT_PUSH_TOKEN_KEY requires MDBASE_NEXT_PUSH_TOKEN_KEY_ID ([A-Za-z0-9_-]{1,32}).");
  }
  const key = keyBytes(raw, "MDBASE_NEXT_PUSH_TOKEN_KEY");
  const previousKeys: Record<string, Buffer> = {};
  const previousRaw = env.MDBASE_NEXT_PUSH_TOKEN_PREVIOUS_KEYS?.trim() ?? "";
  if (previousRaw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(previousRaw);
    } catch {
      throw new Error("MDBASE_NEXT_PUSH_TOKEN_PREVIOUS_KEYS must be a JSON object of key id to key.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("MDBASE_NEXT_PUSH_TOKEN_PREVIOUS_KEYS must be a JSON object of key id to key.");
    }
    for (const [id, value] of Object.entries(parsed)) {
      if (!KEY_ID.test(id) || id === keyId || typeof value !== "string") {
        throw new Error("MDBASE_NEXT_PUSH_TOKEN_PREVIOUS_KEYS has an invalid entry.");
      }
      previousKeys[id] = keyBytes(value, `MDBASE_NEXT_PUSH_TOKEN_PREVIOUS_KEYS.${id}`);
    }
  }
  return { keyId, key, previousKeys };
}

function keyBytes(value: string, name: string): Buffer {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value.replace(/=+$/, "")) {
    throw new Error(`${name} must be 32 bytes, base64url encoded.`);
  }
  return bytes;
}

/**
 * Seal plaintext targets (rows written before sealing was enabled, or sealed
 * under a retired key) in bounded batches. Idempotent; returns rows changed.
 */
export async function sealExistingPushTargets(
  db: DatabasePool,
  sealer: PushTargetSealer,
  batchSize = 200
): Promise<number> {
  let total = 0;
  for (;;) {
    const rows = await db.query<{
      id: string;
      grant_id: string;
      installation_id: string;
      endpoint: string | null;
      p256dh: string | null;
      auth: string | null;
      fcm_token: string | null;
      sealed_target: string | null;
      sealed_key_id: string | null;
    }>(
      `SELECT id, grant_id, installation_id, endpoint, p256dh, auth, fcm_token,
              sealed_target, sealed_key_id
       FROM push_channels
       WHERE (sealed_target IS NULL
              AND (endpoint IS NOT NULL OR fcm_token IS NOT NULL))
          OR (sealed_target IS NOT NULL AND sealed_key_id <> $1)
       ORDER BY id
       LIMIT $2`,
      [sealer.keyId, batchSize]
    );
    if (rows.rows.length === 0) return total;
    for (const row of rows.rows) {
      const target = row.sealed_target
        ? sealer.open(row.grant_id, row.installation_id, row.sealed_target)
        : row;
      await db.query(
        `UPDATE push_channels
         SET sealed_target = $2, sealed_key_id = $3, endpoint = NULL,
             p256dh = NULL, auth = NULL, fcm_token = NULL, updated_at = now()
         WHERE id = $1`,
        [row.id, sealer.seal(row.grant_id, row.installation_id, target), sealer.keyId]
      );
      total += 1;
    }
  }
}

/** Rollback aid: restore plaintext targets so a previous release can send. */
export async function unsealPushTargets(
  db: DatabasePool,
  sealer: PushTargetSealer,
  batchSize = 200
): Promise<number> {
  let total = 0;
  for (;;) {
    const rows = await db.query<{
      id: string;
      grant_id: string;
      installation_id: string;
      sealed_target: string;
    }>(
      `SELECT id, grant_id, installation_id, sealed_target
       FROM push_channels WHERE sealed_target IS NOT NULL
       ORDER BY id LIMIT $1`,
      [batchSize]
    );
    if (rows.rows.length === 0) return total;
    for (const row of rows.rows) {
      const target = sealer.open(row.grant_id, row.installation_id, row.sealed_target);
      await db.query(
        `UPDATE push_channels
         SET endpoint = $2, p256dh = $3, auth = $4, fcm_token = $5,
             sealed_target = NULL, sealed_key_id = NULL, updated_at = now()
         WHERE id = $1`,
        [row.id, target.endpoint, target.p256dh, target.auth, target.fcm_token]
      );
      total += 1;
    }
  }
}
