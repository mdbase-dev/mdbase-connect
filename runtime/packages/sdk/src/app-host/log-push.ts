/** The log's push socket, owned by the Worker that owns the replica. One socket
 * per open collection: `hello` over a single-use HTTP nonce (`n`), `subscribe`,
 * then `items`/`head`/`closed` pushes go straight to the native replica. Requests
 * never use this socket (the server refuses them); they stay on signed HTTPS.
 *
 * No timers poll the log. The socket keeps itself alive with text pings that the
 * Durable Object answers without waking. A lost socket reconnects with backoff
 * and catches up from the head the subscription returns; focus, visibility and
 * `online` reconnect at once. Once every tab is hidden and pending writes are
 * sent, the owner suspends the socket; showing a tab resumes and catches up.
 *
 * Framing stays extensible: `hello` negotiates the API version, every binary
 * frame carries its type at key 0 (1 response, 2 push) and every push a string
 * `kind` at key 1. Unknown frame types, push kinds and text messages are ignored,
 * never an error, so later message kinds need no protocol rework. */
import { LOCAL_APPLICATION_BUILD, localApplicationHttpOrigin } from "../application/local-build.js";
import { decode, encode, type CborValue } from "../cbor.js";
import { uuidToBytes } from "../codec.js";

/** Close codes set by the log (`deploy/cloudflare-do`). */
export const LOG_CLOSE_EXPIRED = 4401, LOG_CLOSE_FORBIDDEN = 4403, LOG_CLOSE_GONE = 4410;
const PING_MS = 30_000, PONG_MS = 10_000, HEALTHY_MS = 60_000, MAX_BACKOFF_MS = 60_000;
/** A socket that is not subscribed this long after it was made is treated as
 * lost: a blocked or hung socket may never fire `close`. */
const OPEN_MS = 15_000;
/** Attempts after a `hello` the runtime could not sign before push counts as
 * unavailable; a later focus, visibility or `online` tries again. */
const UNSIGNED_ATTEMPTS = 4;
const INLINE_BYTES = 64 * 1024, MAX_FRAME = 1024 * 1024;

/** `forbidden`: removed from the collection (or the device by policy);
 * `revoked`: this device's sign-in was revoked; `gone`: the collection is deleted. */
export type AppLogPushEnd = "forbidden" | "revoked" | "gone";
export interface AppLogPushSource {
  /** The log's HTTPS origin (the same one RPCs go to). */
  readonly origin: string;
  readonly collection: string;
  readonly deviceId: string;
  isCurrent(): boolean;
  accessToken(options: { signal: AbortSignal }): Promise<string>;
  invalidateToken?(token: string): void;
  /** A fresh single-use nonce from `GET /v1/nonce`. */
  nonce(options: { signal: AbortSignal }): Promise<Uint8Array>;
  /** Fixed-purpose `hello` proof by the native runtime; null when unsupported. */
  signHello(nonce: Uint8Array, token: string): Uint8Array | null;
}
export interface AppLogPushEvents {
  /** A push frame (`LsFrame::Push` bytes) for the replica. On every (re)subscribe
   * a `head` push is synthesized from the subscription's head: that is catch-up. */
  push(frame: Uint8Array): void;
  /** The socket became live or stopped being live. */
  live(live: boolean): void;
  /** Access ended (removed, revoked, or the collection is gone). Terminal. */
  ended(reason: AppLogPushEnd): void;
}
export interface AppLogPushOptions {
  WebSocket?: typeof globalThis.WebSocket;
  random?: () => number;
  now?: () => number;
  allowLoopbackHttp?: boolean;
}

function wsOrigin(input: string, loopback: boolean): string {
  const u = new URL(input);
  const local = LOCAL_APPLICATION_BUILD ? localApplicationHttpOrigin(input) : ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol === "https:") return `wss://${u.host}`;
  if (loopback && local && u.protocol === "http:") return `ws://${u.host}`;
  throw new Error("app log push: origin");
}
const hex = (b: Uint8Array) => [...b].map(v => v.toString(16).padStart(2, "0")).join("");
type MapValue = Map<CborValue, CborValue>;
const request = (id: number, method: string, params: Map<number, CborValue>) =>
  encode(new Map<number, CborValue>([[0, 0], [1, id], [2, method], [3, params]]));
function errorOf(m: MapValue): { code: string; reason: string } | null {
  const e = m.get(3);
  if (!(e instanceof Map)) return null;
  const code = (e as MapValue).get(0), reason = (e as MapValue).get(1);
  return { code: typeof code === "string" ? code : "unavailable", reason: typeof reason === "string" ? reason : "" };
}

export class AppLogPushChannel {
  private readonly base: string;
  private readonly collectionBytes: Uint8Array;
  private readonly Ws: typeof globalThis.WebSocket;
  private readonly random: () => number;
  private readonly now: () => number;
  private socket: WebSocket | null = null;
  private connecting = false;
  private closed = false;
  private finished: AppLogPushEnd | null = null;
  private unsupported = false;
  private paused = false;
  private isLive = false;
  private attempts = 0;
  private liveSince = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private pongDue: ReturnType<typeof setTimeout> | null = null;
  private opening: ReturnType<typeof setTimeout> | null = null;
  private unsigned = 0;
  private life = new AbortController();
  private token: string | null = null;

  constructor(private readonly source: AppLogPushSource, private readonly events: AppLogPushEvents, options: AppLogPushOptions = {}) {
    this.base = wsOrigin(source.origin, options.allowLoopbackHttp === true);
    this.collectionBytes = uuidToBytes(source.collection);
    const Ws = options.WebSocket ?? globalThis.WebSocket;
    if (typeof Ws !== "function") throw new Error("app log push: no WebSocket");
    this.Ws = Ws; this.random = options.random ?? Math.random; this.now = options.now ?? Date.now;
  }
  /** Live: subscribed, so other devices' changes arrive as they commit. */
  get live(): boolean { return this.isLive; }
  /** Push is not available (an older runtime); callers fall back to event wakes. */
  get available(): boolean { return !this.unsupported && this.finished === null && !this.closed; }
  /** Closed on purpose while every tab is hidden; `resume` reconnects. */
  get suspended(): boolean { return this.paused; }
  start(): void { void this.connect(); }
  /** Focus, visibility or `online`: reconnect now if not connected. */
  nudge(): void {
    this.unsupported = false; this.unsigned = 0;
    if (this.paused || this.socket || this.connecting || !this.available) return;
    this.attempts = 0; this.clearRetry(); void this.connect();
  }
  /** Every tab hidden and nothing left to send: close the socket (code 1000)
   * and stop reconnecting. Nothing is lost: `resume` catches up from the head. */
  suspend(): void {
    if (this.paused || !this.available) return;
    this.paused = true; this.clearRetry(); this.drop(1000, "hidden");
  }
  resume(): void {
    if (!this.paused) { this.nudge(); return; }
    this.paused = false; this.nudge();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.life.abort(); this.clearRetry(); this.drop(1000, "closed");
  }

  private clearRetry(): void { if (this.retry !== null) clearTimeout(this.retry); this.retry = null; }
  private clearPing(): void {
    if (this.ping !== null) clearInterval(this.ping); this.ping = null;
    if (this.pongDue !== null) clearTimeout(this.pongDue); this.pongDue = null;
    if (this.opening !== null) clearTimeout(this.opening); this.opening = null;
  }
  private setLive(live: boolean): void {
    if (this.isLive === live) return;
    this.isLive = live; if (live) this.liveSince = this.now();
    try { this.events.live(live); } catch { /* observer cannot break the channel */ }
  }
  private end(reason: AppLogPushEnd): void {
    if (this.finished || this.closed) return;
    this.finished = reason; this.clearRetry(); this.drop(1000, reason);
    try { this.events.ended(reason); } catch { /* terminal either way */ }
  }
  private drop(code: number, why: string): void {
    this.clearPing();
    const s = this.socket; this.socket = null;
    if (s) { s.onopen = s.onmessage = s.onclose = s.onerror = null; try { s.close(code, why); } catch { /* already closed */ } }
    this.setLive(false);
  }
  /** Full-jitter backoff, 1 s → 60 s; reset after a minute of a healthy socket. */
  private schedule(immediate = false): void {
    if (this.paused || !this.available || this.retry !== null) return;
    const wait = immediate ? 0 : Math.floor(this.random() * Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(this.attempts, 6)));
    this.attempts++;
    this.retry = setTimeout(() => { this.retry = null; void this.connect(); }, wait);
  }
  private async connect(): Promise<void> {
    if (this.paused || this.socket || this.connecting || !this.available) return;
    if (!this.source.isCurrent()) { this.close(); return; }
    this.connecting = true;
    let token: string, nonce: Uint8Array, sig: Uint8Array | null;
    try {
      const signal = this.life.signal;
      token = await this.source.accessToken({ signal });
      nonce = await this.source.nonce({ signal });
      if (this.paused || !this.available || !this.source.isCurrent()) return;
      sig = this.source.signHello(nonce, token);
      // Not signable now (a runtime without it, or not ready yet): retry with
      // backoff a few times, then wait for the next focus, visibility or online.
      if (!sig) { if (++this.unsigned >= UNSIGNED_ATTEMPTS) this.unsupported = true; else this.schedule(); return; }
      this.unsigned = 0;
    } catch {
      this.connecting = false; this.schedule(); return;
    } finally { this.connecting = false; }
    this.token = token;
    let s: WebSocket;
    try { s = new this.Ws(`${this.base}/v1/ws?c=${this.source.collection}&n=${hex(nonce)}`); }
    catch { this.schedule(); return; }
    s.binaryType = "arraybuffer";
    this.socket = s;
    const hello = request(1, "hello", new Map<number, CborValue>([[0, [1, 0]], [1, token], [2, uuidToBytes(this.source.deviceId)], [3, sig]]));
    sig.fill(0); nonce.fill(0);
    s.onopen = () => { try { s.send(hello); } catch { this.lost(s, 1006); } };
    s.onmessage = event => this.message(s, event.data);
    s.onclose = event => this.lost(s, event.code);
    s.onerror = () => { /* onclose follows */ };
    this.opening = setTimeout(() => { this.opening = null; this.lost(s, 1006); }, OPEN_MS);
  }
  private message(s: WebSocket, data: unknown): void {
    if (s !== this.socket) return;
    if (typeof data === "string") {
      if (data === "pong" && this.pongDue !== null) { clearTimeout(this.pongDue); this.pongDue = null; }
      return;
    }
    if (!(data instanceof ArrayBuffer) || data.byteLength > MAX_FRAME) { this.lost(s, 1009); return; }
    const bytes = new Uint8Array(data);
    let m: MapValue;
    try { const v = decode(bytes); if (!(v instanceof Map)) throw new Error(); m = v as MapValue; }
    catch { this.lost(s, 1007); return; }
    if (m.get(0) === 2) {
      if (!this.isLive) return;
      this.deliver(bytes);
      if (m.get(1) === "closed") {
        const payload = m.get(2), reason = payload instanceof Map ? (payload as MapValue).get(1) : null;
        this.end(reason === "gone" ? "gone" : reason === "revoked" ? "revoked" : "forbidden");
      }
      return;
    }
    if (m.get(0) !== 1) return;
    const id = m.get(1), error = errorOf(m);
    if (id === 1) {
      if (error) { this.refused(s, error); return; }
      try { s.send(request(2, "subscribe", new Map<number, CborValue>([[0, this.collectionBytes], [1, 0], [2, INLINE_BYTES]]))); }
      catch { this.lost(s, 1006); }
      return;
    }
    if (id === 2) {
      if (error) { this.refused(s, error); return; }
      const result = m.get(2);
      if (!(result instanceof Map)) { this.lost(s, 1007); return; }
      const head = (result as MapValue).get(0), chain = (result as MapValue).get(1);
      this.startPing(s);
      this.setLive(true);
      // Catch-up: the subscription's head, as the replica's own `head` push.
      if ((typeof head === "number" || typeof head === "bigint") && chain instanceof Uint8Array && chain.length === 32)
        this.deliver(encode(new Map<number, CborValue>([[0, 2], [1, "head"], [2, new Map<number, CborValue>([[0, this.collectionBytes], [1, head], [2, chain]])]])));
    }
  }
  private deliver(frame: Uint8Array): void {
    try { this.events.push(frame); } catch { /* the replica decides; the channel continues */ }
  }
  private refused(s: WebSocket, e: { code: string; reason: string }): void {
    if (e.code === "forbidden" && e.reason === "credentials_revoked") { this.end("revoked"); return; }
    if (e.code === "forbidden" || e.code === "not_found") { this.end(e.code === "not_found" ? "gone" : "forbidden"); return; }
    if (e.code === "gone") { this.end("gone"); return; }
    if (e.code === "unauthenticated" && this.token) { this.source.invalidateToken?.(this.token); this.token = null; }
    this.lost(s, 1008);
  }
  private startPing(s: WebSocket): void {
    this.clearPing();
    this.ping = setInterval(() => {
      if (s !== this.socket || this.pongDue !== null) return;
      try { s.send("ping"); } catch { this.lost(s, 1006); return; }
      this.pongDue = setTimeout(() => { this.pongDue = null; this.lost(s, 1006); }, PONG_MS);
    }, PING_MS);
  }
  private lost(s: WebSocket, code: number): void {
    if (s !== this.socket) return;
    const healthy = this.isLive && this.now() - this.liveSince >= HEALTHY_MS;
    this.drop(1000, "lost");
    if (code === LOG_CLOSE_FORBIDDEN) { this.end("forbidden"); return; }
    if (code === LOG_CLOSE_GONE) { this.end("gone"); return; }
    if (healthy) this.attempts = 0;
    if (code === LOG_CLOSE_EXPIRED) {
      if (this.token) this.source.invalidateToken?.(this.token);
      this.token = null; this.attempts = 0; this.schedule(true); return;
    }
    this.schedule();
  }
}
