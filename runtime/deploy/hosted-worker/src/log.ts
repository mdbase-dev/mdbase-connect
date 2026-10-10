/**
 * The log transport: unary HTTP RPC to the log Worker over the `LOG` service
 * binding (`GET /v1/nonce`, `POST /v1/rpc`), with the service device's bearer token
 * and an `ls-http` possession proof signed inside the engine. No standing socket,
 * so the DO can hibernate; new entries are learned by re-running the subscription.
 *
 * Failures never become definitive results: a transport error is "no response"
 * (the engine retries identical bytes), connectivity loss is "offline".
 */
import { decode, type CborValue } from "../../../packages/sdk/src/cbor.ts";
import type { Engine, LogCallOut } from "./engine.js";
import { appendObservation, type AppendObservation } from "./append-observe.ts";

const ORIGIN = "https://log.internal"; // service binding: the host part is ignored
const MAX_REPLY_BYTES = 16 << 20;
/** An append's reply is a small CBOR result. */
const MAX_APPEND_REPLY_BYTES = 64 << 10;
/** A nonce is 64 hex characters (plus optional whitespace). */
const MAX_NONCE_BYTES = 128;
const TIMEOUT_MS = 15_000;

/**
 * Whether the log session these calls belong to is still current. The DO bumps
 * its generation on a cache reset, an engine replacement or a pause; replies that
 * resolve after that are never fed to an engine (checked after every await).
 */
export type LogFence = () => boolean;

/** An append whose reply arrived for a stale session: its exact request bytes and
 * outcome (reply bytes, or null when unknown), kept apart from any engine. */
export interface StaleAppend {
  id: number;
  frame: Uint8Array;
  reply: Uint8Array | null;
}

function lsMethod(frame: Uint8Array): { method: string; key0: Uint8Array | null } {
  const m = decode(frame) as Map<number, CborValue>;
  const method = m.get(2);
  if (typeof method !== "string") throw new Error("log frame without method");
  const params = m.get(3);
  const k = params instanceof Map ? (params as Map<number, CborValue>).get(0) : undefined;
  return { method, key0: k instanceof Uint8Array && k.length === 16 ? k : null };
}

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * The body, read incrementally and refused as soon as it passes `cap`: a missing
 * or untrusted Content-Length never sizes an allocation (the stream is cancelled).
 */
export async function boundedBytes(r: Response, cap = MAX_REPLY_BYTES): Promise<Uint8Array> {
  const declared = r.headers.get("content-length");
  if (declared !== null && Number(declared) > cap) {
    await r.body?.cancel();
    throw new Error("reply over budget");
  }
  if (!r.body) return new Uint8Array(0);
  const reader = r.body.getReader();
  // One growing buffer (old copies wiped), never the parts plus a full copy.
  let buf = new Uint8Array(Math.min(cap, Math.max(1024, Number(declared ?? 0) || 0)));
  let total = 0;
  let ok = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > cap) throw new Error("reply over budget");
      if (total + value.byteLength > buf.length) {
        const next = new Uint8Array(Math.min(cap, Math.max(buf.length * 2, total + value.byteLength)));
        next.set(buf.subarray(0, total));
        buf.fill(0);
        buf = next;
      }
      buf.set(value, total);
      value.fill(0);
      total += value.byteLength;
    }
    ok = true;
    // A view, not a copy: the peak stays one buffer.
    return buf.subarray(0, total);
  } finally {
    if (!ok) {
      buf.fill(0);
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}

/**
 * Bounded custody for appends whose outcome arrives after their session moved:
 * credits are reserved BEFORE an append is sent, so a stale outcome is always
 * kept (never evicted); with no credit left the append is not sent (busy) and
 * the engine retries the same bytes later.
 */
export class StaleAppendStore {
  private held: StaleAppend[] = [];
  private bytes = 0;
  private reserved = 0;
  private reservedBytes = 0;
  constructor(
    private readonly maxCount = 64,
    private readonly maxBytes = 8 << 20,
  ) {}
  /** Reserve room for one append of `frameBytes` (plus its bounded reply). */
  reserve(frameBytes: number): boolean {
    const need = frameBytes + MAX_APPEND_REPLY_BYTES;
    if (this.held.length + this.reserved + 1 > this.maxCount) return false;
    if (this.bytes + this.reservedBytes + need > this.maxBytes) return false;
    this.reserved += 1;
    this.reservedBytes += need;
    return true;
  }
  /** Release a reservation, keeping `a` when its session went stale. */
  settle(frameBytes: number, a: StaleAppend | null): void {
    this.reserved -= 1;
    this.reservedBytes -= frameBytes + MAX_APPEND_REPLY_BYTES;
    if (a) {
      this.held.push(a);
      this.bytes += a.frame.length + (a.reply?.length ?? 0);
    }
  }
  get count(): number {
    return this.held.length;
  }
}

/**
 * The log over its public HTTPS origin instead of a service binding (a log Worker
 * in another account: the shared LAB log). Paths are the binding's; redirects
 * are refused, never followed.
 */
export function httpsLog(origin: string): Fetcher {
  const base = new URL(origin);
  if (base.protocol !== "https:" || base.pathname !== "/" || base.search || base.hash) {
    throw new Error("LOG_URL must be an https origin");
  }
  return {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const r = await fetch(new URL(url.pathname, base).href, { ...init, redirect: "manual" });
      if (r.status >= 300 && r.status < 400) {
        await r.body?.cancel();
        throw new Error("log redirect refused");
      }
      return r;
    },
    connect() {
      throw new Error("no sockets");
    },
  } as unknown as Fetcher;
}

export async function sendCall(
  log: Fetcher,
  engine: Pick<Engine, "signRpc" | "logReply" | "logFailed">,
  token: string,
  call: LogCallOut,
  fence: LogFence,
  stale: StaleAppendStore,
  observeAppend?: (call: LogCallOut, observation: AppendObservation) => void,
  readReplyCap = MAX_REPLY_BYTES,
): Promise<void> {
  if (!fence()) return;
  // Everything about the call is captured ONCE, before any await: its ID, method,
  // key, and exact wire bytes. The same bytes are signed, sent, and (if the
  // session goes stale) retained; a caller mutating `call` later changes nothing.
  const id = call.id;
  if (call.sidecar) {
    // Direct object upload (> 1 MiB) is not wired yet: outcome unknown, retried.
    engine.logFailed(id, false);
    return;
  }
  let parsed: { method: string; key0: Uint8Array | null };
  try {
    parsed = lsMethod(call.frame);
  } catch {
    engine.logFailed(id, false);
    return;
  }
  const { method } = parsed;
  const key0 = parsed.key0 ? parsed.key0.slice() : null;
  const isAppend = method === "append";
  // Credit for a possibly stale outcome is reserved BEFORE the copy is made.
  const size = call.frame.length;
  if (isAppend && !stale.reserve(size)) {
    engine.logFailed(id, false);
    return;
  }
  const frame = call.frame.slice();
  let kept: StaleAppend | null = null;
  let reply: Uint8Array | null = null;
  let httpStatus: number | undefined;
  const observe = (observation: AppendObservation) => {
    if (!isAppend || !fence()) return;
    try { observeAppend?.(call, observation); } catch { /* No transport effects. */ }
  };
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const nr = await log.fetch(`${ORIGIN}/v1/nonce`, { signal });
    if (!fence()) {
      await nr.body?.cancel();
      return markStale();
    }
    const nonceHex = new TextDecoder().decode(await boundedBytes(nr, MAX_NONCE_BYTES)).trim();
    if (!fence()) return markStale();
    if (!nr.ok || !/^[0-9a-f]{64}$/.test(nonceHex)) throw new Error("nonce");
    const nonce = Uint8Array.from(nonceHex.match(/../g)!.map((h) => parseInt(h, 16)));
    const sig = engine.signRpc(method, key0, token, frame, nonce);
    const r = await log.fetch(`${ORIGIN}/v1/rpc`, {
      method: "POST",
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/cbor",
        "x-mdbase-nonce": nonceHex,
        "x-mdbase-sig": hex(sig),
      },
      body: frame,
    });
    if (!fence()) {
      // Sent: an append's (small, bounded) outcome is kept; anything else is
      // cancelled at once rather than drained.
      if (isAppend && r.ok) reply = await boundedBytes(r, MAX_APPEND_REPLY_BYTES).catch(() => null);
      else await r.body?.cancel();
      return markStale();
    }
    if (!r.ok) {
      httpStatus = r.status;
      await r.body?.cancel();
      throw new Error(`rpc ${r.status}`);
    }
    reply = await boundedBytes(r, isAppend ? MAX_APPEND_REPLY_BYTES : Math.min(readReplyCap, MAX_REPLY_BYTES));
    // The session moved while this call was out: never feed a later engine.
    if (!fence()) return markStale();
    observe(appendObservation(frame, reply));
    if (!fence()) return markStale();
    engine.logReply(id, reply);
  } catch {
    if (!fence()) return markStale();
    observe(httpStatus === undefined ? { outcome: "transport_error" } : { outcome: "http_error", http_status: httpStatus });
    if (!fence()) return markStale();
    engine.logFailed(id, false);
  } finally {
    if (isAppend) stale.settle(size, kept);
    // The copy is wiped unless the stale custody kept it.
    if (!kept) frame.fill(0);
    reply?.fill(0);
  }

  function markStale(): void {
    // Reads and heads are dropped (a fresh session re-reads). An append's exact
    // sent bytes and outcome are kept, under the credit reserved before sending.
    if (isAppend) kept = { id, frame, reply: reply ? reply.slice() : null };
  }
}

/** Move every queued log call (and the calls their replies queue) until quiet. */
/** Wall time per LS method (and `token`), for the LAB timing breakdown. */
export type CallTimings = Map<string, { calls: number; ms: number; firstMs?: number }>;

function note(timings: CallTimings | undefined, method: string, started: number): void {
  if (!timings) return;
  const t = timings.get(method) ?? { calls: 0, ms: 0 };
  const ms = Date.now() - started;
  t.calls += 1;
  t.ms += ms;
  t.firstMs ??= ms;
  timings.set(method, t);
}

export async function pumpLog(
  log: Fetcher,
  engine: Engine,
  token: () => Promise<string>,
  fence: LogFence,
  stale: StaleAppendStore,
  maxRounds = 64,
  timings?: CallTimings,
  observeCall?: (call: LogCallOut) => void,
  observeAppend?: (call: LogCallOut, observation: AppendObservation) => void,
): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    if (!fence()) return;
    // A bound session with nothing queued needs no token: quiet.
    let calls = engine.logBound ? engine.logCalls() : [];
    if (engine.logBound && !calls.length) return;
    let started = Date.now();
    const t = await token();
    note(timings, "token", started);
    if (!fence()) return;
    if (!engine.logBound) {
      // Bound only now: transport authenticated, generation rechecked after the await.
      if (!engine.logBind()) return;
      calls = engine.logCalls();
      if (!calls.length) return;
    }
    // In order: the engine keeps one append in flight; reads and the rest are idempotent.
    for (const c of calls) {
      // Not yet sent, and the engine it came from is being discarded (reset,
      // replaced): the call dies with it; the next engine plans from its own state.
      if (!fence()) return;
      started = Date.now();
      try { observeCall?.(c); } catch { /* Telemetry cannot affect transport. */ }
      if (!fence()) { c.frame.fill(0); return; }
      await sendCall(log, engine, t, c, fence, stale, observeAppend);
      note(timings, timings ? lsMethod(c.frame).method : "", started);
    }
  }
}
