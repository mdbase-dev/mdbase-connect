/**
 * The bounded **legacy source** for hosted import (migration's seam, H0–H9):
 * today's hosted provider Postgres at one fixed checkpoint, plus its R2 file
 * bytes. Read-only by construction; nothing here writes the source.
 *
 * - `openCheckpoint` opens ONE repeatable-read read-only transaction (the host's
 *   `openTx`; checked here) as a SELECT-only role (no superuser, no write
 *   privilege on any provider table), proves the collection is in the state the
 *   caller expects (`active` at S0, `migrating` at S_final) at exactly the fixed
 *   head, that the named backup hold is in force, and unwraps the collection key
 *   into a non-extractable WebCrypto key under the legacy role's configuration.
 * - The backup hold is re-checked OUTSIDE the checkpoint transaction (where
 *   `now()` is frozen) before every page and stream; its `expires_at` is returned
 *   so the consumer can renew it.
 * - `nextPage` returns resources, records or file metadata in primary-key order,
 *   bounded by count AND decoded bytes. Ciphertext lengths are admitted before any
 *   ciphertext is read. A record too large for the page bound comes alone, by
 *   reference: `streamRecord` then streams its document bytes, verified, with
 *   per-row memory bounded by `rowBound` (the collection's document quota with
 *   worst-case JSON escaping, plus framing). A row over that bound is refused explicitly, never
 *   skipped, and `inventory` counts such rows up front (H0).
 * - `nextChanges`, `replicas` and `nextFacts` read the change after-images, the
 *   non-revoked replicas, and the mutation-journal acknowledgement facts at the
 *   same checkpoint, with the same bounds.
 * - `streamContent` streams one file's R2 bytes by an opaque per-session ref (never
 *   the object key), verifying size and SHA-256 incrementally; the stream errors
 *   (it never ends cleanly) on a mismatch, so a consumer that commits only on a
 *   clean end never commits unverified bytes.
 * - `close` rolls the transaction back, drops the key and aborts open streams.
 *
 * No plaintext, keys or pending state are persisted anywhere by this module.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { aad, LegacyCryptoError, openEnvelope, revisionOf, unwrapCollectionKey, type LegacyUnwrapper } from "./crypto.ts";

/** A row from the host's Postgres driver (column name → value; bytea as Uint8Array). */
export type Row = Record<string, unknown>;

/** The host's transaction: REPEATABLE READ READ ONLY, opened before the first read. */
export interface ReadOnlyTx {
  query(sql: string, params: unknown[], signal: AbortSignal): Promise<Row[]>;
  /** Roll back and release. Idempotent. */
  close(): Promise<void>;
}

/** The legacy R2 bucket, read side only. */
export interface LegacyObjects {
  get(key: string, signal: AbortSignal): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>;
}

export interface LegacySourceConfig {
  openTx(signal: AbortSignal): Promise<ReadOnlyTx>;
  /**
   * The backup hold's current `expires_at`, or null when it does not exist. Must
   * run OUTSIDE the checkpoint transaction (a separate statement/connection), so a
   * renewal or a lapse is seen; inside the checkpoint `now()` is frozen.
   */
  holdExpiry(holdId: string, signal: AbortSignal): Promise<Date | null>;
  objects: LegacyObjects;
  unwrapper: LegacyUnwrapper;
}

/** The collection state the checkpoint is taken in: S0 (`active`) or S_final (`migrating`, Connect #592). */
export type ExpectedState = "active" | "migrating";

export interface CheckpointRequest {
  collection: string;
  /** The fixed source sequence the checkpoint is consistent at (S0 or S_final). */
  S0: number;
  /** The state the collection must be in at that head. */
  expectedState: ExpectedState;
  /** `hosted_provider_backup_holds.id` that must stay in force while reading. */
  backupHold: string;
  /** The retention the caller has secured for legacy rows and R2 (ISO time). */
  retainUntil: string;
}

export interface Checkpoint {
  session: string;
  /** The backup hold's expiry as last checked; renew before it. */
  holdExpiresAt: string;
}

export type Table = "resources" | "records" | "files";

export interface PageLimits { maxRecords: number; maxDecodedBytes: number }

export interface ResourceRow { path: string; kind: string; revision: string; document: Uint8Array }
/**
 * A current record, or a change's after-image. `document` is inline when it fit the
 * page; otherwise it is null and `contentRef` streams it (`streamRecord`).
 */
export interface RecordRow {
  recordId: string; path: string; revision: string; sequence: number;
  /** UTF-8 bytes of the document. Over `RECORD_DOCUMENT_CAP`: import as a file. */
  documentBytes: number;
  document: string | null;
  contentRef: string | null;
}
export interface FileRow {
  fileId: string; path: string; contentDigest: string; size: number;
  mediaType: string | null; mediaClass: string; sequence: number;
  /** Opaque per-session handle for `streamContent`; never the R2 key. */
  sourceRef: string;
}
export type ChangeRow =
  | { kind: "record"; sequence: number; recordId: string; after: RecordRow | null }
  | { kind: "file"; sequence: number; fileId: string; after: FileRow | null }
  | { kind: "resource"; sequence: number; path: string; resourceKind: string | null };
export interface ReplicaRow { id: string; purpose: string }
/** A terminal mutation-journal fact (loss oracle / rollback evidence). */
export interface JournalFact {
  replicaId: string; requestId: string;
  state: "completed" | "acknowledged" | "outcome_unknown" | "abandoned";
  /** Hex of the provider's receipt digest. */
  receiptDigest: string;
  completedAt: string; acknowledgedAt: string | null;
}
export type FactTable = "journal" | "tombstones";

export interface Page<T> {
  rows: T[]; next: string | null; done: boolean; collection: string; S0: number; holdExpiresAt: string;
}

/** H0 inventory at the checkpoint, from metadata only (no ciphertext read). */
export interface Inventory {
  records: { total: number; documentsOverRecordCap: number; overRowBound: number };
  resources: { total: number; overRowBound: number };
  files: { total: number; overRowBound: number };
  recordChanges: { total: number; overRowBound: number };
  fileChanges: { total: number; overRowBound: number };
}

/** Why the source refused. Never carries plaintext. */
export class LegacySourceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const MAX_RECORDS = 250;
/** Page bound on decoded bytes; a single inline row may use all of it. */
export const MAX_PAGE_DECODED = 1024 * 1024;
/** Synced records are capped here; larger legacy documents import as files. */
export const RECORD_DOCUMENT_CAP = 1024 * 1024;
/** Envelope overhead: version byte, 12-byte nonce, 16-byte tag. */
const ENVELOPE = 29;
/**
 * Per-row ciphertext ceiling of a collection, and so per-row memory: its own
 * `max_document_bytes` quota times the worst-case JSON escaping factor (6: a control
 * character as a six-byte escape) plus 64 KiB of framing (path, revision, keys) and
 * the envelope, so no provider-valid row is refused. Never above
 * `HARD_ROW_CAP`: larger rows are refused explicitly and inventoried.
 */
export function rowBound(maxDocumentBytes: number): number {
  return Math.min(6 * Math.max(0, maxDocumentBytes) + 64 * 1024 + ENVELOPE, HARD_ROW_CAP);
}
/** Absolute per-row ceiling (Worker memory): 6 x 2 MiB + framing fits under it. */
export const HARD_ROW_CAP = 13 * 1024 * 1024;
const MAX_REPLICAS = 1000;
/** Includes pending source reads, not only streams whose first byte arrived. */
const MAX_OPEN_STREAMS = 2;
const STREAM_CHUNK = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FACT_CURSOR = /^([0-9a-f-]{36})\/([0-9a-f-]{36})$/;

/** A large record whose document is streamed: re-read in the same checkpoint by key. */
interface LargeRef { source: "current" | "change"; recordId: string; sequence: number; ctLen: number; revision: string }

interface Session {
  collection: string;
  S0: number;
  /** This collection's per-row ciphertext ceiling (`rowBound`). */
  maxRow: number;
  hold: string;
  holdExpiresAt: Date;
  tx: ReadOnlyTx;
  key: CryptoKey | null;
  files: Map<string, { objectKey: string; size: number; digest: string }>;
  large: Map<string, LargeRef>;
  /**
   * One large row in flight per session: a large row
   * (up to `rowBound`, about 12 MiB worst case) is decoded or streamed alone, and
   * no other large row may be read until it is done, so peak memory is one such row.
   */
  largeBusy: boolean;
  pageBusy: boolean;
  streams: Set<AbortController>;
  closed: boolean;
}

const bytes = (v: unknown, what: string): Uint8Array => {
  if (v instanceof Uint8Array) return v;
  throw new LegacySourceError("source_shape", `${what} is not bytea`);
};
const text = (v: unknown, what: string): string => {
  if (typeof v === "string") return v;
  throw new LegacySourceError("source_shape", `${what} is not text`);
};
const int = (v: unknown, what: string): number => {
  const n = typeof v === "bigint" ? Number(v) : typeof v === "string" ? Number(v) : v;
  if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) return n;
  throw new LegacySourceError("source_shape", `${what} is not a non-negative integer`);
};
const iso = (v: unknown, what: string): string => {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return new Date(v).toISOString();
  throw new LegacySourceError("source_shape", `${what} is not a timestamp`);
};
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

function decodeJson<T>(plain: Uint8Array): T {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plain)) as T;
  } catch {
    // Never quote decrypted plaintext in an error.
    throw new LegacyCryptoError("decode", "payload is not the expected JSON");
  } finally {
    plain.fill(0);
  }
}

interface RecordPayload { record_id: string; path: string; document: string; revision: string }
interface FilePayload { path: string; content_digest: string; media_type: string | null; media_class: string }

export class LegacySource {
  private sessions = new Map<string, Session>();
  constructor(private readonly config: LegacySourceConfig) {}

  async openCheckpoint(req: CheckpointRequest, signal: AbortSignal): Promise<Checkpoint> {
    if (!UUID.test(req.collection) || !UUID.test(req.backupHold) || !Number.isSafeInteger(req.S0) || req.S0 < 0
      || (req.expectedState !== "active" && req.expectedState !== "migrating")) {
      throw new LegacySourceError("invalid_request", "collection, backup hold, S0 and expected state must be well formed");
    }
    const tx = await this.config.openTx(signal);
    try {
      const [iso0] = await tx.query("SHOW transaction_isolation", [], signal);
      const [ro] = await tx.query("SHOW transaction_read_only", [], signal);
      if (Object.values(iso0 ?? {})[0] !== "repeatable read" || Object.values(ro ?? {})[0] !== "on") {
        throw new LegacySourceError("not_a_checkpoint", "the source transaction is not REPEATABLE READ READ ONLY");
      }
      await verifySelectOnly(tx, signal);
      const holds = await tx.query(
        "SELECT 1 FROM hosted_provider_backup_holds WHERE id = $1::uuid AND expires_at > now()", [req.backupHold], signal);
      if (holds.length !== 1) throw new LegacySourceError("no_backup_hold", "the named backup hold is not in force");
      const rows = await tx.query(
        "SELECT state, head, wrapped_data_key, max_document_bytes FROM hosted_provider_collections WHERE id = $1::uuid", [req.collection], signal);
      if (rows.length !== 1) throw new LegacySourceError("not_found", "the collection is not in the source");
      const row = rows[0];
      if (text(row.state, "state") !== req.expectedState) {
        throw new LegacySourceError("collection_state", `the collection is not ${req.expectedState}`);
      }
      if (int(row.head, "head") !== req.S0) throw new LegacySourceError("not_at_s0", "the source head is not the fixed checkpoint head");
      const holdExpiresAt = await this.liveHold(req.backupHold, signal);
      const key = await unwrapCollectionKey(this.config.unwrapper, bytes(row.wrapped_data_key, "wrapped_data_key"), req.collection, signal);
      signal.throwIfAborted();
      const id = crypto.randomUUID();
      this.sessions.set(id, {
        collection: req.collection, S0: req.S0, maxRow: rowBound(int(row.max_document_bytes, "max_document_bytes")),
        hold: req.backupHold, holdExpiresAt, tx, key,
        files: new Map(), large: new Map(), largeBusy: false, pageBusy: false, streams: new Set(), closed: false,
      });
      return { session: id, holdExpiresAt: holdExpiresAt.toISOString() };
    } catch (e) {
      await tx.close();
      throw e;
    }
  }

  /** The hold's live expiry, checked outside the checkpoint; refuses a lapsed hold. */
  private async liveHold(hold: string, signal: AbortSignal): Promise<Date> {
    const exp = await this.config.holdExpiry(hold, signal);
    signal.throwIfAborted();
    if (!exp || !(exp.getTime() > Date.now())) {
      throw new LegacySourceError("no_backup_hold", "the backup hold has lapsed; renew it and reopen");
    }
    return exp;
  }

  /** The open session, with its backup hold re-checked. */
  private async live(id: string, signal: AbortSignal): Promise<Session> {
    const s = this.session(id);
    s.holdExpiresAt = await this.liveHold(s.hold, signal);
    if (s.closed) throw new LegacySourceError("no_session", "the checkpoint session is closed");
    return s;
  }

  /** One page/hydration at a time: ref invalidation cannot race another page. */
  private async withPage<T>(id: string, signal: AbortSignal, read: (s: Session) => Promise<T>): Promise<T> {
    const s = await this.live(id, signal);
    if (s.pageBusy) throw new LegacySourceError("page_in_flight", "finish the current source page first");
    s.pageBusy = true;
    try {
      const result = await read(s);
      signal.throwIfAborted();
      if (s.closed || !s.key) throw new LegacySourceError("no_session", "the checkpoint session is closed");
      return result;
    } finally {
      s.pageBusy = false;
    }
  }

  private session(id: string): Session {
    const s = this.sessions.get(id);
    if (!s || s.closed || !s.key) throw new LegacySourceError("no_session", "the checkpoint session is closed");
    return s;
  }

  private reserveStream(s: Session): AbortController {
    if (s.closed) throw new LegacySourceError("no_session", "the checkpoint session is closed");
    if (s.streams.size >= MAX_OPEN_STREAMS) throw new LegacySourceError("stream_limit", "finish or cancel an open source stream first");
    const abort = new AbortController();
    s.streams.add(abort);
    return abort;
  }

  /** Take the session's single large-row slot, or refuse. */
  private takeLarge(s: Session): void {
    if (s.largeBusy) {
      throw new LegacySourceError("large_row_in_flight", "finish (or cancel) the open large record stream first");
    }
    s.largeBusy = true;
  }

  private page<T>(s: Session, rows: T[], next: string | null, done: boolean): Page<T> {
    return { rows, next, done, collection: s.collection, S0: s.S0, holdExpiresAt: s.holdExpiresAt.toISOString() };
  }

  /** H0: counts at the checkpoint, from lengths only, of rows each bound would refuse or reroute. */
  async inventory(id: string, signal: AbortSignal): Promise<Inventory> {
    const s = await this.live(id, signal);
    const one = async (sql: string, params: unknown[]) => {
      const [r] = await s.tx.query(sql, params, signal);
      signal.throwIfAborted();
      return r ?? {};
    };
    const rec = await one(
      `SELECT count(*) AS total, count(*) FILTER (WHERE content_bytes > $2) AS big,
              count(*) FILTER (WHERE length(payload_ciphertext) > $3) AS over
       FROM hosted_provider_records WHERE collection_id = $1::uuid`,
      [s.collection, RECORD_DOCUMENT_CAP, s.maxRow]);
    const res = await one(
      `SELECT count(*) AS total, count(*) FILTER (WHERE length(document_ciphertext) > $2) AS over
       FROM hosted_provider_resources WHERE collection_id = $1::uuid`, [s.collection, MAX_PAGE_DECODED + ENVELOPE]);
    const fil = await one(
      `SELECT count(*) AS total, count(*) FILTER (WHERE length(payload_ciphertext) > $2) AS over
       FROM hosted_provider_files WHERE collection_id = $1::uuid`, [s.collection, MAX_PAGE_DECODED + ENVELOPE]);
    const rch = await one(
      `SELECT count(*) AS total, count(*) FILTER (WHERE length(after_ciphertext) > $2) AS over
       FROM hosted_provider_changes WHERE collection_id = $1::uuid`, [s.collection, s.maxRow]);
    const fch = await one(
      `SELECT count(*) AS total, count(*) FILTER (WHERE length(after_ciphertext) > $2) AS over
       FROM hosted_provider_file_changes WHERE collection_id = $1::uuid`, [s.collection, MAX_PAGE_DECODED + ENVELOPE]);
    return {
      records: { total: int(rec.total, "count"), documentsOverRecordCap: int(rec.big, "count"), overRowBound: int(rec.over, "count") },
      resources: { total: int(res.total, "count"), overRowBound: int(res.over, "count") },
      files: { total: int(fil.total, "count"), overRowBound: int(fil.over, "count") },
      recordChanges: { total: int(rch.total, "count"), overRowBound: int(rch.over, "count") },
      fileChanges: { total: int(fch.total, "count"), overRowBound: int(fch.over, "count") },
    };
  }

  /** One bounded page of `table` after the opaque `cursor`. */
  async nextPage(id: string, table: "resources", cursor: string | null, limits: PageLimits, signal: AbortSignal): Promise<Page<ResourceRow>>;
  async nextPage(id: string, table: "records", cursor: string | null, limits: PageLimits, signal: AbortSignal): Promise<Page<RecordRow>>;
  async nextPage(id: string, table: "files", cursor: string | null, limits: PageLimits, signal: AbortSignal): Promise<Page<FileRow>>;
  async nextPage(id: string,table: Table,cursor: string|null,limits: PageLimits,signal: AbortSignal): Promise<Page<unknown>> {
    return this.withPage(id,signal,async (s) => {
      if(cursor!==null&&table!=="resources"&&!UUID.test(cursor)) {
        throw new LegacySourceError("invalid_request","the cursor is not a canonical uuid");
      }
      const { maxRecords,maxBytes }=bounds(limits);
      const q=QUERIES[table];
      // 1. Admit by ciphertext length before reading any ciphertext.
      const meta=cursor===null
        ? await s.tx.query(q.first,[s.collection,maxRecords+1],signal)
        :await s.tx.query(q.after,[s.collection,cursor,maxRecords+1],signal);
      signal.throwIfAborted();
      const admitted=admit(meta.map((m) => int(m.ct_len,"ciphertext length")),maxRecords,maxBytes,table==="records",s.maxRow);
      if(admitted.count===0) {
        s.files.clear();
        s.large.clear();
        return this.page(s,[],cursor,true);
      }
      const chosen=meta.slice(0,admitted.count);
      const done=chosen.length===meta.length;
      // 2. Read exactly the admitted rows, in the same order, and open each. A large row
      // holds the session's single large-row slot while its ciphertext is in memory.
      if(admitted.large) this.takeLarge(s);
      try {
        return await this.readPage(s,table,q.rows,chosen,done,admitted.large,signal);
      } finally {
        if(admitted.large) s.largeBusy=false;
      }
    });
  }

  /**
   * Re-hydrate a bounded set of source primary keys inside the SAME checkpoint.
   * The caller may use resolved placement paths, but reads must name original
   * resource paths or preserved record/file IDs. Ciphertext lengths are admitted
   * before ciphertext is read. Missing/duplicate keys are refused, not skipped.
   * Rows come in source primary-key order; `next` is the last admitted key when
   * byte bounds admit only a prefix. Re-request the remaining keys on the next
   * call. Stream opaque refs BEFORE another page/hydration call invalidates them.
   */
  async hydrateKeys(id: string,table: "resources",keys: string[],limits: PageLimits,signal: AbortSignal): Promise<Page<ResourceRow>>;
  async hydrateKeys(id: string,table: "records",keys: string[],limits: PageLimits,signal: AbortSignal): Promise<Page<RecordRow>>;
  async hydrateKeys(id: string,table: "files",keys: string[],limits: PageLimits,signal: AbortSignal): Promise<Page<FileRow>>;
  async hydrateKeys(id: string,table: Table,keys: string[],limits: PageLimits,signal: AbortSignal): Promise<Page<unknown>> {
    const { maxRecords,maxBytes }=bounds(limits);
    if(!["resources","records","files"].includes(table)||keys.length>maxRecords||new Set(keys).size!==keys.length
      ||keys.some((k) => typeof k!=="string"||(table!=="resources"&&!UUID.test(k)))
      ||keys.reduce((n,k) => n+utf8Length(k),0)>MAX_PAGE_DECODED) {
      throw new LegacySourceError("invalid_request","hydration keys exceed their count/byte bounds or are malformed");
    }
    return this.withPage(id,signal,async (s) => {
      if(!keys.length) {
        s.files.clear();
        s.large.clear();
        return this.page(s,[],null,true);
      }
      const q=QUERIES[table];
      const meta=await s.tx.query(q.keys,[s.collection,keys],signal);
      signal.throwIfAborted();
      if(meta.length!==keys.length||meta.some((m) => !keys.includes(text(m.k,"key")))) {
        throw new LegacySourceError("source_changed","a requested hydration key is missing in the checkpoint");
      }
      const admitted=admit(meta.map((m) => int(m.ct_len,"ciphertext length")),maxRecords,maxBytes,table==="records",s.maxRow);
      if(admitted.large) this.takeLarge(s);
      try {
        return await this.readPage(s,table,q.rows,meta.slice(0,admitted.count),admitted.count===meta.length,admitted.large,signal);
      } finally {
        if(admitted.large) s.largeBusy=false;
      }
    });
  }

  private async readPage(
    s: Session, table: Table, rowsSql: string, chosen: Row[], done: boolean, large: boolean, signal: AbortSignal,
  ): Promise<Page<unknown>> {
    // Opaque handles are page-scoped, not a collection-wide metadata cache.
    // An already-open stream has captured its immutable descriptor separately.
    s.files.clear();
    s.large.clear();
    const keys = chosen.map((m) => text(m.k, "key"));
    const full = await s.tx.query(rowsSql, [s.collection, keys], signal);
    signal.throwIfAborted();
    if (full.length !== keys.length) throw new LegacySourceError("source_changed", "admitted rows changed inside the checkpoint");
    const out: unknown[] = [];
    for (const [i, r] of full.entries()) {
      if (text(r.k, "key") !== keys[i] || int(r.ct_len, "ciphertext length") !== int(chosen[i].ct_len, "ciphertext length")) {
        throw new LegacySourceError("source_changed", "admitted rows changed inside the checkpoint");
      }
      out.push(await this.decode(s, table, r, large));
      signal.throwIfAborted();
    }
    return this.page(s, out, keys[keys.length - 1], done);
  }

  private async decode(s: Session, table: Table, r: Row, large: boolean): Promise<unknown> {
    const cid = s.collection;
    const key = s.key!;
    if (table === "resources") {
      const path = text(r.k, "path");
      const revision = text(r.revision, "revision");
      const document = await openEnvelope(key, bytes(r.ct, "document_ciphertext"), aad.resourceDocument(cid, path));
      if (revision.startsWith("sha256:") && (await revisionOf(document)) !== revision) {
        document.fill(0);
        throw new LegacyCryptoError("inconsistent", `resource revision does not match`);
      }
      return { path, kind: text(r.kind, "kind"), revision, document } satisfies ResourceRow;
    }
    if (table === "records") {
      const rid = text(r.k, "record_id");
      const sequence = int(r.sequence, "sequence");
      return this.recordRow(s, "current", rid, sequence, text(r.revision, "revision"), bytes(r.ct, "payload_ciphertext"),
        aad.currentRecord(cid, rid, sequence), large);
    }
    return this.fileRow(s, text(r.k, "file_id"), int(r.sequence, "sequence"), int(r.size, "size"),
      text(r.object_key, "object_key"), bytes(r.ct, "payload_ciphertext"), aad.currentFile(cid, text(r.k, "file_id"), int(r.sequence, "sequence")));
  }

  /** Open and check a record payload; a large one is returned by reference only. */
  private async recordRow(
    s: Session, source: LargeRef["source"], rid: string, sequence: number, revision: string,
    ct: Uint8Array, additionalData: Uint8Array, large: boolean,
  ): Promise<RecordRow> {
    const p = await openRecord(s.key!, ct, additionalData, rid, revision);
    const documentBytes = utf8Length(p.document);
    if (!large) return { recordId: rid, path: p.path, revision, sequence, documentBytes, document: p.document, contentRef: null };
    const contentRef = crypto.randomUUID();
    s.large.set(contentRef, { source, recordId: rid, sequence, ctLen: ct.length, revision });
    return { recordId: rid, path: p.path, revision, sequence, documentBytes, document: null, contentRef };
  }

  private async fileRow(
    s: Session, fid: string, sequence: number, size: number, objectKey: string, ct: Uint8Array, additionalData: Uint8Array,
  ): Promise<FileRow> {
    const p = decodeJson<FilePayload>(await openEnvelope(s.key!, ct, additionalData));
    if (typeof p.content_digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(p.content_digest)) {
      throw new LegacyCryptoError("inconsistent", `file ${fid}: content_digest is not sha256`);
    }
    const sourceRef = crypto.randomUUID();
    s.files.set(sourceRef, { objectKey, size, digest: p.content_digest });
    return {
      fileId: fid, path: p.path, contentDigest: p.content_digest, size, mediaType: p.media_type ?? null,
      mediaClass: p.media_class, sequence, sourceRef,
    };
  }

  /**
   * Changes after `afterSequence` (record, file and resource), in sequence order,
   * bounded like `nextPage`. Large record after-images come alone, by reference.
   */
  async nextChanges(id: string,afterSequence: number,limits: PageLimits,signal: AbortSignal): Promise<Page<ChangeRow>> {
    return this.withPage(id,signal,async (s) => {
      if(!Number.isSafeInteger(afterSequence)||afterSequence<0) {
        throw new LegacySourceError("invalid_request","the change cursor is not a sequence");
      }
      const { maxRecords,maxBytes }=bounds(limits);
      const n=maxRecords+1;
      const metas=[
        ...(await s.tx.query(
          `SELECT 'record' AS t, sequence, COALESCE(length(after_ciphertext), 0) AS ct_len FROM hosted_provider_changes
         WHERE collection_id = $1::uuid AND sequence > $2 ORDER BY sequence LIMIT $3`,[s.collection,afterSequence,n],signal)),
        ...(await s.tx.query(
          `SELECT 'file' AS t, sequence, COALESCE(length(after_ciphertext), 0) AS ct_len FROM hosted_provider_file_changes
         WHERE collection_id = $1::uuid AND sequence > $2 ORDER BY sequence LIMIT $3`,[s.collection,afterSequence,n],signal)),
        ...(await s.tx.query(
          `SELECT 'resource' AS t, sequence, 0 AS ct_len FROM hosted_provider_resource_changes
         WHERE collection_id = $1::uuid AND sequence > $2 ORDER BY sequence LIMIT $3`,[s.collection,afterSequence,n],signal)),
      ].map((m) => ({ t: text(m.t,"kind"),sequence: int(m.sequence,"sequence"),ctLen: int(m.ct_len,"ciphertext length") }))
        .sort((a,b) => a.sequence-b.sequence)
        .slice(0,n);
      signal.throwIfAborted();
      // A file change's after-image is metadata; only records may stream.
      const admitted=admit(metas.map((m) => m.ctLen),maxRecords,maxBytes,metas[0]?.t==="record",s.maxRow);
      if(admitted.count===0) {
        s.files.clear();
        s.large.clear();
        return this.page(s,[],String(afterSequence),true);
      }
      const chosen=metas.slice(0,admitted.count);
      const done=chosen.length===metas.length;
      if(admitted.large) this.takeLarge(s);
      try {
        return await this.readChanges(s,chosen,done,admitted.large,signal);
      } finally {
        if(admitted.large) s.largeBusy=false;
      }
    });
  }

  private async readChanges(
    s: Session, chosen: Array<{ t: string; sequence: number; ctLen: number }>, done: boolean, large: boolean, signal: AbortSignal,
  ): Promise<Page<ChangeRow>> {
    s.files.clear();
    s.large.clear();
    const seqs = (t: string) => chosen.filter((m) => m.t === t).map((m) => m.sequence);
    const byTable = async (t: string, sql: string) => {
      const want = seqs(t);
      if (!want.length) return new Map<number, Row>();
      const rows = await s.tx.query(sql, [s.collection, want], signal);
      signal.throwIfAborted();
      if (rows.length !== want.length) throw new LegacySourceError("source_changed", "admitted changes changed inside the checkpoint");
      return new Map(rows.map((r) => [int(r.sequence, "sequence"), r]));
    };
    const rec = await byTable("record",
      `SELECT sequence, record_id::text AS id, revision, after_ciphertext AS ct FROM hosted_provider_changes
       WHERE collection_id = $1::uuid AND sequence = ANY($2::bigint[]) ORDER BY sequence`);
    const fil = await byTable("file",
      `SELECT sequence, file_id::text AS id, after_size, after_object_key, after_ciphertext AS ct FROM hosted_provider_file_changes
       WHERE collection_id = $1::uuid AND sequence = ANY($2::bigint[]) ORDER BY sequence`);
    const res = await byTable("resource",
      `SELECT sequence, path, resource_kind FROM hosted_provider_resource_changes
       WHERE collection_id = $1::uuid AND sequence = ANY($2::bigint[]) ORDER BY sequence`);
    const out: ChangeRow[] = [];
    for (const m of chosen) {
      if (m.t === "record") {
        const r = rec.get(m.sequence)!;
        const rid = text(r.id, "record_id");
        const after = r.ct == null ? null : await this.recordRow(s, "change", rid, m.sequence, text(r.revision, "revision"),
          bytes(r.ct, "after_ciphertext"), aad.changeRecord(s.collection, m.sequence, "after"), large);
        out.push({ kind: "record", sequence: m.sequence, recordId: rid, after });
      } else if (m.t === "file") {
        const r = fil.get(m.sequence)!;
        const fid = text(r.id, "file_id");
        const after = r.ct == null ? null : await this.fileRow(s, fid, m.sequence, int(r.after_size, "after_size"),
          text(r.after_object_key, "after_object_key"), bytes(r.ct, "after_ciphertext"), aad.changeFile(s.collection, m.sequence, "after"));
        out.push({ kind: "file", sequence: m.sequence, fileId: fid, after });
      } else {
        const r = res.get(m.sequence)!;
        out.push({ kind: "resource", sequence: m.sequence, path: text(r.path, "path"),
          resourceKind: r.resource_kind == null ? null : text(r.resource_kind, "resource_kind") });
      }
      signal.throwIfAborted();
    }
    return this.page(s, out, String(chosen[chosen.length - 1].sequence), done);
  }

  /** Non-revoked replicas at the checkpoint (H8's revoke list). */
  async replicas(id: string, signal: AbortSignal): Promise<ReplicaRow[]> {
    const s = await this.live(id, signal);
    const rows = await s.tx.query(
      `SELECT id::text AS id, purpose FROM hosted_provider_replicas
       WHERE collection_id = $1::uuid AND revoked_at IS NULL ORDER BY id LIMIT $2`, [s.collection, MAX_REPLICAS + 1], signal);
    signal.throwIfAborted();
    if (rows.length > MAX_REPLICAS) throw new LegacySourceError("too_many_replicas", "more replicas than the source bound");
    return rows.map((r) => ({ id: text(r.id, "id"), purpose: text(r.purpose, "purpose") }));
  }

  /**
   * Terminal mutation-journal facts (or their tombstones) of this collection's
   * replicas, keyset-paged by `replica/request`. Facts are metadata: the receipt
   * digest, never the receipt.
   */
  async nextFacts(id: string, table: FactTable, cursor: string | null, limits: PageLimits, signal: AbortSignal): Promise<Page<JournalFact>> {
    const s = await this.live(id, signal);
    const c = cursor === null ? null : FACT_CURSOR.exec(cursor);
    if (cursor !== null && (!c || !UUID.test(c[1]) || !UUID.test(c[2]))) {
      throw new LegacySourceError("invalid_request", "the fact cursor is not replica/request");
    }
    const { maxRecords } = bounds(limits);
    const [from, state, acked] = table === "journal"
      ? ["hosted_provider_mutation_journal", "j.state", "j.acknowledged_at"]
      : ["hosted_provider_mutation_tombstones", "j.terminal_state", "NULL::timestamptz"];
    const where = table === "journal" ? "AND j.state IN ('completed', 'acknowledged', 'outcome_unknown', 'abandoned')" : "";
    const rows = await s.tx.query(
      `SELECT j.replica_id::text AS replica_id, j.request_id::text AS request_id, ${state} AS state,
              j.receipt_digest AS digest, j.completed_at, ${acked} AS acknowledged_at
       FROM ${from} j JOIN hosted_provider_replicas r ON r.id = j.replica_id
       WHERE r.collection_id = $1::uuid ${where}
         AND ($2::uuid IS NULL OR (j.replica_id, j.request_id) > ($2::uuid, $3::uuid))
       ORDER BY j.replica_id, j.request_id LIMIT $4`,
      [s.collection, c?.[1] ?? null, c?.[2] ?? null, maxRecords + 1], signal);
    signal.throwIfAborted();
    const page = rows.slice(0, maxRecords).map((r) => ({
      replicaId: text(r.replica_id, "replica_id"), requestId: text(r.request_id, "request_id"),
      state: text(r.state, "state") as JournalFact["state"], receiptDigest: hex(bytes(r.digest, "receipt_digest")),
      completedAt: iso(r.completed_at, "completed_at"),
      acknowledgedAt: r.acknowledged_at == null ? null : iso(r.acknowledged_at, "acknowledged_at"),
    }));
    const last = page[page.length - 1];
    return this.page(s, page, last ? `${last.replicaId}/${last.requestId}` : cursor, rows.length <= maxRecords);
  }

  /**
   * One large record's document bytes (a `contentRef` from a page), re-read in the
   * same checkpoint at its admitted length, opened and verified before the first
   * byte is enqueued. Per-row memory is bounded by the collection's `rowBound`.
   */
  async streamRecord(id: string, contentRef: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const s = await this.live(id, signal);
    const ref = s.large.get(contentRef);
    if (!ref) throw new LegacySourceError("unknown_ref", "no such record in this checkpoint");
    // The single large-row slot, held until the stream ends, errors or is cancelled.
    this.takeLarge(s);
    try {
      return await this.openLargeStream(s, ref, signal);
    } catch (e) {
      s.largeBusy = false;
      throw e;
    }
  }

  private async openLargeStream(s: Session,ref: LargeRef,signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const abort=this.reserveStream(s);
    const linked=AbortSignal.any([signal,abort.signal]);
    try {
      const [r]=ref.source==="current"
        ? await s.tx.query(
          `SELECT payload_ciphertext AS ct FROM hosted_provider_records
         WHERE collection_id = $1::uuid AND record_id = $2::uuid AND sequence = $3 AND length(payload_ciphertext) = $4`,
          [s.collection,ref.recordId,ref.sequence,ref.ctLen],linked)
        :await s.tx.query(
          `SELECT after_ciphertext AS ct FROM hosted_provider_changes
         WHERE collection_id = $1::uuid AND sequence = $2 AND record_id = $3::uuid AND length(after_ciphertext) = $4`,
          [s.collection,ref.sequence,ref.recordId,ref.ctLen],linked);
      linked.throwIfAborted();
      if(!r) throw new LegacySourceError("source_changed","the record changed inside the checkpoint");
      const additionalData=ref.source==="current"
        ? aad.currentRecord(s.collection,ref.recordId,ref.sequence)
        :aad.changeRecord(s.collection,ref.sequence,"after");
      const p=await openRecord(s.key!,bytes(r.ct,"ciphertext"),additionalData,ref.recordId,ref.revision);
      linked.throwIfAborted();
      let doc: Uint8Array|null=new TextEncoder().encode(p.document);
      let at=0;
      const finish=() => {
        s.streams.delete(abort);
        linked.removeEventListener("abort",finish);
        doc?.fill(0);
        doc=null;
        s.largeBusy=false;
      };
      linked.addEventListener("abort",finish,{ once: true });
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          try {
            linked.throwIfAborted();
            if(!doc||at>=doc.length) {
              finish();
              controller.close();
              return;
            }
            controller.enqueue(doc.slice(at,at+STREAM_CHUNK));
            at+=STREAM_CHUNK;
          } catch(e) {
            finish();
            controller.error(e);
          }
        },
        cancel() {
          finish();
        },
      },{ highWaterMark: 1 });
    } catch(e) {
      s.streams.delete(abort);
      throw e;
    }
  }

  /** One file's bytes, verified incrementally; errors (never ends cleanly) on any mismatch. */
  async streamContent(id: string, sourceRef: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const s = await this.live(id, signal);
    const f = s.files.get(sourceRef);
    if (!f) throw new LegacySourceError("unknown_ref", "no such file in this checkpoint");
    const abort = this.reserveStream(s);
    const linked = AbortSignal.any([signal, abort.signal]);
    let obj: Awaited<ReturnType<LegacyObjects["get"]>> = null;
    try {
      obj = await this.config.objects.get(f.objectKey, linked);
      linked.throwIfAborted();
      if (!obj) throw new LegacySourceError("object_missing", "the file's R2 object is missing");
      if (obj.size !== f.size) throw new LegacySourceError("object_mismatch", "the R2 object size differs from its row");
    } catch (e) {
      s.streams.delete(abort);
      if (obj) await obj.body.cancel(e);
      throw e;
    }
    const reader = obj.body.getReader();
    const h = sha256.create();
    let seen = 0;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      s.streams.delete(abort);
      linked.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      finish();
      // Cancel the upstream pending read. The next pull checks the abort before
      // publishing anything; cancellation rejection is deliberately consumed.
      void reader.cancel(linked.reason).catch(() => {});
    };
    linked.addEventListener("abort", onAbort, { once: true });
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          linked.throwIfAborted();
          const next = await reader.read();
          linked.throwIfAborted();
          if (next.done) {
            if (seen !== f.size || `sha256:${hex(h.digest())}` !== f.digest) {
              throw new LegacySourceError("object_mismatch", "the R2 object does not match its digest or size");
            }
            finish();
            controller.close();
          } else {
            seen += next.value.byteLength;
            if (seen > f.size) throw new LegacySourceError("object_mismatch", "the R2 object is longer than its row");
            h.update(next.value);
            controller.enqueue(next.value);
          }
        } catch (e) {
          finish();
          await reader.cancel(e).catch(() => {});
          controller.error(e);
        }
      },
      async cancel(reason) {
        finish();
        await reader.cancel(reason);
      },
    }, { highWaterMark: 1 });
  }

  /** Open stream controllers (diagnostics and tests). */
  openStreams(id: string): number {
    return this.sessions.get(id)?.streams.size ?? 0;
  }

  /** Roll back, drop the key, abort streams. Idempotent. */
  async close(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s || s.closed) return;
    s.closed = true;
    s.key = null;
    s.files.clear();
    s.large.clear();
    for (const a of s.streams) a.abort(new LegacySourceError("closed", "the checkpoint was closed"));
    s.streams.clear();
    this.sessions.delete(id);
    await s.tx.close();
  }
}

function bounds(limits: PageLimits) {
  return {
    maxRecords: Math.min(Math.max(1, Math.floor(limits.maxRecords)), MAX_RECORDS),
    maxBytes: Math.min(Math.max(1, Math.floor(limits.maxDecodedBytes)), MAX_PAGE_DECODED),
  };
}

/**
 * Admit rows in order by ciphertext length. Rows fitting the page bound share a
 * page; a row over it comes alone and by reference (only where `streamable`), up
 * to the collection's `rowBound`. Anything else stops explicitly, never skipped.
 */
function admit(lens: number[], maxRecords: number, maxBytes: number, streamable: boolean, maxRow: number): { count: number; large: boolean } {
  let count = 0;
  let total = 0;
  for (const len of lens.slice(0, maxRecords)) {
    const decoded = Math.max(0, len - ENVELOPE);
    if (len > maxRow || decoded > maxBytes) {
      if (count) break;
      if (len <= maxRow && streamable) return { count: 1, large: true };
      throw new LegacySourceError("row_too_large",
        len > maxRow
          ? "a row exceeds the collection's per-row bound (its document quota, escaped, plus framing); see inventory"
          : "a row exceeds the page byte bound and cannot be streamed");
    }
    if (total + decoded > maxBytes && count) break;
    total += decoded;
    count++;
  }
  return { count, large: false };
}

async function openRecord(key: CryptoKey, ct: Uint8Array, additionalData: Uint8Array, rid: string, revision: string): Promise<RecordPayload> {
  const p = decodeJson<RecordPayload>(await openEnvelope(key, ct, additionalData));
  if (p.record_id !== rid) throw new LegacyCryptoError("inconsistent", "record_id differs from its row");
  if (p.revision !== revision || (await revisionOf(new TextEncoder().encode(p.document))) !== p.revision) {
    throw new LegacyCryptoError("inconsistent", `record ${rid}: revision does not match its document`);
  }
  return p;
}

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/**
 * Refuse a role that could write: a superuser, or any write privilege on a
 * provider table visible in the search path (native `verify_select_only`).
 */
async function verifySelectOnly(tx: ReadOnlyTx, signal: AbortSignal): Promise<void> {
  const [r] = await tx.query(
    `SELECT r.rolsuper AS superuser,
            (SELECT count(*) FROM pg_tables t
              WHERE t.tablename LIKE 'hosted\\_provider\\_%'
                AND t.schemaname = ANY (current_schemas(false))) AS tables,
            (SELECT count(*) FROM pg_tables t
              WHERE t.tablename LIKE 'hosted\\_provider\\_%'
                AND t.schemaname = ANY (current_schemas(false))
                AND has_table_privilege(current_user,
                      quote_ident(t.schemaname) || '.' || quote_ident(t.tablename),
                      'INSERT,UPDATE,DELETE,TRUNCATE')) AS writable
     FROM pg_roles r WHERE r.rolname = current_user`, [], signal);
  signal.throwIfAborted();
  if (!r || r.superuser !== false || int(r.writable, "writable") > 0) {
    throw new LegacySourceError("writable_role", "the database role can write; use the SELECT-only reader role");
  }
  if (int(r.tables, "tables") === 0) throw new LegacySourceError("no_tables", "no provider tables visible to this role");
}

/**
 * Keyset queries on the primary keys (`uuid` order, which canonical lowercase text
 * cursors share): `first`/`after` admit by ciphertext length (no ciphertext read),
 * `rows` reads exactly the admitted keys in key order, with their length again.
 */
const QUERIES: Record<Table, { first: string; after: string; keys: string; rows: string }> = {
  resources: {
    first: `SELECT path AS k, length(document_ciphertext) AS ct_len FROM hosted_provider_resources
            WHERE collection_id = $1::uuid ORDER BY path LIMIT $2`,
    after: `SELECT path AS k, length(document_ciphertext) AS ct_len FROM hosted_provider_resources
            WHERE collection_id = $1::uuid AND path > $2 ORDER BY path LIMIT $3`,
    keys: `SELECT path AS k, length(document_ciphertext) AS ct_len FROM hosted_provider_resources
           WHERE collection_id = $1::uuid AND path = ANY($2::text[]) ORDER BY path`,
    rows: `SELECT path AS k, kind, revision, length(document_ciphertext) AS ct_len, document_ciphertext AS ct
           FROM hosted_provider_resources WHERE collection_id = $1::uuid AND path = ANY($2::text[]) ORDER BY path`,
  },
  records: {
    first: `SELECT record_id::text AS k, length(payload_ciphertext) AS ct_len FROM hosted_provider_records
            WHERE collection_id = $1::uuid ORDER BY record_id LIMIT $2`,
    after: `SELECT record_id::text AS k, length(payload_ciphertext) AS ct_len FROM hosted_provider_records
            WHERE collection_id = $1::uuid AND record_id > $2::uuid ORDER BY record_id LIMIT $3`,
    keys: `SELECT record_id::text AS k, length(payload_ciphertext) AS ct_len FROM hosted_provider_records
           WHERE collection_id = $1::uuid AND record_id = ANY($2::uuid[]) ORDER BY record_id`,
    rows: `SELECT record_id::text AS k, revision, sequence, length(payload_ciphertext) AS ct_len, payload_ciphertext AS ct
           FROM hosted_provider_records WHERE collection_id = $1::uuid AND record_id = ANY($2::uuid[]) ORDER BY record_id`,
  },
  files: {
    first: `SELECT file_id::text AS k, length(payload_ciphertext) AS ct_len FROM hosted_provider_files
            WHERE collection_id = $1::uuid ORDER BY file_id LIMIT $2`,
    after: `SELECT file_id::text AS k, length(payload_ciphertext) AS ct_len FROM hosted_provider_files
            WHERE collection_id = $1::uuid AND file_id > $2::uuid ORDER BY file_id LIMIT $3`,
    keys: `SELECT file_id::text AS k, length(payload_ciphertext) AS ct_len FROM hosted_provider_files
           WHERE collection_id = $1::uuid AND file_id = ANY($2::uuid[]) ORDER BY file_id`,
    rows: `SELECT file_id::text AS k, sequence, size, object_key, length(payload_ciphertext) AS ct_len, payload_ciphertext AS ct
           FROM hosted_provider_files WHERE collection_id = $1::uuid AND file_id = ANY($2::uuid[]) ORDER BY file_id`,
  },
};
