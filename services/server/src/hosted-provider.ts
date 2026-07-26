import type {
  CollectionContractDescriptor,
  GrantPolicy,
  TypeProvision
} from "@mdbase/connect-protocol";
import { safeEqual } from "./security.js";

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
  proofPublicKey?: string;
  grantId?: string;
  token: string;
  tokenTtlSeconds?: number;
}

export interface HostedReplicaStatus {
  id: string;
  head: number;
  acknowledged_sequence: number;
  last_seen_at: string | null;
  token_expires_at: string;
}

export interface HostedAuthorityTransfer {
  id: string;
  collection_id: string;
  replica_id: string;
  final_head: number;
  authority_epoch: number;
  manifest_digest: string;
  state: "prepared" | "completed" | "aborted";
  expires_at: string;
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

  authorizesInternalToken(candidate: string | null): boolean {
    return candidate !== null && safeEqual(candidate, this.internalToken);
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
        ...(replica.proofPublicKey ? { proof_public_key: replica.proofPublicKey } : {}),
        ...(replica.grantId ? { grant_id: replica.grantId } : {}),
        token: replica.token,
        ...(replica.tokenTtlSeconds ? { token_ttl_seconds: replica.tokenTtlSeconds } : {})
      }
    );
  }

  async replicaStatuses(collectionId: string): Promise<HostedReplicaStatus[]> {
    const result = await this.request(
      "GET",
      `/internal/v1/collections/${encodeURIComponent(collectionId)}/replicas`
    ) as { replicas?: HostedReplicaStatus[] } | undefined;
    return result?.replicas ?? [];
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
      grantId: string;
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
        grant_id: policy.grantId,
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

  async upsertNotificationGrant(collectionId: string, grant: GrantPolicy): Promise<void> {
    await this.request(
      "PUT",
      `/internal/v1/collections/${encodeURIComponent(collectionId)}/notification-grants/${encodeURIComponent(grant.id)}`,
      grant
    );
  }

  async revokeNotificationGrant(collectionId: string, grantId: string): Promise<void> {
    await this.request(
      "DELETE",
      `/internal/v1/collections/${encodeURIComponent(collectionId)}/notification-grants/${encodeURIComponent(grantId)}`
    );
  }

  async compactThrough(collectionId: string, through: number): Promise<void> {
    await this.request(
      "POST",
      `/internal/v1/collections/${encodeURIComponent(collectionId)}/compact`,
      { through }
    );
  }

  async prepareAuthorityTransfer(
    collectionId: string,
    input: { transferId: string; replicaId: string; ttlSeconds: number }
  ): Promise<HostedAuthorityTransfer> {
    return await this.request(
      "POST",
      `/internal/v1/collections/${encodeURIComponent(collectionId)}/authority-transfers`,
      {
        transfer_id: input.transferId,
        replica_id: input.replicaId,
        ttl_seconds: input.ttlSeconds
      }
    ) as HostedAuthorityTransfer;
  }

  async completeAuthorityTransfer(
    transferId: string,
    manifestDigest: string
  ): Promise<HostedAuthorityTransfer> {
    return await this.request(
      "POST",
      `/internal/v1/authority-transfers/${encodeURIComponent(transferId)}`,
      { manifest_digest: manifestDigest }
    ) as HostedAuthorityTransfer;
  }

  async abortAuthorityTransfer(transferId: string): Promise<HostedAuthorityTransfer> {
    return await this.request(
      "DELETE",
      `/internal/v1/authority-transfers/${encodeURIComponent(transferId)}`
    ) as HostedAuthorityTransfer;
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
