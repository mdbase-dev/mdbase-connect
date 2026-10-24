/**
 * `POST /internal/v1/migration/sample` (service token): a read-only per-item
 * digest sample of one migrated collection's hosted target, for a post-routed
 * verifier. At most 5 records and 1 file per request. The reply carries IDs,
 * digests and sizes only (never a path, document or file byte), answered by the
 * native store (`crates/hosted-worker/src/migration_sample.rs`).
 *
 * Request: `{ collection, records: [uuid...], files: [uuid...] }`.
 * Reply: `{ collection, step, records: [Item], files: [Item] }` in request order,
 * `Item = { id, state: "present" | "missing" | "unsupported", digest, size }`.
 * A record's `digest` is its revision and a file's its content digest, both in
 * the legacy provider's `sha256:<hex>` form (comparable with legacy
 * `records.revision` and the file payload's `content_digest`); `size` is the
 * document's UTF-8 bytes or the file's plaintext bytes. `digest`/`size` are null
 * unless present. Only answered from native step `verified` through `routed`.
 */
import { encode, type CborValue } from "../../../packages/sdk/src/cbor.ts";
import { boundedText, serviceAuthorization } from "./service-devices.ts";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const NIL = "00000000-0000-0000-0000-000000000000";
const MAX_ENTRY_BYTES = 1024;
export const MAX_SAMPLE_RECORDS = 5;
export const MAX_SAMPLE_FILES = 1;
const STATES = ["missing", "present", "unsupported"] as const;

export interface SampleRequest { collection: string; records: string[]; files: string[] }
export interface SampleItem { id: string; state: (typeof STATES)[number]; digest: string | null; size: number | null }

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const uuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v) && v !== NIL;
const ids = (v: unknown, max: number): string[] | null =>
  Array.isArray(v) && v.length <= max && v.every(uuid) && new Set(v).size === v.length ? v as string[] : null;

/** Authenticate and parse; any other shape is `400 invalid_request`. */
export async function migrationSampleRequest(request: Request, token?: string): Promise<SampleRequest | Response> {
  const denied = serviceAuthorization(request, token);
  if (denied) return denied;
  const text = await boundedText(request, MAX_ENTRY_BYTES);
  let body: unknown;
  try { body = text === null ? null : JSON.parse(text); } catch { return json(400, { error: "invalid_request" }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json(400, { error: "invalid_request" });
  const b = body as Record<string, unknown>;
  const records = ids(b.records, MAX_SAMPLE_RECORDS), files = ids(b.files, MAX_SAMPLE_FILES);
  if (Object.keys(b).length !== 3 || !uuid(b.collection) || !records || !files || records.length + files.length === 0) {
    return json(400, { error: "invalid_request" });
  }
  return { collection: b.collection, records, files };
}

const bytes = (u: string) => Uint8Array.from(u.replaceAll("-", "").match(/../g)!, h => parseInt(h, 16));
const hex = (b: Uint8Array) => Array.from(b, v => v.toString(16).padStart(2, "0")).join("");

/** The native request: CBOR `[[record id bytes...], [file id bytes...]]`. */
export function nativeSampleRequest(input: SampleRequest): Uint8Array {
  return encode([input.records.map(bytes), input.files.map(bytes)]);
}

function items(v: CborValue, requested: string[]): SampleItem[] {
  if (!Array.isArray(v) || v.length !== requested.length) throw new Error("migration_sample_invalid");
  return v.map((item, i) => {
    if (!Array.isArray(item) || item.length !== 4) throw new Error("migration_sample_invalid");
    const [id, state, digest, size] = item;
    const present = state === 1;
    if (!(id instanceof Uint8Array) || id.length !== 16 || hex(id) !== requested[i].replaceAll("-", "")
        || typeof state !== "number" || STATES[state] === undefined
        || (present ? !(digest instanceof Uint8Array) || digest.length !== 32
          || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 : digest !== null || size !== null)) {
      throw new Error("migration_sample_invalid");
    }
    return { id: requested[i], state: STATES[state], digest: present ? `sha256:${hex(digest as Uint8Array)}` : null,
      size: present ? size as number : null };
  });
}

/** Check the native reply against the request and map it to the JSON body. */
export function migrationSampleBody(input: SampleRequest, step: number, reply: CborValue) {
  if (!Array.isArray(reply) || reply.length !== 2) throw new Error("migration_sample_invalid");
  return { collection: input.collection, step, records: items(reply[0], input.records), files: items(reply[1], input.files) };
}
