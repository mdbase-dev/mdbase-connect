import type { ContractRequirement, FileAction, FileScope, JsonObject } from "@mdbase-dev/connect-protocol";
import type { MdbaseApplicationManifest } from "./application-contract.js";
import type { MdbaseConnectionInfo } from "./connection-types.js";
/* The versioned protocol package is the sole capability-to-operation compiler. */
import { effectiveCapabilities, type MdbaseEffectiveCapabilities, type MdbaseCapabilityEvidence } from "./capabilities.js";
import type { MdbaseConnection } from "./connection.js";
import type { ConnectRequestOptions } from "./operation-types.js";
import { MdbaseConnectError } from "./errors.js";
import { withRequestBudget } from "./request-budget.js";

type ReadinessPublication =
  | { status: "authorization_required" }
  | { status: "blocked"; problem: { code: string; message: string } };

/** Live verification owns no session state; callers supply identity and cancellation guards. */
export async function verifyStructuredReadiness<Frontmatter extends JsonObject>(input: {
  collectionId: string;
  readiness: MdbaseStructuredReadiness;
  contracts: ContractRequirement[];
  connection: MdbaseConnection<Frontmatter>;
  controller: AbortController;
  options?: ConnectRequestOptions;
  requestMs: number | null;
  isCurrent: () => boolean;
  publish: (result: ReadinessPublication) => void;
}): Promise<boolean> {
  const { collectionId, readiness, contracts, connection, controller, options, requestMs, isCurrent, publish } = input;
  const abort = () => controller.abort(options?.signal?.reason);
  if (options?.signal?.aborted) abort();
  else options?.signal?.addEventListener("abort", abort, { once: true });
  try {
    const outcome = await withRequestBudget({ ...options, signal: controller.signal }, requestMs,
      request => connection.describe(request));
    if (!isCurrent()) return false;
    if (!outcome.ok) {
      const authorizationRequired = ["access_denied", "collection_access_denied", "insufficient_access", "not_authorized", "authorization_expired", "application_declaration_mismatch"].includes(outcome.problem.code);
      readiness.contracts = { state: authorizationRequired ? "requires_authorization" : "temporarily_unavailable", missing: [], evidence: [{ source: "runtime", fact: outcome.problem.message }] };
      publish(authorizationRequired
        ? { status: "authorization_required" }
        : { status: "blocked", problem: outcome.problem });
      return false;
    }
    if (outcome.value.collectionId !== collectionId) {
      readiness.contracts = { state: "temporarily_unavailable", missing: [], evidence: [] };
      publish({ status: "blocked", problem: { code: "collection_not_ready", message: "Description belongs to a different collection." } });
      return false;
    }
    const missing = contracts.filter(required => !outcome.value.contracts.some(actual =>
      actual.id === required.id && actual.version === required.version && actual.digest === required.digest));
    readiness.contracts = { state: missing.length ? "requires_setup" : "verified", missing,
      evidence: [{ source: "authority", fact: "Exact contract ID, version and digest checked by live describe for this collection." }] };
    if (missing.length) {
      publish({ status: "blocked", problem: { code: "collection_not_ready", message: "The collection is missing required exact contracts." } });
      return false;
    }
  } catch (error) {
    if (!isCurrent()) return false;
    if (!(error instanceof MdbaseConnectError)) throw error;
    readiness.contracts = { state: "temporarily_unavailable", missing: [], evidence: [{ source: "runtime", fact: error.problem.message }] };
    publish({ status: "blocked", problem: error.problem });
    return false;
  } finally {
    options?.signal?.removeEventListener("abort", abort);
  }
  return true;
}

export function publishedStructuredReadiness(
  source: MdbaseStructuredReadiness,
  status: string,
  verification?: "cached" | "verified"
): MdbaseStructuredReadiness {
  const readiness = structuredClone(source);
  if (readiness.setup.state !== "not_required" && readiness.setup.state !== "current") {
    readiness.setup.state = status === "ready" ? (verification === "cached" ? "cached" : "current")
      : status === "setup_review_required" ? "review_required"
      : status === "authorization_required" ? "requires_authorization"
      : status === "blocked" ? "blocked" : "checking";
    readiness.setup.evidence = [{ source: status === "ready" && verification === "cached" ? "runtime" : "authority",
      fact: `Collection setup verification: ${readiness.setup.state}.` }];
  }
  return readiness;
}

export interface ApplicationSessionContext {
  collectionId: string;
  info: MdbaseConnectionInfo;
  capabilities: MdbaseEffectiveCapabilities;
  /** Present only for semantic contract v2. */
  readiness?: MdbaseStructuredReadiness;
  connections: MdbaseConnectionInfo[];
}

export function applicationReadinessContext(
  manifest: MdbaseApplicationManifest,
  collectionId: string,
  info: MdbaseConnectionInfo,
  connections: MdbaseConnectionInfo[]
): ApplicationSessionContext {
  return {
    collectionId, info,
    capabilities: effectiveCapabilities(manifest.requirements!.capabilities!, manifest, info),
    ...(manifest.requirements?.capabilities?.contract_version === 2
      ? { readiness: structuredReadiness(manifest, info) } : {}),
    connections
  };
}

export function verificationKey(manifest: MdbaseApplicationManifest, collectionId: string): string {
  return `mdbase-application-session:v1:${manifest.id}:${collectionId}`;
}

export function verificationValue(manifest: MdbaseApplicationManifest): string {
  return JSON.stringify({
    capabilities: manifest.requirements?.capabilities,
    requirements: manifest.requirements?.configuration ?? [],
    provisions: manifest.provisions ?? {}
  });
}

export function collectionSetupInput(
  manifest: MdbaseApplicationManifest,
  applicationId: string,
  declarationDigest: string,
  typePackAdoptions?: Record<string, Record<string, string>>
) {
  return {
    applicationId, declarationDigest,
    requirements: { configuration: manifest.requirements?.configuration ?? [] },
    provisions: {
      configuration: manifest.provisions?.configuration ?? [],
      typePacks: manifest.provisions?.type_packs ?? []
    },
    ...(typePackAdoptions ? { typePackAdoptions } : {})
  };
}

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
