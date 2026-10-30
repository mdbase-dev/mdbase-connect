/** Host-only pinned attachment transport. Whole authenticated objects, never
 * file-sized buffers: stream ciphertext segments into the engine's scoped slot.
 * A plaintext range still fetches each complete intersecting encrypted chunk.
 */
import { decode, type CborValue } from "../../../packages/sdk/src/cbor.ts";
import type { Engine, AttachmentReadOut } from "./engine.js";
import { sendCall, StaleAppendStore, type LogFence } from "./log.ts";
import type { ObjectOriginPolicy } from "./object-origins.ts";
import { objectMap as map, objectSize as size, streamDirectObject } from "./object-download.ts";

const INLINE = 1 << 20;
const META = INLINE + (32 << 10);

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
  let completedCurrent = current;
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
      completedCurrent = await streamDirectObject(log, map(result.get(1)), count, checksum, current, origins,
        () => engine.attachmentReserve(lease.ticket, count),
        bytes => engine.attachmentWrite(lease.ticket, bytes), AbortSignal.timeout(15_000), directFetch);
    }
    // Rust checks the full encoded checksum AND manifest/chunk authentication;
    // no plaintext release until both succeed and the current gate still holds.
    if (!completedCurrent() || !engine.attachmentComplete(lease.ticket, checksum)) throw new Error("object authentication failed");
  } catch {
    engine.attachmentFailed(lease.ticket); // exact old ticket cannot cancel a newer stream
  } finally {
    inline?.fill(0);
    lease.frame.fill(0);
  }
}
