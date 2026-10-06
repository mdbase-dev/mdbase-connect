// Candidate metadata routing boundary for the ACTUAL Replica approval-peer codec.
// This verifies a registered device's origin, not applied policy/key delivery.
// Receivers still verify current policy, custody, commitment and exchange fences.
import { verify } from "node:crypto";
import { inspect } from "node:util";
import { ed25519PublicKeyObject } from "./policy-keys.js";
import { decodeCbor, domainHash, encodeCbor, type Cbor, type Decoded } from "./policy-wire.js";

export class ApprovalPeerInputError extends Error {
  constructor() { super("Invalid signed approval peer metadata."); }
}
export interface ApprovalPeerDevice {
  device: string;
  account: string;
  kind: 0 | 1 | 2 | 3;
  sign_pk: Buffer;
  kem_pk: Buffer;
  noise_pk: Buffer;
}
export interface ApprovalPeer {
  kind: 0 | 1;
  collection: string;
  epoch: bigint;
  approver: ApprovalPeerDevice;
  requester: ApprovalPeerDevice;
  expiresAt: number;
  generation: Buffer;
  bytes: Buffer;
  body: Buffer;
  signature: Buffer;
}
const invalid = (): never => { throw new ApprovalPeerInputError(); };
function closed(value: Decoded | undefined, count: number): Map<number, Decoded> {
  if (!(value instanceof Map) || value.size !== count || [...value.keys()].some((key, i) => key !== i)) return invalid();
  return value as Map<number, Decoded>;
}
function sized(value: Decoded | undefined, length: number): Buffer {
  if (!(value instanceof Uint8Array) || value.length !== length) return invalid();
  return Buffer.from(value);
}
function uuid(value: Decoded | undefined): string {
  const bytes = sized(value, 16);
  if (bytes.every(b => b === 0)) return invalid();
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function device(value: Decoded | undefined): ApprovalPeerDevice {
  const d = closed(value, 6), kind = d.get(2);
  if (typeof kind !== "number" || !Number.isInteger(kind) || kind < 0 || kind > 3) return invalid();
  return { device: uuid(d.get(0)), account: uuid(d.get(1)), kind: kind as 0 | 1 | 2 | 3,
    sign_pk: sized(d.get(3), 32), kem_pk: sized(d.get(4), 32), noise_pk: sized(d.get(5), 32) };
}
function canonical(value: Decoded): Cbor {
  if (value instanceof Map) return { struct: [...value.entries()].map(([key, v]) => {
    if (typeof key !== "number") return invalid();
    return [key, canonical(v)] as const;
  }) };
  if (value instanceof Uint8Array || typeof value === "number" || typeof value === "bigint") return value;
  return invalid();
}

/** Bound collection comes from the authenticated route, NOT the embedded object. */
export function parseApprovalPeer(bytes: Uint8Array, collection: string): ApprovalPeer {
  if (bytes.length === 0 || bytes.length > 2048) return invalid();
  let decoded: Decoded;
  // All decoder failures here describe hostile bounded input, not a network or
  // authority fallback. No caller callback or mutator executes inside this catch.
  try { decoded = decodeCbor(bytes); } catch { return invalid(); }
  const envelope = closed(decoded, 2), rawBody = envelope.get(0);
  if (!(rawBody instanceof Map)) return invalid();
  const kind = rawBody.get(1);
  if (kind !== 0 && kind !== 1) return invalid();
  const body = closed(rawBody, kind === 0 ? 5 : 6), binding = closed(body.get(2), 5);
  if (body.get(0) !== 1) return invalid();
  const bound = uuid(binding.get(0));
  if (bound !== collection) return invalid();
  const e = binding.get(1);
  if ((typeof e !== "number" && typeof e !== "bigint") || (typeof e === "number" && !Number.isSafeInteger(e))) return invalid();
  const epoch = BigInt(e);
  if (epoch <= 0n || epoch > 0xffffffffffffffffn) return invalid();
  const approver = device(binding.get(2)), requester = device(binding.get(3));
  if (approver.device === requester.device) return invalid();
  sized(binding.get(4), 32); // latest applied commitment remains receiver authority
  const expiresAt = body.get(4);
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt < 0) return invalid();
  const generation = sized(body.get(3), 32);
  if (kind === 1) sized(body.get(5), 32);
  const signature = sized(envelope.get(1), 64);
  const encoded = Buffer.from(encodeCbor(canonical(decoded)));
  if (!encoded.equals(Buffer.from(bytes))) return invalid(); // shortest/sorted canonical only
  const peer: ApprovalPeer = { kind, collection: bound, epoch, approver, requester, expiresAt,
    generation, signature, body: Buffer.from(encodeCbor(canonical(rawBody))), bytes: Buffer.from(bytes) };
  // Never make r_A/r_N, signatures or private identity tuples inspectable in logs.
  Object.defineProperty(peer, inspect.custom, { value: () => "ApprovalPeer { <redacted> }" });
  return peer;
}

/** Caller supplies the independently current registered tuple. No embedded-key adoption. */
export function verifyApprovalPeerOrigin(peer: ApprovalPeer, registered: ApprovalPeerDevice): boolean {
  const sender = peer.kind === 0 ? peer.approver : peer.requester;
  return sender.device === registered.device && sender.account === registered.account && sender.kind === registered.kind
    && sender.sign_pk.equals(registered.sign_pk) && sender.kem_pk.equals(registered.kem_pk) && sender.noise_pk.equals(registered.noise_pk)
    && verify(null, domainHash("mdbase/v1/device-approval-peer", peer.body), ed25519PublicKeyObject(registered.sign_pk), peer.signature);
}
