/**
 * The result types. Shapes follow the spec's names (snake_case members) so
 * they match the Rust crate, the CLI and the conformance fixtures.
 */

/** A spec 14 diagnostic. */
export interface Issue {
  /** Spec code: `schema_required`, `type_conflict`, `link_not_found`, ... */
  code: string;
  severity: "error" | "warning";
  /** Which check produced it. */
  tier: "request" | "single_record" | "cross_record";
  /** Human-readable; not stable. */
  message: string;
  /** JSON Pointer into the frontmatter, or a resource path. */
  location?: string;
  /** The type concerned. */
  type?: string;
  details?: unknown;
}

/** A JSON Schema validation failure. */
export interface SchemaIssue {
  /** `schema_<keyword>` or `format_invalid`. */
  code: string;
  /** The JSON Schema keyword (`required`, `minLength`, ...). */
  keyword: string;
  /** RFC 6901 pointer into the instance; `""` is the root. */
  instance_path: string;
  /** Pointer to the failing keyword in the schema document. */
  schema_path: string;
  message: string;
}

/** `settings` from `mdbase.yaml`, with defaults applied. */
export interface Settings {
  timezone: string | null;
  types_folder: string;
  contracts_folder: string;
  record_extensions: string[];
  validation: "off" | "warn" | "error";
  explicit_type_keys: string[];
  id_field: string | null;
  exclude: string[];
}

/** A compiled type definition. `raw` is the type file's whole frontmatter. */
export interface TypeDefinition {
  name: string;
  /** The type file's resource path (`_types/task.md`). */
  path: string;
  version: number | null;
  schema: { document: unknown; entry: string };
  /** `collection.merge`: top-level field → strategy. */
  merge: Record<string, string>;
  /** `collection.links` selectors. */
  link_fields: string[];
  path_pattern: string | null;
  raw: Record<string, unknown>;
}

/** A data contract and its stable digest (spec 05A). */
export interface Contract {
  id: string;
  /** Exact semver, build metadata dropped. */
  version: string;
  contract_type: "record" | "event" | "action" | string;
  name: string | null;
  /** `sha256:<hex>` over the portable semantics. */
  digest: string;
  /** The contract file's resource path. */
  path: string;
  /** Resolved schema members (`record_schema`, `binding_schema`, ...). */
  schemas: Record<string, { entry: string; value: unknown }>;
}

/** A type's implementation of a contract and its digest. */
export interface Implementation {
  type: string;
  contract: string;
  requirement: string;
  version: string;
  /** Contract field → record field. */
  fields: [string, string][];
  binding: Record<string, unknown>;
  contract_digest: string;
  digest: string;
}

/** Everything compiled from `mdbase.yaml`, the types folder and the contracts folder. */
export interface Catalog {
  /** False when the config or a type file is invalid; see `issues`. */
  valid: boolean;
  spec_version: string | null;
  settings: Settings;
  types: TypeDefinition[];
  contracts: Contract[];
  implementations: Implementation[];
  issues: Issue[];
}

/** A pack resource as the manifest declares it, with its bytes. */
export interface PackResource {
  kind: "contract" | "type" | "schema" | string;
  mode: "managed" | "seed";
  source: string;
  target: string;
  digest: string;
  document: string;
  baselines: { digest: string; version: number | null }[];
}

/** A validated type pack. */
export interface Pack {
  id: string;
  version: string;
  /** JCS digest of the manifest. */
  digest: string;
  resources: PackResource[];
}

/** One installed pack, from `mdbase.lock.yaml`. */
export interface Receipt {
  id: string;
  version: string;
  digest: string;
  installed_by: string;
  resources: {
    kind: string;
    mode: "managed" | "seed";
    source: string;
    target: string;
    digest: string;
    origin_digest: string | null;
  }[];
}

/** The parsed lock file. */
export interface Lock {
  packs: Receipt[];
}

export type PackAction = "create" | "update" | "unchanged" | "preserve" | "retire" | "conflict" | string;
export type PackStatus = "install" | "upgrade" | "downgrade" | "current" | "conflict" | string;

/** The read-only assessment of a pack against a collection (spec 05A). */
export interface Assessment {
  status: PackStatus;
  /** Whether `applyTypePack` may proceed. */
  applicable: boolean;
  pack: { id: string; version: string; digest: string };
  /** The installed receipt, if any. */
  current: Receipt | null;
  resources: {
    kind: string;
    mode: "managed" | "seed";
    source: string;
    target: string;
    action: PackAction;
    live: string | null;
    document: string | null;
    result: string | null;
    origin: string | null;
    reason: string | null;
    upgrade_baseline: { digest: string; version: number | null } | null;
  }[];
  lock_action: PackAction;
  lock_document: string;
  lock_digest: string;
  issues: Issue[];
  /** Pass this to `applyTypePack` as `expectedDigest`. */
  assessment_digest: string;
}

/** The core's resource intent, structurally compatible with SDK `Op`. */
export type PackOperation =
  | { kind: "resource_put"; path: string; doc: string; baseRevision?: string; mustNotExist: boolean }
  | { kind: "resource_delete"; path: string; baseRevision?: string };

/** What `applyTypePack` returns: the exact resource changes to make. */
export interface PackApplication {
  assessment: Assessment;
  /**
   * Original core operations in order, including CAS/create-only guards and
   * the lock update. Submit together as ONE mutation through the held client;
   * never rebuild these from writes/deletes or drop guards. Empty if current.
   */
  ops: PackOperation[];
  /** Files to write with these exact bytes (includes `mdbase.lock.yaml`). */
  writes: { path: string; document: string }[];
  /** Files to delete. */
  deletes: string[];
}

/** Explicit resource DATA; completeness comes from the native collector, not this helper. */
export interface ResourceSource {
  path: string;
  source: string;
}

export type ConfigurationScalar = string | number | boolean | null;

/** Detailed evidence from the Core configuration component. */
export interface ConfigurationAssessment {
  configuration: {
    requirement: string;
    path: string;
    value: ConfigurationScalar;
    action: "current" | "add" | "conflict";
    conflict: { code: string; path: string; expected: string; observed: string } | null;
  }[];
  document: string | null;
  source_digest: string | null;
  assessment_digest: string;
  applicable: boolean;
}

/** Resource-only evidence. No file absence, trusted native head or source authority. */
export interface CollectionResourceAssessment {
  scope: "resources";
  application_id: string;
  provision_digest: string;
  resource_inventory_digest: string;
  configuration_digest: string;
  configuration: ConfigurationAssessment;
  type_packs: Assessment[];
  applicable: boolean;
  assessment_digest: string;
}

/** Submit original guarded ops with ordinary explicit-path creates in ONE mutation. */
export interface CollectionResourceApplication {
  assessment: CollectionResourceAssessment;
  ops: PackOperation[];
}

/** Collection files by resource path (`mdbase.yaml`, `_types/task.md`, ...). */
export type Resources = Record<string, string>;
