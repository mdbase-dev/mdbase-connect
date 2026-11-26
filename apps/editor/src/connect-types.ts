import {
  CHANGE_EVENT_KINDS,
  MdbaseConnectError,
  connectError,
  connectProblem,
  type CollectionChange as WireCollectionChange,
  type CollectionChangesPage as WireCollectionChangesPage,
  type CollectionFileDescriptor as WireFileDescriptor,
  type CollectionOperation,
  type ConnectProblem,
  type ConnectProblemCode,
  type ContractRequirement,
  type FileChangePayload,
  type JsonObject,
  type KnownConnectProblem,
  type MdbaseDiagnostic,
  type MutationOperationIdentifier,
  type RecordChangePayload,
  type ResourceChangePayload,
  type TypePackProvision
} from "@mdbase-dev/connect-protocol";
import {
  PERSON_CONTRACT,
  sameIdentity,
  type AccountIdentity,
  type AccountProfile,
  type PeopleDirectory,
  type PersonRecord,
  type PersonResolution
} from "@mdbase-dev/sdk";

export {
  MdbaseConnectError,
  PERSON_CONTRACT,
  connectError,
  connectProblem,
  sameIdentity
};
export type {
  AccountIdentity,
  AccountProfile,
  CollectionOperation,
  ConnectProblem,
  ConnectProblemCode,
  JsonObject,
  KnownConnectProblem,
  MdbaseDiagnostic,
  PeopleDirectory,
  PersonRecord,
  PersonResolution,
  TypePackProvision
};

export interface MdbaseRecordChange {
  body?: string;
  patch?: JsonObject;
}

export interface ConnectSuccess<Value> {
  ok: true;
  value: Value;
}

export interface ConnectFailure<Code extends ConnectProblemCode = ConnectProblemCode> {
  ok: false;
  problem: ConnectProblem<Code>;
}

export type ConnectOutcome<Value, Code extends ConnectProblemCode = ConnectProblemCode> =
  | ConnectSuccess<Value>
  | ConnectFailure<Code>;

export function connectSuccess<Value>(value: Value): ConnectSuccess<Value> {
  return { ok: true, value };
}

export function connectFailure<Code extends ConnectProblemCode = ConnectProblemCode>(
  problem: ConnectProblem<Code>
): ConnectFailure<Code> {
  return { ok: false, problem };
}

export interface ConnectRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number | null;
}

export interface DescribeOptions extends ConnectRequestOptions {
  fresh?: boolean;
}

export type DirectAccessStatus =
  | "disabled"
  | "permission_required"
  | "checking"
  | "available"
  | "unavailable"
  | "denied";

export type MdbaseUnavailableReason =
  | "not_authorized"
  | "authorization_lost"
  | "revoked"
  | "paused"
  | "offline"
  | "removed"
  | "unknown";

export type MdbaseFileSource = Blob | ArrayBuffer | Uint8Array;

export interface MdbaseFileProgress {
  phase: "hashing" | "uploading" | "downloading";
  transferredBytes: number;
  totalBytes: number;
}

export interface CollectionFileDescriptor {
  fileId: string;
  path: string;
  revision: string;
  contentDigest: `sha256:${string}`;
  size: number;
  mediaClass: string;
  mediaType?: string;
  modifiedAt: string;
}

export interface DataContractSelector {
  id: string;
  version: string;
  type?: string;
}

export interface CollectionFileMetadata extends JsonObject {
  name: string;
  folder: string;
  size: number;
  mtime: string;
  tags?: string[];
  links?: unknown[];
  embeds?: unknown[];
}

export interface DataContractViewIdentity {
  id: string;
  version: string;
  digest: string;
  type: string;
  implementationDigest: string;
}

export interface QueryRecord<Frontmatter extends JsonObject = JsonObject> {
  path: string;
  revision?: string;
  frontmatter?: Frontmatter;
  effectiveFrontmatter?: Frontmatter;
  body?: string;
  types: string[];
  file: Partial<CollectionFileMetadata> & { path?: string };
  values?: JsonObject;
  contract?: DataContractViewIdentity;
}

export interface RecordDocument<Frontmatter extends JsonObject = JsonObject> {
  path: string;
  revision: string;
  types: string[];
  frontmatter: Frontmatter;
  effectiveFrontmatter: Frontmatter;
  body?: string;
  document?: string;
  file: Partial<CollectionFileMetadata> & { path?: string };
  contract?: DataContractViewIdentity;
}

export interface CollectionTypeDescriptor {
  name: string;
  version?: number;
  description?: string;
  revision?: string;
  path?: string;
  definition?: JsonObject;
  schema: JsonObject;
  collection?: JsonObject;
  lifecycle?: JsonObject;
  extensions: Record<string, unknown>;
}

export interface CollectionTypeDocument {
  name: string;
  path: string;
  revision: string;
  document: string;
}

export interface CollectionContractImplementationDescriptor {
  typeName: string;
  typeVersion: number;
  typePath?: string;
  digest: string;
  fields: Record<string, string>;
  binding?: JsonObject;
}

export interface CollectionContractDescriptor {
  contractType: "record";
  id: string;
  version: string;
  digest: string;
  schema: JsonObject;
  bindingSchema?: JsonObject;
  implementations: CollectionContractImplementationDescriptor[];
}

export interface CollectionDescription {
  authorityCapabilities?: readonly string[];
  protocolVersion: 1;
  collectionId: string;
  displayName: string;
  specVersion: string;
  operations: CollectionOperation[];
  changeCursor: number;
  types: CollectionTypeDescriptor[];
  contracts: CollectionContractDescriptor[];
  configuration?: JsonObject;
}

export interface QueryResult<Record extends JsonObject = JsonObject, Row = QueryRecord<Record>> {
  results: Row[];
  meta?: {
    totalCount?: number;
    hasMore: boolean;
    cursor?: string;
    snapshot?: string;
  };
}

export interface QueryPage<Record extends JsonObject = JsonObject, Row = QueryRecord<Record>> {
  results: QueryResult<Record, Row>["results"];
  meta?: QueryResult<Record>["meta"];
  page: number;
  offset: number;
  loaded: number;
  complete: boolean;
  cursor?: string;
  snapshot?: string;
}

export interface MutationEstimate {
  affectedRecords: number;
  totalUnits: number;
  warnings: number;
}

export type MutationProgressState = "preflighting" | "ready" | "applying" | "completed" | "cancelled";

export interface MutationProgress {
  operation: "rename" | "delete";
  state: MutationProgressState;
  elapsedMs: number;
  cancellable: boolean;
  resumed: boolean;
  completedUnits: number;
  estimate?: MutationEstimate;
}

export interface PendingMutationSummary {
  requestId: string;
  operation: MutationOperationIdentifier;
  fingerprint: string;
  status: "pending" | "recovering" | "outcome_unknown";
  createdAt: string;
}

export interface DeletePreflightResult {
  path: string;
  deleted: false;
  dryRun: true;
  wouldDelete: true;
  brokenLinks?: Array<{ path: string }>;
}

export interface RenamePreflightResult {
  from: string;
  to: string;
  dryRun: true;
  wouldRename: true;
  referencesAffected?: Array<{ path: string; field?: string; location?: string }>;
  warnings?: Array<{ path: string; message: string }>;
}

export type ContractSetupChoice =
  | { contract: ContractRequirement; mode: "starter" }
  | {
      contract: ContractRequirement;
      mode: "existing";
      typeName: string;
      typeRevision: string;
      fields: Record<string, string>;
      binding?: Record<string, unknown>;
    };

export interface TypePackResourceDiff {
  source: string;
  target: string;
  kind: "contract" | "type" | "schema";
  mode: "managed" | "seed";
  action: "create" | "update" | "delete" | "adopt" | "unchanged" | "preserve" | "conflict";
  digest: string;
  currentDigest?: string;
  installedDigest?: string;
  adoptedFromDigest?: string;
  upgradeBaseline?: { digest: string; version?: number };
  reason?: string;
}

export interface TypePackReceipt {
  id: string;
  version: string;
  digest: string;
  installedBy: string;
  resources: Array<Omit<TypePackResourceDiff, "action" | "currentDigest" | "installedDigest" | "upgradeBaseline" | "reason"> & {
    originDigest?: string;
  }>;
}

export interface TypePackAssessment {
  status: "current" | "install" | "upgrade" | "downgrade" | "reconfigure" | "conflict";
  applicable: boolean;
  assessmentDigest: string;
  current?: TypePackReceipt;
  desired: TypePackReceipt;
  resources: TypePackResourceDiff[];
  lock: { target: "mdbase.lock.yaml"; action: "create" | "update" | "unchanged"; digest: string };
  contractSetups: { choices: ContractSetupChoice[]; resources: TypePackResourceDiff[] };
}

export interface TypePackApplyResult extends TypePackAssessment {
  receipt: TypePackReceipt;
  cleanupDeferred: boolean;
}

export type WatchStatus =
  | { state: "connecting"; cursor?: number }
  | { state: "connected"; cursor: number; recovered: boolean }
  | { state: "reconnecting"; cursor?: number; attempt: number; retryInMs: number; problem: ConnectProblem }
  | { state: "reset_required"; cursor: number; problem: ConnectProblem<"change_cursor_reset"> }
  | { state: "closed"; cursor?: number };

export interface ObserveOptions {
  mode?: "watch" | "manual";
  invalidation?: "paths" | "collection";
  signal?: AbortSignal;
  firstPageSize?: number;
  pageSize?: number;
  coalesceMs?: number;
  maxPendingPaths?: number;
}

interface ChangeBase {
  cursor: number;
  type: string;
  occurredAt: string;
  payload: JsonObject;
  raw: WireCollectionChange;
}

export interface RecordChangeMetadata {
  revision?: string;
  previousRevision?: string;
  types?: string[];
  previousTypes?: string[];
  changedFields?: string[];
  bodyChanged?: boolean;
  before?: JsonObject;
  after?: JsonObject;
}

interface ResourceChangeBase extends ChangeBase {
  path?: string;
  name?: string;
  revision?: string;
  previousRevision?: string;
}

export type CollectionChange =
  | (ChangeBase & RecordChangeMetadata & { kind: "record.created"; path: string })
  | (ChangeBase & RecordChangeMetadata & { kind: "record.updated"; path: string })
  | (ChangeBase & RecordChangeMetadata & { kind: "record.deleted"; path: string })
  | (ChangeBase & RecordChangeMetadata & { kind: "record.renamed"; from: string; to: string })
  | (ResourceChangeBase & { kind: "schema.changed" })
  | (ResourceChangeBase & { kind: "config.changed" })
  | (ResourceChangeBase & { kind: "contract.changed" })
  | (ResourceChangeBase & { kind: "view.changed" })
  | (ChangeBase & { kind: "file.changed"; path: string; revision?: string; previousRevision?: string })
  | (ChangeBase & { kind: "file.put"; file: CollectionFileDescriptor })
  | (ChangeBase & { kind: "file.removed"; fileId: string; previousPath?: string; revision?: string })
  | (ChangeBase & { kind: "gap"; reason?: string })
  | (ChangeBase & { kind: "unknown"; reason: "unrecognized_type" | "invalid_payload" })
  | { kind: "reset"; cursor: number; type: "reset"; occurredAt: null; payload: JsonObject; raw: WireCollectionChangesPage };

const RECORD_FIELDS = Object.entries({
  path: isString, from: isString, to: isString, revision: isString, previous_revision: isString,
  types: isStrings, previous_types: isStrings, changed_fields: isStrings, body_changed: isBoolean,
  before: isObject, after: isObject
});
const RESOURCE_FIELDS = Object.entries({ path: isString, name: isString, revision: isString, previous_revision: isString, reason: isString });
const REMOVED_FILE_FIELDS = Object.entries({ previous_path: isString, revision: isString });

export function normalizeCollectionChange(raw: WireCollectionChange): CollectionChange {
  const base = { cursor: raw.cursor, type: raw.type, occurredAt: raw.occurred_at, payload: raw.payload, raw };
  const unknown = (reason: "unrecognized_type" | "invalid_payload"): CollectionChange => ({ ...base, kind: "unknown", reason });
  const kind = Object.hasOwn(CHANGE_EVENT_KINDS, raw.type)
    ? CHANGE_EVENT_KINDS[raw.type as keyof typeof CHANGE_EVENT_KINDS]
    : undefined;
  if (!kind) return unknown("unrecognized_type");
  const p = raw.payload;
  if (!isObject(p)) return unknown("invalid_payload");
  if (kind.startsWith("record.")) {
    if (!validFields(p, RECORD_FIELDS)) return unknown("invalid_payload");
    const data: RecordChangePayload = p;
    const metadata: RecordChangeMetadata = {
      ...(data.revision == null ? {} : { revision: data.revision }),
      ...(data.previous_revision == null ? {} : { previousRevision: data.previous_revision }),
      ...(data.types == null ? {} : { types: data.types }),
      ...(data.previous_types == null ? {} : { previousTypes: data.previous_types }),
      ...(data.changed_fields == null ? {} : { changedFields: data.changed_fields }),
      ...(data.body_changed == null ? {} : { bodyChanged: data.body_changed }),
      ...(data.before == null ? {} : { before: data.before }),
      ...(data.after == null ? {} : { after: data.after })
    };
    if (kind === "record.renamed") {
      return isString(p.from) && isString(p.to)
        ? { ...base, ...metadata, kind, from: p.from, to: p.to }
        : unknown("invalid_payload");
    }
    if (kind === "record.created" || kind === "record.updated" || kind === "record.deleted") {
      return isString(p.path) ? { ...base, ...metadata, kind, path: p.path } : unknown("invalid_payload");
    }
  }
  if (kind === "file.put") {
    return isWireFileDescriptor(p.file)
      ? { ...base, kind, file: toClientFileDescriptor(p.file) }
      : unknown("invalid_payload");
  }
  if (kind === "file.removed") {
    if (!isString(p.file_id) || !validFields(p, REMOVED_FILE_FIELDS)) return unknown("invalid_payload");
    const data: FileChangePayload = p;
    return {
      ...base,
      kind,
      fileId: p.file_id,
      ...(data.previous_path == null ? {} : { previousPath: data.previous_path }),
      ...(data.revision == null ? {} : { revision: data.revision })
    };
  }
  if (!validFields(p, RESOURCE_FIELDS)) return unknown("invalid_payload");
  const data: ResourceChangePayload = p;
  if (kind === "gap") return { ...base, kind, ...(data.reason == null ? {} : { reason: data.reason }) };
  const metadata = {
    ...(data.revision == null ? {} : { revision: data.revision }),
    ...(data.previous_revision == null ? {} : { previousRevision: data.previous_revision })
  };
  if (kind === "file.changed") return isString(p.path) ? { ...base, ...metadata, kind, path: p.path } : unknown("invalid_payload");
  if (kind === "schema.changed" || kind === "config.changed" || kind === "contract.changed" || kind === "view.changed") {
    return {
      ...base,
      ...metadata,
      kind,
      ...(data.path == null ? {} : { path: data.path }),
      ...(data.name == null ? {} : { name: data.name })
    };
  }
  return unknown("unrecognized_type");
}

function isString(value: unknown): value is string { return typeof value === "string"; }
function isBoolean(value: unknown): value is boolean { return typeof value === "boolean"; }
function isStrings(value: unknown): value is string[] { return Array.isArray(value) && value.every(isString); }
function isObject(value: unknown): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
function validFields(value: JsonObject, fields: [string, (value: unknown) => boolean][]): boolean {
  return fields.every(([key, valid]) => value[key] == null || valid(value[key]));
}
function isWireFileDescriptor(value: unknown): value is WireFileDescriptor {
  if (!isObject(value)) return false;
  return isString(value.file_id) && isString(value.path) && isString(value.revision)
    && isString(value.content_digest) && typeof value.size === "number"
    && isString(value.media_class) && isString(value.modified_at);
}
function toClientFileDescriptor(file: WireFileDescriptor): CollectionFileDescriptor {
  return {
    fileId: file.file_id,
    path: file.path,
    revision: file.revision,
    contentDigest: file.content_digest as `sha256:${string}`,
    size: file.size,
    mediaClass: file.media_class,
    ...(file.media_type === undefined ? {} : { mediaType: file.media_type }),
    modifiedAt: file.modified_at
  };
}
