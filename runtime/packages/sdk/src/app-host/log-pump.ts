/** First-party Worker log-drive plumbing, not a network authenticator or signer.
 * Only Core-generated sealed frames cross this boundary. The immutable transport
 * binding owns authentication and direct transfers; Rust validates all replies.
 * Discarded generations never feed a successor or infer an append outcome. */
import { sha256 } from "@noble/hashes/sha2.js";
import { decode, type CborValue } from "../cbor.js";
import { uuidToBytes } from "../codec.js";

const MAX_FRAME = 16 * 1024 * 1024;
const MAX_OBJECT = 9 * 1024 * 1024;
const MAX_CALLS = 64;
const MAX_BATCH_BYTES = 64 * 1024 * 1024;
const METHODS = new Set([
  "append", "read", "head", "subscribe", "unsubscribe", "put_object", "get_object", "has_objects",
  "put_snapshot", "get_snapshot", "endorse_snapshot", "stream_join", "stream_leave", "stream_send",
]);
export interface AppLogCall {
  /** From log_codec::host_call; the call ID stays inside the canonical frame. */
  endpoint: number | bigint;
  frame: Uint8Array;
  sidecar?: Uint8Array;
}
export interface AppLogRuntime {
  /** Drain canonical records produced by Rust log_codec, not app-authored requests. */
  takeLogCalls(): readonly AppLogCall[];
  /** Rust checks ID, original method, schema/checksum/scope before applying anything.
   * False means invalid, never acknowledgement; it cannot consume another call. */
  acceptLogReply(id: bigint, bytes: Uint8Array): boolean;
  /** No response is NOT a rejection or proof that the append did not happen. */
  logNoResponse(id: bigint): void;
  /** Retire this runtime's log generation before closing its transport. */
  retireLog(): void;
}
export interface AppLogTransport {
  /** Fixed authenticated binding; never dynamically repointed across scopes. */
  readonly endpoint: number | bigint;
  readonly collection: string;
  /** Host-authenticated account/installation/device generation is still current. */
  isCurrent(): boolean;
  /** Sends the EXACT sealed frame. For direct objects, verify ranges/checksums and
   * finish PUT+commit/GET before returning a normalized inline result to Rust.
   * Returns owned mutable bytes (never a borrowed WASM view). Bodies must be
   * bounded while streaming, before allocating a full response.
   * No generic device signer, token, URL or collection keys reach this driver. */
  send(call: AppLogCall, options: { signal: AbortSignal }): Promise<Uint8Array>;
}
export class AppLogHostError extends Error {
  constructor(readonly reason: "invalid_binding" | "invalid_call" | "fenced") {
    super(`app log host: ${reason}`);
    this.name = "AppLogHostError";
  }
}
function uint(v: unknown): bigint {
  if ((typeof v !== "number" || !Number.isSafeInteger(v)) && typeof v !== "bigint") throw new AppLogHostError("invalid_call");
  const n = BigInt(v as number | bigint);
  if (n < 0n || n > (1n << 64n) - 1n) throw new AppLogHostError("invalid_call");
  return n;
}
function equal(a: Uint8Array, b: Uint8Array): boolean { return a.length === b.length && a.every((x, i) => x === b[i]); }
interface Captured { id: bigint; call: AppLogCall }

/** One pump is permanently bound to one runtime/transport generation. The caller
 * supplies actual authenticated initialization; this helper does not manufacture
 * it or create sessions. Worker's owner stop must await close(), or terminate the
 * Worker if transport shutdown hangs, BEFORE releasing its writer lease. */
export class AppLogPump {
  private readonly abort = new AbortController();
  private readonly endpoint: bigint;
  private readonly collection: Uint8Array;
  private readonly rounds: number;
  private work: Promise<{ quiet: boolean }> | null = null;
  private closed = false;
  private failed = false;
  private retired = false;
  constructor(
    private readonly runtime: AppLogRuntime,
    private readonly transport: AppLogTransport,
    binding: { endpoint: number | bigint; collection: string; maxRounds?: number },
  ) {
    try {
      this.endpoint = uint(binding.endpoint);
      this.collection = uuidToBytes(binding.collection);
      if (uint(transport.endpoint) !== this.endpoint || !equal(uuidToBytes(transport.collection), this.collection)) throw new Error();
    } catch { throw new AppLogHostError("invalid_binding"); }
    this.rounds = binding.maxRounds ?? 64;
    if (!Number.isSafeInteger(this.rounds) || this.rounds < 1 || this.rounds > 64) throw new RangeError("invalid app log pump rounds");
  }
  get fenced(): boolean { return this.failed; }
  private current(): boolean {
    if (this.closed || this.failed) return false;
    if (uint(this.transport.endpoint) !== this.endpoint || !equal(uuidToBytes(this.transport.collection), this.collection)) {
      throw new AppLogHostError("invalid_binding");
    }
    if (this.transport.isCurrent() === true) return true;
    this.retire();
    return false;
  }
  private retire(): void {
    this.closed = true;
    this.abort.abort();
    if (this.retired) return;
    this.retired = true;
    try { this.runtime.retireLog(); } catch { this.failed = true; throw new AppLogHostError("fenced"); }
  }
  private capture(calls: readonly AppLogCall[]): Captured[] {
    if (!Array.isArray(calls) || calls.length > MAX_CALLS) throw new AppLogHostError("invalid_call");
    let bytes = 0;
    const ids = new Set<bigint>();
    const captured: Captured[] = [];
    try {
      for (const call of calls) {
        if (uint(call.endpoint) !== this.endpoint || !(call.frame instanceof Uint8Array) || call.frame.length > MAX_FRAME
          || (call.sidecar !== undefined && (!(call.sidecar instanceof Uint8Array) || call.sidecar.length > MAX_OBJECT))) throw new AppLogHostError("invalid_call");
        bytes += call.frame.length + (call.sidecar?.length ?? 0);
        if (bytes > MAX_BATCH_BYTES) throw new AppLogHostError("invalid_call");
        // Trusted Rust-produced request, not a remotely supplied reply tree.
        const decoded = decode(call.frame);
        if (!(decoded instanceof Map)) throw new AppLogHostError("invalid_call");
        const frame = decoded as Map<number, CborValue>;
        if (frame.size !== 4 || frame.get(0) !== 0 || !METHODS.has(frame.get(2) as string)) throw new AppLogHostError("invalid_call");
        const id = uint(frame.get(1));
        if (ids.has(id)) throw new AppLogHostError("invalid_call");
        ids.add(id);
        const params = frame.get(3);
        const scope = params instanceof Map ? (params as Map<number, CborValue>).get(0) : undefined;
        if (!(scope instanceof Uint8Array) || !equal(scope, this.collection)
          || (call.sidecar !== undefined && frame.get(2) !== "put_object")) throw new AppLogHostError("invalid_call");
        if (call.sidecar !== undefined) {
          const fields = params as Map<number, unknown>;
          const checksum = fields.get(4);
          if (call.sidecar.length <= 1024 * 1024 || uint(fields.get(3)) !== BigInt(call.sidecar.length) || fields.has(5)
            || !(checksum instanceof Uint8Array) || !equal(checksum, sha256(call.sidecar))) throw new AppLogHostError("invalid_call");
        }
        // Capture all calls before the first await; later queue mutation cannot
        // alter the bytes, sidecar, endpoint or correlation this turn sends.
        captured.push({ id, call: { endpoint: this.endpoint, frame: call.frame.slice(), ...(call.sidecar ? { sidecar: call.sidecar.slice() } : {}) } });
      }
      return captured;
    } catch {
      for (const c of captured) this.wipe(c);
      throw new AppLogHostError("invalid_call");
    }
  }
  private wipe(c: Captured): void { c.call.frame.fill(0); c.call.sidecar?.fill(0); }

  /** Coalesces concurrent kicks. Bounded turns return quiet:false when the caller
   * should schedule another turn; no background timer or autonomous retry loop. */
  pump(): Promise<{ quiet: boolean }> {
    if (this.work) return this.work;
    if (this.failed) return Promise.reject(new AppLogHostError("fenced"));
    if (this.closed) return Promise.resolve({ quiet: true });
    this.work = Promise.resolve().then(() => this.drive()).finally(() => { this.work = null; });
    return this.work;
  }
  private async drive(): Promise<{ quiet: boolean }> {
    try {
      for (let round = 0; round < this.rounds; round++) {
        if (!this.current()) return { quiet: true };
        const calls = this.capture(this.runtime.takeLogCalls());
        if (!calls.length) return { quiet: true };
        try {
          for (const c of calls) {
            if (!this.current()) return { quiet: true };
            let reply: Uint8Array;
            try { reply = await this.transport.send(c.call, { signal: this.abort.signal }); }
            catch {
              if (!this.current()) return { quiet: true };
              this.runtime.logNoResponse(c.id);
              continue;
            }
            try {
              if (!this.current()) return { quiet: true };
              if (!(reply instanceof Uint8Array) || reply.length > MAX_FRAME) {
                this.runtime.logNoResponse(c.id);
                continue;
              }
              // No JS decode/materialization of the remote result; Rust remains
              // the policy/schema/correlation authority. It borrows these bytes.
              if (this.runtime.acceptLogReply(c.id, reply) !== true) this.runtime.logNoResponse(c.id);
            } finally { if (reply instanceof Uint8Array) reply.fill(0); }
          }
        } finally { for (const c of calls) this.wipe(c); }
      }
      return { quiet: false };
    } catch {
      this.failed = true;
      this.retire();
      throw new AppLogHostError("fenced");
    }
  }
  /** HOST ONLY: fence/abort this pump and drain BEFORE the authenticated host
   * replaces the native session. Native replacement MUST classify originals as
   * unknown; on failure host MUST retire runtime. Same owners/lease stay held.
   * This is not close/lease release/Saved. May hang; terminate Worker first. */
  async drainForAuthenticatedReconnect():Promise<void> {
    if(this.closed||this.failed||this.retired)throw new AppLogHostError("fenced");
    this.closed=true;this.abort.abort();this.retired=true;
    await this.work?.catch(()=>{});
    if(this.failed)throw new AppLogHostError("fenced");
  }
  /** Retire immediately, abort I/O, then drain without feeding late replies. */
  async close(): Promise<void> {
    this.retire();
    await this.work?.catch(() => {});
  }
}
