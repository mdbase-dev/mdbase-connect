import type { ContractRequirement, FileAction, FileScope } from "@mdbase-dev/connect-protocol";
import type { MdbaseApplicationManifest } from "./application-contract.js";
import type { MdbaseConnectionInfo } from "./connection-types.js";
import type { MdbaseCapabilityEvidence } from "./capabilities.js";

/** Independent v2 declarations; never legacy capability aliases. */
export interface MdbaseStructuredReadiness {
  files: {
    state: "not_required" | "available" | "requires_authorization";
    missingRequiredActions: FileAction[];
    missingOptionalActions: FileAction[];
    scopeMatches: boolean;
    evidence: MdbaseCapabilityEvidence[];
  };
  contracts: {
    state: "not_required" | "checking" | "verified" | "requires_setup" | "requires_authorization" | "temporarily_unavailable";
    missing: ContractRequirement[];
    evidence: MdbaseCapabilityEvidence[];
  };
  setup: {
    state: "not_required" | "checking" | "review_required" | "current" | "cached" | "blocked" | "requires_authorization";
    evidence: MdbaseCapabilityEvidence[];
  };
  notifications: {
    state: "not_required" | "requires_registration";
    registration: "unverified";
    evidence: MdbaseCapabilityEvidence[];
  };
}

function sameScope(left: FileScope, right?: FileScope): boolean {
  if (!right || left.kind !== right.kind) return false;
  if (left.kind === "collection" || right.kind === "collection") return true;
  const a = [...new Set(left.folders)].sort();
  const b = [...new Set(right.folders)].sort();
  return JSON.stringify(a) === JSON.stringify(b);
}

export function structuredReadiness(manifest: MdbaseApplicationManifest, info: MdbaseConnectionInfo): MdbaseStructuredReadiness {
  const files = manifest.requirements?.files;
  const requirement = files && "required" in files ? files : undefined;
  const scopeMatches = !requirement || sameScope(requirement.scope, info.fileCapability?.scope);
  const missing = (actions: FileAction[]) => actions.filter(action => !scopeMatches || !info.fileCapability?.actions.includes(action));
  const missingRequiredActions = missing(requirement?.required ?? []);
  const missingOptionalActions = missing(requirement?.optional ?? []);
  const contracts = manifest.requirements?.contracts ?? [];
  const setup = (manifest.provisions?.type_packs.length ?? 0) > 0 || (manifest.provisions?.configuration?.length ?? 0) > 0;
  return {
    files: {
      state: !requirement ? "not_required" : missingRequiredActions.length ? "requires_authorization" : "available",
      missingRequiredActions, missingOptionalActions, scopeMatches,
      evidence: [{ source: "authorization", fact: "Compared exact file actions and folder scope with connection.info().fileCapability." }]
    },
    contracts: { state: contracts.length ? "checking" : "not_required", missing: [], evidence: [] },
    setup: { state: setup ? "checking" : "not_required", evidence: [] },
    notifications: {
      state: manifest.notifications?.criteria.length ? "requires_registration" : "not_required",
      registration: "unverified",
      evidence: [{ source: "runtime", fact: "The connection API exposes registration commands but no current delivery-registration query. Manifest criteria do not prove approval or delivery registration." }]
    }
  };
}
