/** Fixed CBOR mirrors for native generation-0 import (`hd_migration_gen0_*`):
 * the current bytes of one read's placements, from the legacy source reader
 * (`legacy-source/source.ts`) at the SAME open session, and the HasObjects
 * flags over what native asked the host to verify. Strict shape checks only:
 * native binds every byte to the settled open and to the S0 placement's
 * SHA-256 and size before sealing, and is the only place an Outcome is formed. */
import { encode, decode, type CborValue } from "../../../packages/sdk/src/cbor.ts";
import type { FileRow, RecordRow, ResourceRow } from "./legacy-source/source.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NIL = "00000000-0000-0000-0000-000000000000";
const MAX_TEXT = 4096;
/** Whole-file convenience for legacy ABI v1 and direct Engine import tests. */
export const MAX_GEN0_FILE_BYTES = 1 << 20;
export const MAX_GEN0_FILE_CHUNK_BYTES = 8 << 20;
export const MAX_GEN0_FILE_TOTAL_BYTES = 1 << 30;
/** Native input bounds (`migration_action_ledger::gen0`). */
export const MAX_GEN0_FILE_INPUT = MAX_GEN0_FILE_BYTES + 256;
export const MAX_GEN0_RECORD_BYTES = 1 << 20;
export const MAX_GEN0_WINDOW_INPUT = MAX_GEN0_RECORD_BYTES + 8 * 1024;
export const MAX_GEN0_WINDOW_ROWS = 128;
export const MAX_GEN0_RESULT_INPUT = 4 * 1024;
/** Driver action kinds (native `codec::action`). */
export const GEN0_KIND = { import: 4, finish: 5 } as const;

/** The open source read the bytes come from: `openCheckpoint` + its session. */
export interface Gen0Source { collection: string; S0: number; session: string }
/** One whole current file of the pending bucket, streamed by `streamContent`
 * (which already verified size and SHA-256) and buffered whole. */
export interface Gen0FileInput { source: Gen0Source; file: FileRow; bytes: Uint8Array }
/** Next exact AttachmentV1 chunk of a current file. */
export interface Gen0FileChunkInput extends Gen0FileInput { offset: number }
/** Metadata of the exact native-selected prefix, not host-selected rows. */
export interface Gen0Placement {
  kind: 0 | 1 | 2; key: string; path: string; size: number; hash: string;
}
export interface Gen0Placements { rows: Gen0Placement[]; done: boolean }
/** The pending window's resources (the resource window) or records (a bucket
 * window), each with its inline current document. */
export interface Gen0WindowInput {
  source: Gen0Source;
  rows: Array<{ resource: ResourceRow } | { record: RecordRow }>;
}
/** HasObjects over exactly the addresses native returned to verify, in order. */
export interface Gen0Result { collection: string; present: boolean[] }

/** Sealed objects to upload (`put_object`) and every address whose presence
 * settles the window or finish. */
export interface Gen0Sealed {
  objects: Array<{ address: string; kind: number; bytes: Uint8Array }>;
  verify: string[];
}

class Refused extends Error { constructor() { super("migration_gen0_input_invalid"); } }
const refuse = (): never => { throw new Refused(); };

function uuid(v: unknown): Uint8Array {
  if (typeof v !== "string" || !UUID.test(v) || v === NIL) return refuse();
  return Uint8Array.from(v.replaceAll("-", "").match(/../g)!, h => Number.parseInt(h, 16));
}
function count(v: unknown): number { return Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : refuse(); }
function path(v: unknown): string {
  return typeof v === "string" && v.length > 0 && new TextEncoder().encode(v).length <= MAX_TEXT ? v : refuse();
}
function head(s: Gen0Source): CborValue[] {
  return [uuid(s.collection), count(s.S0), uuid(s.session)];
}
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** `[collection, head, session, file id, bytes]`; throws `migration_gen0_input_invalid`. */
export function migrationGen0FileInput(input: Gen0FileInput): Uint8Array {
  const { file, bytes } = input;
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_GEN0_FILE_BYTES || bytes.length !== count(file.size)) return refuse();
  const out = encode([...head(input.source), uuid(file.fileId), bytes]);
  return out.length <= MAX_GEN0_FILE_INPUT ? out : refuse();
}

/** Chunk interface v1: `[collection, head, session, file id, offset, bytes]`. */
export function migrationGen0FileChunkInput(input: Gen0FileChunkInput): Uint8Array {
  const { file, bytes } = input;
  const size = count(file.size), offset = count(input.offset);
  if (size > MAX_GEN0_FILE_TOTAL_BYTES || offset > size || !(bytes instanceof Uint8Array)
    || bytes.length !== Math.min(size - offset, MAX_GEN0_FILE_CHUNK_BYTES)) return refuse();
  const out = encode([...head(input.source), uuid(file.fileId), offset, bytes]);
  return out.length <= MAX_GEN0_FILE_CHUNK_BYTES + 256 ? out : refuse();
}

/** `[collection, head, session, [[path | record id, text]…]]`. Resource text is
 * the decrypted document as UTF-8; a record by reference (`contentRef`, over
 * the page bound) or not valid UTF-8 is refused, never truncated. */
export function migrationGen0WindowInput(input: Gen0WindowInput): Uint8Array {
  if (!Array.isArray(input.rows) || input.rows.length > MAX_GEN0_WINDOW_ROWS) return refuse();
  const rows = input.rows.map((r): CborValue => {
    if ("resource" in r) {
      const doc = r.resource.document;
      if (!(doc instanceof Uint8Array)) return refuse();
      let text: string;
      try { text = utf8.decode(doc); } catch { return refuse(); }
      return [path(r.resource.path), text];
    }
    if ("record" in r && typeof r.record.document === "string") {
      return [uuid(r.record.recordId), r.record.document];
    }
    return refuse();
  });
  const out = encode([...head(input.source), rows]);
  const isolated = input.rows.length === 1 && "record" in input.rows[0]
    && typeof input.rows[0].record.document === "string"
    && new TextEncoder().encode(input.rows[0].record.document).length <= MAX_GEN0_RECORD_BYTES;
  return out.length <= (isolated ? MAX_GEN0_WINDOW_INPUT : 72 * 1024) ? out : refuse();
}

/** `[collection, [present…]]`. */
export function migrationGen0ResultInput(result: Gen0Result): Uint8Array {
  if (!Array.isArray(result.present) || !result.present.every(p => typeof p === "boolean")) return refuse();
  const out = encode([uuid(result.collection), result.present]);
  return out.length <= MAX_GEN0_RESULT_INPUT ? out : refuse();
}

const hex = (b: Uint8Array) => Array.from(b, v => v.toString(16).padStart(2, "0")).join("");
function address(v: CborValue): string {
  return v instanceof Uint8Array && v.length === 32 ? hex(v) : refuse();
}

/** Native placement-list interface v1: `[rows, done]`. */
export function decodeGen0Placements(output: Uint8Array): Gen0Placements {
  const v = decode(output);
  if (!Array.isArray(v) || v.length !== 2 || !Array.isArray(v[0]) || typeof v[1] !== "boolean"
    || v[0].length > MAX_GEN0_WINDOW_ROWS) return refuse();
  const rows = v[0].map((r): Gen0Placement => {
    if (!Array.isArray(r) || r.length !== 5 || (r[0] !== 0 && r[0] !== 1 && r[0] !== 2)
      || typeof r[1] !== "string") return refuse();
    if (r[0] === 0) path(r[1]); else uuid(r[1]);
    return { kind: r[0], key: r[1], path: path(r[2]), size: count(r[3]), hash: address(r[4]) };
  });
  return { rows, done: v[1] };
}

/** Decode native's `[[[address, kind, bytes]…], [address…]]` output. */
export function decodeGen0Sealed(output: Uint8Array): Gen0Sealed {
  const v = decode(output);
  if (!Array.isArray(v) || v.length !== 2 || !Array.isArray(v[0]) || !Array.isArray(v[1])) return refuse();
  const objects = v[0].map(o => {
    if (!Array.isArray(o) || o.length !== 3 || !(o[2] instanceof Uint8Array) || typeof o[1] !== "number") return refuse();
    return { address: address(o[0]), kind: o[1], bytes: o[2] };
  });
  return { objects, verify: v[1].map(address) };
}
