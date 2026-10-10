/** Host-only pinned attachment transport. Whole authenticated objects, never
 * file-sized buffers: stream ciphertext segments into the engine's scoped slot.
 * A plaintext range still fetches each complete intersecting encrypted chunk.
 */
import { decode, type CborValue } from "../../../packages/sdk/src/cbor.ts";
import type { Engine, AttachmentReadOut } from "./engine.js";
import { sendCall, StaleAppendStore, type LogFence } from "./log.ts";
import type { ObjectOriginPolicy } from "./object-origins.ts";

const INLINE = 1 << 20;
const SEALED = 9 << 20;
const META = INLINE + (32 << 10);
const TIMEOUT = 15_000;
function map(v: CborValue | undefined): Map<CborValue, CborValue> {
  if (!(v instanceof Map)) throw new Error("invalid object metadata");
  return v;
}
function size(v: CborValue | undefined): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0 || v > SEALED)
    throw new Error("invalid object size");
  return v;
}
function base64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)); }

/** Reuse the authenticated LS nonce/possession-proof path, with a much smaller
 * reply budget and no append credits. Replies are correlated to this exact lease.
 */
async function metadata(log: Fetcher, engine: Engine, token: string,
  lease: AttachmentReadOut, current: LogFence): Promise<Map<CborValue, CborValue>> {
  let raw: Uint8Array | null = null;
  try {
    await sendCall(log, {
      signRpc: (...args) => engine.signRpc(...args),
      logReply: (id, bytes) => { if (id === lease.ticket) raw = bytes.slice(); },
      logFailed: () => {},
    }, token, { id: lease.ticket, frame: lease.frame }, current, new StaleAppendStore(0, 0), undefined, META);
    if (!current() || !raw) throw new Error("object metadata unavailable");
    const response = map(decode(raw));
    if (response.get(0) !== 1 || response.get(1) !== lease.ticket ||
        !response.has(2) || response.has(3)) throw new Error("invalid object response");
    return map(response.get(2));
  } finally { (raw as Uint8Array | null)?.fill(0); }
}

/** Exactly one read lease. Outer fence MUST include the live app admission gate,
 * not just engine identity; the engine additionally rechecks READ/folder/wake.
 * No URI, credential, response body or collection identifier is logged here.
 */
export async function fetchAttachment(log: Fetcher, engine: Engine, token: string,
  lease: AttachmentReadOut, fence: LogFence, origins: ObjectOriginPolicy, directFetch: typeof fetch = fetch): Promise<void> {
  const current = () => fence() && engine.attachmentAllowed(lease.ticket);
  let inline: Uint8Array | undefined;
  try {
    if (!current()) throw new Error("stale read");
    const result = await metadata(log, engine, token, lease, current);
    if (!current()) throw new Error("stale read");
    const count = size(result.get(2));
    const checksum = result.get(3);
    if (!(checksum instanceof Uint8Array) || checksum.length !== 32 ||
        (lease.expectedBytes !== null && count !== lease.expectedBytes) ||
        result.has(0) === result.has(1)) throw new Error("invalid object transfer");
    if (result.has(0)) {
      const bytes = result.get(0);
      if (!(bytes instanceof Uint8Array) || bytes.length !== count || count > INLINE)
        throw new Error("invalid inline object");
      inline = bytes;
      if (!current() || !engine.attachmentReserve(lease.ticket, count)) throw new Error("read allocation refused");
      if (!current() || !engine.attachmentWrite(lease.ticket, bytes)) throw new Error("stale read");
    } else {
      const transfer = map(result.get(1));
      const uri = transfer.get(0);
      const expiry = transfer.get(2);
      if (typeof uri !== "string" || uri.length > 8192 || typeof expiry !== "number" ||
          !Number.isSafeInteger(expiry) || expiry <= Date.now()) throw new Error("invalid direct capability");
      const { viaLog } = origins.destination(uri);
      const headers = new Headers();
      const supplied = map(transfer.get(1));
      let headerBytes = 0;
      if (supplied.size > 32) throw new Error("direct headers over budget");
      for (const [k, v] of supplied) {
        if (typeof k !== "string" || typeof v !== "string" || k.length > 128 || v.length > 4096 ||
            /^(authorization|proxy-authorization|cookie|host|range)$/i.test(k)) throw new Error("invalid direct headers");
        headerBytes += k.length + v.length;
        if (headerBytes > (16 << 10)) throw new Error("direct headers over budget");
        headers.set(k, v);
      }
      // Closed, exact ciphertext range; never accept a silent whole-body fallback.
      headers.set("range", `bytes=0-${count - 1}`);
      const live = () => current() && expiry > Date.now();
      if (!live() || !engine.attachmentReserve(lease.ticket, count)) throw new Error("read allocation refused");
      if (!live()) throw new Error("stale read");
      const init: RequestInit = { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT) };
      const response = viaLog ? await log.fetch(uri, init) : await directFetch(uri, init);
      if (!live() || response.status !== 206 || response.headers.get("content-length") !== String(count) ||
          response.headers.get("content-range") !== `bytes 0-${count - 1}/${count}` ||
          response.headers.get("x-amz-checksum-sha256") !== base64(checksum)) {
        await response.body?.cancel();
        throw new Error("direct range refused");
      }
      if (!response.body) throw new Error("missing object body");
      // A transferable 64KiB BYOB piece is reused, not one fresh external
      // ArrayBuffer per network pull. Unsupported byte streams fail closed.
      const reader = response.body.getReader({ mode: "byob" });
      let scratch = new Uint8Array(64 << 10);
      let received = 0;
      let complete = false;
      try {
        for (;;) {
          const part = await reader.read(scratch);
          if (!live()) { part.value?.fill(0); throw new Error("stale read"); }
          if (part.value) {
            try {
              if (received + part.value.length > count) throw new Error("object over budget");
              if (part.value.length && !engine.attachmentWrite(lease.ticket, part.value))
                throw new Error("stale read");
              received += part.value.length;
            } finally {
              part.value.fill(0);
              scratch = new Uint8Array(part.value.buffer);
            }
          }
          if (part.done) break;
        }
        if (received !== count || !live()) throw new Error("incomplete object");
        complete = true;
      } finally {
        if (!complete) await reader.cancel().catch(() => {});
        try { scratch.fill(0); } catch { /* ownership was transferred to reader */ }
        reader.releaseLock();
      }
    }
    // Rust checks the full encoded checksum AND manifest/chunk authentication;
    // no plaintext release until both succeed and the current gate still holds.
    if (!current() || !engine.attachmentComplete(lease.ticket, checksum)) throw new Error("object authentication failed");
  } catch {
    engine.attachmentFailed(lease.ticket); // exact old ticket cannot cancel a newer stream
  } finally {
    inline?.fill(0);
    lease.frame.fill(0);
  }
}
