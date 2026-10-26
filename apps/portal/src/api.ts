export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(
      response.status,
      body?.error?.message ?? `Request failed with HTTP ${response.status}.`,
      typeof body?.error?.code === "string" ? body.error.code : undefined,
      body?.error?.details
    );
  }
  return body as T;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export interface DevicePairing {
  connector_name: string;
  approved_at: string | null;
  installation_device?: boolean;
  kind?: "app-runtime" | "mobile";
  account_selected?: boolean;
  account_selection_confirmed?: boolean;
  account_email?: string | null;
  account_provider?: string;
  account_login?: string;
  signed_in_account_email?: string | null;
  signed_in_account_provider?: string;
  signed_in_account_login?: string;
  selected_collection_id?: string | null;
  native_authorization_id?: string | null;
  collection_hint?: string | null;
  can_create_collection?: boolean;
  creation?: {collection_id:string;display_name:string;completed:boolean} | null;
  attested?: boolean;
  fingerprint?: string | null;
  app_origin?: string;
  app_platform?: "native";
  return_url?: string | null;
  timer_declaration?: {digest:string};
  timer_consent?: boolean | null;
  requested_create_collections?: boolean;
  approved_create_collections?: boolean;
  approved_collection_ids?: string[];
  scope_only?: boolean;
  account_upgraded?: boolean;
  account_upgrade?: "in_progress" | "postponed" | "scheduled" | "not_scheduled" | null;
  retained_collection_ids?: string[];
  retained_create_collections?: boolean;
  collections?: Array<{collection_id:string;display_name:string;role:string;kind?:"private"}>;
  file_access?: FileAccessRequest;
}
interface FileAccessRequest {
  collection_id: string;
  collection_name: string | null;
  actions: FileAction[];
  reason: string;
  approved_actions: FileAction[] | null;
}
export type FileAction = "list" | "read" | "add" | "replace" | "move" | "delete";

export interface HostedReplica {
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

export interface HostedCollection {
  id: string;
  display_name: string;
  template: "mdbase";
  provider_url: string;
  spec_version: string;
  contracts: CollectionContractDescriptor[];
  authority_state: "active" | "transferring" | "transferred";
  authority_epoch: number;
  transferred_collection_id: string | null;
  created_at: string;
  replicas: HostedReplica[];
}

export interface AuthorityTransfer {
  id: string;
  collection_id: string;
  replica_id: string;
  state: "requested" | "approved" | "prepared" | "completed" | "cancelled" | "expired";
  final_head: number | null;
  authority_epoch: number | null;
  manifest_digest: string | null;
  expires_at: string;
  verification_uri: string;
  local_collection_id?: string;
  collection_name?: string;
  mirror_name?: string;
}

export interface PendingAuthorization {
  id: string;
  /** Persisted consenting account marker, not inferred from the Noise key. */
  account_backend?: "legacy" | "next";
  flow: "authorization_code" | "device_code";
  user_code?: string | null;
  requested_operations: string[];
  collection_id?: string | null;
  expires_at: string;
  application_id: string;
  application_name: string;
  distribution: "web" | "portable";
  platform?: "native";
  application_origin?: string;
  homepage: string;
  project_url: string | null;
  icon: string | null;
  requirements: ApplicationRequirements;
  provisions: ApplicationProvisions;
  notifications: ApplicationNotifications;
  /** Fingerprint of the app's attested Noise key, when it registered one (mdbase-next). */
  client_fingerprint?: string | null;
  existing_access?: Array<{
    collection_id: string;
    operations: string[];
  }>;
  available_collections?: AvailableCollection[];
  unavailable_connectors?: UnavailableConnector[];
}

export interface AvailableCollection {
  id: string;
  offer_id?: string;
  /** `private`: an end-to-end encrypted collection; a device approves the grant. */
  kind?: "local" | "hosted" | "private";
  connector_name: string;
  display_name: string;
  spec_version: string;
  contracts: CollectionContractDescriptor[];
  types?: CollectionTypeDescriptor[];
  authorization?:
    | { available: true; operations: string[]; file_actions: ApplicationFileAction[] }
    | { available: false; detail: string };
}

export interface CollectionTypeDescriptor {
  name: string;
  version?: number;
  description?: string;
  revision?: string;
  schema: Record<string, unknown>;
}

export type ContractSetupChoice =
  | { contract: ContractRequirement; mode: "starter" }
  | {
      contract: ContractRequirement;
      mode: "existing";
      type_name: string;
      type_revision: string;
      fields: Record<string, string>;
      binding?: Record<string, unknown>;
    };

export interface UnavailableConnector {
  connector_id: string;
  connector_name: string;
  reason: "offline" | "paused";
}

export interface ContractRequirement {
  id: string;
  version: string;
  digest: string;
}

export interface CollectionContractDescriptor extends ContractRequirement {
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

export type ApplicationCapabilityId =
  | "collection.read"
  | "records.create"
  | "records.edit"
  | "records.delete"
  | "views.manage"
  | "definitions.manage"
  | "background.schedule"
  | "offline.replica";

export type ApplicationFileAction =
  | "list" | "read" | "add" | "replace" | "move" | "delete";

export type ApplicationRequirements = CapabilityApplicationRequirements | LegacyApplicationRequirements;

export type LegacyApplicationRequirements = Omit<CapabilityApplicationRequirements, "capabilities" | "files" | "people"> & {
  capabilities?: import("@mdbase-dev/connect-protocol").LegacyApplicationCapabilityRequirements;
  files?: {
    actions: ApplicationFileAction[];
    scope: NonNullable<CapabilityApplicationRequirements["files"]>["scope"];
  };
};

export interface CapabilityApplicationRequirements {
  people?: import("@mdbase-dev/connect-protocol").ApplicationPeopleRequirement;
  contracts: ContractRequirement[];
  capabilities: {
    contract_version: 2;
    required: ApplicationCapabilityId[];
    optional?: ApplicationCapabilityId[];
  };
  configuration?: ConfigurationRequirement[];
  access?: "contract" | "full_collection";
  collection_kind?: "local" | "hosted";
  files?: {
    required: ApplicationFileAction[];
    optional?: ApplicationFileAction[];
    scope:
      | { kind: "selected_folders"; folders: string[] }
      | { kind: "collection" };
  };
}

type TypePackUpgradeBaseline = { digest: string; document: string; version?: number };

export interface TypePackProvision {
  manifest: {
    kind: "mdbase.type-pack";
    id: string;
    version: string;
    name?: string;
    description?: string;
    resources: Array<{
      kind: "contract" | "type" | "schema";
      upgrade_from?: TypePackUpgradeBaseline | TypePackUpgradeBaseline[];
      source: string;
      target: string;
      digest: string;
    }>;
  };
  resources: Array<{ source: string; document: string }>;
  provides: ContractRequirement[];
}

export interface ApplicationProvisions {
  type_packs: TypePackProvision[];
  configuration?: ConfigurationProvision[];
}

export type ConfigurationContributionValue = string | number | boolean | null;

export interface ConfigurationRequirement {
  id: string;
  path: string;
  predicate: "contains";
  value: ConfigurationContributionValue;
}

export interface ConfigurationProvision {
  requirement: string;
  operation: "set_add";
  path: string;
  value: ConfigurationContributionValue;
}

export interface NotificationCriterion {
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

export interface ApplicationNotifications {
  criteria: NotificationCriterion[];
}
