/** Read-only legacy provider KMS. Distinct from next-hosted device-key custody.
 * Only the SigV4 primitive is shared; credentials, context and policy are not.
 * IAM must independently restrict Decrypt to the approved provider keys/context.
 */
import { AwsClient } from "aws4fetch";
import type { AwsCredentials } from "../custody/aws-kms.ts";
import { kmsContext, LegacyCryptoError } from "./crypto.ts";
import type { LegacyKmsDecrypt } from "./crypto.ts";

export interface LegacyAwsKmsConfig {
  region: string;
  environment: "lab" | "staging" | "production";
  collections: readonly string[];
  /** Immutable historical keys, not just the current writer's alias target. */
  keyArns: readonly string[];
}

const MAX_KEYS = 32;
const MAX_COLLECTIONS = 16;
const RESPONSE_BYTES = 16 * 1024;
const TIMEOUT_MS = 8000;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const NIL = "00000000-0000-0000-0000-000000000000";
// Fixed commercial AWS endpoint mapping. No caller-selected host/partition,
// pseudo-regions, FIPS/dualstack variants, China or GovCloud endpoints.
const REGIONS = new Set([
  "af-south-1", "ap-east-1", "ap-east-2", "ap-northeast-1", "ap-northeast-2", "ap-northeast-3",
  "ap-south-1", "ap-south-2", "ap-southeast-1", "ap-southeast-2", "ap-southeast-3", "ap-southeast-4",
  "ap-southeast-5", "ap-southeast-6", "ap-southeast-7", "ca-central-1", "ca-west-1",
  "eu-central-1", "eu-central-2", "eu-north-1", "eu-south-1", "eu-south-2",
  "eu-west-1", "eu-west-2", "eu-west-3", "il-central-1", "me-central-1", "me-south-1",
  "mx-central-1", "sa-east-1", "us-east-1", "us-east-2", "us-west-1", "us-west-2",
]);
function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value) && value !== NIL;
}
function keyArn(value: unknown): { account: string; resource: string } | null {
  if (typeof value !== "string" || value.length > 256) return null;
  const m = /^arn:aws:kms:([^:]+):(\d{12}):key\/(.+)$/.exec(value);
  if (!m || !REGIONS.has(m[1]) || !(validUuid(m[3]) || /^mrk-[0-9a-f]{32}$/.test(m[3]))) return null;
  return { account: m[2], resource: m[3] };
}
function fail(code: string): never { throw new LegacyCryptoError("kms", code); }

/** Pure settings validation: never resolves aliases, credentials, or AWS state. */
export function validateLegacyKmsConfig(config: LegacyAwsKmsConfig): void {
  if (!config || !REGIONS.has(config.region) || !["lab", "staging", "production"].includes(config.environment) ||
      !Array.isArray(config.collections) || config.collections.length > MAX_COLLECTIONS ||
      !Array.from(config.collections).every(validUuid) || new Set(config.collections).size !== config.collections.length ||
      !Array.isArray(config.keyArns) || config.keyArns.length === 0 || config.keyArns.length > MAX_KEYS ||
      !Array.from(config.keyArns).every((arn) => keyArn(arn) !== null) || new Set(config.keyArns).size !== config.keyArns.length) {
    fail("kms_invalid_config");
  }
}

function base64(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw);
}
function plaintext(value: unknown): Uint8Array {
  // Decode at most 8192 bytes so even an invalid-length plaintext has bounded
  // owned storage which the caller's finally will wipe.
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(8192 / 3) * 4 ||
      value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail("kms_invalid_response");
  let raw: string;
  try { raw = atob(value); } catch { return fail("kms_invalid_response"); }
  if (btoa(raw) !== value || raw.length > 8192) fail("kms_invalid_response");
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Bound even a mock/uncooperative transport or stalled stream by the deadline. */
async function untilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(new LegacyCryptoError("kms", "kms_aborted"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    if (signal.aborted) fail("kms_aborted");
    return await Promise.race([work, aborted]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}
const TRANSIENT_KMS_ERRORS = /(?:^|#)(?:ThrottlingException|KMSInternalException|DependencyTimeoutException)$/;
function cancel(body: ReadableStream<Uint8Array> | null): void {
  // Cancellation must not defeat the total deadline if a stream ignores it.
  try { void body?.cancel().catch(() => {}); } catch { /* locked/closed */ }
}
async function boundedJson(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > RESPONSE_BYTES)) {
    cancel(response.body);
    return fail("kms_invalid_response");
  }
  const reader = response.body?.getReader();
  if (!reader) return fail("kms_invalid_response");
  const buffer = new Uint8Array(RESPONSE_BYTES);
  let length = 0;
  try {
    for (;;) {
      const next = await untilAbort(reader.read(), signal);
      if (next.done) break;
      if (next.value.byteLength > RESPONSE_BYTES - length) fail("kms_invalid_response");
      buffer.set(next.value, length);
      length += next.value.byteLength;
    }
    if (signal.aborted) fail("kms_aborted");
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buffer.subarray(0, length)));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("kms_invalid_response");
    return parsed as Record<string, unknown>;
  } catch {
    try { void reader.cancel().catch(() => {}); } catch { /* already closed */ }
    return fail(signal.aborted ? "kms_aborted" : "kms_invalid_response");
  } finally {
    buffer.fill(0);
    reader.releaseLock();
  }
}

export class LegacyAwsKms implements LegacyKmsDecrypt {
  private readonly region: string;
  private readonly environment: LegacyAwsKmsConfig["environment"];
  private readonly collections: ReadonlySet<string>;
  private readonly keyArns: readonly string[];
  private readonly endpoint: string;
  private readonly credentials: () => AwsCredentials | null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(config: LegacyAwsKmsConfig, credentials: () => AwsCredentials | null, fetchImpl: typeof fetch = fetch, now: () => number = Date.now) {
    validateLegacyKmsConfig(config);
    this.region = config.region;
    this.environment = config.environment;
    this.collections = new Set(config.collections);
    this.keyArns = Object.freeze([...config.keyArns]);
    this.endpoint = `https://kms.${this.region}.amazonaws.com/`;
    this.credentials = credentials;
    // Receiver-neutral for the native Worker global fetch.
    this.fetchImpl = (input, init) => fetchImpl(input, init);
    this.now = now;
  }

  private allowedKey(value: unknown): value is string {
    const returned = keyArn(value);
    if (!returned) return false;
    if (this.keyArns.includes(value as string)) return true;
    // Historical MRK replicas: same commercial partition AND account, not an
    // arbitrary same-named resource from another account. IAM still must allow it.
    return returned.resource.startsWith("mrk-") && this.keyArns.some((arn) => {
      const approved = keyArn(arn)!;
      return returned.account === approved.account && returned.resource === approved.resource;
    });
  }

  async decrypt(ciphertext: Uint8Array, context: Record<string, string>, signal: AbortSignal): Promise<{ keyId: string; plaintext: Uint8Array }> {
    const cid = context?.["mdbase:collection-id"];
    if (!validUuid(cid) || !this.collections.has(cid)) fail("kms_collection_not_allowed");
    const expected = kmsContext(this.environment, cid);
    if (Reflect.ownKeys(context).length !== 5 || Object.entries(expected).some(([k, v]) =>
      !Object.hasOwn(context, k) || context[k] !== v)) fail("kms_invalid_context");
    if (!(ciphertext instanceof Uint8Array) || ciphertext.length < 1 || ciphertext.length > 8192) fail("kms_invalid_ciphertext");
    // Snapshot validated inputs before invoking credential/fetch callbacks.
    const body = JSON.stringify({ CiphertextBlob: base64(ciphertext), EncryptionContext: expected, EncryptionAlgorithm: "SYMMETRIC_DEFAULT" });
    const controller = new AbortController();
    const active = AbortSignal.any([signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let client: AwsClient | undefined;
    let plain: Uint8Array | undefined;
    let transferred = false;
    const wipeCache = () => {
      if (!client) return;
      for (const key of client.cache.values()) new Uint8Array(key).fill(0);
      client.cache.clear();
    };
    try {
      if (active.aborted) fail("kms_aborted");
      const creds = this.credentials();
      const now = this.now();
      // Same credential/STS expiry policy as hosted custody, but NO fallback to
      // its credentials or client. STS tokens require trusted issuer expiry.
      if (!creds || !Number.isSafeInteger(now) || typeof creds.accessKeyId !== "string" || !/^[A-Z0-9]{10,128}$/.test(creds.accessKeyId) ||
          typeof creds.secretAccessKey !== "string" || creds.secretAccessKey.length < 16 || creds.secretAccessKey.length > 256 ||
          (creds.sessionToken !== undefined && (typeof creds.sessionToken !== "string" || creds.sessionToken.length === 0 || creds.sessionToken.length > 8192 ||
            !Number.isSafeInteger(creds.expiresAt) || creds.expiresAt! <= now + 30_000)) ||
          (creds.expiresAt !== undefined && (!Number.isSafeInteger(creds.expiresAt) || creds.expiresAt <= now + 30_000))) fail("kms_credentials_unavailable");
      client = new AwsClient({ accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, sessionToken: creds.sessionToken,
        region: this.region, service: "kms", retries: 0 });
      const signing = client.sign(this.endpoint, {
        method: "POST", redirect: "manual", signal: active,
        headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "TrentService.Decrypt" },
        // Deliberately NO KeyId selector: ciphertext identifies the historical key.
        body, aws: { datetime: new Date(now).toISOString().replace(/[:-]|\.\d{3}/g, "") },
      });
      // If abort wins during WebCrypto signing, wipe any later cache insertion.
      void signing.then(() => { if (active.aborted) wipeCache(); }, wipeCache);
      const request = await untilAbort(signing, active);
      if (active.aborted) fail("kms_aborted");
      const fetching = this.fetchImpl(request);
      void fetching.then((response) => { if (active.aborted) cancel(response.body); }, () => {});
      const response = await untilAbort(fetching, active);
      if (!response.ok) {
        // Throttling/5xx/dependency timeouts say nothing about the envelope: the
        // caller retries them. Everything else (redirects, auth, key refusals) is final.
        if (response.status === 429 || response.status >= 500) { cancel(response.body); return fail("kms_unavailable"); }
        if (response.status === 400) {
          const type = await boundedJson(response, active).then(e => e.__type, () => undefined);
          if (typeof type === "string" && TRANSIENT_KMS_ERRORS.test(type)) return fail("kms_unavailable");
        } else cancel(response.body);
        return fail("kms_refused");
      }
      const result = await boundedJson(response, active);
      plain = plaintext(result.Plaintext);
      if (!this.allowedKey(result.KeyId) || result.EncryptionAlgorithm !== "SYMMETRIC_DEFAULT" || plain.length !== 32) fail("kms_invalid_response");
      if (active.aborted) fail("kms_aborted");
      transferred = true;
      return { keyId: result.KeyId, plaintext: plain };
    } catch (error) {
      // Never disclose SDK errors, JSON/body data, credentials or abort reasons.
      if (active.aborted) return fail("kms_aborted");
      if (error instanceof LegacyCryptoError && ["kms_refused", "kms_invalid_response", "kms_credentials_unavailable"].includes(error.message)) throw error;
      return fail("kms_unavailable");
    } finally {
      clearTimeout(timer);
      if (!transferred) plain?.fill(0);
      wipeCache();
    }
  }
}
