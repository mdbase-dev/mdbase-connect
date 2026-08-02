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
      typeof body?.error?.code === "string" ? body.error.code : undefined
    );
  }
  return body as T;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string
  ) {
    super(message);
  }
}

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
  flow: "authorization_code" | "device_code";
  user_code?: string | null;
  requested_operations: string[];
  collection_id?: string | null;
  expires_at: string;
  application_id: string;
  application_name: string;
  distribution: "web" | "portable";
  homepage: string;
  project_url: string | null;
  icon: string | null;
  requirements: ApplicationRequirements;
  provisions: ApplicationProvisions;
  notifications: ApplicationNotifications;
  available_collections?: AvailableCollection[];
  unavailable_connectors?: UnavailableConnector[];
}

export interface AvailableCollection {
  id: string;
  offer_id?: string;
  kind?: "local" | "hosted";
  connector_name: string;
  display_name: string;
  spec_version: string;
  contracts: CollectionContractDescriptor[];
  types?: CollectionTypeDescriptor[];
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

export interface ApplicationRequirements {
  contracts: ContractRequirement[];
  access?: "contract" | "full_collection";
  collection_kind?: "local" | "hosted";
  files?: {
    actions: Array<"list" | "read" | "add" | "replace" | "move" | "delete">;
    scope:
      | { kind: "selected_folders"; folders: string[] }
      | { kind: "collection" };
  };
}

export interface TypePackProvision {
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

export interface ApplicationProvisions {
  type_packs: TypePackProvision[];
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
