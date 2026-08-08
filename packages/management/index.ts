export interface AccountSession {
  id: string;
  provider: "google" | "github" | "password" | "session";
  client_name: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  current: boolean;
}

export interface AccountData {
  user: { id: string; name: string; email: string | null; login: string | null };
  authentication: {
    managed: boolean;
    current_provider: "google" | "github" | "password" | "tailscale" | "session";
    available_providers: {
      github: boolean;
      google: boolean;
      password: boolean;
    };
    identities: Array<{
      provider: "github" | "google";
      subject: string;
      login: string | null;
      email: string | null;
      email_verified: boolean;
      linked_at: string;
      current: boolean;
      removable: boolean;
    }>;
    password: {
      configured: boolean;
      email: string | null;
      current: boolean;
      change_available: boolean;
    };
  };
  storage: {
    status: "available" | "partial" | "unavailable";
    total_content_bytes: number | null;
    total_file_bytes: number | null;
    total_storage_bytes: number | null;
    total_stored_file_bytes: number | null;
    total_records: number | null;
    collections: Array<{
      id: string;
      display_name: string;
      usage: null | {
        collection_id: string;
        record_count: number;
        content_bytes: number;
        max_records: number;
        max_content_bytes: number;
        max_document_bytes: number;
        file_count: number;
        file_bytes: number;
        stored_file_bytes: number;
        max_files: number;
        max_file_bytes: number;
        max_stored_file_bytes: number;
        max_single_file_bytes: number;
      };
    }>;
  };
  deletion: {
    available: boolean;
    hosted_collections: number;
    local_collections: number;
    computers: number;
    development_confirmation: boolean;
  };
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
  subscription: null | {
    kind: "beta" | "entitled";
    profiles: string[];
    permanent: boolean;
    limits: {
      hosted_storage_bytes: number;
      retained_file_bytes: number;
      max_document_bytes: number;
      max_single_file_bytes: number;
      max_mirror_replicas_per_collection: number;
      max_application_replicas_per_collection: number;
      max_hosted_collections: number;
      max_files_per_collection: number;
    };
    usage: null | {
      hosted_collections: number;
      live_content_bytes: number;
      live_file_bytes: number;
      live_storage_bytes: number;
      retained_file_bytes: number;
    };
    reconciliation: null | {
      entitlement_revision: number;
      provider_revision: number;
    };
  };
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
    connector_version?: string | null;
    compatibility?: "compatible" | "unknown" | "upgrade_required";
    last_incompatible_at?: string | null;
    minimum_connector_version?: string | null;
    update_url?: string | null;
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
  constructor(
    public readonly status: number,
    public readonly code: "cancelled" | "http_error" | "invalid_response" | "outcome_unknown" | "partial_failure" | "timeout",
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "ManagementApiError";
  }
}

export interface ManagementRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number | null;
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

  overview(options?: ManagementRequestOptions): Promise<ManagementOverview> {
    return this.request("/v1/me", {}, options);
  }

  sessions(options?: ManagementRequestOptions): Promise<{ sessions: AccountSession[] }> {
    return this.request("/v1/account/sessions", {}, options);
  }

  account(options?: ManagementRequestOptions): Promise<AccountData> {
    return this.request("/v1/account", {}, options);
  }

  githubAccountFlowUrl(purpose: "link" | "reauth_delete"): string {
    const path = purpose === "link"
      ? "/v1/account/identities/github/link"
      : "/v1/account/reauth/github";
    const url = new URL(path, this.baseUrl);
    url.searchParams.set("return_to", "/account");
    return url.href;
  }

  startGoogleAccountFlow(purpose: "link" | "reauth_delete", options?: ManagementRequestOptions): Promise<{
    client_id: string;
    nonce: string;
  }> {
    const path = purpose === "link"
      ? "/v1/account/identities/google/link"
      : "/v1/account/reauth/google";
    return this.request(`${path}?return_to=${encodeURIComponent("/account")}`, {}, options);
  }

  completeGoogleAccountFlow(credential: string, options?: ManagementRequestOptions): Promise<{ redirect_to: string }> {
    return this.request("/auth/google/callback", {
      method: "POST",
      headers: { "x-mdbase-auth": "google" },
      body: JSON.stringify({ credential })
    }, options);
  }

  disconnectIdentity(provider: "github" | "google", options?: ManagementRequestOptions): Promise<void> {
    return this.request(`/v1/account/identities/${provider}`, { method: "DELETE" }, options);
  }

  changePassword(currentPassword: string, newPassword: string, options?: ManagementRequestOptions): Promise<void> {
    return this.request("/v1/account/password", {
      method: "PATCH",
      body: JSON.stringify({
        current_password: currentPassword,
        new_password: newPassword
      })
    }, options);
  }

  deleteAccount(input: {
    confirmation: string;
    currentPassword?: string;
    reauthenticationToken?: string;
  }, options?: ManagementRequestOptions): Promise<void> {
    return this.request("/v1/account", {
      method: "DELETE",
      body: JSON.stringify({
        confirmation: input.confirmation,
        ...(input.currentPassword ? { current_password: input.currentPassword } : {}),
        ...(input.reauthenticationToken ? { reauth_token: input.reauthenticationToken } : {})
      })
    }, options);
  }

  createHostedCollection(
    input: { displayName: string; timezone: string },
    options?: ManagementRequestOptions
  ): Promise<void> {
    return this.request("/v1/hosted/collections", {
      method: "POST",
      body: JSON.stringify({
        display_name: input.displayName,
        template: "mdbase",
        timezone: input.timezone
      })
    }, options);
  }

  renameHostedCollection(id: string, displayName: string, options?: ManagementRequestOptions): Promise<void> {
    return this.request(`/v1/hosted/collections/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ display_name: displayName })
    }, options);
  }

  deleteHostedCollection(id: string, options?: ManagementRequestOptions): Promise<void> {
    return this.request(`/v1/hosted/collections/${encodeURIComponent(id)}`, { method: "DELETE" }, options);
  }

  revokeReplica(id: string, options?: ManagementRequestOptions): Promise<void> {
    return this.request(`/v1/hosted/replicas/${encodeURIComponent(id)}`, { method: "DELETE" }, options);
  }

  renameConnector(id: string, name: string, options?: ManagementRequestOptions): Promise<void> {
    return this.request(`/v1/connectors/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name })
    }, options);
  }

  revokeConnector(id: string, options?: ManagementRequestOptions): Promise<void> {
    return this.request(`/v1/connectors/${encodeURIComponent(id)}`, { method: "DELETE" }, options);
  }

  updateGrant(id: string, operations: string[], options?: ManagementRequestOptions): Promise<void> {
    return this.request(`/v1/grants/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ operations })
    }, options);
  }

  revokeGrant(id: string, options?: ManagementRequestOptions): Promise<void> {
    return this.request(`/v1/grants/${encodeURIComponent(id)}`, { method: "DELETE" }, options);
  }

  async revokeApplication(
    grantIds: string[],
    options?: ManagementRequestOptions
  ): Promise<{ results: Array<{ grant_id: string; status: "revoked" | "revoking" | "conflict" }> }> {
    const result = await this.request<{
      ok: boolean;
      results: Array<{ grant_id: string; status: "revoked" | "revoking" | "conflict" }>;
    }>("/v1/grants/revoke-batch", {
      method: "POST",
      body: JSON.stringify({ grant_ids: [...new Set(grantIds)] })
    }, options);
    const failed = result.results.filter(({ status }) => status === "conflict");
    if (failed.length > 0) {
      throw new ManagementApiError(
        200,
        "partial_failure",
        `${result.results.length - failed.length} grants were revoked; ${failed.length} changed concurrently. The current state has been refreshed.`,
        { results: result.results }
      );
    }
    return result;
  }

  revokeSession(id: string, options?: ManagementRequestOptions): Promise<void> {
    return this.request(`/v1/account/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }, options);
  }

  revokeOtherSessions(options?: ManagementRequestOptions): Promise<void> {
    return this.request("/v1/account/sessions/revoke-others", { method: "POST" }, options);
  }

  logout(options?: ManagementRequestOptions): Promise<void> {
    return this.request("/v1/logout", { method: "POST" }, options);
  }

  private async request<T = void>(
    path: string,
    init: RequestInit = {},
    options: ManagementRequestOptions = {}
  ): Promise<T> {
    const deadline = managementDeadline(options);
    const method = (init.method ?? "GET").toUpperCase();
    const mutation = !["GET", "HEAD", "OPTIONS"].includes(method);
    let dispatched = false;
    try {
      if (deadline.signal.aborted) throw deadline.signal.reason;
      const request = fetch(new URL(path, this.baseUrl), {
        ...init,
        signal: deadline.signal,
        credentials: "include",
        headers: {
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers
        }
      });
      dispatched = true;
      const response = await deadline.wait(request);
      const text = await deadline.wait(response.text());
      let body: unknown = {};
      if (text.trim() !== "") {
        try {
          body = JSON.parse(text);
        } catch {
          throw new ManagementApiError(
            response.status,
            "invalid_response",
            `The management service returned invalid JSON (HTTP ${response.status}).`
          );
        }
      } else if (response.ok && response.status !== 204) {
        throw new ManagementApiError(
          response.status,
          "invalid_response",
          `The management service returned an empty response (HTTP ${response.status}).`
        );
      }
      if (!response.ok) {
        const message = body && typeof body === "object"
          && "error" in body
          && body.error && typeof body.error === "object"
          && "message" in body.error
          && typeof body.error.message === "string"
          ? body.error.message
          : `Request failed with HTTP ${response.status}.`;
        throw new ManagementApiError(response.status, "http_error", message);
      }
      return body as T;
    } catch (cause) {
      if (cause instanceof ManagementApiError) throw cause;
      if (deadline.signal.aborted) {
        if (mutation && dispatched) {
          throw new ManagementApiError(
            0,
            "outcome_unknown",
            deadline.timedOut()
              ? "The request timed out after it may have reached the service. Refresh to confirm the current state before trying again."
              : "The request was cancelled after it may have reached the service. Refresh to confirm the current state before trying again.",
            { operation_outcome: "unknown" }
          );
        }
        if (mutation) {
          throw new ManagementApiError(
            0,
            deadline.timedOut() ? "timeout" : "cancelled",
            deadline.timedOut()
              ? "The management request timed out before it changed server state."
              : "The management request was cancelled before dispatch.",
            { operation_outcome: "not_sent" }
          );
        }
        throw new ManagementApiError(
          0,
          deadline.timedOut() ? "timeout" : "cancelled",
          deadline.timedOut() ? "The management request timed out." : "The management request was cancelled."
        );
      }
      throw cause;
    } finally {
      deadline.dispose();
    }
  }
}

function managementDeadline(options: ManagementRequestOptions): {
  signal: AbortSignal;
  timedOut(): boolean;
  wait<T>(promise: Promise<T>): Promise<T>;
  dispose(): void;
} {
  const controller = new AbortController();
  let timeout = false;
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const timeoutMs = options.timeoutMs === null ? null : options.timeoutMs ?? 30_000;
  if (timeoutMs !== null && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
    throw new TypeError("timeoutMs must be a positive safe integer or null.");
  }
  const timer = timeoutMs === null ? undefined : setTimeout(() => {
    timeout = true;
    controller.abort();
  }, timeoutMs);
  const wait = <T>(promise: Promise<T>): Promise<T> => {
    if (controller.signal.aborted) return Promise.reject(controller.signal.reason);
    return new Promise<T>((resolve, reject) => {
      const aborted = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", aborted, { once: true });
      promise.then(resolve, reject).finally(() => {
        controller.signal.removeEventListener("abort", aborted);
      });
    });
  };
  return {
    signal: controller.signal,
    timedOut: () => timeout,
    wait,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  };
}
