import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import {
  MdbaseCollectionClient,
  MdbaseConnectError,
  type MdbaseCollectionTransport
} from "@mdbase/connect";
import type {
  CollectionChange,
  CollectionChangesPage,
  CollectionDescription,
  CollectionOperation,
  JsonObject,
  MdbaseOperationEnvelope,
  RecordResult
} from "@mdbase/connect-protocol";
import { isNativeRedirectUri } from "@mdbase/connect-protocol";
import appManifestSchema from "@mdbase/connect-protocol/schemas/mdbase-app.schema.json" with { type: "json" };
import contractExtensionSchema from "@mdbase/connect-protocol/schemas/contract-extension.v1.schema.json" with { type: "json" };
import connectProtocolSchema from "@mdbase/connect-protocol/schemas/connect-protocol.v2.schema.json" with { type: "json" };

export interface ValidationIssue {
  path: string;
  keyword: string;
  message: string;
  params: Record<string, unknown>;
}

export type ValidationResult =
  | { valid: true; issues: [] }
  | { valid: false; issues: ValidationIssue[] };

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  formats: { "date-time": true, uri: true }
});
ajv.addSchema(appManifestSchema);
ajv.addSchema(contractExtensionSchema);
ajv.addSchema(connectProtocolSchema);

const appManifestValidator = requiredValidator(String(appManifestSchema.$id));
const contractValidator = requiredValidator(String(contractExtensionSchema.$id));

export interface ManifestValidationOptions {
  /** Allow HTTP only for localhost/loopback developer manifests. */
  allowLocal?: boolean;
}

export function validateAppManifest(
  value: unknown,
  options: ManifestValidationOptions = {}
): ValidationResult {
  const candidate = options.allowLocal ? localManifestSchemaCandidate(value) : value;
  const schemaResult = validationResult(appManifestValidator, candidate);
  if (!schemaResult.valid) return schemaResult;
  const originResult = validateManifestOrigins(value, options.allowLocal === true);
  if (!originResult.valid) return originResult;
  return validateProvisionRequirements(value);
}

export function validateContractExtension(value: unknown): ValidationResult {
  return validationResult(contractValidator, value);
}

export function validateProtocolValue(value: unknown, definition?: string): ValidationResult {
  const reference = definition
    ? `${String(connectProtocolSchema.$id)}#/$defs/${definition}`
    : String(connectProtocolSchema.$id);
  return validationResult(requiredValidator(reference), value);
}

export interface ContractExtension extends JsonObject {
  contract: string;
  version: number;
}

export function defineContract<const Contract extends ContractExtension>(contract: Contract): Contract {
  const result = validateContractExtension(contract);
  if (!result.valid) {
    throw new ContractDefinitionError(result.issues);
  }
  return contract;
}

export class ContractDefinitionError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super(`Invalid contract extension: ${formatValidationIssues(issues)}`);
  }
}

export interface SandboxRecord<Frontmatter extends JsonObject = JsonObject> {
  path: string;
  frontmatter: Frontmatter;
  body?: string;
  types?: string[];
}

export interface SandboxOptions<Frontmatter extends JsonObject = JsonObject> {
  description?: Partial<CollectionDescription>;
  records?: SandboxRecord<Frontmatter>[];
}

interface StoredRecord<Frontmatter extends JsonObject> extends SandboxRecord<Frontmatter> {
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
    this.records.set(record.path, this.storedRecord(record));
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
      default: throw new MdbaseConnectError("unsupported_operation", `Unsupported sandbox operation: ${operation}`);
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

  private read(input: JsonObject): MdbaseOperationEnvelope<RecordResult<Frontmatter>> {
    const path = string(input.path, "path");
    const record = this.records.get(path);
    if (!record) return invalid("file_not_found", `File not found: ${path}`, path);
    return envelope(this.recordResult(record));
  }

  private query(input: JsonObject): MdbaseOperationEnvelope<JsonObject> {
    if (input.where !== undefined || input.order_by !== undefined) {
      throw new MdbaseConnectError(
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
      const result = this.recordResult(record) as RecordResult<Frontmatter> & JsonObject;
      if (input.include_body !== true) delete result.body;
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

  private create(input: JsonObject): MdbaseOperationEnvelope<RecordResult<Frontmatter>> {
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

  private update(input: JsonObject): MdbaseOperationEnvelope<RecordResult<Frontmatter>> {
    const path = string(input.path, "path");
    const current = this.records.get(path);
    if (!current) return invalid("file_not_found", `File not found: ${path}`, path);
    const revisionError = checkRevision(input, current);
    if (revisionError) return revisionError;
    const patch = asObject(input.patch ?? input.fields ?? {});
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
    this.append("mdbase.record.deleted", current, { path, previous_types: current.types });
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

  private storedRecord(record: SandboxRecord<Frontmatter>): StoredRecord<Frontmatter> {
    return {
      path: record.path,
      frontmatter: clone(record.frontmatter),
      body: record.body ?? "",
      types: [...(record.types ?? explicitTypes(record.frontmatter))],
      revision: `sandbox:${++this.revisionSequence}`
    };
  }

  private recordResult(record: StoredRecord<Frontmatter>): RecordResult<Frontmatter> {
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
      frontmatter: effective as Frontmatter,
      raw_frontmatter: clone(record.frontmatter),
      body: record.body,
      types: [...record.types],
      revision: record.revision
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

export function formatValidationIssues(issues: ValidationIssue[]): string {
  return issues.map((issue) => `${issue.path || "/"} ${issue.message}`).join("; ");
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

function validateManifestOrigins(value: unknown, allowLocal: boolean): ValidationResult {
  const manifest = asObject(value);
  try {
    const homepage = new URL(String(manifest.homepage));
    if (!secureOrAllowedLocal(homepage, allowLocal)) {
      return semanticIssue("/homepage", "must use HTTPS (or loopback HTTP in local mode)");
    }
    for (const [index, redirect] of (manifest.redirect_uris as unknown[]).entries()) {
      const url = new URL(String(redirect));
      if (url.origin === homepage.origin && !secureOrAllowedLocal(url, allowLocal)) {
        return semanticIssue(`/redirect_uris/${index}`, "must use HTTPS (or loopback HTTP in local mode)");
      }
      if (url.origin !== homepage.origin && !isNativeRedirectUri(url, homepage.hostname)) {
        return semanticIssue(
          `/redirect_uris/${index}`,
          "must use the homepage origin or a publisher-bound private-use application scheme"
        );
      }
    }
    if (manifest.icon !== undefined && new URL(String(manifest.icon)).origin !== homepage.origin) {
      return semanticIssue("/icon", "must use the homepage origin");
    }
    return { valid: true, issues: [] };
  } catch {
    return semanticIssue("/", "contains an invalid URL");
  }
}

function validateProvisionRequirements(value: unknown): ValidationResult {
  const manifest = asObject(value);
  const requirements = asObject(manifest.requirements);
  const requiredContracts = Array.isArray(requirements.contracts) ? requirements.contracts : [];
  const required = new Set(requiredContracts.map((contract) => {
    const value = asObject(contract);
    return `${value.id}@${value.version}`;
  }));
  const provisions = asObject(manifest.provisions);
  const types = Array.isArray(provisions.types) ? provisions.types : [];
  for (const [typeIndex, provisionValue] of types.entries()) {
    const provision = asObject(provisionValue);
    for (const providedValue of provision.provides as unknown[]) {
      const provided = asObject(providedValue);
      if (!required.has(`${provided.id}@${provided.version}`)) {
        return semanticIssue(
          `/provisions/types/${typeIndex}/provides`,
          "may only contain contracts required by the application"
        );
      }
    }
  }
  return { valid: true, issues: [] };
}

function localManifestSchemaCandidate(value: unknown): unknown {
  const candidate = clone(value);
  const object = asObject(candidate);
  for (const field of ["homepage", "icon"] as const) {
    if (typeof object[field] === "string") object[field] = schemaSafeLocalUrl(object[field]);
  }
  if (Array.isArray(object.redirect_uris)) {
    object.redirect_uris = object.redirect_uris.map((url) =>
      typeof url === "string" ? schemaSafeLocalUrl(url) : url
    );
  }
  return candidate;
}

function schemaSafeLocalUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" && isLoopback(url.hostname)) url.protocol = "https:";
    return url.href;
  } catch {
    return value;
  }
}

function secureOrAllowedLocal(url: URL, allowLocal: boolean): boolean {
  return url.protocol === "https:"
    || (allowLocal && url.protocol === "http:" && isLoopback(url.hostname));
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function semanticIssue(path: string, message: string): ValidationResult {
  return {
    valid: false,
    issues: [{ path, keyword: "semantic", message, params: {} }]
  };
}

function sandboxDescription(value: Partial<CollectionDescription> = {}): CollectionDescription {
  return {
    protocol_version: 2,
    collection_id: value.collection_id ?? "01900000-0000-7000-8000-000000000001",
    display_name: value.display_name ?? "Developer sandbox",
    spec_version: value.spec_version ?? "0.3.0",
    operations: value.operations ?? ["describe", "changes", "read", "query", "validate", "create", "update", "delete", "rename", "read_type", "create_type", "update_type"],
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
    throw new MdbaseConnectError("invalid_path", `Unsafe sandbox path: ${path}`);
  }
}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new MdbaseConnectError("invalid_request", `${field} must be a non-empty string.`);
  }
  return value;
}

function integer(value: unknown, field: string, minimum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum) {
    throw new MdbaseConnectError("invalid_request", `${field} must be an integer of at least ${minimum}.`);
  }
  return Number(value);
}

function clone<ValueType>(value: ValueType): ValueType {
  return structuredClone(value);
}
