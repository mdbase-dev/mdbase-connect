import type {
  JsonObject,
  SyncChange,
  SyncChangesPage,
  SyncCollectionResources,
  SyncMutation,
  SyncMutationReceipt,
  SyncRecord,
  SyncSession,
  SyncSnapshotPage
} from "@mdbase/connect-protocol";

export type {
  SyncChange,
  SyncChangesPage,
  SyncCollectionResources,
  SyncConflict,
  SyncMutation,
  SyncMutationReceipt,
  SyncRecord,
  SyncSession,
  SyncSnapshotPage
} from "@mdbase/connect-protocol";

export interface SyncTransport<Frontmatter extends JsonObject = JsonObject> {
  openSession(): Promise<SyncSession>;
  snapshot(snapshotId: string, page?: string): Promise<SyncSnapshotPage<Frontmatter>>;
  changes(after: number, limit?: number): Promise<SyncChangesPage<Frontmatter>>;
  mutate(mutation: SyncMutation): Promise<SyncMutationReceipt<Frontmatter>>;
}

export interface HostedCollectionOptions<Frontmatter extends JsonObject = JsonObject> {
  id?: string;
  validate?(record: SyncRecord<Frontmatter>): void;
  snapshotPageSize?: number;
  resources?: SyncCollectionResources;
}

export interface ReplicaOptions {
  id?: string;
  name: string;
  mode: "read_only" | "read_write";
  allowedTypes?: string[];
}

export interface SerializedHostedAuthority<Frontmatter extends JsonObject = JsonObject> {
  version: 1;
  collectionId: string;
  head: number;
  retainedAfter: number;
  records: Array<SyncRecord<Frontmatter>>;
  replicas: Array<{
    id: string;
    name: string;
    mode: "read_only" | "read_write";
    allowedTypes: string[];
    scopeEpoch: number;
    revoked: boolean;
  }>;
  changes: Array<AuthorityChange<Frontmatter>>;
  receipts: Array<[string, SyncMutationReceipt<Frontmatter>]>;
  resources?: SyncCollectionResources;
}

interface ReplicaState {
  id: string;
  name: string;
  mode: "read_only" | "read_write";
  allowedTypes: Set<string>;
  scopeEpoch: number;
  revoked: boolean;
}

export interface AuthorityChange<Frontmatter extends JsonObject> {
  sequence: number;
  before?: SyncRecord<Frontmatter>;
  after?: SyncRecord<Frontmatter>;
  revision: string;
}

interface SnapshotState<Frontmatter extends JsonObject> {
  id: string;
  replicaId: string;
  scopeEpoch: number;
  cursor: number;
  records: Array<SyncRecord<Frontmatter>>;
}

/** Executable protocol model used by SDK tests and local developer sandboxes. */
export class MemoryHostedAuthority<Frontmatter extends JsonObject = JsonObject> {
  readonly collectionId: string;
  private readonly validateRecord: (record: SyncRecord<Frontmatter>) => void;
  private readonly snapshotPageSize: number;
  private readonly resources: SyncCollectionResources;
  private readonly records = new Map<string, SyncRecord<Frontmatter>>();
  private readonly paths = new Map<string, string>();
  private readonly replicas = new Map<string, ReplicaState>();
  private readonly changesLog: Array<AuthorityChange<Frontmatter>> = [];
  private readonly snapshots = new Map<string, SnapshotState<Frontmatter>>();
  private readonly receipts = new Map<string, SyncMutationReceipt<Frontmatter>>();
  private head = 0;
  private retainedAfter = 0;

  constructor(options: HostedCollectionOptions<Frontmatter> = {}) {
    this.collectionId = options.id ?? crypto.randomUUID();
    this.validateRecord = options.validate ?? (() => undefined);
    this.snapshotPageSize = positiveInteger(options.snapshotPageSize ?? 100, "snapshotPageSize");
    this.resources = clone(options.resources ?? {
      revision: "hosted-resources:0",
      spec_version: "0.3.0",
      types: [],
      contracts: []
    });
  }

  static restore<Frontmatter extends JsonObject = JsonObject>(
    state: SerializedHostedAuthority<Frontmatter>,
    options: Omit<HostedCollectionOptions<Frontmatter>, "id"> = {},
    preserveSnapshotsFrom?: MemoryHostedAuthority<Frontmatter>
  ): MemoryHostedAuthority<Frontmatter> {
    if (state.version !== 1) throw new SyncError("unsupported_state", "Hosted authority state version is unsupported.");
    const authority = new MemoryHostedAuthority<Frontmatter>({
      ...options,
      id: state.collectionId,
      resources: state.resources ?? options.resources
    });
    authority.head = state.head;
    authority.retainedAfter = state.retainedAfter;
    for (const record of state.records) {
      authority.records.set(record.record_id, clone(record));
      authority.paths.set(record.path, record.record_id);
    }
    for (const replica of state.replicas) {
      authority.replicas.set(replica.id, { ...replica, allowedTypes: new Set(replica.allowedTypes) });
    }
    authority.changesLog.push(...state.changes.map(clone));
    for (const [key, receipt] of state.receipts) authority.receipts.set(key, clone(receipt));
    if (preserveSnapshotsFrom?.collectionId === state.collectionId) {
      for (const [id, snapshot] of preserveSnapshotsFrom.snapshots) {
        authority.snapshots.set(id, clone(snapshot));
      }
    }
    return authority;
  }

  serialize(): SerializedHostedAuthority<Frontmatter> {
    return {
      version: 1,
      collectionId: this.collectionId,
      head: this.head,
      retainedAfter: this.retainedAfter,
      records: [...this.records.values()].map(clone),
      replicas: [...this.replicas.values()].map((replica) => ({
        ...replica,
        allowedTypes: [...replica.allowedTypes]
      })),
      changes: this.changesLog.map(clone),
      receipts: [...this.receipts.entries()].map(clone),
      resources: clone(this.resources)
    };
  }

  seed(records: Array<Omit<SyncRecord<Frontmatter>, "revision"> & { revision?: string }>): void {
    if (this.head !== 0 || this.records.size !== 0) throw new SyncError("already_initialized", "Collection already contains records.");
    for (const value of records) {
      assertSafePath(value.path);
      if (this.records.has(value.record_id) || this.paths.has(value.path)) {
        throw new SyncError("record_conflict", "Seed records must have unique IDs and paths.");
      }
      const record = clone({ ...value, revision: value.revision ?? `hosted:0:${value.record_id}` }) as SyncRecord<Frontmatter>;
      this.validateRecord(record);
      this.records.set(record.record_id, record);
      this.paths.set(record.path, record.record_id);
    }
  }

  registerReplica(options: ReplicaOptions): string {
    const id = options.id ?? crypto.randomUUID();
    if (this.replicas.has(id)) throw new SyncError("replica_conflict", "Replica already exists.");
    this.replicas.set(id, {
      id,
      name: options.name,
      mode: options.mode,
      allowedTypes: new Set(options.allowedTypes ?? []),
      scopeEpoch: 1,
      revoked: false
    });
    return id;
  }

  updateReplicaScope(replicaId: string, allowedTypes: string[]): void {
    const replica = this.requireReplica(replicaId);
    replica.allowedTypes = new Set(allowedTypes);
    replica.scopeEpoch += 1;
    for (const [id, snapshot] of this.snapshots) {
      if (snapshot.replicaId === replicaId) this.snapshots.delete(id);
    }
  }

  revokeReplica(replicaId: string): void {
    this.requireReplica(replicaId).revoked = true;
  }

  compactThrough(sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < this.retainedAfter || sequence > this.head) {
      throw new SyncError("invalid_cursor", "Compaction cursor is outside retained history.");
    }
    this.retainedAfter = sequence;
    while (this.changesLog[0]?.sequence <= sequence) this.changesLog.shift();
  }

  transport(replicaId: string): SyncTransport<Frontmatter> {
    return {
      openSession: async () => this.openSession(replicaId),
      snapshot: async (snapshotId, page) => this.snapshot(replicaId, snapshotId, page),
      changes: async (after, limit) => this.changes(replicaId, after, limit),
      mutate: async (mutation) => this.mutate(replicaId, mutation)
    };
  }

  private openSession(replicaId: string): SyncSession {
    const replica = this.requireActiveReplica(replicaId);
    for (const [id, snapshot] of this.snapshots) {
      if (snapshot.replicaId === replicaId) this.snapshots.delete(id);
    }
    const snapshot: SnapshotState<Frontmatter> = {
      id: crypto.randomUUID(),
      replicaId,
      scopeEpoch: replica.scopeEpoch,
      cursor: this.head,
      records: [...this.records.values()]
        .filter((record) => visible(record, replica))
        .sort((left, right) => left.path.localeCompare(right.path))
        .map(clone)
    };
    this.snapshots.set(snapshot.id, snapshot);
    return {
      protocol_version: 1,
      session_id: crypto.randomUUID(),
      replica_id: replicaId,
      collection_id: this.collectionId,
      mode: replica.mode,
      scope_epoch: replica.scopeEpoch,
      retained_after: this.retainedAfter,
      head: this.head,
      snapshot_id: snapshot.id,
      resources: scopedResources(this.resources, replica)
    };
  }

  private snapshot(replicaId: string, snapshotId: string, page?: string): SyncSnapshotPage<Frontmatter> {
    const replica = this.requireActiveReplica(replicaId);
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot || snapshot.replicaId !== replicaId || snapshot.scopeEpoch !== replica.scopeEpoch) {
      throw new SyncError("snapshot_expired", "The snapshot is unavailable; open a new sync session.");
    }
    const offset = page === undefined ? 0 : positiveIntegerString(page, "snapshot page");
    const records = snapshot.records.slice(offset, offset + this.snapshotPageSize).map(clone);
    const nextOffset = offset + records.length;
    return {
      protocol_version: 1,
      snapshot_id: snapshot.id,
      scope_epoch: snapshot.scopeEpoch,
      cursor: snapshot.cursor,
      records,
      ...(nextOffset < snapshot.records.length ? { next_page: String(nextOffset) } : {})
    };
  }

  private changes(replicaId: string, after: number, limit = 200): SyncChangesPage<Frontmatter> {
    const replica = this.requireActiveReplica(replicaId);
    nonNegativeInteger(after, "after");
    positiveInteger(limit, "limit");
    if (after < this.retainedAfter) {
      return {
        protocol_version: 1,
        scope_epoch: replica.scopeEpoch,
        events: [],
        cursor: after,
        head: this.head,
        has_more: false,
        reset_required: true
      };
    }
    const events: Array<SyncChange<Frontmatter>> = [];
    let cursor = after;
    for (const change of this.changesLog) {
      if (change.sequence <= after) continue;
      cursor = change.sequence;
      events.push(...project(change, replica));
      if (events.length >= limit) break;
    }
    return {
      protocol_version: 1,
      scope_epoch: replica.scopeEpoch,
      events: events.map(clone),
      cursor,
      head: this.head,
      has_more: cursor < this.head,
      reset_required: false
    };
  }

  private mutate(replicaId: string, mutation: SyncMutation): SyncMutationReceipt<Frontmatter> {
    const receiptKey = `${replicaId}:${mutation.mutation_id}`;
    const prior = this.receipts.get(receiptKey);
    if (prior) {
      const replay = clone(prior);
      return replay.status === "applied"
        ? { ...replay, status: "previously_applied" }
        : replay;
    }
    let receipt: SyncMutationReceipt<Frontmatter>;
    try {
      const replica = this.requireActiveReplica(replicaId);
      if (replica.mode !== "read_write") throw new SyncError("read_only_replica", "This replica cannot submit mutations.");
      if (mutation.replica_id !== replicaId || mutation.scope_epoch !== replica.scopeEpoch) {
        throw new SyncError("scope_epoch_changed", "Replica scope changed; rebuild before uploading mutations.");
      }
      receipt = this.applyMutation(replica, mutation);
    } catch (error) {
      if (!(error instanceof SyncError)) throw error;
      receipt = {
        mutation_id: mutation.mutation_id,
        status: "rejected",
        error: { code: error.code, message: error.message }
      };
    }
    this.receipts.set(receiptKey, clone(receipt));
    return clone(receipt);
  }

  private applyMutation(replica: ReplicaState, mutation: SyncMutation): SyncMutationReceipt<Frontmatter> {
    const current = this.records.get(mutation.record_id);
    if (mutation.operation === "create") {
      if (current) return this.conflict(mutation, current);
      const path = requiredString(mutation.input.path, "path");
      assertSafePath(path);
      if (this.paths.has(path)) return this.conflict(mutation);
      const record = {
        record_id: mutation.record_id,
        path,
        revision: this.nextRevision(mutation.record_id),
        frontmatter: object(mutation.input.frontmatter) as Frontmatter,
        body: optionalText(mutation.input.body, "body") ?? "",
        types: stringList(mutation.input.types ?? explicitTypes(object(mutation.input.frontmatter)))
      } satisfies SyncRecord<Frontmatter>;
      if (!visible(record, replica)) throw new SyncError("scope_denied", "The new record is outside this replica's scope.");
      this.validateRecord(record);
      this.commit(undefined, record);
      return { mutation_id: mutation.mutation_id, status: "applied", sequence: this.head, record: clone(record) };
    }
    if (!current) return this.conflict(mutation);
    if (!visible(current, replica)) throw new SyncError("scope_denied", "The record is outside this replica's scope.");
    if (!mutation.base_revision || mutation.base_revision !== current.revision) {
      return this.conflict(mutation, current);
    }
    if (mutation.operation === "delete") {
      this.commit(current, undefined);
      return { mutation_id: mutation.mutation_id, status: "applied", sequence: this.head };
    }
    const next = clone(current);
    if (mutation.operation === "rename") {
      const path = requiredString(mutation.input.path, "path");
      assertSafePath(path);
      const occupied = this.paths.get(path);
      if (occupied && occupied !== current.record_id) return this.conflict(mutation, current);
      next.path = path;
    } else {
      const patch = object(mutation.input.patch ?? {});
      const frontmatter = clone(next.frontmatter) as JsonObject;
      for (const [field, value] of Object.entries(patch)) {
        if (value === null) delete frontmatter[field];
        else frontmatter[field] = clone(value);
      }
      next.frontmatter = frontmatter as Frontmatter;
      if (mutation.input.body !== undefined) next.body = requiredText(mutation.input.body, "body");
      if (mutation.input.types !== undefined) next.types = stringList(mutation.input.types);
    }
    next.revision = this.nextRevision(next.record_id);
    if (!visible(next, replica)) throw new SyncError("scope_denied", "The mutation would move the record outside this replica's scope.");
    this.validateRecord(next);
    this.commit(current, next);
    return { mutation_id: mutation.mutation_id, status: "applied", sequence: this.head, record: clone(next) };
  }

  private conflict(mutation: SyncMutation, current?: SyncRecord<Frontmatter>): SyncMutationReceipt<Frontmatter> {
    return {
      mutation_id: mutation.mutation_id,
      status: "conflicted",
      conflict: {
        record_id: mutation.record_id,
        mutation: clone(mutation),
        ...(current ? { current: clone(current), current_revision: current.revision } : {})
      }
    };
  }

  private nextRevision(recordId: string): string {
    return `hosted:${this.head + 1}:${recordId}`;
  }

  private commit(before?: SyncRecord<Frontmatter>, after?: SyncRecord<Frontmatter>): void {
    this.head += 1;
    const revision = after?.revision ?? `hosted:${this.head}:deleted:${before?.record_id}`;
    if (before) this.paths.delete(before.path);
    if (after) {
      this.records.set(after.record_id, clone(after));
      this.paths.set(after.path, after.record_id);
    } else if (before) {
      this.records.delete(before.record_id);
    }
    this.changesLog.push({ sequence: this.head, before: before && clone(before), after: after && clone(after), revision });
  }

  private requireReplica(replicaId: string): ReplicaState {
    const replica = this.replicas.get(replicaId);
    if (!replica) throw new SyncError("replica_not_found", "Replica not found.");
    return replica;
  }

  private requireActiveReplica(replicaId: string): ReplicaState {
    const replica = this.requireReplica(replicaId);
    if (replica.revoked) throw new SyncError("replica_revoked", "Replica access was revoked.");
    return replica;
  }
}

export interface ReplicaData<Frontmatter extends JsonObject = JsonObject> {
  replicaId: string;
  scopeEpoch?: number;
  cursor?: number;
  records: Record<string, SyncRecord<Frontmatter>>;
  pending: SyncMutation[];
  conflicts: Record<string, SyncMutationReceipt<Frontmatter>>;
  resources?: SyncCollectionResources;
}

export interface ReplicaStore<Frontmatter extends JsonObject = JsonObject> {
  load(): Promise<ReplicaData<Frontmatter>>;
  save(data: ReplicaData<Frontmatter>): Promise<void>;
}

export class MemoryReplicaStore<Frontmatter extends JsonObject = JsonObject> implements ReplicaStore<Frontmatter> {
  constructor(private data: ReplicaData<Frontmatter>) {}
  async load(): Promise<ReplicaData<Frontmatter>> { return clone(this.data); }
  async save(data: ReplicaData<Frontmatter>): Promise<void> { this.data = clone(data); }
}

export class IndexedDbReplicaStore<Frontmatter extends JsonObject = JsonObject> implements ReplicaStore<Frontmatter> {
  private database: Promise<IDBDatabase> | null = null;

  constructor(private readonly key: string, private readonly initial: ReplicaData<Frontmatter>) {}

  async load(): Promise<ReplicaData<Frontmatter>> {
    const database = await this.open();
    const stored = await idbRequest<ReplicaData<Frontmatter> | undefined>(
      database.transaction("replicas").objectStore("replicas").get(this.key)
    );
    if (stored) return clone(stored);
    await this.save(this.initial);
    return clone(this.initial);
  }

  async save(data: ReplicaData<Frontmatter>): Promise<void> {
    const database = await this.open();
    await idbWrite(database, (store) => store.put(clone(data), this.key));
  }

  private open(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined") throw new SyncError("storage_unavailable", "IndexedDB is required for a persistent offline cache.");
    this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open("mdbase-connect-sync", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("replicas")) request.result.createObjectStore("replicas");
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    return this.database;
  }
}

export class HttpSyncTransport<Frontmatter extends JsonObject = JsonObject> implements SyncTransport<Frontmatter> {
  private readonly serverUrl: string;
  constructor(serverUrl: string, private readonly collectionId: string, private readonly replicaToken: string) {
    this.serverUrl = serverUrl.replace(/\/$/, "");
  }

  openSession(): Promise<SyncSession> {
    return this.request("POST", "sessions");
  }
  snapshot(snapshotId: string, page?: string): Promise<SyncSnapshotPage<Frontmatter>> {
    const query = new URLSearchParams({ snapshot_id: snapshotId });
    if (page) query.set("page", page);
    return this.request("GET", `snapshot?${query}`);
  }
  changes(after: number, limit = 200): Promise<SyncChangesPage<Frontmatter>> {
    return this.request("GET", `changes?${new URLSearchParams({ after: String(after), limit: String(limit) })}`);
  }
  mutate(mutation: SyncMutation): Promise<SyncMutationReceipt<Frontmatter>> {
    return this.request("POST", "mutations", mutation);
  }

  private async request<Result>(method: string, path: string, body?: unknown): Promise<Result> {
    const response = await fetch(`${this.serverUrl}/v1/hosted/collections/${encodeURIComponent(this.collectionId)}/sync/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.replicaToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const value = await response.json();
    if (!response.ok) throw new SyncError(value?.error?.code ?? "sync_failed", value?.error?.message ?? "Sync request failed.");
    return value as Result;
  }
}

export class OfflineReplica<Frontmatter extends JsonObject = JsonObject> {
  private operationGate: Promise<void> = Promise.resolve();

  constructor(
    private readonly transport: SyncTransport<Frontmatter>,
    private readonly store: ReplicaStore<Frontmatter>
  ) {}

  async records(): Promise<Array<SyncRecord<Frontmatter>>> {
    return Object.values((await this.store.load()).records).sort((a, b) => a.path.localeCompare(b.path));
  }

  async pending(): Promise<SyncMutation[]> {
    return (await this.store.load()).pending;
  }

  async conflicts(): Promise<Array<SyncMutationReceipt<Frontmatter>>> {
    return Object.values((await this.store.load()).conflicts);
  }

  async collectionResources(): Promise<SyncCollectionResources | null> {
    return clone((await this.store.load()).resources ?? null);
  }

  initialize(): Promise<void> {
    return this.exclusive(() => this.initializeUnlocked());
  }

  private async initializeUnlocked(): Promise<void> {
    const data = await this.store.load();
    const session = await this.transport.openSession();
    if (session.replica_id !== data.replicaId) throw new SyncError("replica_mismatch", "Sync session belongs to another replica.");
    const records: Record<string, SyncRecord<Frontmatter>> = {};
    let page: string | undefined;
    do {
      const snapshot = await this.transport.snapshot(session.snapshot_id, page);
      if (snapshot.scope_epoch !== session.scope_epoch || snapshot.cursor !== session.head) {
        throw new SyncError("invalid_snapshot", "Snapshot boundary changed during download.");
      }
      for (const record of snapshot.records) records[record.record_id] = clone(record);
      page = snapshot.next_page;
    } while (page);
    const pending = data.pending.map((mutation) => ({
      ...mutation,
      scope_epoch: session.scope_epoch
    }));
    await this.store.save({
      ...data,
      scopeEpoch: session.scope_epoch,
      cursor: session.head,
      records: applyPendingOverlay(records, pending),
      pending,
      resources: clone(session.resources)
    });
  }

  queueCreate(input: {
    recordId?: string;
    mutationId?: string;
    path: string;
    frontmatter: Frontmatter;
    body?: string;
    types: string[];
  }): Promise<SyncRecord<Frontmatter>> {
    return this.exclusive(() => this.queueCreateUnlocked(input));
  }

  private async queueCreateUnlocked(input: {
    recordId?: string;
    mutationId?: string;
    path: string;
    frontmatter: Frontmatter;
    body?: string;
    types: string[];
  }): Promise<SyncRecord<Frontmatter>> {
    const data = await this.requireInitialized();
    assertSafePath(input.path);
    const mutationId = input.mutationId ?? crypto.randomUUID();
    const recordId = input.recordId ?? crypto.randomUUID();
    if (data.records[recordId] || Object.values(data.records).some((record) => record.path === input.path)) {
      throw new SyncError("local_record_conflict", "The offline cache already contains this record ID or path.");
    }
    const mutation: SyncMutation = {
      mutation_id: mutationId,
      replica_id: data.replicaId,
      scope_epoch: data.scopeEpoch!,
      operation: "create",
      record_id: recordId,
      input: { path: input.path, frontmatter: clone(input.frontmatter), body: input.body ?? "", types: [...input.types] },
      created_at: new Date().toISOString()
    };
    const optimistic: SyncRecord<Frontmatter> = {
      record_id: recordId,
      path: input.path,
      revision: `local:${mutationId}`,
      frontmatter: clone(input.frontmatter),
      body: input.body ?? "",
      types: [...input.types]
    };
    data.pending.push(mutation);
    data.records[recordId] = optimistic;
    await this.store.save(data);
    return clone(optimistic);
  }

  queueUpdate(input: {
    recordId: string;
    mutationId?: string;
    patch: JsonObject;
    body?: string;
    baseRevision?: string;
  }): Promise<void> {
    return this.exclusive(() => this.queueUpdateUnlocked(input));
  }

  private async queueUpdateUnlocked(input: {
    recordId: string;
    mutationId?: string;
    patch: JsonObject;
    body?: string;
    baseRevision?: string;
  }): Promise<void> {
    const data = await this.requireInitialized();
    const current = data.records[input.recordId];
    if (!current) throw new SyncError("record_not_found", "Cached record not found.");
    this.assertRecordNotBlocked(data, input.recordId);
    const mutationId = input.mutationId ?? crypto.randomUUID();
    const predecessor = [...data.pending].reverse().find((item) => item.record_id === input.recordId);
    data.pending.push({
      mutation_id: mutationId,
      replica_id: data.replicaId,
      scope_epoch: data.scopeEpoch!,
      operation: "update",
      record_id: input.recordId,
      base_revision: input.baseRevision ?? current.revision,
      input: { patch: clone(input.patch), ...(input.body === undefined ? {} : { body: input.body }) },
      created_at: new Date().toISOString(),
      ...(predecessor ? { causal_predecessor: predecessor.mutation_id } : {})
    });
    const frontmatter = clone(current.frontmatter) as JsonObject;
    for (const [key, value] of Object.entries(input.patch)) {
      if (value === null) delete frontmatter[key];
      else frontmatter[key] = clone(value);
    }
    data.records[input.recordId] = {
      ...current,
      frontmatter: frontmatter as Frontmatter,
      body: input.body ?? current.body,
      revision: `local:${mutationId}`
    };
    await this.store.save(data);
  }

  queueRename(input: {
    recordId: string;
    path: string;
    mutationId?: string;
    baseRevision?: string;
  }): Promise<void> {
    return this.exclusive(async () => {
      const data = await this.requireInitialized();
      const current = data.records[input.recordId];
      if (!current) throw new SyncError("record_not_found", "Cached record not found.");
      this.assertRecordNotBlocked(data, input.recordId);
      assertSafePath(input.path);
      if (Object.values(data.records).some((record) => record.record_id !== input.recordId && record.path === input.path)) {
        throw new SyncError("local_record_conflict", "The offline cache already contains the destination path.");
      }
      const mutationId = input.mutationId ?? crypto.randomUUID();
      const predecessor = [...data.pending].reverse().find((item) => item.record_id === input.recordId);
      data.pending.push({
        mutation_id: mutationId,
        replica_id: data.replicaId,
        scope_epoch: data.scopeEpoch!,
        operation: "rename",
        record_id: input.recordId,
        base_revision: input.baseRevision ?? current.revision,
        input: { path: input.path },
        created_at: new Date().toISOString(),
        ...(predecessor ? { causal_predecessor: predecessor.mutation_id } : {})
      });
      data.records[input.recordId] = { ...current, path: input.path, revision: `local:${mutationId}` };
      await this.store.save(data);
    });
  }

  queueDelete(input: {
    recordId: string;
    mutationId?: string;
    baseRevision?: string;
  }): Promise<void> {
    return this.exclusive(async () => {
      const data = await this.requireInitialized();
      const current = data.records[input.recordId];
      if (!current) throw new SyncError("record_not_found", "Cached record not found.");
      this.assertRecordNotBlocked(data, input.recordId);
      const mutationId = input.mutationId ?? crypto.randomUUID();
      const predecessor = [...data.pending].reverse().find((item) => item.record_id === input.recordId);
      data.pending.push({
        mutation_id: mutationId,
        replica_id: data.replicaId,
        scope_epoch: data.scopeEpoch!,
        operation: "delete",
        record_id: input.recordId,
        base_revision: input.baseRevision ?? current.revision,
        input: {},
        created_at: new Date().toISOString(),
        ...(predecessor ? { causal_predecessor: predecessor.mutation_id } : {})
      });
      delete data.records[input.recordId];
      await this.store.save(data);
    });
  }

  sync(): Promise<void> {
    return this.exclusive(() => this.syncUnlocked());
  }

  private async syncUnlocked(): Promise<void> {
    let data = await this.requireInitialized();
    const appliedByMutation = new Map<string, SyncRecord<Frontmatter> | undefined>();
    let rebuild = false;
    for (const queued of [...data.pending]) {
      if (data.conflicts[queued.record_id]) continue;
      const mutation = clone(queued);
      if (mutation.causal_predecessor) {
        const predecessor = appliedByMutation.get(mutation.causal_predecessor);
        if (predecessor) mutation.base_revision = predecessor.revision;
      }
      const receipt = await this.transport.mutate(mutation);
      if (receipt.status === "applied" || receipt.status === "previously_applied") {
        data.pending = data.pending.filter((item) => item.mutation_id !== queued.mutation_id);
        appliedByMutation.set(queued.mutation_id, receipt.record);
        if (receipt.record) {
          for (const pending of data.pending) {
            if (pending.causal_predecessor === queued.mutation_id) {
              pending.base_revision = receipt.record.revision;
              delete pending.causal_predecessor;
            }
          }
        }
        if (receipt.record) data.records[receipt.record.record_id] = clone(receipt.record);
        else delete data.records[queued.record_id];
      } else if (receipt.status === "conflicted") {
        data.conflicts[queued.record_id] = clone(receipt);
      } else {
        data.pending = data.pending.filter((item) => item.mutation_id !== queued.mutation_id);
        data.conflicts[queued.record_id] = clone(receipt);
        rebuild = true;
      }
      await this.store.save(data);
    }
    if (rebuild) await this.initializeUnlocked();
    else await this.pullUnlocked();
  }

  pull(): Promise<void> {
    return this.exclusive(() => this.pullUnlocked());
  }

  private async pullUnlocked(): Promise<void> {
    let data = await this.requireInitialized();
    while (true) {
      const page = await this.transport.changes(data.cursor!, 200);
      if (page.scope_epoch !== data.scopeEpoch || page.reset_required) {
        await this.initializeUnlocked();
        return;
      }
      validateChangesPage(page, data.cursor!);
      for (const event of page.events) {
        if (event.type === "put") data.records[event.record.record_id] = clone(event.record);
        else delete data.records[event.record_id];
      }
      data.records = applyPendingOverlay(data.records, data.pending);
      data.cursor = page.cursor;
      await this.store.save(data);
      if (!page.has_more) return;
      data = await this.store.load();
    }
  }

  private assertRecordNotBlocked(data: ReplicaData<Frontmatter>, recordId: string): void {
    if (data.conflicts[recordId]) {
      throw new SyncError("record_conflicted", "Resolve the record's existing sync issue before editing it again.");
    }
  }

  private async exclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    const prior = this.operationGate;
    let release!: () => void;
    this.operationGate = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async requireInitialized(): Promise<ReplicaData<Frontmatter>> {
    const data = await this.store.load();
    if (data.scopeEpoch === undefined || data.cursor === undefined) {
      throw new SyncError("not_initialized", "Install a snapshot before using the offline replica.");
    }
    return data;
  }
}

function applyPendingOverlay<Frontmatter extends JsonObject>(
  authorityRecords: Record<string, SyncRecord<Frontmatter>>,
  pending: SyncMutation[]
): Record<string, SyncRecord<Frontmatter>> {
  const records = clone(authorityRecords);
  for (const mutation of pending) {
    if (mutation.operation === "create") {
      const path = requiredString(mutation.input.path, "path");
      records[mutation.record_id] = {
        record_id: mutation.record_id,
        path,
        revision: `local:${mutation.mutation_id}`,
        frontmatter: object(mutation.input.frontmatter) as Frontmatter,
        body: optionalText(mutation.input.body, "body") ?? "",
        types: stringList(mutation.input.types ?? explicitTypes(object(mutation.input.frontmatter)))
      };
      continue;
    }
    const current = records[mutation.record_id];
    if (!current) continue;
    if (mutation.operation === "delete") {
      delete records[mutation.record_id];
      continue;
    }
    if (mutation.operation === "rename") {
      records[mutation.record_id] = {
        ...current,
        path: requiredString(mutation.input.path, "path"),
        revision: `local:${mutation.mutation_id}`
      };
      continue;
    }
    const frontmatter = clone(current.frontmatter) as JsonObject;
    for (const [field, value] of Object.entries(object(mutation.input.patch ?? {}))) {
      if (value === null) delete frontmatter[field];
      else frontmatter[field] = clone(value);
    }
    records[mutation.record_id] = {
      ...current,
      frontmatter: frontmatter as Frontmatter,
      body: mutation.input.body === undefined ? current.body : requiredText(mutation.input.body, "body"),
      types: mutation.input.types === undefined ? current.types : stringList(mutation.input.types),
      revision: `local:${mutation.mutation_id}`
    };
  }
  return records;
}

function validateChangesPage(page: SyncChangesPage, requestedAfter: number): void {
  if (page.cursor < requestedAfter || page.cursor > page.head || (page.has_more && page.cursor === requestedAfter)) {
    throw new SyncError("invalid_changes_page", "The sync provider returned an invalid or non-advancing cursor.");
  }
  let sequence = requestedAfter;
  for (const event of page.events) {
    if (event.sequence <= sequence || event.sequence > page.cursor) {
      throw new SyncError("invalid_changes_page", "The sync provider returned changes out of order.");
    }
    sequence = event.sequence;
  }
}

export class SyncError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

function project<Frontmatter extends JsonObject>(
  change: AuthorityChange<Frontmatter>,
  replica: ReplicaState
): Array<SyncChange<Frontmatter>> {
  const beforeVisible = change.before ? visible(change.before, replica) : false;
  const afterVisible = change.after ? visible(change.after, replica) : false;
  if (afterVisible && change.after) return [{ sequence: change.sequence, type: "put", record: clone(change.after) }];
  if (beforeVisible && change.before) {
    return [{
      sequence: change.sequence,
      type: "remove",
      record_id: change.before.record_id,
      previous_path: change.before.path,
      revision: change.revision
    }];
  }
  return [];
}

function visible(record: SyncRecord, replica: ReplicaState): boolean {
  return replica.allowedTypes.size === 0 || record.types.some((type) => replica.allowedTypes.has(type));
}

function scopedResources(resources: SyncCollectionResources, replica: ReplicaState): SyncCollectionResources {
  if (replica.allowedTypes.size === 0) return clone(resources);
  return {
    revision: resources.revision,
    spec_version: resources.spec_version,
    types: resources.types.filter((type) => replica.allowedTypes.has(type.name)).map(clone),
    contracts: resources.contracts
      .filter((contract) => replica.allowedTypes.has(contract.type_name))
      .map(clone),
    documents: resources.documents
      ?.filter((document) => document.kind === "configuration"
        || (document.kind === "type"
          && replica.allowedTypes.has(document.path.replace(/^_types\//, "").replace(/\.md$/, ""))))
      .map(clone)
  };
}

function explicitTypes(frontmatter: JsonObject): string[] {
  return [frontmatter.type, frontmatter.types]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value): value is string => typeof value === "string");
}

function assertSafePath(path: string): void {
  if (path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new SyncError("invalid_path", "Record paths must be safe collection-relative paths.");
  }
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyncError("invalid_input", "Expected an object.");
  return clone(value as JsonObject);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new SyncError("invalid_input", `${name} must be a non-empty string.`);
  return value;
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string") throw new SyncError("invalid_input", `${name} must be a string.`);
  return value;
}

function optionalText(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : requiredText(value, name);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw new SyncError("invalid_input", "types must be a list of non-empty strings.");
  }
  return [...new Set(value)];
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new SyncError("invalid_input", `${name} must be a non-negative integer.`);
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new SyncError("invalid_input", `${name} must be a positive integer.`);
  return value;
}

function positiveIntegerString(value: string, name: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new SyncError("invalid_input", `${name} is invalid.`);
  return positiveInteger(Number(value), name);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function idbRequest<T = IDBValidKey>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function idbWrite(database: IDBDatabase, operation: (store: IDBObjectStore) => IDBRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("replicas", "readwrite");
    const request = operation(transaction.objectStore("replicas"));
    request.onerror = () => reject(request.error);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("Replica transaction aborted."));
    transaction.oncomplete = () => resolve();
  });
}
