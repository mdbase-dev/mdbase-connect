/** Explicit runtime-v1 conformance codecs, not Submit/Hello or feature activation.
 * Legacy operations delegate unchanged; the default mutation still rejects13–18.
 * Shape checks do not authenticate manifests, admit file sizes or verify authority.
 */
import type { CborValue } from "./cbor.js";
import { type Codec, SchemaError, b16, b32, either, enumOf, hash, list, struct, tstr, uint, union, uuid } from "./codec.js";
import { blobRef, conflictMode, op, opClock, type BlobRef, type Hash, type Mutation, type Op, type Uuid } from "./wire.js";

import { attachmentContentV1, type AttachmentContentV1 } from "./attachment-wire.js";
export { attachmentContentV1, attachmentRefV1 } from "./attachment-wire.js";
export type { AttachmentContentV1, AttachmentRefV1 } from "./attachment-wire.js";
export type FileAttach = { kind: "file_attach"; id: Uuid; path: string; content: AttachmentContentV1; ifRevision?: Hash; base?: Hash };
export type FileContent = { form: "blob"; blob: BlobRef } | { form: "attachment"; content: AttachmentContentV1 };
/** Closed content union; unknown envelopes never become BlobRefs. */
export const fileContent: Codec<FileContent> = {
  name: "file-content",
  enc: v => v.form === "blob" ? blobRef.enc(v.blob) : attachmentContentV1.enc(v.content),
  dec: c => Array.isArray(c) ? { form: "attachment", content: attachmentContentV1.dec(c) }
    : { form: "blob", blob: blobRef.dec(c) },
};
export interface UnindexedMarkdownPayloadV1 { content: FileContent }
function payloadSize(v: UnindexedMarkdownPayloadV1): number | bigint {
  return v.content.form === "blob" ? v.content.blob.size : v.content.content.totalPlainBytes;
}
/** Structural declaration only; neither UTF8 nor plaintext/authority proof. */
export const unindexedMarkdownPayloadV1: Codec<UnindexedMarkdownPayloadV1> = {
  name: "unindexed-markdown-payload-v1",
  enc: v => {
    if (payloadSize(v) <= 1_048_576) throw new SchemaError("unindexed-markdown-payload-v1", "declared size must exceed record cap");
    return [2, 1, 1, fileContent.enc(v.content)];
  },
  dec: c => {
    const name = "unindexed-markdown-payload-v1";
    if (!Array.isArray(c) || c.length !== 4) throw new SchemaError(name, "must have exactly four elements");
    if (uint.dec(c[0]!) !== 2 || uint.dec(c[1]!) !== 1 || uint.dec(c[2]!) !== 1) throw new SchemaError(name, "unknown discriminator/profile/kind", true);
    const v = { content: fileContent.dec(c[3]!) };
    if (payloadSize(v) <= 1_048_576) throw new SchemaError(name, "declared size must exceed record cap");
    return v;
  },
};
export type RuntimeText = string | number;
const runtimeText = either<string, number>("text", tstr, (v): v is string => typeof v === "string", c => typeof c === "string", uint);
export type UnindexedMarkdownPut = { kind: "unindexed_markdown_put"; id: Uuid; path: string; payload: UnindexedMarkdownPayloadV1; expected?: UnindexedMarkdownPayloadV1 };
export type RecordToUnindexedMarkdown = { kind: "record_to_unindexed_markdown"; id: Uuid; path: string; payload: UnindexedMarkdownPayloadV1; priorRevision: Hash };
export type UnindexedMarkdownToRecord = { kind: "unindexed_markdown_to_record"; id: Uuid; path: string; doc: RuntimeText; prior: UnindexedMarkdownPayloadV1 };
export type OrdinaryFileToRecord = { kind: "ordinary_file_to_record"; id: Uuid; path: string; doc: RuntimeText; prior: FileContent };
export type OrdinaryAttachmentContinuation = {kind: "ordinary_attachment_continuation"; id: Uuid; path: string; content: AttachmentContentV1; prior: FileContent};
type ExtendedOp = OrdinaryAttachmentContinuation | FileAttach | UnindexedMarkdownPut | RecordToUnindexedMarkdown | UnindexedMarkdownToRecord | OrdinaryFileToRecord;
export type RuntimeOp = Op | ExtendedOp;
const extendedOp = union<ExtendedOp>("extended-runtime-op", [
  [13, "file_attach", [[1, "id", uuid], [2, "path", tstr], [3, "content", attachmentContentV1], [4, "ifRevision", hash, "opt"], [5, "base", hash, "opt"]]],
  [14, "unindexed_markdown_put", [[1, "id", uuid], [2, "path", tstr], [3, "payload", unindexedMarkdownPayloadV1], [4, "expected", unindexedMarkdownPayloadV1, "opt"]]],
  [15, "record_to_unindexed_markdown", [[1, "id", uuid], [2, "path", tstr], [3, "payload", unindexedMarkdownPayloadV1], [4, "priorRevision", hash]]],
  [16, "unindexed_markdown_to_record", [[1, "id", uuid], [2, "path", tstr], [3, "doc", runtimeText], [4, "prior", unindexedMarkdownPayloadV1]]],
  [18, "ordinary_attachment_continuation", [[1, "id", uuid], [2, "path", tstr], [3, "content", attachmentContentV1], [4, "prior", fileContent]]],
  [17, "ordinary_file_to_record", [[1, "id", uuid], [2, "path", tstr], [3, "doc", runtimeText], [4, "prior", fileContent]]],
]);
function extended(v: RuntimeOp): v is ExtendedOp {
  return v.kind === "ordinary_attachment_continuation" || v.kind === "file_attach" || v.kind === "unindexed_markdown_put" || v.kind === "record_to_unindexed_markdown"
    || v.kind === "unindexed_markdown_to_record" || v.kind === "ordinary_file_to_record";
}
export const runtimeOp: Codec<RuntimeOp> = {
  name: "runtime-v1-op",
  enc: v => extended(v) ? extendedOp.enc(v) : op.enc(v),
  dec: c => {
    const tag = c instanceof Map ? uint.dec((c as Map<number, CborValue>).get(0)!) : undefined;
    return tag !== undefined && tag >= 13 && tag <= 18 ? extendedOp.dec(c) : op.dec(c);
  },
};
export type RuntimeMutation = Omit<Mutation, "ops"> & { ops: RuntimeOp[] };
/** Canonical parent keys unchanged; only the explicit operation family differs. */
export const runtimeMutation = struct<RuntimeMutation>("runtime-v1-mutation", [
  [0, "id", uuid], [1, "origin", uuid], [2, "baseSeq", uint],
  [3, "clock", opClock],
  [4, "seed", b32], [5, "source", enumOf("source", ["api", "external"] as const)],
  [6, "ops", list(runtimeOp, { nonEmpty: true }), "req1"],
  [7, "onBehalf", uuid, "opt"], [8, "conflictMode", conflictMode, "opt"],
  [9, "validatedAt", enumOf("level", ["off", "warn", "error"] as const), "opt"],
  [10, "room", struct<{ stream: Uint8Array; state: Hash }>("room-checkpoint", [[0, "stream", b16], [1, "state", hash]]), "opt"],
]);
