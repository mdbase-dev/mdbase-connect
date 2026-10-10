/** First-party unary LS HTTP + staged object transfers. No account/key custody defaults. */
import { sha256 } from "@noble/hashes/sha2.js";
import { decode, encode, type CborValue } from "../cbor.js";
import { uuidToBytes } from "../codec.js";
import type { AppLogCall, AppLogTransport } from "./log-pump.js";

const MAX_FRAME = 16 * 1024 * 1024, MAX_OBJECT = 9 * 1024 * 1024;
const METHODS = new Set(["append", "read", "head", "subscribe", "unsubscribe", "put_object", "get_object", "has_objects", "put_snapshot", "get_snapshot", "endorse_snapshot", "stream_join", "stream_leave", "stream_send"]);
const FORBIDDEN = new Set(["host", "content-length", "transfer-encoding", "connection", "keep-alive", "upgrade", "te", "trailer", "expect", "range", "cookie", "authorization", "proxy-authorization", "origin", "referer", "accept-charset", "accept-encoding", "access-control-request-headers", "access-control-request-method", "date", "dnt", "permissions-policy", "set-cookie", "via"]);
const utf8 = new TextEncoder();
type MapValue = Map<CborValue, CborValue>;
export class AppHttpLogError extends Error {
  constructor(readonly reason: "binding" | "fenced" | "shape" | "unavailable" | "integrity") { super(`app log transport: ${reason}`); this.name = "AppHttpLogError"; }
}
const error = (reason: AppHttpLogError["reason"]) => new AppHttpLogError(reason);
/** A domain-specific proof, never a generic device signer reachable by grant clients. */
export interface AppLogHttpProof {
  readonly endpoint: number | bigint;
  readonly originalCallId: number | bigint;
  /** Exact frame and bearer needed for the fixed WASM transcript, not a digest signer. */
  readonly frame: Uint8Array;
  readonly token: string;
  readonly method: string;
  readonly path: "/v1/rpc";
  readonly collection: string;
  readonly nonce: Uint8Array;
  readonly bodyHash: Uint8Array;
  readonly tokenHash: Uint8Array;
  readonly digest: Uint8Array;
}
/** Supplied by authenticated account/device selection and protected signing custody. */
export interface AppLogHttpAuthority {
  readonly endpoint: number | bigint;
  readonly collection: string;
  readonly origin: string;
  /** Exact approved first-party object-store origins, captured before any send. */
  readonly directOrigins: readonly string[];
  isCurrent(): boolean;
  accessToken(options: { signal: AbortSignal }): Promise<string>;
  signLogProof(proof: AppLogHttpProof, options: { signal: AbortSignal }): Promise<Uint8Array>;
}
export interface AppLogHttpOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** Explicit local harness only. Production requires HTTPS for every origin. */
  allowLoopbackHttp?: boolean;
}
function uint64(v: unknown): bigint {
  if ((typeof v !== "number" || !Number.isSafeInteger(v)) && typeof v !== "bigint") throw error("shape");
  const n = BigInt(v as number | bigint); if (n < 0n || n > (1n << 64n) - 1n) throw error("shape"); return n;
}
function number(v: unknown, max: number): number { const n = uint64(v); if (n > BigInt(max)) throw error("shape"); return Number(n); }
function map(v: CborValue | undefined): MapValue { if (!(v instanceof Map)) throw error("shape"); return v as MapValue; }
function struct(m: MapValue): Map<number, CborValue> {
  const entries: [number, CborValue][] = [];
  for (const [key, value] of m) { if (typeof key !== "number" || !Number.isSafeInteger(key) || key < 0) throw error("shape"); entries.push([key, value]); }
  return new Map(entries.sort(([a], [b]) => a - b));
}
function bytes(v: CborValue | undefined, length?: number): Uint8Array { if (!(v instanceof Uint8Array) || (length !== undefined && v.length !== length)) throw error("shape"); return v; }
function equal(a: Uint8Array, b: Uint8Array): boolean { return a.length === b.length && a.every((v, i) => v === b[i]); }
function hex(b: Uint8Array): string { return [...b].map(v => v.toString(16).padStart(2, "0")).join(""); }
function base64(b: Uint8Array): string { return btoa(String.fromCharCode(...b)); }
function origin(input: string, loopback: boolean): string {
  let u: URL; try { u = new URL(input); } catch { throw error("binding"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.username || u.password || u.pathname !== "/" || u.search || u.hash || (u.protocol !== "https:" && !(loopback && local && u.protocol === "http:"))) throw error("binding");
  return u.origin;
}
/** Fetch exposes decoded bytes; CORS can hide Content-Encoding. Wire length
 * is never a decoded-size assertion, only an early over-cap hint. */
function wireOverCap(response: Response, cap: number): boolean {
  const input = response.headers.get("content-length");
  return input !== null && /^(0|[1-9][0-9]*)$/.test(input) && Number(input) > cap;
}
/** Exact public ls-http transcript, shared with native/hosted verifier. */
function proof(endpoint: number | bigint, originalCallId: bigint, method: string, collection: string, token: string, frame: Uint8Array, nonce: Uint8Array): AppLogHttpProof {
  const domain = utf8.encode("mdbase/v1/ls-http"), m = utf8.encode(method), path = utf8.encode("/v1/rpc");
  const tokenBytes = utf8.encode(token), tokenHash = sha256(tokenBytes), bodyHash = sha256(frame);
  tokenBytes.fill(0);
  const pre = new Uint8Array(1 + domain.length + m.length + 1 + path.length + 1 + 16 + 96);
  let at = 0;
  for (const part of [Uint8Array.of(domain.length), domain, m, Uint8Array.of(0), path, Uint8Array.of(0), uuidToBytes(collection), tokenHash, bodyHash, nonce]) { pre.set(part, at); at += part.length; }
  const digest = sha256(pre); pre.fill(0);
  return Object.freeze({ endpoint, originalCallId, frame: frame.slice(), token, method, path: "/v1/rpc", collection, nonce: nonce.slice(), bodyHash, tokenHash, digest });
}
interface Request { id: bigint; method: string; params: MapValue }
interface Direct { url: string; headers: Headers; expires: number }

/** All operations are bound to ONE immutable authenticated generation. A throw is
 * unknown outcome; AppLogPump feeds NoResponse, never an invented rejection/save. */
export class AppHttpLogTransport implements AppLogTransport {
  readonly endpoint: number | bigint;
  readonly collection: string;
  private readonly endpointId: bigint;
  private readonly collectionBytes: Uint8Array;
  private readonly base: string;
  private readonly approved: ReadonlySet<string>;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly loopback: boolean;
  private commitId = (1n << 64n) - 1n;
  constructor(private readonly authority: AppLogHttpAuthority, options: AppLogHttpOptions = {}) {
    try {
      this.endpointId = uint64(authority.endpoint); this.endpoint = this.endpointId;
      this.collection = authority.collection; this.collectionBytes = uuidToBytes(this.collection);
      this.loopback = options.allowLoopbackHttp === true;
      this.base = origin(authority.origin, this.loopback);
      if (!Array.isArray(authority.directOrigins) || authority.directOrigins.length > 32) throw error("binding");
      this.approved = new Set(authority.directOrigins.map(v => origin(v, this.loopback)));
      this.fetchImpl = options.fetch ?? globalThis.fetch; this.now = options.now ?? Date.now;
    } catch { throw error("binding"); }
  }
  isCurrent(): boolean {
    try { return this.authority.isCurrent() === true && uint64(this.authority.endpoint) === this.endpointId && this.authority.collection === this.collection && origin(this.authority.origin, this.loopback) === this.base; }
    catch { return false; }
  }
  private check(signal: AbortSignal): void { if (signal.aborted || !this.isCurrent()) throw error("fenced"); }
  private request(frame: Uint8Array): Request {
    if (frame.length > MAX_FRAME) throw error("shape");
    const m = map(decode(frame));
    if (m.get(0) !== 0 || typeof m.get(2) !== "string") throw error("shape");
    const method = m.get(2) as string, params = map(m.get(3));
    if (!METHODS.has(method) || !equal(bytes(params.get(0), 16), this.collectionBytes)) throw error("shape");
    return { id: uint64(m.get(1)), method, params };
  }
  private response(frame: Uint8Array, id: bigint): MapValue {
    const m = map(decode(frame));
    if (m.get(0) !== 1 || uint64(m.get(1)) !== id || m.has(2) === m.has(3)) throw error("shape");
    return m;
  }
  private async fetch(url: string, init: RequestInit, parent: AbortSignal, milliseconds: number): Promise<Response> {
    this.check(parent);
    const ctrl = new AbortController(), abort = () => ctrl.abort();
    parent.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, milliseconds); (timer as { unref?: () => void }).unref?.();
    try {
      // Free-function invocation also works with browser/Worker native fetch.
      const fetchImpl = this.fetchImpl;
      const r = await fetchImpl(url, { ...init, signal: ctrl.signal, redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
      if (!this.isCurrent() || parent.aborted) { void r.body?.cancel().catch(() => {}); throw error("fenced"); }
      // Keep abort/timeout active through body consumption, not just headers.
      return this.withCleanup(r, () => { clearTimeout(timer); parent.removeEventListener("abort", abort); });
    } catch { clearTimeout(timer); parent.removeEventListener("abort", abort); throw error(parent.aborted || !this.isCurrent() ? "fenced" : "unavailable"); }
  }
  private cleanups = new WeakMap<Response, () => void>();
  private withCleanup(r: Response, cleanup: () => void): Response { this.cleanups.set(r, cleanup); return r; }
  private release(r: Response): void { this.cleanups.get(r)?.(); this.cleanups.delete(r); }
  private async read(r: Response, cap: number, signal: AbortSignal): Promise<Uint8Array> {
    let buf = new Uint8Array(Math.min(1024, cap)), total = 0, reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      this.check(signal);
      if (wireOverCap(r, cap)) throw error("integrity");
      if (!r.body) return buf.subarray(0, 0);
      reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        try {
          this.check(signal); if (done) break;
          if (total + value.length > cap) throw error("integrity");
          if (total + value.length > buf.length) { const next = new Uint8Array(Math.min(cap, Math.max(buf.length * 2, total + value.length))); next.set(buf.subarray(0, total)); buf.fill(0); buf = next; }
          buf.set(value, total); total += value.length;
        } finally { value?.fill(0); }
      }
      return buf.subarray(0, total);
    } catch (e) { buf.fill(0); void (reader?.cancel() ?? r.body?.cancel())?.catch(() => {}); throw e; }
    finally { reader?.releaseLock(); this.release(r); }
  }
  private async rpc(frame: Uint8Array, method: string, id: bigint, signal: AbortSignal, originalId = id): Promise<Uint8Array> {
    this.check(signal); const token = await this.authority.accessToken({ signal }); this.check(signal);
    if (typeof token !== "string" || !token || token.length > 16 * 1024 || /[\r\n]/.test(token)) throw error("shape");
    const nr = await this.fetch(`${this.base}/v1/nonce`, {}, signal, 15_000);
    if (!nr.ok) { void nr.body?.cancel().catch(() => {}); this.release(nr); throw error("unavailable"); }
    const raw = await this.read(nr, 128, signal);
    let nonce: Uint8Array;
    try { this.check(signal); const text = new TextDecoder("utf-8", { fatal: true }).decode(raw).trim(); if (!/^[0-9a-f]{64}$/.test(text)) throw error("shape"); nonce = Uint8Array.from(text.match(/../g)!.map(v => parseInt(v, 16))); } finally { raw.fill(0); }
    this.check(signal); const p = proof(this.endpoint, originalId, method, this.collection, token, frame, nonce); nonce.fill(0);
    let signature: Uint8Array | null = null;
    try {
      signature = await this.authority.signLogProof(p, { signal }); this.check(signal);
      if (!(signature instanceof Uint8Array) || signature.length !== 64) throw error("shape");
      const r = await this.fetch(`${this.base}/v1/rpc`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/cbor", "x-mdbase-nonce": hex(p.nonce), "x-mdbase-sig": hex(signature) }, body: frame as BodyInit }, signal, 15_000);
      if (!r.ok) { void r.body?.cancel().catch(() => {}); this.release(r); throw error("unavailable"); }
      const reply = await this.read(r, method === "append" ? 64 * 1024 : MAX_FRAME, signal);
      try { this.check(signal); this.response(reply, id); return reply; } catch (e) { reply.fill(0); throw e; }
    } finally { signature?.fill(0); p.frame.fill(0); p.nonce.fill(0); p.bodyHash.fill(0); p.tokenHash.fill(0); p.digest.fill(0); }
  }
  private direct(value: CborValue | undefined, checksum: Uint8Array): Direct {
    const m = map(value), rawUrl = m.get(0), rawHeaders = map(m.get(1)), expiry = m.get(2);
    if (typeof rawUrl !== "string" || rawUrl.length > 16 * 1024 || typeof expiry !== "number" || !Number.isSafeInteger(expiry)) throw error("shape");
    let url: URL; try { url = new URL(rawUrl); } catch { throw error("shape"); }
    if (url.username || url.password || url.hash || !this.approved.has(url.origin)) throw error("binding");
    const headers = new Headers(), names = new Set<string>();
    if (rawHeaders.size > 32) throw error("shape");
    for (const [key, val] of rawHeaders) {
      if (typeof key !== "string" || typeof val !== "string") throw error("shape");
      const name = key.toLowerCase();
      if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || FORBIDDEN.has(name) || name.startsWith("proxy-") || name.startsWith("sec-") || name.startsWith("x-mdbase-") || name.startsWith("x-http-method") || names.has(name) || val.length > 8 * 1024 || /[\r\n]/.test(val)) throw error("shape");
      if (name === "x-amz-checksum-sha256" && val !== base64(checksum)) throw error("integrity");
      names.add(name); headers.set(name, val);
    }
    if (expiry - this.now() <= 5_000) throw error("unavailable");
    return { url: url.href, headers, expires: expiry };
  }
  private timeout(d: Direct, size: number): number { const left = d.expires - this.now(); if (left <= 5_000) throw error("unavailable"); return Math.min(left, 30_000 + Math.ceil(size / (128 * 1024)) * 1_000); }
  private async upload(d: Direct, object: Uint8Array, signal: AbortSignal): Promise<void> {
    this.check(signal); let r: Response;
    try { r = await this.fetch(d.url, { method: "PUT", headers: d.headers, body: object as BodyInit }, signal, this.timeout(d, object.length)); }
    catch (e) { this.check(signal); if (e instanceof AppHttpLogError && e.reason === "unavailable") return; throw e; } // Unknown PUT: only commit can decide.
    try {
      this.check(signal);
      if (r.ok || r.status === 408 || r.status === 425 || r.status === 429 || r.status >= 500) return;
      throw error("unavailable");
    } finally { void r.body?.cancel().catch(() => {}); this.release(r); }
  }
  private async download(d: Direct, size: number, checksum: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
    const out = new Uint8Array(size); let got = 0, stalled = 0;
    try {
      for (let requests = 0; requests < 32 && stalled < 5; requests++) {
        this.check(signal); const start = got, headers = new Headers(d.headers);
        if (start > 0) headers.set("range", `bytes=${start}-${size - 1}`);
        let r: Response;
        try { r = await this.fetch(d.url, { headers }, signal, this.timeout(d, size - start)); }
        catch { this.check(signal); stalled++; continue; }
        let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
        try {
          this.check(signal);
          if ([401, 403, 404, 410].includes(r.status)) throw error("unavailable");
          if ([408, 425, 429].includes(r.status) || r.status >= 500) { stalled++; continue; }
          if (r.status !== (start === 0 ? 200 : 206) || wireOverCap(r, size - start) || (start > 0 ? r.headers.get("content-range") !== `bytes ${start}-${size - 1}/${size}` : r.headers.has("content-range"))) throw error("integrity");
          if (r.headers.has("content-encoding") && r.headers.get("content-encoding") !== "identity") throw error("integrity");
          const ck = r.headers.get("x-amz-checksum-sha256"); if (ck !== null && ck !== base64(checksum)) throw error("integrity");
          if (!r.body) throw error("integrity"); reader = r.body.getReader();
          for (;;) {
            let part: ReadableStreamReadResult<Uint8Array>;
            try { part = await reader.read(); } catch { this.check(signal); break; }
            try { this.check(signal); if (part.done) break; if (part.value.length > size - got) throw error("integrity"); out.set(part.value, got); got += part.value.length; }
            finally { part.value?.fill(0); }
          }
        } finally { void (reader?.cancel() ?? r.body?.cancel())?.catch(() => {}); reader?.releaseLock(); this.release(r); }
        if (got === size) { if (!equal(sha256(out), checksum)) throw error("integrity"); return out; }
        stalled = got > start ? 0 : stalled + 1;
      }
      throw error("unavailable");
    } catch (e) { out.fill(0); throw e; }
  }
  async send(call: AppLogCall, options: { signal: AbortSignal }): Promise<Uint8Array> {
    let frame: Uint8Array | null = null, sidecar: Uint8Array | null = null, reply: Uint8Array | null = null, object: Uint8Array | null = null, commit: Uint8Array | null = null;
    try {
      this.check(options.signal);
      if (uint64(call.endpoint) !== this.endpointId || !(call.frame instanceof Uint8Array) || call.frame.length > MAX_FRAME || (call.sidecar !== undefined && (!(call.sidecar instanceof Uint8Array) || call.sidecar.length > MAX_OBJECT))) throw error("shape");
      frame = call.frame.slice(); sidecar = call.sidecar?.slice() ?? null;
      const request = this.request(frame);
      if (sidecar && request.method !== "put_object") throw error("shape");
      if (request.method === "put_object") {
        const size = number(request.params.get(3), MAX_OBJECT), ck = bytes(request.params.get(4), 32), inline = request.params.get(5);
        if (size === 0 || (sidecar !== null && (inline !== undefined || sidecar.length <= 1024 * 1024)) || (sidecar === null && size > 1024 * 1024)) throw error("shape");
        const body = sidecar ?? bytes(inline);
        if (body.length !== size || !equal(sha256(body), ck)) throw error("integrity");
      }
      reply = await this.rpc(frame, request.method, request.id, options.signal); this.check(options.signal);
      const response = this.response(reply, request.id);
      if (response.has(3)) { const result = reply; reply = null; return result; }
      if (request.method === "put_object") {
        const result = map(response.get(2)), status = result.get(0);
        if (status === 0 || status === 2) { if (result.has(1)) throw error("shape"); const out = reply; reply = null; return out; }
        if (status !== 1 || !sidecar) throw error("shape");
        const ck = bytes(request.params.get(4), 32), address = bytes(request.params.get(1), 32);
        await this.upload(this.direct(result.get(1), ck), sidecar, options.signal); this.check(options.signal);
        // Host-only IDs occupy a separate descending namespace; never reuse the
        // original ID. Unary HTTP has no multiplexed outstanding commit scope.
        if (this.commitId === request.id || this.commitId === 0n) throw error("unavailable");
        const id = this.commitId--;
        commit = encode(new Map<number, CborValue>([[0, 0], [1, id], [2, "commit_object"], [3, new Map<number, CborValue>([[0, this.collectionBytes], [1, address]])]]));
        const committed = await this.rpc(commit, "commit_object", id, options.signal, request.id);
        try { this.check(options.signal); const c = this.response(committed, id); if (c.has(3) || c.get(2) !== true) throw error("unavailable"); }
        finally { committed.fill(0); }
        const normalized = new Map(result); normalized.delete(1); normalized.set(0, 0);
        response.set(2, struct(normalized)); return encode(struct(response));
      }
      if (request.method === "get_object") {
        const result = map(response.get(2)), size = number(result.get(2), MAX_OBJECT), ck = bytes(result.get(3), 32);
        if (size === 0 || result.has(0) === result.has(1)) throw error("shape");
        const range = request.params.get(2);
        let offset = 0, count = size;
        if (range !== undefined) { if (!Array.isArray(range) || range.length !== 2) throw error("shape"); offset = number(range[0], MAX_OBJECT); count = number(range[1], MAX_OBJECT); if (offset > size || count > size - offset) throw error("shape"); }
        if (result.has(0)) { const inline = bytes(result.get(0)); if (inline.length !== count || (count === size && !equal(sha256(inline), ck))) throw error("integrity"); const out = reply; reply = null; return out; }
        object = await this.download(this.direct(result.get(1), ck), size, ck, options.signal); this.check(options.signal);
        const normalized = new Map(result); normalized.delete(1); normalized.set(0, object.subarray(offset, offset + count));
        response.set(2, struct(normalized)); return encode(struct(response));
      }
      const out = reply; reply = null; return out;
    } catch (e) { if (e instanceof AppHttpLogError) throw e; throw error(options.signal.aborted || !this.isCurrent() ? "fenced" : "unavailable"); }
    finally { frame?.fill(0); sidecar?.fill(0); reply?.fill(0); object?.fill(0); commit?.fill(0); }
  }
}
