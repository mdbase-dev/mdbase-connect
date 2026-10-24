/** Fixed CBOR mirrors of legacy source results (`legacy-source/source.ts`) for
 * native settlement (`hd_migration_source_result`). Strict shape checks only:
 * native binds the result to the run, the settled hold and open, and the exact
 * pending action, and is the only place a Driver outcome is formed. Page rows
 * carry identity, path, content hash and size, never document bytes. */
import { sha256 } from "@noble/hashes/sha2.js";
import { encode, type CborValue } from "../../../packages/sdk/src/cbor.js";
import type { CheckpointRequest, FileRow, Page, RecordRow, ResourceRow } from "./legacy-source/source.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NIL = "00000000-0000-0000-0000-000000000000";
const DIGEST = /^sha256:([0-9a-f]{64})$/;
const MAX_TEXT = 4096;
/** Native page bounds (`budget::MAX_SOURCE_PAGE_ROWS`/`MAX_SOURCE_PAGE_BYTES`),
 * the same as Connect's paged migration sources. */
export const MAX_SOURCE_PAGE_ROWS = 64;
export const MAX_SOURCE_INPUT = 48 * 1024;

export type MigrationSourceResult =
  /** `openCheckpoint(request)` → `checkpoint.session`. */
  | { kind: "opened"; request: CheckpointRequest; session: string }
  /** One `nextPage(session, table, after, …)` page. */
  | { kind: "page"; session: string; after: string | null; page:
      | { table: "resources"; page: Page<ResourceRow> }
      | { table: "records"; page: Page<RecordRow> }
      | { table: "files"; page: Page<FileRow> } };

/** Driver action kind (native `codec::action`) each result settles. */
export const SOURCE_RESULT_KIND = { opened: 2, page: 3 } as const satisfies Record<MigrationSourceResult["kind"], number>;

class Refused extends Error { constructor() { super("migration_source_result_invalid"); } }
const refuse = (): never => { throw new Refused(); };

function uuid(v: unknown): Uint8Array {
  if (typeof v !== "string" || !UUID.test(v) || v === NIL) return refuse();
  return Uint8Array.from(v.replaceAll("-", "").match(/../g)!, h => Number.parseInt(h, 16));
}
function count(v: unknown): number { return Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : refuse(); }
function text(v: unknown): string {
  return typeof v === "string" && v.length > 0 && new TextEncoder().encode(v).length <= MAX_TEXT ? v : refuse();
}
function digest(v: unknown): Uint8Array {
  const m = typeof v === "string" ? DIGEST.exec(v) : null;
  return m ? Uint8Array.from(m[1].match(/../g)!, h => Number.parseInt(h, 16)) : refuse();
}

type Mirrored = { key: string; row: CborValue };
function resource(r: ResourceRow): Mirrored {
  if (!(r.document instanceof Uint8Array)) return refuse();
  // The source checked a sha256 revision against the document; hash otherwise.
  const content = DIGEST.test(r.revision) ? digest(r.revision) : sha256(r.document);
  return { key: text(r.path), row: [null, text(r.path), content, r.document.length] };
}
function record(r: RecordRow): Mirrored {
  return { key: r.recordId, row: [uuid(r.recordId), text(r.path), digest(r.revision), count(r.documentBytes)] };
}
function file(r: FileRow): Mirrored {
  return { key: r.fileId, row: [uuid(r.fileId), text(r.path), digest(r.contentDigest), count(r.size)] };
}

/** Encode one source result; throws `migration_source_result_invalid`. A page
 * over the native bounds is cut to its largest admitted prefix, which then
 * continues at its last row, exactly as Connect's paged sources stop short. */
export function migrationSourceInput(result: MigrationSourceResult): Uint8Array {
  if (result.kind === "opened") {
    const r = result.request;
    if (r.expectedState !== "active" && r.expectedState !== "migrating") return refuse();
    const input = encode([0, uuid(r.collection), r.expectedState, count(r.S0), uuid(result.session), uuid(r.backupHold)]);
    return input.length <= MAX_SOURCE_INPUT ? input : refuse();
  }
  if (result.kind !== "page") return refuse();
  const { table, page } = result.page;
  if (!page || !Array.isArray(page.rows) || typeof page.done !== "boolean") return refuse();
  const after = result.after === null ? null : text(result.after);
  const rows: Mirrored[] = table === "resources" ? page.rows.map(resource)
    : table === "records" ? page.rows.map(record)
    : table === "files" ? page.rows.map(file) : refuse();
  // The source continues at its last key; an unfinished page must have one.
  if (!page.done && (rows.length === 0 || page.next !== rows.at(-1)!.key)) return refuse();
  const head = [1, uuid(page.collection), count(page.S0), uuid(result.session), table, after] as const;
  const encodeWith = (n: number) => {
    const next = n < rows.length || !page.done ? rows[n - 1].key : null;
    return encode([...head, rows.slice(0, n).map(r => r.row), next]);
  };
  if (rows.length === 0) return encode([...head, [], null]);
  let input: Uint8Array | null = null;
  for (let n = 1; n <= Math.min(rows.length, MAX_SOURCE_PAGE_ROWS); n++) {
    const candidate = encodeWith(n);
    if (candidate.length > MAX_SOURCE_INPUT) break;
    input = candidate;
  }
  return input ?? refuse();
}
