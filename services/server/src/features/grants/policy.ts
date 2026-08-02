import { randomUUID } from "node:crypto";
import type {
  ApplicationProvisions,
  ApplicationRequirements,
  CollectionContractDescriptor,
  ContractRequirement,
  GrantEncryption,
  GrantScope,
  TypePackProvision
} from "@mdbase-dev/connect-protocol";
import type { DatabasePool } from "../../database-types.js";
import { typesForContracts } from "../../hosted.js";
import { RequestValidationError } from "../../platform/http-errors.js";

const FULL_COLLECTION_OPERATIONS = new Set([
  "validate",
  "list_views",
  "execute_view",
  "read_type",
  "create_type",
  "update_type",
  "apply_type_pack"
]);

const PORTABLE_PROFILE_OPERATIONS = new Set([
  "query",
  "list_views",
  "execute_view",
  "read_type",
  "create_type",
  "update_type",
  "apply_type_pack"
]);

export function scopeForRequirements(
  requirements: ApplicationRequirements | null | undefined,
  available: CollectionContractDescriptor[] = []
): GrantScope {
  if (requirements?.access === "full_collection") {
    return { access: "full_collection", contracts: [] };
  }
  const required = new Set(
    (requirements?.contracts ?? []).map(
      ({ id, version }) => `${id}@${version}`
    )
  );
  return {
    access: "contract",
    contracts: available.filter(
      ({ id, version }) => required.has(`${id}@${version}`)
    )
  };
}

export function collectionSupportsOperations(
  specVersion: string,
  operations: readonly string[]
): boolean {
  return /^0\.3(?:\.|$)/.test(specVersion)
    || operations.every(
      (operation) => !PORTABLE_PROFILE_OPERATIONS.has(operation)
    );
}

export function assertCollectionSupportsOperations(
  specVersion: string,
  operations: readonly string[]
): void {
  const unsupported = operations.find(
    (operation) =>
      PORTABLE_PROFILE_OPERATIONS.has(operation)
      && !/^0\.3(?:\.|$)/.test(specVersion)
  );
  if (unsupported) {
    throw new RequestValidationError(
      `This collection uses mdbase ${specVersion} and does not support the ${unsupported} operation.`
    );
  }
}

export function operationsAllowedByRequirements(
  operations: readonly string[],
  requirements: ApplicationRequirements | null | undefined
): boolean {
  return requirements?.access === "full_collection"
    || operations.every(
      (operation) => !FULL_COLLECTION_OPERATIONS.has(operation)
    );
}

export function assertOperationsAllowedByRequirements(
  operations: readonly string[],
  requirements: ApplicationRequirements | null | undefined
): void {
  if (
    operations.length > 0
    &&
    requirements?.access !== "full_collection"
    && (requirements?.contracts?.length ?? 0) === 0
  ) {
    throw new RequestValidationError(
      "Contract-scoped application manifests must declare at least one required contract; use full_collection for collection-wide access."
    );
  }
  if (!operationsAllowedByRequirements(operations, requirements)) {
    throw new RequestValidationError(
      "Saved views, collection-wide validation, and type definitions require the application manifest to request full collection access."
    );
  }
}

export function requiredContractsForRequirements(
  requirements: ApplicationRequirements | null | undefined
): ContractRequirement[] {
  const contracts = requirements?.contracts ?? [];
  return [...new Map(contracts.map((contract) => [
    `${contract.id}@${contract.version}`,
    contract
  ])).values()];
}

export function allowedTypesForRequirements(
  descriptors: CollectionContractDescriptor[],
  requirements: ApplicationRequirements
): string[] {
  return requirements.access === "full_collection"
    ? []
    : typesForContracts(
        descriptors,
        requiredContractsForRequirements(requirements)
      );
}

export function requiresHostedCollection(
  requirements: ApplicationRequirements | null | undefined
): boolean {
  return requirements?.collection_kind === "hosted";
}

export async function rotateGrantEncryption(
  db: DatabasePool,
  grantId: string
): Promise<void> {
  const grant = await db.query<{ encryption: GrantEncryption | null }>(
    `SELECT encryption FROM grants
     WHERE id = $1 AND revoked_at IS NULL AND activated_at IS NOT NULL`,
    [grantId]
  );
  const encryption = grant.rows[0]?.encryption;
  if (!encryption) return;
  const rotated: GrantEncryption = {
    ...encryption,
    key_id: `enc_${randomUUID()}`,
    scope_epoch: encryption.scope_epoch + 1
  };
  await db.query(
    "UPDATE grants SET encryption = $2::jsonb WHERE id = $1",
    [grantId, JSON.stringify(rotated)]
  );
}

export function contractsSatisfy(
  available: ContractRequirement[] | null | undefined,
  required: ContractRequirement[]
): boolean {
  const present = new Set(
    (available ?? []).map(
      (contract) => `${contract.id}@${contract.version}`
    )
  );
  return required.every(
    (contract) => present.has(`${contract.id}@${contract.version}`)
  );
}

export function requiredTypePackProvisions(
  requirements: ApplicationRequirements,
  provisions: ApplicationProvisions,
  available: ContractRequirement[]
): TypePackProvision[] | null {
  const missing = requirements.contracts.filter(
    (required) =>
      !available.some(
        (present) =>
          present.id === required.id
          && present.version === required.version
          && present.digest === required.digest
      )
  );
  if (
    missing.some(
      (required) =>
        !provisions.type_packs.some(
          (provision) =>
            provision.provides.some(
              (provided) =>
                provided.id === required.id
                && provided.version === required.version
                && provided.digest === required.digest
            )
        )
    )
  ) {
    return null;
  }
  return provisions.type_packs.filter(
    (provision) =>
      provision.provides.some(
        (provided) =>
          missing.some(
            (required) =>
              required.id === provided.id
              && required.version === provided.version
          )
      )
  );
}
