import type { ConnectProblem, JsonObject } from "@mdbase-dev/connect-protocol";
import { MdbaseConnectError, connectProblem, connectError } from "./errors.js";
import { connectFailure, connectSuccess, type ConnectOutcome } from "./outcomes.js";
import type { CollectionChange, CollectionChangesPage, ChangesInput, ConnectRequestOptions, QueryInput, QueryRecord, QueryPage, QueryPagesOptions, QueryMetadataInput, QueryMetadataRecord, QueryMetadataResult, QueryAllOptions, QueryResult, ReadManyOptions, ReadManyResult, WatchOptions, WatchStatus } from "./operation-types.js";

interface ObserveSource<F extends JsonObject> {
  changes(input?: ChangesInput, options?: ConnectRequestOptions): Promise<ConnectOutcome<CollectionChangesPage>>;
  watch(options?: WatchOptions): AsyncIterable<ConnectOutcome<CollectionChange>>;
  readMany(paths: readonly string[], options?: ReadManyOptions): Promise<ConnectOutcome<ReadManyResult<F>>>;
  queryPages(input: QueryInput, options?: QueryPagesOptions<F>): AsyncIterable<ConnectOutcome<QueryPage<F>>>;
  queryAll(input: QueryMetadataInput, options?: QueryAllOptions<JsonObject, QueryMetadataRecord>): Promise<ConnectOutcome<QueryMetadataResult>>;
  queryAll(input: QueryInput, options?: QueryAllOptions<F>): Promise<ConnectOutcome<QueryResult<F>>>;
}

export interface ObserveOptions {
  mode?: "watch" | "manual";
  /** Opt into targeted membership checks for predicates whose dependencies are path-local. */
  invalidation?: "paths" | "collection";
  signal?: AbortSignal;
  firstPageSize?: number;
  pageSize?: number;
  coalesceMs?: number;
  /** Backlog above this bound causes a full reconciliation, not dropped paths. */
  maxPendingPaths?: number;
  watch?: Omit<WatchOptions, "cursor" | "signal" | "onStatus">;
}
export interface ObserveSnapshot<F extends JsonObject = JsonObject> {
  readonly records: readonly QueryRecord<F>[];
  readonly state: "loading" | "ready" | "error" | "closed";
  readonly generation: number;
  readonly total?: number;
  readonly problem: ConnectProblem | null;
  readonly watchStatus: WatchStatus | null;
}
export interface ObserveDelta<F extends JsonObject = JsonObject> {
  readonly reason: "page" | "reload" | "changes" | "local" | "status";
  readonly upserts: readonly QueryRecord<F>[];
  readonly removed: readonly string[];
}
export interface ObserveOverlay {
  /** Call only after the write succeeds; rereads retire this overlay, not newer ones. */
  commit(): void;
  rollback(): void;
}

/** Collection-owned query synchronization. No drafts, domain indexes or persistence. */
export class MdbaseQueryObserver<F extends JsonObject = JsonObject> {
  private records = new Map<string, QueryRecord<F>>();
  private overlays = new Map<string, { token: object; record: QueryRecord<F> | null; committed: boolean }>();
  private pending = new Set<string>();
  private listeners = new Set<(snapshot: ObserveSnapshot<F>, delta: ObserveDelta<F>) => void>();
  private changes = new Set<(change: CollectionChange) => void>();
  private lifetime = new AbortController();
  private request = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private draining = false;
  private removeAbort?: () => void;
  private snapshot: ObserveSnapshot<F> = Object.freeze({ records: Object.freeze([]), state: "loading", generation: 0, problem: null, watchStatus: null });
  readonly ready: Promise<ConnectOutcome<void>>;

  constructor(
    private readonly client: ObserveSource<F>,
    private readonly query: QueryInput,
    private readonly options: ObserveOptions = {},
    private readonly supports?: (id: string, options?: ConnectRequestOptions) => Promise<ConnectOutcome<boolean>>
  ) {
    for (const [name, value] of [["pageSize", options.pageSize], ["firstPageSize", options.firstPageSize], ["maxPendingPaths", options.maxPendingPaths]] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new TypeError(`${name} must be a positive integer.`);
    }
    if (options.coalesceMs !== undefined && (!Number.isFinite(options.coalesceMs) || options.coalesceMs < 0)) throw new TypeError("coalesceMs must be nonnegative.");
    if (query.output !== undefined || query.cursor || query.snapshot || query.groupBy || query.summaries || query.summaryFunctions) throw new TypeError("observe requires a record query, not a continuation or aggregate.");
    // Copy caller-owned criteria; changing a query means opening a new observer.
    this.query = structuredClone(query);
    if (options.signal?.aborted) this.close();
    else if (options.signal) {
      const close = () => this.close();
      options.signal.addEventListener("abort", close, { once: true });
      this.removeAbort = () => options.signal?.removeEventListener("abort", close);
    }
    this.ready = this.refresh();
  }

  getSnapshot = (): ObserveSnapshot<F> => this.snapshot;
  subscribe = (listener: (snapshot: ObserveSnapshot<F>, delta: ObserveDelta<F>) => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  subscribeChanges(listener: (change: CollectionChange) => void): () => void {
    this.changes.add(listener);
    return () => { this.changes.delete(listener); };
  }

  /** Upgrade this observer to body-bearing rows, retaining one synchronization owner. */
  hydrate(): Promise<ConnectOutcome<void>> { this.query.includeBody = true; return this.load(true); }

  refresh(): Promise<ConnectOutcome<void>> { return this.load(); }

  private async load(preserve = false): Promise<ConnectOutcome<void>> {
    if (this.lifetime.signal.aborted) return cancelled();
    this.request.abort();
    this.request = new AbortController();
    const signal = this.request.signal;
    const generation = this.snapshot.generation + 1;
    this.pending.clear();
    clearTimeout(this.timer);
    this.timer = undefined;
    this.publish("status", { state: "loading", generation, problem: null });
    const current = () => !signal.aborted && !this.lifetime.signal.aborted;
    try {
      // Capture BEFORE querying. Watch catches up mutations during every page.
      const baseline = this.options.mode === "manual" ? null : unwrap(await this.client.changes({}, { signal }));
      const accepted = new Map([...this.overlays].filter(([, overlay]) => overlay.committed));
      const loaded = new Map<string, QueryRecord<F>>();
      let stableScan = true;
      const pageOptions = { signal, firstPageSize: this.options.firstPageSize, pageSize: this.options.pageSize };
      // Full-row pages already carry file facts and qualified revisions.
      const pages = this.client.queryPages(this.query, pageOptions)[Symbol.asyncIterator]();
      try {
        for (let next = pages.next(), step = await next; !step.done; step = await next) {
          const page = step.value;
          // One page ahead overlaps transport latency with immutable publication.
          next = pages.next();
          void next.catch(() => undefined); // Also observed by the loop unless cancelled.
          if (!page.ok) throw new MdbaseConnectError(page.problem);
          const value = page.value;
          if (value.page === 0) stableScan = !value.meta?.hasMore || !!(value.cursor || value.snapshot);
          if (!current()) return cancelled();
          const rows = immutable(value.results);
          for (const row of rows) loaded.set(row.path, row);
          const removed = value.page === 0 && !preserve ? this.snapshot.records
            .filter(row => !loaded.has(row.path) && !this.overlays.get(row.path)?.record).map(row => row.path) : [];
          if (value.page === 0 && !preserve) this.records = loaded;
          if (preserve) for (const row of rows) this.records.set(row.path, row);
          this.publish("page", { total: value.meta?.totalCount }, { upserts: rows.filter(row => !this.overlays.has(row.path)), removed });
        }
      } finally { await pages.return?.(); }
      if (!current()) return cancelled();
      this.records = loaded;
      for (const [path, overlay] of accepted) if (this.overlays.get(path) === overlay) this.overlays.delete(path);
      this.publish("reload", { state: "ready", total: loaded.size, problem: null });
      if (baseline) {
        void this.follow(baseline.cursor, signal, stableScan);
        if (this.pending.size) void this.drain(signal);
      }
      return connectSuccess(undefined);
    } catch (error) {
      if (!current()) return cancelled();
      return this.fail(error);
    }
  }

  /** Overlay caller-supplied query rows; no authority write is performed. */
  optimistic(upserts: readonly QueryRecord<F>[] = [], removed: readonly string[] = []): ObserveOverlay {
    if (this.lifetime.signal.aborted) throw new Error("Observer is closed.");
    const token = {};
    const paths = [...new Set([...upserts.map(row => row.path), ...removed])];
    for (const row of upserts) this.overlays.set(row.path, { token, record: immutable(row), committed: false });
    for (const path of removed) this.overlays.set(path, { token, record: null, committed: false });
    this.publish("local");
    return {
      commit: () => {
        for (const path of paths) {
          const overlay = this.overlays.get(path);
          if (overlay?.token === token) {
            overlay.committed = true;
            // An echo may already be in a read begun before this acceptance.
            if (this.draining) this.pending.add(path);
          }
        }
      },
      rollback: () => this.retire(paths, token)
    };
  }

  close(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort();
    this.request.abort();
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    this.records = new Map(this.snapshot.records.map(row => [row.path, row]));
    this.overlays.clear();
    this.removeAbort?.();
    this.publish("status", { state: "closed" });
    this.listeners.clear();
    this.changes.clear();
  }

  private fullReloadRequired(): boolean {
    return this.options.invalidation === "collection" || !!(this.query.contract || this.query.orderBy || this.query.offset !== undefined || this.query.select || this.query.projections
      || (this.options.invalidation !== "paths" && (this.query.where || this.query.context)));
  }

  private async follow(cursor: number, signal: AbortSignal, stableScan: boolean): Promise<void> {
    // Initial ready waiters run before watch; replacements never wait on old ready.
    if (this.snapshot.generation === 1) await this.ready;
    if (signal.aborted) return;
    try {
      for await (const outcome of this.client.watch({ ...this.options.watch, cursor, signal, onStatus: status => {
        if (!signal.aborted) this.publish("status", { watchStatus: immutable(status) });
      } })) {
        if (signal.aborted) return;
        if (!outcome.ok) {
          if (outcome.problem.code === "change_cursor_reset") { void this.refresh(); return; }
          this.fail(new MdbaseConnectError(outcome.problem));
          return;
        }
        const change = immutable(outcome.value);
        for (const listener of this.changes) listener(change);
        if (["reset", "gap", "unknown", "schema.changed", "config.changed", "contract.changed", "view.changed"].includes(change.kind)) {
          void this.refresh(); return;
        }
        const paths = changedPaths(change);
        // Legacy offset-only editor/Writer authorities cannot prove a scan did
        // not skip an unchanged row after a structural shift. Remove when every
        // supported authority supplies cursor/snapshot-pinned pages.
        if (this.fullReloadRequired() || (!stableScan && (change.kind === "record.created" || change.kind === "record.deleted" || change.kind === "record.renamed"))) { void this.refresh(); return; }
        if (!paths.length) continue;
        for (const path of paths) this.pending.add(path);
        if (this.pending.size > (this.options.maxPendingPaths ?? 1000)) { void this.refresh(); return; }
        // Fixed window, not trailing debounce: continuous traffic cannot starve reads.
        if (!this.timer && !this.draining) this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.drain(signal);
        }, this.options.coalesceMs ?? 50);
      }
    } catch (error) { if (!signal.aborted) this.fail(error); }
  }

  private async drain(signal: AbortSignal): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!signal.aborted && this.pending.size) {
        const paths = [...this.pending];
        this.pending.clear();
        if (!(await this.reread(paths, signal)).ok) return;
      }
    } finally {
      this.draining = false;
      // A reset can replace the generation while this read is in flight.
      if (!this.request.signal.aborted && this.snapshot.state !== "loading" && this.pending.size) void this.drain(this.request.signal);
    }
  }

  private async reread(paths: string[], signal: AbortSignal): Promise<ConnectOutcome<void>> {
    const overlays = new Map([...this.overlays].filter(([path, overlay]) => paths.includes(path) && overlay.committed));
    try {
      const where = `file.path in ${JSON.stringify(paths)}`;
      const input: QueryInput = { ...this.query, where: this.query.where ? `(${this.query.where}) && (${where})` : where, includeBody: this.query.includeBody };
      const support = this.supports ? unwrap(await this.supports("query-metadata-v1", { signal })) : false;
      // Editor/Writer/TaskNotes on pre-wave-B authorities use ordinary discovery.
      // Remove when minimum supported authorities all advertise query-metadata-v1.
      const membership = support
        ? unwrap(await this.client.queryAll({ ...input, select: fileFields.map(field => `file.${field}`), includeBody: false, output: "metadata" }, { signal })).results
        : unwrap(await this.client.queryAll(input, { signal })).results;
      const matches = new Map(membership.map(row => [row.path, row]));
      const mode = this.query.frontmatterMode ?? "effective";
      const cached = new Map([...overlays].flatMap(([path, { record }]) => support && record?.revision && record.revision === matches.get(path)?.revision
        && (!this.query.includeBody || record.body !== undefined)
        && (mode === "effective" || record.frontmatter !== undefined) && (mode === "persisted" || record.effectiveFrontmatter !== undefined)
        ? [[path, record] as const] : []));
      const documents = support || (this.supports ? unwrap(await this.supports("read-many-documents-v1", { signal })) : false);
      // Ordinary discovery already contains full query rows. Without document
      // support, do not repeat the same query through readMany's legacy path.
      const result = documents ? unwrap(await this.client.readMany(paths.filter(path => matches.has(path) && !cached.has(path)), {
        signal, includeBody: this.query.includeBody, frontmatterMode: this.query.frontmatterMode
      })) : { results: (membership as QueryRecord<F>[]).map(record => ({ status: "found" as const, path: record.path, record })), errors: [] };
      if (signal.aborted || this.lifetime.signal.aborted) return cancelled();
      if (result.errors.length) throw new MdbaseConnectError(result.errors[0]!.failure.problem);
      const found = new Map([...cached, ...result.results.flatMap(entry => entry.status === "found" ? [[entry.path, entry.record] as const] : [])]
        .map(([path, record]) => [path, immutable(withQueryFile(record, matches.get(path)!))] as const));
      for (const path of paths) if (!matches.has(path)) this.records.delete(path);
      for (const entry of result.results) {
        if (entry.status === "found") this.records.set(entry.path, found.get(entry.path)!);
        else if (entry.status === "missing") this.records.delete(entry.path);
      }
      for (const [path] of cached) this.records.set(path, found.get(path)!);
      for (const [path, overlay] of overlays) if (overlay?.committed && this.overlays.get(path) === overlay) this.overlays.delete(path);
      this.publish("changes", { state: "ready", problem: null });
      return connectSuccess(undefined);
    } catch (error) {
      if (signal.aborted || this.lifetime.signal.aborted) return cancelled();
      return this.fail(error);
    }
  }

  private retire(paths: string[], token: object): void {
    for (const path of paths) if (this.overlays.get(path)?.token === token) this.overlays.delete(path);
    if (!this.lifetime.signal.aborted) this.publish("local");
  }
  private fail(error: unknown): ConnectOutcome<void> {
    const problem = error instanceof MdbaseConnectError ? error.problem : connectProblem("operation_failed", error instanceof Error ? error.message : "Query observation failed.");
    this.publish("status", { state: "error", problem: immutable(problem) });
    return connectFailure(problem);
  }
  private publish(reason: ObserveDelta<F>["reason"], patch: Partial<ObserveSnapshot<F>> = {}, changed?: Pick<ObserveDelta<F>, "upserts" | "removed">): void {
    const visible = this.overlays.size ? new Map(this.records) : this.records;
    for (const [path, overlay] of this.overlays) {
      if (overlay.record) visible.set(path, overlay.record); else visible.delete(path);
    }
    const previous = this.snapshot.records;
    const records = reason === "status" ? previous : Object.freeze([...visible.values()]);
    const before = new Map(changed || records === previous ? [] : previous.map(row => [row.path, row]));
    const delta = Object.freeze({ reason,
      upserts: Object.freeze(changed?.upserts ?? (records === previous ? [] : records.filter(row => before.get(row.path) !== row))),
      removed: Object.freeze(changed?.removed ?? (records === previous ? [] : previous.filter(row => !visible.has(row.path)).map(row => row.path))) });
    this.snapshot = Object.freeze({ ...this.snapshot, ...patch, records,
      ...((patch.state ?? this.snapshot.state) === "ready" ? { total: records.length } : {}) });
    for (const listener of this.listeners) listener(this.snapshot, delta);
  }
}

// Document reads carry scalar file facts, not query-derived link/tag metadata.
// Select those facts at the authority; do not reimplement Markdown semantics.
const fileFields = ["tags", "links", "embeds"] as const;
function withQueryFile<F extends JsonObject>(record: QueryRecord<F>, membership: QueryRecord<F> | QueryMetadataRecord): QueryRecord<F> {
  const file = "file" in membership ? membership.file : Object.fromEntries(fileFields.map(field => {
    const value = membership.values[field];
    if (!Array.isArray(value) || (field === "tags" && value.some(tag => typeof tag !== "string"))) throw connectError("invalid_operation_response", "Invalid authority-derived file metadata.");
    return [field, value];
  }));
  return { ...record, file: "file" in membership ? { ...file, ...record.file } : { ...record.file, ...file } };
}
function unwrap<T>(outcome: ConnectOutcome<T>): T {
  if (!outcome.ok) throw new MdbaseConnectError(outcome.problem);
  return outcome.value;
}
function cancelled(): ConnectOutcome<void> { return connectFailure(connectProblem("operation_cancelled", "Query observation was cancelled.")); }
function changedPaths(change: CollectionChange): string[] {
  if (change.kind === "record.renamed") return [change.from, change.to];
  if (change.kind === "record.created" || change.kind === "record.updated" || change.kind === "record.deleted") return [change.path];
  return [];
}
function immutable<T>(value: T): T {
  // Copy/freeze JSON containers once; strings already have immutable ownership.
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map(immutable)) as T;
  const copy = { ...(value as Record<string, unknown>) };
  for (const key in copy) if (Object.hasOwn(copy, key) && copy[key] && typeof copy[key] === "object") copy[key] = immutable(copy[key]);
  return Object.freeze(copy) as T;
}
