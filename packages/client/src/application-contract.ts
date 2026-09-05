import {
  APPLICATION_SETUP_OPERATIONS,
  applicationFileRequest,
  capabilityOperationsForContractVersion,
  type ApplicationCapabilityId,
  type ApplicationCapabilityRequirements,
  type LegacyApplicationCapabilityRequirements,
  type LegacyApplicationCapabilityId,
  type ApplicationRequirements,
  type LegacyApplicationRequirements,
  type MdbaseAppManifest,
  type LegacyMdbaseAppManifest,
  type CollectionOperation
} from "@mdbase-dev/connect-protocol";
import { connectError } from "./errors.js";
export const DEFAULT_OPERATIONS: CollectionOperation[] = ["describe", "changes", "read", "query"];

/** SDK input compatibility boundary; protocol ApplicationRequirements remains v2-only. */
export type MdbaseApplicationManifest = MdbaseAppManifest | LegacyMdbaseAppManifest;
export type MdbaseApplicationRequirements = ApplicationRequirements | LegacyApplicationRequirements;
export type MdbaseApplicationCapabilityRequirements = ApplicationCapabilityRequirements | LegacyApplicationCapabilityRequirements;
export type MdbaseApplicationCapabilityId = ApplicationCapabilityId | LegacyApplicationCapabilityId;

interface MdbaseAuthorizationSelection {
  operations?: CollectionOperation[];
  capabilities?: MdbaseApplicationCapabilityId[];
}

export function semanticContractVersion(requirements: MdbaseApplicationRequirements): 1 | 2 {
  const version = requirements.capabilities === undefined ? 1 : requirements.capabilities?.contract_version;
  if (version !== 1 && version !== 2) invalidAuthorizationSelection("Unsupported declared capability contract version.");
  return version;
}

export function invalidAuthorizationSelection(message: string): never {
  throw connectError("invalid_application_manifest", message, {
    details: { issues: [{ path: "/requirements/capabilities", keyword: "authorizationSelection", message, params: {} }] }
  });
}

export function validateAuthorizationSelection(
  requirements: MdbaseApplicationRequirements,
  options: MdbaseAuthorizationSelection
): void {
  if (options.operations !== undefined && options.capabilities !== undefined) {
    invalidAuthorizationSelection("Specify operations or capabilities, not both.");
  }
  if (options.operations !== undefined && semanticContractVersion(requirements) !== 1) {
    invalidAuthorizationSelection("Exact operations authorization is only supported for legacy v1 declarations.");
  }
  if (options.capabilities !== undefined) {
    const declared = new Set<string>([
      ...(requirements.capabilities?.required ?? []),
      ...(requirements.capabilities?.optional ?? [])
    ]);
    if (options.capabilities.some((id) => !declared.has(id)
      || capabilityOperationsForContractVersion(semanticContractVersion(requirements), id) === undefined)) {
      invalidAuthorizationSelection("Authorization can only include capabilities declared by the application.");
    }
  }
}

export function declaredOperations(requirements: MdbaseApplicationRequirements): CollectionOperation[] {
  const capabilities = requirements.capabilities;
  if (!capabilities) return [...DEFAULT_OPERATIONS];
  return [...new Set([...capabilities.required, ...(capabilities.optional ?? [])].flatMap(
    (id) => capabilityOperationsForContractVersion(capabilities.contract_version, id) ?? []
  ))];
}

export function authorizationOperations(
  application: { requirements: MdbaseApplicationRequirements; provisions?: MdbaseApplicationManifest["provisions"] },
  options: MdbaseAuthorizationSelection
): CollectionOperation[] {
  const { requirements } = application;
  validateAuthorizationSelection(requirements, options);
  // Legacy callers selected independent exact operations, including subsets of declarations.
  if (semanticContractVersion(requirements) === 1) {
    if (options.operations !== undefined) return [...new Set(options.operations)];
    if (options.capabilities === undefined) return [...DEFAULT_OPERATIONS];
  }
  const declared = requirements.capabilities;
  const selected = [...(declared?.required ?? []), ...(options.capabilities ?? declared?.optional ?? [])];
  const operations = selected.flatMap((id) => capabilityOperationsForContractVersion(semanticContractVersion(requirements), id) ?? []);
  const hasSetup = (application.provisions?.type_packs.length ?? 0) > 0
    || (application.provisions?.configuration?.length ?? 0) > 0;
  return [...new Set([
    ...operations,
    ...(semanticContractVersion(requirements) === 2 && hasSetup ? APPLICATION_SETUP_OPERATIONS : [])
  ])];
}

export function retainedCapabilities(requirements: MdbaseApplicationRequirements, operations: CollectionOperation[]): MdbaseApplicationCapabilityId[] {
  return [...(requirements.capabilities?.required ?? []), ...(requirements.capabilities?.optional ?? [])].filter(
    (id) => (capabilityOperationsForContractVersion(semanticContractVersion(requirements), id) ?? []).every((operation) => operations.includes(operation))
  );
}

export function authorizationFiles(requirements: MdbaseApplicationRequirements) {
  const files = requirements.files;
  if (!files) return undefined;
  if (semanticContractVersion(requirements) === 1) {
    if (!("actions" in files) || "required" in files || "optional" in files) {
      invalidAuthorizationSelection("Legacy file declarations must use exact files.actions.");
    }
    return { actions: [...files.actions], scope: structuredClone(files.scope) };
  }
  if ("actions" in files) invalidAuthorizationSelection("V2 file declarations must use required/optional file actions.");
  return applicationFileRequest(files);
}
