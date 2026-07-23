import type { CollectionContractDescriptor, TypeProvision } from "@mdbase/connect-protocol";

export interface HostedProviderConfig {
  url: string;
  internalToken: string;
}

export interface HostedReplicaEnrollment {
  id: string;
  name: string;
  purpose?: "mirror" | "application";
  mode: "read_only" | "read_write";
  allowedTypes: string[];
  fullCollection?: boolean;
  allowedOperations?: string[];
  allowedOrigin?: string;
  token: string;
  tokenTtlSeconds?: number;
}

export class HostedProviderClient {
  readonly url: string;
  private readonly internalToken: string;

  constructor(config: HostedProviderConfig) {
    this.url = new URL(config.url).origin;
    this.internalToken = config.internalToken;
  }

  async ready(): Promise<void> {
    await this.request("GET", "/ready", undefined, false);
  }

  async createCollection(collectionId: string, template: string, displayName: string): Promise<void> {
    await this.request("POST", "/internal/v1/collections", {
      collection_id: collectionId,
      template,
      display_name: displayName
    });
  }

  async renameCollection(collectionId: string, displayName: string): Promise<void> {
    await this.request(
      "PATCH",
      `/internal/v1/collections/${encodeURIComponent(collectionId)}`,
      { display_name: displayName }
    );
  }

  async deleteCollection(collectionId: string): Promise<void> {
    await this.request("DELETE", `/internal/v1/collections/${encodeURIComponent(collectionId)}`);
  }

  async provisionTypes(
    collectionId: string,
    provisions: TypeProvision[]
  ): Promise<CollectionContractDescriptor[]> {
    const result = await this.request(
      "POST",
      `/internal/v1/collections/${encodeURIComponent(collectionId)}/types/provision`,
      { types: provisions }
    ) as { contracts?: CollectionContractDescriptor[] } | undefined;
    return result?.contracts ?? [];
  }

  async registerReplica(collectionId: string, replica: HostedReplicaEnrollment): Promise<void> {
    await this.request(
      "POST",
      `/internal/v1/collections/${encodeURIComponent(collectionId)}/replicas`,
      {
        replica_id: replica.id,
        name: replica.name,
        purpose: replica.purpose ?? "mirror",
        mode: replica.mode,
        allowed_types: replica.allowedTypes,
        full_collection: replica.fullCollection ?? false,
        allowed_operations: replica.allowedOperations ?? [],
        ...(replica.allowedOrigin ? { allowed_origin: replica.allowedOrigin } : {}),
        token: replica.token,
        ...(replica.tokenTtlSeconds ? { token_ttl_seconds: replica.tokenTtlSeconds } : {})
      }
    );
  }

  async rotateReplicaToken(replicaId: string, token: string, tokenTtlSeconds?: number): Promise<void> {
    await this.request(
      "POST",
      `/internal/v1/replicas/${encodeURIComponent(replicaId)}/token`,
      { token, ...(tokenTtlSeconds ? { token_ttl_seconds: tokenTtlSeconds } : {}) }
    );
  }

  async updateApplicationReplica(
    replicaId: string,
    policy: {
      mode: "read_only" | "read_write";
      allowedTypes: string[];
      fullCollection: boolean;
      allowedOperations: string[];
    }
  ): Promise<void> {
    await this.request(
      "PATCH",
      `/internal/v1/replicas/${encodeURIComponent(replicaId)}/policy`,
      {
        mode: policy.mode,
        allowed_types: policy.allowedTypes,
        full_collection: policy.fullCollection,
        allowed_operations: policy.allowedOperations
      }
    );
  }

  async revokeReplica(replicaId: string): Promise<void> {
    await this.request("DELETE", `/internal/v1/replicas/${encodeURIComponent(replicaId)}`);
  }

  async compactThrough(collectionId: string, through: number): Promise<void> {
    await this.request(
      "POST",
      `/internal/v1/collections/${encodeURIComponent(collectionId)}/compact`,
      { through }
    );
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    authenticated = true
  ): Promise<unknown> {
    let unavailable: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(`${this.url}${path}`, {
          method,
          headers: {
            ...(authenticated ? { authorization: `Bearer ${this.internalToken}` } : {}),
            ...(body === undefined ? {} : { "content-type": "application/json" })
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(15_000)
        });
      } catch (error) {
        unavailable = error;
        if (attempt < 2) {
          await delay(100 * 2 ** attempt);
          continue;
        }
        break;
      }
      if (response.ok) return readResponse(response);
      const value = await readResponse(response);
      if ([429, 502, 503, 504].includes(response.status) && attempt < 2) {
        await delay(100 * 2 ** attempt);
        continue;
      }
      const providerError = asProviderError(value);
      throw new HostedProviderResponseError(
        response.status,
        providerError.code,
        providerError.message
      );
    }
    throw new HostedProviderUnavailableError(unavailable);
  }
}

export class HostedProviderResponseError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export class HostedProviderUnavailableError extends Error {
  constructor(public readonly cause: unknown) {
    super("The hosted storage provider is temporarily unavailable.");
  }
}

async function readResponse(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asProviderError(value: unknown): { code: string; message: string } {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const error = body.error && typeof body.error === "object"
    ? body.error as Record<string, unknown>
    : {};
  return {
    code: typeof error.code === "string" ? error.code : "hosted_provider_error",
    message: typeof error.message === "string"
      ? error.message
      : "The hosted storage provider rejected the request."
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
