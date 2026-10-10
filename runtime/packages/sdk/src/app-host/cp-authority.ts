/** Enrolled-device CP log-token refresh + protected WASM proof authority.
 * Not registration, account login, key custody storage or readiness admission. */
import { uuidToBytes } from "../codec.js";
import { AppHttpLogTransport, type AppLogHttpAuthority, type AppLogHttpOptions, type AppLogHttpProof } from "./http-log.js";
import type { AppCpConnectorPin, AppWasmRuntime } from "./wasm-runtime.js";

export interface AppCpSession extends AppCpConnectorPin {
  readonly endpoint: number | bigint;
  readonly cpOrigin: string;
  readonly logOrigin: string;
  readonly directOrigins: readonly string[];
  /** Actual authenticated connector credential; never a device seed/signing API. */
  connectorBearer(options: { signal: AbortSignal }): Promise<string>;
}
export class AppCpAuthorityError extends Error {
  constructor(readonly reason: "binding" | "fenced" | "unavailable" | "response") { super(`app CP authority: ${reason}`); this.name = "AppCpAuthorityError"; }
}
const fail = (r: AppCpAuthorityError["reason"]) => new AppCpAuthorityError(r);
function origin(input: string, loopback: boolean): string {
  let u: URL; try { u = new URL(input); } catch { throw fail("binding"); }
  if (u.username || u.password || u.pathname !== "/" || u.search || u.hash || (u.protocol !== "https:" && !(loopback && u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)))) throw fail("binding");
  return u.origin;
}
function uint(v: number | bigint): bigint { if (typeof v === "number" && !Number.isSafeInteger(v)) throw fail("binding"); const n = BigInt(v); if (n < 0n || n > (1n << 64n) - 1n) throw fail("binding"); return n; }
function hex(b: Uint8Array): string { return [...b].map(v => v.toString(16).padStart(2, "0")).join(""); }
function object(v: unknown): Record<string, unknown> { if (!v || typeof v !== "object" || Array.isArray(v)) throw fail("response"); return v as Record<string, unknown>; }

/** Construct after genuine connector/backend selection + registered-device
 * protected unwrap. Call await accessToken BEFORE bindLogTransport. */
export class AppCpLogAuthority implements AppLogHttpAuthority {
  readonly endpoint: bigint;
  readonly collection: string;
  readonly origin: string;
  readonly directOrigins: readonly string[];
  private readonly cpOrigin: string;
  private readonly connectorId: string;
  private readonly deviceId: string;
  private readonly rawCpOrigin: string;
  private readonly rawLogOrigin: string;
  private readonly now: () => number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly lifetime = new AbortController();
  private authenticated = false;
  private token: { value: string; expires: number } | null = null;
  private readonly transport: AppHttpLogTransport;
  constructor(private readonly runtime: AppWasmRuntime, private readonly session: AppCpSession, options: AppLogHttpOptions = {}) {
    try {
      this.endpoint = uint(session.endpoint); this.collection = session.collection; this.connectorId = session.connectorId; this.deviceId = session.deviceId;
      for (const id of [this.collection, this.connectorId, this.deviceId]) { const b = uuidToBytes(id); if (b.every(v => v === 0)) throw fail("binding"); }
      this.rawCpOrigin = session.cpOrigin; this.rawLogOrigin = session.logOrigin;
      this.cpOrigin = origin(this.rawCpOrigin, options.allowLoopbackHttp === true); this.origin = origin(this.rawLogOrigin, options.allowLoopbackHttp === true);
      this.directOrigins = Object.freeze([...session.directOrigins]); this.now = options.now ?? Date.now; this.fetchImpl = options.fetch ?? globalThis.fetch;
      this.transport = new AppHttpLogTransport(this, options); // validates direct-origin budget/policy before pinning.
      if (!this.scopeCurrent()) throw fail("binding");
      runtime.bindCpConnector(session);
    } catch { throw fail("binding"); }
  }
  private scopeCurrent(): boolean {
    try { return !this.lifetime.signal.aborted && this.session.isCurrent() === true && uint(this.session.endpoint) === this.endpoint && this.session.collection === this.collection && this.session.connectorId === this.connectorId && this.session.deviceId === this.deviceId && this.session.cpOrigin === this.rawCpOrigin && this.session.logOrigin === this.rawLogOrigin; }
    catch { return false; }
  }
  /** Token age/connectivity are NOT identity loss: offline tentative edits retain
   * their verified local lifetime. Fresh token is required by accessToken for RPC. */
  isCurrent(): boolean { return this.authenticated && this.scopeCurrent(); }
  private check(signal: AbortSignal): void {
    if (!this.scopeCurrent()) { this.close(); throw fail("fenced"); }
    if (signal.aborted) throw fail("fenced");
  }
  /** Available only after an actual validated CP token response. */
  logTransport(): AppHttpLogTransport { if (!this.isCurrent()) throw fail("fenced"); return this.transport; }
  async signLogProof(proof: AppLogHttpProof, options: { signal: AbortSignal }): Promise<Uint8Array> {
    this.check(options.signal); if (!this.authenticated) throw fail("fenced");
    return this.runtime.signLogHttp(proof);
  }
  private async json(path: string, bearer: string, body: string | undefined, parent: AbortSignal): Promise<Record<string, unknown>> {
    this.check(parent); const ctrl = new AbortController(), abort = () => ctrl.abort();
    parent.addEventListener("abort", abort, { once: true }); this.lifetime.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 15_000); (timer as { unref?: () => void }).unref?.();
    let response: Response | null = null, reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const bytes = new Uint8Array(32 * 1024); let count = 0;
    try {
      const fetchImpl = this.fetchImpl;
      response = await fetchImpl(`${this.cpOrigin}${path}`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body, signal: ctrl.signal, redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
      this.check(parent); if (ctrl.signal.aborted) throw fail("unavailable");
      if (!response.ok) throw fail("unavailable");
      // Content-Encoding may be hidden by CORS; Content-Length is wire-only.
      const length = response.headers.get("content-length");
      if (length !== null && /^(0|[1-9][0-9]*)$/.test(length) && Number(length) > bytes.length) {ctrl.abort(); throw fail("unavailable");}
      if (!response.body) throw fail("response"); reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        try { this.check(parent); if (ctrl.signal.aborted) throw fail("unavailable"); if (done) break; if (count + value.length > bytes.length) {ctrl.abort(); throw fail("response");} bytes.set(value, count); count += value.length; }
        finally { value?.fill(0); }
      }
      return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count))));
    } catch (e) { this.check(parent); if (e instanceof AppCpAuthorityError) throw e; throw fail("unavailable"); }
    finally { bytes.fill(0); void (reader?.cancel() ?? response?.body?.cancel())?.catch(() => {}); reader?.releaseLock(); clearTimeout(timer); parent.removeEventListener("abort", abort); this.lifetime.signal.removeEventListener("abort", abort); }
  }
  /** Exactly one fresh challenge + mint attempt; no hidden retry/timers. Current
   * callers may schedule a new attempt after an uncertain/expired proof outcome. */
  async accessToken(options: { signal: AbortSignal }): Promise<string> {
    let challenge: Uint8Array | null = null, signature: Uint8Array | null = null;
    try {
      this.check(options.signal);
      if (this.token && this.token.expires - this.now() > 5_000) return this.token.value;
      const bearer = await this.session.connectorBearer(options); this.check(options.signal);
      if (typeof bearer !== "string" || !bearer || bearer.length > 16 * 1024 || /[^\x21-\x7e]/.test(bearer)) throw fail("binding");
      const issued = await this.json("/v1/next/devices/challenge", bearer, undefined, options.signal); this.check(options.signal);
      if (typeof issued.challenge !== "string" || !/^[0-9a-f]{64}$/.test(issued.challenge) || typeof issued.expires_at !== "number" || !Number.isSafeInteger(issued.expires_at) || issued.expires_at - this.now() <= 5_000) throw fail("response");
      challenge = Uint8Array.from(issued.challenge.match(/../g)!.map(v => parseInt(v, 16)));
      signature = this.runtime.signCpLogToken(challenge); this.check(options.signal);
      if (!(signature instanceof Uint8Array) || signature.length !== 64) throw fail("response");
      const body = JSON.stringify({ device_id: this.deviceId, challenge: issued.challenge, sig: hex(signature) });
      const minted = await this.json(`/v1/next/collections/${this.collection}/log-token`, bearer, body, options.signal); this.check(options.signal);
      if (typeof minted.token !== "string" || !minted.token || minted.token.length > 16 * 1024 || /[^\x21-\x7e]/.test(minted.token) || typeof minted.expires_at !== "number" || !Number.isSafeInteger(minted.expires_at) || minted.expires_at - this.now() <= 5_000 || minted.expires_at - this.now() > 16 * 60_000) throw fail("response");
      this.token = { value: minted.token, expires: minted.expires_at }; this.authenticated = true; return minted.token;
    } catch (e) { if (e instanceof AppCpAuthorityError) throw e; throw fail(this.scopeCurrent() ? "unavailable" : "fenced"); }
    finally { challenge?.fill(0); signature?.fill(0); }
  }
  close(): void { if (this.lifetime.signal.aborted) return; this.lifetime.abort(); this.token = null; this.authenticated = false; this.runtime.retireLog(); }
}
