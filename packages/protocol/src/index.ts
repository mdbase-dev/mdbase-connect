import type { ConnectProblem } from "./connect-problems.generated.js";
import type {
  ApplicationFileRequirement,
  CollectionFileDescriptor,
  FileCapability
} from "./files.js";
import type { CollectionOperation } from "./operations.js";
import type { ApplicationCapabilityRequirements } from "./capabilities.js";
import type { ContractRequirement, ContractSetupChoice, TypePackProvision } from "./type-packs.js";
import type {
  ApplicationAuthorizationProof
} from "./application-authorization.js";
export * from "./connect-problems.generated.js";
export * from "./files.js";
export * from "./operations.js";
export * from "./capabilities.js";
export * from "./application-authorization.js";
export * from "./type-packs.js";

export const CONTROL_PROTOCOL_VERSION = 1 as const;
export const ENCRYPTED_RELAY_PROTOCOL_VERSION = 1 as const;
export const APPLICATION_AUTHORIZATION_PROTOCOL_VERSION = 2 as const;
export const LOOPBACK_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_LOOPBACK_PORT = 28_485 as const;
export const RELAY_ENCRYPTION_SUITE = "P256-HKDF-SHA256-AES256GCM" as const;
export const SYNC_PROTOCOL_VERSION = 1 as const;
export const CONTRACT_SETUP_CAPABILITY = "contract-setup-v1" as const;
export const FILE_RELAY_CAPABILITY = "file-relay-v1" as const;
export const RELAY_REQUIRED_CAPABILITIES = [
  "application-authorization-v2",
  "authorization-activation",
  "encrypted-relay",
  "policy-ack"
] as const;
export const RELAY_CAPABILITIES = [
  ...RELAY_REQUIRED_CAPABILITIES,
  CONTRACT_SETUP_CAPABILITY,
  FILE_RELAY_CAPABILITY
] as const;
export const AUTHORITY_PROOF_VERSION = 1 as const;
export const AUTHORITY_PROOF_ALGORITHM = "P256-SHA256" as const;
export const AUTHORITY_PROOF_DOMAIN = "mdbase-authority-request-proof-v1" as const;
export const AUTHORITY_PROOF_HEADERS = {
  version: "x-mdbase-proof-version",
  timestamp: "x-mdbase-proof-timestamp",
  nonce: "x-mdbase-proof-nonce",
  signature: "x-mdbase-proof-signature"
} as const;

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
  notificationWebhook: "https://mdbase.dev/connect/schemas/notification-webhook.v1.json",
  dataContract: "https://mdbase.dev/schemas/v0.3/data-contract.schema.json",
  eventActionInterop: "https://mdbase.dev/schemas/interop/v0.1/profile.schema.json",
  protocol: "https://mdbase.dev/connect/schemas/connect-protocol.v1.json",
  encryptedRelay: "https://mdbase.dev/connect/schemas/encrypted-relay.v1.json",
  files: "https://mdbase.dev/connect/schemas/files.v1.json",
  sync: "https://mdbase.dev/connect/schemas/sync.v1.json"
} as const;

export interface NotificationCriterion {
  /** Stable, manifest-owned identifier selected by an installation. */
  id: string;
  /** Runtime event contract evaluated at the collection authority. */
  event: ContractRequirement;
  /** Canonical mdbase CEL. Event content never leaves the authority for evaluation. */
  if?: { $expr: string };
  debounce?: string;
  minimum_interval?: string;
  /** Static Web Push copy. Dynamic record content is intentionally unsupported. */
  presentation: {
    title: string;
    body?: string;
    tag?: string;
  };
}

export type NativeNotificationDelivery =
  | {
      /**
       * Connect sends through FCM using revocable, least-privilege authority
       * granted by the application's Firebase project.
       */
      mode: "managed_fcm";
      firebase_project_id: string;
    }
  | {
      /**
       * Connect sends a signed, content-free signal to infrastructure operated
       * by the application developer. That infrastructure owns APNs/FCM.
       */
      mode: "webhook";
      url: string;
    };

export interface ApplicationNotifications {
  criteria: NotificationCriterion[];
  /** Optional native delivery route. Web Push registration remains independent. */
  native_delivery?: NativeNotificationDelivery;
}

/**
 * The declaration bundled with an application build and registered inline.
 *
 * `id` is stable presentation metadata rather than proof of a publisher. Each
 * exact declaration is independently identified and authorized by Connect.
 */
interface MdbaseAppManifestBase {
  manifest_version: 1;
  id: string;
  name: string;
  requirements?: ApplicationRequirements;
  provisions?: ApplicationProvisions;
  notifications?: ApplicationNotifications;
}

export interface MdbaseWebAppManifest extends MdbaseAppManifestBase {
  /** Omitted by existing v1 declarations; explicit `web` is equivalent. */
  distribution?: "web";
  homepage: string;
  icon?: string;
  redirect_uris: string[];
}

export interface MdbasePortableAppManifest extends MdbaseAppManifestBase {
  /**
   * A downloaded, publisher-unverified application opened from a local file.
   * Portable declarations use device authorization and never claim a web origin.
   */
  distribution: "portable";
  /** Optional HTTPS page where the user can inspect the project or source. */
  project_url?: string;
  /** Optional HTTPS icon on the project URL's origin. */
  icon?: string;
}

export type MdbaseAppManifest =
  | MdbaseWebAppManifest
  | MdbasePortableAppManifest;

export interface NotificationSignal {
  /** Stable idempotency key generated by the collection authority. */
  signal_id: string;
  grant_id: string;
  criterion_id: string;
  /** Opaque authority cursor used by the app to retrieve current state after waking. */
  cursor: string;
}

export interface NotificationPresentation {
  title: string;
  body?: string;
  tag?: string;
}

export interface MdbaseNotification {
  type: "mdbase.notification";
  version: 1;
  signal_id: string;
  criterion_id: string;
  cursor: string;
  presentation: NotificationPresentation;
}

export interface NotificationWebhook {
  type: "mdbase.notification.webhook";
  version: 1;
  delivery_id: string;
  /** Opaque application grant reference returned during authorization. */
  connection_id: string;
  notification: MdbaseNotification;
}

export interface ApplicationRequirements {
  contracts: ContractRequirement[];
  /** Versioned semantic intent compiled by Connect into exact operations. */
  capabilities?: ApplicationCapabilityRequirements;
  /** Access boundary requested after compatibility and provisioning checks. */
  access?: "contract" | "full_collection";
  /** Restrict authorization to durable provider-backed collections. */
  collection_kind?: "hosted";
  /** First-class non-Markdown file access requested independently of records. */
  files?: ApplicationFileRequirement;
}

export interface ApplicationProvisions {
  type_packs: TypePackProvision[];
}

export interface GrantScope {
  /**
   * Exact contract definitions and sorted implementation sets approved by the
   * user. Digests make the scope fail closed if either the interface or any
   * provider changes after approval.
   */
  contracts: CollectionContractDescriptor[];
  access: "contract" | "full_collection";
}

export interface RelayOperationRequest {
  type: "operation_request";
  protocol_version: 1;
  request_id: string;
  grant_id: string;
  collection_id: string;
  application_id: string;
  operation: CollectionOperation;
  input: unknown;
}

export type RelayOperationResponse =
  | {
      type: "operation_response";
      protocol_version: 1;
      request_id: string;
      ok: true;
      result: unknown;
    }
  | {
      type: "operation_response";
      protocol_version: 1;
      request_id: string;
      ok: false;
      problem: ConnectProblem;
    };

export interface MdbaseOperationRequest<Input = unknown> {
  protocol_version: 1;
  request_id: string;
  input: Input;
}

export type MdbaseOperationResponse<Result = unknown> =
  | {
      protocol_version: 1;
      request_id: string;
      ok: true;
      result: Result;
    }
  | {
      protocol_version: 1;
      request_id: string;
      ok: false;
      problem: ConnectProblem;
    };

export interface GrantPolicy {
  id: string;
  application_id: string;
  collection_id: string;
  operations: CollectionOperation[];
  scope: GrantScope;
  application_name: string;
  /** Distribution profile used when the exact application manifest was approved. */
  application_distribution?: "web" | "portable";
  application_homepage: string;
  /** Informational HTTPS project page for a downloaded portable application. */
  application_project_url?: string;
  /** Exact browser origin authorized to use this grant over loopback. */
  application_origin?: string;
  application_icon?: string;
  collection_name: string;
  /** Approval-time criterion snapshot evaluated only by this collection authority. */
  notification_criteria?: NotificationCriterion[];
  created_at: string;
  encryption?: GrantEncryption;
  file_capability?: FileCapability;
  application_authorization: ApplicationAuthorizationProof;
}

/** Presentation-only grant shape used outside a local authorization boundary. */
export type GrantSummary = Omit<
  GrantPolicy,
  "application_authorization"
>;

export interface GrantEncryption {
  protocol_version: 1;
  suite: typeof RELAY_ENCRYPTION_SUITE;
  key_id: string;
  scope_epoch: number;
  connector_id: string;
  collection_id: string;
  application_agreement_public_key: string;
  connector_agreement_public_key: string;
}

export interface EncryptedRelayEnvelope {
  protocol_version: 1;
  suite: typeof RELAY_ENCRYPTION_SUITE;
  request_id: string;
  grant_id: string;
  application_id: string;
  connector_id: string;
  collection_id: string;
  operation: EncryptedRelayOperation;
  scope_epoch: number;
  key_id: string;
  counter: string;
  ciphertext: string;
}

/** Encrypted control namespaces share grant authentication but not record permissions. */
export type EncryptedRelayOperation = CollectionOperation | "file_control";

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
  kind: "configuration" | "lock" | "type" | "contract" | "schema" | "view";
  /** SHA-256 revision of the exact UTF-8 document (`sha256:<lowercase hex>`). */
  revision: string;
  document: string;
}

export interface AuthoritySnapshotRecord<Frontmatter extends JsonObject = JsonObject> {
  record: SyncRecord<Frontmatter>;
  document: string;
}

export interface AuthoritySnapshot<Frontmatter extends JsonObject = JsonObject> {
  protocol_version: 1;
  collection_id: string;
  source_head: number;
  source_revision: string;
  manifest_digest: string;
  resources: SyncCollectionResources;
  records: Array<AuthoritySnapshotRecord<Frontmatter>>;
  files: CollectionFileDescriptor[];
}

export interface AuthorityImportManifest {
  protocol_version: 1;
  collection_id: string;
  source_head: number;
  source_revision: string;
  manifest_digest: string;
  resources: SyncCollectionResources;
  record_count: number;
  file_count: number;
  files: CollectionFileDescriptor[];
}

export interface AuthorityImportRecord {
  record_id: string;
  path: string;
  document: string;
}

export interface AuthorityImportSnapshot {
  protocol_version: 1;
  collection_id: string;
  source_head: number;
  source_revision: string;
  manifest_digest: string;
  resources: SyncCollectionResources;
  records: AuthorityImportRecord[];
  files: CollectionFileDescriptor[];
}

export interface AuthorityImportRecordPage {
  protocol_version: 1;
  page: number;
  records: AuthorityImportRecord[];
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
  records: Array<SyncSnapshotRecord<Frontmatter>>;
  next_page?: string;
}

export interface SyncSnapshotRecord<Frontmatter extends JsonObject = JsonObject>
  extends SyncRecord<Frontmatter> {
  /** Exact bytes whose SHA-256 revision and parsed metadata match this record. */
  document: string;
}

/** Manifest-only snapshot page. File bytes are fetched by digest via the file data plane. */
export interface SyncFileSnapshotPage {
  protocol_version: 1;
  type: "file_snapshot_page";
  snapshot_id: string;
  scope_epoch: number;
  cursor: number;
  files: CollectionFileDescriptor[];
  next_page?: string;
}

export type SyncChange<Frontmatter extends JsonObject = JsonObject> =
  | { sequence: number; type: "put"; record: SyncRecord<Frontmatter> }
  | { sequence: number; type: "remove"; record_id: string; previous_path: string; revision: string }
  | { sequence: number; type: "file_put"; file: CollectionFileDescriptor }
  | { sequence: number; type: "file_remove"; file_id: string; previous_path: string; revision: string };

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

interface SyncFileMutationBase {
  mutation_id: string;
  replica_id: string;
  scope_epoch: number;
  file_id: string;
  created_at: string;
  causal_predecessor?: string;
}

export type SyncFileMutation =
  | SyncFileMutationBase & {
      operation: "file_put";
      base_revision?: string;
      path: string;
      transfer_id: string;
      content_digest: `sha256:${string}`;
      size: number;
      media_type?: string;
    }
  | SyncFileMutationBase & {
      operation: "file_move";
      base_revision: string;
      path: string;
      update_references: boolean;
    }
  | SyncFileMutationBase & {
      operation: "file_delete";
      base_revision: string;
    };

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

export interface SyncFileConflict {
  file_id: string;
  mutation: SyncFileMutation;
  current?: CollectionFileDescriptor;
  current_revision?: string;
}

export type SyncFileMutationReceipt =
  | {
      mutation_id: string;
      status: "file_applied" | "file_previously_applied";
      sequence: number;
      file?: CollectionFileDescriptor;
    }
  | { mutation_id: string; status: "file_conflicted"; conflict: SyncFileConflict }
  | { mutation_id: string; status: "file_rejected"; error: { code: string; message: string } };

export type EncryptedRelayOperationRequest = EncryptedRelayEnvelope & {
  type: "encrypted_operation_request";
};

export type EncryptedRelayOperationResponse = EncryptedRelayEnvelope & {
  type: "encrypted_operation_response";
};

export interface RelayPolicySnapshot {
  type: "policy_snapshot";
  protocol_version: 1;
  request_id: string;
  revision: string;
  grants: GrantPolicy[];
}

export interface RelayHello {
  type: "relay_hello";
  protocol_version: 1;
  connector_version: string;
  capabilities: string[];
}

export interface RelayWelcome {
  type: "relay_welcome";
  protocol_version: 1;
  session_id: string;
  capabilities: string[];
}

export interface RelayIncompatible {
  type: "relay_incompatible";
  protocol_version: 1;
  code: "connector_upgrade_required";
  message: string;
  update_url: string;
}

export interface RelayPolicyApplied {
  type: "policy_applied";
  protocol_version: 1;
  request_id: string;
  revision: string;
  ok: boolean;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface AuthorizationCollectionOffer {
  collection_id: string;
  display_name: string;
  spec_version: string;
  contracts: CollectionContractDescriptor[];
  /** Minimal schema metadata; type source and collection paths never leave the authority. */
  types: CollectionTypeDescriptor[];
}

export interface AuthorizationOfferResponse {
  type: "authorization_offer_response";
  protocol_version: 1;
  request_id: string;
  paused: boolean;
  collections: AuthorizationCollectionOffer[];
}

export interface AuthorizationActivationResponse {
  type: "authorization_activation_response";
  protocol_version: 1;
  request_id: string;
  ok: boolean;
  contracts: CollectionContractDescriptor[];
  /** Exact setup plan applied by the authority. */
  contract_setups: ContractSetupChoice[];
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface ConnectorCollection {
  id: string;
  display_name: string;
  spec_version: string;
  enabled: boolean;
  contracts: CollectionContractDescriptor[];
}

export type JsonObject = Record<string, unknown>;

export interface MdbaseDiagnostic {
  [key: string]: unknown;
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

/**
 * A saved-view row always includes the canonical frontmatter used to evaluate
 * the view. Empty-frontmatter Markdown is represented by an empty object.
 */
export interface SavedViewRecord<Frontmatter extends JsonObject = JsonObject>
  extends Omit<QueryRecord<Frontmatter>, "effective_frontmatter"> {
  effective_frontmatter: Frontmatter;
  values?: JsonObject;
}

export interface SavedViewExecution<Frontmatter extends JsonObject = JsonObject> {
  results: Array<SavedViewRecord<Frontmatter>>;
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

export interface DataContractViewIdentity {
  id: string;
  version: string;
  digest: string;
  type: string;
  implementation_digest: string;
}

/**
 * A projected query row. Frontmatter members are optional because
 * `frontmatter_mode` selects which fixed-semantics representation is returned.
 */
export interface QueryRecord<Frontmatter extends JsonObject = JsonObject> {
  path: string;
  frontmatter?: Frontmatter;
  effective_frontmatter?: Frontmatter;
  body?: string;
  types: string[];
  file: Partial<CollectionFileMetadata> & { path?: string };
  /** Present when the authority returned a normalized contract projection. */
  contract?: DataContractViewIdentity;
}

/** An authoritative record or a field-limited data-contract projection. */
export interface RecordDocument<Frontmatter extends JsonObject = JsonObject> {
  path: string;
  revision: string;
  types: string[];
  frontmatter: Frontmatter;
  effective_frontmatter: Frontmatter;
  /** Omitted from contract-scoped results. */
  body?: string;
  /**
   * The exact UTF-8 Markdown source, including frontmatter delimiters,
   * comments, quoting, whitespace, line endings, and trailing newline.
   * Returned only when the operation requests it.
   */
  document?: string;
  file: Partial<CollectionFileMetadata> & { path?: string };
  /** Present when the authority returned a normalized contract projection. */
  contract?: DataContractViewIdentity;
}

export interface CollectionTypeDescriptor {
  name: string;
  version?: number;
  description?: string;
  /** Digest of the exact type source used as a setup precondition. */
  revision?: string;
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
  /** Collection operations expose only record contracts. */
  contract_type: "record";
  id: string;
  version: string;
  /** Digest of the resolved contract schemas and metadata. */
  digest: string;
  /** Resolved portable record-view schema. */
  schema: JsonObject;
  /** Resolved implementation-binding schema, when the contract declares one. */
  binding_schema?: JsonObject;
  /** Every type currently implementing this exact contract, sorted by type name. */
  implementations: CollectionContractImplementationDescriptor[];
}

export interface CollectionContractImplementationDescriptor {
  type_name: string;
  type_version: number;
  type_path?: string;
  /** Digest of the contract digest, type schema, fields, and binding. */
  digest: string;
  fields: Record<string, string>;
  binding?: JsonObject;
}

export interface CollectionDescription {
  protocol_version: 1;
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
