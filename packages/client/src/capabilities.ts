import {
  capabilityOperations,
  type ApplicationCapabilityId,
  type ApplicationCapabilityRequirements,
  type FileAction,
  type MdbaseAppManifest
} from "@mdbase-dev/connect-protocol";
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
  contractVersion: 1;
  values: Partial<Record<ApplicationCapabilityId, MdbaseEffectiveCapability>>;
  requiredAvailable: boolean;
}

export function effectiveCapabilities(
  requirements: ApplicationCapabilityRequirements,
  manifest: MdbaseAppManifest,
  connection: MdbaseConnectionInfo
): MdbaseEffectiveCapabilities {
  const required = new Set(requirements.required);
  const declared = [...new Set([...requirements.required, ...(requirements.optional ?? [])])];
  const values: Partial<Record<ApplicationCapabilityId, MdbaseEffectiveCapability>> = {};
  for (const id of declared) {
    values[id] = effectiveCapability(id, required.has(id), manifest, connection);
  }
  return {
    contractVersion: 1,
    values,
    requiredAvailable: requirements.required.every(
      (id) => values[id]?.state === "available"
    )
  };
}

function effectiveCapability(
  id: ApplicationCapabilityId,
  required: boolean,
  manifest: MdbaseAppManifest,
  connection: MdbaseConnectionInfo
): MdbaseEffectiveCapability {
  const operations = capabilityOperations(id);
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
      fact: `${required ? "Required" : "Optional"} in capability contract v1.`
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
  if (id === "definitions.contracts.current") {
    const approved = new Set(connection.scope.contracts.map(
      ({ id, version, digest }) => `${id}@${version}:${digest}`
    ));
    const missingContracts = (manifest.requirements?.contracts ?? []).filter(
      ({ id, version, digest }) => !approved.has(`${id}@${version}:${digest}`)
    );
    if (missingContracts.length > 0) {
      return {
        ...base,
        state: "requires_authorization",
        reason: "The current grant does not approve the exact required contract definitions.",
        evidence: [...base.evidence, {
          source: "authorization",
          fact: `Missing ${missingContracts.map(({ id, version }) => `${id}@${version}`).join(", ")}.`
        }],
        details: { missingContracts }
      };
    }
  }
  if (id.startsWith("files.")) {
    const action = id.slice("files.".length);
    if (!connection.fileCapability?.actions.includes(action as FileAction)) {
      return {
        ...base,
        state: connection.fileCapability ? "requires_authorization" : "unsupported",
        reason: connection.fileCapability
          ? `The current file grant does not include ${action}.`
          : "This connection has no file capability.",
        evidence: [...base.evidence, {
          source: "authorization",
          fact: connection.fileCapability
            ? `Granted file actions: ${connection.fileCapability.actions.join(", ")}.`
            : "No file capability was granted."
        }]
      };
    }
  }
  if (
    id === "notifications.background-delivery"
    && (manifest.notifications?.criteria.length ?? 0) === 0
  ) {
    return {
      ...base,
      state: "requires_setup",
      reason: "The application manifest declares no notification criteria.",
      evidence: [...base.evidence, {
        source: "application",
        fact: "No authority notification criteria are declared."
      }]
    };
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
    ...(id === "sync.offline-replica"
      ? {
          details: {
            durability: "device",
            writes: "queued",
            authority: connection.authority.kind
          }
        }
      : {}),
    ...(id === "notifications.background-delivery"
      ? { details: { delivery: "authority", payload: "opaque" } }
      : {})
  };
}
