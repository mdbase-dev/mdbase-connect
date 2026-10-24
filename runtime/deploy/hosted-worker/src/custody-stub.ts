/**
 * LAB-only custody stub for newly generated service devices (env.LAB === "1" and
 * `LAB_CUSTODY_WRAP_KEY` set). It stands in for KMS in the `DeviceKeyWrapper` seam:
 * AES-256-GCM under a LAB secret, with the encryption context (role, environment,
 * collection, device, purpose, version) as additional data, so an envelope opens
 * only for the record it was made for. Never active in production: production
 * custody is KMS.
 *
 * Envelope: `"MDBK" ‖ 0x01 ‖ iv(12) ‖ AES-GCM(secret, aad = context JSON)`.
 */
import type { DeviceKeyWrapper } from "./seams.js";

/** The stand-in "key ARN" recorded with every stub envelope. */
export const LAB_STUB_ARN = "arn:aws:kms:lab-stub:000000000000:key/mdbase-lab-custody-stub";
const MAGIC = new TextEncoder().encode("MDBK");

function fromHex(s: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(s)) throw new Error("hex");
  return Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
}

/** The additional data binding an envelope to its record. */
export function stubContext(role: "hosted" | "escrow", collection: string, device: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ v: 1, role, env: "lab", collection, device, purpose: "device-key" }));
}

async function key(hex: string, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  const raw = fromHex(hex);
  try {
    if (raw.length !== 32) throw new Error("custody_unavailable");
    return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [usage]);
  } finally {
    raw.fill(0);
  }
}

/** The stub wrapper for `role`, or `null` when the LAB key is absent. */
export function labStubWrapper(role: "hosted" | "escrow", wrapKeyHex: string | undefined): DeviceKeyWrapper | null {
  if (!wrapKeyHex) return null;
  return {
    async wrapDeviceKeys({ collection, device, secret }, signal) {
      signal.throwIfAborted();
      // Exactly the 96-byte device secret (sign ‖ kem ‖ noise), nothing else.
      if (secret.length !== 96) throw new Error("custody_unavailable");
      const k = await key(wrapKeyHex, "encrypt");
      signal.throwIfAborted();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: stubContext(role, collection, device) }, k, secret));
      // Aborted while encrypting: no envelope is returned for a cancelled request.
      signal.throwIfAborted();
      const envelope = new Uint8Array(MAGIC.length + 1 + iv.length + ct.length);
      envelope.set(MAGIC, 0);
      envelope[MAGIC.length] = 1;
      envelope.set(iv, MAGIC.length + 1);
      envelope.set(ct, MAGIC.length + 1 + iv.length);
      return { envelope, kmsKeyArn: LAB_STUB_ARN };
    },
  };
}

/** Open a stub envelope for exactly this record (role, collection, device). */
export async function labStubUnwrap(
  wrapKeyHex: string, role: "hosted" | "escrow", collection: string, device: string, envelope: Uint8Array,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const head = MAGIC.length + 1 + 12;
  if (envelope.length <= head + 16 || !MAGIC.every((b, i) => envelope[i] === b) || envelope[MAGIC.length] !== 1) {
    throw new Error("custody_unavailable");
  }
  const k = await key(wrapKeyHex, "decrypt");
  signal?.throwIfAborted();
  const iv = envelope.subarray(MAGIC.length + 1, head);
  const secret = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: stubContext(role, collection, device) }, k, envelope.subarray(head)));
  if (signal?.aborted) {
    secret.fill(0);
    signal.throwIfAborted();
  }
  return secret;
}
