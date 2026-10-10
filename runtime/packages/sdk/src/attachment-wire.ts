/** Shared runtime-v1 attachment shape codec. No profile/crypto change or
 * manifest authentication, file-size admission, Submit or feature activation. */
import type { CborValue } from "./cbor.js";
import { type Codec, SchemaError, b32, hash, uint, uuid } from "./codec.js";
import type { Hash, Uuid } from "./wire.js";

export interface AttachmentRefV1 {
  collection: Uuid;
  keyEpoch: number | bigint;
  attachmentId: Uint8Array;
  manifestCipherHash: Hash;
}
export interface AttachmentContentV1 {
  reference: AttachmentRefV1;
  wholePlainHash: Hash;
  totalPlainBytes: number | bigint;
}
/** Exact wire u64 only; size admission belongs to native, not this decoder.
 * Keep existing small-number callers, never round a large attachment identity. */
const attachmentUint64: Codec<number | bigint> = {
  name: "attachment-uint64",
  enc: v => {
    if (typeof v === "number") return uint.enc(v);
    if (typeof v !== "bigint" || v < 0n || v > 0xffffffffffffffffn) throw new SchemaError("attachment-uint64", "outside uint64");
    return v;
  },
  dec: c => {
    if (typeof c === "number") return uint.dec(c);
    if (typeof c !== "bigint" || c < 0n || c > 0xffffffffffffffffn) throw new SchemaError("attachment-uint64", "outside uint64");
    return c <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(c) : c;
  },
};
const CHUNK_BYTES_V1 = 8_388_608;
function tuple(c: CborValue, length: number, name: string): CborValue[] {
  if (!Array.isArray(c) || c.length !== length) throw new SchemaError(name, `must have exactly ${length} elements`);
  if (uint.dec(c[0]!) !== 1) throw new SchemaError(name, "unknown version", true);
  return c;
}
export const attachmentRefV1: Codec<AttachmentRefV1> = {
  name: "attachment-ref-v1",
  enc: v => [1, uuid.enc(v.collection), attachmentUint64.enc(v.keyEpoch), b32.enc(v.attachmentId), CHUNK_BYTES_V1, hash.enc(v.manifestCipherHash)],
  dec: c => {
    const a = tuple(c, 6, "attachment-ref-v1");
    if (uint.dec(a[4]!) !== CHUNK_BYTES_V1) throw new SchemaError("attachment-ref-v1", "unknown chunk profile", true);
    return { collection: uuid.dec(a[1]!), keyEpoch: attachmentUint64.dec(a[2]!), attachmentId: b32.dec(a[3]!), manifestCipherHash: hash.dec(a[5]!) };
  },
};
export const attachmentContentV1: Codec<AttachmentContentV1> = {
  name: "attachment-content-v1",
  enc: v => [1, attachmentRefV1.enc(v.reference), hash.enc(v.wholePlainHash), attachmentUint64.enc(v.totalPlainBytes)],
  dec: c => {
    const a = tuple(c, 4, "attachment-content-v1");
    return { reference: attachmentRefV1.dec(a[1]!), wholePlainHash: hash.dec(a[2]!), totalPlainBytes: attachmentUint64.dec(a[3]!) };
  },
};
