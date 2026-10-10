/**
 * Today's hosted provider (`connect-hosted-provider`) crypto, read side only: the
 * per-column AES-256-GCM envelope `0x01 ‖ nonce[12] ‖ ct ‖ tag`, its JSON identity
 * AADs, and collection-key unwrapping (legacy deployment key, or AWS KMS in an
 * `MDBK` envelope). A faithful port of migration's reviewed native reader
 * (`mdbn-legacy::hosted`) for the Worker: no native crate is imported.
 *
 * The collection key never leaves WebCrypto: it is imported non-extractable for
 * `decrypt` only, and the unwrapped raw bytes are wiped immediately.
 */

/** Why a row could not be opened. Messages never carry plaintext. */
export class LegacyCryptoError extends Error {
  constructor(readonly code: "envelope" | "authentication" | "wrapped_key" | "kms" | "decode" | "inconsistent", message: string) {
    super(message);
  }
}

/** The provider's identity-tuple AADs (`serde_json` of arrays; sequences are bare numbers). */
export const aad = {
  resourceDocument: (cid: string, path: string) => json(["resource_document", cid, path]),
  currentRecord: (cid: string, rid: string, sequence: number) => json(["current_record", cid, rid, sequence]),
  currentFile: (cid: string, fid: string, sequence: number) => json(["current_file", cid, fid, sequence]),
  changeRecord: (cid: string, sequence: number, side: "before" | "after") => json(["change_record", cid, sequence, side]),
  changeFile: (cid: string, sequence: number, side: "before" | "after") => json(["change_file", cid, sequence, side]),
  collectionKey: (cid: string) => json(["collection_key", cid]),
};

function json(v: unknown[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(v));
}

/** Open an envelope with an imported AES-GCM key. */
export async function openEnvelope(key: CryptoKey, envelope: Uint8Array, additionalData: Uint8Array): Promise<Uint8Array> {
  if (envelope.length <= 13 || envelope[0] !== 1) throw new LegacyCryptoError("envelope", "ciphertext envelope is invalid");
  try {
    return new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: envelope.subarray(1, 13), additionalData }, key, envelope.subarray(13)));
  } catch {
    throw new LegacyCryptoError("authentication", "ciphertext failed authentication");
  }
}

async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  try {
    if (raw.length !== 32) throw new LegacyCryptoError("wrapped_key", "unwrapped key is not 32 bytes");
    return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  } finally {
    raw.fill(0);
  }
}

/** A parsed `collections.wrapped_data_key`. */
export type WrappedKey =
  | { kind: "legacy"; envelope: Uint8Array }
  | { kind: "kms"; keyRef: string; ciphertext: Uint8Array };

const MDBK = [0x4d, 0x44, 0x42, 0x4b];

/** Classify and parse exactly as the provider's `key_wrapping/envelope.rs`. */
export function parseWrappedKey(value: Uint8Array): WrappedKey {
  const isMdbk = value.length >= 4 && MDBK.every((b, i) => value[i] === b);
  if (value[0] === 1 && !isMdbk) return { kind: "legacy", envelope: value };
  const bad = (m: string) => new LegacyCryptoError("wrapped_key", m);
  if (value.length < 12 || !isMdbk) throw bad("not an MDBK envelope");
  if (value[4] !== 1 || value[5] !== 1) throw bad("unsupported MDBK version or scheme");
  const keyRefLen = (value[6] << 8) | value[7];
  const ctLen = ((value[8] << 24) >>> 0) + (value[9] << 16) + (value[10] << 8) + value[11];
  if (keyRefLen === 0 || keyRefLen > 2048 || ctLen === 0 || ctLen > 8192 || value.length !== 12 + keyRefLen + ctLen) {
    throw bad("MDBK lengths are inconsistent");
  }
  let keyRef: string;
  try {
    keyRef = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(value.subarray(12, 12 + keyRefLen));
  } catch {
    throw bad("key_ref is not UTF-8");
  }
  if (![...keyRef].every((c) => c > " " && c <= "~" && c !== '"' && c !== "\\")) throw bad("key_ref has invalid characters");
  return { kind: "kms", keyRef, ciphertext: value.subarray(12 + keyRefLen) };
}

/** KMS `Decrypt` with an exact encryption context (the host supplies it; no AWS here). */
export interface LegacyKmsDecrypt {
  decrypt(ciphertext: Uint8Array, context: Record<string, string>, signal: AbortSignal): Promise<{ keyId: string; plaintext: Uint8Array }>;
}

/** The exact KMS encryption context for a collection key (ADR 0003). */
export function kmsContext(environment: string, cid: string): Record<string, string> {
  return {
    "mdbase:service": "hosted-provider",
    "mdbase:environment": environment,
    "mdbase:purpose": "collection-data-key",
    "mdbase:envelope-version": "1",
    "mdbase:collection-id": cid,
  };
}

/** The returned KeyId names the enveloped key, or the same multi-region key elsewhere. */
export function sameKmsKey(returned: string, enveloped: string): boolean {
  if (returned === enveloped) return true;
  const mrk = (arn: string) => { const i = arn.lastIndexOf("key/"); return i < 0 ? null : arn.slice(i + 4); };
  const a = mrk(returned);
  const b = mrk(enveloped);
  return a !== null && b !== null && a.startsWith("mrk-") && a === b;
}

/** How to unwrap collection keys in one environment (the legacy role's own config). */
export interface LegacyUnwrapper {
  /** `staging` / `production` / `local` (LAB, tests). */
  environment: string;
  /** The legacy deployment master key, imported non-extractable, if any row may need it. */
  legacyMasterKey?: CryptoKey;
  /** KMS, if any row may need it. */
  kms?: LegacyKmsDecrypt;
}

/** Unwrap collection `cid`'s data key into a non-extractable decrypt-only CryptoKey. */
export async function unwrapCollectionKey(u: LegacyUnwrapper, wrapped: Uint8Array, cid: string, signal: AbortSignal): Promise<CryptoKey> {
  const w = parseWrappedKey(wrapped);
  if (w.kind === "legacy") {
    if (!u.legacyMasterKey) throw new LegacyCryptoError("wrapped_key", "legacy key not configured");
    return importKey(await openEnvelope(u.legacyMasterKey, w.envelope, aad.collectionKey(cid)));
  }
  if (!u.kms) throw new LegacyCryptoError("kms", "KMS not configured");
  const { keyId, plaintext } = await u.kms.decrypt(w.ciphertext, kmsContext(u.environment, cid), signal);
  signal.throwIfAborted();
  if (!sameKmsKey(keyId, w.keyRef)) {
    plaintext.fill(0);
    throw new LegacyCryptoError("kms", "decrypted by a different key");
  }
  return importKey(plaintext);
}

/** `"sha256:<hex>"` of bytes (the provider's revision form). */
export async function revisionOf(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${[...d].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
