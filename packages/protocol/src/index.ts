export const CONTROL_PROTOCOL_VERSION = 2 as const;
export const ENCRYPTED_RELAY_PROTOCOL_VERSION = 3 as const;
export const LOOPBACK_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_LOOPBACK_PORT = 28_485 as const;
export const RELAY_ENCRYPTION_SUITE = "P256-HKDF-SHA256-AES256GCM" as const;
export const SYNC_PROTOCOL_VERSION = 1 as const;

/**
 * Validate a native OAuth callback against the publisher of its web manifest.
 * Reverse-domain private-use schemes keep native app identity tied to the
 * manifest origin; PKCE remains mandatory at the authorization boundary.
 */
export function isNativeRedirectUri(url: URL, publisherHostname?: string): boolean {
  const scheme = url.protocol.slice(0, -1);
  const publisherPrefix = publisherHostname
    ?.toLowerCase()
    .split(".")
    .reverse()
    .join(".");
  return scheme.includes(".")
    && /^[a-z][a-z0-9+.-]*$/.test(scheme)
    && !["http", "https", "file", "javascript", "data"].includes(scheme)
    && (!publisherPrefix
      || scheme === publisherPrefix
      || scheme.startsWith(`${publisherPrefix}.`))
    && url.username === ""
    && url.password === ""
    && url.hostname.length > 0
    && url.hash === "";
}

export const CONNECT_SCHEMA_IDS = {
  appManifest: "https://mdbase.dev/connect/schemas/mdbase-app.v1.json",
  contractExtension: "https://mdbase.dev/connect/schemas/contract-extension.v1.json",
  protocol: "https://mdbase.dev/connect/schemas/connect-protocol.v2.json",
  encryptedRelay: "https://mdbase.dev/connect/schemas/encrypted-relay.v3.json",
  sync: "https://mdbase.dev/connect/schemas/sync.v1.json"
} as const;

export type CollectionOperation =
  | "describe"
  | "changes"
  | "read"
  | "query"
  | "list_views"
  | "execute_view"
  | "read_view_source"
  | "create_view_source"
  | "update_view_source"
  | "delete_view_source"
  | "validate"
  | "create"
  | "update"
  | "delete"
  | "rename"
  | "read_type"
  | "create_type"
  | "update_type";

export interface MdbaseAppManifest {
  manifest_version: 1;
  name: string;
  homepage: string;
  icon?: string;
  redirect_uris: string[];
  requirements?: ApplicationRequirements;
  provisions?: ApplicationProvisions;
}

export interface ContractRequirement {
  id: string;
  version: number;
}

export interface ApplicationRequirements {
  contracts: ContractRequirement[];
  /** Access boundary requested after compatibility and provisioning checks. */
  access?: "contract" | "full_collection";
  /** Restrict authorization to durable provider-backed collections. */
  collection_kind?: "hosted";
}

export interface TypeProvision {
  /** Type name shown during approval and verified after installation. */
  name: string;
  /** Optional collection-relative destination. The collection validates the final path. */
  path?: string;
  /** Complete portable mdbase type document. */
  document: string;
  /** Contracts expected to be exposed after this type is installed. */
  provides: ContractRequirement[];
}

export interface ApplicationProvisions {
  types: TypeProvision[];
}

export interface GrantScope {
  contracts: ContractRequirement[];
}

export interface RelayOperationRequest {
  type: "operation_request";
  protocol_version: 2;
  request_id: string;
  grant_id: string;
  collection_id: string;
  application_id: string;
  operation: CollectionOperation;
  input: unknown;
}

export interface RelayOperationResponse {
  type: "operation_response";
  protocol_version: 2;
  request_id: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

export interface GrantPolicy {
  id: string;
  application_id: string;
  collection_id: string;
  operations: CollectionOperation[];
  scope: GrantScope;
  application_name: string;
  application_homepage: string;
  /** Exact browser origin authorized to use this grant over loopback. */
  application_origin?: string;
  application_icon?: string;
  collection_name: string;
  created_at: string;
  encryption?: GrantEncryption;
}

export interface GrantEncryption {
  protocol_version: 3;
  suite: typeof RELAY_ENCRYPTION_SUITE;
  key_id: string;
  scope_epoch: number;
  connector_id: string;
  collection_id: string;
  application_public_key: string;
  connector_public_key: string;
}

export interface EncryptedRelayEnvelope {
  protocol_version: 3;
  suite: typeof RELAY_ENCRYPTION_SUITE;
  request_id: string;
  grant_id: string;
  application_id: string;
  connector_id: string;
  collection_id: string;
  operation: CollectionOperation;
  scope_epoch: number;
  key_id: string;
  counter: string;
  ciphertext: string;
}

export interface SyncRecord<Frontmatter extends JsonObject = JsonObject> {
  record_id: string;
  path: string;
  revision: string;
  frontmatter: Frontmatter;
  body: string;
  types: string[];
}

export interface SyncCollectionResources {
  revision: string;
  spec_version: string;
  types: CollectionTypeDescriptor[];
  contracts: CollectionContractDescriptor[];
  documents?: SyncResourceDocument[];
}

export interface SyncResourceDocument {
  path: string;
  kind: "configuration" | "type";
  revision: string;
  document: string;
}

export interface SyncSession {
  protocol_version: 1;
  session_id: string;
  replica_id: string;
  collection_id: string;
  mode: "read_only" | "read_write";
  scope_epoch: number;
  retained_after: number;
  head: number;
  snapshot_id: string;
  resources: SyncCollectionResources;
}

export interface SyncSnapshotPage<Frontmatter extends JsonObject = JsonObject> {
  protocol_version: 1;
  snapshot_id: string;
  scope_epoch: number;
  cursor: number;
  records: Array<SyncRecord<Frontmatter>>;
  next_page?: string;
}

export type SyncChange<Frontmatter extends JsonObject = JsonObject> =
  | { sequence: number; type: "put"; record: SyncRecord<Frontmatter> }
  | { sequence: number; type: "remove"; record_id: string; previous_path: string; revision: string };

export interface SyncChangesPage<Frontmatter extends JsonObject = JsonObject> {
  protocol_version: 1;
  scope_epoch: number;
  events: Array<SyncChange<Frontmatter>>;
  cursor: number;
  head: number;
  has_more: boolean;
  reset_required: boolean;
}

export interface SyncMutation {
  mutation_id: string;
  replica_id: string;
  scope_epoch: number;
  operation: "create" | "update" | "rename" | "delete";
  record_id: string;
  base_revision?: string;
  input: JsonObject;
  created_at: string;
  causal_predecessor?: string;
}

export interface SyncConflict<Frontmatter extends JsonObject = JsonObject> {
  record_id: string;
  mutation: SyncMutation;
  current?: SyncRecord<Frontmatter>;
  current_revision?: string;
}

export type SyncMutationReceipt<Frontmatter extends JsonObject = JsonObject> =
  | { mutation_id: string; status: "applied" | "previously_applied"; sequence: number; record?: SyncRecord<Frontmatter> }
  | { mutation_id: string; status: "conflicted"; conflict: SyncConflict<Frontmatter> }
  | { mutation_id: string; status: "rejected"; error: { code: string; message: string } };

export type EncryptedRelayOperationRequest = EncryptedRelayEnvelope & {
  type: "encrypted_operation_request";
};

export type EncryptedRelayOperationResponse = EncryptedRelayEnvelope & {
  type: "encrypted_operation_response";
};

export interface RelayPolicySnapshot {
  type: "policy_snapshot";
  protocol_version: 2;
  grants: GrantPolicy[];
}

export interface ConnectorCollection {
  id: string;
  display_name: string;
  spec_version: string;
  enabled: boolean;
  contracts: ContractRequirement[];
}

export type JsonObject = Record<string, unknown>;

export interface MdbaseDiagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  path?: string;
  field?: string;
  type?: string;
  schema_location?: string;
  details?: unknown;
}

export interface MdbaseOperationEnvelope<Result = JsonObject> {
  valid: boolean;
  result: Result;
  diagnostics: MdbaseDiagnostic[];
}

export interface SavedViewPresentation extends JsonObject {
  type: string;
  fallback?: string;
  mappings?: Record<string, string>;
  options?: JsonObject;
}

export interface SavedViewSource {
  path: string;
  format: string;
  revision: string;
  writable: boolean;
}

export interface SavedNamedView {
  id: string;
  name: string;
  properties: SavedViewProperty[];
  presentation?: SavedViewPresentation;
}

export interface SavedViewProperty {
  key: string;
  label?: string;
  description?: string;
  format?: string;
  hidden?: boolean;
}

export interface SavedViewDocument {
  id: string;
  name: string;
  source: SavedViewSource;
  views: SavedNamedView[];
}

export interface SavedViewList {
  views: SavedViewDocument[];
  meta: { total_count: number };
}

export interface SavedViewSourceDocument {
  path: string;
  format: string;
  revision: string;
  document: string;
}

export interface ReadViewSourceInput {
  path: string;
}

export interface CreateViewSourceInput {
  document: string;
  path?: string;
  format?: string;
  name?: string;
}

export interface UpdateViewSourceInput {
  path: string;
  document: string;
  if_revision?: string;
}

export interface DeleteViewSourceInput {
  path: string;
  if_revision?: string;
}

export interface DeleteViewSourceResult {
  path: string;
  deleted: boolean;
}

export interface ExecuteViewInput {
  path: string;
  view: string;
  context?: { path: string } | null;
  limit?: number;
  offset?: number;
  render?: boolean;
}

export interface SavedViewExecution<Frontmatter extends JsonObject = JsonObject> {
  results: Array<RecordSummary<Frontmatter> & { values?: JsonObject }>;
  meta: {
    total_count: number;
    has_more: boolean;
    view: { path: string; id: string };
    context?: { path: string };
    groups?: Array<{
      values: JsonObject;
      count: number;
      summaries: JsonObject;
    }>;
  };
}

export interface CollectionFileMetadata extends JsonObject {
  name: string;
  folder: string;
  size: number;
  mtime: string;
  tags?: string[];
  links?: unknown[];
  embeds?: unknown[];
}

export interface RecordSummary<Frontmatter extends JsonObject = JsonObject> {
  path: string;
  frontmatter: Frontmatter;
  raw_frontmatter?: Frontmatter;
  body?: string;
  types: string[];
  file?: CollectionFileMetadata;
}

export interface RecordResult<Frontmatter extends JsonObject = JsonObject>
  extends RecordSummary<Frontmatter> {
  revision: string;
}

export interface CollectionTypeDescriptor {
  name: string;
  version?: number;
  description?: string;
  /** Collection-relative source path. */
  path?: string;
  /** Complete portable type frontmatter, including extension declarations. */
  definition?: JsonObject;
  schema: JsonObject;
  collection?: JsonObject;
  lifecycle?: JsonObject;
  extensions: Record<string, unknown>;
}

export interface CollectionTypeDocument {
  name: string;
  path: string;
  revision: string;
  document: string;
}

export interface CollectionContractDescriptor {
  id: string;
  version: number;
  type_name: string;
  extension: string;
  configuration: JsonObject;
}

export interface CollectionDescription {
  protocol_version: 2;
  collection_id: string;
  display_name: string;
  spec_version: string;
  operations: CollectionOperation[];
  change_cursor: number;
  types: CollectionTypeDescriptor[];
  contracts: CollectionContractDescriptor[];
  /** Canonical collection settings; extension and implementation-specific values are omitted. */
  configuration?: JsonObject;
}

export interface CollectionChange {
  cursor: number;
  type: string;
  occurred_at: string;
  payload: JsonObject;
}

export interface CollectionChangesPage {
  events: CollectionChange[];
  cursor: number;
  has_more: boolean;
  reset: boolean;
}
