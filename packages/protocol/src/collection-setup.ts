import type {
  ContractSetupChoice,
  TypePackAssessment,
  TypePackProvision,
  TypePackReceipt
} from "./type-packs.js";

export type ConfigurationContributionValue = string | number | boolean | null;

export interface ConfigurationRequirement {
  id: string;
  path: string;
  predicate: "contains";
  value: ConfigurationContributionValue;
}

export interface ConfigurationProvision {
  requirement: string;
  operation: "set_add";
  path: string;
  value: ConfigurationContributionValue;
}

export interface ApplicationCollectionSetupRequirements {
  configuration: ConfigurationRequirement[];
}

export interface ApplicationCollectionSetupProvisions {
  configuration: ConfigurationProvision[];
  type_packs: TypePackProvision[];
}

export interface AssessCollectionSetupInput {
  /** Stable application declaration id, not the server's database id. */
  application_id: string;
  /** Exact canonical digest of the complete registered application declaration. */
  declaration_digest: string;
  requirements: ApplicationCollectionSetupRequirements;
  provisions: ApplicationCollectionSetupProvisions;
  /** Collection-owner choices for user-owned contract implementations. */
  contract_setups?: ContractSetupChoice[];
  /** Digest-pinned consent to adopt unmanaged managed resources, keyed by pack id and target. */
  type_pack_adoptions?: Record<string, Record<string, string>>;
}

export interface ApplyCollectionSetupInput extends AssessCollectionSetupInput {
  expected_assessment_digest: string;
  expected_collection_revision: string;
  expected_provision_digest: string;
  allow_type_pack_downgrades?: string[];
}

export interface ConfigurationSetupConflict {
  code: "configuration_path_conflict" | "configuration_type_conflict";
  path: string;
  expected: "mapping" | "sequence";
  observed: "null" | "boolean" | "number" | "string" | "sequence" | "mapping" | "tagged";
  message: string;
}

export interface ConfigurationSetupAssessment {
  requirement: string;
  path: string;
  value: ConfigurationContributionValue;
  action: "current" | "add" | "conflict";
  conflict?: ConfigurationSetupConflict;
}

export interface CollectionSetupAssessment {
  status: "current" | "provision" | "conflict";
  applicable: boolean;
  application_id: string;
  declaration_digest: string;
  provision_digest: string;
  collection_revision: string;
  final_collection_revision: string;
  baseline_diagnostic_count: number;
  final_diagnostic_count: number;
  resolved_diagnostic_count: number;
  introduced_diagnostic_count: number;
  baseline_diagnostic_digest: string;
  configuration: ConfigurationSetupAssessment[];
  type_packs: TypePackAssessment[];
  final_resource_revisions: Record<string, string>;
  assessment_digest: string;
}

export interface ConfigurationContributionReceipt {
  requirement: string;
  path: string;
  value: ConfigurationContributionValue;
}

export interface CollectionSetupReceipt {
  application_id: string;
  declaration_digest: string;
  provision_digest: string;
  assessment_digest: string;
  collection_revision: string;
  configuration: ConfigurationContributionReceipt[];
  type_packs: TypePackReceipt[];
  cleanup_deferred: boolean;
}

export interface CollectionSetupApplyResult {
  assessment: CollectionSetupAssessment;
  receipt: CollectionSetupReceipt;
}
