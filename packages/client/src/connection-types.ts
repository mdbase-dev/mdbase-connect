import type {
  CollectionOperation,
  FileCapability,
  GrantScope,
  JsonObject,
  SyncChangesPage,
  SyncMutation,
  SyncMutationReceipt,
  SyncSession,
  SyncSnapshotPage
} from "@mdbase-dev/connect-protocol";

export type MdbaseConnectionRoute = "remote" | "direct" | "relay";
export type DirectAccessStatus =
  | "disabled"
  | "permission_required"
  | "checking"
  | "available"
  | "unavailable"
  | "denied";

export interface MdbaseConnectionInfo {
  collectionId: string;
  displayName: string;
  operations: CollectionOperation[];
  scope: GrantScope;
  fileCapability?: FileCapability;
  authority:
    | { kind: "hosted"; durability: "provider" }
    | { kind: "connector"; durability: "computer" };
  route: MdbaseConnectionRoute;
  directAccess: DirectAccessStatus;
}

export interface MdbaseAuthorizationCapabilities {
  authorized: boolean;
  sufficient: boolean;
  collectionId?: string;
  grantedOperations: CollectionOperation[];
  missingOperations: CollectionOperation[];
}

export interface MdbaseSyncTransport<Frontmatter extends JsonObject = JsonObject> {
  openSession(): Promise<SyncSession>;
  snapshot(snapshotId: string, page?: string): Promise<SyncSnapshotPage<Frontmatter>>;
  changes(after: number, limit?: number): Promise<SyncChangesPage<Frontmatter>>;
  mutate(mutation: SyncMutation): Promise<SyncMutationReceipt<Frontmatter>>;
}

export interface MdbaseSyncConnection<Frontmatter extends JsonObject = JsonObject> {
  collectionId: string;
  replicaId: string;
  transport: MdbaseSyncTransport<Frontmatter>;
}
