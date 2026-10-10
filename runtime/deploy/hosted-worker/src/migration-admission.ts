/** Read-only public observations, never a native migration permit. */
import { evidence } from "./app.ts";
import { serviceAuthorization } from "./service-devices.ts";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const NIL = "00000000-0000-0000-0000-000000000000";
const MAX_REQUEST_BYTES = 1024;
const U64 = (1n << 64n) - 1n;
export interface MigrationAdmissionRequest { collection: string; challenge: string }
const uuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v) && v !== NIL;
const u64 = (v: unknown): v is bigint => typeof v === "bigint" && v >= 0n && v <= U64;
const hash = (v: unknown): v is Uint8Array => v instanceof Uint8Array && v.byteLength === 32 && v.some(x => x !== 0);
const hex = (v: Uint8Array) => Array.from(v, x => x.toString(16).padStart(2, "0")).join("");
const error = (status: number, code: string) => Response.json({ error: code }, {
  status, headers: { "cache-control": "no-store" },
});
export const migrationAdmissionUnavailable = () => error(503, "migration_admission_unavailable");

function challenge(v: unknown): v is string {
  if (typeof v !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(v)) return false;
  try { const decoded = atob(v); return decoded.length === 32 && btoa(decoded) === v; }
  catch { return false; }
}

/** Authenticate before allocation/read; bound bytes BEFORE decoding/parsing. */
export async function migrationAdmissionRequest(request: Request, token?: string): Promise<MigrationAdmissionRequest | Response> {
  const denied = serviceAuthorization(request, token);
  if (denied) return denied;
  const reader = request.body?.getReader();
  if (!reader) return error(400, "invalid_request");
  const bytes = new Uint8Array(MAX_REQUEST_BYTES);
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (part.value.byteLength > MAX_REQUEST_BYTES - length) {
        await reader.cancel();
        return error(400, "invalid_request");
      }
      bytes.set(part.value, length);
      length += part.value.byteLength;
    }
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)));
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 2) return error(400, "invalid_request");
    const value = body as Record<string, unknown>;
    if (!uuid(value.collection) || !challenge(value.challenge)) return error(400, "invalid_request");
    return { collection: value.collection, challenge: value.challenge };
  } catch { return error(400, "invalid_request"); }
  finally { reader.releaseLock(); }
}

/** Project ONLY hd_admission's verified tuple, sampled synchronously at output.
 * Caller separately rechecks live custody/root/Noise and the exact Engine. */
export function migrationAdmissionObservation(encoded: unknown, request: MigrationAdmissionRequest, device: string) {
  try {
    if (!Array.isArray(encoded) || encoded.length !== 2 || !(encoded[1] instanceof Map) || encoded[1].size !== 15) return null;
    const map = encoded[1] as Map<number, unknown>;
    const scalar = (v: unknown) => u64(v) || typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
    if (![5, 6, 7, 14].every(k => scalar(map.get(k))) || ![8, 9].every(k => {
      const h = map.get(k); return Array.isArray(h) && h.length === 2 && scalar(h[0]);
    })) return null;
    const e = evidence(encoded);
    if (!e || !uuid(request.collection) || !challenge(request.challenge) || !uuid(device) || e.collection !== request.collection || e.device !== device ||
      !u64(e.epoch) || e.epoch === 0n || !u64(e.wake) || e.wake === 0n || !u64(e.generation) ||
      !u64(e.applied.seq) || e.applied.seq === 0n || !u64(e.authenticated.seq) ||
      e.applied.seq !== e.authenticated.seq || !hash(e.applied.chain) || !hash(e.authenticated.chain) ||
      hex(e.applied.chain) !== hex(e.authenticated.chain) || !hash(e.controlChain)) return null;
    return {
      schema: "mdbn-migration-admission/1", collection: e.collection, device_id: e.device,
      epoch: e.epoch.toString(), wake: e.wake.toString(), fault_generation: e.generation.toString(),
      applied_head: { seq: e.applied.seq.toString(), chain: hex(e.applied.chain) },
      authenticated_head: { seq: e.authenticated.seq.toString(), chain: hex(e.authenticated.chain) },
      control_chain: hex(e.controlChain), challenge: request.challenge,
    };
  } catch { return null; }
}
