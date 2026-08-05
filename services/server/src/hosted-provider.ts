import type {
  ApplicationProvisions,
  ApplicationRequirements,
  CollectionContractDescriptor,
  CollectionTypeDescriptor,
  ContractSetupChoice,
  FileCapability,
  GrantSummary,
  TypePackProvision
} from "@mdbase-dev/connect-protocol";
import {
  CONNECT_CONTRACT_SUPPORT,
  HOSTED_PROVIDER_REQUIRED_CAPABILITIES,
  type ConnectContractSupport
} from "@mdbase-dev/connect-protocol";
import { hostedReplicaCollectionOperations } from "./hosted-replica-policy.js";
import { safeEqual } from "./security.js";

export interface HostedProviderConfig {
  url: string;
  publicUrl?: string;
  internalToken: string;
}

export interface HostedReplicaEnrollment {
  id: string;
  name: string;
  purpose?: "mirror" | "application";
  mode: "read_only" | "read_write";
  allowedTypes: string[];
  contractScope?: CollectionContractDescriptor[];
  fullCollection?: boolean;
  allowedOperations?: string[];
  fileCapability?: FileCapability;
  allowedOrigin?: string;
  proofPublicKey?: string;
  grantId?: string;
  applicationDeclarationId?: string;
  applicationDeclarationDigest?: string;
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

export interface HostedCollectionUsage {
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
}

export interface HostedAccountLimits {
  hosted_storage_bytes: number;
  retained_file_bytes: number;
  max_document_bytes: number;
  max_single_file_bytes: number;
  max_replicas_per_collection: number;
  max_hosted_collections: number;
  max_files_per_collection: number;
}

export interface HostedAccountUsage extends HostedAccountLimits {
  account_id: string;
  entitlement_revision: number;
  collection_count: number;
  live_content_bytes: number;
  live_file_bytes: number;
  retained_file_bytes: number;
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

export interface HostedContractSetupResult {
  contracts: CollectionContractDescriptor[];
  contractSetups: ContractSetupChoice[];
  setupAssessment?: unknown;
  provisionReceipt?: unknown;
}

export interface AuthorityImport {
  id: string;
  collection_id: string;
  authority_epoch: number;
  state: "receiving" | "uploaded" | "completed" | "aborted";
  manifest_digest: string | null;
  source_revision: string | null;
  source_head: number | null;
  contracts: CollectionContractDescriptor[];
  expires_at: string;
}

export class HostedProviderClient {
  readonly url: string;
  private readonly endpointUrl: string;
  private readonly internalToken: string;

  constructor(config: HostedProviderConfig) {
    this.endpointUrl = new URL(config.url).origin;
    this.url = new URL(config.publicUrl ?? config.url).origin;
    this.internalToken = config.internalToken;
  }

  async ready(): Promise<void> {
    const result = await this.request("GET", "/ready", undefined, false) as {
      status?: unknown;
      provider?: { version?: unknown; capabilities?: unknown; contract_support?: unknown };
    } | undefined;
    const capabilities = result?.provider?.capabilities;
    if (result?.status !== "ready"
        || typeof result.provider?.version !== "string"
        || !Array.isArray(capabilities)
        || !capabilities.every((capability) => typeof capability === "string")
        || !HOSTED_PROVIDER_REQUIRED_CAPABILITIES.every(
          (required) => capabilities.includes(required)
        )
        || !hostedContractSupportMatches(result.provider?.contract_support)) {
      throw new HostedProviderUnavailableError(
        new Error("Hosted provider capability report is incompatible.")
      );
    }
  }

  authorizesInternalToken(candidate: string | null): boolean {
    return candidate !== null && safeEqual(candidate, this.internalToken);
  }

  async upsertAccount(
    accountId: string,
    entitlementRevision: number,
    limits: HostedAccountLimits
  ): Promise<HostedAccountUsage> {
    const result = await this.request(
      "PUT",
      `/internal/v1/accounts/${encodeURIComponent(accountId)}`,
      { entitlement_revision: entitlementRevision, ...limits }
    ) as { account?: HostedAccountUsage } | undefined;
    if (!result?.account) {
      throw new HostedProviderResponseError(
        502,
        "invalid_provider_response",
        "Hosted account usage was missing from the provider response."
      );
    }
    return result.account;
  }

  async accountUsage(accountId: string): Promise<HostedAccountUsage> {
    const result = await this.request(
      "GET",
      `/internal/v1/accounts/${encodeURIComponent(accountId)}`
    ) as { account?: HostedAccountUsage } | undefined;
    if (!result?.account) {
      throw new HostedProviderResponseError(
        502,
        "invalid_provider_response",
        "Hosted account usage was missing from the provider response."
      );
    }
    return result.account;
  }

  async reconcileCollectionAccount(accountId: string, collectionId: string): Promise<void> {
    await this.request(
      "PUT",
      `/internal/v1/accounts/${encodeURIComponent(accountId)}/collections/${encodeURIComponent(collectionId)}`,
      {}
    );
  }

  async createCollection(
    accountId: string,
    collectionId: string,
    template: string,
    displayName: string
  ): Promise<void> {
    await this.request("POST", "/internal/v1/collections", {
      account_id: accountId,
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

  async provisionTypePacks(
    collectionId: string,
    provisions: TypePackProvision[],
    installedBy: string,
    contractSetups: ContractSetupChoice[] = []
  ): Promise<HostedContractSetupResult> {
    const setupRequest = contractSetups.length > 0;
    const result = await this.request(
      "POST",
      `/internal/v1/collections/${encodeURIComponent(collectionId)}/${setupRequest
        ? "contract-setup"
        : "type-packs/provision"}`,
      {
        type_packs: provisions,
        installed_by: installedBy,
        ...(setupRequest
          ? { contract_setups: contractSetups }
          : {})
      }
    ) as {
      contracts?: CollectionContractDescriptor[];
      contract_setups?: ContractSetupChoice[];
    } | undefined;
    return {
      contracts: result?.contracts ?? [],
      contractSetups: result?.contract_setups ?? []
    };
  }

  async provisionApplicationSetup(
    collectionId: string,
    input: {
      applicationId: string;
      declarationDigest: string;
      requirements: ApplicationRequirements;
      provisions: ApplicationProvisions;
      contractSetups?: ContractSetupChoice[];
    }
  ): Promise<HostedContractSetupResult> {
    const result = await this.request(
      "POST",
      `/internal/v1/collections/${encodeURIComponent(collectionId)}/application-setup`,
      {
        application_id: input.applicationId,
        declaration_digest: input.declarationDigest,
        requirements: input.requirements,
        provisions: input.provisions,
        contract_setups: input.contractSetups ?? []
      }
    ) as {
      contracts?: CollectionContractDescriptor[];
      contract_setups?: ContractSetupChoice[];
      setup_assessment?: unknown;
      provision_receipt?: unknown;
    } | undefined;
    return {
      contracts: result?.contracts ?? [],
      contractSetups: result?.contract_setups ?? [],
      setupAssessment: result?.setup_assessment,
      provisionReceipt: result?.provision_receipt
    };
  }

  async collectionTypeCandidates(collectionId: string): Promise<CollectionTypeDescriptor[]> {
    const result = await this.request(
      "GET",
      `/internal/v1/collections/${encodeURIComponent(collectionId)}/types`
    ) as { types?: CollectionTypeDescriptor[] } | undefined;
    return result?.types ?? [];
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
        contract_scope: replica.contractScope ?? [],
        full_collection: replica.fullCollection ?? false,
        allowed_operations: hostedReplicaCollectionOperations(
          replica.allowedOperations ?? []
        ),
        ...(replica.fileCapability ? { file_capability: replica.fileCapability } : {}),
        ...(replica.allowedOrigin ? { allowed_origin: replica.allowedOrigin } : {}),
        ...(replica.proofPublicKey ? { proof_public_key: replica.proofPublicKey } : {}),
        ...(replica.grantId ? { grant_id: replica.grantId } : {}),
        ...(replica.applicationDeclarationId
          ? { application_declaration_id: replica.applicationDeclarationId }
          : {}),
        ...(replica.applicationDeclarationDigest
          ? { application_declaration_digest: replica.applicationDeclarationDigest }
          : {}),
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

  async collectionUsage(collectionId: string): Promise<HostedCollectionUsage> {
    const result = await this.request(
      "GET",
      `/internal/v1/collections/${encodeURIComponent(collectionId)}/usage`
    ) as { usage?: HostedCollectionUsage } | undefined;
    if (!result?.usage) {
      throw new HostedProviderResponseError(
        502,
        "invalid_provider_response",
        "Hosted storage usage was missing from the provider response."
      );
    }
    return result.usage;
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
      contractScope: CollectionContractDescriptor[];
      fullCollection: boolean;
      allowedOperations: string[];
      fileCapability?: FileCapability;
      allowedOrigin: string | undefined;
      proofPublicKey: string;
      applicationDeclarationId: string;
      applicationDeclarationDigest: string;
    }
  ): Promise<void> {
    await this.request(
      "PATCH",
      `/internal/v1/replicas/${encodeURIComponent(replicaId)}/policy`,
      {
        grant_id: policy.grantId,
        mode: policy.mode,
        allowed_types: policy.allowedTypes,
        contract_scope: policy.contractScope,
        full_collection: policy.fullCollection,
        allowed_operations: hostedReplicaCollectionOperations(
          policy.allowedOperations
        ),
        ...(policy.fileCapability ? { file_capability: policy.fileCapability } : {}),
        allowed_origin: policy.allowedOrigin,
        proof_public_key: policy.proofPublicKey,
        application_declaration_id: policy.applicationDeclarationId,
        application_declaration_digest: policy.applicationDeclarationDigest
      }
    );
  }

  async revokeReplica(replicaId: string): Promise<void> {
    await this.request("DELETE", `/internal/v1/replicas/${encodeURIComponent(replicaId)}`);
  }

  async upsertNotificationGrant(collectionId: string, grant: GrantSummary): Promise<void> {
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

  async prepareAuthorityImport(input: {
    transferId: string;
    accountId: string;
    collectionId: string;
    displayName: string;
    token: string;
    authorityEpoch: number;
    ttlSeconds: number;
  }): Promise<AuthorityImport> {
    return await this.request("POST", "/internal/v1/authority-imports", {
      transfer_id: input.transferId,
      account_id: input.accountId,
      collection_id: input.collectionId,
      display_name: input.displayName,
      token: input.token,
      authority_epoch: input.authorityEpoch,
      ttl_seconds: input.ttlSeconds
    }) as AuthorityImport;
  }

  async completeAuthorityImport(
    transferId: string,
    manifestDigest: string,
    sourceRevision: string
  ): Promise<AuthorityImport> {
    return await this.request(
      "POST",
      `/internal/v1/authority-imports/${encodeURIComponent(transferId)}`,
      { manifest_digest: manifestDigest, source_revision: sourceRevision }
    ) as AuthorityImport;
  }

  async abortAuthorityImport(transferId: string): Promise<AuthorityImport> {
    return await this.request(
      "DELETE",
      `/internal/v1/authority-imports/${encodeURIComponent(transferId)}`
    ) as AuthorityImport;
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
        response = await fetch(`${this.endpointUrl}${path}`, {
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

function hostedContractSupportMatches(value: unknown): value is ConnectContractSupport {
  if (!value || typeof value !== "object") return false;
  const support = value as Record<string, unknown>;
  const includes = (axis: keyof ConnectContractSupport, required: readonly number[]) =>
    Array.isArray(support[axis])
    && required.every((version) => (support[axis] as unknown[]).includes(version));
  return includes("operation_transport", CONNECT_CONTRACT_SUPPORT.operation_transport)
    && includes("authorization_binding", CONNECT_CONTRACT_SUPPORT.authorization_binding)
    && includes("semantic_capabilities", CONNECT_CONTRACT_SUPPORT.semantic_capabilities)
    && includes("durable_mutation", CONNECT_CONTRACT_SUPPORT.durable_mutation);
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
