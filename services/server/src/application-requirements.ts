import { applicationFileRequest, capabilityOperationsForContractVersion } from "@mdbase-dev/connect-protocol";
import type { ApplicationRequirements as V2ApplicationRequirements, ApplicationFileRequest } from "@mdbase-dev/connect-protocol";
import type { LegacyApplicationRequirements } from "@mdbase-dev/connect-protocol/manifest";

/** Server-only declaration union. Never translate predecessor intent into groups. */
export type ApplicationRequirements = LegacyApplicationRequirements | V2ApplicationRequirements;

export function requirementContractVersion(requirements: ApplicationRequirements | null | undefined): 1 | 2 {
  const version = requirements?.capabilities?.contract_version ?? 1;
  if (version !== 1 && version !== 2) throw new Error("Unsupported semantic capability contract version.");
  return version;
}

export function legacyOperationSelectionAllowed(
  requirements: ApplicationRequirements | null | undefined,
  operations: readonly string[]
): boolean {
  const declared = requirements?.capabilities;
  if (!declared) return true;
  if (declared.contract_version !== 1) return false;
  const expansions = [...declared.required, ...(declared.optional ?? [])].map(
    (capability) => capabilityOperationsForContractVersion(1, capability)
  );
  if (expansions.some((expansion) => expansion === undefined)) return false;
  const allowed = new Set<string>(expansions.flatMap((expansion) => expansion ?? []));
  return operations.every((operation) => allowed.has(operation));
}

export function fileRequestForRequirements(requirements: ApplicationRequirements): ApplicationFileRequest | undefined {
  const files = requirements.files;
  if (!files) return undefined;
  if (requirementContractVersion(requirements) === 1) {
    if (!("actions" in files) || "required" in files || "optional" in files) {
      throw new Error("Semantic v1 requires files.actions.");
    }
    return { actions: [...files.actions], scope: structuredClone(files.scope) };
  }
  if ("actions" in files) throw new Error("Semantic v2 requires required/optional file actions.");
  return applicationFileRequest(files);
}
