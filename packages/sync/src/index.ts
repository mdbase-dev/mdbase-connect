export type {
  SyncChange,
  SyncChangesPage,
  SyncCollectionResources,
  SyncConflict,
  SyncMutation,
  SyncMutationReceipt,
  SyncRecord,
  SyncSession,
  SyncSnapshotPage,
  SyncSnapshotRecord
} from "@mdbase-dev/connect-protocol";

export {
  MemoryAuthority,
  type AuthorityChange,
  type MemoryAuthorityOptions,
  type ReplicaOptions,
  type SerializedMemoryAuthority
} from "./memory-authority.js";
export { HttpSyncTransport } from "./http-transport.js";
export { OfflineReplica } from "./offline-replica.js";
export {
  IndexedDbReplicaStore,
  MemoryReplicaStore,
  type ReplicaData,
  type ReplicaStore
} from "./replica-store.js";
export { SyncError } from "./sync-error.js";
export type { SyncTransport } from "./sync-types.js";
