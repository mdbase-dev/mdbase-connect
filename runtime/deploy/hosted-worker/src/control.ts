/**
 * The hosted deployment's client of the Connect control plane (cloud-copy bootstrap;
 * Connect PRs #615/#616). Custody (src/custody/, hosted) uses it to read this
 * collection's service-device record and to obtain and refresh the role-0 log token.
 *
 * - `GET  <cp>/internal/v1/next/collections/:id/service-devices/hosted`
 * - `POST <cp>/internal/v1/next/service-devices/:device/log-token {collection}`
 *
 * Authenticated by the deployment's inbound control-plane token
 * (`MDBASE_NEXT_HOSTED_INTERNAL_TOKEN` on the Connect side). HTTPS only, no
 * redirects, bounded responses, abortable. A record is data to verify, not trust:
 * custody re-derives the public keys after unwrap and checks them against this record
 * and the log's enrolment. Tokens are cached in RAM only and refreshed a minute before
 * they expire.
 */

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const KEY = /^[0-9a-f]{64}$/;
const MAX_RECORD_BYTES = 128 * 1024;
const MAX_TOKEN_BYTES = 8 * 1024;
const MAX_WRAPPED_BYTES = 64 * 1024;
const TOKEN_LIFETIME_MS = 15 * 60_000;
const REFRESH_MARGIN_MS = 60_000;
const TIMEOUT_MS = 10_000;

export type ControlErrorCode = "unavailable" | "refused" | "not_standard" | "not_found" | "invalid";

export class ControlError extends Error {
  constructor(readonly code: ControlErrorCode, message: string) {
    super(message);
  }
}

export interface OriginalGenesis {
  seq: 1;
  /** Complete ORIGINAL signed CBOR bytes, never a log-discovered replacement. */
  item: Uint8Array;
  /** Plain SHA256 checksum only; native derives its own domain-separated pin. */
  hash: Uint8Array;
}

export interface ServiceDeviceRecord {
  kind: "hosted" | "escrow";
  deviceId: string;
  signPk: Uint8Array;
  kemPk: Uint8Array;
  noisePk: Uint8Array;
  /** The MDBK envelope, opaque here. */
  wrappedKeys: Uint8Array;
  kmsKeyArn: string;
  genesis: OriginalGenesis;
}

export interface LogToken {
  token: string;
  expiresAt: number;
}

const fromHex = (s: string) => Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)));

function fromBase64(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) return null;
  try {
    const binary = atob(s);
    return btoa(binary) === s ? Uint8Array.from(binary, (c) => c.charCodeAt(0)) : null;
  } catch {
    return null;
  }
}

function statusError(status: number): ControlError {
  if (status === 409) return new ControlError("not_standard", "the collection is not a current cloud copy");
  if (status === 404) return new ControlError("not_found", "no such service device");
  if (status >= 500) return new ControlError("unavailable", `control plane answered ${status}`);
  return new ControlError("refused", `control plane answered ${status}`);
}

/** Fixed diagnostic vocabulary only: never expose a fetch exception's URL,
 * credentials, response content or arbitrary message to callers/logs. */
function fetchFailure(cause: unknown, signal: AbortSignal): string {
  if (typeof AbortSignal.any !== "function") return "abort_any_unavailable";
  if (typeof AbortSignal.timeout !== "function") return "abort_timeout_unavailable";
  if (signal.aborted) return "caller_aborted";
  if (cause instanceof Error) {
    if (cause.name === "TimeoutError") return "timeout";
    if (cause.name === "AbortError") return "aborted";
    if (cause.message.includes("different request") || cause.message.includes("I/O on behalf")) return "io_context";
    if (cause.message.includes("signal") && cause.message.includes("AbortSignal")) return "signal_type";
    if (cause.name === "TypeError") return "type_error";
  }
  return "network";
}

export class ControlClient {
  private readonly base: string;
  private readonly token: string;
  private readonly tokens = new Map<string, LogToken>();
  private readonly kind: "hosted" | "escrow";

  constructor(
    config: { url: string; token: string; kind?: "hosted" | "escrow" },
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    const url = new URL(config.url);
    if (url.protocol !== "https:") throw new Error("the control plane URL must use https");
    if (config.token.length < 32) throw new Error("the control plane token must be at least 32 characters");
    this.base = url.toString().replace(/\/+$/, "");
    this.token = config.token;
    this.kind = config.kind ?? "hosted";
  }

  private async call(path: string, init: { method: "GET" | "POST"; body?: unknown }, limit: number, signal: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      // Workers' native fetch rejects a ControlClient receiver (Illegal invocation).
      // Invoke the injected/global callable as a free function, not an object method.
      const fetchImpl = this.fetchImpl;
      response = await fetchImpl(`${this.base}${path}`, {
        method: init.method,
        headers: { authorization: `Bearer ${this.token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined,
        // workerd rejects redirect: "error"; never follow (the bearer must not be
        // forwarded) and refuse any 3xx explicitly below.
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      });
    } catch (cause) {
      throw new ControlError("unavailable", `control plane unreachable (${fetchFailure(cause, signal)})`);
    }
    if ((response.type as string) === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      throw new ControlError("refused", "control plane redirected; not followed");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw statusError(response.status);
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const next = reader ? await reader.read() : { done: true as const, value: undefined };
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) {
        await reader!.cancel();
        throw new ControlError("invalid", "control plane answer too large");
      }
      chunks.push(next.value);
    }
    const all = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      all.set(c, off);
      off += c.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder().decode(all));
    } catch {
      throw new ControlError("invalid", "control plane answer is not JSON");
    }
  }

  /** This collection's service-device record of this deployment's kind. */
  async serviceDevice(collection: string, signal: AbortSignal): Promise<ServiceDeviceRecord> {
    if (!UUID.test(collection)) throw new ControlError("invalid", "collection");
    const r = (await this.call(`/internal/v1/next/collections/${collection}/service-devices/${this.kind}`, { method: "GET" }, MAX_RECORD_BYTES, signal)) as Record<string, unknown>;
    const ok = r && typeof r === "object" && Object.keys(r).length === 8
      && r.kind === this.kind && typeof r.device_id === "string" && UUID.test(r.device_id)
      && [r.sign_pk, r.kem_pk, r.noise_pk].every((k) => typeof k === "string" && KEY.test(k))
      && typeof r.wrapped_keys === "string" && typeof r.kms_key_arn === "string" && /^arn:[!-~]{1,2044}$/.test(r.kms_key_arn);
    const wrapped = ok ? fromBase64(r.wrapped_keys as string) : null;
    const g = ok ? r.genesis as Record<string, unknown> | undefined : undefined;
    const genesisOk = g && typeof g === "object" && !Array.isArray(g) && Object.keys(g).length === 3
      && g.seq === 1 && typeof g.item === "string" && g.item.length <= 4 * Math.ceil((64 << 10) / 3)
      && typeof g.hash === "string" && KEY.test(g.hash);
    const original = genesisOk ? fromBase64(g.item as string) : null;
    if (!ok || !wrapped || wrapped.length === 0 || wrapped.length > MAX_WRAPPED_BYTES
        || !genesisOk || !original || !original.length || original.length > 64 << 10) {
      throw new ControlError("invalid", "malformed service device record");
    }
    return {
      kind: this.kind,
      deviceId: r.device_id as string,
      signPk: fromHex(r.sign_pk as string),
      kemPk: fromHex(r.kem_pk as string),
      noisePk: fromHex(r.noise_pk as string),
      wrappedKeys: wrapped,
      kmsKeyArn: r.kms_key_arn as string,
      genesis: { seq: 1, item: original, hash: fromHex(g.hash as string) },
    };
  }

  /** A role-0 log token for `device` in `collection`, from cache while it has a minute left. */
  async logToken(device: string, collection: string, signal: AbortSignal): Promise<LogToken> {
    if (!UUID.test(device) || !UUID.test(collection)) throw new ControlError("invalid", "device or collection");
    const key = `${device}/${collection}`;
    const now = this.now();
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - REFRESH_MARGIN_MS > now) return cached;
    this.tokens.delete(key);
    const r = (await this.call(`/internal/v1/next/service-devices/${device}/log-token`, { method: "POST", body: { collection } }, MAX_TOKEN_BYTES, signal)) as Record<string, unknown>;
    const ok = r && typeof r === "object" && typeof r.token === "string" && /^[0-9a-f]+\.[0-9a-f]{128}$/.test(r.token)
      && typeof r.expires_at === "number" && Number.isSafeInteger(r.expires_at)
      && r.expires_at > now + REFRESH_MARGIN_MS && r.expires_at <= now + TOKEN_LIFETIME_MS + REFRESH_MARGIN_MS;
    if (!ok) throw new ControlError("invalid", "malformed log token");
    const token = { token: r.token as string, expiresAt: r.expires_at as number };
    this.tokens.set(key, token);
    return token;
  }

  /** Forget cached tokens (on revocation, a collection leaving sync, or a refused token). */
  forget(collection?: string): void {
    if (!collection) return this.tokens.clear();
    for (const key of [...this.tokens.keys()]) if (key.endsWith(`/${collection}`)) this.tokens.delete(key);
  }
}
