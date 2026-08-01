import type {
  CollectionFileDescriptor,
  CommitFileUploadReceipt,
  DeleteFileReceipt,
  DeleteFileRequest,
  JsonObject,
  MoveFileReceipt,
  MoveFileRequest,
  OpenFileUploadRequest,
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
  /** Optional writable file plane; required by a read-write mirror that selects files. */
  uploadFile?(
    request: OpenFileUploadRequest,
    source: AsyncIterable<Uint8Array>
  ): Promise<CommitFileUploadReceipt>;
  moveFile?(request: MoveFileRequest): Promise<MoveFileReceipt>;
  deleteFile?(request: DeleteFileRequest): Promise<DeleteFileReceipt>;
  changes(after: number, limit?: number): Promise<SyncChangesPage<Frontmatter>>;
  mutate(mutation: SyncMutation): Promise<SyncMutationReceipt<Frontmatter>>;
}
