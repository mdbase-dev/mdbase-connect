// mdbase-next devices for daemons (interface note
// 2026-10-04-control-daemon-grant-feed-and-relay.md §1-§3).
//
// A daemon pairs as a connector as today, then registers a device with proof of
// possession of its signing key. The device needs no log. On the connector relay
// socket it proves the socket is its own with `device_bind` before any Noise pipe is
// routed to it, and its policy snapshots gain the Noise fields of each grant.
import { createHash, randomBytes, verify as edVerify } from "node:crypto";
import type { WebSocket } from "ws";
import {
  APPLICATION_CAPABILITY_DEFINITIONS,
  type ApplicationCapabilityId
} from "@mdbase-dev/connect-protocol";
import type { DatabasePool } from "../../database-types.js";
import { ed25519PublicKeyObject } from "./policy-keys.js";
import { domainHash, uuidBytes } from "./policy-wire.js";

export const NEXT_DEVICE_CAPABILITY = "next_device_v1";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export class DeviceRegistrationError extends Error {
  constructor(readonly code: "invalid_device" | "challenge_invalid" | "device_keys_changed" | "device_already_bound", message: string) {
    super(message);
  }
}

// Encodings with the top bit masked, as libsodium compares them (SEC-039).
// Ed25519: the small-order points and the non-canonical y >= p encodings of y = 0, 1.
const WEAK_ED25519 = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
];
// X25519: the low-order u-coordinates, including 0 (all-zero is reserved for recovery devices).
const WEAK_X25519 = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
  "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
];

function masked(key: Uint8Array): string {
  const copy = Buffer.from(key);
  copy[31] = copy[31]! & 0x7f;
  return copy.toString("hex");
}

/** A non-canonical (y >= p) Ed25519 encoding: y read little-endian with the sign bit cleared. */
function nonCanonicalEd25519(key: Uint8Array): boolean {
  const y = BigInt(`0x${Buffer.from(key).reverse().toString("hex")}`) & ((1n << 255n) - 1n);
  return y >= (1n << 255n) - 19n;
}

/** Ed25519 public keys a device may not use: small order or non-canonical. */
export function weakSigningKey(key: Uint8Array): boolean {
  return WEAK_ED25519.includes(masked(key)) || nonCanonicalEd25519(key);
}

/** X25519 public keys a device may not use: all-zero or low order. */
export function weakAgreementKey(key: Uint8Array): boolean {
  return WEAK_X25519.includes(masked(key));
}

const bytes = (hex: unknown, size: number): Buffer | null =>
  typeof hex === "string" && new RegExp(`^[0-9a-f]{${size * 2}}$`).test(hex) ? Buffer.from(hex, "hex") : null;

const verifies = (publicKey: Uint8Array, digest: Uint8Array, signature: Uint8Array): boolean => {
  try {
    return edVerify(null, digest, ed25519PublicKeyObject(publicKey), signature);
  } catch {
    return false;
  }
};

export async function issueDeviceChallenge(db: DatabasePool, connectorId: string, now = Date.now()): Promise<{ challenge: string; expires_at: number }> {
  const challenge = randomBytes(32);
  await db.query("DELETE FROM next_device_challenges WHERE expires_at < now() - interval '1 hour'");
  await db.query(
    "INSERT INTO next_device_challenges (challenge, connector_id, expires_at) VALUES ($1, $2, $3)",
    [challenge, connectorId, new Date(now + CHALLENGE_TTL_MS)]
  );
  return { challenge: challenge.toString("hex"), expires_at: now + CHALLENGE_TTL_MS };
}

/** `H("mdbase/v1/cp-enrol", challenge ‖ connector ‖ device ‖ sign_pk ‖ kem_pk ‖ noise_pk)`. */
export function deviceRegistrationDigest(input: { challenge: Uint8Array; connectorId: string; deviceId: string; signPk: Uint8Array; kemPk: Uint8Array; noisePk: Uint8Array }): Uint8Array {
  return domainHash("mdbase/v1/cp-enrol", Buffer.concat([
    input.challenge, uuidBytes(input.connectorId), uuidBytes(input.deviceId), input.signPk, input.kemPk, input.noisePk
  ]));
}

/**
 * Register (or re-register with identical keys) the daemon device of a connector.
 * The challenge is consumed in the same transaction.
 */
export async function registerDevice(
  db: DatabasePool,
  connector: { id: string; user_id: string },
  body: Record<string, unknown>
): Promise<{ device_id: string }> {
  const deviceId = typeof body.device_id === "string" && /^[0-9a-f-]{36}$/.test(body.device_id) ? body.device_id : null;
  const kind = body.kind === "desktop" || body.kind === "cli" ? body.kind : null;
  const signPk = bytes(body.sign_pk, 32);
  const kemPk = bytes(body.kem_pk, 32);
  const noisePk = bytes(body.noise_pk, 32);
  const challenge = bytes(body.challenge, 32);
  const sig = bytes(body.sig, 64);
  if (!deviceId || !kind || !signPk || !kemPk || !noisePk || !challenge || !sig) {
    throw new DeviceRegistrationError("invalid_device", "The device registration is malformed.");
  }
  if (weakSigningKey(signPk) || weakAgreementKey(kemPk) || weakAgreementKey(noisePk)) {
    throw new DeviceRegistrationError("invalid_device", "A device key is weak, small order or non-canonical.");
  }
  const digest = deviceRegistrationDigest({ challenge, connectorId: connector.id, deviceId, signPk, kemPk, noisePk });
  if (!verifies(signPk, digest, sig)) throw new DeviceRegistrationError("invalid_device", "The device signature does not verify.");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const used = await client.query(
      `UPDATE next_device_challenges SET used_at = now()
       WHERE challenge = $1 AND connector_id = $2 AND used_at IS NULL AND expires_at > now()`,
      [challenge, connector.id]
    );
    if (used.rowCount !== 1) throw new DeviceRegistrationError("challenge_invalid", "The challenge is unknown, used or expired.");
    const existing = await client.query<{ id: string; connector_id: string; sign_pk: Buffer; kem_pk: Buffer; noise_pk: Buffer }>(
      "SELECT id, connector_id, sign_pk, kem_pk, noise_pk FROM next_devices WHERE id = $1 OR connector_id = $2 FOR UPDATE",
      [deviceId, connector.id]
    );
    const row = existing.rows[0];
    if (row) {
      if (row.id !== deviceId || row.connector_id !== connector.id) {
        throw new DeviceRegistrationError("device_already_bound", "This connector or device is already registered to another.");
      }
      if (!row.sign_pk.equals(signPk) || !row.kem_pk.equals(kemPk) || !row.noise_pk.equals(noisePk)) {
        throw new DeviceRegistrationError("device_keys_changed", "A device's keys never change; register a new device.");
      }
    } else {
      await client.query(
        `INSERT INTO next_devices (id, connector_id, user_id, kind, sign_pk, kem_pk, noise_pk)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [deviceId, connector.id, connector.user_id, kind, signPk, kemPk, noisePk]
      );
    }
    await client.query("COMMIT");
    return { device_id: deviceId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** `H("mdbase/v1/relay-device", connector ‖ session ‖ device_nonce)`; session is the relay generation. */
export function deviceBindDigest(connectorId: string, sessionId: string, nonce: Uint8Array): Uint8Array {
  return domainHash("mdbase/v1/relay-device", Buffer.concat([uuidBytes(connectorId), Buffer.from(sessionId, "utf8"), nonce]));
}

/**
 * Per-socket device state on the connector relay. Nothing here changes a socket that
 * did not offer `next_device_v1`.
 */
export class NextRelayDevices {
  private readonly sockets = new WeakMap<WebSocket, { nonce: Buffer; deviceId?: string }>();

  constructor(private readonly db: DatabasePool) {}

  negotiated(capabilities: readonly string[]): boolean {
    return capabilities.includes(NEXT_DEVICE_CAPABILITY);
  }

  /** Extra `relay_welcome` fields: a fresh nonce when the connector offered the capability. */
  welcome(socket: WebSocket, capabilities: readonly string[]): { device_nonce?: string } {
    if (!this.negotiated(capabilities)) return {};
    const nonce = randomBytes(32);
    this.sockets.set(socket, { nonce });
    return { device_nonce: nonce.toString("hex") };
  }

  /** Handle `device_bind`; replies `device_bound` or `device_bind_failed`. */
  async bind(socket: WebSocket, connectorId: string, sessionId: string, message: Record<string, unknown>): Promise<void> {
    const state = this.sockets.get(socket);
    const reply = (value: Record<string, unknown>) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(value));
    };
    const deviceId = typeof message.device_id === "string" ? message.device_id : "";
    const sig = bytes(message.sig, 64);
    if (!state || state.deviceId || !sig) return reply({ type: "device_bind_failed", reason: state?.deviceId ? "already_bound" : "invalid" });
    const device = await this.db.query<{ sign_pk: Buffer }>(
      `SELECT d.sign_pk FROM next_devices d JOIN connectors c ON c.id = d.connector_id
       WHERE d.id = $1 AND d.connector_id = $2 AND c.revoked_at IS NULL`,
      [deviceId, connectorId]
    ).catch(() => ({ rows: [] as Array<{ sign_pk: Buffer }> }));
    const row = device.rows[0];
    if (!row || !verifies(row.sign_pk, deviceBindDigest(connectorId, sessionId, state.nonce), sig)) {
      return reply({ type: "device_bind_failed", reason: "unknown_device_or_signature" });
    }
    state.deviceId = deviceId;
    reply({ type: "device_bound", device_id: deviceId });
  }

  boundDevice(socket: WebSocket): string | undefined {
    return this.sockets.get(socket)?.deviceId;
  }
}

/**
 * The v2 capability groups a grant's operations cover exactly, for the daemon's access
 * list. `offline.replica` is never offered for a local collection. Undefined for v1
 * bindings, which work only through the envelope compatibility layer.
 */
export function grantCapabilityGroups(semanticCapabilities: number | undefined, operations: readonly string[]): string[] | undefined {
  if (semanticCapabilities !== 2) return undefined;
  const granted = new Set(operations);
  return (Object.keys(APPLICATION_CAPABILITY_DEFINITIONS) as ApplicationCapabilityId[]).filter((group) =>
    group !== "offline.replica" && APPLICATION_CAPABILITY_DEFINITIONS[group].every((operation) => granted.has(operation)));
}

/** The fingerprint the daemon (#88) and the consent screen show: first 8 bytes of `SHA-256("mdbase/v1/client-fp" ‖ client_pk)`. */
export function clientFingerprint(clientPk: Uint8Array): string {
  const hex = createHash("sha256").update("mdbase/v1/client-fp").update(clientPk).digest("hex").slice(0, 16);
  return hex.match(/.{4}/g)!.join("-");
}
