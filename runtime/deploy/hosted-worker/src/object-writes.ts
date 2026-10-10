/** Sealed-object transport only, not durability/admission/SQL authority.
 * Native owns the immutable ciphertext in its shared region. Each pull copies
 * only a fresh <=64KiB native view; no WASM view survives an await. Native must
 * subsequently verify HasObjects and encrypted-journal commit before progress.
 */
import { decode, type CborValue } from "../../../packages/sdk/src/cbor.ts";
import type { Engine } from "./engine.js";
import { sendCall, StaleAppendStore, type LogFence } from "./log.ts";
import type { ObjectOriginPolicy } from "./object-origins.ts";

const WINDOW = 64 << 10;
const SEALED = 9 << 20;
const FRAME = 4096;
const META = 64 << 10;
const TIMEOUT = 15_000;

/** Trusted native descriptor, not caller-supplied file/context/commit knowledge. */
export interface SealedObjectLease {
  ticket: number;
  collection: Uint8Array;
  cipherHash: Uint8Array;
  sealedBytes: number;
  putFrame: Uint8Array;
  commitFrame: Uint8Array;
  /** Must reacquire the current native region view on EVERY call. */
  window(offset: number, length: number): Uint8Array | null;
}
/** Raw bounded LS replies: native decoding/current-scope checks remain required.
 * Caller owns/wipes these metadata buffers. No file bytes are returned. */
export interface SealedObjectReplies {
  put: Uint8Array;
  commit: Uint8Array | null;
}
export type FixedStreamFactory = (length: number) => {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};
function fixedStream(length: number) {
  if (typeof FixedLengthStream !== "function") throw new Error("fixed-length upload stream unavailable");
  return new FixedLengthStream(length, { highWaterMark: WINDOW });
}
function map(v: CborValue | undefined): Map<CborValue, CborValue> {
  if (!(v instanceof Map)) throw new Error("invalid sealed-object metadata");
  return v;
}
function same(v: CborValue | undefined, expected: Uint8Array): boolean {
  return v instanceof Uint8Array && v.length === expected.length && v.every((b, i) => b === expected[i]);
}
function base64(v: Uint8Array): string { return btoa(String.fromCharCode(...v)); }
function request(frame: Uint8Array, ticket: number, method: string): Map<CborValue, CborValue> {
  if (frame.length === 0 || frame.length > FRAME) throw new Error("sealed-object frame over budget");
  const value = map(decode(frame));
  if (value.get(0) !== 0 || value.get(1) !== ticket || value.get(2) !== method)
    throw new Error("sealed-object request correlation changed");
  return map(value.get(3));
}
function response(raw: Uint8Array, ticket: number): Map<CborValue, CborValue> | null {
  const value = map(decode(raw));
  if (value.get(0) !== 1 || value.get(1) !== ticket || value.has(2) === value.has(3))
    throw new Error("sealed-object response correlation changed");
  if (value.has(3)) { map(value.get(3)); return null; } // retain authoritative refusal for native
  return map(value.get(2));
}
async function rpc(log: Fetcher, signer: Pick<Engine, "signRpc">, token: string,
  ticket: number, frame: Uint8Array, current: LogFence): Promise<Uint8Array> {
  let raw: Uint8Array | null = null;
  try {
    await sendCall(log, {
      signRpc: (...args) => {
        const signature = signer.signRpc(...args);
        if (!current()) { signature.fill(0); throw new Error("stale sealed-object signer"); }
        return signature;
      },
      logReply: (id, bytes) => { if (id === ticket) raw = bytes.slice(); },
      logFailed: () => {},
    }, token, { id: ticket, frame }, current, new StaleAppendStore(0, 0), undefined, META);
    if (!current() || !raw) throw new Error("sealed-object RPC outcome unavailable");
    return raw;
  } catch (e) { (raw as Uint8Array | null)?.fill(0); throw e; }
}
function capability(value: Map<CborValue, CborValue>, checksum: Uint8Array, origins: ObjectOriginPolicy) {
  const uri = value.get(0), expiry = value.get(2);
  if (typeof uri !== "string" || uri.length > 8192 || typeof expiry !== "number" ||
      !Number.isSafeInteger(expiry) || expiry <= Date.now()) throw new Error("invalid sealed-object capability");
  const { viaLog } = origins.destination(uri);
  const supplied = map(value.get(1));
  if (supplied.size > 32) throw new Error("sealed-object headers over budget");
  let bytes = 0;
  const headers = new Headers();
  for (const [k, v] of supplied) {
    if (typeof k !== "string" || typeof v !== "string" || k.length > 128 || v.length > 4096 ||
        /^(authorization|proxy-authorization|cookie|host|range|content-length|transfer-encoding|connection)$/i.test(k))
      throw new Error("invalid sealed-object headers");
    bytes += k.length + v.length;
    if (bytes > (16 << 10) || headers.has(k)) throw new Error("sealed-object headers over budget");
    headers.set(k, v);
  }
  if (headers.get("x-amz-checksum-sha256") !== base64(checksum))
    throw new Error("sealed-object checksum binding changed");
  return { uri, viaLog, expiry, headers };
}

/** Current MUST include native owner/session/epoch/folder/wake/admission and
 * isolate resource ownership, not just engine identity. No retries on unknown
 * outcomes; no SQL or native progress callback here. Unsupported streaming fails
 * closed without buffering a whole object or an inline/file-body fallback.
 */
export async function stageSealedObject(log: Fetcher, signer: Pick<Engine, "signRpc">,
  token: string, lease: SealedObjectLease, current: LogFence, origins: ObjectOriginPolicy,
  directFetch: typeof fetch = fetch, makeStream: FixedStreamFactory = fixedStream,
): Promise<SealedObjectReplies> {
  // Freeze all primitive metadata/frame identities before the first await.
  const ticket = lease.ticket, count = lease.sealedBytes;
  if (!current() || !Number.isSafeInteger(ticket) || ticket <= 0 ||
      !Number.isSafeInteger(count) || count <= 0 || count > SEALED ||
      lease.collection.length !== 16 || lease.cipherHash.length !== 32 ||
      lease.putFrame.length > FRAME || lease.commitFrame.length > FRAME)
    throw new Error("invalid sealed-object lease");
  const collection = lease.collection.slice(), checksum = lease.cipherHash.slice();
  const putFrame = lease.putFrame.slice(), commitFrame = lease.commitFrame.slice();
  const window = lease.window.bind(lease);
  let put: Uint8Array | null = null, commit: Uint8Array | null = null;
  let returned = false;
  try {
    const p = request(putFrame, ticket, "put_object"), c = request(commitFrame, ticket, "commit_object");
    if (p.size !== 5 || !same(p.get(0), collection) || !same(p.get(1), checksum) || p.get(2) !== 18 ||
        p.get(3) !== count || !same(p.get(4), checksum) || p.has(5) ||
        c.size !== 2 || !same(c.get(0), collection) || !same(c.get(1), checksum))
      throw new Error("sealed-object scope changed");
    if (!current()) throw new Error("stale sealed-object lease");
    put = await rpc(log, signer, token, ticket, putFrame, current);
    if (!current()) throw new Error("stale sealed-object lease");
    const result = response(put, ticket);
    if (result === null || (result.get(0) === 2 && result.size === 1)) {
      returned = true; return { put, commit: null }; // refusal or dedup; native still decides
    }
    if (result.get(0) !== 1 || result.size !== 2) throw new Error("invalid sealed-object upload result");
    const transfer = capability(map(result.get(1)), checksum, origins);
    const live = () => current() && transfer.expiry > Date.now();
    if (!live()) throw new Error("stale sealed-object capability");
    const fixed = makeStream(count);
    let offset = 0;
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(TIMEOUT)]);
    const input = new ReadableStream<Uint8Array>({
      pull(controller) {
        try {
          if (!live()) throw new Error("stale sealed-object capability");
          if (offset === count) { controller.close(); return; }
          const n = Math.min(WINDOW, count - offset);
          const view = window(offset, n);
          if (!view || view.length !== n || !live()) throw new Error("sealed-object view refused");
          // Never enqueue a WASM view: another native call may grow memory.
          const bytes = view.slice();
          if (!live()) { bytes.fill(0); throw new Error("stale sealed-object capability"); }
          controller.enqueue(bytes);
          offset += n;
        } catch (e) { controller.error(e); }
      },
    }, { highWaterMark: 0 });
    // Cancel the readable too: an early HTTP rejection may leave no consumer,
    // so aborting pipeTo alone can wait forever on an in-progress write.
    let cancellation: Promise<void> = Promise.resolve();
    const cancel = () => {
      if (!abort.signal.aborted) {
        abort.abort();
        cancellation = fixed.readable.cancel().catch(() => {}); // fetch may already own its lock
      }
    };
    signal.addEventListener("abort", cancel, { once: true });
    // Both tasks are observed; either failure aborts the other. No untracked
    // producer, retained chunk list, full-body allocation or whole-object hash.
    const pipe = input.pipeTo(fixed.writable, { signal }).catch((e) => { cancel(); throw e; });
    const upload = (async () => {
      try {
        if (!live()) throw new Error("stale sealed-object capability");
        const init: RequestInit = { method: "PUT", body: fixed.readable, headers: transfer.headers,
          redirect: "manual", signal };
        const r = transfer.viaLog
          ? await log.fetch(transfer.uri, init) : await directFetch(transfer.uri, init);
        const acceptable = live() && (r.status === 200 || r.status === 204);
        await r.body?.cancel();
        if (!acceptable || !live()) throw new Error("sealed-object PUT outcome unavailable");
      } catch (e) { cancel(); throw e; }
    })();
    const settled = await Promise.allSettled([pipe, upload]);
    signal.removeEventListener("abort", cancel);
    await cancellation;
    if (settled.some((r) => r.status === "rejected") || !live() || offset !== count)
      throw new Error("sealed-object PUT outcome unavailable");
    // Commit only after exact full upload and current native/adapter/expiry gates.
    commit = await rpc(log, signer, token, ticket, commitFrame, live);
    if (!live()) throw new Error("stale sealed-object capability");
    const stored = response(commit, ticket);
    if (stored !== null && (stored.size !== 1 || stored.get(0) !== true))
      throw new Error("sealed-object commit outcome unavailable");
    returned = true;
    return { put, commit };
  } finally {
    putFrame.fill(0); commitFrame.fill(0); collection.fill(0); checksum.fill(0);
    if (!returned) { put?.fill(0); commit?.fill(0); }
  }
}
