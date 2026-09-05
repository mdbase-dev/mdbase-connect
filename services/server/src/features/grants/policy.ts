import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  APPLICATION_SETUP_OPERATIONS,
  applicationOperationSelectionIsAtomic,
  areCollectionOperations,
  isCollectionOperation,
  MDBASE_TIMER_FIRED_CONTRACT,
  operationRequiresTimerCriterion
} from "@mdbase-dev/connect-protocol";
import type {
  ApplicationNotifications,
  ApplicationProvisions,
  CollectionContractDescriptor,
  ContractRequirement,
  ContractSetupChoice,
  GrantEncryption,
  GrantScope,
  TypePackProvision
} from "@mdbase-dev/connect-protocol";
import { legacyOperationSelectionAllowed, requirementContractVersion, type ApplicationRequirements } from "../../application-requirements.js";
import { collectionGrantScope } from "../../application-grant-scope.js";
import type { DatabasePool } from "../../database-types.js";
import { RequestValidationError } from "../../platform/http-errors.js";
import { requiresPortableProfile } from "../../collection-operation-policy.js";

export function scopeForRequirements(
  _requirements: ApplicationRequirements | null | undefined,
  _available: CollectionContractDescriptor[] = []
): GrantScope {
  return collectionGrantScope();
}

export function collectionSupportsOperations(
  specVersion: string,
  operations: readonly string[]
): boolean {
  if (!areCollectionOperations(operations)) return false;
  return /^0\.3(?:\.|$)/.test(specVersion)
    || operations.every((operation) => !requiresPortableProfile(operation));
}

export function assertCollectionSupportsOperations(
  specVersion: string,
  operations: readonly string[]
): void {
  const validOperations = areCollectionOperations(operations);
  const unsupported = validOperations
    ? operations.find((operation) =>
        requiresPortableProfile(operation)
          && !/^0\.3(?:\.|$)/.test(specVersion)
      )
    : operations.find((operation) =>
        !isCollectionOperation(operation)
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
  if (!areCollectionOperations(operations)) return false;
  const declared = requirements?.capabilities;
  if (requirementContractVersion(requirements) === 1) {
    return legacyOperationSelectionAllowed(requirements, operations);
  }
  const setup = new Set<string>(APPLICATION_SETUP_OPERATIONS);
  const requestedSetup = operations.filter((operation) => setup.has(operation));
  if (
    requestedSetup.length !== 0
    && requestedSetup.length !== APPLICATION_SETUP_OPERATIONS.length
  ) return false;
  const semantic = operations.filter((operation) => !setup.has(operation));
  return declared?.contract_version === 2
    ? applicationOperationSelectionIsAtomic(declared, semantic)
    : true;
}

export function assertOperationsAllowedByRequirements(
  operations: readonly string[],
  requirements: ApplicationRequirements | null | undefined
): void {
  if (!operationsAllowedByRequirements(operations, requirements)) {
    throw new RequestValidationError(
      "The requested collection operations exceed the application's declared capabilities."
    );
  }
}

export function assertOperationsAllowedByApplication(
  operations: readonly string[],
  requirements: ApplicationRequirements | null | undefined,
  notifications: ApplicationNotifications,
  provisions: ApplicationProvisions = { type_packs: [] }
): void {
  assertOperationsAllowedByRequirements(operations, requirements);
  if (requirementContractVersion(requirements) === 2) {
    const hasSetup = provisions.type_packs.length > 0
      || (provisions.configuration?.length ?? 0) > 0;
    const requestedSetup = operations.filter((operation) =>
      (APPLICATION_SETUP_OPERATIONS as readonly string[]).includes(operation)
    );
    if (
      (hasSetup && requestedSetup.length !== APPLICATION_SETUP_OPERATIONS.length)
      || (!hasSetup && requestedSetup.length !== 0)
    ) {
      throw new RequestValidationError(
        "Collection setup operations must exactly match the application's declared provisions."
      );
    }
  }
  if (
    areCollectionOperations(operations)
    && operations.some(operationRequiresTimerCriterion)
    && !notifications.criteria.some(({ event }) =>
      event.id === MDBASE_TIMER_FIRED_CONTRACT.id
      && event.version === MDBASE_TIMER_FIRED_CONTRACT.version
      && event.digest === MDBASE_TIMER_FIRED_CONTRACT.digest
    )
  ) {
    throw new RequestValidationError(
      "Timer operations require an mdbase.runtime.timer.fired notification criterion."
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

export function verifyContractSetupAcknowledgement(
  requested: ContractSetupChoice[],
  acknowledged: ContractSetupChoice[] | undefined,
  contracts: CollectionContractDescriptor[]
): void {
  if (requested.length === 0) return;
  if (!acknowledged || !isDeepStrictEqual(acknowledged, requested)) {
    throw new RequestValidationError(
      "The collection authority did not acknowledge the exact contract setup that was approved."
    );
  }
  for (const setup of requested) {
    const contract = contracts.find((candidate) =>
      candidate.id === setup.contract.id
      && candidate.version === setup.contract.version
    );
    if (!contract) {
      throw new RequestValidationError(
        `Contract setup did not provide ${setup.contract.id} ${setup.contract.version}.`
      );
    }
    if (setup.mode === "starter") continue;
    const implementation = contract.implementations.find((candidate) =>
      candidate.type_name === setup.type_name
      && isDeepStrictEqual(candidate.fields, setup.fields)
      && isDeepStrictEqual(candidate.binding, setup.binding)
    );
    if (!implementation) {
      throw new RequestValidationError(
        `Contract setup did not apply the approved mapping to type '${setup.type_name}'.`
      );
    }
  }
}

export function validateContractSetupChoices(
  setups: ContractSetupChoice[],
  required: ContractRequirement[],
  available: CollectionContractDescriptor[]
): void {
  const keys = new Set(setups.map(
    (setup) => `${setup.contract.id}@${setup.contract.version}#${setup.contract.digest}`
  ));
  if (
    keys.size !== setups.length
    || setups.some((setup) => !required.some((contract) =>
      contract.id === setup.contract.id
        && contract.version === setup.contract.version
        && contract.digest === setup.contract.digest
    ))
  ) {
    throw new RequestValidationError(
      "Contract setup may configure each contract required by this application only once."
    );
  }
  if (setups.length === 0) return;
  const missing = required.filter((contract) => !available.some((candidate) =>
    candidate.id === contract.id
      && candidate.version === contract.version
      && candidate.digest === contract.digest
  ));
  if (
    keys.size !== missing.length
    || missing.some((contract) =>
      !keys.has(`${contract.id}@${contract.version}#${contract.digest}`))
  ) {
    throw new RequestValidationError(
      "Choose starter or existing-type setup for each missing contract only."
    );
  }
}

export function allowedTypesForRequirements(
  _descriptors: CollectionContractDescriptor[],
  _requirements: ApplicationRequirements
): string[] {
  return [];
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
