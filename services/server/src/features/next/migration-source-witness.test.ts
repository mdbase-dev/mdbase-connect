import { createPrivateKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ed25519PublicKeyObject, ed25519RawPublicKey, verifyCert } from "./policy-keys.js";
import { certDigest, decodeCbor, domainHash, keyId, uuidBytes, type PolicySigner } from "./policy-wire.js";
import { signMigrationSourceWitness } from "./migration-source-witness.js";

// PUBLIC SYNTHETIC TEST SEEDS ONLY, not credentials or release pins.
const testKey = (byte: number) => createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, byte)]),
  format: "der", type: "pkcs8",
});
const root = testKey(0x31);
const policy = testKey(0x32);
const rootPublicKey = ed25519RawPublicKey(root);
const unsigned = { policyPublicKey: ed25519RawPublicKey(policy), notBefore: 1790000000000, notAfter: 1800000000000, root: keyId(rootPublicKey) };
const signer: PolicySigner = { privateKey: policy, cert: { ...unsigned, signature: sign(null, certDigest(unsigned), root) } };
const facts = {
  target: "4c18af2e-b04a-4b77-b83e-493c3695962e", device: "2d7e9a41-6c3b-4f18-9a05-c8e1b2d3f467", epoch: 2n,
  legacy: "4c18af2e-b04a-4b77-b83e-493c3695962e", frozenHead: 42n, startedAt: 1791099999000,
  wake: (1n << 64n) - 1n, issuedAt: 1791100000000,
};
function decoded(witness: Uint8Array) {
  const outer = decodeCbor(witness, { maxDepth: 5, canonicalStructs: true });
  if (!Array.isArray(outer) || outer.length !== 4 || !(outer[1] instanceof Uint8Array) || !(outer[2] instanceof Map) || !(outer[3] instanceof Uint8Array)) throw new Error("bad test envelope");
  const claims = decodeCbor(outer[1], { maxDepth: 2, canonicalStructs: true });
  if (!Array.isArray(claims)) throw new Error("bad test claims");
  return { outer, bytes: outer[1], cert: outer[2], signature: outer[3], claims };
}

describe("migration-source witness producer", () => {
  it("pins the producer vector for independent native verifier qualification", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/migration-source-witness-v1.json", import.meta.url), "utf8")) as { witnessHex:string; claimsHex:string; digestHex:string; rootPublicKeyHex:string; policyPublicKeyHex:string };
    const { witness } = signMigrationSourceWitness(signer, facts);
    const hex = (bytes:Uint8Array) => Buffer.from(bytes).toString("hex");
    expect(hex(witness)).toBe(fixture.witnessHex);
    expect(hex(decoded(witness).bytes)).toBe(fixture.claimsHex);
    expect(hex(domainHash("mdbase-next/migration-source/v1", decoded(witness).bytes))).toBe(fixture.digestHex);
    expect(hex(rootPublicKey)).toBe(fixture.rootPublicKeyHex);
    expect(hex(signer.cert.policyPublicKey)).toBe(fixture.policyPublicKeyHex);
  });
  it("pins the exact four-field envelope, ten-field claims and unchanged root-certified CpCert", () => {
    const { witness, expiresAt } = signMigrationSourceWitness(signer, facts);
    expect(witness.length).toBeLessThanOrEqual(4096);
    const result = decoded(witness);
    expect(result.outer[0]).toBe(1);
    expect(result.claims).toEqual([1, Uint8Array.from(uuidBytes(facts.target)), Uint8Array.from(uuidBytes(facts.device)), 2, Uint8Array.from(uuidBytes(facts.legacy)), 42, facts.startedAt, facts.wake, facts.issuedAt, expiresAt]);
    expect(result.cert.size).toBe(5);
    expect(result.cert.get(0)).toEqual(Uint8Array.from(signer.cert.policyPublicKey));
    expect(result.cert.get(1)).toBe(signer.cert.notBefore);
    expect(result.cert.get(2)).toBe(signer.cert.notAfter);
    expect(result.cert.get(3)).toEqual(Uint8Array.from(signer.cert.root));
    expect(result.cert.get(4)).toEqual(Uint8Array.from(signer.cert.signature));
    expect(verifyCert(signer.cert, rootPublicKey)).toBe(true);
    expect(result.signature.length).toBe(64);
    const publicKey = ed25519PublicKeyObject(signer.cert.policyPublicKey);
    expect(verify(null, domainHash("mdbase-next/migration-source/v1", result.bytes), publicKey, result.signature)).toBe(true);
    expect(verify(null, result.bytes, publicKey, result.signature)).toBe(false);
    expect(verify(null, domainHash("mdbase/v1/ls-token", result.bytes), publicKey, result.signature)).toBe(false);
    const changed = Uint8Array.from(result.bytes); changed[changed.length - 1]! ^= 1;
    expect(verify(null, domainHash("mdbase-next/migration-source/v1", changed), publicKey, result.signature)).toBe(false);
    expect(expiresAt - facts.issuedAt).toBe(900000);
  });
  it("preserves full u64 counters and exact signed millisecond start claim", () => {
    const maximum = (1n << 64n) - 1n;
    const result = decoded(signMigrationSourceWitness(signer, { ...facts, epoch: maximum, frozenHead: maximum, startedAt: -1 }).witness);
    expect(result.claims[3]).toBe(maximum); expect(result.claims[5]).toBe(maximum); expect(result.claims[6]).toBe(-1); expect(result.claims[7]).toBe(maximum);
  });
  it("clamps expiry to the existing certificate window", () => {
    const limited = { ...signer, cert: { ...signer.cert, notAfter: facts.issuedAt + 1234 } };
    const result = signMigrationSourceWitness(limited, facts);
    expect(result.expiresAt).toBe(limited.cert.notAfter); expect(decoded(result.witness).claims[9]).toBe(result.expiresAt);
  });
  it.each([
    { epoch: -1n }, { epoch: 1n << 64n }, { frozenHead: -1n }, { frozenHead: 1n << 64n }, { wake: -1n }, { wake: 1n << 64n },
    { target: "00000000-0000-0000-0000-000000000000" }, { device: "00000000-0000-0000-0000-000000000000" }, { legacy: "00000000-0000-0000-0000-000000000000" },
    { target: facts.target.toUpperCase() }, { device: "bad" }, { legacy: "bad" },
    { startedAt: 1.5 }, { startedAt: NaN }, { startedAt: Number.MAX_SAFE_INTEGER + 1 }, { startedAt: facts.issuedAt + 1 },
    { issuedAt: 1.5 }, { issuedAt: NaN }, { issuedAt: Number.MAX_SAFE_INTEGER + 1 },
    { issuedAt: signer.cert.notBefore - 1, startedAt: signer.cert.notBefore - 2 }, { issuedAt: signer.cert.notAfter },
  ])("refuses invalid trusted-fact input %#", invalid => {
    expect(() => signMigrationSourceWitness(signer, { ...facts, ...invalid })).toThrow();
  });
});
