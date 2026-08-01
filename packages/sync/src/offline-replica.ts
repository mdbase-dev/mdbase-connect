import type {
  JsonObject,
  SyncChangesPage,
  SyncCollectionResources,
  SyncMutation,
  SyncMutationReceipt,
  SyncRecord
} from "@mdbase-dev/connect-protocol";
import type { ReplicaData, ReplicaStore } from "./replica-store.js";
import { SyncError } from "./sync-error.js";
import type { SyncTransport } from "./sync-types.js";
import {
  assertSafePath,
  clone,
  explicitTypes,
  object,
  optionalText,
  requiredString,
  requiredText,
  stringList
} from "./sync-values.js";

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

  async conflictEntries(): Promise<
    Array<{ recordId: string; receipt: SyncMutationReceipt<Frontmatter> }>
  > {
    return Object.entries((await this.store.load()).conflicts).map(
      ([recordId, receipt]) => ({ recordId, receipt }),
    );
  }

  /** Resolve one blocked record without disturbing mutations for other records. */
  resolveConflict(recordId: string, resolution: "local" | "remote"): Promise<void> {
    return this.exclusive(async () => {
      const data = await this.requireInitialized();
      const receipt = data.conflicts[recordId];
      if (!receipt) throw new SyncError("conflict_not_found", "The record has no sync issue to resolve.");
      const current = receipt.status === "conflicted" ? receipt.conflict.current : undefined;
      if (resolution === "remote") {
        data.pending = data.pending.filter((mutation) => mutation.record_id !== recordId);
        if (current) data.records[recordId] = clone(current);
        else delete data.records[recordId];
        delete data.conflicts[recordId];
        await this.store.save(data);
        return;
      }
      if (receipt.status !== "conflicted" || !current) {
        throw new SyncError(
          "local_resolution_unavailable",
          "This sync issue cannot keep the local version; use the remote version or edit a new record."
        );
      }
      const pending = data.pending.filter((mutation) => mutation.record_id === recordId);
      if (pending.length === 0) {
        throw new SyncError("conflict_mutation_missing", "The local change for this sync issue is unavailable.");
      }
      const first = pending[0];
      const replacedMutationId = first.mutation_id;
      first.mutation_id = crypto.randomUUID();
      first.created_at = new Date().toISOString();
      for (const later of pending.slice(1)) {
        if (later.causal_predecessor === replacedMutationId) {
          later.causal_predecessor = first.mutation_id;
        }
      }
      if (first.operation === "create") {
        first.operation = "update";
        first.base_revision = current.revision;
        first.input = {
          patch: clone(first.input.frontmatter ?? {}),
          body: first.input.body ?? "",
          types: first.input.types ?? current.types
        };
      } else {
        first.base_revision = current.revision;
      }
      delete first.causal_predecessor;
      delete data.conflicts[recordId];
      const overlay = applyPendingOverlay<Frontmatter>({ [recordId]: clone(current) }, pending);
      if (overlay[recordId]) data.records[recordId] = overlay[recordId];
      else delete data.records[recordId];
      await this.store.save(data);
    });
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
    for (const recordId of Object.keys(data.conflicts)) {
      reconcileConflictCurrent(data.conflicts, recordId, records[recordId]);
    }
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
    frontmatter?: Frontmatter;
    body?: string;
    types?: string[];
  }): Promise<SyncRecord<Frontmatter>> {
    return this.exclusive(() => this.queueCreateUnlocked(input));
  }

  private async queueCreateUnlocked(input: {
    recordId?: string;
    mutationId?: string;
    path: string;
    frontmatter?: Frontmatter;
    body?: string;
    types?: string[];
  }): Promise<SyncRecord<Frontmatter>> {
    const data = await this.requireInitialized();
    assertSafePath(input.path);
    const mutationId = input.mutationId ?? crypto.randomUUID();
    const recordId = input.recordId ?? crypto.randomUUID();
    const frontmatter = clone(input.frontmatter ?? {}) as Frontmatter;
    const types = input.types ?? explicitTypes(frontmatter);
    if (data.records[recordId] || Object.values(data.records).some((record) => record.path === input.path)) {
      throw new SyncError("local_record_conflict", "The offline cache already contains this record ID or path.");
    }
    const mutation: SyncMutation = {
      mutation_id: mutationId,
      replica_id: data.replicaId,
      scope_epoch: data.scopeEpoch!,
      operation: "create",
      record_id: recordId,
      input: { path: input.path, frontmatter, body: input.body ?? "", types: [...types] },
      created_at: new Date().toISOString()
    };
    const optimistic: SyncRecord<Frontmatter> = {
      record_id: recordId,
      path: input.path,
      revision: `local:${mutationId}`,
      frontmatter,
      body: input.body ?? "",
      types: [...types]
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
        if (event.type === "put") {
          data.records[event.record.record_id] = clone(event.record);
          reconcileConflictCurrent(data.conflicts, event.record.record_id, event.record);
        } else {
          delete data.records[event.record_id];
          reconcileConflictCurrent(data.conflicts, event.record_id);
        }
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

function reconcileConflictCurrent<Frontmatter extends JsonObject>(
  conflicts: Record<string, SyncMutationReceipt<Frontmatter>>,
  recordId: string,
  current?: SyncRecord<Frontmatter>
): void {
  const receipt = conflicts[recordId];
  if (!receipt || receipt.status !== "conflicted") return;
  if (current) {
    receipt.conflict.current = clone(current);
    receipt.conflict.current_revision = current.revision;
    return;
  }
  delete receipt.conflict.current;
  delete receipt.conflict.current_revision;
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
        frontmatter: object(mutation.input.frontmatter ?? {}) as Frontmatter,
        body: optionalText(mutation.input.body, "body") ?? "",
        types: stringList(mutation.input.types ?? explicitTypes(object(mutation.input.frontmatter ?? {})))
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
