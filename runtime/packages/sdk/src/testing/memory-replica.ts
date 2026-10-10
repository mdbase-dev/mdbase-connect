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
import { hashFromBytes, list, uuid as uuidCodec } from "../codec.js";
import { ERROR_CODES, ErrorCode, isMdbaseError, mdbaseError, MdbaseError } from "../errors.js";
import { Connector, FramePort, portPair } from "../transport/port.js";
import { toPlain, uuidv7 } from "../values.js";
import * as w from "../wire.js";
import { accountKeyStatus, type AccountKeyStatus } from "../private.js";

type M = Map<number, CborValue>;

export interface MemoryRecord {
  id: w.Uuid;
  path: string;
  types: string[];
  frontmatter: w.FmMap;
  body: string;
  confirmedSeq: number;
  pending: boolean;
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
  /** Answer hello with this problem instead (auth tests). */
  refuse?: w.Problem;
  runtimeVersion?: string;
  /** Core's temporal hint for a top-level field under a query's exact type list (default: `none`). */
  typing?: (types: string[], path: string) => w.TemporalHint;
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
  private uploads = new Map<w.Uuid, { params: w.OpenUploadParams; chunks: Map<number, Uint8Array> }>();
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
    if (!p.versions.some((v) => v.major === 1)) {
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
        "files.write",
        "definitions.manage",
      ],
      role: this.opts.role ?? "owner",
    };
    if (this.opts.grant) grant.grant = this.opts.grant;
    const result: w.HelloResult = {
      version: { major: 1, minor: 0 },
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
      holds: 0,
      unresolved: 0,
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
      state: { state: r.pending ? "pending" : "confirmed", confirmedSeq: r.confirmedSeq },
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
          types: [...types].sort().map((name) => ({ name, path: `_types/${name}.md`, implements: [] })),
          settings: new Map(),
          inclusion: { include: ["image", "audio", "video", "pdf", "other"] },
          issues: [],
          contracts: [],
        });
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
          .filter((mu) => c.mutations.has(mu))
          .map((mu) => ({ receipt: this.receipts.get(mu)!, captured: 0, ops: this.pendingOps.get(mu) ?? [] }))
          .filter((x) => x.ops.length);
        return w.listPendingResult.enc({ pending });
      }
      case "list_views":
        return w.listViewsResult.enc({ sources: [], diagnostics: [], complete: true });
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
        return [];
      case "subscribe_holds":
        c.holds = true;
        return null;
      case "list_conflicts":
        return [];
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
        const u = this.uploads.get(op.transfer) ?? { params: op, chunks: new Map() };
        this.uploads.set(op.transfer, u);
        return w.openUploadResult.enc({
          transfer: op.transfer,
          chunkSize: 1024 * 1024,
          received: [...u.chunks.keys()],
          expiresAt: Date.now() + 86_400_000,
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
    const id = u.params.fileId ?? uuidv7();
    const prev = this.files.get(id);
    if (u.params.ifRevision && prev && hashFromBytes(sha256(prev.bytes)) !== u.params.ifRevision) {
      throw mdbaseError("conflict", "file changed", "revision");
    }
    this.files.set(id, { id, path: u.params.path, bytes, confirmedSeq: prev?.confirmedSeq ?? 0, pending: true });
    this.touch(id, u.params.path, "put");
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
            frontmatter: new Map(op.frontmatter ?? []),
            body: op.body ?? "",
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
          const doc = op.new.doc;
          const mm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(doc);
          const fm = new Map<string, CborValue>();
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
              fm.set(line.slice(0, i).trim(), v);
            }
          }
          staged.set(op.id, {
            id: op.id,
            path: op.new.path || r0?.path || `${op.id}.md`,
            types: r0?.types ?? [],
            frontmatter: fm,
            body: mm ? mm[2]! : doc,
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
          this.touch(f.id, f.path, "remove");
          f.path = op.to;
          f.pending = true;
          this.touch(f.id, f.path, "put");
          break;
        }
        case "file_delete": {
          const f = this.files.get(op.id);
          if (!f) throw mdbaseError("not_found", "no such file");
          this.files.delete(op.id);
          this.touch(f.id, f.path, "remove");
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
        case "conflict_dismiss":
          break;
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
    if (d === null || !this.online || this.confirmTimer) return;
    this.confirmTimer = setTimeout(() => {
      this.confirmTimer = null;
      if (this.online) this.confirmAll();
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
  private touch(id: w.Uuid, path: string, kind: "put" | "remove"): void {
    this.viewVersion++;
    const ch: w.Change = { id, path, kind, version: this.viewVersion };
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
