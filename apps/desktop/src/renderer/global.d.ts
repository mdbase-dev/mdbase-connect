interface AgentStatus {
  protocol_version: number;
  binary_version?: string;
  state: "local_only" | "connecting" | "connected" | "offline";
  registered_collections: number;
  paused: boolean;
  direct_access_available: boolean;
  loopback_port?: number;
}

interface CollectionSummary {
  id: string;
  display_name: string;
  description?: string;
  path: string;
  spec_version: string;
  enabled: boolean;
  contracts: CollectionContractDescriptor[];
}

interface ContractRequirement {
  id: string;
  version: string;
}

interface CollectionContractDescriptor extends ContractRequirement {
  digest: string;
  schema: Record<string, unknown>;
  binding_schema?: Record<string, unknown>;
  implementations: Array<{
    type_name: string;
    type_version: number;
    type_path?: string;
    digest: string;
    fields: Record<string, string>;
    binding?: Record<string, unknown>;
  }>;
}

interface ApplicationRequirements {
  contracts: ContractRequirement[];
  access?: "contract" | "full_collection";
  collection_kind?: "hosted";
}

interface TypePackProvision {
  manifest: {
    kind: "mdbase.type-pack";
    id: string;
    version: string;
    name?: string;
    description?: string;
    resources: Array<{
      kind: "contract" | "type" | "schema";
      source: string;
      target: string;
      digest: string;
    }>;
  };
  resources: Array<{ source: string; document: string }>;
  provides: ContractRequirement[];
}

interface ApplicationProvisions {
  type_packs: TypePackProvision[];
}

interface NotificationCriterion {
  id: string;
  event: ContractRequirement;
  if?: { $expr: string };
  debounce?: string;
  minimum_interval?: string;
  presentation: {
    title: string;
    body?: string;
    tag?: string;
  };
}

interface ApplicationNotifications {
  criteria: NotificationCriterion[];
}

interface GrantScope {
  contracts: CollectionContractDescriptor[];
  access: "contract" | "full_collection";
}

interface StartupSetting {
  enabled: boolean;
  available: boolean;
}

interface DesktopUpdateStatus {
  phase:
    | "unavailable"
    | "idle"
    | "checking"
    | "deferred"
    | "downloading"
    | "ready"
    | "external"
    | "installing"
    | "recovery"
    | "failed";
  current_version: string;
  channel: "stable" | "beta";
  target_version?: string;
  checked_at?: string;
  progress?: number;
  message: string;
  release_url?: string;
  can_check: boolean;
  can_install: boolean;
}

interface CloudSetting {
  configured: boolean;
  serverUrl: string | null;
}

interface ConnectorAccount {
  connector_id: string;
  connector_name: string;
  user_name: string;
  user_email: string;
}

interface GrantSummary {
  id: string;
  application_id: string;
  application_family_id?: string;
  application_name: string;
  application_distribution: "web" | "portable";
  application_homepage: string;
  application_project_url?: string;
  application_origin: string;
  application_icon?: string;
  collection_id: string;
  collection_name: string;
  collection_kind?: "local" | "hosted";
  operations: string[];
  scope: GrantScope;
  created_at: string;
}

interface PendingAuthorization {
  id: string;
  application_id: string;
  application_name: string;
  application_distribution: "web" | "portable";
  application_homepage: string;
  application_project_url?: string;
  flow: "authorization_code" | "device_code";
  user_code?: string;
  application_icon?: string;
  requested_operations: string[];
  collection_hint?: string;
  requirements: ApplicationRequirements;
  provisions: ApplicationProvisions;
  notifications: ApplicationNotifications;
  compatible_collection_ids: string[];
  provisionable_collection_ids: string[];
  expires_at: string;
}

interface AccessSnapshot {
  configured: boolean;
  online: boolean;
  account?: ConnectorAccount;
  grants: GrantSummary[];
  pending_authorizations: PendingAuthorization[];
  authority_conflicts: AuthorityConflict[];
}

interface HostedReplicaSummary {
  id: string;
  name: string;
  mode: "read_only" | "read_write";
  allowed_types: string[];
  revoked_at: string | null;
  created_at: string;
  sync_status: {
    head: number;
    acknowledged_sequence: number;
    last_seen_at: string | null;
    token_expires_at: string;
  } | null;
}

interface HostedCollectionSummary {
  id: string;
  display_name: string;
  template: "mdbase";
  sync_url: string;
  spec_version: string;
  contracts: CollectionContractDescriptor[];
  authority_state: "active" | "transferring" | "transferred";
  authority_epoch: number;
  transferred_collection_id: string | null;
  created_at: string;
  replicas: HostedReplicaSummary[];
}

interface HostedControlSnapshot {
  online: boolean;
  hosted_collections_available?: boolean;
  hosted_collections: HostedCollectionSummary[];
  grants: GrantSummary[];
  pending_authorizations: PendingAuthorization[];
}

interface DesktopMirrorSummary {
  collection_id: string;
  replica_id: string;
  name: string;
  mode: "read_only" | "read_write";
  path: string;
  state: "not_initialized" | "up_to_date" | "changes_waiting" | "attention" | "offline";
  pending: number;
  conflicts: Array<{
    record_id: string;
    path: string | null;
    kind: "conflicted" | "rejected";
    message: string;
  }>;
  local_issues: Array<{
    path: string;
    code: "invalid_frontmatter";
    message: string;
  }>;
  cursor: number | null;
  last_synced_at: string | null;
  syncing: boolean;
  promotion_pending: boolean;
  promotion?: {
    phase:
      | "synchronizing"
      | "awaiting_approval"
      | "verifying"
      | "registering"
      | "registered"
      | "activating"
      | "completed"
      | "resuming";
  };
  progress?: {
    phase: "uploading" | "applying";
    completed: number;
    total: number | null;
  };
  error?: string;
}

interface AuthorityConflict {
  collection_id: string;
  display_name: string;
  active_connector_name: string;
}

interface ActivityEntry {
  id: string;
  application_id: string;
  application_name: string;
  collection_id: string;
  collection_name: string;
  operation: string;
  outcome: "succeeded" | "failed" | "denied";
  detail?: string;
  created_at: string;
}

interface Window {
  mdbaseConnect: {
    status(): Promise<AgentStatus>;
    updateStatus(): Promise<DesktopUpdateStatus>;
    checkForUpdates(): Promise<DesktopUpdateStatus>;
    installUpdate(): Promise<DesktopUpdateStatus>;
    listCollections(): Promise<CollectionSummary[]>;
    addCollection(): Promise<
      | { status: "added"; collection: CollectionSummary }
      | { status: "copy_requires_new_identity"; path: string }
      | null
    >;
    addCopiedCollection(path: string): Promise<CollectionSummary>;
    makeCollectionIndependent(collectionId: string): Promise<CollectionSummary>;
    takeCollectionAuthority(collectionId: string): Promise<{ ok: true }>;
    transferCollectionAuthority(collectionId: string): Promise<{
      transfer: { status: "completed"; collection_id: string; authority_epoch: number };
      mirror: DesktopMirrorSummary;
    }>;
    chooseCreateFolder(): Promise<string | null>;
    createCollection(input: { path: string; name: string }): Promise<CollectionSummary>;
    updateCollectionMetadata(input: { collectionId: string; name: string; description?: string }): Promise<CollectionSummary>;
    setCollectionEnabled(collectionId: string, enabled: boolean): Promise<CollectionSummary>;
    validateCollection(collectionId: string): Promise<unknown>;
    removeCollection(collectionId: string): Promise<CollectionSummary>;
    openPath(path: string): Promise<string>;
    openCollectionConfig(collectionId: string): Promise<string>;
    openEditor(collectionId: string): Promise<void>;
    getLaunchAtLogin(): Promise<StartupSetting>;
    setLaunchAtLogin(enabled: boolean): Promise<StartupSetting>;
    getCloudConfig(): Promise<CloudSetting>;
    setCloudConfig(input: { serverUrl: string; connectorToken: string }): Promise<CloudSetting>;
    clearCloudConfig(): Promise<CloudSetting>;
    beginPairing(input: { serverUrl: string; connectorName: string }): Promise<{
      pairingId: string;
      verificationUri: string;
      expiresIn: number;
    }>;
    pairingStatus(pairingId: string): Promise<{ status: "pending" | "paired"; connector?: { id: string; name: string } }>;
    accessSnapshot(): Promise<AccessSnapshot>;
    setAccessPaused(paused: boolean): Promise<{ paused: boolean }>;
    renameComputer(name: string): Promise<{ connector: { id: string; name: string } }>;
    createGrant(input: { applicationId: string; collectionId: string; operations: string[] }): Promise<unknown>;
    updateGrant(input: { grantId: string; operations: string[] }): Promise<unknown>;
    revokeGrant(grantId: string): Promise<unknown>;
    approveAuthorization(input: { requestId: string; collectionId: string; operations: string[] }): Promise<unknown>;
    denyAuthorization(requestId: string): Promise<unknown>;
    listActivity(limit?: number): Promise<ActivityEntry[]>;
    hostedSnapshot(): Promise<HostedControlSnapshot>;
    createHostedCollection(name: string): Promise<{ collection: HostedCollectionSummary }>;
    renameHostedCollection(input: { collectionId: string; name: string }): Promise<{ collection: { id: string; display_name: string } }>;
    deleteHostedCollection(collectionId: string): Promise<{ ok: true }>;
    approveHostedAuthorization(input: { requestId: string; collectionId: string; operations: string[] }): Promise<{ ok: true }>;
    updateHostedGrant(input: { grantId: string; operations: string[] }): Promise<unknown>;
    revokeHostedGrant(grantId: string): Promise<unknown>;
    revokeHostedReplica(replicaId: string): Promise<{ ok: true }>;
    listMirrors(): Promise<DesktopMirrorSummary[]>;
    chooseMirrorFolder(): Promise<string | null>;
    connectMirror(input: { collectionId: string; path: string; mode: "read_only" | "read_write"; name?: string }): Promise<DesktopMirrorSummary>;
    syncMirror(replicaId: string): Promise<DesktopMirrorSummary>;
    resolveMirrorConflict(input: { replicaId: string; recordId: string; resolution: "local" | "remote" }): Promise<DesktopMirrorSummary>;
    promoteMirrorAuthority(replicaId: string): Promise<{
      collection_id: string;
      authority_epoch: number;
      path: string;
    }>;
    disconnectMirror(replicaId: string): Promise<{ ok: true }>;
    openMirror(replicaId: string): Promise<string>;
    onNavigate(listener: (route: string) => void): () => void;
    onUpdateStatus(listener: (status: DesktopUpdateStatus) => void): () => void;
  };
}
