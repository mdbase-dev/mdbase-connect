import type { ApplicationRequirements } from "./application-requirements.js";
import type {
  ApplicationAuthorizationProof,
  ApplicationProvisions,
  CollectionContractDescriptor,
  CollectionTypeDescriptor,
  ContractSetupChoice,
  FileCapability,
  GrantSummary,
  TypePackProvision
} from "@mdbase-dev/connect-protocol";
import {
  CONNECT_CONTRACT_SUPPORT,
  HOSTED_CANDIDATE_B_ACTIVATION_CAPABILITY,
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

export interface HostedProviderOperationOptions {
  /** Absolute Unix epoch deadline in milliseconds. */
  deadline?: number;
  signal?: AbortSignal;
}

interface RequiredOperationOptions {
  deadline: number;
  signal?: AbortSignal;
}

const PROVIDER_OPERATION_TIMEOUT_MS = 14_000;
const PROVIDER_REQUEST_TIMEOUT_MS = 15_000;

export interface HostedProjectionGenerationStatus {
  collection_id: string;
  generation_id: string;
  source_head: number;
  phase: "projection" | "resolution";
  status: "building";
}

export interface HostedProjectionStatus {
  collection_id: string;
  ready: boolean;
  head: number;
  resource_revision: string;
  active_generation_id: string | null;
  building_generation: HostedProjectionGenerationStatus | null;
  latest_terminal_generation_id?: string | null;
  latest_terminal_error_code?: string | null;
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
  operationTransportProtocol?: number;
  operationTransportRecoveryProtocols?: number[];
  fileCapability?: FileCapability;
  allowedOrigin?: string;
  proofPublicKey?: string;
  grantId?: string;
  applicationDeclarationId?: string;
  applicationDeclarationDigest?: string;
  applicationDeclaration?: unknown;
  applicationAuthorization?: ApplicationAuthorizationProof;
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
  max_mirror_replicas_per_collection: number;
  max_application_replicas_per_collection: number;
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

export interface HostedProtocolUsageEntry {
  account_id: string;
  protocol_version: number;
  sample_count: number;
  first_seen_at: string;
  last_seen_at: string;
}

export interface HostedProtocolUsageReport {
  entries: HostedProtocolUsageEntry[];
  unbound_application_replicas: number;
  v2_recovery_application_replicas: number;
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
  state: "receiving" | "uploaded" | "indexing" | "completed" | "aborted";
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
        || !capabilities.includes(HOSTED_CANDIDATE_B_ACTIVATION_CAPABILITY)
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

  async protocolUsage(): Promise<HostedProtocolUsageReport> {
    const result = await this.request(
      "GET",
      "/internal/v1/protocol-usage"
    ) as { protocol_usage?: HostedProtocolUsageReport } | undefined;
    if (!result?.protocol_usage) {
      throw new HostedProviderResponseError(
        502,
        "invalid_provider_response",
        "Hosted protocol usage was missing from the provider response."
      );
    }
    return result.protocol_usage;
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
    displayName: string,
    timezone: string
  ): Promise<void> {
    await this.request("POST", "/internal/v1/collections", {
      account_id: accountId,
      collection_id: collectionId,
      template,
      display_name: displayName,
      timezone
    });
    const projection = await this.projectionStatus(collectionId);
    if (!projection.ready || !projection.active_generation_id) {
      throw new HostedProviderResponseError(
        503,
        "projection_activation_stalled",
        "The provider returned a new collection without a current projection."
      );
    }
  }

  async projectionStatus(
    collectionId: string,
    options?: HostedProviderOperationOptions
  ): Promise<HostedProjectionStatus> {
    const operation = requiredOperation(options);
    const result = await this.request(
      "GET",
      `/internal/v1/collections/${encodeURIComponent(collectionId)}/projection`,
      undefined,
      true,
      operation
    ) as { projection?: HostedProjectionStatus } | undefined;
    return requiredProjectionStatus(result?.projection, collectionId);
  }

  async advanceProjection(
    collectionId: string,
    generationId: string,
    options?: HostedProviderOperationOptions
  ): Promise<HostedProjectionStatus> {
    const operation = requiredOperation(options);
    let retryDelay = 25;
    for (;;) {
      try {
        const result = await this.request(
          "POST",
          `/internal/v1/collections/${encodeURIComponent(collectionId)}/projection/advance`,
          { generation_id: generationId },
          true,
          operation
        ) as { projection?: HostedProjectionStatus } | undefined;
        return exactProjectionHandoff(
          requiredProjectionStatus(result?.projection, collectionId),
          generationId
        );
      } catch (error) {
        // A bounded batch may commit while its HTTP response is lost. Reconcile
        // only the requested generation in the requested collection. An old
        // active A alongside requested building B is a valid Candidate B
        // handoff, but A is never accepted as completion of B.
        if (
          error instanceof HostedProviderResponseError
          && matchesProjectionHandoff(error.code)
        ) {
          const status = await this.projectionStatus(collectionId, operation);
          if (
            status.ready
            && status.active_generation_id === generationId
          ) return status;
          if (status.latest_terminal_generation_id === generationId) {
            throw new HostedProviderResponseError(
              409,
              status.latest_terminal_error_code ?? "projection_generation_not_building",
              "The requested projection generation terminated before activation."
            );
          }
          if (
            error.code === "projection_lease_unavailable"
            && status.building_generation?.generation_id === generationId
          ) {
            if (remainingMilliseconds(operation) <= 0) {
              throw projectionActivationPending();
            }
            try {
              await boundedDelay(retryDelay, operation);
            } catch (delayError) {
              if (operation.signal?.aborted) throw delayError;
              if (remainingMilliseconds(operation) <= 0) {
                throw projectionActivationPending();
              }
              throw delayError;
            }
            retryDelay = Math.min(retryDelay * 2, 200);
            continue;
          }
        }
        throw error;
      }
    }
  }

  private async completeProjection(
    collectionId: string,
    operation: RequiredOperationOptions
  ): Promise<void> {
    let status = await this.projectionStatus(collectionId, operation);
    // All sixteen bounded batches share the authority operation's one absolute
    // deadline and cancellation signal. Large imports resume only the exact
    // fenced generation through the typed pending response.
    for (let batch = 0; batch < 16; batch += 1) {
      if (
        status.ready
        && status.active_generation_id
        && status.building_generation === null
      ) return;
      const generationId = status.building_generation?.generation_id;
      if (!generationId) {
        throw new HostedProviderResponseError(
          503,
          "projection_activation_stalled",
          "Candidate B activation has no building projection generation."
        );
      }
      status = await this.advanceProjection(collectionId, generationId, operation);
    }
    throw projectionActivationPending();
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
    const evidence = await this.setupEvidence(replica);
    await this.request(
      "POST",
      `/internal/${evidence.application_setup_evidence ? "v2" : "v1"}/collections/${encodeURIComponent(collectionId)}/replicas`,
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
        ...(replica.operationTransportProtocol !== undefined
          ? { operation_transport_protocol: replica.operationTransportProtocol }
          : {}),
        ...(replica.operationTransportProtocol !== undefined
          || replica.operationTransportRecoveryProtocols !== undefined
          ? {
              operation_transport_recovery_protocols:
                replica.operationTransportRecoveryProtocols ?? []
            }
          : {}),
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
        ...evidence,
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
      operationTransportProtocol: number;
      operationTransportRecoveryProtocols: number[];
      fileCapability?: FileCapability;
      allowedOrigin: string | undefined;
      proofPublicKey: string;
      applicationDeclarationId: string;
      applicationDeclarationDigest: string;
      applicationDeclaration?: unknown;
      applicationAuthorization?: ApplicationAuthorizationProof;
    }
  ): Promise<void> {
    const evidence = await this.setupEvidence(policy);
    await this.request(
      "PATCH",
      `/internal/${evidence.application_setup_evidence ? "v2" : "v1"}/replicas/${encodeURIComponent(replicaId)}/policy`,
      {
        grant_id: policy.grantId,
        mode: policy.mode,
        allowed_types: policy.allowedTypes,
        contract_scope: policy.contractScope,
        full_collection: policy.fullCollection,
        allowed_operations: hostedReplicaCollectionOperations(
          policy.allowedOperations
        ),
        operation_transport_protocol: policy.operationTransportProtocol,
        operation_transport_recovery_protocols:
          policy.operationTransportRecoveryProtocols,
        ...(policy.fileCapability ? { file_capability: policy.fileCapability } : {}),
        allowed_origin: policy.allowedOrigin,
        proof_public_key: policy.proofPublicKey,
        application_declaration_id: policy.applicationDeclarationId,
        application_declaration_digest: policy.applicationDeclarationDigest,
        ...evidence
      }
    );
  }

  private async setupEvidence(policy: {
    applicationDeclaration?: unknown;
    applicationAuthorization?: ApplicationAuthorizationProof;
  }): Promise<Record<string, unknown>> {
    const declaredVersion = (policy.applicationDeclaration as {
      requirements?: { capabilities?: { contract_version?: number } };
    } | undefined)?.requirements?.capabilities?.contract_version;
    const signedVersion = policy.applicationAuthorization?.binding.contracts.semantic_capabilities;
    if (signedVersion !== 2 && declaredVersion !== 2) return {};
    if (signedVersion !== 2 || !policy.applicationDeclaration) {
      throw new HostedProviderUnavailableError(new Error("Missing v2 application declaration evidence."));
    }
    // Do not infer support from an older receiver ignoring optional JSON fields.
    const ready = await this.request("GET", "/ready", undefined, false) as {
      status?: string; provider?: { capabilities?: string[] };
    } | undefined;
    if (ready?.status !== "ready"
        || !ready.provider?.capabilities?.includes("application-setup-evidence-v2")) {
      throw new HostedProviderUnavailableError(new Error("Hosted provider does not enforce v2 setup evidence."));
    }
    return { application_setup_evidence: {
      application_declaration: policy.applicationDeclaration,
      application_authorization: policy.applicationAuthorization
    } };
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
    sourceRevision: string,
    options?: HostedProviderOperationOptions
  ): Promise<AuthorityImport> {
    const operation = requiredOperation(options);
    const complete = () => this.request(
      "POST",
      `/internal/v1/authority-imports/${encodeURIComponent(transferId)}`,
      { manifest_digest: manifestDigest, source_revision: sourceRevision },
      true,
      operation
    ) as Promise<AuthorityImport>;
    let completed = await complete();
    if (completed.state === "completed") return completed;
    await this.completeProjection(completed.collection_id, operation);
    // Reconcile the same import row inside the original operation budget.
    completed = await complete();
    return completed;
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
    authenticated = true,
    options?: HostedProviderOperationOptions
  ): Promise<unknown> {
    const operation = requiredOperation(options);
    let unavailable: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      throwIfCancelled(operation);
      const requestController = new AbortController();
      const requestTimeout = setTimeout(
        () => requestController.abort(new DOMException("Provider request deadline exceeded.", "TimeoutError")),
        Math.min(PROVIDER_REQUEST_TIMEOUT_MS, remainingMilliseconds(operation))
      );
      const signal = operation.signal
        ? AbortSignal.any([operation.signal, requestController.signal])
        : requestController.signal;
      let retryable = false;
      try {
        const response = await fetch(`${this.endpointUrl}${path}`, {
          method,
          headers: {
            ...(authenticated ? { authorization: `Bearer ${this.internalToken}` } : {}),
            ...(body === undefined ? {} : { "content-type": "application/json" })
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal
        });
        const value = await readResponse(response);
        if (response.ok) return value;
        if ([429, 502, 503, 504].includes(response.status) && attempt < 2) {
          retryable = true;
        } else {
          const providerError = asProviderError(value);
          throw new HostedProviderResponseError(
            response.status,
            providerError.code,
            providerError.message
          );
        }
      } catch (error) {
        if (error instanceof HostedProviderResponseError) throw error;
        unavailable = error;
        if (operation.signal?.aborted) throw operation.signal.reason;
        retryable = attempt < 2;
      } finally {
        clearTimeout(requestTimeout);
      }
      if (!retryable || remainingMilliseconds(operation) <= 0) break;
      await boundedDelay(100 * 2 ** attempt, operation);
    }
    throwIfCancelled(operation);
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

function projectionActivationPending(): HostedProviderResponseError {
  return new HostedProviderResponseError(
    409,
    "projection_activation_pending",
    "Candidate B activation is still building; resume the same fenced authority import."
  );
}

function matchesProjectionHandoff(code: string): boolean {
  return code === "projection_generation_not_building"
    || code === "projection_lease_unavailable";
}

function exactProjectionHandoff(
  status: HostedProjectionStatus,
  generationId: string
): HostedProjectionStatus {
  if (status.ready && status.active_generation_id === generationId) return status;
  if (status.latest_terminal_generation_id === generationId) {
    throw new HostedProviderResponseError(
      409,
      status.latest_terminal_error_code ?? "projection_generation_not_building",
      "The requested projection generation terminated before activation."
    );
  }
  if (status.building_generation?.generation_id === generationId) return status;
  throw new HostedProviderResponseError(
    409,
    "projection_generation_not_building",
    "The requested projection generation is no longer building."
  );
}

function requiredProjectionStatus(
  value: unknown,
  expectedCollectionId?: string
): HostedProjectionStatus {
  if (!value || typeof value !== "object") {
    throw new HostedProviderResponseError(
      502,
      "invalid_provider_response",
      "Hosted projection status was missing from the provider response."
    );
  }
  const status = value as Record<string, unknown>;
  const building = status.building_generation;
  if (
    typeof status.collection_id !== "string"
    || (expectedCollectionId !== undefined && status.collection_id !== expectedCollectionId)
    || typeof status.ready !== "boolean"
    || !Number.isSafeInteger(status.head)
    || typeof status.resource_revision !== "string"
    || !(status.active_generation_id === null
      || typeof status.active_generation_id === "string")
    || !(status.latest_terminal_generation_id === undefined
      || status.latest_terminal_generation_id === null
      || typeof status.latest_terminal_generation_id === "string")
    || !(status.latest_terminal_error_code === undefined
      || status.latest_terminal_error_code === null
      || typeof status.latest_terminal_error_code === "string")
    || !(building === null || (
      typeof building === "object"
      && typeof (building as Record<string, unknown>).collection_id === "string"
      && (building as Record<string, unknown>).collection_id === status.collection_id
      && typeof (building as Record<string, unknown>).generation_id === "string"
      && Number.isSafeInteger((building as Record<string, unknown>).source_head)
      && ["projection", "resolution"].includes(
        String((building as Record<string, unknown>).phase)
      )
      && (building as Record<string, unknown>).status === "building"
    ))
  ) {
    throw new HostedProviderResponseError(
      502,
      "invalid_provider_response",
      "Hosted projection status was malformed."
    );
  }
  return value as HostedProjectionStatus;
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

function requiredOperation(
  options?: HostedProviderOperationOptions
): RequiredOperationOptions {
  return {
    deadline: options?.deadline ?? Date.now() + PROVIDER_OPERATION_TIMEOUT_MS,
    ...(options?.signal ? { signal: options.signal } : {})
  };
}

function remainingMilliseconds(options: RequiredOperationOptions): number {
  return Math.max(0, options.deadline - Date.now());
}

function throwIfCancelled(options: RequiredOperationOptions): void {
  if (options.signal?.aborted) throw options.signal.reason;
  if (remainingMilliseconds(options) <= 0) {
    throw new HostedProviderUnavailableError(
      new DOMException("Provider operation deadline exceeded.", "TimeoutError")
    );
  }
}

async function boundedDelay(
  milliseconds: number,
  options: RequiredOperationOptions
): Promise<void> {
  throwIfCancelled(options);
  const delayMilliseconds = Math.min(milliseconds, remainingMilliseconds(options));
  await new Promise<void>((resolveDelay, rejectDelay) => {
    const finish = () => {
      options.signal?.removeEventListener("abort", abort);
      resolveDelay();
    };
    const timeout = setTimeout(finish, delayMilliseconds);
    const abort = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      rejectDelay(options.signal?.reason);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
  });
  throwIfCancelled(options);
}
