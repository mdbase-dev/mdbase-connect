import type {
  JsonObject,
  SyncChange,
  SyncChangesPage,
  SyncCollectionResources,
  SyncMutation,
  SyncMutationReceipt,
  SyncRecord,
  SyncSession,
  SyncSnapshotPage,
  SyncSnapshotRecord
} from "@mdbase-dev/connect-protocol";
import { stringify } from "yaml";
import { documentRevision } from "./mirror-format.js";
import { SyncError } from "./sync-error.js";
import type { SyncTransport } from "./sync-types.js";
import {
  assertSafePath,
  clone,
  explicitTypes,
  nonNegativeInteger,
  object,
  optionalText,
  positiveInteger,
  positiveIntegerString,
  requiredString,
  requiredText,
  stringList
} from "./sync-values.js";

export interface MemoryAuthorityOptions<Frontmatter extends JsonObject = JsonObject> {
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

export interface SerializedMemoryAuthority<Frontmatter extends JsonObject = JsonObject> {
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
  records: Array<SyncSnapshotRecord<Frontmatter>>;
}

/** Executable protocol model used by SDK tests and local developer sandboxes. */
export class MemoryAuthority<Frontmatter extends JsonObject = JsonObject> {
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

  constructor(options: MemoryAuthorityOptions<Frontmatter> = {}) {
    this.collectionId = options.id ?? crypto.randomUUID();
    this.validateRecord = options.validate ?? (() => undefined);
    this.snapshotPageSize = positiveInteger(options.snapshotPageSize ?? 100, "snapshotPageSize");
    this.resources = clone(options.resources ?? {
      revision: "memory-resources:0",
      spec_version: "0.3.0",
      types: [],
      contracts: []
    });
  }

  static restore<Frontmatter extends JsonObject = JsonObject>(
    state: SerializedMemoryAuthority<Frontmatter>,
    options: Omit<MemoryAuthorityOptions<Frontmatter>, "id"> = {},
    preserveSnapshotsFrom?: MemoryAuthority<Frontmatter>
  ): MemoryAuthority<Frontmatter> {
    if (state.version !== 1) throw new SyncError("unsupported_state", "Authority state version is unsupported.");
    const authority = new MemoryAuthority<Frontmatter>({
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

  serialize(): SerializedMemoryAuthority<Frontmatter> {
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
      const record = clone({ ...value, revision: "" }) as SyncRecord<Frontmatter>;
      const revision = memoryRecordRevision(record);
      if (value.revision !== undefined && value.revision !== revision) {
        throw new SyncError(
          "invalid_revision",
          `Seed record ${value.path} does not match its declared revision.`
        );
      }
      record.revision = revision;
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
        .map((record) => ({
          ...clone(record),
          document: memoryRecordMarkdownDocument(record)
        }))
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
        revision: "",
        frontmatter: object(mutation.input.frontmatter ?? {}) as Frontmatter,
        body: optionalText(mutation.input.body, "body") ?? "",
        types: stringList(mutation.input.types ?? explicitTypes(object(mutation.input.frontmatter ?? {})))
      } satisfies SyncRecord<Frontmatter>;
      record.revision = memoryRecordRevision(record);
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
    next.revision = memoryRecordRevision(next);
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

  private commit(before?: SyncRecord<Frontmatter>, after?: SyncRecord<Frontmatter>): void {
    this.head += 1;
    const revision = after?.revision ?? `authority:${this.head}:deleted:${before?.record_id}`;
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

function memoryRecordMarkdownDocument(record: SyncRecord): string {
  if (Object.keys(record.frontmatter).length === 0) {
    return record.body;
  }

  const yaml = stringify(record.frontmatter, { lineWidth: 0 }).trimEnd();
  const body = record.body ? `\n${record.body.replace(/^\n/, "")}` : "";
  return `---\n${yaml}\n---\n${body}`;
}

function memoryRecordRevision(record: SyncRecord): string {
  return documentRevision(memoryRecordMarkdownDocument(record));
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
      .map((contract) => ({
        ...clone(contract),
        implementations: contract.implementations.filter((implementation) =>
          replica.allowedTypes.has(implementation.type_name)
        )
      }))
      .filter((contract) => contract.implementations.length > 0),
    documents: resources.documents
      ?.filter((document) => document.kind === "configuration"
        || (document.kind === "type"
          && replica.allowedTypes.has(document.path.replace(/^_types\//, "").replace(/\.md$/, ""))))
      .map(clone)
  };
}
