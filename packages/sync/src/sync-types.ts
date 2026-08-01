import type {
  CollectionFileDescriptor,
  JsonObject,
  SyncChangesPage,
  SyncMutation,
  SyncMutationReceipt,
  SyncSession,
  SyncFileSnapshotPage,
  SyncSnapshotPage
} from "@mdbase-dev/connect-protocol";

export interface SyncTransport<Frontmatter extends JsonObject = JsonObject> {
  openSession(): Promise<SyncSession>;
  snapshot(snapshotId: string, page?: string): Promise<SyncSnapshotPage<Frontmatter>>;
  fileSnapshot(snapshotId: string, page?: string): Promise<SyncFileSnapshotPage>;
  /** Exact file bytes, streamed from the authority's binary data plane. */
  downloadFile(file: CollectionFileDescriptor): AsyncIterable<Uint8Array>;
  changes(after: number, limit?: number): Promise<SyncChangesPage<Frontmatter>>;
  mutate(mutation: SyncMutation): Promise<SyncMutationReceipt<Frontmatter>>;
}
