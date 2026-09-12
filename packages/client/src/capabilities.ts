import {
  capabilityOperationsForContractVersion,
  type ApplicationCapabilityRequirements,
  type LegacyApplicationCapabilityRequirements,
  type FileAction
} from "@mdbase-dev/connect-protocol";
import type { MdbaseApplicationCapabilityId as ApplicationCapabilityId, MdbaseApplicationManifest as MdbaseAppManifest } from "./application-contract.js";
import type { MdbaseConnectionInfo } from "./connection-types.js";

export type MdbaseCapabilityState =
  | "available"
  | "requires_authorization"
  | "requires_setup"
  | "temporarily_unavailable"
  | "unsupported";

export interface MdbaseCapabilityEvidence {
  source: "application" | "authorization" | "authority" | "runtime";
  fact: string;
}

export interface MdbaseEffectiveCapability {
  id: ApplicationCapabilityId;
  requirement: "required" | "optional";
  state: MdbaseCapabilityState;
  operations: string[];
  missingOperations: string[];
  evidence: MdbaseCapabilityEvidence[];
  reason?: string;
  details?: Record<string, unknown>;
}

export interface MdbaseEffectiveCapabilities {
  contractVersion: 1 | 2;
  values: Partial<Record<ApplicationCapabilityId, MdbaseEffectiveCapability>>;
  requiredAvailable: boolean;
}

export function effectiveCapabilities(
  requirements: ApplicationCapabilityRequirements | LegacyApplicationCapabilityRequirements,
  manifest: MdbaseAppManifest,
  connection: MdbaseConnectionInfo
): MdbaseEffectiveCapabilities {
  const required = new Set(requirements.required);
  const declared = [...new Set([...requirements.required, ...(requirements.optional ?? [])])];
  const values: Partial<Record<ApplicationCapabilityId, MdbaseEffectiveCapability>> = {};
  for (const id of declared) {
    values[id] = effectiveCapability(id, required.has(id), connection, requirements.contract_version, manifest);
  }
  return {
    contractVersion: requirements.contract_version,
    values,
    requiredAvailable: requirements.required.every(
      (id) => values[id]?.state === "available"
    )
  };
}

function effectiveCapability(
  id: ApplicationCapabilityId,
  required: boolean,
  connection: MdbaseConnectionInfo,
  version: 1 | 2,
  manifest: MdbaseAppManifest
): MdbaseEffectiveCapability {
  const operations = capabilityOperationsForContractVersion(version, id) ?? [];
  const missingOperations = operations.filter(
    (operation) => !connection.operations.includes(operation)
  );
  const base = {
    id,
    requirement: required ? "required" as const : "optional" as const,
    operations,
    missingOperations,
    evidence: [{
      source: "application" as const,
      fact: `${required ? "Required" : "Optional"} in capability contract v${version}.`
    }]
  };
  if (missingOperations.length > 0) {
    return {
      ...base,
      state: "requires_authorization",
      evidence: [...base.evidence, {
        source: "authorization",
        fact: `Missing ${missingOperations.join(", ")}.`
      }],
      reason: "The current grant does not include every operation for this capability."
    };
  }
  if (connection.scope.access !== "full_collection") {
    return {
      ...base,
      state: "requires_authorization",
      reason: "The current grant uses legacy contract scope and must be reauthorized for the entire collection.",
      evidence: [...base.evidence, {
        source: "authorization",
        fact: "Legacy contract scope is compatibility evidence, not active data authority."
      }]
    };
  }
  // Compatibility readiness is deliberately limited to v1 aliases. V2 needs
  // structured file/notification/runtime evidence, not these legacy shortcuts.
  if (version === 1 && id.startsWith("files.")) {
    const action = id.slice("files.".length) as FileAction;
    if (!connection.fileCapability?.actions.includes(action)) {
      return {
        ...base,
        state: connection.fileCapability ? "requires_authorization" : "unsupported",
        reason: connection.fileCapability ? `The current file grant does not include ${action}.` : "This connection has no file capability."
      };
    }
  }
  if (version === 1 && id === "notifications.background-delivery" && (manifest.notifications?.criteria.length ?? 0) === 0) {
    return { ...base, state: "requires_setup", reason: "The application manifest declares no notification criteria." };
  }
  return {
    ...base,
    state: "available",
    evidence: [...base.evidence, {
      source: "authorization",
      fact: operations.length > 0
        ? `Granted operations: ${operations.join(", ")}.`
        : "No record operation is required."
    }, {
      source: "authority",
      fact: connection.authority.kind === "hosted"
        ? "Backed by a durable hosted mdbase authority."
        : "Backed by a user-operated mdbase connector."
    }],
    ...(id === "offline.replica" || (version === 1 && id === "sync.offline-replica")
      ? {
          details: {
            durability: "device",
            writes: "queued",
            authority: connection.authority.kind
          }
        }
      : {}),
    ...(version === 1 && id === "notifications.background-delivery"
      ? { details: { delivery: "authority", payload: "opaque" } } : {})
  };
}
