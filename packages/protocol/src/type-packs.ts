export interface ContractRequirement {
  id: string;
  /** Exact semantic version of the collection-local mdbase data contract. */
  version: string;
  /** Exact digest of the resolved portable contract identity. */
  digest: string;
}

/** Exact identity of the standard record-created runtime event contract. */
export const MDBASE_RECORD_CREATED_CONTRACT = {
  id: "mdbase.record.created",
  version: "1.0.0",
  digest: "sha256:7f3bed6baa356ee9389e977ae7b77a102e2bee871a7c1d9f2026fc21cacdbfc9",
} as const satisfies ContractRequirement;

/** Exact identity of the standard record-modified runtime event contract. */
export const MDBASE_RECORD_MODIFIED_CONTRACT = {
  id: "mdbase.record.modified",
  version: "1.0.0",
  digest: "sha256:064187148a95701a1f5c749643d306d3c6708470b6b7ab0bf0c698d38dbcabe3",
} as const satisfies ContractRequirement;

/** Exact identity of the standard record-deleted runtime event contract. */
export const MDBASE_RECORD_DELETED_CONTRACT = {
  id: "mdbase.record.deleted",
  version: "1.0.0",
  digest: "sha256:84e5fb0f9d3bfdcd53f76cdc5035f94c7693fdea39a8ead190b10b422dd2ee09",
} as const satisfies ContractRequirement;

/** Exact identity of the standard record-renamed runtime event contract. */
export const MDBASE_RECORD_RENAMED_CONTRACT = {
  id: "mdbase.record.renamed",
  version: "1.0.0",
  digest: "sha256:c825ef8d7db775b784d7af27e6acdf6f2799d2c6440d486f5bfa78afcca71471",
} as const satisfies ContractRequirement;

/** Exact identity of the standard timer-fired runtime event contract. */
export const MDBASE_TIMER_FIRED_CONTRACT = {
  id: "mdbase.runtime.timer.fired",
  version: "1.0.0",
  digest: "sha256:41105be7a7abf33b31ced47e1e1965242236e40ccaea286b959b0a8c591f5642",
} as const satisfies ContractRequirement;

export interface TypePackManifestResource {
  kind: "contract" | "type" | "schema";
  mode: "managed" | "seed";
  source: string;
  target: string;
  digest: string;
}

export interface TypePackManifest {
  kind: "mdbase.type-pack";
  id: string;
  version: string;
  name?: string;
  description?: string;
  resources: TypePackManifestResource[];
  [extension: `x-${string}`]: unknown;
}

export interface TypePackSourceResource {
  source: string;
  document: string;
}

export interface TypePackProvision {
  /** Canonical type-pack manifest shown during approval and verified on install. */
  manifest: TypePackManifest;
  /** Exact UTF-8 resource bytes, keyed by each manifest source path. */
  resources: TypePackSourceResource[];
  /** Data contracts expected after the complete pack is installed. */
  provides: ContractRequirement[];
}

export interface TypePackResourceDiff {
  source: string;
  target: string;
  kind: "contract" | "type" | "schema";
  mode: "managed" | "seed";
  action: "create" | "update" | "delete" | "adopt" | "unchanged" | "preserve" | "conflict";
  digest: string;
  current_digest?: string;
  installed_digest?: string;
  adopted_from_digest?: string;
  reason?: string;
}

export interface TypePackReceipt {
  id: string;
  version: string;
  digest: string;
  installed_by: string;
  resources: Omit<TypePackResourceDiff, "action" | "current_digest" | "installed_digest" | "reason">[];
}

export interface TypePackAssessment {
  status: "current" | "install" | "upgrade" | "downgrade" | "reconfigure" | "conflict";
  applicable: boolean;
  assessment_digest: string;
  current?: TypePackReceipt;
  desired: TypePackReceipt;
  resources: TypePackResourceDiff[];
  lock: {
    target: "mdbase.lock.yaml";
    action: "create" | "update" | "unchanged";
    digest: string;
  };
  contract_setups: {
    choices: ContractSetupChoice[];
    resources: TypePackResourceDiff[];
  };
}

export interface TypePackApplyResult extends TypePackAssessment {
  receipt: TypePackReceipt;
  cleanup_deferred: boolean;
}

export interface AssessTypePackInput {
  provision: TypePackProvision;
  installed_by: string;
  /** Explicit digest-pinned consent to claim differing unmanaged managed targets. */
  adopt_resources?: Record<string, string>;
  /** Seed resources deliberately omitted because the user selected an existing implementation. */
  preserve_seed_targets?: string[];
  /** Resolve canonical manifest targets to collection-specific paths. */
  target_overrides?: Record<string, string>;
  /** Reviewed edits to user-owned types, committed atomically with the pack. */
  contract_setups?: ContractSetupChoice[];
}

export interface ApplyTypePackInput extends AssessTypePackInput {
  expected_assessment_digest: string;
  allow_downgrade?: boolean;
}

export type ContractSetupChoice =
  | {
      contract: ContractRequirement;
      mode: "starter";
    }
  | {
      contract: ContractRequirement;
      mode: "existing";
      type_name: string;
      /** Exact type source revision shown during approval. */
      type_revision: string;
      fields: Record<string, string>;
      binding?: Record<string, unknown>;
    };
