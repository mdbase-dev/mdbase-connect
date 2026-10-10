/**
 * `mdbase`: the mdbase engine for JavaScript.
 *
 * This entry point is the **universal helpers**: pure functions over strings and
 * JSON that run anywhere WebAssembly runs (browsers, workers, Node, Deno, Bun).
 * They are the parts of the engine that apps use outside a collection runtime:
 *
 * - {@link contractDigest} and {@link implementationDigest}: the stable digests
 *   of spec 05A, byte-identical to the Rust engine and the conformance suite;
 * - {@link loadCatalog} and {@link getType}: `mdbase.yaml`, type files and
 *   contracts compiled into one catalog;
 * - {@link validateRecord} and {@link validateSchema}: single-record validation
 *   and plain JSON Schema (2020-12 profile) validation;
 * - {@link checkQuery}: spec 11 query validation;
 * - {@link loadPack}, {@link parseLock}, {@link assessTypePack},
 *   {@link applyTypePack}: transactional type packs.
 *
 * Every function is async because the engine loads lazily on first use; see
 * {@link init} to control where `mdbase-core.wasm` comes from. Every failure is an
 * {@link MdbaseError} with a stable `code` and a `help` line.
 *
 * Collections on disk (`Collection.open`, CRUD, queries, changes) live in
 * `mdbase/node`.
 *
 * @example
 * ```ts
 * import { contractDigest, loadCatalog } from "mdbase";
 *
 * const { digest } = await contractDigest(contractFileText);
 * const catalog = await loadCatalog({ "mdbase.yaml": config, "_types/task.md": task });
 * console.log(catalog.types.map((t) => t.name));
 * ```
 *
 * @packageDocumentation
 */

import { engine } from "./loader.js";
import type {
  Assessment,
  Catalog,
  CollectionResourceApplication,
  CollectionResourceAssessment,
  ConfigurationScalar,
  Contract,
  Implementation,
  Issue,
  Lock,
  Pack,
  PackApplication,
  Resources,
  ResourceSource,
  SchemaIssue,
  TypeDefinition,
} from "./types.js";

export { init, type WasmSource } from "./loader.js";
export { MdbaseError, type ErrorCode } from "./errors.js";
export type * from "./types.js";

/** This package's version. */
export const VERSION = "0.5.0-rc.1";

/** What the loaded engine reports about itself. */
export interface EngineInfo {
  /** ABI major of `mdbase-core.wasm`. */
  abi: number;
  /** The engine crate's version. */
  version: string;
  /** Replicated-semantics version `[major, minor]`. */
  sem: [number, number];
  /** Spec versions the catalog accepts (`0.3.0`). */
  spec_versions: string[];
}

/** Version information from the engine. */
export async function info(): Promise<EngineInfo> {
  const c = await engine();
  return c.call("info", {}) as EngineInfo;
}

/**
 * A contract document: either the file's text, or an object with the file text
 * (`source`) or the parsed frontmatter (`frontmatter`), its resource `path`, and
 * the `resources` that `ref` wrappers point at (by collection path).
 */
export type ContractInput =
  | string
  | { source: string; path?: string; resources?: Resources }
  | { frontmatter: Record<string, unknown>; path?: string; resources?: Resources };

/**
 * The stable digest of a data contract (spec 05A "Stable Digests"), plus the
 * contract's identity and resolved schemas.
 *
 * The digest is SHA-256 over the JCS form of `{kind, contract_type, id,
 * version, <schema members>, behavior?}` with every `ref` wrapper resolved. It
 * equals the Rust engine's and (for contracts without `+build` version metadata)
 * the old `@callumalpass/mdbase` `dataContractDigest`.
 *
 * @example
 * ```ts
 * const c = await contractDigest(await fs.readFile("_contracts/tasknotes.task.md", "utf8"));
 * c.digest; // "sha256:a49d2513…"
 * ```
 * @throws {MdbaseError} `invalid_data_contract` (and the spec's finer codes such
 * as `schema_ref_unresolved`) when the document is not a valid contract.
 */
export async function contractDigest(input: ContractInput): Promise<Contract> {
  const c = await engine();
  const arg = typeof input === "string" ? { source: input } : input;
  return c.call("contract_digest", arg) as Contract;
}

/** A contract or type file: its text (`source`) and resource `path`. */
export interface FileInput {
  source: string;
  /** Resource path; defaults to a file in the contracts or types folder. */
  path?: string;
}

/**
 * The digest of a type's implementation of a contract (spec 05A): it pins the
 * contract digest, the type's portable semantics and the binding.
 *
 * @throws {MdbaseError} `invalid_implementation` with the catalog issues in
 * `details` when the type does not implement the contract.
 */
export async function implementationDigest(input: {
  contract: FileInput;
  type: FileInput;
  resources?: Resources;
}): Promise<Implementation> {
  const c = await engine();
  return c.call("implementation_digest", input) as Implementation;
}

/**
 * Compile a catalog from collection resources: `mdbase.yaml`, every file in the
 * types folder and the contracts folder, keyed by resource path. Never throws
 * for invalid resources: `catalog.valid` is false and `catalog.issues` says why.
 *
 * On Node, `mdbase/node` has `loadCatalog(root)` that reads the files for you.
 */
export async function loadCatalog(resources: Resources): Promise<Catalog> {
  const c = await engine();
  return c.call("load_catalog", { resources }) as Catalog;
}

/** One type from {@link loadCatalog}, or `undefined` when the catalog has no such type. */
export async function getType(resources: Resources, name: string): Promise<TypeDefinition | undefined> {
  const cat = await loadCatalog(resources);
  return cat.types.find((t) => t.name === name);
}

/**
 * Single-record validation of one document against the catalog: membership,
 * frontmatter shape and every matched type's JSON Schema. Issue severity follows
 * `settings.validation` (with `off`, issues come back as warnings).
 */
export async function validateRecord(input: {
  resources: Resources;
  /** The record's collection path (`tasks/a.md`). */
  path: string;
  /** The file's text. */
  source: string;
}): Promise<{ issues: Issue[]; types: string[] }> {
  const c = await engine();
  return c.call("validate_record", input) as { issues: Issue[]; types: string[] };
}

/**
 * Validate `instance` against a JSON Schema document (the spec 06 2020-12
 * profile: local `$ref` only, regex-lite patterns, `date`/`time`/`date-time`
 * formats).
 *
 * @throws {MdbaseError} `invalid_schema` when the schema itself does not compile.
 */
export async function validateSchema(input: {
  schema: unknown;
  /** JSON Pointer to the schema inside `schema`; `""` (default) is the root. */
  entry?: string;
  instance: unknown;
}): Promise<{ valid: boolean; issues: SchemaIssue[] }> {
  const c = await engine();
  return c.call("validate_schema", input) as { valid: boolean; issues: SchemaIssue[] };
}

/**
 * Check a spec 11 query object. With `resources`, the query is also compiled
 * against that catalog (unknown types, bad `order_by` fields, ...).
 *
 * @throws {MdbaseError} `invalid_query` (or `invalid_timezone`,
 * `invalid_expression`, ...) with `location` naming the member.
 */
export async function checkQuery(
  query: Record<string, unknown>,
  resources?: Resources,
): Promise<{ valid: true; types: string[] }> {
  const c = await engine();
  return c.call("check_query", resources ? { query, resources } : { query }) as { valid: true; types: string[] };
}

/** A pack: its `mdbase-pack.yaml` text and its source files by pack-relative path. */
export interface PackInput {
  manifest: string;
  sources: Resources;
}

/**
 * Validate a pack manifest and its resources (digests, kinds, targets).
 * @throws {MdbaseError} `invalid_type_pack`.
 */
export async function loadPack(input: PackInput): Promise<Pack> {
  const c = await engine();
  return c.call("load_pack", input) as Pack;
}

/** Parse `mdbase.lock.yaml`. */
export async function parseLock(source: string): Promise<Lock> {
  const c = await engine();
  return c.call("parse_lock", { source }) as Lock;
}

/** Caller decisions for {@link assessTypePack} (spec 05A). */
export interface PackOptions {
  /** Stable reverse-domain installer identity (`dev.mdbase.cli`). Required. */
  installed_by: string;
  /** Canonical target → collection target. */
  target_overrides?: Record<string, string>;
  /** Unmanaged targets to adopt → their current `sha256:` digest. */
  adopt?: Record<string, string>;
  /** Seed targets intentionally left out. */
  preserve_seed_targets?: string[];
  allow_downgrade?: boolean;
}

/**
 * Assess a pack against a collection's resources without changing anything.
 * The result says what `applyTypePack` would do and carries the
 * `assessment_digest` that apply requires.
 */
export async function assessTypePack(input: {
  pack: PackInput;
  /** The collection's resources (`mdbase.yaml`, `mdbase.lock.yaml`, `_types/*`, `_contracts/*`). */
  resources: Resources;
  options: PackOptions;
}): Promise<Assessment> {
  const c = await engine();
  return c.call("assess_type_pack", {
    manifest: input.pack.manifest,
    sources: input.pack.sources,
    resources: input.resources,
    options: input.options,
  }) as Assessment;
}

/**
 * Re-assess at the current resources and, if nothing changed since
 * `expectedDigest` was computed, return the original guarded core `ops` plus
 * the exact files to write and delete. Submit `ops` as ONE atomic mutation
 * through the held SDK client to install the pack. Do not reconstruct intent
 * from writes/deletes: those snapshot diffs do not carry concurrency guards.
 *
 * @throws {MdbaseError} `concurrent_modification` when the resources changed
 * since the assessment; `type_pack_conflict` for user-modified targets.
 */
export async function applyTypePack(input: {
  pack: PackInput;
  resources: Resources;
  options: PackOptions;
  /** `assessment_digest` from {@link assessTypePack}. */
  expectedDigest: string;
}): Promise<PackApplication> {
  const c = await engine();
  return c.call("apply_type_pack", {
    manifest: input.pack.manifest,
    sources: input.pack.sources,
    resources: input.resources,
    options: input.options,
    expected_digest: input.expectedDigest,
  }) as PackApplication;
}

/** Strict requirements/provisions declaration decoded by Core, not an app-side planner. */
export interface CollectionSetup {
  application_id: string;
  declaration_digest: string;
  requirements?: {
    configuration?: { id: string; path: string; predicate: "contains"; value: ConfigurationScalar }[];
  };
  provisions?: {
    configuration?: { requirement: string; path: string; operation: "set_add"; value: ConfigurationScalar }[];
    type_packs?: { provision: PackInput; options: PackOptions }[];
  };
}

/**
 * Assess complete resource DATA only. This cannot certify ordinary-file absence,
 * a native head, or source-write capability. Missing/null inventories and duplicate
 * paths are rejected. Detailed component evidence comes directly from Core.
 */
export async function assessCollectionResources(input: {
  resources: ResourceSource[];
  setup: CollectionSetup;
}): Promise<CollectionResourceAssessment> {
  const c = await engine();
  return c.call("assess_collection_resources", input) as CollectionResourceAssessment;
}

/**
 * Re-assess exact resource DATA and return the original ordered guarded Core ops.
 * Append ordinary explicit-path creates and submit ONE immutable atomic mutation;
 * native head planning owns occupancy/validity. No retries, snapshot writes or lock
 * reconstruction. Read back native resources/records before activating capabilities.
 * @throws {MdbaseError} `concurrent_modification`, `collection_setup_conflict`.
 */
export async function applyCollectionResources(input: {
  resources: ResourceSource[];
  setup: CollectionSetup;
  expectedDigest: string;
}): Promise<CollectionResourceApplication> {
  const c = await engine();
  const { expectedDigest, ...data } = input;
  return c.call("apply_collection_resources", {
    ...data,
    expected_digest: expectedDigest,
  }) as CollectionResourceApplication;
}
