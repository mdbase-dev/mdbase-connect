/**
 * The hosted engine (`mdbn-hosted-worker` wasm) for one collection, inside its DO.
 * One instance per DO wake; key material passes through `open` once and is wiped.
 */
import { outputFrames } from "./output-frames.ts";
import { decodePitrAppQuery } from "./pitr-app-query.ts";
import type { ControlClient, PitrAppGrantIdentity } from "./control.ts";
import type { CatchupFacts } from "./wake-observe.ts";
import { decode, encode, type CborValue } from "../../../packages/sdk/src/cbor.js";
import { sqlHost } from "./sql.js";
import engineModule from "../hosted.wasm";

interface Exports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  alloc(n: number): number;
  dealloc(p: number, n: number): void;
  hd_open(p: number, n: number): bigint;
  hd_snapshot_declined(): number;
  hd_serving(): number;
  hd_initialize_collection(p: number, n: number, start: number): number;
  hd_needs_reset(): number;
  hd_requires_reopen(): number;
  hd_pin_state(): number;
  hd_hello(gp: number, gn: number, p: number, n: number): bigint;
  hd_frame(session: number, p: number, n: number): void;
  hd_close(session: number): void;
  hd_tick(now: number, afterOpen: number): void;
  hd_next_wakeup(omitStallProbe: number): number;
  hd_install_status(): bigint;
  hd_catchup_facts(): bigint;
  hd_applied_head(): bigint;
  hd_poll(): bigint;
  hd_log_calls(): bigint;
  hd_log_reply(call: number, p: number, n: number): void;
  hd_log_failed(call: number, offline: number): void;
  hd_log_push(p: number, n: number): void;
  hd_log_event(kind: number): void;
  hd_log_bind(): number;
  hd_log_retire(): void;
  hd_log_request_head(): number;
  hd_attachment_object(): bigint;
  hd_attachment_allowed(ticket: number): number;
  hd_attachment_reserve(ticket: number, size: number): number;
  hd_attachment_write(ticket: number, p: number, n: number): number;
  hd_attachment_region(ticket: number, size: number): number;
  hd_attachment_written(ticket: number, size: number): number;
  hd_attachment_call_requires_slot(session: number, p: number, n: number): number;
  hd_attachment_call_busy(session: number, p: number, n: number): void;
  hd_attachment_active(session: number): number;
  hd_attachment_complete(ticket: number, p: number, n: number): number;
  hd_attachment_failed(ticket: number): void;
  hd_noise_key(p: number, n: number): number;
  hd_noise_matches(p: number, n: number): number;
  hd_noise_start(p: number, n: number): number;
  hd_noise_read1(h: number, p: number, n: number): bigint;
  hd_pitr_app_query(h: number, p: number, n: number): bigint;
  hd_noise_write2(h: number, ep: number, en: number, p: number, n: number): bigint;
  hd_noise_seal(h: number, p: number, n: number): bigint;
  hd_noise_open(h: number, p: number, n: number): bigint;
  hd_noise_drop(h: number): void;
  hd_admission(): bigint;
  hd_mode_service_ready(): bigint;
  hd_wake_instance(): bigint;
  hd_grant_ok(p: number, n: number): number;
  hd_log_http_sign(
    mp: number, mn: number, kp: number, kn: number, tp: number, tn: number,
    bp: number, bn: number, np: number, nn: number,
  ): bigint;
}

/** A log call: its ID, the canonical LS request frame, and an optional sealed sidecar. */
export interface LogCallOut {
  id: number;
  frame: Uint8Array;
  sidecar?: Uint8Array;
}

export type EngineOut = { session: number; frame: Uint8Array | null };

/** Host-only pinned object lease; not an app RPC or an admission permit. */
export interface AttachmentReadOut {
  ticket: number;
  session: number;
  expectedBytes: number | null;
  frame: Uint8Array;
}

export class Engine {
  private ex!: Exports;
  #opened = false;
  /** LAB only: the salted collection tag for this engine's repair lines. */
  labTag: string | null = null;

  constructor(storage: DurableObjectStorage) {
    const host = sqlHost(storage, () => this.ex);
    const instance = new WebAssembly.Instance(engineModule, {
      env: {
        host_sql: host,
        host_repair_boundary: (startReason: number, seq: bigint, visited: bigint, written: bigint) => {
          try {
            // `labTag` is set by the host only in LAB; production lines are unchanged.
            console.info(JSON.stringify({ event: startReason ? "hosted_record_meta_repair_start" : "hosted_record_meta_repair_finish",
              ...(this.labTag ? { collection_tag: this.labTag } : {}),
              reason: [undefined, "first_open", "catalog_stamp_changed", "cursor_invalid", "derived_version_changed"][startReason],
              applied_seq: seq.toString(), records_visited: Number(visited), record_rows_written: Number(written) }));
          } catch { /* Diagnostics cannot interrupt a committed slice. */ }
        },
        host_now_ms: () => Date.now(),
        host_random: (p: number, n: number) => {
          for (let off = 0; off < n; off += 65536) {
            crypto.getRandomValues(new Uint8Array(this.ex.memory.buffer, p + off, Math.min(65536, n - off)));
          }
        },
        host_local_date: (ms: number, tp: number, tn: number, out: number) => {
          const tz = new TextDecoder().decode(new Uint8Array(this.ex.memory.buffer, tp, tn));
          try {
            const d = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return 0;
            new Uint8Array(this.ex.memory.buffer, out, 10).set(new TextEncoder().encode(d));
            return 10;
          } catch {
            return 0;
          }
        },
        host_default_zone: (out: number, cap: number) => {
          const z = new TextEncoder().encode("UTC");
          new Uint8Array(this.ex.memory.buffer, out, Math.min(cap, z.length)).set(z.subarray(0, cap));
          return Math.min(cap, z.length);
        },
      },
    });
    this.ex = instance.exports as Exports;
  }

  private put(bytes: Uint8Array): [number, number] {
    if (bytes.length === 0) return [0, 0];
    const p = this.ex.alloc(bytes.length);
    new Uint8Array(this.ex.memory.buffer, p, bytes.length).set(bytes);
    return [p, bytes.length];
  }

  private take(out: bigint): Uint8Array {
    const p = Number(out >> 32n);
    const n = Number(out & 0xffffffffn);
    if (n === 0) return new Uint8Array(0);
    const view = new Uint8Array(this.ex.memory.buffer, p, n);
    const copy = view.slice();
    // Wipe the engine's output before freeing it (dealloc wipes too).
    view.fill(0);
    this.ex.dealloc(p, n);
    return copy;
  }

  /** Take and decode an output, then wipe the encoded copy (decoded bytes are copies). */
  private takeDecoded(out: bigint): CborValue {
    const bytes = this.take(out);
    try {
      return decode(bytes);
    } finally {
      bytes.fill(0);
    }
  }

  /** Open from the CBOR config; the caller's copy is wiped here too. */
  open(config: Uint8Array): void {
    let out: Uint8Array;
    try {
      if (this.#opened) throw new Error("hosted engine already opened");
      this.#opened = true;
      out = this.take(this.ex.hd_open(...this.put(config)));
    } finally {
      config.fill(0);
    }
    if (out.length) throw new Error(`hosted engine open: ${new TextDecoder().decode(out)}`);
  }

  /** Capture the next immutable object, only on the bound log/read session. */
  attachmentObject(): AttachmentReadOut | null {
    const v = this.takeDecoded(this.ex.hd_attachment_object());
    if (v === null) return null;
    if (!Array.isArray(v) || v.length !== 5 ||
        typeof v[0] !== "number" || !Number.isSafeInteger(v[0]) || v[0] <= 0 ||
        typeof v[1] !== "number" || !Number.isSafeInteger(v[1]) || v[1] <= 0 ||
        !(v[2] instanceof Uint8Array) || v[2].length !== 32 ||
        (v[3] !== null && (typeof v[3] !== "number" || !Number.isSafeInteger(v[3]) || v[3] < 0)) ||
        !(v[4] instanceof Uint8Array)) throw new Error("invalid attachment lease");
    return { ticket: v[0], session: v[1], expectedBytes: v[3] as number | null, frame: v[4] };
  }
  attachmentCallRequiresSlot(session: number, frame: Uint8Array): boolean { return this.ex.hd_attachment_call_requires_slot(session, ...this.put(frame)) === 1; }
  attachmentCallBusy(session: number, frame: Uint8Array): void { this.ex.hd_attachment_call_busy(session, ...this.put(frame)); }
  attachmentActive(session: number): boolean { return this.ex.hd_attachment_active(session) === 1; }
  attachmentAllowed(ticket: number): boolean { return this.ex.hd_attachment_allowed(ticket) === 1; }
  attachmentReserve(ticket: number, size: number): boolean { return this.ex.hd_attachment_reserve(ticket, size) === 1; }
  /** Each call copies only one bounded segment; no memory view survives an await. */
  attachmentWrite(ticket: number, bytes: Uint8Array): boolean {
    if (bytes.length > (1 << 20)) return false;
    const pointer = this.ex.hd_attachment_region(ticket, bytes.length) >>> 0;
    if (!pointer) return false;
    // Exactly one copy from the reader's piece into the already allocated region.
    // This fresh view is consumed synchronously, never stored or awaited upon.
    new Uint8Array(this.ex.memory.buffer, pointer, bytes.length).set(bytes);
    return this.ex.hd_attachment_written(ticket, bytes.length) === 1;
  }
  attachmentComplete(ticket: number, checksum: Uint8Array): boolean {
    return checksum.length === 32 && this.ex.hd_attachment_complete(ticket, ...this.put(checksum)) === 1;
  }
  attachmentFailed(ticket: number): void { this.ex.hd_attachment_failed(ticket); }

  serving(): boolean {
    return this.ex.hd_serving() === 1;
  }

  cacheRecovery(): "reset" | "reopen" | null {
    if (this.ex.hd_needs_reset() === 1) return "reset";
    return this.ex.hd_requires_reopen() === 1 ? "reopen" : null;
  }

  /** The native open-time pin check on the state applied so far. */
  pinState(): "inconsistent" | "rebuilding" | "rebuilt" | null {
    const state = this.ex.hd_pin_state();
    return state === 1 ? "inconsistent" : state === 2 ? "rebuilding" : state === 3 ? "rebuilt" : null;
  }

  hello(grant: Uint8Array | null, frame: Uint8Array): { session: number; response: Uint8Array } {
    const [gp, gn] = this.put(grant ?? new Uint8Array(0));
    const out = this.takeDecoded(this.ex.hd_hello(gp, gn, ...this.put(frame))) as CborValue[];
    return { session: Number(out[0]), response: out[1] as Uint8Array };
  }

  frame(session: number, frame: Uint8Array): void {
    this.ex.hd_frame(session, ...this.put(frame));
  }

  close(session: number): void {
    this.ex.hd_close(session);
  }

  tick(now: number, afterOpen = false): void {
    this.ex.hd_tick(now, Number(afterOpen));
  }

  /** Opaque native applied progress, for idle scheduling only. Never persisted,
   * logged, installed back, or used for serving/currentness/effect permission. */
  appliedHead(): string {
    const bytes = this.take(this.ex.hd_applied_head());
    if (bytes.length < 36 || bytes.length > 44) throw new Error("invalid applied head");
    return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  }

  /** Snapshot install progress in chunks, or null with none running. Counts only,
   * safe to log. */
  installStatus(): { done: number; total: number } | null {
    const status = this.takeDecoded(this.ex.hd_install_status());
    if (!Array.isArray(status)) return null;
    return { done: Number(status[0]), total: Number(status[1]) };
  }

  /** LAB diagnostics only (connect#1850): numbers and flags, never an authority. */
  catchupFacts(): CatchupFacts | null {
    const facts = this.takeDecoded(this.ex.hd_catchup_facts());
    if (!Array.isArray(facts) || facts.length !== 5) return null;
    return {
      applied: Number(facts[0]), headKnown: Number(facts[1]), caughtUp: facts[2] === true,
      grantWaiting: facts[3] === true, grantDue: facts[4] === true,
    };
  }

  snapshotDeclined(): boolean {
    return this.ex.hd_snapshot_declined() === 1;
  }

  nextWakeup(omitStallProbe = false): number | null {
    const t = this.ex.hd_next_wakeup(Number(omitStallProbe));
    return t < 0 ? null : t;
  }

  poll(): EngineOut[] {
    return outputFrames(this.take(this.ex.hd_poll()));
  }

  logCalls(): LogCallOut[] {
    const items = this.takeDecoded(this.ex.hd_log_calls()) as CborValue[][];
    return items.map(([id, rec]) => {
      const m = rec as Map<number, CborValue>;
      const sidecar = m.get(2) as Uint8Array | undefined;
      return { id: Number(id), frame: m.get(1) as Uint8Array, ...(sidecar ? { sidecar } : {}) };
    });
  }

  logReply(id: number, bytes: Uint8Array): void {
    this.ex.hd_log_reply(id, ...this.put(bytes));
  }

  logFailed(id: number, offline: boolean): void {
    this.ex.hd_log_failed(id, offline ? 1 : 0);
  }

  /** Whether a log session is bound (replica-repair). */
  logBound = false;

  /** Bind the authenticated log session: only after the transport authenticated
   * (token in hand) and the caller's generation was rechecked after that await.
   * Re-subscribes; an earlier session's outstanding calls become unknown. */
  logBind(): boolean {
    this.logBound = this.ex.hd_log_bind() === 1;
    return this.logBound;
  }

  /** Retire the session: replies to its calls are refused before decoding. */
  logRetire(): void {
    this.logBound = false;
    this.ex.hd_log_retire();
  }

  /** Re-run the subscription (a `head` RPC) to learn of new log entries: the
   * next pump re-binds the session once its token is in hand. */
  refresh(): void {
    this.logRetire();
  }

  /** Queue a head fetch on the current log session (no retire): learns entries
   * other writers appended, such as the control plane's migration cutover. */
  requestHead(): boolean {
    return this.ex.hd_log_request_head() === 1;
  }

  initializeCollection(requestId: string, timezone: string, start: boolean): number {
    const id = Uint8Array.from(requestId.replaceAll("-", "").match(/../g)!, pair => Number.parseInt(pair, 16));
    return this.ex.hd_initialize_collection(...this.put(encode([id, timezone])), Number(start));
  }

  // ---------------------------------------------------- app sessions (Noise)

  /** Install this wake's Noise static secret (the caller's copy is wiped). */
  noiseKey(secret: Uint8Array): boolean {
    try {
      return this.ex.hd_noise_key(...this.put(secret)) === 1;
    } finally {
      secret.fill(0);
    }
  }

  noiseMatches(publicKey: Uint8Array): boolean {
    return this.ex.hd_noise_matches(...this.put(publicKey)) === 1;
  }

  /** A responder handshake bound to `prologue`, or 0. */
  noiseStart(prologue: Uint8Array): number {
    return this.ex.hd_noise_start(...this.put(prologue));
  }

  private items(out: bigint): CborValue[] {
    return this.takeDecoded(out) as CborValue[];
  }

  noiseRead1(h: number, m1: Uint8Array): { payload: Uint8Array; peer: Uint8Array } | null {
    const r = this.items(this.ex.hd_noise_read1(h, ...this.put(m1)));
    return r.length === 2 ? { payload: r[0] as Uint8Array, peer: r[1] as Uint8Array } : null;
  }

  /** Host-only public CP-query metadata from this instance's REAL Noise handle
   * and native Engine original/context checks. Input is trusted eleven-field
   * declaration CBOR, NOT authenticated admission; no decoded peer substitute.
   * Output data is historical/ALREADY KEYED, not a before-key/current CP/phase
   * permit. No app-serving/profile hook invokes this method.
   */
  pitrAppQuery(h: number, declarations: Uint8Array): Readonly<PitrAppGrantIdentity> | null {
    if (!Number.isInteger(h) || h < 1 || h > 0xffffffff || !(declarations instanceof Uint8Array)
        || declarations.length === 0 || declarations.length > 512) return null;
    try {
      return decodePitrAppQuery(this.takeDecoded(this.ex.hd_pitr_app_query(h, ...this.put(declarations))));
    } catch { return null; }
  }

  /** Uncached app CP point with fresh native re-observation after its await.
   * Void/READ-ONLY: not a returned lease or effect hook. External phase, trusted
   * original admission and BEFORE-key authority still belong to independent gates.
   * A changed wake/head/generation/declaration/Noise context closes this point.
   */
  async assertPitrAppCurrent(h: number, declarations: Uint8Array, control: ControlClient,
    signal: AbortSignal): Promise<void> {
    const refused = () => { throw new Error("pitr_app_current_not_established"); };
    if (!(declarations instanceof Uint8Array) || !declarations.length || declarations.length > 512 || signal.aborted) return refused();
    const snapshot = declarations.slice();
    const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => b[i] === v);
    const original = this.pitrAppQuery(h, snapshot);
    if (!original) return refused();
    const native = encode(this.admission());
    const wake = this.wakeInstance();
    if (!wake || signal.aborted) return refused();
    try { await control.assertPitrCurrentAppGrant(original, signal); } catch { return refused(); }
    if (signal.aborted || !same(snapshot, declarations) || this.wakeInstance() !== wake) return refused();
    const current = this.pitrAppQuery(h, snapshot);
    if (!current || !same(native, encode(this.admission()))
        || !Object.entries(original).every(([k, v]) => Reflect.get(current, k) === v)) return refused();
  }

  /** Message 2 with a fresh CSPRNG ephemeral (generated and wiped here). */
  noiseWrite2(h: number, payload: Uint8Array): Uint8Array | null {
    const e = crypto.getRandomValues(new Uint8Array(32));
    let ep: number, en: number;
    try {
      [ep, en] = this.put(e);
    } finally {
      e.fill(0);
    }
    const r = this.items(this.ex.hd_noise_write2(h, ep, en, ...this.put(payload)));
    return r.length === 1 ? (r[0] as Uint8Array) : null;
  }

  noiseSeal(h: number, plaintext: Uint8Array): Uint8Array | null {
    const r = this.items(this.ex.hd_noise_seal(h, ...this.put(plaintext)));
    return r.length === 1 ? (r[0] as Uint8Array) : null;
  }

  noiseOpen(h: number, message: Uint8Array): Uint8Array | null {
    const r = this.items(this.ex.hd_noise_open(h, ...this.put(message)));
    return r.length === 1 ? (r[0] as Uint8Array) : null;
  }

  noiseDrop(h: number): void {
    this.ex.hd_noise_drop(h);
  }

  /** The live verified hosted admission, encoded (`admission_wire.rs`). */
  modeServiceReady(): CborValue { return this.takeDecoded(this.ex.hd_mode_service_ready()); }
  admission(): CborValue {
    return this.takeDecoded(this.ex.hd_admission());
  }

  wakeInstance(): bigint {
    const b = this.take(this.ex.hd_wake_instance());
    return b.length === 8 ? new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0) : 0n;
  }

  grantOk(grant: Uint8Array, clientPk: Uint8Array): boolean {
    const g = new Uint8Array(48);
    g.set(grant, 0);
    g.set(clientPk, 16);
    return this.ex.hd_grant_ok(...this.put(g)) === 1;
  }

  /** The `ls-http` possession signature for one RPC (the key stays in wasm). */
  signRpc(method: string, key0: Uint8Array | null, token: string, body: Uint8Array, nonce: Uint8Array): Uint8Array {
    const enc = new TextEncoder();
    const t = enc.encode(token);
    const sig = this.take(
      this.ex.hd_log_http_sign(
        ...this.put(enc.encode(method)),
        ...this.put(key0 ?? new Uint8Array(0)),
        ...this.put(t),
        ...this.put(body),
        ...this.put(nonce),
      ),
    );
    t.fill(0);
    if (sig.length !== 64) throw new Error("log rpc signing refused");
    return sig;
  }
}

export { encode, decode };
