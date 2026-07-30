import type {
  JsonObject,
  SyncChangesPage,
  SyncMutation,
  SyncMutationReceipt,
  SyncSession,
  SyncSnapshotPage
} from "@mdbase/connect-protocol";

export interface SyncTransport<Frontmatter extends JsonObject = JsonObject> {
  openSession(): Promise<SyncSession>;
  snapshot(snapshotId: string, page?: string): Promise<SyncSnapshotPage<Frontmatter>>;
  changes(after: number, limit?: number): Promise<SyncChangesPage<Frontmatter>>;
  mutate(mutation: SyncMutation): Promise<SyncMutationReceipt<Frontmatter>>;
}
