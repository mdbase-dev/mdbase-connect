/** Shared saved-view source writes, using ordinary record intents and receipts.
 * No renderer/type-pack assumptions, YAML rewriting, implicit reads or retries. */
import type {CreateInput, MdbaseClient, RecordRef, Write, WriteOptions} from "./client.js";
import {hash, uuid} from "./codec.js";
import {mdbaseError} from "./errors.js";
import {revisionOf} from "./values.js";
import type {Include, RecordView, Uuid} from "./wire.js";

/** Capture identities once, before the first submission; retain them on unknown.
 * The helper never generates a replacement record or mutation identity. */
export interface ViewSourceCreateInput {
  id: Uuid;
  path: string;
  document: string;
  /** Optional manifest-installed record type; no extension/type is inferred. */
  type?: string;
}
export interface ViewSourceWriteOptions extends WriteOptions {
  mutationId: Uuid;
}
export interface ViewSourceReadOptions {
  include?: Include;
  signal?: AbortSignal;
}
function invalid(message: string) {
  return mdbaseError("invalid_request", message, "view_source_witness_required");
}
function identity(id: Uuid): void {
  try {uuid.enc(id);} catch {throw invalid("view source writes need their original record and mutation UUIDs");}
}
function fullSource(record: RecordView): void {
  if (!record || typeof record.path !== "string" || record.path.length === 0 || typeof record.document !== "string") {
    throw invalid("view source update needs the complete RecordView read with document included");
  }
  identity(record.id);
  try {hash.enc(record.revision);} catch {throw invalid("view source needs its original source revision");}
  if (revisionOf(record.document) !== record.revision) {
    throw invalid("view source document differs from its captured revision");
  }
}
function sourceOptions(options: ViewSourceWriteOptions): ViewSourceWriteOptions {
  identity(options?.mutationId);
  // Source writes return genuine full local records even while pending. The
  // replica's receipt remains authoritative; inclusion is not confirmation.
  return {...options, include: {...options.include, document: true}};
}
/** Read a complete current local record, not a projection or a source-text DTO.
 * Return the actual SDK RecordView; never manufacture record metadata. */
export async function readViewSourceRecord(
  client: Pick<MdbaseClient, "get">,
  source: RecordRef,
  options: ViewSourceReadOptions = {},
): Promise<RecordView> {
  // Capture selection before awaiting; a caller-mutated reference must not
  // silently authorize readback for another record.
  const expectedId = typeof source === "string" ? source : "id" in source ? source.id : undefined;
  const expected = expectedId === undefined ? undefined : uuid.dec(uuid.enc(expectedId));
  const record = await client.get(source, {...options.include, document: true}, options.signal);
  fullSource(record);
  if (expected !== undefined && record.id !== expected) throw invalid("view source readback belongs to another record");
  return record;
}
/** Submit exactly the caller-captured document/UUID/MID through ordinary create.
 * The returned object is the SDK's genuine Write, including pending/unknown
 * outcomes and later confirmation/publication. No helper-owned retry/resubmit. */
export function createViewSource(
  client: Pick<MdbaseClient, "create">,
  input: ViewSourceCreateInput,
  options: ViewSourceWriteOptions,
): Promise<Write> {
  identity(input?.id);
  if (typeof input.path !== "string" || input.path.length === 0 || typeof input.document !== "string") {
    throw invalid("view source create needs the exact path and complete source document");
  }
  const original: CreateInput = {id: input.id, path: input.path, document: input.document};
  if (input.type !== undefined) original.type = input.type;
  return client.create(original, sourceOptions(options));
}
/** Replace a full source at its actual captured UUID/path/revision, including a
 * pending local revision. Never read-and-overwrite a newer document implicitly.
 * Pass a genuine full RecordView from native get or a document-inclusive receipt. */
export function updateViewSource(
  client: Pick<MdbaseClient, "replaceDocument">,
  seen: RecordView,
  document: string,
  options: ViewSourceWriteOptions,
): Promise<Write> {
  fullSource(seen);
  const state = seen.state;
  if (!state || (state.state !== "pending" && state.state !== "confirmed") || !Number.isSafeInteger(state.confirmedSeq) || state.confirmedSeq < 0) {
    throw invalid("view source update needs actual native record state, not inferred confirmation");
  }
  if (state.hold !== undefined || (state.unresolved !== undefined && state.unresolved !== 0)) {
    throw invalid("resolve the original view source hold or unresolved mutation before replacing its document");
  }
  if (typeof document !== "string") throw invalid("view source update needs complete source text");
  return client.replaceDocument(seen, document, {...sourceOptions(options), ifRevision: seen.revision});
}
