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
  authentication: { provider: "github" | "tailscale" | "session" };
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
    homepage: string;
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
}

export interface HostedCollection {
  id: string;
  display_name: string;
  template: "mdbase" | "tasknotes";
  provider_url: string;
  spec_version: string;
  contracts: ContractRequirement[];
  created_at: string;
  replicas: HostedReplica[];
}

export interface PendingAuthorization {
  id: string;
  requested_operations: string[];
  expires_at: string;
  application_id: string;
  application_name: string;
  homepage: string;
  icon: string | null;
  requirements: ApplicationRequirements;
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
}

export interface GrantScope {
  contracts: ContractRequirement[];
}
