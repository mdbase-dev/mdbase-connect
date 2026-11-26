import {
  CHANGE_EVENT_KINDS,
  type CollectionChange as WireChange,
  type CollectionFileDescriptor as WireFile,
  type FileChangePayload,
  type FileMediaClass,
  type JsonObject,
  type RecordChangePayload,
  type ResourceChangePayload
} from "@mdbase-dev/connect-protocol";

const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

export interface CollectionFileDescriptor {
  fileId: string;
  path: string;
  revision: string;
  contentDigest: `sha256:${string}`;
  size: number;
  mediaType?: string;
  mediaClass: FileMediaClass;
  modifiedAt: string;
}

interface ChangeBase {
  cursor: number;
  type: string;
  occurredAt: string;
  payload: JsonObject;
  raw: WireChange;
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
  | (ChangeBase & { kind: "unknown"; reason: "unrecognized_type" | "invalid_payload" });

const RECORD_FIELDS = Object.entries({
  path: string, from: string, to: string, revision: string, previous_revision: string,
  types: strings, previous_types: strings, changed_fields: strings, body_changed: boolean,
  before: object, after: object
});
const RESOURCE_FIELDS = Object.entries({ path: string, name: string, revision: string, previous_revision: string, reason: string });
const REMOVED_FILE_FIELDS = Object.entries({ previous_path: string, revision: string });

/** Normalize authority events once, without inferring metadata missing on older authorities. */
export function normalizeCollectionChange(raw: WireChange): CollectionChange {
  const base = { cursor: raw.cursor, type: raw.type, occurredAt: raw.occurred_at, payload: raw.payload, raw };
  const unknown = (reason: "unrecognized_type" | "invalid_payload"): CollectionChange => ({ ...base, kind: "unknown", reason });
  const kind = Object.hasOwn(CHANGE_EVENT_KINDS, raw.type)
    ? CHANGE_EVENT_KINDS[raw.type as keyof typeof CHANGE_EVENT_KINDS]
    : undefined;
  if (!kind) return unknown("unrecognized_type");
  const p = raw.payload;
  if (!object(p)) return unknown("invalid_payload");
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
      return string(p.from) && string(p.to)
        ? { ...base, ...metadata, kind, from: p.from, to: p.to }
        : unknown("invalid_payload");
    }
    if (kind === "record.created" || kind === "record.updated" || kind === "record.deleted") {
      return string(p.path) ? { ...base, ...metadata, kind, path: p.path } : unknown("invalid_payload");
    }
  }
  if (kind === "file.put") {
    return validFileDescriptor(p.file)
      ? { ...base, kind, file: toFileDescriptor(p.file) }
      : unknown("invalid_payload");
  }
  if (kind === "file.removed") {
    if (!string(p.file_id) || !validFields(p, REMOVED_FILE_FIELDS)) return unknown("invalid_payload");
    const data: FileChangePayload = p;
    return { ...base, kind, fileId: p.file_id,
      ...(data.previous_path == null ? {} : { previousPath: data.previous_path }),
      ...(data.revision == null ? {} : { revision: data.revision }) };
  }
  if (!validFields(p, RESOURCE_FIELDS)) return unknown("invalid_payload");
  const data: ResourceChangePayload = p;
  if (kind === "gap") return { ...base, kind, ...(data.reason == null ? {} : { reason: data.reason }) };
  const metadata = {
    ...(data.revision == null ? {} : { revision: data.revision }),
    ...(data.previous_revision == null ? {} : { previousRevision: data.previous_revision })
  };
  if (kind === "file.changed") return string(p.path) ? { ...base, ...metadata, kind, path: p.path } : unknown("invalid_payload");
  if (kind === "schema.changed" || kind === "config.changed" || kind === "contract.changed" || kind === "view.changed") {
    return { ...base, ...metadata, kind,
      ...(data.path == null ? {} : { path: data.path }),
      ...(data.name == null ? {} : { name: data.name }) };
  }
  throw new Error(`Unhandled change kind: ${kind}`);
}

function validFileDescriptor(value: unknown): value is WireFile {
  if (!value || typeof value !== "object") return false;
  const file = value as WireFile;
  return typeof file.file_id === "string" && FILE_ID.test(file.file_id)
    && typeof file.path === "string" && typeof file.revision === "string"
    && typeof file.content_digest === "string" && SHA256_DIGEST.test(file.content_digest)
    && Number.isSafeInteger(file.size) && file.size >= 0
    && ["image", "audio", "video", "pdf", "other"].includes(file.media_class)
    && typeof file.modified_at === "string" && (file.media_type === undefined || typeof file.media_type === "string");
}

function toFileDescriptor(file: WireFile): CollectionFileDescriptor {
  return {
    fileId: file.file_id,
    path: file.path,
    revision: file.revision,
    contentDigest: file.content_digest,
    size: file.size,
    ...(file.media_type ? { mediaType: file.media_type } : {}),
    mediaClass: file.media_class,
    modifiedAt: file.modified_at
  };
}

function string(value: unknown): value is string { return typeof value === "string"; }
function boolean(value: unknown): value is boolean { return typeof value === "boolean"; }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(string); }
function object(value: unknown): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
function validFields(value: JsonObject, fields: [string, (value: unknown) => boolean][]): boolean {
  return fields.every(([key, valid]) => value[key] == null || valid(value[key]));
}
