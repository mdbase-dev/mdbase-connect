/**
 * The recovery device's keys, derived from the recovery secret
 * (`sealed-envelope.md` §5.4):
 *
 *     seed_sign = HKDF-SHA256(ikm = R, salt = collection, info = "mdbase/v1/recovery-sign")   ; Ed25519 seed
 *     seed_kem  = HKDF-SHA256(ikm = R, salt = collection, info = "mdbase/v1/recovery-kem")    ; X25519 secret
 *     device ID = first 16 bytes of H("mdbase/v1/recovery-id", collection ‖ sign_pk)
 *     noise_pk  = 32 zero bytes
 *
 * `collection` is the 16-byte collection ID, so one paper key used for two
 * collections gives unrelated keys.
 *
 * The runtime (Rust) derives the same keys. This TS twin lets the Obsidian side
 * check an enrol item against the paper key itself, before keying the recovery
 * device. It is also checked against the shared vector, so a key printed
 * in Obsidian works in the daemon and vice versa.
 */

import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concat, domainHash, uuidBytes } from "../util/hash.js";
import type { EnrolledKeys } from "./sasProtocol.js";

const enc = new TextEncoder();

/** The recovery device's derived identity. `seedSign` and `seedKem` are secret. */
export interface RecoveryDevice {
  readonly device: string;
  readonly seedSign: Uint8Array;
  readonly seedKem: Uint8Array;
  readonly signPk: Uint8Array;
  readonly kemPk: Uint8Array;
  readonly noisePk: Uint8Array;
}

function uuidString(b: Uint8Array): string {
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Derive the recovery device for `collection` from the 32-byte secret. */
export async function deriveRecoveryDevice(secret: Uint8Array, collection: string): Promise<RecoveryDevice> {
  if (secret.length !== 32) throw new Error("recovery secret is 32 bytes");
  const salt = uuidBytes(collection);
  const seedSign = hkdf(sha256, secret, salt, enc.encode("mdbase/v1/recovery-sign"), 32);
  const seedKem = hkdf(sha256, secret, salt, enc.encode("mdbase/v1/recovery-kem"), 32);
  const signPk = ed25519.getPublicKey(seedSign);
  const kemPk = x25519.getPublicKey(seedKem);
  const id = (await domainHash("mdbase/v1/recovery-id", concat(salt, signPk))).slice(0, 16);
  return { device: uuidString(id), seedSign, seedKem, signPk, kemPk, noisePk: new Uint8Array(32) };
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * The `device-enrol` of the recovery device must carry exactly the
 * derived device ID, keys and an all-zero `noise_pk`. Check before any
 * `key_grant` or `rekey` includes it.
 */
export function recoveryEnrolMatches(derived: RecoveryDevice, item: Omit<EnrolledKeys, "sasCommit">): boolean {
  return item.device === derived.device && eq(item.signPk, derived.signPk) && eq(item.kemPk, derived.kemPk) && eq(item.noisePk, derived.noisePk);
}

/** Wipe the secret seeds. */
export function wipeRecoveryDevice(d: RecoveryDevice): void {
  d.seedSign.fill(0);
  d.seedKem.fill(0);
}
