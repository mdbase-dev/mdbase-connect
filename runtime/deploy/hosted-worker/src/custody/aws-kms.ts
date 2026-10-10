/** Direct SigV4 KMS for the hosted role. No registry, plaintext persistence,
 * cross-request signing cache, credential fallback or response-selected key.
 * The core supplies deployment-scoped Worker secrets; aws4fetch is pinned 1.0.20.
 */
import { AwsClient } from "aws4fetch";
import { configuredEnvelope, encodeEnvelope } from "./envelope.ts";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const NIL = "00000000-0000-0000-0000-000000000000";
const SECRET_BYTES = 96;
const CIPHER_BYTES = 8192;
const RESPONSE_BYTES = 16 * 1024;

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Trusted issuer expiry for future STS credentials; not needed for IAM keys. */
  expiresAt?: number;
}

export interface HostedKmsConfig {
  keyArn: string;
  region: string;
  environment: "lab" | "staging" | "production";
  /** Exact deployment-owned collections; never inferred from a request. */
  collections: readonly string[];
}

function fail(code: string): never { throw new Error(code); }
function validUuid(id: string): boolean { return UUID.test(id) && id !== NIL; }
function base64(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw);
}
function unbase64(value: unknown, max: number): Uint8Array {
  if (typeof value !== "string" || value.length === 0 ||
      value.length > Math.ceil(max / 3) * 4 || value.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail("kms_invalid_response");
  let raw: string;
  try { raw = atob(value); } catch { return fail("kms_invalid_response"); }
  if (raw.length > max || btoa(raw) !== value) fail("kms_invalid_response");
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > RESPONSE_BYTES)) {
    await response.body?.cancel();
    return fail("kms_invalid_response");
  }
  const reader = response.body?.getReader();
  if (!reader) return fail("kms_invalid_response");
  const buffer = new Uint8Array(RESPONSE_BYTES);
  let length = 0;
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new Error("kms_aborted"));
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try {
    signal.throwIfAborted();
    for (;;) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) break;
      if (next.value.byteLength > RESPONSE_BYTES - length) fail("kms_invalid_response");
      buffer.set(next.value, length);
      length += next.value.byteLength;
    }
    signal.throwIfAborted();
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buffer.subarray(0, length)));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("kms_invalid_response");
    return parsed as Record<string, unknown>;
  } catch {
    await reader.cancel();
    return fail(signal.aborted ? "kms_aborted" : "kms_invalid_response");
  } finally {
    if (rejectAbort) signal.removeEventListener("abort", rejectAbort);
    buffer.fill(0);
    reader.releaseLock();
  }
}

export class HostedAwsKms {
  private readonly keyArn: string;
  private readonly region: string;
  private readonly environment: HostedKmsConfig["environment"];
  private readonly collections: ReadonlySet<string>;
  private readonly endpoint: string;
  private readonly credentials: () => AwsCredentials | null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(
    config: HostedKmsConfig,
    credentials: () => AwsCredentials | null,
    fetchImpl: typeof fetch = fetch,
    now: () => number = Date.now,
  ) {
    this.credentials = credentials;
    this.fetchImpl = fetchImpl;
    this.now = now;
    // Commercial AWS only until another partition has a reviewed endpoint mapping.
    const match = /^arn:aws:kms:([a-z]{2}(?:-[a-z]+)+-\d):\d{12}:key\/([0-9a-f-]+)$/.exec(config.keyArn);
    if (!match || match[1] !== config.region || !validUuid(match[2]) ||
        !["lab", "staging", "production"].includes(config.environment) ||
        config.collections.length > 500 || !config.collections.every(validUuid)) fail("kms_invalid_config");
    this.keyArn = config.keyArn;
    this.region = config.region;
    this.environment = config.environment;
    this.collections = new Set(config.collections);
    this.endpoint = `https://kms.${this.region}.amazonaws.com/`;
  }

  private context(collection: string, device: string): Record<string, string> {
    if (!validUuid(collection) || !validUuid(device) || !this.collections.has(collection)) fail("kms_collection_not_allowed");
    return {
      "mdbase:service": "next-hosted",
      "mdbase:environment": this.environment,
      "mdbase:collection-id": collection,
      "mdbase:device-id": device,
      "mdbase:purpose": "device-key",
      "mdbase:envelope-version": "1",
    };
  }

  private async call(operation: "Encrypt" | "Decrypt", body: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    const activeSignal = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
    activeSignal.throwIfAborted();
    let client: AwsClient | undefined;
    try {
      const creds = this.credentials();
      const now = this.now();
      if (!creds || !Number.isSafeInteger(now) || !/^[A-Z0-9]{10,128}$/.test(creds.accessKeyId) ||
          typeof creds.secretAccessKey !== "string" || creds.secretAccessKey.length < 16 || creds.secretAccessKey.length > 256 ||
          (creds.sessionToken !== undefined && (creds.sessionToken.length === 0 || creds.sessionToken.length > 8192 ||
            !Number.isSafeInteger(creds.expiresAt) || creds.expiresAt! <= now + 30_000)) ||
          (creds.expiresAt !== undefined && (!Number.isSafeInteger(creds.expiresAt) || creds.expiresAt <= now + 30_000))) {
        return fail("kms_credentials_unavailable");
      }
      // Instance/cache scoped to this operation, never shared across tenants/wakes.
      client = new AwsClient({ ...creds, region: this.region, service: "kms", retries: 0 });
      const request = await client.sign(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": `TrentService.${operation}` },
        body: JSON.stringify({ ...body, KeyId: this.keyArn, EncryptionAlgorithm: "SYMMETRIC_DEFAULT" }),
        // workerd supports follow/manual, not redirect:error. Manual plus the
        // !ok check below rejects 3xx without forwarding signed credentials.
        redirect: "manual", signal: activeSignal,
        aws: { datetime: new Date(this.now()).toISOString().replace(/[:-]|\.\d{3}/g, "") },
      });
      activeSignal.throwIfAborted();
      const response = await this.fetchImpl(request);
      if (!response.ok) {
        await response.body?.cancel();
        return fail("kms_refused");
      }
      const result = await boundedJson(response, activeSignal);
      if (result.KeyId !== this.keyArn || result.EncryptionAlgorithm !== "SYMMETRIC_DEFAULT") fail("kms_invalid_response");
      return result;
    } catch (error) {
      // Never propagate an SDK/network error containing credentials/request data.
      if (error instanceof Error && ["kms_refused", "kms_invalid_response", "kms_aborted", "kms_credentials_unavailable"].includes(error.message)) throw error;
      return fail(activeSignal.aborted ? "kms_aborted" : "kms_unavailable");
    } finally {
      if (client) {
        for (const key of client.cache.values()) new Uint8Array(key).fill(0);
        client.cache.clear();
      }
    }
  }

  /** Structurally implements the core DeviceKeyWrapper seam. Caller wipes input. */
  async wrapDeviceKeys(input: { collection: string; device: string; secret: Uint8Array }, signal: AbortSignal): Promise<{ envelope: Uint8Array; kmsKeyArn: string }> {
    if (input.secret.length !== SECRET_BYTES) fail("custody_secret_invalid");
    const context = this.context(input.collection, input.device);
    const copy = input.secret.slice();
    try {
      const response = await this.call("Encrypt", { Plaintext: base64(copy), EncryptionContext: context }, signal);
      return { envelope: encodeEnvelope(this.keyArn, unbase64(response.CiphertextBlob, CIPHER_BYTES)), kmsKeyArn: this.keyArn };
    } finally { copy.fill(0); }
  }

  /** Return an owned RAM buffer; caller must wipe it in finally after verification. */
  async unwrapDeviceKeys(collection: string, device: string, envelope: Uint8Array, reportedArn: string, signal: AbortSignal): Promise<Uint8Array> {
    if (reportedArn !== this.keyArn) fail("custody_key_not_configured");
    const parsed = configuredEnvelope(envelope, [this.keyArn]);
    const response = await this.call("Decrypt", {
      CiphertextBlob: base64(parsed.ciphertext), EncryptionContext: this.context(collection, device),
    }, signal);
    const plain = unbase64(response.Plaintext, SECRET_BYTES);
    if (plain.length !== SECRET_BYTES) { plain.fill(0); return fail("custody_secret_invalid"); }
    return plain;
  }
}
