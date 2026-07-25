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
    throw new ApiError(response.status, body?.error?.message ?? `Request failed with HTTP ${response.status}.`);
  }
  return body as T;
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface DashboardData {
  user: { id: string; name: string; email: string | null; login: string | null };
  authentication: {
    provider: "google" | "github" | "tailscale" | "session";
    registration: "closed" | "open";
  };
  connectors: Array<{ id: string; name: string; last_seen_at: string | null; created_at: string }>;
  collections: Array<{
    id: string;
    connector_id: string;
    local_id: string;
    connector_name: string;
    display_name: string;
    spec_version: string;
    enabled: boolean;
    contracts: ContractRequirement[];
    last_seen_at: string;
  }>;
  hosted_collections: HostedCollection[];
  grants: Array<{
    id: string;
    operations: string[];
    scope: GrantScope;
    created_at: string;
    revoked_at: string | null;
    collection_id: string;
    collection_name: string;
    collection_kind: "local" | "hosted";
    application_id: string;
    application_name: string;
    distribution: "web" | "portable";
    homepage: string;
    project_url: string | null;
    application_origin: string;
    icon: string | null;
  }>;
  pending_authorizations: PendingAuthorization[];
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
  contracts: ContractRequirement[];
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
  collection_hint?: string | null;
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
}

export interface AvailableCollection {
  id: string;
  kind?: "local" | "hosted";
  connector_name: string;
  display_name: string;
  spec_version: string;
  contracts: ContractRequirement[];
}

export interface ContractRequirement {
  id: string;
  version: number;
}

export interface ApplicationRequirements {
  contracts: ContractRequirement[];
  access?: "contract" | "full_collection";
  collection_kind?: "local" | "hosted";
}

export interface TypeProvision {
  name: string;
  path?: string;
  document: string;
  provides: ContractRequirement[];
}

export interface ApplicationProvisions {
  types: TypeProvision[];
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

export interface GrantScope {
  contracts: ContractRequirement[];
  access: "contract" | "full_collection";
}
