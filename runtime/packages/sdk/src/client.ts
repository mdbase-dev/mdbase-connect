/**
 * `MdbaseClient`: the SDK's main entry point over any transport.
 *
 * - Reads return the replica's local view: confirmed state plus pending local
 *   mutations (§3).
 * - Live queries are pushed (§4). Use a `limit` window with `include` off for lists,
 *   and fetch bodies per record on demand.
 * - Writes are intents with optimistic results (§5). The SDK mints mutation IDs, so
 *   resubmitting after a broken link is idempotent.
 * - Receipts move pending → confirmed / rejected (§6). Status is "confirmed through
 *   N, plus pending" (§7).
 * - The client reconnects by itself and restores every subscription. Offline is never
 *   an error.
 */
import { Float64, type CborValue } from "./cbor.js";
import { encodeAppBasesRequest, decodeAppBasesResult, type AppBasesRequest, type AppBasesResult, encodeAppBasesDiscoveryRequest, decodeAppBasesDiscoveryResult, encodeAppBasesSourceRequest, decodeAppBasesSourceResult, type AppBasesDiscoveryRequest, type AppBasesDiscoveryResult, type AppBasesSourceRequest, type AppBasesSourceResult } from "./app-host/bases-wire.js";
import { list, uint, uuid as uuidCodec } from "./codec.js";
import { isMdbaseError, mdbaseError, MdbaseError } from "./errors.js";
import { FilesApi } from "./files.js";
import { LiveListener, LiveQueryState, LiveResult } from "./live.js";
import { PresenceApi } from "./presence.js";
import { rememberWitness, witnessesFor } from "./witness.js";
import { API_VERSIONS, problemCodec, schemaToError, Session } from "./session.js";
import type { Connector } from "./transport/port.js";
import { usesNextRelayFence } from "./transport/read-fence-policy.js";
import { diffEdits, PlainValue, revisionOf, toFmMap, toValue, uuidv7, valueEquals } from "./values.js";
import {
  PendingDevice,
  pendingDevice,
  RecoveryKeyStatus,
  recoveryKeyCreated,
  recoveryKeyStatus,
  accountKeyStatus,
  AccountKeyStatus,
} from "./private.js";
import {
  BacklinksResult,
  backlinksResult,
  DescribeResult,
  describeResult,
  DescribeTypingResult,
  describeTypingResult,
  DESCRIBE_TYPING_MAX_PATHS,
  DESCRIBE_TYPING_MAX_TYPES,
  listPendingResult,
  listResourcesResult,
  listViewsResult,
  PendingMutation,
  Preflight,
  ResourceView,
  resourceView,
  ViewSourceDocument,
  viewSourceDocument,
} from "./wire.js";
import {
  BaseField,
  BodyEdit,
  changesResult,
  ChangesResult,
  conflictEntry,
  ConflictEntry,
  ConflictMode,
  fenceApply,
  FenceApply,
  fenceReport,
  FenceReportEntry,
  fenceResult,
  FmMap,
  hold,
  Hold,
  HoldResolution,
  holdResolution,
  HelloResult,
  include as includeCodec,
  Include,
  Op,
  queryResult,
  QueryResult,
  queryUpdate,
  QueryUpdate,
  receipt as receiptCodec,
  Receipt,
  recordView,
  RecordView,
  submitParams,
  SubmitParams,
  submitResult,
  syncStatus,
  SyncStatus,
  appliedPrefix as appliedPrefixCodec,
  appliedPrefixParams,
  AppliedPrefix,
  Uuid,
  Value,
} from "./wire.js";

export interface ClientOptions {
  connector: Connector;
  /** App ID and version, sent in `hello`. */
  app: { name: string; version: string };
  /** IANA time zone for this session's writes and queries. Defaults to the host's. */
  timezone?: string;
  /** Extra features to request ("fence", "presence", ...). */
  features?: string[];
  /** Reconnect after the link drops (default on). */
  reconnect?: false | { minDelayMs?: number; maxDelayMs?: number };
  /** Private collections: wait for a device replica to come online instead of failing. */
  waitForDevice?: boolean;
  /** Called while waiting for a device (`reason: "no_device_online"`). */
  onWaiting?: (why: MdbaseError) => void;
  signal?: AbortSignal;
}

/** The link between this client and its replica (not the replica's sync state). */
export type LinkState = "open" | "reconnecting" | "closed";

/** Local subscription state, not cache completeness or fresh authority. */
export type ChangesWatchState = "starting" | "active" | "stale" | "failed" | "closed";
/** Callable for compatibility with the former stop-only return value. */
export interface ChangesWatch {
  (): void;
  /** First current-session watch ACK; rejects initial failure or stop. */
  readonly ready: Promise<void>;
  readonly state: ChangesWatchState;
  readonly error: MdbaseError | null;
  subscribe(listener: (state: ChangesWatchState, error: MdbaseError | null) => void): () => void;
}

/** A spec 11 query object. Plain objects are converted to data maps. */
export type Query = {
  types?: string[];
  where?: string;
  order_by?: PlainValue;
  select?: PlainValue;
  limit?: number;
  cursor?: string;
  timezone?: string;
  context?: PlainValue;
  [key: string]: PlainValue | undefined;
};

/** Snapshot plain query data without losing Float64 kind/signed zero, exact
 * integers, ordered Maps or omitted fields (structuredClone loses prototypes). */
function snapshotQueryValue(value: PlainValue | undefined): PlainValue | undefined {
  if (value instanceof Float64) return new Float64(value.value);
  if (value instanceof Date) return new Date(value) as unknown as PlainValue;
  if (Array.isArray(value)) return value.map(item => snapshotQueryValue(item) as PlainValue);
  if (value instanceof Map) return new Map([...value].map(([key, item]) => [key, snapshotQueryValue(item) as PlainValue]));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshotQueryValue(item)]));
  return value;
}

export interface PagesReset {
  reason: "cursor_expired" | "cursor_stale";
  error: MdbaseError;
  /** Pages emitted since the previous start; clear ALL accumulated results. */
  pagesYielded: number;
  signal?: AbortSignal;
}

export interface PagesOptions {
  /** Opt in to one first-page restart. Must clear accumulated results before
   * resolving, even when the replacement query has the same asOf. Without this
   * callback a stale/expired cursor is thrown, never silently retried. */
  onReset?: (reset: PagesReset) => void | Promise<void>;
}

export type RecordRef = Uuid | { path: string } | RecordView;

function refValue(ref: RecordRef): CborValue {
  if (typeof ref === "string") return uuidCodec.enc(ref);
  if ("id" in ref && typeof (ref as RecordView).id === "string") return uuidCodec.enc((ref as RecordView).id);
  return (ref as { path: string }).path;
}

function refId(ref: RecordRef): Uuid {
  if (typeof ref === "string") return ref;
  if ("id" in ref) return ref.id;
  throw mdbaseError("invalid_request", "this operation needs a record ID, not a path; get() the record first");
}

function includeValue(inc?: Include): CborValue | undefined {
  return inc ? includeCodec.enc(inc) : undefined;
}

/** The account secret `R` is exactly 32 bytes; refused locally before any request. */
function accountSecret(secret: Uint8Array): void {
  if (!(secret instanceof Uint8Array) || secret.length !== 32) throw mdbaseError("invalid_request", "the account secret is 32 bytes", "account_secret_length");
}

function params(entries: [number, CborValue | undefined][]): Map<number, CborValue> {
  const m = new Map<number, CborValue>();
  for (const [k, v] of entries) if (v !== undefined) m.set(k, v);
  return m;
}

export interface CreateInput {
  /** A record ID minted by the caller; default a new UUIDv7. */
  id?: Uuid;
  type?: string;
  path?: string;
  frontmatter?: Map<string, PlainValue> | { [k: string]: PlainValue | undefined };
  body?: string;
  /** Complete source instead of frontmatter + body. */
  document?: string;
}

export interface UpdateInput {
  /** Set these top-level keys. */
  patch?: Map<string, PlainValue> | { [k: string]: PlainValue | undefined };
  unset?: string[];
  add?: { [field: string]: PlainValue[] };
  remove?: { [field: string]: PlainValue[] };
  /** Replace the body. With a RecordView target, it is sent as a 3-way merge. */
  body?: string;
  bodyEdits?: BodyEdit[];
  bodyBase?: string;
  /** Opt-in whole-document CAS. */
  ifRevision?: string;
}

export interface WriteOptions {
  mutationId?: Uuid;
  conflictMode?: ConflictMode;
  timezone?: string;
  include?: Include;
  dryRun?: boolean;
  /** Hold for log confirmation, or final local file publication (not confirmation). */
  wait?: "pending" | "confirmed" | "published";
  signal?: AbortSignal;
}

type ReceiptListener = (r: Receipt) => void;

// Log confirmation and local publication are independent outcomes. Rejected or
// unknown receipts settle both promises; confirmation alone cannot drop a file
// write still publishing. Always inspect Write's merged publication metadata.
function needsReceipt(r: Receipt): boolean {
  return r.state === "pending" || (r.state === "confirmed" && r.published === "publishing");
}
function mergePublication(r: Receipt, previous: Receipt): Receipt {
  const prior = previous.published;
  return prior === "published" || prior === "not_published" || (r.published === undefined && prior !== undefined)
    ? { ...r, published: prior }
    : r;
}

/**
 * A submitted write. `receipt` is what the replica answered (usually `pending` with
 * optimistic `records`). `confirmed` settles when it leaves `pending`.
 */
export class Write {
  private listeners = new Set<ReceiptListener>();
  private settle!: { resolve(r: Receipt): void; reject(e: MdbaseError): void };
  private settlePublished!: { resolve(r: Receipt): void; reject(e: MdbaseError): void };
  /** Resolves with the confirmed receipt; rejects with the problem if rejected or unknown. */
  readonly confirmed: Promise<Receipt>;
  /** Final local file result, possibly BEFORE log confirmation. `not_published`
   * is a final non-publication, not success. Without files, settles at confirmation.
   * Rejects rejected/unknown outcomes; not a native custody/durable ACK gate. */
  readonly published: Promise<Receipt>;

  constructor(public receipt: Receipt) {
    this.confirmed = new Promise((resolve, reject) => (this.settle = { resolve, reject }));
    this.published = new Promise((resolve, reject) => (this.settlePublished = { resolve, reject }));
    // Callers that only look at `receipt` must not see unhandled rejections.
    this.confirmed.catch(() => {});
    this.published.catch(() => {});
    this.update(receipt);
  }

  get mutationId(): Uuid {
    return this.receipt.mutation;
  }

  /** The records as they now read locally (optimistic until confirmed). */
  get records(): RecordView[] {
    return this.receipt.records ?? [];
  }

  get state(): Receipt["state"] {
    return this.receipt.state;
  }

  onReceipt(fn: ReceiptListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** @internal */
  update(r: Receipt): void {
    let merged = r.records || !this.receipt.records ? r : { ...r, records: this.receipt.records };
    // Preserve final publication through delayed/missing pushes without mutating input.
    merged = mergePublication(merged, this.receipt);
    this.receipt = merged;
    for (const fn of [...this.listeners]) fn(this.receipt);
    // A contradictory rejected/unknown packet must not resolve publication first.
    if (r.state === "rejected" || r.state === "unknown") {
      const error = new MdbaseError(r.problem ?? {
        code: r.state === "unknown" ? "outcome_unknown" : "internal",
        recovery: r.state === "unknown" ? "resolve_outcome" : "contact_support",
        message: `mutation ${r.state}`,
      });
      this.settle.reject(error);
      this.settlePublished.reject(error);
    } else {
      const pub = this.receipt.published;
      if (pub === "published" || pub === "not_published" || (r.state === "confirmed" && pub === undefined)) {
        this.settlePublished.resolve(this.receipt);
      }
      if (r.state === "confirmed") this.settle.resolve(this.receipt);
    }
  }
}

/** A live query handle. */
export class LiveQuery implements LiveQueryState {
  private result = new LiveResult();
  private listeners = new Set<LiveListener>();
  private subId: number | null = null;
  private closedFlag = false;
  /** Rejects if the first subscribe fails; resolves on the first snapshot. */
  readonly ready: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (e: MdbaseError) => void;
  /** The last error from (re)subscribing, if the subscription is currently broken. */
  error: MdbaseError | null = null;

  /** @internal */
  constructor(
    private client: MdbaseClient,
    private query: Query,
    private include: Include | undefined,
  ) {
    this.ready = new Promise((res, rej) => ((this.readyResolve = res), (this.readyReject = rej)));
    this.ready.catch(() => {});
  }

  get records(): readonly RecordView[] {
    return this.result.records;
  }
  get complete(): boolean {
    return this.result.complete;
  }
  get asOf(): number {
    return this.result.asOf;
  }
  get stale(): boolean {
    return this.result.stale;
  }
  /** Full native metadata bound to asOf; never reconstructed from the window. */
  get metadata(): QueryUpdate["metadata"] {
    return this.result.metadata;
  }
  get closed(): boolean {
    return this.closedFlag;
  }
  get(id: Uuid): RecordView | undefined {
    return this.result.get(id);
  }

  /** Call `fn` now and on every change. Returns an unsubscribe function. */
  subscribe(fn: LiveListener): () => void {
    this.listeners.add(fn);
    fn(this, null);
    return () => this.listeners.delete(fn);
  }

  /** Change the query (for example a larger `limit` window). Re-subscribes. */
  async setQuery(query: Query, include = this.include): Promise<void> {
    this.query = query;
    this.include = include;
    this.result.markStale();
    this.emit(null);
    await this.client._resubscribeLive(this);
  }

  close(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.result.markStale();
    this.client._closeLive(this);
    this.listeners.clear();
  }

  /** @internal */
  _params(): CborValue {
    return params([
      [0, toValue(this.query)],
      [1, includeValue(this.include)],
    ]);
  }
  /** @internal */
  _setSub(id: number | null): void {
    this.subId = id;
  }
  /** @internal */
  get _sub(): number | null {
    return this.subId;
  }
  /** @internal */
  _apply(u: QueryUpdate): void {
    if (this.closedFlag) return;
    this.result.apply(u);
    if (u.kind === "snapshot") {
      this.error = null;
      this.readyResolve();
    }
    this.emit(u);
  }
  /** @internal */
  _markStale(): void {
    this.result.markStale();
    this.emit(null);
  }
  /** @internal */
  _fail(e: MdbaseError, first: boolean): void {
    this.error = e;
    if (first) this.readyReject(e);
    this.emit(null);
  }

  private emit(u: QueryUpdate | null): void {
    for (const fn of [...this.listeners]) fn(this, u);
  }
}

/** Fence handler offered by an editor host (§14). */
export type FenceHandler = (
  req: FenceApply,
) => Promise<{ outcome: "applied" | "not_open" | "buffer_changed"; buffer?: string }>;

/** Collection data reads, not status/receipts/writes or historical proof probes. */
const READ_METHODS = new Set([
  "get", "query", "subscribe", "changes", "backlinks", "list_resources", "get_resource", "execute_view",
  "list_views", "read_view_source", "describe", "describe_typing", "list_files", "get_file", "read_file",
  "list_holds", "list_conflicts", "validate",
]);

export class MdbaseClient {
  private session: Session | null;
  private linkState: LinkState = "open";
  private linkError: MdbaseError | null = null;
  private linkListeners = new Set<(s: LinkState, why: MdbaseError | null) => void>();
  private lastStatus: SyncStatus;
  private statusListeners = new Set<(s: SyncStatus) => void>();
  private statusSubscribed = false;
  private lives = new Set<LiveQuery>();
  private livesBySub = new Map<number, LiveQuery>();
  private subscribing = 0;
  private early = new Map<number, QueryUpdate[]>();
  private writes = new Map<Uuid, Write>();
  private unclaimed = new Map<Uuid, Receipt>();
  private reconnectWaiters: (() => void)[] = [];
  private restorers: ((s: Session) => Promise<void> | void)[] = [];
  private fenceHandler: FenceHandler | null = null;
  private readonly fenceReads: boolean;
  private readFloor: number;
  private readFencedAt: number | null = null;
  private readFenceWaiters: (() => void)[] = [];
  private closing = false;
  private readonly collectionId: Uuid;
  private holdsWatch: { listeners: Set<(h: Hold[]) => void>; last: Hold[] | null } = {
    listeners: new Set(),
    last: null,
  };
  private conflictsWatch: { listeners: Set<(c: ConflictEntry[]) => void>; last: ConflictEntry[] | null } = {
    listeners: new Set(),
    last: null,
  };
  /** Files: handles, uploads, downloads (§10). */
  readonly files: FilesApi;
  /** Presence on records (§11). */
  readonly presence: PresenceApi;

  private constructor(
    private opts: ClientOptions,
    session: Session,
  ) {
    this.session = session;
    this.collectionId = session.hello.collection;
    this.lastStatus = session.hello.status;
    this.fenceReads = usesNextRelayFence(opts.connector);
    this.readFloor = session.hello.status.confirmedThrough;
    this.files = new FilesApi(this);
    this.presence = new PresenceApi(this);
    this.attach(session);
  }

  /**
   * Connect to a replica and say hello. With `waitForDevice`, a private collection with
   * no device online keeps retrying (calling `onWaiting`) instead of failing.
   */
  static async connect(opts: ClientOptions): Promise<MdbaseClient> {
    // A next-relay connection keeps its original connector/policy across awaits.
    if (usesNextRelayFence(opts.connector)) opts = { ...opts };
    let delay = (opts.reconnect && opts.reconnect.minDelayMs) || 1000;
    for (;;) {
      try {
        const session = await Session.open(opts.connector, MdbaseClient.helloParams(opts), opts.signal);
        return new MdbaseClient(opts, session);
      } catch (e) {
        if (!(opts.waitForDevice && isMdbaseError(e, "unavailable") && e.reason === "no_device_online")) throw e;
        opts.onWaiting?.(e);
        await new Promise<void>((res, rej) => {
          const t = setTimeout(res, delay);
          opts.signal?.addEventListener(
            "abort",
            () => (clearTimeout(t), rej(mdbaseError("cancelled", "connect aborted"))),
            { once: true },
          );
        });
        delay = Math.min(15_000, delay * 2);
      }
    }
  }

  private static helloParams(opts: ClientOptions) {
    const tz = opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    return {
      versions: API_VERSIONS,
      clientName: opts.app.name,
      clientVersion: opts.app.version,
      features: opts.features ?? [],
      ...(tz ? { timezone: tz } : {}),
    };
  }

  // ---------------------------------------------------------------- session and link

  /** The negotiated session: API version, runtime, collection, grant, features. */
  get hello(): HelloResult {
    return this.currentSession().hello;
  }

  get collection(): Uuid {
    return this.collectionId;
  }

  get link(): LinkState {
    return this.linkState;
  }

  /**
   * Why the link is not open: the last connect error. `reason: "no_device_online"`
   * means a private collection has no device replica reachable right now; show
   * "waiting for one of your devices" rather than an error.
   */
  get linkProblem(): MdbaseError | null {
    return this.linkError;
  }

  onLink(fn: (s: LinkState, why: MdbaseError | null) => void): () => void {
    this.linkListeners.add(fn);
    return () => this.linkListeners.delete(fn);
  }

  close(): void {
    this.closing = true;
    this.session?.close();
    this.setLink("closed");
    for (const w of this.reconnectWaiters.splice(0)) w();
    this.wakeReadFence();
  }

  /** Next-relay consistency floor ONLY; not keyed/readable/Saved authority. */
  get readFenced(): boolean { return this.readFencedAt !== null; }

  /** @internal Wait for the next-relay consistency floor (other connectors never wait). */
  async readFence(signal?: AbortSignal): Promise<void> {
    if (!this.fenceReads) return;
    while (this.readFencedAt !== null) {
      if (this.linkState === "closed") throw mdbaseError("unavailable", "client closed");
      if (signal?.aborted) throw mdbaseError("cancelled", "aborted while the replica catches up");
      await new Promise<void>(res => {
        const done = () => {
          signal?.removeEventListener("abort", done);
          const i = this.readFenceWaiters.indexOf(done);
          if (i >= 0) this.readFenceWaiters.splice(i, 1);
          res();
        };
        this.readFenceWaiters.push(done);
        signal?.addEventListener("abort", done, { once: true });
      });
    }
    if (this.linkState === "closed") throw mdbaseError("unavailable", "client closed");
    if (signal?.aborted) throw mdbaseError("cancelled", "aborted while the replica catches up");
  }

  /** @internal Recheck session identity after waiting for catch-up. */
  async readyForRead(signal?: AbortSignal, immediate = false): Promise<Session> {
    if (!this.fenceReads) return immediate ? this.currentSession() : this.ready(signal);
    for (;;) {
      const s = immediate ? this.currentSession() : await this.ready(signal);
      await this.readFence(signal);
      if (s === this.session && !s.closed && this.readFencedAt === null) return s;
      if (immediate) this.currentSession();
    }
  }

  private wakeReadFence(): void { for (const w of this.readFenceWaiters.splice(0)) w(); }

  private noteReplica(s: Session): void {
    if (!this.fenceReads) return;
    const behind = s.hello.status.confirmedThrough < this.readFloor;
    this.readFencedAt = behind ? this.readFloor : null;
    if (behind && !this.statusSubscribed) void s.request("subscribe_status", null).catch(() => {});
    if (!behind) this.wakeReadFence();
  }

  private noteReceipt(r: Receipt): void {
    if (this.fenceReads && this.readFencedAt === null && r.state === "confirmed" && r.seq !== undefined) {
      this.readFloor = Math.max(this.readFloor, r.seq);
    }
  }

  /** @internal The open session, or throw `unavailable`. */
  currentSession(): Session {
    if (!this.session || this.session.closed) {
      throw mdbaseError("unavailable", "not connected to the replica", { reason: "reconnecting" });
    }
    return this.session;
  }

  /** @internal Wait until a session is open (or the client closes). */
  async ready(signal?: AbortSignal): Promise<Session> {
    for (;;) {
      if (this.linkState === "closed") throw mdbaseError("unavailable", "client closed");
      if (this.session && !this.session.closed) return this.session;
      if (signal?.aborted) throw mdbaseError("cancelled", "aborted while reconnecting");
      await new Promise<void>((res) => {
        this.reconnectWaiters.push(res);
        signal?.addEventListener("abort", () => res(), { once: true });
      });
    }
  }

  /**
   * @internal Run a request on the current session; on a dropped link, wait for the
   * reconnect and retry when `retry` (idempotent requests only).
   */
  async call<T = CborValue>(
    method: string,
    p: CborValue,
    o: { signal?: AbortSignal; codec?: import("./codec.js").Codec<T>; retry?: boolean } = {},
  ): Promise<T> {
    // Pin the decoder before any route/request await. Observation must use the
    // SAME codec passed to dispatch, not caller options mutated while pending.
    const codec = o.codec;
    const read = this.fenceReads && READ_METHODS.has(method);
    for (;;) {
      const s = read ? await this.readyForRead(o.signal, !o.retry) : o.retry ? await this.ready(o.signal) : this.currentSession();
      try {
        const r = await s.request(method, p, { ...(o.signal ? { signal: o.signal } : {}), ...(codec ? { codec } : {}) });
        if (read && (s !== this.session || s.closed || this.closing)) {
          if (o.retry && !this.closing) continue;
          throw mdbaseError("unavailable", "the session changed during the read", { reason: "reconnecting" });
        }
        // Explicit receipt probes are not reads, but their decoded confirmed
        // position contributes to next-relay consistency just like a push.
        // Never observe a late/closed session or an arbitrary caller codec.
        if (s === this.session && !s.closed && !this.closing &&
            codec === receiptCodec && (method === "receipt" || method === "await"))
          this.noteReceipt(r as Receipt);
        return r;
      } catch (e) {
        const lost = isMdbaseError(e, "unavailable") && s.closed;
        if (!(o.retry && lost && this.opts.reconnect !== false && !this.closing)) throw e;
      }
    }
  }

  /** @internal Register work to redo on every new session (re-subscribe). */
  onSession(fn: (s: Session) => Promise<void> | void): void {
    this.restorers.push(fn);
  }

  /** Pass head witnesses between replicas (log-entry.md §11); best effort. */
  private relayWitnesses(s: Session): void {
    const own = s.hello.headWitness;
    if (own) rememberWitness(this.collectionId, own, s.device);
    const others = witnessesFor(this.collectionId, own);
    if (others.length) {
      // Proposed method; a replica without it answers unknown_method, which is fine.
      void s.request("report_witnesses", params([[0, others]])).catch(() => {});
    }
  }

  /** Transport-authenticated replica identity (Noise target), NOT hello/witness
   * self-claims. Absent when the transport has no authenticated device identity. */
  get authenticatedDevice(): string | undefined {
    return this.currentSession().device;
  }

  /** The replica's latest signed head witness from `hello`, if it sent one. */
  get headWitness(): Uint8Array | undefined {
    return this.session?.hello.headWitness;
  }

  private attach(s: Session): void {
    this.relayWitnesses(s);
    s.onPush("query_update", (p) => {
      if (this.fenceReads && this.session !== s) return;
      let u: QueryUpdate;
      try {
        u = queryUpdate.dec(p);
      } catch {
        return;
      }
      const l = this.livesBySub.get(u.sub);
      if (l) l._apply(u);
      else if (this.subscribing > 0) {
        // The first push can overtake the `subscribe` response: hold it briefly.
        // Bounded: a few pushes per pending subscribe at most.
        const q = this.early.get(u.sub) ?? [];
        if (q.length < 64 && this.early.size < 64) {
          q.push(u);
          this.early.set(u.sub, q);
        }
      }
    });
    s.onPush("receipt", (p) => {
      try {
        const r = receiptCodec.dec(p);
        if (this.session === s) this.noteReceipt(r);
        const w = this.writes.get(r.mutation);
        if (w) {
          w.update(r);
          if (!needsReceipt(w.receipt)) this.writes.delete(r.mutation);
        } else {
          // The push can overtake the `submit` response; keep it for `_track`.
          const prior = this.unclaimed.get(r.mutation);
          this.unclaimed.set(r.mutation, prior ? mergePublication(r, prior) : r);
          if (this.unclaimed.size > 256) this.unclaimed.delete(this.unclaimed.keys().next().value!);
        }
      } catch {
        // ignore malformed receipts from a newer replica
      }
    });
    s.onPush("status", (p) => {
      if (this.fenceReads && this.session !== s) return;
      try {
        this.setStatus(syncStatus.dec(p));
      } catch {
        // ignore
      }
    });
    s.onPush("holds", (p) => {
      try {
        this.emitHolds(list(hold).dec(p));
      } catch {
        // ignore
      }
    });
    s.onPush("conflicts", (p) => {
      try {
        this.emitConflicts(list(conflictEntry).dec(p));
      } catch {
        // ignore
      }
    });
    s.onPush("closed", (p) => {
      // The replica ended the session (grant revoked, collection gone).
      let err: MdbaseError;
      try {
        err = new MdbaseError(problemCodec.dec(p));
      } catch {
        err = mdbaseError("unauthenticated", "the replica closed the session");
      }
      s.closeWith(err);
    });
    s.handle("fence_apply", async (p) => {
      if (!this.fenceHandler) {
        throw mdbaseError("invalid_request", "this client offers no fence", { reason: "unknown_method" });
      }
      return fenceResult.enc(await this.fenceHandler(fenceApply.dec(p)));
    });
    s.onClose((e) => this.onSessionClosed(s, e));
  }

  private onSessionClosed(s: Session, e?: MdbaseError): void {
    if (this.session !== s) return;
    for (const l of this.lives) {
      l._setSub(null);
      l._markStale();
    }
    this.livesBySub.clear();
    this.early.clear();
    if (this.closing || this.opts.reconnect === false) {
      this.setLink("closed");
      return;
    }
    if (e && (e.code === "unauthenticated" || e.code === "upgrade_required" || e.code === "forbidden")) {
      // Retrying cannot help: the app must reauthorize or upgrade.
      this.setLink("closed", e);
      return;
    }
    this.setLink("reconnecting", e ?? null);
    void this.reconnectLoop();
  }

  private async reconnectLoop(): Promise<void> {
    const cfg = this.opts.reconnect || {};
    const min = cfg.minDelayMs ?? 250;
    const max = cfg.maxDelayMs ?? 15_000;
    let delay = min;
    while (!this.closing) {
      try {
        const s = await Session.open(this.opts.connector, MdbaseClient.helloParams(this.opts));
        if (this.closing) {
          s.close();
          return;
        }
        if (s.hello.collection !== this.collectionId) {
          s.close();
          throw mdbaseError("invalid_request", "reconnected to a different collection");
        }
        this.session = s;
        this.attach(s);
        this.noteReplica(s);
        this.setStatus(s.hello.status);
        this.setLink("open");
        for (const w of this.reconnectWaiters.splice(0)) w();
        await this.restore(s);
        return;
      } catch (e) {
        if (isMdbaseError(e) && ["unauthenticated", "forbidden", "upgrade_required"].includes(e.code)) {
          this.setLink("closed", e);
          for (const w of this.reconnectWaiters.splice(0)) w();
          return;
        }
        if (isMdbaseError(e)) this.setLink("reconnecting", e);
        // Jittered exponential backoff (at least the replica's retry hint).
        const hint = isMdbaseError(e) ? (e.retryAfterMs ?? 0) : 0;
        await new Promise((r) => setTimeout(r, Math.max(hint, delay * (0.5 + Math.random() / 2))));
        delay = Math.min(max, delay * 2);
      }
    }
  }

  private async restore(s: Session): Promise<void> {
    const jobs: Promise<unknown>[] = [];
    if (this.statusSubscribed) jobs.push(s.request("subscribe_status", null).catch(() => {}));
    if (this.holdsWatch.listeners.size) jobs.push(this.refreshHolds(true).catch(() => {}));
    if (this.conflictsWatch.listeners.size) jobs.push(this.refreshConflicts(true).catch(() => {}));
    for (const l of this.lives) jobs.push(this._resubscribeLive(l, false, s).catch(() => {}));
    // Recover unsettled confirmation OR publication after a dropped session.
    for (const [id, w] of this.writes) {
      jobs.push(
        this.awaitReceipt(id)
          .then((r) => {
            w.update(r);
            if (!needsReceipt(w.receipt)) this.writes.delete(id);
          })
          .catch(() => {}),
      );
    }
    for (const fn of this.restorers) jobs.push(Promise.resolve(fn(s)).catch(() => {}));
    await Promise.all(jobs);
  }

  private setLink(s: LinkState, why: MdbaseError | null = null): void {
    if (this.linkState === "closed") return;
    if (s === "closed" && this.fenceReads) queueMicrotask(() => this.wakeReadFence());
    if (this.linkState === s && this.linkError?.reason === why?.reason) return;
    this.linkState = s;
    this.linkError = s === "open" ? null : why;
    for (const fn of [...this.linkListeners]) fn(s, this.linkError);
  }

  // ---------------------------------------------------------------- status (§7)

  /** The latest known status. */
  get status(): SyncStatus {
    return this.lastStatus;
  }

  /** Fresh status from the replica. */
  async getStatus(): Promise<SyncStatus> {
    if (!this.fenceReads) {
      const s = await this.call("get_status", null, { codec: syncStatus, retry: true });
      this.setStatus(s); return s;
    }
    for (;;) {
      const session = await this.ready();
      let s: SyncStatus;
      try { s = await session.request("get_status", null, { codec: syncStatus }); }
      catch (e) {
        if (isMdbaseError(e, "unavailable") && session.closed && !this.closing && this.opts.reconnect !== false) continue;
        throw e;
      }
      if (session !== this.session || session.closed) {
        if (this.closing) throw mdbaseError("unavailable", "client closed");
        continue;
      }
      this.setStatus(s); return s;
    }
  }

  /**
   * Read the retained historical chain at a captured hosted fence. READ/session
   * authorization is unchanged. No automatic retry/reconnect: a handover must
   * revalidate the authenticated session and all readiness gates after any await.
   * Missing chain or any error means remain hosted; never substitute asOf or the
   * current head/generations. Decoding does not authenticate a witness or switch.
   */
  async appliedPrefix(seq: number, signal?: AbortSignal): Promise<AppliedPrefix> {
    const p = appliedPrefixParams.enc({ seq });
    const r = await this.call("applied_prefix", p, {
      codec: appliedPrefixCodec, retry: false, ...(signal ? { signal } : {}),
    });
    if (r.seq !== seq || (r.chain !== undefined && (seq === 0 || r.appliedThrough < seq))) {
      throw mdbaseError("invalid_request", "applied_prefix: inconsistent historical proof", "prefix_response");
    }
    return r;
  }

  /** Call `fn` with the status now and on every change (pushed, ≤ 4/s). */
  onStatus(fn: (s: SyncStatus) => void): () => void {
    this.statusListeners.add(fn);
    fn(this.lastStatus);
    if (!this.statusSubscribed) {
      this.statusSubscribed = true;
      void this.call("subscribe_status", null, { retry: true }).catch(() => {});
    }
    return () => this.statusListeners.delete(fn);
  }

  private setStatus(s: SyncStatus): void {
    if (this.fenceReads) {
      if (this.readFencedAt !== null && s.confirmedThrough >= this.readFencedAt) {
        this.readFencedAt = null;
        this.wakeReadFence();
      }
      if (this.readFencedAt === null) this.readFloor = Math.max(this.readFloor, s.confirmedThrough);
    }
    this.lastStatus = s;
    for (const fn of [...this.statusListeners]) fn(s);
  }

  // ---------------------------------------------------------------- reads (§4)

  /** Catalog summary: types with their contract implementations, contracts, settings (§4.4). */
  describe(signal?: AbortSignal): Promise<DescribeResult> {
    return this.call("describe", null, { codec: describeResult, retry: true, ...(signal ? { signal } : {}) });
  }

  /**
   * Core's temporal typing for top-level fields under a query's exact `types` OR list
   * (`date` / `date_time` only when every type agrees; otherwise `none`). The answer is
   * bound to a catalog generation; nested paths are `none`. The SDK never infers typing.
   */
  describeTyping(types: readonly string[], paths: readonly string[], signal?: AbortSignal): Promise<DescribeTypingResult> {
    const strings = (a: readonly string[], max: number) =>
      Array.isArray(a) && a.length <= max && a.every((s) => typeof s === "string" && s.length > 0 && s.length <= 1024);
    if (!strings(types, DESCRIBE_TYPING_MAX_TYPES) || !strings(paths, DESCRIBE_TYPING_MAX_PATHS)) {
      return Promise.reject(mdbaseError("invalid_request", "describe_typing: at most 64 types and 256 non-empty paths", "typing_bounds"));
    }
    return this.call("describe_typing", params([[0, [...types]], [1, [...paths]]]), {
      codec: describeTypingResult, retry: true, ...(signal ? { signal } : {}),
    }).then((r) => {
      if (r.fields.length !== paths.length || r.fields.some((f, i) => f.path !== paths[i])) {
        throw mdbaseError("internal", "describe_typing answered for different paths", "invalid_typing_response");
      }
      return r;
    });
  }

  /** One record by ID or path. Throws `not_found`. */
  get(ref: RecordRef, include?: Include, signal?: AbortSignal): Promise<RecordView> {
    return this.call(
      "get",
      params([
        [0, refValue(ref)],
        [1, includeValue(include)],
      ]),
      { codec: recordView, retry: true, ...(signal ? { signal } : {}) },
    );
  }

  /** One record, or `null` when there is none. */
  async find(ref: RecordRef, include?: Include, signal?: AbortSignal): Promise<RecordView | null> {
    try {
      return await this.get(ref, include, signal);
    } catch (e) {
      if (isMdbaseError(e, "not_found")) return null;
      throw e;
    }
  }

  /**
   * One page of a query, evaluated by the replica (body predicates and links
   * included, §4). Pass `result.cursor` back as `query.cursor` for the next.
   * `opts.contract` is not supported by the live replica dispatch. Supplying it
   * returns `invalid_request` with reason `unknown_param`; no contract filter
   * is applied. The option remains encoded unchanged for API compatibility.
   */
  query(query: Query, include?: Include, signal?: AbortSignal, opts: { contract?: string } = {}): Promise<QueryResult> {
    return this.call(
      "query",
      params([
        [0, toValue(query)],
        [1, includeValue(include)],
        [2, opts.contract],
      ]),
      { codec: queryResult, retry: true, ...(signal ? { signal } : {}) },
    );
  }

  /** Records whose links resolve to `target` (index-backed, §4.2). */
  backlinks(
    target: RecordRef,
    o: { include?: Include; limit?: number; cursor?: string; signal?: AbortSignal } = {},
  ): Promise<BacklinksResult> {
    return this.call(
      "backlinks",
      params([
        [0, refValue(target)],
        [1, includeValue(o.include)],
        [2, o.limit],
        [3, o.cursor],
      ]),
      { codec: backlinksResult, retry: true, ...(o.signal ? { signal: o.signal } : {}) },
    );
  }

  /** Definitions: `mdbase.yaml`, type files, contract files (§4.1). */
  readonly resources = {
    get: (path: string, signal?: AbortSignal): Promise<ResourceView> =>
      this.call("get_resource", params([[0, path]]), { codec: resourceView, retry: true, ...(signal ? { signal } : {}) }),
    /** One bounded resource inventory page. Text defaults to false; limit defaults
     * to 64 (maximum 128). Preserve folder/text/limit on continuation. Collect all
     * pages before assessing a complete snapshot; stale/expired cursors require
     * explicit reassessment, never an automatic restart. */
    list: (o: { folder?: string; text?: boolean; cursor?: string; limit?: number; signal?: AbortSignal } = {}) =>
      this.call(
        "list_resources",
        params([
          [0, o.folder],
          [1, o.text],
          [2, o.cursor],
          [3, o.limit],
        ]),
        { codec: listResourcesResult, retry: true, ...(o.signal ? { signal: o.signal } : {}) },
      ),
    /**
     * Write a resource. CAS: pass the revision you read as `baseRevision`, or
     * `mustNotExist` to create only (a taken path is `conflict` / `path_taken`). Not both.
     */
    put: (
      path: string,
      doc: string,
      o: WriteOptions & { baseRevision?: string; mustNotExist?: boolean } = {},
    ): Promise<Write> => {
      if (o.baseRevision && o.mustNotExist) {
        return Promise.reject(mdbaseError("invalid_request", "baseRevision and mustNotExist are exclusive"));
      }
      return this.one(
        {
          kind: "resource_put",
          path,
          doc,
          ...(o.baseRevision ? { baseRevision: o.baseRevision } : {}),
          ...(o.mustNotExist ? { mustNotExist: true } : {}),
        },
        o,
      );
    },
    delete: (path: string, o: WriteOptions & { baseRevision?: string } = {}): Promise<Write> =>
      this.one({ kind: "resource_delete", path, ...(o.baseRevision ? { baseRevision: o.baseRevision } : {}) }, o),
  };

  /** Saved views (§4.3). Write view sources with ordinary record ops. */
  readonly views = {
    list: (folder?: string, signal?: AbortSignal) =>
      this.call("list_views", params([[0, folder]]), { codec: listViewsResult, retry: true, ...(signal ? { signal } : {}) }),
    execute: (
      source: RecordRef,
      view: string,
      o: { context?: RecordRef; limit?: number; offset?: number; timezone?: string; include?: Include; signal?: AbortSignal } = {},
    ): Promise<QueryResult> =>
      this.call(
        "execute_view",
        params([
          [0, refValue(source)],
          [1, view],
          [2, o.context ? refValue(o.context) : undefined],
          [3, o.limit],
          [4, o.offset],
          [5, o.timezone],
          [6, includeValue(o.include)],
        ]),
        { codec: queryResult, retry: true, ...(o.signal ? { signal: o.signal } : {}) },
      ),
    readSource: (source: RecordRef, signal?: AbortSignal): Promise<ViewSourceDocument> =>
      this.call("read_view_source", params([[0, refValue(source)]]), {
        codec: viewSourceDocument,
        retry: true,
        ...(signal ? { signal } : {}),
      }),
  };

  /**
   * This session's pending mutations, oldest first (§6): recover after a reload, then
   * follow each with `awaitReceipt`. Pages through everything.
   */
  async pendingWrites(signal?: AbortSignal): Promise<PendingMutation[]> {
    const out: PendingMutation[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.call(
        "list_pending",
        params([[0, after ? uuidCodec.enc(after) : undefined]]),
        { codec: listPendingResult, retry: true, ...(signal ? { signal } : {}) },
      );
      out.push(...page.pending);
      if (!page.next) return out;
      after = page.next;
    }
  }

  /**
   * What a rename would do to links (dry run, §5): the rewrites, and links left broken.
   * Throws the problem the real rename would get.
   */
  async preflightRename(target: RecordView, to: string, o: { updateRefs?: boolean } = {}): Promise<Preflight> {
    return this.preflight({ kind: "rename", id: target.id, from: target.path, to, updateRefs: o.updateRefs ?? true });
  }

  /** Links a delete would break (dry run, §5). */
  async preflightDelete(target: RecordRef): Promise<Preflight> {
    return this.preflight({ kind: "delete", id: refId(target) });
  }

  private async preflight(op: Op): Promise<Preflight> {
    const [w] = await this.submit([op], { dryRun: true });
    const r = w!.receipt;
    if (r.state === "rejected") throw new MdbaseError(r.problem!);
    return r.preflight ?? { rewrites: [], broken: [] };
  }

  /** Every page of a query. Cursor resets require explicit caller clearing;
   * otherwise cursor_expired/cursor_stale is thrown unchanged. */
  async *pages(query: Query, include?: Include, signal?: AbortSignal, options: PagesOptions = {}): AsyncGenerator<QueryResult> {
    const original = snapshotQueryValue(query) as Query;
    const originalInclude = include ? { ...include } : undefined;
    let cursor = original.cursor, restarted = false, pagesYielded = 0;
    delete original.cursor;
    for (;;) {
      signal?.throwIfAborted();
      let page: QueryResult;
      try {
        page = await this.query(cursor !== undefined ? { ...original, cursor } : { ...original }, originalInclude, signal);
      } catch (error) {
        if (!options.onReset || restarted || !isMdbaseError(error, "invalid_request") || error.recovery !== "fix_request" ||
            (error.reason !== "cursor_expired" && error.reason !== "cursor_stale")) throw error;
        signal?.throwIfAborted();
        await options.onReset({ reason: error.reason, error, pagesYielded, ...(signal ? { signal } : {}) });
        signal?.throwIfAborted();
        restarted = true;
        cursor = undefined;
        pagesYielded = 0;
        continue;
      }
      signal?.throwIfAborted();
      yield page;
      pagesYielded++;
      if (!page.cursor) return;
      cursor = page.cursor;
    }
  }

  /**
   * A live query. Subscribe for pushes; keep lists cheap with a `limit` window and no
   * bodies, and widen the window with `setQuery`.
   */
  live(query: Query, include?: Include): LiveQuery {
    const l = new LiveQuery(this, query, include);
    this.lives.add(l);
    void this._resubscribeLive(l, true);
    return l;
  }

  /** @internal */
  async _resubscribeLive(l: LiveQuery, first = false, forSession?: Session): Promise<void> {
    const old = l._sub;
    if (old !== null) {
      this.livesBySub.delete(old);
      l._setSub(null);
      void this.call("unsubscribe", params([[0, old]])).catch(() => {});
    }
    try {
      const s = await this.readyForRead();
      if (this.fenceReads && (l.closed || (forSession && forSession !== s))) return;
      this.subscribing++;
      let id: number;
      try {
        const r = await s.request("subscribe", l._params());
        id = uint.dec((r as Map<number, CborValue>).get(0) ?? null);
      } finally {
        this.subscribing--;
      }
      const early = this.early.get(id) ?? [];
      this.early.delete(id);
      if (this.subscribing === 0) this.early.clear();
      if (l.closed || (this.fenceReads && (s !== this.session || s.closed))) {
        void s.request("unsubscribe", params([[0, id]])).catch(() => {});
        return;
      }
      l._setSub(id);
      this.livesBySub.set(id, l);
      for (const u of early) l._apply(u);
    } catch (e) {
      const err = schemaToError(e, "subscribe");
      // A dropped link is retried by the reconnect loop; anything else is the query's error.
      if (!(isMdbaseError(err, "unavailable") && this.linkState === "reconnecting")) l._fail(err, first);
    }
  }

  /** @internal */
  _closeLive(l: LiveQuery): void {
    this.lives.delete(l);
    const id = l._sub;
    if (id !== null) {
      this.livesBySub.delete(id);
      void this.call("unsubscribe", params([[0, id]])).catch(() => {});
    }
  }

  /** One page of the change feed. A `reset: true` result means "re-read what you cache". */
  changes(cursor?: string, limit?: number, signal?: AbortSignal): Promise<ChangesResult> {
    return this.call(
      "changes",
      params([
        [0, cursor ?? null],
        [1, limit],
      ]),
      { codec: changesResult, retry: true, ...(signal ? { signal } : {}) },
    );
  }

  /**
   * Follow the change feed from `cursor`. `onChanges` gets every batch; `reset: true`
   * means the app must re-read what it caches. Survives reconnects.
   * `ready` confirms the first watch ACK, not a complete/current collection cache.
   * After reconnect, observe `state`; an already-resolved promise is not freshness.
   */
  watchChanges(cursor: string | undefined, onChanges: (batch: ChangesResult) => void): ChangesWatch {
    let last = cursor, stopped = false, epoch = 0;
    let state: ChangesWatchState = "starting", error: MdbaseError | null = null;
    let active: Session | null = null, controller: AbortController | null = null;
    let offPush: (() => void) | null = null, offClose: (() => void) | null = null;
    let clearEarly = () => {};
    let resolveReady!: () => void, rejectReady!: (e: MdbaseError) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    // Legacy callers may use only the callable stop function.
    ready.catch(() => {});
    const listeners = new Set<(state: ChangesWatchState, error: MdbaseError | null) => void>();
    const notify = (listener: (state: ChangesWatchState, error: MdbaseError | null) => void) => {
      try { listener(state, error); } catch { /* Observer exceptions cannot break cleanup. */ }
    };
    const publish = (next: ChangesWatchState, why: MdbaseError | null = null) => {
      state = next; error = why;
      for (const listener of [...listeners]) notify(listener);
    };
    const release = () => {
      offPush?.(); offPush = null; offClose?.(); offClose = null;
      const pending = controller; controller = null;
      clearEarly(); clearEarly = () => {};
      pending?.abort();
      active = null;
    };
    const detach = () => {
      this.restorers = this.restorers.filter(f => f !== start);
      offLink();
    };
    const fail = (why: MdbaseError) => {
      if (stopped) return;
      stopped = true; epoch++; release(); detach(); rejectReady(why);
      publish("failed", why); listeners.clear();
    };
    const stop = () => {
      if (state === "closed") return;
      stopped = true; epoch++; release(); detach();
      rejectReady(mdbaseError("cancelled", "change watch closed"));
      publish("closed"); listeners.clear();
    };
    const start = async (s: Session) => {
      if (stopped || s.closed || s !== this.session || active === s) return;
      epoch++; release(); active = s;
      const generation = epoch;
      const current = () => !stopped && generation === epoch && !s.closed && s === this.session;
      controller = new AbortController();
      const signal = controller.signal;
      try { await this.readFence(signal); } catch (e) { if (current()) fail(schemaToError(e, "changes watch")); return; }
      if (!current()) return;
      let initial = true, early: ChangesResult[] = [], weight = 0;
      clearEarly = () => { early.length = 0; weight = 0; };
      const deliver = (batch: ChangesResult) => {
        if (!current()) return;
        last = batch.cursor;
        try { onChanges(batch); } catch { /* Consumer owns its callback failure. */ }
      };
      offClose = s.onClose(why => {
        if (stopped || generation !== epoch) return;
        epoch++; release();
        const problem = why ?? mdbaseError("unavailable", "change watch session closed");
        rejectReady(problem); publish("stale", problem);
      });
      offPush = s.onPush("changes", payload => {
        if (!current()) return;
        try {
          const batch = changesResult.dec(payload);
          if (!initial) { deliver(batch); return; }
          // A batched transport can deliver pushes before the request continuation.
          // Bound retained startup metadata without making a measured-heap claim.
          const charge = 64 + batch.cursor.length * 2 + batch.changes.reduce((n, c) => n + 384 + c.path.length * 2, 0);
          if (early.length >= 16 || weight + charge > 1024 * 1024) {
            fail(mdbaseError("unavailable", "change watch startup buffer exceeded")); return;
          }
          weight += charge; early.push(batch);
        } catch (e) { fail(schemaToError(e, "changes push")); }
      });
      publish("starting");
      if (!current()) return;
      try {
        const first = await s.request("changes", params([[0, last ?? null], [2, true]]), { codec: changesResult, signal });
        if (!current()) return;
        last = first.cursor;
        if (first.changes.length || first.reset) deliver(first);
        while (early.length && current()) deliver(early.shift()!);
        clearEarly(); initial = false;
        if (!current()) return;
        publish("active");
        if (current()) resolveReady();
      } catch (e) {
        if (current()) fail(schemaToError(e, "changes watch"));
      }
    };
    const offLink = this.onLink((link, why) => {
      if (link === "closed") {
        if (why) fail(why); else stop();
      }
    });
    this.onSession(start);
    void this.ready().then(start).catch(e => fail(schemaToError(e, "changes watch")));
    const watch = Object.assign(stop, { ready, subscribe: (listener: (state: ChangesWatchState, error: MdbaseError | null) => void) => {
      if (state !== "closed" && state !== "failed") listeners.add(listener);
      notify(listener);
      return () => { listeners.delete(listener); };
    } });
    Object.defineProperties(watch, { state: { get: () => state }, error: { get: () => error } });
    return Object.freeze(watch) as ChangesWatch;
  }

  validate(refs?: RecordRef[], signal?: AbortSignal): Promise<CborValue> {
    return this.call("validate", params([[0, refs?.map(refValue)]]), { retry: true, ...(signal ? { signal } : {}) });
  }

  /** Independent native app-host Bases READ, exact original held session.
   * Unsupported transports refuse: no generic execute_view/data fallback. */
  async executeAppBases(request: AppBasesRequest, signal?: AbortSignal): Promise<AppBasesResult> {
    const window = request.window === undefined ? null : {...request.window};
    const bytes = encodeAppBasesRequest({...request, ...(window === null ? {} : {window})});
    const session = await this.readyForRead(signal);
    const reply = await session.readAppBases(bytes, signal);
    if (session !== this.session || session.closed || this.readFencedAt !== null) throw mdbaseError("unavailable", "original Bases session is no longer current");
    try { return decodeAppBasesResult(reply, window); }
    catch (error) { throw schemaToError(error, "app Bases result"); }
  }

  /** One bounded native discovery page. Empty views do not mean EOF when a
   * continuation is present. Supplied handles never silently restart/retry. */
  async listAppBasesViews(request: AppBasesDiscoveryRequest, signal?: AbortSignal): Promise<AppBasesDiscoveryResult> {
    const limit = request.limit, bytes = encodeAppBasesDiscoveryRequest(request);
    const session = await this.readyForRead(signal);
    const reply = await session.readAppBasesDiscovery("list-views",bytes,signal);
    try {
      if (session !== this.session || session.closed || this.readFencedAt !== null) throw mdbaseError("unavailable", "original Bases session is no longer current");
      return decodeAppBasesDiscoveryResult(reply,limit);
    } catch (error) { throw schemaToError(error,"app Bases discovery"); }
    finally { reply.fill(0); }
  }

  /** Exact current source for one native UUID/SHA/original ordinal, never path
   * aliases, inferred catalog entries, generic RPC or cached document fallback. */
  async readAppBasesViewSource(request: AppBasesSourceRequest, signal?: AbortSignal): Promise<AppBasesSourceResult> {
    const original = {...request}, bytes = encodeAppBasesSourceRequest(original);
    const session = await this.readyForRead(signal);
    const reply = await session.readAppBasesDiscovery("read-view-source",bytes,signal);
    try {
      if (session !== this.session || session.closed || this.readFencedAt !== null) throw mdbaseError("unavailable", "original Bases session is no longer current");
      return decodeAppBasesSourceResult(reply,original);
    } catch (error) { throw schemaToError(error,"app Bases exact source"); }
    finally { reply.fill(0); }
  }

  listViews(signal?: AbortSignal): Promise<CborValue> {
    return this.call("list_views", null, { retry: true, ...(signal ? { signal } : {}) });
  }

  executeView(p: PlainValue, signal?: AbortSignal): Promise<CborValue> {
    return this.call("execute_view", toValue(p), { retry: true, ...(signal ? { signal } : {}) });
  }

  // ---------------------------------------------------------------- writes (§5, §6)

  /** Submit operations as one mutation (or one per op with `allowPartial`). */
  async submit(ops: Op[], o: WriteOptions & { allowPartial?: boolean } = {}): Promise<Write[]> {
    const p: SubmitParams = { ops, mutationId: o.mutationId ?? uuidv7() };
    if (o.allowPartial) {
      p.allowPartial = true;
      p.mutationIds = ops.map((_, i) => (i === 0 ? p.mutationId! : uuidv7()));
    }
    if (o.conflictMode) p.conflictMode = o.conflictMode;
    if (o.timezone) p.timezone = o.timezone;
    if (o.dryRun) p.dryRun = true;
    if (o.include) p.include = o.include;
    if (o.wait) p.wait = o.wait;
    // Idempotent by mutation ID: safe to resubmit after a dropped link.
    const receipts = await this.call("submit", submitParams.enc(p), {
      codec: submitResult,
      retry: true,
      ...(o.signal ? { signal: o.signal } : {}),
    });
    return receipts.map((r) => (o.dryRun ? new Write(r) : this._track(r)));
  }

  private async one(op: Op, o: WriteOptions): Promise<Write> {
    const [w] = await this.submit([op], o);
    return w!;
  }

  /** Create a record. The ID is minted here, so the app can use it before confirmation. */
  create(input: CreateInput, o: WriteOptions = {}): Promise<Write> {
    const op: Op = { kind: "create", id: input.id ?? uuidv7() };
    if (input.path !== undefined) op.path = input.path;
    if (input.type !== undefined) op.type = input.type;
    if (input.frontmatter !== undefined) op.frontmatter = toFmMap(input.frontmatter);
    if (input.body !== undefined) op.body = input.body;
    if (input.document !== undefined) op.document = input.document;
    return this.one(op, o);
  }

  /**
   * Update a record by field-level intent. Pass the `RecordView` you edited from, and
   * the SDK sends `base` for every key you set or unset, and the body as a 3-way merge,
   * so concurrent edits merge instead of last-writer-wins.
   */
  update(target: RecordRef, changes: UpdateInput, o: WriteOptions = {}): Promise<Write> {
    return this.one(this.updateOp(target, changes), o);
  }

  /** @internal Build an `update` op (exposed for batching with `submit`). */
  updateOp(target: RecordRef, c: UpdateInput): Op & { kind: "update" } {
    const op: Op & { kind: "update" } = { kind: "update", id: refId(target) };
    const seen = typeof target === "object" && "frontmatter" in target ? (target as RecordView) : null;
    if (c.patch) op.patch = toFmMap(c.patch);
    if (c.unset?.length) op.unset = c.unset;
    if (c.add) op.add = new Map(Object.entries(c.add).map(([k, v]) => [k, v.map(toValue)]));
    if (c.remove) op.remove = new Map(Object.entries(c.remove).map(([k, v]) => [k, v.map(toValue)]));
    if (c.ifRevision) op.ifRevision = c.ifRevision;
    if (c.bodyEdits?.length) {
      op.bodyEdits = c.bodyEdits;
      const base = c.bodyBase ?? (seen?.body !== undefined ? revisionOf(seen.body) : undefined);
      if (!base) throw mdbaseError("invalid_request", "bodyEdits need bodyBase (or a RecordView read with its body)");
      op.bodyBase = base;
    } else if (c.body !== undefined) {
      if (seen?.body !== undefined && c.bodyBase === undefined) {
        // Small edits travel as edits; the replica merges them against the base.
        const edits = diffEdits(seen.body, c.body);
        if (edits.length) {
          op.bodyEdits = edits;
          op.bodyBase = revisionOf(seen.body);
        }
      } else {
        op.body = c.body;
        if (c.bodyBase) op.bodyBase = c.bodyBase;
      }
    }
    if (seen) {
      const base: BaseField[] = [];
      const touched = [...(op.patch?.keys() ?? []), ...(op.unset ?? [])];
      for (const k of new Set(touched)) {
        const v = seen.frontmatter.get(k);
        base.push(v === undefined ? { key: k } : { key: k, observed: v });
      }
      if (base.length) op.base = base;
    }
    // Drop patch keys whose value didn't change from what was read: no-op writes
    // should not create conflicts.
    if (seen && op.patch) {
      for (const [k, v] of [...op.patch]) {
        const cur = seen.frontmatter.get(k);
        if (cur !== undefined && valueEquals(cur, v)) {
          op.patch.delete(k);
          op.base = op.base?.filter((b) => b.key !== k);
        }
      }
      if (op.patch.size === 0) delete op.patch;
      if (op.base?.length === 0) delete op.base;
    }
    return op;
  }

  /** Replace a record's whole document. */
  replaceDocument(target: RecordRef, document: string, o: WriteOptions & { ifRevision?: string } = {}): Promise<Write> {
    const seen = typeof target === "object" && "path" in target && "revision" in target ? (target as RecordView) : null;
    const op: Op = { kind: "document", id: refId(target), new: { path: seen?.path ?? "", doc: document } };
    if (!seen) throw mdbaseError("invalid_request", "replaceDocument needs the RecordView it was edited from");
    if (seen.document !== undefined) op.base = { path: seen.path, doc: seen.document };
    if (o.ifRevision) op.ifRevision = o.ifRevision;
    return this.one(op, o);
  }

  /** Delete a record. With a RecordView, a concurrent change supersedes the delete. */
  delete(target: RecordRef, o: WriteOptions & { ifRevision?: string } = {}): Promise<Write> {
    const op: Op = { kind: "delete", id: refId(target) };
    if (typeof target === "object" && "revision" in target) op.baseRevision = (target as RecordView).revision;
    if (o.ifRevision) op.ifRevision = o.ifRevision;
    return this.one(op, o);
  }

  /** Rename (move) a record; `updateRefs` rewrites links to it (default true). */
  rename(
    target: RecordView,
    to: string,
    o: WriteOptions & { updateRefs?: boolean; ifRevision?: string } = {},
  ): Promise<Write> {
    const op: Op = { kind: "rename", id: target.id, from: target.path, to, updateRefs: o.updateRefs ?? true };
    if (o.ifRevision) op.ifRevision = o.ifRevision;
    return this.one(op, o);
  }

  /** @internal Track a receipt the replica returned outside `submit`. */
  _track(r: Receipt): Write {
    this.noteReceipt(r);
    let initial = r;
    const later = this.unclaimed.get(r.mutation);
    if (later) {
      this.unclaimed.delete(r.mutation);
      // Reconcile BEFORE constructing Write: a confirmed response that omits
      // publication is not the no-files case when a buffered push knows it.
      // Preserve response confirmation/seq/relocation/records over early pending
      // publication. Rejected/unknown response outcomes always remain refusals.
      initial = mergePublication(r, later);
      if (r.state === "pending" || (r.state === "confirmed" && (later.state === "rejected" || later.state === "unknown"))) {
        initial = mergePublication({ ...r, ...later }, initial);
      }
    }
    let w = this.writes.get(r.mutation);
    if (w) w.update(initial);
    else w = new Write(initial);
    if (needsReceipt(w.receipt)) this.writes.set(r.mutation, w);
    else this.writes.delete(r.mutation);
    return w;
  }

  /** The current receipt of a mutation. */
  receipt(mutation: Uuid, signal?: AbortSignal): Promise<Receipt> {
    return this.call("receipt", params([[0, uuidCodec.enc(mutation)]]), {
      codec: receiptCodec,
      retry: true,
      ...(signal ? { signal } : {}),
    });
  }

  /** Resolves when the receipt leaves `pending`, or at `timeoutMs` with the pending receipt. */
  awaitReceipt(mutation: Uuid, timeoutMs?: number, signal?: AbortSignal): Promise<Receipt> {
    return this.call(
      "await",
      params([
        [0, uuidCodec.enc(mutation)],
        [1, timeoutMs],
      ]),
      { codec: receiptCodec, retry: true, ...(signal ? { signal } : {}) },
    );
  }

  // ---------------------------------------------------------------- holds and conflicts (§8)

  listHolds(signal?: AbortSignal): Promise<Hold[]> {
    return this.call("list_holds", null, { codec: list(hold), retry: true, ...(signal ? { signal } : {}) });
  }

  /** Call `fn` with the holds now and on every change. */
  onHolds(fn: (h: Hold[]) => void): () => void {
    const w = this.holdsWatch;
    w.listeners.add(fn);
    if (w.last) fn(w.last);
    if (w.listeners.size === 1) void this.refreshHolds(true).catch(() => {});
    return () => w.listeners.delete(fn);
  }

  private async refreshHolds(subscribe: boolean): Promise<void> {
    if (subscribe) await this.call("subscribe_holds", null, { retry: true });
    this.emitHolds(await this.listHolds());
  }

  private emitHolds(h: Hold[]): void {
    this.holdsWatch.last = h;
    for (const fn of [...this.holdsWatch.listeners]) fn(h);
  }

  /** Resolve a hold. Submits an ordinary mutation and returns its write. */
  async resolveHold(id: Uuid, how: HoldResolution, use?: string): Promise<Write> {
    const r = await this.call(
      "resolve_hold",
      params([
        [0, uuidCodec.enc(id)],
        [1, holdResolution.enc(how)],
        [2, use],
      ]),
      { codec: receiptCodec },
    );
    return this._track(r);
  }

  listConflicts(record?: Uuid, signal?: AbortSignal): Promise<ConflictEntry[]> {
    return this.call("list_conflicts", record ? params([[0, uuidCodec.enc(record)]]) : null, {
      codec: list(conflictEntry),
      retry: true,
      ...(signal ? { signal } : {}),
    });
  }

  onConflicts(fn: (c: ConflictEntry[]) => void): () => void {
    const w = this.conflictsWatch;
    w.listeners.add(fn);
    if (w.last) fn(w.last);
    if (w.listeners.size === 1) void this.refreshConflicts(true).catch(() => {});
    return () => w.listeners.delete(fn);
  }

  private async refreshConflicts(subscribe: boolean): Promise<void> {
    if (subscribe) await this.call("subscribe_conflicts", null, { retry: true });
    this.emitConflicts(await this.listConflicts());
  }

  private emitConflicts(c: ConflictEntry[]): void {
    this.conflictsWatch.last = c;
    for (const fn of [...this.conflictsWatch.listeners]) fn(c);
  }

  /** Accept what the record kept. */
  dismissConflict(entry: ConflictEntry, o: WriteOptions = {}): Promise<Write> {
    return this.one({ kind: "conflict_dismiss", mutation: entry.mutation, record: entry.conflict.id }, o);
  }

  /** Resolve a field conflict with a chosen value, dismissing it in the same mutation. */
  async resolveConflict(entry: ConflictEntry, field: string, chosen: PlainValue, o: WriteOptions = {}): Promise<Write> {
    const [w] = await this.submit(
      [
        { kind: "update", id: entry.conflict.id, patch: new Map([[field, toValue(chosen)]]) },
        { kind: "conflict_dismiss", mutation: entry.mutation, record: entry.conflict.id },
      ],
      o,
    );
    return w!;
  }

  // ---------------------------------------------------------------- private collections (§8.3)

  /**
   * Devices waiting for approval in a private collection. Offered only to the app
   * hosting the replica (no grant). `exchangeReady` is challenge/reveal readiness,
   * NOT approval/key delivery. Never display a legacy `sas` from this response.
   */
  pendingDevices(signal?: AbortSignal): Promise<PendingDevice[]> {
    return this.call("pending_devices", null, { codec: list(pendingDevice), retry: true, ...(signal ? { signal } : {}) });
  }

  /**
   * Confirm with the six digits the HUMAN TYPED from the requesting device's local
   * display. Never copy a code from pending metadata or an approver push. The
   * replica checks the current context and awaits the actual approval disposition.
   */
  approveDevice(device: Uuid, sas: string): Promise<void> {
    if (!/^\d{6}$/.test(sas)) {
      return Promise.reject(mdbaseError("invalid_request", "the code is six digits", "invalid_sas"));
    }
    return this.call(
      "approve_device",
      params([
        [0, uuidCodec.enc(device)],
        [1, sas],
      ]),
    ).then(() => {});
  }

  /** Stop offering a device here. Revoking it is a control-plane action. */
  rejectDevice(device: Uuid): Promise<void> {
    return this.call("reject_device", params([[0, uuidCodec.enc(device)]])).then(() => {});
  }

  /**
   * The account key (AK1 §6; hosting app only, never over a cloud-copy thin session).
   * `secret` is the 32-byte account secret `R`; the replica derives the collection's
   * recovery device from it and drops it. The SDK keeps no copy.
   */
  readonly accountKey = {
    /** Setup step 2: check the enrolment and key the recovery device (an ordinary mutation). */
    setup: async (secret: Uint8Array): Promise<Write> => {
      accountSecret(secret);
      const r = await this.call("account_key_setup", params([[0, secret]]), { codec: receiptCodec });
      return this._track(r);
    },
    /** Unlock step 3: start the recovery-signed self-grant; poll `status` until `keyed` or `refused`. */
    unlock: async (secret: Uint8Array): Promise<void> => {
      accountSecret(secret);
      await this.call("account_key_unlock", params([[0, secret]]));
    },
    status: (signal?: AbortSignal): Promise<AccountKeyStatus> =>
      this.call("account_key_status", null, { codec: accountKeyStatus, retry: true, ...(signal ? { signal } : {}) }),
  };

  /** Recovery key for a private collection (hosting app only). */
  readonly recoveryKey = {
    /** Whether a recovery key is set up for this collection. */
    status: (): Promise<RecoveryKeyStatus> =>
      this.call("recovery_key_status", null, { codec: recoveryKeyStatus, retry: true }),
    /**
     * Create a recovery key. The returned phrase is shown to the user once and never
     * stored by the SDK; the replica keys a recovery device with it.
     */
    create: (): Promise<{ phrase: string; device: Uuid }> =>
      this.call("recovery_key_create", null, { codec: recoveryKeyCreated }),
    /** Join this device using a recovery phrase (when no other device is available). */
    import: (phrase: string): Promise<void> =>
      this.call("recovery_key_import", params([[0, phrase.trim()]])).then(() => {}),
  };

  // ---------------------------------------------------------------- editor fence (§14)

  /**
   * Offer the editor fence: the replica will route changes to open files through
   * `handler`. Requires the "fence" feature in `hello`.
   */
  offerFence(handler: FenceHandler): void {
    this.fenceHandler = handler;
  }

  /** Report the files open in editors (on open, close, dirty change, and after saves). */
  reportFence(open: FenceReportEntry[]): Promise<void> {
    return this.call("fence_report", fenceReport.enc({ open }), { retry: true }).then(() => {});
  }
}

/** Connect to a replica. */
export function connect(opts: ClientOptions): Promise<MdbaseClient> {
  return MdbaseClient.connect(opts);
}

export type { FmMap, Value };
