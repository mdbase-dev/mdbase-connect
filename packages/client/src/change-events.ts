import {
  CHANGE_EVENT_KINDS,
  type CollectionChange as WireChange,
  type CollectionChangesPage as WirePage,
  type JsonObject,
  type RecordChangePayload,
  type ResourceChangePayload,
  type FileChangePayload
} from "@mdbase-dev/connect-protocol";
import type { CollectionChange, CollectionChangesPage, RecordChangeMetadata } from "./operation-types.js";
import { clientFileDescriptor } from "./file-descriptor.js";

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
    return clientFileDescriptorIsValid(p.file)
      ? { ...base, kind, file: clientFileDescriptor(p.file) }
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

export function normalizeChangesPage(raw: WirePage): CollectionChangesPage {
  return {
    events: raw.reset ? [{ kind: "reset", type: "reset", cursor: raw.cursor, occurredAt: null, payload: {}, raw }] : raw.events.map(normalizeCollectionChange),
    cursor: raw.cursor,
    hasMore: raw.has_more,
    reset: raw.reset
  };
}

export function invalidatesDescription(change: CollectionChange): boolean {
  return change.kind === "schema.changed" || change.kind === "config.changed"
    || change.kind === "contract.changed" || change.kind === "view.changed"
    || change.kind === "gap" || change.kind === "reset" || change.kind === "unknown";
}

function string(value: unknown): value is string { return typeof value === "string"; }
function boolean(value: unknown): value is boolean { return typeof value === "boolean"; }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(string); }
function object(value: unknown): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
function validFields(value: JsonObject, fields: [string, (value: unknown) => boolean][]): boolean {
  return fields.every(([key, valid]) => value[key] == null || valid(value[key]));
}
function clientFileDescriptorIsValid(value: unknown): value is import("@mdbase-dev/connect-protocol").CollectionFileDescriptor {
  return object(value) && string(value.file_id) && string(value.path) && string(value.revision)
    && string(value.content_digest) && value.content_digest.startsWith("sha256:")
    && typeof value.size === "number" && Number.isSafeInteger(value.size) && value.size >= 0
    && ["image", "audio", "video", "pdf", "other"].includes(value.media_class as string)
    && string(value.modified_at) && (value.media_type == null || string(value.media_type));
}
