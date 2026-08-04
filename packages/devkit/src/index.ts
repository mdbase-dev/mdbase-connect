import { createHash } from "node:crypto";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { parseDocument } from "yaml";
import {
  MdbaseCollectionClient,
  connectError,
  type MdbaseCollectionTransport
} from "@mdbase-dev/connect";
import type {
  CollectionChange,
  CollectionChangesPage,
  CollectionDescription,
  CollectionOperation,
  JsonObject,
  MdbaseOperationEnvelope,
  RecordDocument,
  TypePackProvision
} from "@mdbase-dev/connect-protocol";
import {
  formatManifestValidationIssues,
  validateAppManifest,
  type ManifestValidationIssue,
  type ManifestValidationOptions,
  type ManifestValidationResult
} from "@mdbase-dev/connect-protocol/manifest";
import connectProblemSchema from "@mdbase-dev/connect-protocol/schemas/connect-problem.v1.schema.json" with { type: "json" };
import dataContractSchema from "@mdbase-dev/connect-protocol/schemas/data-contract.schema.json" with { type: "json" };
import connectProtocolSchema from "@mdbase-dev/connect-protocol/schemas/connect-protocol.v1.schema.json" with { type: "json" };
import filesSchema from "@mdbase-dev/connect-protocol/schemas/files.v1.schema.json" with { type: "json" };

export type ValidationIssue = ManifestValidationIssue;
export type ValidationResult = ManifestValidationResult;
export type { ManifestValidationOptions };
export { validateAppManifest };
export const formatValidationIssues = formatManifestValidationIssues;

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  // `required` may name properties declared by an enclosing allOf branch.
  strictRequired: false,
  formats: { "date-time": true, uri: true, uuid: true }
});
ajv.addSchema(connectProblemSchema);
ajv.addSchema(dataContractSchema);
ajv.addSchema(filesSchema);
ajv.addSchema(connectProtocolSchema);

const contractValidator = requiredValidator(String(dataContractSchema.$id));

export function validateDataContract(value: unknown): ValidationResult {
  return validationResult(contractValidator, value);
}

export function validateProtocolValue(value: unknown, definition?: string): ValidationResult {
  const reference = definition
    ? `${String(connectProtocolSchema.$id)}#/$defs/${definition}`
    : String(connectProtocolSchema.$id);
  return validationResult(requiredValidator(reference), value);
}

export interface DataContractDocument extends JsonObject {
  kind: "mdbase.contract";
  contract_type: "record" | "event" | "action";
  id: string;
  version: string;
}

export interface RecordDataContractDocument extends DataContractDocument {
  contract_type: "record";
  record_schema: JsonObject;
}

export interface EventDataContractDocument extends DataContractDocument {
  contract_type: "event";
  data_schema: JsonObject;
}

export interface ActionDataContractDocument extends DataContractDocument {
  contract_type: "action";
  input_schema: JsonObject;
}

export function defineDataContract<
  const Contract extends
    | RecordDataContractDocument
    | EventDataContractDocument
    | ActionDataContractDocument
>(
  contract: Contract
): Contract {
  const result = validateDataContract(contract);
  if (!result.valid) {
    throw new DataContractDefinitionError(result.issues);
  }
  return contract;
}

export class DataContractDefinitionError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super(`Invalid data contract: ${formatValidationIssues(issues)}`);
  }
}

export interface TypePackResourceInput {
  kind: "contract" | "type" | "schema";
  /** Managed resources evolve with the pack; seed resources become user-owned after creation. */
  mode: "managed" | "seed";
  source: string;
  /** Collection-relative install location. Defaults to `source`. */
  target?: string;
  /** Exact UTF-8 resource document included in the provision. */
  document: string;
}

export interface TypePackDefinition {
  id: string;
  version: string;
  name?: string;
  description?: string;
  resources: TypePackResourceInput[];
}

/**
 * Build a complete, digest-pinned type-pack provision from readable source
 * documents. This keeps application manifests reviewable without asking
 * developers to calculate SHA-256 values by hand.
 */
export function defineTypePack(definition: TypePackDefinition): TypePackProvision {
  const provides = definition.resources
    .map((resource, index) => ({ resource, index }))
    .filter(({ resource }) => resource.kind === "contract")
    .map(({ resource, index }) => {
      if (resource.mode !== "managed") {
        throw new TypePackDefinitionError([definitionIssue(
          `/resources/${index}/mode`,
          "contract_resource_mode",
          "contract resources must be managed so their declared version and digest can evolve with the pack"
        )]);
      }
      return exactContractReferenceFromDocument(resource.document, index);
    })
    .sort((left, right) =>
      left.id.localeCompare(right.id)
      || left.version.localeCompare(right.version)
      || left.digest.localeCompare(right.digest));
  const provision: TypePackProvision = {
    manifest: {
      kind: "mdbase.type-pack",
      id: definition.id,
      version: definition.version,
      ...(definition.name ? { name: definition.name } : {}),
      ...(definition.description ? { description: definition.description } : {}),
      resources: definition.resources.map(({ kind, mode, source, target = source, document }) => ({
        kind,
        mode,
        source,
        target,
        digest: `sha256:${createHash("sha256").update(document).digest("hex")}`
      }))
    },
    resources: definition.resources.map(({ source, document }) => ({ source, document })),
    provides
  };
  const result = validateProtocolValue(provision, "typePackProvision");
  if (!result.valid) throw new TypePackDefinitionError(result.issues);
  return provision;
}

function exactContractReferenceFromDocument(
  document: string,
  resourceIndex: number
): { id: string; version: string; digest: string } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(document)?.[1];
  if (frontmatter === undefined) {
    throw new TypePackDefinitionError([definitionIssue(
      `/resources/${resourceIndex}/document`,
      "contract_frontmatter",
      "contract resources must contain YAML frontmatter"
    )]);
  }
  const parsed = parseDocument(frontmatter, { uniqueKeys: true });
  if (parsed.errors.length > 0) {
    throw new TypePackDefinitionError([definitionIssue(
      `/resources/${resourceIndex}/document`,
      "contract_frontmatter",
      `contract frontmatter is invalid: ${parsed.errors[0]?.message ?? "unknown YAML error"}`
    )]);
  }
  const contract = parsed.toJS({ maxAliasCount: 0 }) as unknown;
  const validation = validateDataContract(contract);
  if (!validation.valid) throw new DataContractDefinitionError(validation.issues);
  const value = contract as Record<string, unknown>;
  return {
    id: String(value.id),
    version: String(value.version),
    digest: dataContractDigest(value)
  };
}

/** Compute the portable semantic digest of one validated, fully resolved contract. */
export function dataContractDigest(contract: Record<string, unknown>): string {
  const validation = validateDataContract(contract);
  if (!validation.valid) throw new DataContractDefinitionError(validation.issues);
  const contractType = String(contract.contract_type);
  const portable: Record<string, unknown> = {
    kind: contract.kind,
    contract_type: contract.contract_type,
    id: contract.id,
    version: contract.version
  };
  const schemaFields = contractType === "record"
    ? ["record_schema", "binding_schema"]
    : contractType === "event"
      ? ["data_schema", "source_schema"]
      : ["input_schema", "output_schema", "error_schema", "provider_schema"];
  for (const field of schemaFields) {
    const wrapper = contract[field];
    if (wrapper === undefined) continue;
    if (!isRecord(wrapper) || !("value" in wrapper)) {
      throw new DataContractDigestError(
        `${field} must be resolved to an inline JSON Schema before calculating a contract digest.`
      );
    }
    portable[field] = structuredClone(wrapper.value);
  }
  if (contractType === "action" && contract.behavior !== undefined) {
    portable.behavior = structuredClone(contract.behavior);
  }
  return `sha256:${createHash("sha256").update(canonicalJson(portable)).digest("hex")}`;
}

export class DataContractDigestError extends Error {}

export class TypePackDefinitionError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super(`Invalid type pack: ${formatValidationIssues(issues)}`);
  }
}

export interface SandboxRecord<Frontmatter extends JsonObject = JsonObject> {
  path: string;
  frontmatter?: Frontmatter;
  body?: string;
  types?: string[];
}

export interface SandboxOptions<Frontmatter extends JsonObject = JsonObject> {
  description?: Partial<CollectionDescription>;
  records?: SandboxRecord<Frontmatter>[];
}

interface StoredRecord<Frontmatter extends JsonObject> {
  path: string;
  frontmatter: Frontmatter;
  body: string;
  types: string[];
  revision: string;
}

export interface DeveloperSandbox<Frontmatter extends JsonObject = JsonObject> {
  client: MdbaseCollectionClient<Frontmatter>;
  transport: SandboxTransport<Frontmatter>;
}

/**
 * Build a deterministic, in-memory provider for frontend development.
 *
 * It intentionally implements the transport contract, CRUD preconditions,
 * defaults, type filtering, pagination, and change cursors. It rejects query
 * expression features so tests cannot silently rely on a non-conformant CEL
 * approximation; use a real connector for semantic integration tests.
 */
export function createSandbox<Frontmatter extends JsonObject = JsonObject>(
  options: SandboxOptions<Frontmatter> = {}
): DeveloperSandbox<Frontmatter> {
  const transport = new SandboxTransport(options);
  return { transport, client: new MdbaseCollectionClient(transport) };
}

export class SandboxTransport<Frontmatter extends JsonObject = JsonObject>
implements MdbaseCollectionTransport {
  private readonly records = new Map<string, StoredRecord<Frontmatter>>();
  private readonly events: CollectionChange[] = [];
  private revisionSequence = 0;
  readonly description: CollectionDescription;

  constructor(options: SandboxOptions<Frontmatter> = {}) {
    this.description = sandboxDescription(options.description);
    for (const record of options.records ?? []) this.seed(record);
    this.events.length = 0;
  }

  seed(record: SandboxRecord<Frontmatter>): void {
    assertSafePath(record.path);
    this.records.set(record.path, this.storedRecord({
      ...record,
      frontmatter: asObject(record.frontmatter) as Frontmatter
    }));
  }

  snapshot(): SandboxRecord<Frontmatter>[] {
    return [...this.records.values()]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((record) => ({
        path: record.path,
        frontmatter: clone(record.frontmatter),
        body: record.body,
        types: [...record.types]
      }));
  }

  async operation<Result>(operation: CollectionOperation, input: unknown): Promise<Result> {
    const object = asObject(input);
    let result: unknown;
    switch (operation) {
      case "describe": result = clone(this.description); break;
      case "changes": result = this.changes(object); break;
      case "read": result = this.read(object); break;
      case "query": result = this.query(object); break;
      case "validate": result = envelope({}); break;
      case "create": result = this.create(object); break;
      case "update": result = this.update(object); break;
      case "delete": result = this.delete(object); break;
      case "rename": result = this.rename(object); break;
      default: throw connectError("unsupported_operation", `Unsupported sandbox operation: ${operation}`);
    }
    return clone(result) as Result;
  }

  private changes(input: JsonObject): CollectionChangesPage {
    const current = this.events.length;
    if (input.after === undefined) {
      return { events: [], cursor: current, has_more: false, reset: false };
    }
    const after = integer(input.after, "after", 0);
    const limit = integer(input.limit ?? 200, "limit", 1);
    const available = this.events.filter((event) => event.cursor > after);
    const events = available.slice(0, limit);
    return {
      events,
      cursor: events.at(-1)?.cursor ?? after,
      has_more: available.length > events.length,
      reset: false
    };
  }

  private read(input: JsonObject): MdbaseOperationEnvelope<RecordDocument<Frontmatter>> {
    const path = string(input.path, "path");
    const record = this.records.get(path);
    if (!record) return invalid("file_not_found", `File not found: ${path}`, path);
    return envelope(this.recordResult(record));
  }

  private query(input: JsonObject): MdbaseOperationEnvelope<JsonObject> {
    if (input.where !== undefined || input.order_by !== undefined) {
      throw connectError(
        "sandbox_unsupported",
        "The in-memory sandbox does not emulate CEL or ordering. Run this test against a real connector."
      );
    }
    const types = Array.isArray(input.types)
      ? input.types.filter((value): value is string => typeof value === "string")
      : [];
    const all = [...this.records.values()]
      .filter((record) => types.length === 0 || record.types.some((type) => types.includes(type)))
      .sort((left, right) => left.path.localeCompare(right.path));
    const offset = integer(input.offset ?? 0, "offset", 0);
    const limit = integer(input.limit ?? all.length, "limit", 0);
    const selected = all.slice(offset, offset + limit).map((record) => {
      const document = this.recordResult(record);
      const result: JsonObject = {
        path: document.path,
        types: document.types,
        file: { ...document.file, path: document.path }
      };
      const mode = input.frontmatter_mode ?? "effective";
      if (mode === "persisted" || mode === "both") {
        result.frontmatter = document.frontmatter;
      }
      if (mode === "effective" || mode === "both") {
        result.effective_frontmatter = document.effective_frontmatter;
      }
      if (input.include_body !== true) delete result.body;
      else result.body = document.body;
      return result;
    });
    return envelope({
      results: selected,
      meta: {
        total_count: all.length,
        has_more: offset + selected.length < all.length
      }
    });
  }

  private create(input: JsonObject): MdbaseOperationEnvelope<RecordDocument<Frontmatter>> {
    const path = string(input.path, "path");
    assertSafePath(path);
    if (this.records.has(path)) return invalid("path_conflict", `File already exists: ${path}`, path);
    if (input.if_revision !== undefined) {
      return invalid("concurrent_modification", `File does not match the requested revision: ${path}`, path);
    }
    const frontmatter = asObject(input.frontmatter) as Frontmatter;
    const type = typeof input.type === "string" ? input.type.toLowerCase() : undefined;
    const record = this.storedRecord({
      path,
      frontmatter,
      body: typeof input.body === "string" ? input.body : "",
      types: type ? [type] : explicitTypes(frontmatter)
    });
    this.records.set(path, record);
    this.append("mdbase.record.created", record, { path, types: record.types });
    return envelope(this.recordResult(record));
  }

  private update(input: JsonObject): MdbaseOperationEnvelope<RecordDocument<Frontmatter>> {
    const path = string(input.path, "path");
    const current = this.records.get(path);
    if (!current) return invalid("file_not_found", `File not found: ${path}`, path);
    const revisionError = checkRevision(input, current);
    if (revisionError) return revisionError;
    const patch = asObject(input.patch ?? {});
    const frontmatter = clone(current.frontmatter) as JsonObject;
    for (const [field, value] of Object.entries(patch)) frontmatter[field] = clone(value);
    const record = this.storedRecord({
      path,
      frontmatter: frontmatter as Frontmatter,
      body: typeof input.body === "string" ? input.body : current.body,
      types: explicitTypes(frontmatter).length > 0 ? explicitTypes(frontmatter) : current.types
    });
    this.records.set(path, record);
    this.append("mdbase.record.modified", record, { path, types: record.types, changed_fields: Object.keys(patch) });
    return envelope(this.recordResult(record));
  }

  private delete(input: JsonObject): MdbaseOperationEnvelope<JsonObject> {
    const path = string(input.path, "path");
    const current = this.records.get(path);
    if (!current) return invalid("file_not_found", `File not found: ${path}`, path);
    const revisionError = checkRevision(input, current);
    if (revisionError) return revisionError;
    if (input.dry_run === true) {
      return envelope({
        path,
        deleted: false,
        dry_run: true,
        would_delete: true
      });
    }
    this.records.delete(path);
    this.append("mdbase.record.deleted", current, { path, types: current.types });
    return envelope({ path, deleted: true });
  }

  private rename(input: JsonObject): MdbaseOperationEnvelope<JsonObject> {
    const from = string(input.from, "from");
    const to = string(input.to, "to");
    assertSafePath(to);
    const current = this.records.get(from);
    if (!current) return invalid("file_not_found", `File not found: ${from}`, from);
    const revisionError = checkRevision(input, current);
    if (revisionError) return revisionError;
    if (this.records.has(to)) return invalid("path_conflict", `File already exists: ${to}`, to);
    if (input.dry_run === true) {
      return envelope({
        from,
        to,
        dry_run: true,
        would_rename: true
      });
    }
    this.records.delete(from);
    const record = this.storedRecord({ ...current, path: to });
    this.records.set(to, record);
    this.append("mdbase.record.renamed", record, { from, to, types: record.types });
    return envelope({ ...this.recordResult(record), from, to, references_updated: [] });
  }

  private storedRecord(
    record: SandboxRecord<Frontmatter> & { frontmatter: Frontmatter }
  ): StoredRecord<Frontmatter> {
    return {
      path: record.path,
      frontmatter: clone(record.frontmatter),
      body: record.body ?? "",
      types: [...(record.types ?? explicitTypes(record.frontmatter))],
      revision: `sandbox:${++this.revisionSequence}`
    };
  }

  private recordResult(record: StoredRecord<Frontmatter>): RecordDocument<Frontmatter> {
    const effective = clone(record.frontmatter) as JsonObject;
    for (const typeName of record.types) {
      const type = this.description.types.find((candidate) => candidate.name === typeName);
      const defaults = asObject(type?.collection?.read_defaults);
      for (const [field, value] of Object.entries(defaults)) {
        if (!(field in effective)) effective[field] = clone(value);
      }
    }
    return {
      path: record.path,
      frontmatter: clone(record.frontmatter),
      effective_frontmatter: effective as Frontmatter,
      body: record.body,
      types: [...record.types],
      revision: record.revision,
      file: sandboxFileMetadata(record)
    };
  }

  private append(type: string, record: StoredRecord<Frontmatter>, payload: JsonObject): void {
    const cursor = this.events.length + 1;
    this.events.push({
      cursor,
      type,
      occurred_at: new Date(cursor).toISOString(),
      payload: { ...clone(payload), revision: record.revision }
    });
  }
}

function sandboxFileMetadata<Frontmatter extends JsonObject>(
  record: StoredRecord<Frontmatter>
) {
  const segments = record.path.split("/");
  const name = segments.at(-1) ?? record.path;
  const folder = segments.slice(0, -1).join("/");
  const revision = Number(record.revision.split(":").at(-1) ?? 0);
  const serialized = `---\n${JSON.stringify(record.frontmatter)}\n---\n${record.body}`;
  return {
    name,
    folder,
    size: new TextEncoder().encode(serialized).byteLength,
    mtime: new Date(revision).toISOString()
  };
}

function requiredValidator(reference: string): ValidateFunction {
  const validate = ajv.getSchema(reference);
  if (!validate) throw new Error(`Canonical schema is unavailable: ${reference}`);
  return validate;
}

function validationResult(validate: ValidateFunction, value: unknown): ValidationResult {
  if (validate(value)) return { valid: true, issues: [] };
  return {
    valid: false,
    issues: (validate.errors ?? []).map(validationIssue)
  };
}

function validationIssue(error: ErrorObject): ValidationIssue {
  return {
    path: error.instancePath,
    keyword: error.keyword,
    message: error.message ?? "is invalid",
    params: error.params as Record<string, unknown>
  };
}

function definitionIssue(
  path: string,
  keyword: string,
  message: string
): ValidationIssue {
  return { path, keyword, message, params: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function sandboxDescription(value: Partial<CollectionDescription> = {}): CollectionDescription {
  return {
    protocol_version: 1,
    collection_id: value.collection_id ?? "01900000-0000-7000-8000-000000000001",
    display_name: value.display_name ?? "Developer sandbox",
    spec_version: value.spec_version ?? "0.3.0",
    operations: value.operations ?? ["describe", "changes", "read", "query", "list_views", "execute_view", "read_view_source", "validate", "create", "update", "delete", "rename", "create_view_source", "update_view_source", "delete_view_source", "read_type", "create_type", "update_type", "assess_type_pack", "apply_type_pack"],
    change_cursor: value.change_cursor ?? 0,
    types: clone(value.types ?? []),
    contracts: clone(value.contracts ?? [])
  };
}

function envelope<Result>(result: Result): MdbaseOperationEnvelope<Result & JsonObject> {
  return { valid: true, result: result as Result & JsonObject, diagnostics: [] };
}

function invalid<Result = never>(
  code: string,
  message: string,
  path?: string
): MdbaseOperationEnvelope<Result> {
  return {
    valid: false,
    result: {} as Result,
    diagnostics: [{ severity: "error", code, message, path }]
  };
}

function checkRevision(
  input: JsonObject,
  record: StoredRecord<JsonObject>
): MdbaseOperationEnvelope<never> | null {
  if (input.if_revision === undefined || input.if_revision === record.revision) return null;
  return invalid("concurrent_modification", `File does not match the requested revision: ${record.path}`, record.path);
}

function explicitTypes(frontmatter: JsonObject): string[] {
  const values = [frontmatter.type, frontmatter.types]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => value.toLowerCase());
  return [...new Set(values)];
}

function assertSafePath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) {
    throw connectError("invalid_path", `Unsafe sandbox path: ${path}`);
  }
}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw connectError("invalid_request", `${field} must be a non-empty string.`);
  }
  return value;
}

function integer(value: unknown, field: string, minimum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum) {
    throw connectError("invalid_request", `${field} must be an integer of at least ${minimum}.`);
  }
  return Number(value);
}

function clone<ValueType>(value: ValueType): ValueType {
  return structuredClone(value);
}
