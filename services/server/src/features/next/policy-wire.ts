// Encoding and signing of mdbase-next policy items (mdbase-next contracts:
// policy.md §1/§3, sealed-envelope.md §2, 00-overview.md §3 `mdb-cbor/1`).
//
// The control plane only ever *writes* policy items, so this is an encoder for the
// subset of the canonical CBOR profile those items use: unsigned and negative
// integers, byte and text strings, arrays, booleans and struct maps with ascending
// unsigned integer keys. Bytes are pinned by the golden fixtures in
// `policy-wire.test.ts`, copied from mdbase-next `conformance/wire/`.
import { createHash, sign as edSign, type KeyObject } from "node:crypto";

export type Cbor = number | bigint | boolean | string | Uint8Array | Cbor[] | StructMap;
/** A struct map: unsigned integer keys, encoded in ascending order. Absent fields are omitted. */
export type StructMap = { readonly struct: ReadonlyArray<readonly [number, Cbor | undefined]> };

const struct = (fields: ReadonlyArray<readonly [number, Cbor | undefined]>): StructMap => ({ struct: fields });

function head(major: number, value: bigint, out: number[]): void {
  const m = major << 5;
  if (value < 24n) out.push(m | Number(value));
  else if (value < 0x100n) out.push(m | 24, Number(value));
  else if (value < 0x10000n) out.push(m | 25, Number(value >> 8n), Number(value & 0xffn));
  else if (value < 0x100000000n) {
    out.push(m | 26);
    for (let shift = 24n; shift >= 0n; shift -= 8n) out.push(Number((value >> shift) & 0xffn));
  } else if (value < 0x10000000000000000n) {
    out.push(m | 27);
    for (let shift = 56n; shift >= 0n; shift -= 8n) out.push(Number((value >> shift) & 0xffn));
  } else throw new Error("integer outside the mdb-cbor/1 range");
}

function encodeInto(value: Cbor, out: number[]): void {
  if (typeof value === "number" || typeof value === "bigint") {
    if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("mdb-cbor/1 encoder accepts integers only");
    const n = BigInt(value);
    if (n >= 0n) head(0, n, out);
    else head(1, -1n - n, out);
  } else if (typeof value === "boolean") out.push(value ? 0xf5 : 0xf4);
  else if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    head(3, BigInt(bytes.length), out);
    for (const b of bytes) out.push(b);
  } else if (value instanceof Uint8Array) {
    head(2, BigInt(value.length), out);
    for (const b of value) out.push(b);
  } else if (Array.isArray(value)) {
    head(4, BigInt(value.length), out);
    for (const item of value) encodeInto(item, out);
  } else {
    const present = value.struct.filter((entry): entry is readonly [number, Cbor] => entry[1] !== undefined);
    for (let i = 1; i < present.length; i += 1) {
      if (present[i]![0] <= present[i - 1]![0]) throw new Error("struct map keys must be strictly ascending");
    }
    head(5, BigInt(present.length), out);
    for (const [key, field] of present) {
      head(0, BigInt(key), out);
      encodeInto(field, out);
    }
  }
}

export function encodeCbor(value: Cbor): Uint8Array {
  const out: number[] = [];
  encodeInto(value, out);
  return Uint8Array.from(out);
}

/** `H(tag, m) = SHA-256(u8(len(tag)) ‖ tag ‖ m)` (00-overview.md §4). */
export function domainHash(tag: string, message: Uint8Array): Uint8Array {
  const tagBytes = Buffer.from(tag, "utf8");
  if (tagBytes.length > 255) throw new Error("domain tag longer than 255 bytes");
  return createHash("sha256").update(Uint8Array.of(tagBytes.length)).update(tagBytes).update(message).digest();
}

/** Key ID: first 16 bytes of SHA-256 of the public key (00-overview.md §5). */
export function keyId(publicKey: Uint8Array): Uint8Array {
  return createHash("sha256").update(publicKey).digest().subarray(0, 16);
}

function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error("invalid UUID");
  return Buffer.from(hex, "hex");
}

export type CollectionStateName = "e2e" | "cloud-copy";
export type DeviceKind = "desktop" | "mobile" | "app-runtime" | "cli" | "hosted" | "escrow";
export type MemberRole = "viewer" | "editor" | "owner";

const CSTATE: Record<CollectionStateName, number> = { e2e: 0, "cloud-copy": 1 };
const DEVICE_KIND: Record<DeviceKind, number> = { desktop: 0, mobile: 1, "app-runtime": 2, cli: 3, hosted: 4, escrow: 5 };
const ROLE: Record<MemberRole, number> = { viewer: 0, editor: 1, owner: 2 };

export interface CpCert {
  policyPublicKey: Uint8Array;
  notBefore: number;
  notAfter: number;
  root: Uint8Array;
  signature: Uint8Array;
}

export type PolicyOp =
  | { op: "genesis"; owner: string; root: Uint8Array; state: CollectionStateName }
  | { op: "device-enrol"; device: string; account: string; kind: DeviceKind; signPublicKey: Uint8Array; kemPublicKey: Uint8Array; noisePublicKey: Uint8Array }
  | { op: "device-revoke"; device: string }
  | { op: "member-set"; account: string; role: MemberRole }
  | { op: "member-remove"; account: string }
  | { op: "grant"; grant: string; installation: string; appId: string; account: string; capabilities: string[]; clientPublicKey: Uint8Array; fileFolders?: string[] }
  | { op: "grant-revoke"; grant: string }
  | { op: "collection-state"; state: CollectionStateName; compress?: boolean; minSemMajor?: number }
  | { op: "cp-key-revoke"; keyId: Uint8Array; revokedFrom: number; rootSignature: Uint8Array }
  | { op: "migration-cutover"; legacyCollection: string; revoked: string[]; cutoverAt: number }
  | { op: "freeze"; frozen: boolean; reason?: string };

function sized(bytes: Uint8Array, size: number, name: string): Uint8Array {
  if (bytes.length !== size) throw new Error(`${name} must be ${size} bytes`);
  return bytes;
}

function encodeOp(op: PolicyOp): StructMap {
  switch (op.op) {
    case "genesis":
      return struct([[0, 1], [1, uuidBytes(op.owner)], [2, sized(op.root, 16, "root")], [3, CSTATE[op.state]]]);
    case "device-enrol":
      return struct([
        [0, 2], [1, uuidBytes(op.device)], [2, uuidBytes(op.account)], [3, DEVICE_KIND[op.kind]],
        [4, sized(op.signPublicKey, 32, "sign_pk")], [5, sized(op.kemPublicKey, 32, "kem_pk")], [6, sized(op.noisePublicKey, 32, "noise_pk")],
      ]);
    case "device-revoke":
      return struct([[0, 3], [1, uuidBytes(op.device)]]);
    case "member-set":
      return struct([[0, 4], [1, uuidBytes(op.account)], [2, ROLE[op.role]]]);
    case "member-remove":
      return struct([[0, 5], [1, uuidBytes(op.account)]]);
    case "grant":
      if (op.capabilities.length === 0) throw new Error("a grant needs at least one capability");
      if (op.fileFolders?.length === 0) throw new Error("file_folders is omitted, never empty");
      return struct([
        [0, 6], [1, uuidBytes(op.grant)], [2, uuidBytes(op.installation)], [3, op.appId], [4, uuidBytes(op.account)],
        [5, op.capabilities], [6, sized(op.clientPublicKey, 32, "client_pk")], [7, op.fileFolders],
      ]);
    case "grant-revoke":
      return struct([[0, 7], [1, uuidBytes(op.grant)]]);
    case "collection-state":
      return struct([[0, 8], [1, CSTATE[op.state]], [2, op.compress], [3, op.minSemMajor]]);
    case "cp-key-revoke":
      return struct([[0, 9], [1, sized(op.keyId, 16, "key ID")], [2, op.revokedFrom], [3, sized(op.rootSignature, 64, "signature")]]);
    case "migration-cutover":
      return struct([[0, 10], [1, uuidBytes(op.legacyCollection)], [2, op.revoked.map(uuidBytes)], [3, op.cutoverAt]]);
    case "freeze":
      return struct([[0, 11], [1, op.frozen], [2, op.reason]]);
  }
}

function certFields(cert: Omit<CpCert, "signature">): Array<readonly [number, Cbor]> {
  return [[0, sized(cert.policyPublicKey, 32, "policy_pk")], [1, cert.notBefore], [2, cert.notAfter], [3, sized(cert.root, 16, "root")]];
}

/** The digest the offline root signs to certify a policy key (policy.md §3). */
export function certDigest(cert: Omit<CpCert, "signature">): Uint8Array {
  return domainHash("mdbase/v1/cp-cert", encodeCbor(struct(certFields(cert))));
}

/** The digest the offline root signs for a `cp-key-revoke` op (policy.md §1). */
export function keyRevocationDigest(revokedKeyId: Uint8Array, revokedFrom: number): Uint8Array {
  return domainHash("mdbase/v1/cp-cert", encodeCbor([sized(revokedKeyId, 16, "key ID"), revokedFrom]));
}

export function encodeCert(cert: CpCert): Uint8Array {
  return encodeCbor(struct([...certFields(cert), [4, sized(cert.signature, 64, "signature")]]));
}

export function encodePolicyPayload(cert: CpCert, issuedAt: number, ops: PolicyOp[]): Uint8Array {
  if (ops.length === 0) throw new Error("a policy item needs at least one op");
  return encodeCbor(struct([
    [0, 1],
    [1, struct([...certFields(cert), [4, sized(cert.signature, 64, "signature")]])],
    [2, issuedAt],
    [3, ops.map(encodeOp)],
  ]));
}

const POLICY_KIND = 2;

function itemFields(collection: string, seq: number, prev: Uint8Array, signer: Uint8Array, body: Uint8Array): Array<readonly [number, Cbor]> {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("seq must be a positive integer");
  return [[0, 1], [1, POLICY_KIND], [2, uuidBytes(collection)], [3, seq], [4, sized(prev, 32, "prev")], [6, sized(signer, 16, "signer")], [11, body]];
}

/** `H("mdbase/v1/item-sig", canonical(item without key 12))` (sealed-envelope.md §2.2). */
export function policyItemSignedDigest(collection: string, seq: number, prev: Uint8Array, signer: Uint8Array, body: Uint8Array): Uint8Array {
  return domainHash("mdbase/v1/item-sig", encodeCbor(struct(itemFields(collection, seq, prev, signer, body))));
}

export function encodePolicyItem(collection: string, seq: number, prev: Uint8Array, signer: Uint8Array, body: Uint8Array, signature: Uint8Array): Uint8Array {
  return encodeCbor(struct([...itemFields(collection, seq, prev, signer, body), [12, sized(signature, 64, "signature")]]));
}

/** `chain(p) = H("mdbase/v1/chain", canonical bytes of the complete item)` (sealed-envelope.md §2.3). */
export function chainHash(item: Uint8Array): Uint8Array {
  return domainHash("mdbase/v1/chain", item);
}

export interface PolicySigner {
  cert: CpCert;
  privateKey: KeyObject;
}

/** Build and sign the policy item at `(seq, prev)`. */
export function signPolicyItem(signer: PolicySigner, input: { collection: string; seq: number; prev: Uint8Array; issuedAt: number; ops: PolicyOp[] }): Uint8Array {
  const body = encodePolicyPayload(signer.cert, input.issuedAt, input.ops);
  const signerId = keyId(signer.cert.policyPublicKey);
  const digest = policyItemSignedDigest(input.collection, input.seq, input.prev, signerId, body);
  const signature = edSign(null, digest, signer.privateKey);
  return encodePolicyItem(input.collection, input.seq, input.prev, signerId, body, signature);
}
