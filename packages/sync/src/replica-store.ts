import type {
  JsonObject,
  SyncCollectionResources,
  SyncMutation,
  SyncMutationReceipt,
  SyncRecord
} from "@mdbase-dev/connect-protocol";
import { SyncError } from "./sync-error.js";
import { clone } from "./sync-values.js";

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
