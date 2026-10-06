import { generateKeyPairSync, sign } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ApprovalPeerInputError, parseApprovalPeer, verifyApprovalPeerOrigin, type ApprovalPeerDevice } from "./approval-peer.js";
import { ed25519RawPublicKey } from "./policy-keys.js";
import { domainHash, encodeCbor, uuidBytes, type Cbor } from "./policy-wire.js";

const collection = "11111111-1111-4111-8111-111111111111";
const account = "22222222-2222-4222-8222-222222222222";
const struct = (values: Cbor[]): Cbor => ({ struct: values.map((value, i) => [i, value]) });
function fixture(kind: 0 | 1 = 0) {
  const a = generateKeyPairSync("ed25519"), n = generateKeyPairSync("ed25519");
  const approver: ApprovalPeerDevice = { device: "33333333-3333-4333-8333-333333333333", account, kind: 3,
    sign_pk: ed25519RawPublicKey(a.publicKey), kem_pk: Buffer.alloc(32, 5), noise_pk: Buffer.alloc(32, 6) };
  const requester: ApprovalPeerDevice = { ...approver, device: "44444444-4444-4444-8444-444444444444", sign_pk: ed25519RawPublicKey(n.publicKey) };
  const device = (d: ApprovalPeerDevice) => struct([uuidBytes(d.device), uuidBytes(d.account), d.kind, d.sign_pk, d.kem_pk, d.noise_pk]);
  const binding = [uuidBytes(collection), 1, device(approver), device(requester), Buffer.alloc(32, 9)];
  const fields: Cbor[] = [1, kind, struct(binding), Buffer.alloc(32, 10), 1_800_000_000_000];
  if (kind === 1) fields.push(Buffer.alloc(32, 11));
  const body = struct(fields);
  const signature = sign(null, domainHash("mdbase/v1/device-approval-peer", encodeCbor(body)), kind === 0 ? a.privateKey : n.privateKey);
  const bytes = encodeCbor(struct([body, signature]));
  return { bytes, fields, binding, signature, approver, requester };
}

describe("actual Replica signed approval peer envelope boundary", () => {
  it.each([0, 1] as const)("verifies kind %s only against its independently registered full sender tuple", kind => {
    const f = fixture(kind), parsed = parseApprovalPeer(f.bytes, collection);
    expect(parsed.kind).toBe(kind);
    expect(parsed.epoch).toBe(1n);
    expect(parsed.bytes).toEqual(Buffer.from(f.bytes));
    const sender = kind === 0 ? f.approver : f.requester;
    expect(verifyApprovalPeerOrigin(parsed, sender)).toBe(true);
    for (const altered of [{ ...sender, device: f.requester.device === sender.device ? f.approver.device : f.requester.device },
      { ...sender, account: "55555555-5555-4555-8555-555555555555" }, { ...sender, kind: 0 as const },
      { ...sender, sign_pk: Buffer.alloc(32, 12) }, { ...sender, kem_pk: Buffer.alloc(32, 12) }, { ...sender, noise_pk: Buffer.alloc(32, 12) }]) {
      expect(verifyApprovalPeerOrigin(parsed, altered)).toBe(false);
    }
  });
  it("does not adopt collection context from an embedded signed field", () => {
    expect(() => parseApprovalPeer(fixture().bytes, "55555555-5555-4555-8555-555555555555")).toThrow(ApprovalPeerInputError);
  });
  it("refuses a changed canonical body under the old signature", () => {
    const f = fixture(); f.fields[3] = Buffer.alloc(32, 13);
    const parsed = parseApprovalPeer(encodeCbor(struct([struct(f.fields), f.signature])), collection);
    expect(verifyApprovalPeerOrigin(parsed, f.approver)).toBe(false);
  });
  it("redacts nonces, signed bytes and identities from inspection", () => {
    expect(inspect(parseApprovalPeer(fixture(1).bytes, collection))).toBe("ApprovalPeer { <redacted> }");
  });
  it.each(["extra", "missing", "service", "zero-epoch", "nil-collection", "same-device", "negative-expiry", "float-expiry", "short-signature", "short-nonce"])("rejects closed-shape violation %s", violation => {
    const f = fixture();
    if (violation === "extra") f.fields.push(Buffer.alloc(32));
    if (violation === "missing") f.fields.pop();
    if (violation === "service") (f.binding[2] as { struct: [number, Cbor][] }).struct[2][1] = 4;
    if (violation === "zero-epoch") f.binding[1] = 0;
    if (violation === "nil-collection") f.binding[0] = Buffer.alloc(16);
    if (violation === "same-device") f.binding[3] = f.binding[2];
    if (violation === "negative-expiry") f.fields[4] = -1;
    if (violation === "float-expiry") f.fields[4] = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    if (violation === "short-nonce") f.fields[3] = Buffer.alloc(31);
    f.fields[2] = struct(f.binding);
    const bytes = encodeCbor(struct([struct(f.fields), violation === "short-signature" ? Buffer.alloc(63) : f.signature]));
    expect(() => parseApprovalPeer(bytes, collection)).toThrow(ApprovalPeerInputError);
  });
  it("rejects oversized, trailing, nonshortest, unsorted and duplicate CBOR", () => {
    const f = fixture();
    const nonshortest = Buffer.concat([Buffer.from([0xb8, 2]), Buffer.from(f.bytes).subarray(1)]);
    const swapped = Buffer.concat([Buffer.from([0xa2, 1]), encodeCbor(f.signature), Buffer.from([0]), encodeCbor(struct(f.fields))]);
    for (const bytes of [Buffer.alloc(2049), Buffer.concat([Buffer.from(f.bytes), Buffer.from([0])]), nonshortest, swapped,
      Buffer.from([0xa2, 0, 1, 0, 1])]) expect(() => parseApprovalPeer(bytes, collection)).toThrow(ApprovalPeerInputError);
  });
});
