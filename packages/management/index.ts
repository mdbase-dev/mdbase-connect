export interface AccountSession {
  id: string;
  provider: "google" | "github" | "password" | "session";
  client_name: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  current: boolean;
}

export interface CollectionContractDescriptor {
  id: string;
  version: string;
  digest: string;
  schema: Record<string, unknown>;
}

export interface HostedReplica {
  id: string;
  name: string;
  mode: "read_only" | "read_write";
  allowed_types: string[];
  revoked_at: string | null;
  revocation_status: "active" | "revoking" | "revoked";
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

export interface ManagementOverview {
  user: { id: string; name: string; email: string | null; login: string | null };
  hosted_collections_available?: boolean;
  authentication: {
    provider: "google" | "github" | "password" | "tailscale" | "session";
    registration: "closed" | "invite" | "open";
  };
  connectors: Array<{
    id: string;
    name: string;
    last_seen_at: string | null;
    created_at: string;
  }>;
  collections: Array<{
    id: string;
    connector_id: string;
    local_id: string;
    connector_name: string;
    display_name: string;
    spec_version: string;
    enabled: boolean;
    contracts: CollectionContractDescriptor[];
    last_seen_at: string;
  }>;
  hosted_collections: HostedCollection[];
  grants: Array<{
    id: string;
    operations: string[];
    scope: { contracts: CollectionContractDescriptor[]; access: "contract" | "full_collection" };
    created_at: string;
    revoked_at: string | null;
    revocation_status: "active" | "revoking" | "revoked";
    collection_id: string;
    collection_name: string;
    collection_kind: "local" | "hosted";
    application_id: string;
    application_family_id?: string;
    application_name: string;
    distribution: "web" | "portable";
    homepage: string;
    project_url: string | null;
    application_origin: string;
    icon: string | null;
  }>;
  pending_authorizations: Array<{
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
  }>;
}

export class ManagementApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "ManagementApiError";
  }
}

export class ConnectManagementClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    const normalized = new URL(baseUrl);
    normalized.pathname = "/";
    normalized.search = "";
    normalized.hash = "";
    this.baseUrl = normalized.href;
  }

  overview(signal?: AbortSignal): Promise<ManagementOverview> {
    return this.request("/v1/me", { signal });
  }

  sessions(signal?: AbortSignal): Promise<{ sessions: AccountSession[] }> {
    return this.request("/v1/account/sessions", { signal });
  }

  createHostedCollection(displayName: string): Promise<void> {
    return this.request("/v1/hosted/collections", {
      method: "POST",
      body: JSON.stringify({ display_name: displayName, template: "mdbase" })
    });
  }

  renameHostedCollection(id: string, displayName: string): Promise<void> {
    return this.request(`/v1/hosted/collections/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ display_name: displayName })
    });
  }

  deleteHostedCollection(id: string): Promise<void> {
    return this.request(`/v1/hosted/collections/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  revokeReplica(id: string): Promise<void> {
    return this.request(`/v1/hosted/replicas/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  renameConnector(id: string, name: string): Promise<void> {
    return this.request(`/v1/connectors/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name })
    });
  }

  revokeConnector(id: string): Promise<void> {
    return this.request(`/v1/connectors/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  updateGrant(id: string, operations: string[]): Promise<void> {
    return this.request(`/v1/grants/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ operations })
    });
  }

  revokeGrant(id: string): Promise<void> {
    return this.request(`/v1/grants/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  revokeSession(id: string): Promise<void> {
    return this.request(`/v1/account/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  revokeOtherSessions(): Promise<void> {
    return this.request("/v1/account/sessions/revoke-others", { method: "POST" });
  }

  logout(): Promise<void> {
    return this.request("/v1/logout", { method: "POST" });
  }

  private async request<T = void>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      ...init,
      credentials: "include",
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers
      }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = body && typeof body === "object"
        && "error" in body
        && body.error && typeof body.error === "object"
        && "message" in body.error
        && typeof body.error.message === "string"
        ? body.error.message
        : `Request failed with HTTP ${response.status}.`;
      throw new ManagementApiError(response.status, message);
    }
    return body as T;
  }
}
