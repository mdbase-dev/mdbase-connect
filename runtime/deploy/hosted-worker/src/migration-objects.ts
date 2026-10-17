/** Generation-0 object transport: inline <=1 MiB, otherwise the log's own
 * direct PUT URL followed by signed commit_object, and HasObjects over exactly
 * the native verification list. No generic third-party object-store transport. Signed with the engine's
 * device key through the same `sendCall` as every log RPC. Transport only:
 * native settles the window or finish from the HasObjects flags. */
import { decode, encode, type CborValue } from "../../../packages/sdk/src/cbor.ts";
import type { Engine } from "./engine.js";
import { sendCall, StaleAppendStore, type LogFence } from "./log.ts";

const MAX_INLINE = 1 << 20;
const MAX_OBJECT = 9 << 20;
const MAX_ADDRESSES = 1024;
const MAX_REPLY = 64 << 10;
const unhex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g) ?? [], h => Number.parseInt(h, 16));
const uuid = (s: string): Uint8Array => unhex(s.replaceAll("-", ""));
/** Ids above the engine's own call ids; one call at a time per executor. */
let next = 2 ** 40;

async function rpc(log: Fetcher, signer: Pick<Engine, "signRpc">, token: string, method: string,
  params: Map<number, CborValue>, current: LogFence): Promise<Map<CborValue, CborValue>> {
  const id = ++next;
  let raw: Uint8Array | null = null;
  let failed = false;
  await sendCall(log, {
    signRpc: (...args) => signer.signRpc(...args),
    logReply: (rid, bytes) => { if (rid === id) raw = bytes.slice(); },
    logFailed: () => { failed = true; },
  }, token, { id, frame: encode(new Map<number, CborValue>([[0, 0], [1, id], [2, method], [3, params]])) },
  current, new StaleAppendStore(0, 0), undefined, MAX_REPLY);
  if (failed || !raw || !current()) throw new Error(`migration_object_${method}_unavailable`);
  const decoded = decode(raw);
  const reply = decoded instanceof Map ? decoded as Map<CborValue, CborValue> : null;
  if (!reply || reply.get(0) !== 1 || reply.get(1) !== id || !(reply.get(2) instanceof Map)) {
    throw new Error(`migration_object_${method}_refused`);
  }
  return reply.get(2) as Map<CborValue, CborValue>;
}

export async function putGen0Object(log: Fetcher, signer: Pick<Engine, "signRpc">, token: string, collection: string,
  object: { address: string; kind: number; bytes: Uint8Array }, current: LogFence, signal: AbortSignal): Promise<void> {
  const live = () => current() && !signal.aborted;
  if (!live()) throw new Error("migration_object_put_unavailable");
  if (!object.bytes.length || object.bytes.length > MAX_OBJECT || !/^[0-9a-f]{64}$/.test(object.address)) throw new Error("migration_object_invalid");
  const checksum = new Uint8Array(await crypto.subtle.digest("SHA-256", object.bytes));
  if (Array.from(checksum, b => b.toString(16).padStart(2,"0")).join("") !== object.address) throw new Error("migration_object_invalid");
  const params = new Map<number, CborValue>([
    [0, uuid(collection)], [1, unhex(object.address)], [2, object.kind], [3, object.bytes.length], [4, checksum],
  ]);
  if (object.bytes.length <= MAX_INLINE) params.set(5, object.bytes);
  const result = await rpc(log, signer, token, "put_object", params, live);
  const status = result.get(0);
  if (status === 2 || (status === 0 && object.bytes.length <= MAX_INLINE)) return;
  if (status !== 1 || object.bytes.length <= MAX_INLINE) throw new Error("migration_object_put_refused");
  const direct = result.get(1);
  if (!(direct instanceof Map)) throw new Error("migration_object_put_refused");
  const d = direct as Map<CborValue, CborValue>;
  const rawUrl = d.get(0), headers = d.get(1), expires = d.get(2);
  if (typeof rawUrl !== "string" || rawUrl.length > 2048 || !(headers instanceof Map)
    || typeof expires !== "number" || !Number.isSafeInteger(expires)) throw new Error("migration_object_put_refused");
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error("migration_object_put_refused"); }
  const check64 = btoa(String.fromCharCode(...checksum));
  // Exact URL/header profile emitted by log-service::Service::direct. Route
  // through the SAME trusted log Fetcher, never fetch a response-chosen origin.
  if (url.protocol !== "https:" || url.username || url.password || url.hash
    || url.pathname !== `/v1/o/${collection}/${object.address}` || url.searchParams.size !== 6 || url.searchParams.get("op") !== "put"
    || url.searchParams.get("size") !== String(object.bytes.length) || url.searchParams.get("ck") !== object.address
    || url.searchParams.get("exp") !== String(expires) || !/^[0-9a-f]{32}$/.test(url.searchParams.get("dev") ?? "")
    || !/^[0-9a-f]{64}$/.test(url.searchParams.get("sig") ?? "")
    || headers.size !== 1 || (headers as Map<CborValue, CborValue>).get("x-amz-checksum-sha256") !== check64) throw new Error("migration_object_put_refused");
  const remaining = expires - Date.now();
  if (remaining <= 5000) throw new Error("migration_object_put_refused");
  const putSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.min(remaining, 90_000))]);
  if (!live()) throw new Error("migration_object_put_unavailable");
  let response: Response | null = null;
  try {
    response = await log.fetch(new URL(url.pathname + url.search, "https://log.internal").href, {
      method: "PUT", body: object.bytes as BodyInit, headers: { "x-amz-checksum-sha256": check64 }, redirect: "manual", signal: putSignal,
    });
  } catch {
    // A lost PUT reply is UNKNOWN. Only the authenticated commit below proves
    // the exact size/checksum landed; it never becomes a fabricated success.
  }
  if (response) {
    await response.body?.cancel();
    if (!response.ok && response.status < 500 && ![408,425,429].includes(response.status)) throw new Error("migration_object_put_refused");
  }
  if (!live()) throw new Error("migration_object_put_unavailable");
  const committed = await rpc(log, signer, token, "commit_object", new Map<number, CborValue>([
    [0, uuid(collection)], [1, unhex(object.address)],
  ]), live);
  if (committed.get(0) !== true) throw new Error("migration_object_commit_refused");
}

export async function hasGen0Objects(log: Fetcher, signer: Pick<Engine, "signRpc">, token: string, collection: string,
  addresses: string[], current: LogFence): Promise<boolean[]> {
  if (!addresses.length) return [];
  if (addresses.length > MAX_ADDRESSES || !addresses.every(a => /^[0-9a-f]{64}$/.test(a))) throw new Error("migration_object_invalid");
  const result = await rpc(log, signer, token, "has_objects", new Map<number, CborValue>([
    [0, uuid(collection)], [1, addresses.map(unhex)],
  ]), current);
  const present = result.get(0);
  if (!Array.isArray(present) || present.length !== addresses.length || !present.every(p => typeof p === "boolean")) {
    throw new Error("migration_object_has_refused");
  }
  return present as boolean[];
}
