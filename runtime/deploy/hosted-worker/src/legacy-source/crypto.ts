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

/** Missing unwrap custody is a source contract refusal, not transient KMS I/O. */
export class LegacyKmsUnconfiguredError extends LegacyCryptoError {
  constructor() {
    super("kms", "KMS unwrap custody is not configured for this legacy source");
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
  } catch (error) {
    if (error instanceof LegacyCryptoError) throw error;
    throw new LegacyCryptoError("wrapped_key", "unwrapped key import failed");
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
    keyRef = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value.subarray(12, 12 + keyRefLen));
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

/** Pure immutable-reference validation, never a URL/alias resolver or authority grant.
 * The provider validates the stored reference BEFORE AWS Decrypt. This adapter
 * supports commercial KMS UUID/MRK ARNs; the separate client still validates
 * returned keys against its approved historical keys and fixed regional scope.
 */
function storedKmsKeyRef(value: unknown): { account: string; resource: string } | null {
  if (typeof value !== "string" || value.length > 256) return null;
  const m = /^arn:aws:kms:[a-z]+(?:-[a-z0-9]+)+-[0-9]+:(\d{12}):key\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}|mrk-[0-9a-f]{32})$/.exec(value);
  if (!m || m[2] === "00000000-0000-0000-0000-000000000000") return null;
  return { account: m[1], resource: m[2] };
}

/** Exact immutable ARN, or the same commercial/account MRK in another region. */
export function sameKmsKey(returned: string, enveloped: string): boolean {
  const a = storedKmsKeyRef(returned);
  const b = storedKmsKeyRef(enveloped);
  if (!a || !b) return false;
  if (returned === enveloped) return true;
  return a.account === b.account && a.resource.startsWith("mrk-") && a.resource === b.resource;
}

/** How to unwrap collection keys in one environment (the legacy role's own config). */
export interface LegacyUnwrapper {
  /** `lab` / `staging` / `production` for managed source bindings. */
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
  if (!storedKmsKeyRef(w.keyRef)) throw new LegacyCryptoError("wrapped_key", "KMS key reference is invalid");
  if (!u.kms) throw new LegacyKmsUnconfiguredError();
  const { keyId, plaintext } = await u.kms.decrypt(w.ciphertext, kmsContext(u.environment, cid), signal);
  try {
    if (signal.aborted) throw new LegacyCryptoError("kms", "KMS unwrap aborted");
    if (!sameKmsKey(keyId, w.keyRef)) throw new LegacyCryptoError("kms", "decrypted by a different key");
    const key = await importKey(plaintext);
    if (signal.aborted) throw new LegacyCryptoError("kms", "KMS unwrap aborted");
    return key;
  } finally {
    // Own the returned buffer immediately, including abort/validation/import
    // failures before importKey's own finally can take responsibility for it.
    plaintext.fill(0);
  }
}

/** `"sha256:<hex>"` of bytes (the provider's revision form). */
export async function revisionOf(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${[...d].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
