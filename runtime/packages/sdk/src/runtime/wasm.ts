/**
 * The JS side of `runtime.wasm`'s ABI (`crates/wasm/src/lib.rs`): instantiate it,
 * open a replica, and hand out in-process ports (`replica-client-api.md` §12.1).
 *
 * Packaging (embedding as base64, the table-driven decoder, the process-wide registry
 * and the version-skew rule) lives in `packages/obsidian-runtime`. This module takes
 * the decoded bytes, so web apps that host a replica and Obsidian share it.
 */
import { CborValue, decode, encode, encodeSecret } from "../cbor.js";
import { mdbaseError } from "../errors.js";
import type { InProcessConnectOptions, InProcessRuntime } from "../transport/inprocess.js";
import type { FramePort } from "../transport/port.js";
import { uuidToBytes } from "../codec.js";

/** @internal Shared ABI shape for the optional trusted app host. */
export interface Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  rt_info(): bigint;
  rt_open(ptr: number, len: number): bigint;
  rt_open_profile?(ptr: number, len: number, tag: number): bigint;
  rt_hello(gptr: number, glen: number, ptr: number, len: number): bigint;
  rt_frame(session: bigint, ptr: number, len: number): void;
  rt_close(session: bigint): void;
  rt_tick(now: number): void;
  rt_poll(): bigint;
}

export interface RuntimeInfo {
  abiMajor: number;
  runtimeVersion: string;
  sem: { major: number; minor: number };
  serves: { major: number; minor: number }[];
}

/** Trusted host initialization policy, not a grant/session/query override. */
export type QueryExecutionProfile = "memory_constrained" | "desktop";

export interface OpenConfig {
  collection: string;
  replicaId: string;
  deviceId: string;
  mode: "local_only" | "synced";
  /** An end-to-end (private) collection. */
  e2e?: boolean;
  /** Explicit selection requires the exact bootstrap export before key allocation.
   * Omission permits legacy modules; it does not prove constrained enforcement. */
  queryExecutionProfile?: QueryExecutionProfile;
  /** Device secrets from the host's key storage, never the vault. */
  signSecretKey: Uint8Array;
  kemSecretKey: Uint8Array;
}

/** A `runtime.wasm` instance hosting one collection. */
export class WasmRuntime implements InProcessRuntime {
  private ports = new Map<bigint, FramePort & { deliver(f: CborValue): void; end(): void }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private opened = false;

  protected constructor(private instance: Exports | null) {}

  protected get x(): Exports {
    if (!this.instance) throw mdbaseError("unavailable", "runtime instance was discarded after an ABI failure");
    return this.instance;
  }

  protected discard(): void {
    // A trap may bypass Rust's input wipe. Ownership has crossed the ABI, so do
    // not guess whether the pointer is still allocated. Fail-stop and release
    // the instance instead of serving or reopening it with uncertain key state.
    this.instance = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const port of [...this.ports.values()]) port.end();
    this.ports.clear();
  }

  /** Instantiate from the module's bytes (decoded by the embedding loader). */
  static async instantiate(bytes: BufferSource): Promise<WasmRuntime> {
    return new WasmRuntime(await this.load(bytes));
  }

  /** @internal App subclass installs bounded same-Worker imports, never app RPCs. */
  protected static async load(bytes: BufferSource, extra?: (exports: () => Exports) => WebAssembly.ModuleImports): Promise<Exports> {
    let memory: WebAssembly.Memory | null = null;
    let exports: Exports | null = null;
    const extraEnv = extra?.(() => {
      if (!exports) throw mdbaseError("unavailable", "runtime imports called before initialization");
      return exports;
    }) ?? {};
    const utf8 = new TextDecoder();
    const env = {
      // The optional app host overrides this with same-Worker SQL. A legacy
      // runtime cannot activate app storage or silently fall back to MemStore.
      host_app_sql: (_ptr: number, _len: number) => 0n,
      host_now_ms: () => Date.now(),
      host_local_date: (ms: number, tzPtr: number, tzLen: number, out: number) => {
        try {
          const tz = utf8.decode(new Uint8Array(memory!.buffer, tzPtr, tzLen));
          // en-CA formats as YYYY-MM-DD.
          const d = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return 0;
          new Uint8Array(memory!.buffer, out, 10).set(new TextEncoder().encode(d));
          return 10;
        } catch {
          return 0; // unknown zone
        }
      },
      host_default_zone: (out: number, cap: number) => {
        const b = new TextEncoder().encode(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
        const n = Math.min(b.length, cap);
        new Uint8Array(memory!.buffer, out, n).set(b.subarray(0, n));
        return n;
      },
      host_random: (ptr: number, len: number) => {
        // Fill in chunks: getRandomValues takes at most 65536 bytes.
        const view = new Uint8Array(memory!.buffer, ptr, len);
        for (let o = 0; o < len; o += 65536) globalThis.crypto.getRandomValues(view.subarray(o, o + 65536));
      },
    };
    const { instance } = await WebAssembly.instantiate(bytes, { env: { ...env, ...extraEnv } });
    const x = instance.exports as unknown as Exports;
    exports = x;
    memory = x.memory;
    return x;
  }

  protected put(b: Uint8Array): [number, number] {
    if (b.length === 0) return [0, 0];
    const p = this.x.alloc(b.length);
    new Uint8Array(this.x.memory.buffer, p, b.length).set(b);
    return [p, b.length];
  }

  protected takeOut(packed: bigint): Uint8Array {
    const ptr = Number(packed >> 32n);
    const len = Number(packed & 0xffffffffn);
    if (len === 0) return new Uint8Array(0);
    const out = new Uint8Array(this.x.memory.buffer, ptr, len).slice();
    this.x.dealloc(ptr, len);
    return out;
  }

  info(): RuntimeInfo {
    const m = decode(this.takeOut(this.x.rt_info())) as Map<number, CborValue>;
    const pair = (v: CborValue) => {
      const [major, minor] = v as number[];
      return { major: major!, minor: minor! };
    };
    return {
      abiMajor: m.get(0) as number,
      runtimeVersion: m.get(1) as string,
      sem: pair(m.get(2)!),
      serves: (m.get(3) as CborValue[]).map(pair),
    };
  }

  /** Open the replica. */
  open(c: OpenConfig): void {
    const x = this.x;
    if (this.opened) throw mdbaseError("unavailable", "runtime is already open");
    const profile = c.queryExecutionProfile;
    let tag: number | undefined;
    if (profile !== undefined) {
      if (profile !== "memory_constrained" && profile !== "desktop") {
        throw mdbaseError("invalid_request", "unknown query execution profile");
      }
      if (typeof x.rt_open_profile !== "function") {
        throw mdbaseError("unavailable", "runtime does not support explicit query profile initialization");
      }
      tag = profile === "memory_constrained" ? 0 : 1;
    }
    const cfg = encodeSecret(
      new Map<number, CborValue>([
        [0, uuidToBytes(c.collection)],
        [1, uuidToBytes(c.replicaId)],
        [2, uuidToBytes(c.deviceId)],
        [3, c.mode === "local_only" ? 0 : 1],
        [4, c.signSecretKey],
        [5, c.kemSecretKey],
        [6, c.e2e ?? false],
      ]),
    );
    let err: Uint8Array;
    try {
      // rt_open consumes and wipes the linear-memory input. This JS encoding is
      // a separate secret-bearing copy: clear it on success, refusal or a trap.
      const input = this.put(cfg);
      err = this.takeOut(tag === undefined ? x.rt_open(...input) : x.rt_open_profile!(...input, tag));
    } catch (error) {
      this.discard();
      throw error;
    } finally {
      cfg.fill(0);
    }
    if (err.length) throw mdbaseError("unavailable", `runtime failed to open: ${new TextDecoder().decode(err)}`);
    this.markOpened();
  }

  /** @internal Start the shared frame/timer driver only after a successful open. */
  protected markOpened(): void {
    this.opened = true;
    this.timer ??= setInterval(() => this.tick(), 1000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Run timers now. */
  tick(): void {
    this.x.rt_tick(Date.now());
    this.flush();
  }

  /** An in-process port. The first frame sent must be `hello`. */
  connect(o: InProcessConnectOptions & { clientKey?: Uint8Array } = {}): FramePort {
    let session: bigint | null = null;
    let closed = false;
    const queue: CborValue[] = [];
    const port: FramePort & { deliver(f: CborValue): void; end(): void } = {
      onframe: null,
      onclose: null,
      send: (frame) => {
        if (closed) throw mdbaseError("unavailable", "port closed");
        const bytes = encode(frame);
        if (session === null) {
          const grant =
            o.grant && o.clientKey ? new Uint8Array([...uuidToBytes(o.grant), ...o.clientKey]) : new Uint8Array(0);
          const out = decode(this.takeOut(this.x.rt_hello(...this.put(grant), ...this.put(bytes)))) as CborValue[];
          const s = BigInt(out[0] as number | bigint);
          const resp = decode(out[1] as Uint8Array);
          queueMicrotask(() => {
            port.onframe?.(resp);
            if (s === 0n) port.end();
          });
          if (s !== 0n) {
            session = s;
            this.ports.set(s, port);
            this.flush();
          }
          return;
        }
        this.x.rt_frame(session, ...this.put(bytes));
        this.flush();
      },
      close: () => {
        if (closed) return;
        closed = true;
        if (session !== null) {
          this.ports.delete(session);
          this.x.rt_close(session);
        }
        port.onclose?.();
      },
      deliver: (f) => (port.onframe ? port.onframe(f) : queue.push(f)),
      end: () => {
        if (closed) return;
        closed = true;
        if (session !== null) this.ports.delete(session);
        port.onclose?.();
      },
    };
    return port;
  }

  /** @internal Privileged app subclass: current local session, never a caller
   * guessed ID. Closed/foreign/uninitialized ports have no authority. */
  protected sessionForPort(port: FramePort): bigint | null {
    for (const [id, current] of this.ports) if (current === port) return id;
    return null;
  }

  private flush(): void {
    const out = this.takeOut(this.x.rt_poll());
    if (!out.length) return;
    for (const item of decode(out) as CborValue[]) {
      const [s, f] = item as [number | bigint, Uint8Array | null];
      const port = this.ports.get(BigInt(s));
      if (!port) continue;
      if (f === null) port.end();
      else {
        const frame = decode(f);
        queueMicrotask(() => port.deliver(frame));
      }
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    for (const p of [...this.ports.values()]) p.close();
  }
}
