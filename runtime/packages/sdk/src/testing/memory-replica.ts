/**
 * `MemoryReplica`: an in-memory stand-in for a replica that speaks the real client
 * protocol (frames, hello, pushes, receipts). For SDK tests, app tests and demo modes.
 *
 * It is **not** the replica: no planner, merge or lifecycle. Its semantics are
 * deliberately simple:
 * - patches apply blindly, and bodies are replaced or edited;
 * - `where` is evaluated by an optional callback;
 * - mutations stay `pending` until confirmed, either after `confirmDelayMs` or by
 *   calling {@link MemoryReplica.confirmAll}.
 *
 * The real runtime replaces it behind the same `Connector`.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import type { CborValue } from "../cbor.js";
import { decode, encode, Float64 } from "../cbor.js";
import { hash as hashCodec, hashFromBytes, list, uuid as uuidCodec } from "../codec.js";
import { ERROR_CODES, ErrorCode, isMdbaseError, mdbaseError, MdbaseError } from "../errors.js";
import { Connector, FramePort, portPair } from "../transport/port.js";
import { revisionOf, toPlain, toValue, uuidv7, type PlainValue } from "../values.js";
import * as w from "../wire.js";
import { accountKeyStatus, type AccountKeyStatus } from "../private.js";
import { contractRecordWire, contractWritePlan } from "../contract-records.js";
import { contractQueryResult } from "../contract-query.js";
import {
  contractDigest, contractFields, implementationDigest, implementationFor, mapWrite, type MemoryContract,
} from "./memory-contracts.js";

type M = Map<number, CborValue>;

export interface MemoryRecord {
  id: w.Uuid;
  path: string;
  types: string[];
  frontmatter: w.FmMap;
  body: string;
  confirmedSeq: number;
  pending: boolean;
  hold?: w.HoldRef;
  unresolved?: number;
}

/** A saved view served to app Bases reads: rows are the records of `types`,
 * cells the named columns (`file.path`, `file.name` or a frontmatter field).
 * No filters, sorting, grouping or formulas. */
export interface MemoryBaseView {
  path: string;
  types: string[];
  columns: string[];
  name?: string;
}

export interface MemoryReplicaOptions {
  collection?: w.Uuid;
  /** Delay before pending mutations confirm; `null` = only on `confirmAll()`. */
  confirmDelayMs?: number | null;
  /** Evaluate a query's `where` against a record (plain frontmatter + `file`). */
  where?: (expr: string, record: MemoryRecord) => boolean;
  role?: w.Role;
  capabilities?: string[];
  grant?: w.Uuid;
  /** The grant's file folder scope (absent: the whole file namespace). */
  fileFolders?: string[];
  /** Answer hello with this problem instead (auth tests). */
  refuse?: w.Problem;
  runtimeVersion?: string;
  /** Core's temporal hint for a top-level field under a query's exact type list (default: `none`). */
  typing?: (types: string[], path: string) => w.TemporalHint;
  /** Serve contract-scoped records through these declared implementations (a
   * subset of Core's mapping; no schema validation). Absent: contract methods
   * are unknown, as on an older replica. */
  contracts?: MemoryContract[];
}

interface Sub {
  id: number;
  query: Map<string, CborValue>;
  include: w.Include | undefined;
  last: Map<w.Uuid, string>; // id → revision
  order: w.Uuid[];
}

interface Conn {
  port: FramePort;
  subs: Map<number, Sub>;
  status: boolean;
  holds: boolean;
  conflicts: boolean;
  changesWatch: boolean;
  presence: Set<w.Uuid>;
  joined: Map<w.Uuid, CborValue>;
  pseudonym: Uint8Array;
  mutations: Set<w.Uuid>;
  streams: Map<number, { data: Uint8Array; offset: number; acked: number }>;
}

interface MemFile {
  id: w.Uuid;
  path: string;
  bytes: Uint8Array;
  confirmedSeq: number;
  pending: boolean;
}

function problem(code: ErrorCode, message: string, reason?: string): w.Problem {
  const p: w.Problem = { code, recovery: ERROR_CODES[code], message };
  if (reason) p.reason = reason;
  return p;
}

function renderDocument(r: MemoryRecord): string {
  const lines = [...r.frontmatter].map(([k, v]) => `${k}: ${JSON.stringify(toPlain(v))}`);
  return lines.length ? `---\n${lines.join("\n")}\n---\n${r.body}` : r.body;
}

/** Synthetic frontmatter subset shared by document creates and replacements.
 * Not Core's YAML/type/contract parser. */
function parseDocument(doc: string): { frontmatter: w.FmMap; body: string } {
  const mm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(doc);
  const frontmatter = new Map<string, CborValue>();
  for (const line of (mm?.[1] ?? "").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) {
      const raw = line.slice(i + 1).trim();
      let v: CborValue = raw;
      try {
        v = JSON.parse(raw) as CborValue;
      } catch {
        // keep as text
      }
      frontmatter.set(line.slice(0, i).trim(), v);
    }
  }
  return { frontmatter, body: mm ? mm[2]! : doc };
}

function revision(r: MemoryRecord): string {
  return hashFromBytes(sha256(new TextEncoder().encode(renderDocument(r))));
}

function mediaOf(path: string): w.MediaClass {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"].includes(ext)) return "image";
  if (["mp3", "wav", "ogg", "m4a", "flac"].includes(ext)) return "audio";
  if (["mp4", "webm", "mov", "mkv"].includes(ext)) return "video";
  if (ext === "pdf") return "pdf";
  return "other";
}

/** A few of Core's `paths::media_type` entries, enough for SDK tests. */
const MEDIA_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", pdf: "application/pdf", txt: "text/plain" };
function mediaTypeOf(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot < 0 ? undefined : MEDIA_TYPES[name.slice(dot + 1).toLowerCase()];
}

function applyScalarEdits(base: string, edits: w.BodyEdit[]): string {
  const chars = Array.from(base);
  // Apply from the end so earlier offsets stay valid.
  for (const [start, end, insert] of [...edits].sort((a, b) => b[0] - a[0])) {
    chars.splice(start, end - start, ...Array.from(insert));
  }
  return chars.join("");
}

export class MemoryReplica {
  readonly collection: w.Uuid;
  private records = new Map<w.Uuid, MemoryRecord>();
  private files = new Map<w.Uuid, MemFile>();
  private uploads = new Map<w.Uuid, { params: w.OpenUploadParams; fileId: w.Uuid; chunks: Map<number, Uint8Array> }>();
  private receipts = new Map<w.Uuid, w.Receipt>();
  private pendingQueue: w.Uuid[] = [];
  private pendingRecords = new Map<w.Uuid, w.Uuid[]>();
  private conns = new Set<Conn>();
  private seq = 0;
  private viewVersion = 0;
  private changeLog: w.Change[] = [];
  private nextSub = 1;
  private nextStream = 1;
  private online = true;
  private awaiters = new Map<w.Uuid, (() => void)[]>();
  /** AK1 §6 stand-in: the secret `account_key_setup` enrolled, and this device's unlock state. */
  private accountKeySecret: Uint8Array | null = null;
  private accountKey: AccountKeyStatus = { state: "idle" };
  private stalled = false;
  private loseNext = false;
  private failWrite: w.Problem | null = null;
  private holdList = new Map<w.Uuid, { hold: w.Hold; record: w.Uuid }>();
  private conflictList: w.ConflictEntry[] = [];
  private baseViews = new Map<w.Uuid, MemoryBaseView[]>();
  /** Test hook: answer `describe_typing` with this instead (for mismatch tests). */
  typingAnswer?: (types: string[], paths: string[]) => w.DescribeTypingResult;

  constructor(private opts: MemoryReplicaOptions = {}) {
    this.collection = opts.collection ?? uuidv7();
  }

  // ---------------------------------------------------------------- test controls

  /** A connector for `MdbaseClient.connect`. Each `open` is a new session. */
  connector(): Connector {
    return {
      description: "memory",
      open: async (hello) => {
        const [client, server] = portPair();
        const conn: Conn = {
          port: server,
          subs: new Map(),
          status: false,
          holds: false,
          conflicts: false,
          changesWatch: false,
          presence: new Set(),
          joined: new Map(),
          pseudonym: globalThis.crypto.getRandomValues(new Uint8Array(16)),
          mutations: new Set(),
          streams: new Map(),
        };
        const helloResponse = this.hello(hello);
        if (this.opts.refuse) {
          queueMicrotask(() => server.close());
          return { port: client, helloResponse };
        }
        this.conns.add(conn);
        Object.assign(client, {
          readAppBases: async (bytes: Uint8Array) => this.basesRead(bytes),
          readAppBasesDiscovery: async (op: "list-views" | "read-view-source", bytes: Uint8Array) => this.basesDiscovery(op, bytes),
        });
        server.onframe = (f) => void this.onFrame(conn, f);
        server.onclose = () => this.drop(conn);
        return { port: client, helloResponse };
      },
    };
  }

  /** Drop every session (simulates a broken link; clients reconnect). */
  dropConnections(): void {
    for (const c of [...this.conns]) c.port.close();
  }

  /** Simulate the log service being unreachable: submits stay pending. */
  setOnline(online: boolean): void {
    this.online = online;
    this.pushStatus();
    if (online && this.opts.confirmDelayMs !== null) this.scheduleConfirm();
  }

  /** Seed a confirmed record directly. */
  seed(r: { id?: w.Uuid; path: string; types?: string[]; frontmatter?: Record<string, CborValue>; body?: string }): MemoryRecord {
    const rec: MemoryRecord = {
      id: r.id ?? uuidv7(),
      path: r.path,
      types: r.types ?? [],
      frontmatter: new Map(Object.entries(r.frontmatter ?? {})),
      body: r.body ?? "",
      confirmedSeq: ++this.seq,
      pending: false,
    };
    this.records.set(rec.id, rec);
    this.touch(rec.id, rec.path, "put");
    return rec;
  }

  /** Confirm every pending mutation now. */
  confirmAll(): void {
    while (this.pendingQueue.length) this.confirmNext();
  }

  // ------------------------------------------------------------ faults (R6)

  /** Another device edits a record; the change arrives confirmed. A `null`
   * frontmatter value removes the field. */
  editElsewhere(ref: string, change: { body?: string; frontmatter?: Record<string, CborValue | null> }): void {
    const r = this.rec(ref);
    if (change.body !== undefined) r.body = change.body;
    for (const [k, v] of Object.entries(change.frontmatter ?? {})) {
      if (v === null) r.frontmatter.delete(k);
      else r.frontmatter.set(k, v);
    }
    r.confirmedSeq = ++this.seq;
    this.touch(r.id, r.path, "put");
    this.pushStatus();
  }

  /** Another device renames (moves) a record. */
  renameElsewhere(ref: string, to: string): void {
    const r = this.rec(ref), from = r.path;
    r.path = to;
    r.confirmedSeq = ++this.seq;
    this.touch(r.id, from, "remove");
    this.touch(r.id, to, "put");
    this.pushStatus();
  }

  /** Another device deletes a record. */
  deleteElsewhere(ref: string): void {
    const r = this.rec(ref);
    this.records.delete(r.id);
    ++this.seq;
    this.touch(r.id, r.path, "remove", "record", r.types);
    this.pushStatus();
  }

  /** The next request runs but its response is lost and the session drops,
   * as when a link breaks after a write was captured. Clients reconnect, and
   * a resubmitted write (same mutation ID) gets its original receipt. */
  loseNextResponse(): void {
    this.loseNext = true;
  }

  /** The next submit fails with `p` and captures nothing. */
  failNextWrite(p: w.Problem = problem("unavailable", "the replica could not take the write", "storage_busy")): void {
    this.failWrite = p;
  }

  /** Stuck pending: while stalled, writes are not confirmed on their own even
   * though the replica is online (`confirmAll` still confirms). */
  stallConfirmations(stalled = true): void {
    this.stalled = stalled;
    if (!stalled) this.scheduleConfirm();
  }

  /** Put a hold on a record (as the replica does on a conflicting or suspect
   * write). Resolve it with `client.resolveHold`. */
  hold(ref: string, o: { reason?: w.HoldReason; mine?: string; theirs?: string } = {}): w.Uuid {
    const r = this.rec(ref), id = uuidv7(), reason = o.reason ?? "conflict";
    r.hold = { id, reason };
    this.holdList.set(id, {
      record: r.id,
      hold: { id, path: r.path, reason, since: Date.now(), mine: o.mine ?? r.body, ...(o.theirs !== undefined ? { theirs: o.theirs } : {}), saves: 0 },
    });
    this.touch(r.id, r.path, "put");
    this.pushHolds();
    this.pushStatus();
    return id;
  }

  /** Record a merged field conflict on a record (the kept value is applied). */
  conflict(ref: string, o: { field: string; kept: PlainValue; lost: PlainValue }): w.ConflictEntry {
    const r = this.rec(ref);
    r.frontmatter.set(o.field, toValue(o.kept));
    r.confirmedSeq = ++this.seq;
    r.unresolved = (r.unresolved ?? 0) + 1;
    const entry: w.ConflictEntry = {
      mutation: uuidv7(),
      seq: this.seq,
      conflict: { kind: "field", id: r.id, field: o.field, kept: { form: "value", value: toValue(o.kept) }, lost: { form: "value", value: toValue(o.lost) } },
    };
    this.conflictList.push(entry);
    this.touch(r.id, r.path, "put");
    this.pushConflicts();
    this.pushStatus();
    return entry;
  }

  /** Declare a type, so `describe` lists it with this definition and schema. */
  seedType(name: string, definition: Record<string, PlainValue> = {}): string {
    const fm: Record<string, PlainValue> = { kind: "mdbase.type", name, ...definition };
    const path = `_types/${name}.md`;
    this.seedResource(path, `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n`);
    return path;
  }

  /** Add a saved view for app Bases reads (another view in the same file when
   * the path exists). Returns its identity for `executeAppBases`. */
  seedBaseView(view: MemoryBaseView): { record: w.Uuid; sourceRevision: string; ordinal: number } {
    if (!view.types.length) throw new Error("MemoryReplica: a Bases view needs a type");
    let r = [...this.records.values()].find((x) => x.path === view.path);
    if (!r) r = this.seed({ path: view.path });
    const views = [...(this.baseViews.get(r.id) ?? []), view];
    this.baseViews.set(r.id, views);
    r.body = views.map((v) => `- name: ${JSON.stringify(v.name ?? null)}\n  types: ${JSON.stringify(v.types)}\n  columns: ${JSON.stringify(v.columns)}`).join("\n") + "\n";
    r.confirmedSeq = ++this.seq;
    this.touch(r.id, r.path, "put");
    return { record: r.id, sourceRevision: revisionOf(r.body), ordinal: views.length - 1 };
  }

  private rec(ref: string): MemoryRecord {
    const r = this.records.get(ref) ?? [...this.records.values()].find((x) => x.path === ref);
    if (!r) throw new Error(`MemoryReplica: no record ${ref}`);
    return r;
  }

  private pushHolds(): void {
    const payload = list(w.hold).enc([...this.holdList.values()].map((h) => h.hold));
    for (const c of this.conns) if (c.holds) this.push(c, "holds", payload);
  }

  private pushConflicts(): void {
    const payload = list(w.conflictEntry).enc(this.conflictList);
    for (const c of this.conns) if (c.conflicts) this.push(c, "conflicts", payload);
  }

  // ------------------------------------------------------------ app Bases (subset)

  private basesClock(): CborValue {
    const now = new Date();
    return w.opClock.enc({ instant: now.getTime(), tz: "UTC", localDate: now.toISOString().slice(0, 10) });
  }

  private basesRevision(): CborValue {
    return hashCodec.enc(hashFromBytes(sha256(new TextEncoder().encode(`memory-${this.viewVersion}`))));
  }

  private basesDescriptor(r: MemoryRecord, ordinal: number): CborValue {
    const v = this.baseViews.get(r.id)![ordinal]!;
    const digest = (s: string) => hashCodec.enc(hashFromBytes(sha256(new TextEncoder().encode(s))));
    return new Map<number, CborValue>([
      [0, uuidCodec.enc(r.id)], [1, r.path], [2, hashCodec.enc(revisionOf(r.body))], [3, ordinal],
      [4, v.name ?? null], [5, "table"],
      [6, v.types.map((t) => new Map<number, CborValue>([[0, t], [1, "1"], [2, digest(`contract:${t}`)], [3, digest(`implementation:${t}`)]]))],
    ]);
  }

  private basesRefusal(p: w.Problem): Uint8Array {
    return encode(new Map<number, CborValue>([[0, 1], [7, w.problem.enc(p)]]));
  }

  private basesView(record: CborValue, revisionWire: CborValue, ordinal: CborValue): { r: MemoryRecord; ordinal: number } | w.Problem {
    const id = uuidCodec.dec(record), r = this.records.get(id), views = this.baseViews.get(id);
    if (!r || !views || typeof ordinal !== "number" || !views[ordinal]) return problem("not_found", "no such view", "view_not_found");
    if (hashCodec.dec(revisionWire) !== revisionOf(r.body)) return problem("conflict", "the view changed", "view_source_changed");
    return { r, ordinal };
  }

  private basesRead(bytes: Uint8Array): Uint8Array {
    const m = decode(bytes) as Map<number, CborValue>;
    const found = this.basesView(m.get(0)!, m.get(1)!, m.get(2)!);
    if (!("r" in found)) return this.basesRefusal(found);
    const view = this.baseViews.get(found.r.id)![found.ordinal]!;
    const cell = (v: unknown): CborValue =>
      v === null || v === undefined ? [0] : typeof v === "boolean" ? [1, v] : typeof v === "number" ? [2, new Float64(v)]
        : typeof v === "string" ? [3, v] : Array.isArray(v) ? [6, v.map(cell)] : [3, JSON.stringify(v)];
    const value = (r: MemoryRecord, column: string): unknown =>
      column === "file.path" ? r.path : column === "file.name" ? r.path.slice(r.path.lastIndexOf("/") + 1)
        : toPlain(r.frontmatter.get(column.replace(/^(note|fm)\./, "")) ?? null);
    const all = this.evalQuery(new Map([["types", view.types]]))
      .map((r) => [uuidCodec.enc(r.id), r.path, hashCodec.enc(revision(r)), view.columns.map((c) => cell(value(r, c)))] as CborValue);
    const win = m.get(6) as Map<number, number> | undefined;
    const offset = win?.get(0) ?? 0, rows = win ? all.slice(offset, offset + win.get(1)!) : all;
    const out = new Map<number, CborValue>([
      [0, 1], [1, this.basesDescriptor(found.r, found.ordinal)], [2, new Map<number, CborValue>([[0, view.columns], [1, []]])],
      [3, rows], [4, []], [5, this.basesClock()], [6, this.basesRevision()],
    ]);
    if (win) out.set(8, new Map<number, CborValue>([[0, offset], [1, win.get(1)!], [2, all.length], [3, []]]));
    return encode(out);
  }

  private basesDiscovery(op: "list-views" | "read-view-source", bytes: Uint8Array): Uint8Array {
    const m = decode(bytes) as Map<number, CborValue>;
    if (op === "read-view-source") {
      const found = this.basesView(m.get(1)!, m.get(2)!, m.get(3)!);
      if (!("r" in found)) return this.basesRefusal(found);
      return encode(new Map<number, CborValue>([
        [0, 1], [1, this.basesDescriptor(found.r, found.ordinal)], [2, found.r.body], [3, this.basesClock()], [4, this.basesRevision()],
      ]));
    }
    const limit = m.get(2) as number, handle = m.get(3);
    const start = handle instanceof Uint8Array ? new DataView(handle.buffer, handle.byteOffset).getUint32(0) : 0;
    const all = [...this.baseViews.keys()].filter((id) => this.records.has(id)).sort()
      .flatMap((id) => this.baseViews.get(id)!.map((_, i) => this.basesDescriptor(this.records.get(id)!, i)));
    const next = start + limit < all.length ? new Uint8Array(32) : null;
    if (next) new DataView(next.buffer).setUint32(0, start + limit);
    return encode(new Map<number, CborValue>([
      [0, 1], [1, all.slice(start, start + limit)], [2, this.basesClock()], [3, this.basesRevision()], [4, next],
    ]));
  }

  /** Reject a pending mutation (as a failed check at head would). */
  reject(mutation: w.Uuid, p: w.Problem = problem("conflict", "rejected at head", "revision")): void {
    const r = this.receipts.get(mutation);
    if (!r || r.state !== "pending") return;
    this.pendingQueue = this.pendingQueue.filter((m) => m !== mutation);
    // Roll the local view back: the rejected mutation's effects disappear (§6).
    for (const [id, before] of this.priors.get(mutation) ?? []) {
      const cur = this.records.get(id);
      if (before) this.records.set(id, before);
      else this.records.delete(id);
      if (cur && (!before || cur.path !== before.path)) this.touch(id, cur.path, "remove");
      if (before) this.touch(id, before.path, "put");
    }
    this.priors.delete(mutation);
    this.settle({ mutation, state: "rejected", problem: p });
  }

  get allRecords(): MemoryRecord[] {
    return [...this.records.values()];
  }

  get sessionCount(): number {
    return this.conns.size;
  }

  // ---------------------------------------------------------------- protocol

  private hello(frame: CborValue): CborValue {
    const f = w.clientFrame.dec(frame);
    if (f.kind !== "request" || f.method !== "hello") throw new Error("expected hello");
    if (this.opts.refuse) return w.clientFrame.enc({ kind: "response", id: f.id, problem: this.opts.refuse });
    const p = w.helloParams.dec(f.params);
    const minor = Math.max(-1, ...p.versions.filter((v) => v.major === 1 && v.minor <= 2).map((v) => v.minor));
    if (minor < 0) {
      return w.clientFrame.enc({
        kind: "response",
        id: f.id,
        problem: problem("upgrade_required", "no common API version"),
      });
    }
    const grant: w.GrantInfo = {
      capabilities: this.opts.capabilities ?? [
        "collection.read",
        "records.create",
        "records.edit",
        "records.delete",
        "definitions.manage",
      ],
      role: this.opts.role ?? "owner",
    };
    if (this.opts.grant) grant.grant = this.opts.grant;
    if (this.opts.fileFolders) grant.fileFolders = [...this.opts.fileFolders];
    const result: w.HelloResult = {
      version: { major: 1, minor },
      runtimeVersion: this.opts.runtimeVersion ?? "memory-0",
      sem: { major: 1, minor: 0 },
      collection: this.collection,
      grant,
      status: this.status(),
      features: (p.features ?? []).filter((x) => x === "presence" || x === "fence"),
    };
    return w.clientFrame.enc({ kind: "response", id: f.id, result: w.helloResult.enc(result) });
  }

  private status(): w.SyncStatus {
    return {
      mode: "synced",
      confirmedThrough: this.seq,
      headKnown: this.seq,
      pending: this.pendingQueue.length,
      ...(this.pendingQueue.length ? { oldestPending: Date.now() } : {}),
      holds: this.holdList.size,
      unresolved: [...this.records.values()].reduce((n, r) => n + (r.unresolved ?? 0), 0),
      connection: this.online ? "online" : "offline",
      incidents: [],
    };
  }

  private send(c: Conn, f: w.ClientFrame): void {
    try {
      c.port.send(w.clientFrame.enc(f));
    } catch {
      // closed
    }
  }

  private push(c: Conn, type: string, payload: CborValue): void {
    this.send(c, { kind: "push", type, payload });
  }

  private drop(c: Conn): void {
    this.conns.delete(c);
    for (const id of c.joined.keys()) this.pushPresence(id);
  }

  private async onFrame(c: Conn, raw: CborValue): Promise<void> {
    const f = w.clientFrame.dec(raw);
    if (f.kind !== "request") return;
    if (this.loseNext) {
      this.loseNext = false;
      await this.dispatch(c, f.method, f.params).catch(() => {});
      c.port.close();
      return;
    }
    try {
      const result = await this.dispatch(c, f.method, f.params);
      this.send(c, { kind: "response", id: f.id, result: result ?? null });
    } catch (e) {
      const p = isMdbaseError(e)
        ? e.toProblem()
        : problem("invalid_request", e instanceof Error ? e.message : String(e));
      this.send(c, { kind: "response", id: f.id, problem: p });
    }
  }

  private contractMethod(method: string, m: M, contracts: MemoryContract[]): CborValue {
    if (method === "query_contract_v1") {
      const sel = { id: m.get(1) as string, version: m.get(2) as string };
      const impls = contracts.filter((c) => c.id === sel.id && c.version === sel.version);
      if (!impls.length) throw mdbaseError("not_found", "no such contract", "data_contract_not_found");
      const where = m.get(5) as string | undefined;
      if (where && !this.opts.where) throw mdbaseError("invalid_request", "MemoryReplica: pass a `where` evaluator to use where");
      const rows = [...this.records.values()]
        .sort((a, b) => (a.path < b.path ? -1 : 1))
        .map((r) => ({
          r,
          implementations: impls
            .filter((c) => r.types.includes(c.type))
            .map((c) => ({ typeName: c.type, fields: contractFields(c, r), issues: [] }))
            .filter((x) => !where || this.opts.where!(where, { ...r, frontmatter: x.fields })),
        }))
        .filter((x) => x.implementations.length);
      const start = Number(m.get(4) ?? 0);
      const limit = (m.get(3) as number | undefined) ?? 128;
      const slice = rows.slice(start, start + limit);
      const page: w.QueryResult = { records: slice.map((x) => this.view(x.r)), complete: true, asOf: this.viewVersion };
      if (start + limit < rows.length) page.cursor = String(start + limit);
      return contractQueryResult.enc({
        version: 1, page, contractDigest: contractDigest(impls[0]!),
        records: slice.map((x) => ({ id: x.r.id, implementations: x.implementations })),
      });
    }
    if (method === "get_contract_v1") {
      const r = this.find(m.get(1)!);
      const c = implementationFor(contracts, { id: m.get(2) as string, version: m.get(3) as string, type: m.get(4) as string | undefined }, r);
      return contractRecordWire.enc({
        version: 1, id: r.id, path: r.path, revision: revision(r), type: c.type, fields: contractFields(c, r),
        contractDigest: contractDigest(c), implementationDigest: implementationDigest(c),
      });
    }
    const target = m.get(4);
    const r = target === undefined ? undefined : this.find(target);
    const sel = { id: m.get(1) as string, version: m.get(2) as string, type: m.get(3) as string | undefined };
    // Promotion: an untyped record takes the implementing type through `type`.
    const promoting = m.get(7) === true && r !== undefined && r.types.length === 0;
    if (m.get(7) === true && r?.types.length && !contracts.some((c) => c.id === sel.id && c.version === sel.version && r.types.includes(c.type))) {
      throw mdbaseError("invalid_request", "only a record without types can be promoted", "data_contract_promote_typed");
    }
    const c = implementationFor(contracts, sel, promoting ? undefined : r);
    const mapped = mapWrite(c, r, (m.get(5) ?? new Map()) as Map<string, CborValue>, (m.get(6) ?? []) as string[]);
    if (promoting) {
      mapped.patch.set("type", c.type);
      mapped.base.push({ key: "type" });
    }
    return contractWritePlan.enc({
      version: 1, type: c.type, ...mapped, contractDigest: contractDigest(c), implementationDigest: implementationDigest(c),
      ...(r ? { id: r.id, path: r.path, revision: revision(r) } : {}),
    });
  }

  private find(ref: CborValue): MemoryRecord {
    const r =
      typeof ref === "string"
        ? [...this.records.values()].find((x) => x.path === ref)
        : this.records.get(uuidCodec.dec(ref));
    if (!r) throw mdbaseError("not_found", "no such record");
    return r;
  }

  private view(r: MemoryRecord, inc?: w.Include): w.RecordView {
    const v: w.RecordView = {
      id: r.id,
      path: r.path,
      revision: revision(r),
      frontmatter: new Map(r.frontmatter),
      types: r.types,
      state: {
        state: r.pending ? "pending" : "confirmed",
        confirmedSeq: r.confirmedSeq,
        ...(r.hold ? { hold: { ...r.hold } } : {}),
        ...(r.unresolved ? { unresolved: r.unresolved } : {}),
      },
    };
    if (inc?.body) v.body = r.body;
    if (inc?.document) v.document = renderDocument(r);
    if (inc?.effective) v.effective = new Map(r.frontmatter);
    return v;
  }

  private evalQuery(q: Map<string, CborValue>): MemoryRecord[] {
    const types = q.get("types") as string[] | undefined;
    const where = q.get("where") as string | undefined;
    let rows = [...this.records.values()].filter((r) => !types?.length || types.some((t) => r.types.includes(t)));
    if (where) {
      if (!this.opts.where) throw mdbaseError("invalid_request", "MemoryReplica: pass a `where` evaluator to use where");
      rows = rows.filter((r) => this.opts.where!(where, r));
    }
    const order = q.get("order_by");
    const keys: { field: string; desc: boolean }[] = [];
    for (const o of Array.isArray(order) ? order : order ? [order] : []) {
      if (typeof o === "string") keys.push({ field: o.replace(/^-/, ""), desc: o.startsWith("-") });
      else if (o instanceof Map) {
        const m = o as Map<string, CborValue>;
        keys.push({ field: String(m.get("field")), desc: m.get("direction") === "desc" });
      }
    }
    const get = (r: MemoryRecord, field: string): unknown =>
      field === "file.path" || field === "path" ? r.path : toPlain(r.frontmatter.get(field.replace(/^fm\./, "")) ?? null);
    rows.sort((a, b) => {
      for (const k of keys) {
        const x = get(a, k.field) as never;
        const y = get(b, k.field) as never;
        if (x === y) continue;
        const c = x === null ? -1 : y === null ? 1 : x < y ? -1 : 1;
        return k.desc ? -c : c;
      }
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
    return rows;
  }

  private page(q: Map<string, CborValue>): { rows: MemoryRecord[]; cursor?: string } {
    const all = this.evalQuery(q);
    const start = Number(q.get("cursor") ?? 0);
    const limit = q.get("limit") as number | undefined;
    const rows = limit === undefined ? all.slice(start) : all.slice(start, start + limit);
    const next = start + rows.length;
    return next < all.length && limit !== undefined ? { rows, cursor: String(next) } : { rows };
  }

  private async dispatch(c: Conn, method: string, p: CborValue): Promise<CborValue | undefined> {
    const m = (p ?? new Map()) as M;
    switch (method) {
      case "cancel":
        return null;
      case "describe": {
        const types = new Set<string>();
        for (const r of this.records.values()) r.types.forEach((t) => types.add(t));
        for (const p of this.resources.keys()) {
          const m = /^_types\/(.+)\.md$/.exec(p);
          if (m) types.add(m[1]!);
        }
        return w.describeResult.enc({
          specVersion: "0.3.0-rc.5",
          types: [...types].sort().map((name) => this.typeSummary(name, m.get(0) === true)),
          settings: new Map(),
          inclusion: { include: ["image", "audio", "video", "pdf", "other"] },
          issues: [],
          contracts: [],
        });
      }
      case "new_type_file": {
        // Synthetic subset of Core's derivation: frontmatter name, default folder.
        const { frontmatter } = parseDocument(m.get(0) as string);
        const name = frontmatter.get("name");
        if (frontmatter.get("kind") !== "mdbase.type" || typeof name !== "string" || name === "" || name.includes("/")) {
          throw mdbaseError("invalid_record", "the type needs a usable name", "invalid_type_definition");
        }
        const existing = [...this.resources.keys()].find((p) => p.toLowerCase() === `_types/${name.toLowerCase()}.md`);
        if (existing !== undefined) {
          throw mdbaseError("conflict", "the type exists", { reason: "type_conflict", details: existing });
        }
        return w.newTypeFile.enc({ name, path: `_types/${name}.md` });
      }
      case "get_resource": {
        const path = m.get(0) as string;
        const r = this.resources.get(path);
        if (r === undefined) throw mdbaseError("not_found", "no such resource");
        return w.resourceView.enc(this.resourceView(path, r, true));
      }
      case "list_resources": {
        const folder = m.get(0) as string | undefined;
        const text = m.get(1) === true;
        const resources = [...this.resources.entries()]
          .filter(([p]) => !folder || p.startsWith(folder.endsWith("/") ? folder : `${folder}/`))
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([p, r]) => this.resourceView(p, r, text));
        return w.listResourcesResult.enc({ resources, complete: true });
      }
      case "backlinks": {
        const target = this.find(m.get(0)!);
        const inc = m.get(1) ? w.include.dec(m.get(1)!) : undefined;
        const backlinks = [...this.records.values()]
          .filter((r) => r.id !== target.id)
          .map((r) => ({ r, links: this.linksOf(r).filter((l) => l.resolution.target === target.id) }))
          .filter((x) => x.links.length)
          .sort((a, b) => (a.r.path < b.r.path ? -1 : 1))
          .map((x) => ({ record: this.view(x.r, inc), links: x.links }));
        return w.backlinksResult.enc({ backlinks, complete: true, asOf: this.viewVersion });
      }
      case "list_pending": {
        const pending = this.pendingQueue
          // Owner-scoped like the replica: one grant per MemoryReplica, so every
          // session (a reload included) sees them.
          .map((mu) => ({ receipt: this.receipts.get(mu)!, captured: 0, ops: this.pendingOps.get(mu) ?? [] }))
          .filter((x) => x.ops.length);
        return w.listPendingResult.enc({ pending });
      }
      case "get_status":
        return w.syncStatus.enc(this.status());
      case "subscribe_status":
        c.status = true;
        return null;
      case "get": {
        const inc = m.get(1) ? w.include.dec(m.get(1)!) : undefined;
        return w.recordView.enc(this.view(this.find(m.get(0)!), inc));
      }
      case "query": {
        const q = (m.get(0) ?? new Map()) as Map<string, CborValue>;
        const inc = m.get(1) ? w.include.dec(m.get(1)!) : undefined;
        const { rows, cursor } = this.page(q);
        const r: w.QueryResult = { records: rows.map((x) => this.view(x, inc)), complete: true, asOf: this.viewVersion };
        if (cursor) r.cursor = cursor;
        return w.queryResult.enc(r);
      }
      case "subscribe": {
        const sub: Sub = {
          id: this.nextSub++,
          query: (m.get(0) ?? new Map()) as Map<string, CborValue>,
          include: m.get(1) ? w.include.dec(m.get(1)!) : undefined,
          last: new Map(),
          order: [],
        };
        c.subs.set(sub.id, sub);
        queueMicrotask(() => this.refreshSub(c, sub, true));
        return new Map([[0, sub.id]]);
      }
      case "unsubscribe":
        c.subs.delete(m.get(0) as number);
        return null;
      case "changes": {
        const after = Number(m.get(0) ?? 0);
        const limit = (m.get(1) as number | undefined) ?? 1000;
        const changes = this.changeLog.filter((x) => x.version > after).slice(0, limit);
        if (m.get(2) === true) c.changesWatch = true;
        const cursor = String(changes.length ? changes[changes.length - 1]!.version : Math.max(after, this.viewVersion));
        return w.changesResult.enc({ changes, cursor, reset: after > this.viewVersion });
      }
      case "submit":
        return w.submitResult.enc(await this.submit(c, w.submitParams.dec(p)));
      case "receipt": {
        const r = this.receipts.get(uuidCodec.dec(m.get(0)!));
        if (!r) throw mdbaseError("not_found", "no such mutation");
        return w.receipt.enc(r);
      }
      case "await": {
        const id = uuidCodec.dec(m.get(0)!);
        const r = this.receipts.get(id);
        if (!r) throw mdbaseError("not_found", "no such mutation");
        if (r.state === "pending") {
          const timeout = m.get(1) as number | undefined;
          await new Promise<void>((res) => {
            const list = this.awaiters.get(id) ?? [];
            list.push(res);
            this.awaiters.set(id, list);
            if (timeout !== undefined) setTimeout(res, timeout);
          });
        }
        return w.receipt.enc(this.receipts.get(id)!);
      }
      case "describe_typing": {
        const types = (m.get(0) ?? []) as string[];
        const paths = (m.get(1) ?? []) as string[];
        if (types.length > w.DESCRIBE_TYPING_MAX_TYPES || paths.length > w.DESCRIBE_TYPING_MAX_PATHS) {
          throw mdbaseError("too_large", "describe_typing: too many types or paths");
        }
        if (this.typingAnswer) return w.describeTypingResult.enc(this.typingAnswer(types, paths));
        // Top-level fields only; nested paths are `none` at the op layer, before Core is asked.
        const fields = paths.map((path) => ({
          path,
          hint: path.includes(".") || types.length === 0 || !this.opts.typing ? ("none" as const) : this.opts.typing(types, path),
        }));
        return w.describeTypingResult.enc({ catalogGeneration: this.viewVersion, fields });
      }
      case "account_key_setup": {
        const secret = m.get(0);
        if (!(secret instanceof Uint8Array) || secret.length !== 32) throw mdbaseError("invalid_request", "the account secret is 32 bytes");
        this.accountKeySecret = secret.slice();
        const mutation = uuidv7();
        c.mutations.add(mutation);
        const r: w.Receipt = { mutation, state: "pending" };
        this.receipts.set(mutation, r);
        this.pendingQueue.push(mutation);
        this.pendingRecords.set(mutation, []);
        this.pushStatus();
        return w.receipt.enc(r);
      }
      case "account_key_unlock": {
        const secret = m.get(0);
        if (!(secret instanceof Uint8Array) || secret.length !== 32) throw mdbaseError("invalid_request", "the account secret is 32 bytes");
        const refused = (reason: string): AccountKeyStatus => ({
          state: "refused",
          problem: { code: "forbidden", recovery: "reauthorize", message: `account key refused: ${reason}`, details: new Map([["reason", reason]]) },
        });
        const enrolled = this.accountKeySecret;
        this.accountKey = !enrolled ? refused("device_missing")
          : enrolled.length === secret.length && enrolled.every((b, i) => b === secret[i]) ? { state: "keyed" }
          : refused("enrolment_mismatch");
        return null;
      }
      case "account_key_status":
        return accountKeyStatus.enc(this.accountKey);
      case "list_holds":
        return list(w.hold).enc([...this.holdList.values()].map((h) => h.hold));
      case "resolve_hold": {
        const id = uuidCodec.dec(m.get(0)!), how = w.holdResolution.dec(m.get(1)!), use = m.get(2) as string | undefined;
        const held = this.holdList.get(id);
        if (!held) throw mdbaseError("not_found", "no such hold");
        const r = this.records.get(held.record);
        this.holdList.delete(id);
        if (r) delete r.hold;
        const theirs = typeof held.hold.theirs === "string" ? held.hold.theirs : undefined;
        const ops: w.Op[] = !r ? []
          : how === "delete" ? [{ kind: "delete", id: r.id }]
          : how === "take_theirs" && theirs !== undefined ? [{ kind: "update", id: r.id, body: theirs }]
          : how === "use" && use !== undefined ? [{ kind: "update", id: r.id, body: use }]
          : how === "keep_both" ? [{ kind: "create", id: uuidv7(), path: r.path.replace(/(\.[^./]+)?$/, " (copy)$1"), body: theirs ?? r.body }]
          : [{ kind: "update", id: r.id }];
        const [receipt] = await this.submit(c, { ops, mutationId: uuidv7() });
        this.pushHolds();
        this.pushStatus();
        return w.receipt.enc(receipt!);
      }
      case "subscribe_holds":
        c.holds = true;
        return null;
      case "list_conflicts": {
        const record = m.get(0) === undefined ? undefined : uuidCodec.dec(m.get(0)!);
        return list(w.conflictEntry).enc(this.conflictList.filter((e) => !record || e.conflict.id === record));
      }
      case "subscribe_conflicts":
        c.conflicts = true;
        return null;
      case "presence_join":
      case "presence_update": {
        const id = uuidCodec.dec(m.get(0)!);
        c.joined.set(id, m.get(1) ?? null);
        this.pushPresence(id);
        return null;
      }
      case "presence_leave": {
        const id = uuidCodec.dec(m.get(0)!);
        c.joined.delete(id);
        this.pushPresence(id);
        return null;
      }
      case "subscribe_presence": {
        const id = uuidCodec.dec(m.get(0)!);
        c.presence.add(id);
        queueMicrotask(() => this.pushPresence(id, c));
        return null;
      }
      case "list_files": {
        const folder = m.get(0) as string | undefined;
        const files = [...this.files.values()]
          .filter((f) => !folder || f.path.startsWith(folder.endsWith("/") ? folder : `${folder}/`))
          .sort((a, b) => (a.path < b.path ? -1 : 1))
          .map((f) => this.fileView(f));
        return w.listFilesResult.enc({ files, complete: true });
      }
      case "get_file":
        return w.fileView.enc(this.fileView(this.findFile(m.get(0)!)));
      case "open_upload": {
        const op = w.openUploadParams.dec(p);
        const u = this.uploads.get(op.transfer) ?? { params: op, fileId: op.fileId ?? uuidv7(), chunks: new Map() };
        this.uploads.set(op.transfer, u);
        return w.openUploadResult.enc({
          transfer: op.transfer,
          chunkSize: 1024 * 1024,
          received: [...u.chunks.keys()],
          expiresAt: Date.now() + 86_400_000,
          fileId: u.fileId,
        });
      }
      case "upload_chunk": {
        const ch = w.uploadChunkParams.dec(p);
        const u = this.uploads.get(ch.transfer);
        if (!u) throw mdbaseError("not_found", "no such transfer", "transfer_expired");
        u.chunks.set(ch.index, ch.bytes.slice());
        return new Map([[0, u.chunks.size]]);
      }
      case "commit_upload":
        return w.receipt.enc(this.commitUpload(c, uuidCodec.dec(m.get(0)!)));
      case "abort_upload":
        this.uploads.delete(uuidCodec.dec(m.get(0)!));
        return null;
      case "read_file": {
        const f = this.findFile(m.get(0)!);
        const range = m.get(1) as number[] | undefined;
        const data = range ? f.bytes.subarray(range[0], range[0]! + range[1]!) : f.bytes;
        const id = this.nextStream++;
        c.streams.set(id, { data, offset: 0, acked: 0 });
        queueMicrotask(() => this.pumpStream(c, id));
        return new Map<number, CborValue>([
          [0, id],
          [1, w.fileView.enc(this.fileView(f))],
        ]);
      }
      case "ack_chunks": {
        const st = c.streams.get(m.get(0) as number);
        if (st) {
          st.acked = m.get(1) as number;
          this.pumpStream(c, m.get(0) as number);
        }
        return null;
      }
      case "cancel_stream":
        c.streams.delete(m.get(0) as number);
        return null;
      case "fence_report":
        return null;
      case "get_contract_v1":
      case "map_contract_write_v1":
      case "query_contract_v1":
        if (this.opts.contracts) return this.contractMethod(method, m, this.opts.contracts);
        throw mdbaseError("invalid_request", `MemoryReplica does not implement ${method}`, "unknown_method");
      default:
        throw mdbaseError("invalid_request", `MemoryReplica does not implement ${method}`, "unknown_method");
    }
  }

  private pumpStream(c: Conn, id: number): void {
    const st = c.streams.get(id);
    if (!st) return;
    const CHUNK = 256 * 1024;
    while (st.offset - st.acked < 8 * 1024 * 1024) {
      const end = Math.min(st.data.length, st.offset + CHUNK);
      const last = end >= st.data.length;
      this.push(
        c,
        "file_chunk",
        w.fileChunk.enc({ stream: id, offset: st.offset, bytes: st.data.slice(st.offset, end), last }),
      );
      st.offset = end;
      if (last) {
        c.streams.delete(id);
        return;
      }
    }
  }

  private findFile(ref: CborValue): MemFile {
    const f =
      typeof ref === "string" ? [...this.files.values()].find((x) => x.path === ref) : this.files.get(uuidCodec.dec(ref));
    if (!f) throw mdbaseError("not_found", "no such file");
    return f;
  }

  private fileView(f: MemFile): w.FileView {
    return {
      id: f.id,
      path: f.path,
      size: f.bytes.length,
      digest: hashFromBytes(sha256(f.bytes)),
      media: mediaOf(f.path),
      ...(mediaTypeOf(f.path) ? { mediaType: mediaTypeOf(f.path)! } : {}),
      state: f.pending ? "pending_upload" : "materialized",
      confirmedSeq: f.confirmedSeq,
    };
  }

  private commitUpload(c: Conn, transfer: w.Uuid): w.Receipt {
    const u = this.uploads.get(transfer);
    if (!u) throw mdbaseError("not_found", "no such transfer", "transfer_expired");
    const total = [...u.chunks.entries()].sort((a, b) => a[0] - b[0]);
    const bytes = new Uint8Array(u.params.size);
    let off = 0;
    for (const [, ch] of total) {
      bytes.set(ch, off);
      off += ch.length;
    }
    if (off !== u.params.size) throw mdbaseError("invalid_request", "size mismatch", "size_mismatch");
    if (u.params.digest && hashFromBytes(sha256(bytes)) !== u.params.digest) {
      throw mdbaseError("invalid_request", "digest mismatch", "digest_mismatch");
    }
    this.uploads.delete(transfer);
    const mutation = u.params.mutationId ?? uuidv7();
    const existing = this.receipts.get(mutation);
    if (existing) return existing;
    const id = u.fileId;
    const prev = this.files.get(id);
    if (u.params.ifRevision && prev && hashFromBytes(sha256(prev.bytes)) !== u.params.ifRevision) {
      throw mdbaseError("conflict", "file changed", "revision");
    }
    this.files.set(id, { id, path: u.params.path, bytes, confirmedSeq: prev?.confirmedSeq ?? 0, pending: true });
    this.touch(id, u.params.path, "put", "file");
    c.mutations.add(mutation);
    const r: w.Receipt = { mutation, state: "pending" };
    this.receipts.set(mutation, r);
    this.pendingQueue.push(mutation);
    this.pendingRecords.set(mutation, []);
    this.fileMutations.set(mutation, [id]);
    this.pushStatus();
    this.scheduleConfirm();
    return r;
  }

  private fileMutations = new Map<w.Uuid, w.Uuid[]>();
  private resources = new Map<string, { text: string; pending: boolean }>();
  private pendingOps = new Map<w.Uuid, w.Op[]>();

  /** Seed a resource (a type file, mdbase.yaml). */
  seedResource(path: string, text: string): void {
    this.resources.set(path, { text, pending: false });
  }

  /** Synthetic type summary: the parsed subset of the type file, never Core's catalog. */
  private typeSummary(name: string, definitions: boolean): w.TypeSummary {
    const path = `_types/${name}.md`;
    const summary: w.TypeSummary = { name, path, implements: [] };
    const source = this.resources.get(path);
    if (source === undefined) return definitions ? { ...summary, definition: new Map(), schema: null } : summary;
    const { frontmatter } = parseDocument(source.text);
    const version = frontmatter.get("version");
    if (typeof version === "number" && Number.isInteger(version)) summary.version = version;
    summary.revision = this.resourceView(path, source, false).revision;
    if (definitions) {
      // parseDocument leaves JSON objects plain; normalise them to data maps.
      const definition = toValue(frontmatter as Map<string, PlainValue>) as Map<string, CborValue>;
      const schema = definition.get("schema");
      summary.definition = definition;
      summary.schema = schema instanceof Map ? ((schema as Map<string, CborValue>).get("value") ?? null) : null;
    }
    return summary;
  }

  private resourceView(path: string, r: { text: string; pending: boolean }, text: boolean): w.ResourceView {
    const bytes = new TextEncoder().encode(r.text);
    const v: w.ResourceView = {
      path,
      revision: hashFromBytes(sha256(bytes)),
      size: bytes.length,
      state: r.pending ? "pending" : "confirmed",
    };
    if (text) v.text = r.text;
    return v;
  }

  /** `[[target]]` / `![[target]]` links in the body, resolved by path or basename. */
  private linksOf(r: MemoryRecord): w.LinkView[] {
    const out: w.LinkView[] = [];
    for (const m of r.body.matchAll(/(!?)\[\[([^\]|#]+)(?:[^\]]*)\]\]/g)) {
      const name = m[2]!.trim();
      const target = [...this.records.values()].find(
        (x) => x.path === name || x.path === `${name}.md` || x.path.replace(/\.md$/, "").split("/").pop() === name,
      );
      out.push({
        raw: m[0],
        embed: m[1] === "!",
        resolution: target ? { kind: "record", target: target.id, path: target.path } : { kind: "not_found" },
      });
    }
    return out;
  }

  /** Dry-run preflight: links a delete breaks, links a rename rewrites. */
  private preflight(ops: w.Op[]): w.Preflight {
    const pf: w.Preflight = { rewrites: [], broken: [] };
    for (const op of ops) {
      if (op.kind !== "delete" && op.kind !== "rename") continue;
      for (const r of [...this.records.values()].sort((a, b) => (a.path < b.path ? -1 : 1))) {
        for (const l of this.linksOf(r)) {
          if (l.resolution.target !== op.id) continue;
          if (op.kind === "rename" && op.updateRefs) {
            pf.rewrites.push({ record: r.id, path: r.path, from: l.raw, to: l.raw.replace(/\[\[[^\]|#]+/, (x) => x.slice(0, x.indexOf("[[") + 2) + op.to.replace(/\.md$/, "")) });
          } else {
            pf.broken.push({ record: r.id, path: r.path, raw: l.raw, target: op.id });
          }
        }
      }
    }
    return pf;
  }
  /** Record state before each pending mutation, to roll back on reject. */
  private priors = new Map<w.Uuid, Map<w.Uuid, MemoryRecord | null>>();

  private async submit(c: Conn, p: w.SubmitParams): Promise<w.Receipt[]> {
    if (this.failWrite && !p.dryRun) {
      const failure = this.failWrite;
      this.failWrite = null;
      throw new MdbaseError(failure);
    }
    const groups = p.allowPartial ? p.ops.map((op) => [op]) : [p.ops];
    const ids = p.allowPartial ? (p.mutationIds ?? []) : [p.mutationId ?? uuidv7()];
    const out: w.Receipt[] = [];
    for (let i = 0; i < groups.length; i++) {
      const mutation = ids[i] ?? uuidv7();
      const known = this.receipts.get(mutation);
      if (known) {
        out.push(known);
        continue;
      }
      let r: w.Receipt;
      try {
        if (p.dryRun) {
          // Validate without changing anything: apply to a scratch copy.
          const saved = {
            records: new Map([...this.records].map(([k, v]) => [k, { ...v, frontmatter: new Map(v.frontmatter) }])),
            resources: new Map([...this.resources].map(([k, v]) => [k, { ...v }])),
            files: new Map(this.files),
            changeLog: this.changeLog.length,
            viewVersion: this.viewVersion,
          };
          const pf = this.preflight(groups[i]!);
          const mute = this.conns;
          this.conns = new Set();
          try {
            const touched = this.applyOps(groups[i]!, mutation);
            r = { mutation, state: "pending", records: touched.map((id) => this.view(this.records.get(id)!, p.include)), preflight: pf };
          } finally {
            this.records = saved.records;
            this.resources = saved.resources;
            this.files = saved.files;
            this.changeLog.length = saved.changeLog;
            this.viewVersion = saved.viewVersion;
            this.priors.delete(mutation);
            this.conns = mute;
          }
          out.push(r);
          continue;
        }
        const touched = this.applyOps(groups[i]!, mutation);
        r = { mutation, state: "pending", records: touched.map((id) => this.view(this.records.get(id)!, p.include)) };
        this.pendingOps.set(mutation, groups[i]!);
        c.mutations.add(mutation);
        this.receipts.set(mutation, r);
        this.pendingQueue.push(mutation);
        this.pendingRecords.set(mutation, touched);
        this.pushStatus();
        this.scheduleConfirm();
      } catch (e) {
        const prob = e instanceof MdbaseError ? e.toProblem() : problem("invalid_request", String(e));
        r = { mutation, state: "rejected", problem: prob };
        this.receipts.set(mutation, r);
      }
      if (p.wait === "confirmed" && r.state === "pending") {
        await new Promise<void>((res) => {
          const list = this.awaiters.get(mutation) ?? [];
          list.push(res);
          this.awaiters.set(mutation, list);
        });
        r = this.receipts.get(mutation)!;
      }
      out.push(r);
    }
    return out;
  }

  /** Apply ops to the local view; returns the record IDs touched (still present). */
  private applyOps(ops: w.Op[], mutation: w.Uuid): w.Uuid[] {
    const touched: w.Uuid[] = [];
    // Validate everything first: a mutation is atomic.
    const staged = new Map<w.Uuid, MemoryRecord | null>();
    const cur = (id: w.Uuid) => (staged.has(id) ? staged.get(id) : this.records.get(id));
    for (const op of ops) {
      switch (op.kind) {
        case "create": {
          if (cur(op.id)) throw mdbaseError("invalid_request", "record ID exists");
          const path = op.path ?? `${op.type ?? "record"}-${op.id.slice(0, 8)}.md`;
          if ([...this.records.values()].some((r) => r.path.toLowerCase() === path.toLowerCase() && staged.get(r.id) !== null)) {
            throw mdbaseError("conflict", `path ${path} is taken`, "path_taken");
          }
          staged.set(op.id, {
            id: op.id,
            path,
            types: op.type ? [op.type] : [],
            ...(op.document === undefined
              ? { frontmatter: new Map(op.frontmatter ?? []), body: op.body ?? "" }
              : parseDocument(op.document)),
            confirmedSeq: 0,
            pending: true,
          });
          touched.push(op.id);
          break;
        }
        case "update": {
          const r0 = cur(op.id);
          if (!r0) throw mdbaseError("not_found", "no such record");
          if (op.ifRevision && op.ifRevision !== revision(r0)) {
            throw new MdbaseError({
              ...problem("conflict", "the record changed since if_revision", "revision"),
              details: new Map([["current", revision(r0)]]),
            });
          }
          const r = { ...r0, frontmatter: new Map(r0.frontmatter), pending: true };
          for (const [k, v] of op.patch ?? []) r.frontmatter.set(k, v);
          // Explicit membership, as Core reads the `type` key.
          const declared = r.frontmatter.get("type");
          if (typeof declared === "string" && !r.types.includes(declared)) r.types = [declared];
          for (const k of op.unset ?? []) r.frontmatter.delete(k);
          for (const [k, items] of op.add ?? []) {
            const old = r.frontmatter.get(k);
            const arr = Array.isArray(old) ? [...old] : [];
            for (const it of items) if (!arr.some((x) => JSON.stringify(toPlain(x)) === JSON.stringify(toPlain(it)))) arr.push(it);
            r.frontmatter.set(k, arr);
          }
          for (const [k, items] of op.remove ?? []) {
            const old = r.frontmatter.get(k);
            if (Array.isArray(old)) {
              const drop = new Set(items.map((x) => JSON.stringify(toPlain(x))));
              r.frontmatter.set(k, old.filter((x) => !drop.has(JSON.stringify(toPlain(x)))));
            }
          }
          if (op.bodyEdits) {
            const base = hashFromBytes(sha256(new TextEncoder().encode(r.body)));
            if (op.bodyBase && op.bodyBase !== base) throw mdbaseError("conflict", "body changed", "body");
            r.body = applyScalarEdits(r.body, op.bodyEdits);
          } else if (op.body !== undefined) r.body = op.body;
          staged.set(op.id, r);
          touched.push(op.id);
          break;
        }
        case "document": {
          const r0 = cur(op.id);
          if (!op.new) {
            staged.set(op.id, null);
            break;
          }
          staged.set(op.id, {
            id: op.id,
            path: op.new.path || r0?.path || `${op.id}.md`,
            types: r0?.types ?? [],
            ...parseDocument(op.new.doc),
            confirmedSeq: r0?.confirmedSeq ?? 0,
            pending: true,
          });
          touched.push(op.id);
          break;
        }
        case "delete": {
          const r0 = cur(op.id);
          if (!r0) throw mdbaseError("not_found", "no such record");
          if (op.ifRevision && op.ifRevision !== revision(r0)) throw mdbaseError("conflict", "changed", "revision");
          staged.set(op.id, null);
          break;
        }
        case "rename": {
          const r0 = cur(op.id);
          if (!r0) throw mdbaseError("not_found", "no such record");
          if ([...this.records.values()].some((r) => r.path === op.to && r.id !== op.id)) {
            throw mdbaseError("conflict", `path ${op.to} is taken`, "path_taken");
          }
          staged.set(op.id, { ...r0, path: op.to, pending: true });
          touched.push(op.id);
          break;
        }
        case "file_move": {
          const f = this.files.get(op.id);
          if (!f) throw mdbaseError("not_found", "no such file");
          this.touch(f.id, f.path, "remove", "file");
          f.path = op.to;
          f.pending = true;
          this.touch(f.id, f.path, "put", "file");
          break;
        }
        case "file_delete": {
          const f = this.files.get(op.id);
          if (!f) throw mdbaseError("not_found", "no such file");
          this.files.delete(op.id);
          this.touch(f.id, f.path, "remove", "file");
          break;
        }
        case "resource_put": {
          const cur = this.resources.get(op.path);
          if (op.mustNotExist && cur) {
            throw new MdbaseError({
              ...problem("conflict", `a resource exists at ${op.path}`, "path_taken"),
              details: this.resourceView(op.path, cur, false).revision,
            });
          }
          if (op.baseRevision && (!cur || this.resourceView(op.path, cur, false).revision !== op.baseRevision)) {
            throw mdbaseError("conflict", "the resource changed", "revision");
          }
          this.resources.set(op.path, { text: op.doc, pending: true });
          break;
        }
        case "resource_delete": {
          const cur = this.resources.get(op.path);
          if (!cur) throw mdbaseError("not_found", "no such resource");
          if (op.baseRevision && this.resourceView(op.path, cur, false).revision !== op.baseRevision) {
            throw mdbaseError("conflict", "the resource changed", "revision");
          }
          this.resources.delete(op.path);
          break;
        }
        case "conflict_dismiss": {
          const before = this.conflictList.length;
          this.conflictList = this.conflictList.filter((e) => !(e.mutation === op.mutation && e.conflict.id === op.record));
          const r0 = this.records.get(op.record);
          if (r0 && before !== this.conflictList.length) {
            r0.unresolved = Math.max(0, (r0.unresolved ?? 0) - 1);
            this.pushConflicts();
          }
          break;
        }
        default:
          throw mdbaseError("invalid_request", `MemoryReplica does not implement ${op.kind}`);
      }
    }
    const prior = new Map<w.Uuid, MemoryRecord | null>();
    for (const id of staged.keys()) {
      const b = this.records.get(id);
      prior.set(id, b ? { ...b, frontmatter: new Map(b.frontmatter) } : null);
    }
    this.priors.set(mutation, prior);
    for (const [id, r] of staged) {
      const before = this.records.get(id);
      if (r === null) {
        this.records.delete(id);
        if (before) this.touch(id, before.path, "remove");
      } else {
        this.records.set(id, r);
        if (before && before.path !== r.path) this.touch(id, before.path, "remove");
        this.touch(id, r.path, "put");
      }
    }
    return touched.filter((id) => this.records.has(id));
  }

  private confirmTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleConfirm(): void {
    const d = this.opts.confirmDelayMs;
    if (d === null || !this.online || this.stalled || this.confirmTimer) return;
    this.confirmTimer = setTimeout(() => {
      this.confirmTimer = null;
      if (this.online && !this.stalled) this.confirmAll();
    }, d ?? 0);
  }

  private confirmNext(): void {
    const mutation = this.pendingQueue.shift();
    if (!mutation) return;
    const seq = ++this.seq;
    const ids = this.pendingRecords.get(mutation) ?? [];
    for (const id of ids) {
      const r = this.records.get(id);
      if (r) {
        r.pending = false;
        r.confirmedSeq = seq;
        this.touch(id, r.path, "put");
      }
    }
    for (const id of this.fileMutations.get(mutation) ?? []) {
      const f = this.files.get(id);
      if (f) {
        f.pending = false;
        f.confirmedSeq = seq;
      }
    }
    this.pendingRecords.delete(mutation);
    this.fileMutations.delete(mutation);
    this.priors.delete(mutation);
    for (const op of this.pendingOps.get(mutation) ?? []) {
      if (op.kind === "resource_put") {
        const r = this.resources.get(op.path);
        if (r) r.pending = false;
      }
    }
    this.pendingOps.delete(mutation);
    const records = ids.filter((id) => this.records.has(id)).map((id) => this.view(this.records.get(id)!));
    this.settle({ mutation, state: "confirmed", seq, status: "applied", records });
  }

  private settle(r: w.Receipt): void {
    this.receipts.set(r.mutation, r);
    for (const c of this.conns) if (c.mutations.has(r.mutation)) this.push(c, "receipt", w.receipt.enc(r));
    for (const res of this.awaiters.get(r.mutation) ?? []) res();
    this.awaiters.delete(r.mutation);
    this.pushStatus();
  }

  private pushStatus(): void {
    const s = w.syncStatus.enc(this.status());
    for (const c of this.conns) if (c.status) this.push(c, "status", s);
  }

  private pushPresence(record: w.Uuid, only?: Conn): void {
    const peers: w.Peer[] = [];
    for (const c of this.conns) {
      const st = c.joined.get(record);
      if (st !== undefined) peers.push({ session: c.pseudonym, state: st, lastSeen: Date.now() });
    }
    const payload = w.presencePush.enc({ record, peers });
    for (const c of only ? [only] : this.conns) if (c.presence.has(record)) this.push(c, "presence", payload);
  }

  /** Record a change and refresh live queries. */
  private touch(id: w.Uuid, path: string, kind: "put" | "remove", entity: "record" | "file" = "record", types?: string[]): void {
    this.viewVersion++;
    const t = entity === "record" ? (types ?? this.records.get(id)?.types) : undefined;
    const ch: w.Change = { id, path, kind, version: this.viewVersion, entity, ...(t?.length ? { types: [...t] } : {}) };
    this.changeLog.push(ch);
    queueMicrotask(() => {
      for (const c of this.conns) {
        for (const sub of c.subs.values()) this.refreshSub(c, sub, false);
        if (c.changesWatch) {
          this.push(c, "changes", w.changesResult.enc({ changes: [ch], cursor: String(ch.version), reset: false }));
        }
      }
    });
  }

  private refreshSub(c: Conn, sub: Sub, first: boolean): void {
    if (!c.subs.has(sub.id)) return;
    const { rows } = this.page(new Map([...sub.query].filter(([k]) => k !== "cursor")));
    const views = rows.map((r) => this.view(r, sub.include));
    const next = new Map(views.map((v) => [v.id, `${v.revision}|${v.state.state}|${v.path}`]));
    const order = views.map((v) => v.id);
    if (first) {
      sub.last = next;
      sub.order = order;
      this.push(
        c,
        "query_update",
        w.queryUpdate.enc({ sub: sub.id, kind: "snapshot", added: views, order, complete: true, asOf: this.viewVersion }),
      );
      return;
    }
    const added = views.filter((v) => !sub.last.has(v.id));
    const changed = views.filter((v) => sub.last.has(v.id) && sub.last.get(v.id) !== next.get(v.id));
    const removed = [...sub.last.keys()].filter((id) => !next.has(id));
    const orderChanged = order.join() !== sub.order.join();
    if (!added.length && !changed.length && !removed.length && !orderChanged) return;
    sub.last = next;
    sub.order = order;
    const u: w.QueryUpdate = { sub: sub.id, kind: "diff", complete: true, asOf: this.viewVersion };
    if (added.length) u.added = added;
    if (changed.length) u.changed = changed;
    if (removed.length) u.removed = removed;
    if (orderChanged) u.order = order;
    this.push(c, "query_update", w.queryUpdate.enc(u));
  }
}

export { list };
