/** Shared ciphertext-only Direct transport. Attachment leases stream into their
 * pinned native slot; ordinary log reads own at most one bounded sealed object.
 * Authentication/checksums remain native, not a second JS crypto implementation.
 */
import { decode, encodeSecret, type CborValue } from "../../../packages/sdk/src/cbor.ts";
import type { ObjectOriginPolicy } from "./object-origins.ts";

export const SEALED_OBJECT_BYTES = 9 << 20;
export function objectMap(v: CborValue | undefined): Map<number, CborValue> {
  if (!(v instanceof Map)) throw new Error("invalid object metadata");
  return v as Map<number, CborValue>;
}
export function objectSize(v: CborValue | undefined): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0 || v > SEALED_OBJECT_BYTES)
    throw new Error("invalid object size");
  return v;
}
function base64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)); }

/** No owned attachment buffer: reserve/write are synchronous native lease calls.
 * The returned fence also covers capability expiry after the caller's await.
 */
export async function streamDirectObject(log: Fetcher, transfer: Map<number, CborValue>,
  count: number, checksum: Uint8Array, current: () => boolean, origins: ObjectOriginPolicy,
  reserve: () => boolean, write: (bytes: Uint8Array) => boolean,
  signal: AbortSignal = AbortSignal.timeout(15_000), directFetch: typeof fetch = fetch): Promise<() => boolean> {
  objectSize(count);
  if (checksum.length !== 32) throw new Error("invalid object checksum");
  const uri = transfer.get(0), expiry = transfer.get(2);
  if (typeof uri !== "string" || uri.length > 8192 || typeof expiry !== "number" ||
      !Number.isSafeInteger(expiry) || expiry <= Date.now()) throw new Error("invalid direct capability");
  const { viaLog } = origins.destination(uri);
  const headers = new Headers();
  const supplied = transfer.get(1);
  if (!(supplied instanceof Map)) throw new Error("invalid direct headers");
  let headerBytes = 0;
  if (supplied.size > 32) throw new Error("direct headers over budget");
  for (const [k, v] of supplied) {
    if (typeof k !== "string" || typeof v !== "string" || k.length > 128 || v.length > 4096 ||
        /^(authorization|proxy-authorization|cookie|host|range)$/i.test(k)) throw new Error("invalid direct headers");
    headerBytes += k.length + v.length;
    if (headerBytes > (16 << 10)) throw new Error("direct headers over budget");
    headers.set(k, v);
  }
  headers.set("range", `bytes=0-${count - 1}`);
  const live = () => current() && !signal.aborted && expiry > Date.now();
  if (!live() || !reserve()) throw new Error("read allocation refused");
  if (!live()) throw new Error("stale read");
  // Workers have no ambient cookie jar or RequestInit.credentials. Only the
  // validated capability headers above are forwarded, never the LS bearer.
  const init: RequestInit = { method: "GET", headers, redirect: "manual", signal };
  const response = viaLog ? await log.fetch(uri, init) : await directFetch(uri, init);
  if (!live() || response.status !== 206 || response.headers.get("content-length") !== String(count) ||
      response.headers.get("content-range") !== `bytes 0-${count - 1}/${count}` ||
      response.headers.get("x-amz-checksum-sha256") !== base64(checksum) ||
      (response.headers.has("content-encoding") && response.headers.get("content-encoding") !== "identity")) {
    await response.body?.cancel();
    throw new Error("direct range refused");
  }
  if (!response.body) throw new Error("missing object body");
  let reader: ReadableStreamBYOBReader;
  try { reader = response.body.getReader({ mode: "byob" }); }
  catch (e) { await response.body.cancel().catch(() => {}); throw e; }
  // Reuse a transferred 64KiB backing store, including the final EOF probe.
  let scratch = new Uint8Array(64 << 10);
  let received = 0;
  let complete = false;
  try {
    for (;;) {
      const part = await reader.read(scratch);
      if (part.value) {
        try {
          if (!live()) throw new Error("stale read");
          if (part.value.length > count - received) throw new Error("object over budget");
          if (part.value.length && !write(part.value)) throw new Error("stale read");
          received += part.value.length;
        } finally {
          part.value.fill(0);
          scratch = new Uint8Array(part.value.buffer);
        }
      }
      if (!live()) throw new Error("stale read");
      if (part.done) break;
    }
    if (received !== count || !live()) throw new Error("incomplete object");
    complete = true;
    return live;
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    try { scratch.fill(0); } catch { /* ownership transferred to reader */ }
    reader.releaseLock();
  }
}

function wipe(v: CborValue | undefined): void {
  if (v instanceof Uint8Array) v.fill(0);
  else if (v instanceof Map) for (const value of v.values()) wipe(value);
  else if (Array.isArray(v)) for (const value of v) wipe(value);
}
function struct(m: Map<number, CborValue>): Map<number, CborValue> {
  return new Map([...m].sort(([a], [b]) => a - b));
}

/** Opt-in for normal get_object ONLY. Raw attachment metadata never enters here.
 * Preserve the original response ID, schema, checksum and unknown fields; Rust
 * still decodes/correlates/authenticates the normalized internal reply.
 */
export async function completeObjectReply(log: Fetcher, frame: Uint8Array, reply: Uint8Array,
  id: number, current: () => boolean, origins: ObjectOriginPolicy, signal: AbortSignal):
  Promise<{ bytes: Uint8Array; live: () => boolean } | null> {
  let request: CborValue | undefined, response: CborValue | undefined;
  const owned: { bytes?: Uint8Array } = {};
  try {
    if (!current() || signal.aborted) throw new Error("stale read");
    request = decode(frame);
    const req = objectMap(request);
    if (req.get(0) !== 0 || req.get(1) !== id || req.get(2) !== "get_object") throw new Error("invalid object request");
    response = decode(reply);
    const res = objectMap(response);
    // Errors and inline replies retain their original bytes and native validation.
    if (res.get(0) !== 1 || res.get(1) !== id || res.has(2) === res.has(3)) throw new Error("invalid object response");
    if (res.has(3)) return null;
    const result = objectMap(res.get(2));
    const size = objectSize(result.get(2)), checksum = result.get(3);
    if (result.has(0) === result.has(1) || !(checksum instanceof Uint8Array) || checksum.length !== 32)
      throw new Error("invalid object transfer");
    const params = objectMap(req.get(3));
    let offset = 0, count = size;
    if (params.has(2)) {
      const range = params.get(2);
      if (!Array.isArray(range) || range.length !== 2) throw new Error("invalid object range");
      const [start, length] = range;
      if (typeof start !== "number" || typeof length !== "number" ||
          !Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 ||
          start > size || length > size - start) throw new Error("invalid object range");
      offset = start; count = length;
    }
    if (result.has(0)) {
      const bytes = result.get(0);
      if (!(bytes instanceof Uint8Array) || bytes.length !== count) throw new Error("invalid inline object");
      return null;
    }
    // Real LS ranges are inline. Do not turn a partial Direct into a reply whose
    // whole-object hash Rust cannot check (no JS crypto/fallback authority).
    if (offset !== 0 || count !== size) throw new Error("partial direct object refused");
    let received = 0;
    const live = await streamDirectObject(log, objectMap(result.get(1)), size, checksum, current, origins,
      () => { owned.bytes = new Uint8Array(size); return true; },
      bytes => { owned.bytes!.set(bytes, received); received += bytes.length; return true; }, signal);
    if (!live()) throw new Error("stale read");
    const normalized = new Map(result);
    normalized.delete(1);
    normalized.set(0, owned.bytes!.subarray(offset, offset + count));
    res.set(2, struct(normalized));
    return { bytes: encodeSecret(struct(res)), live };
  } finally { owned.bytes?.fill(0); wipe(request); wipe(response); }
}
