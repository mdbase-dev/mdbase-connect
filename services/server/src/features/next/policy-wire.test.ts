import { generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  certDigest,
  chainHash,
  decodeCbor,
  deviceKindNumber,
  encodeCbor,
  encodePolicyItem,
  encodePolicyPayload,
  keyId,
  keyRevocationDigest,
  policyItemSignedDigest,
  rootHandoverDigest,
  signPolicyItem,
  type CpCert,
  type PolicyOp,
} from "./policy-wire.js";
import { certToJson, ed25519PublicKeyObject, ed25519RawPublicKey, loadPolicySigner, parseNextControlPlaneEnv } from "./policy-keys.js";
import { runCpCertCommand } from "./cp-cert-cli.js";

// Golden fixtures from mdbase-next `conformance/wire/` (policy/genesis, policy/every-op,
// item/policy). The Rust wire crate produces these bytes; these tests pin the TypeScript
// encoder to them.
const hex = (value: string) => Buffer.from(value, "hex");
const fill = (byte: number, size: number) => new Uint8Array(size).fill(byte);

const fixtureCert: CpCert = {
  policyPublicKey: fill(0x9c, 32),
  notBefore: 1790000000000,
  notAfter: 1800000000000,
  root: hex("a0a1a2a3a4a5a6a7a8a9aaabacadaeaf"),
  signature: fill(0x51, 64),
};
const owner = "6f1e2d3c-4b5a-4968-8776-655443322110";
const device = "2d7e9a41-6c3b-4f18-9a05-c8e1b2d3f467";
const other = "9b2f6c1e-3a47-4d5b-8e21-6f0a9c3d7e54";
const legacy = "4c18af2e-b04a-4b77-b83e-493c3695962e";

const GENESIS = "a4000101a50058209c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c011b000001a0c4506c00021b000001a3185c50000350a0a1a2a3a4a5a6a7a8a9aaabacadaeaf04584051515151515151515151515151515151515151515151515151515151515151515151515151515151515151515151515151515151515151515151515151515151021b000001a105e117000383a4000101506f1e2d3c4b5a496887766554433221100250a0a1a2a3a4a5a6a7a8a9aaabacadaeaf0300a3000401506f1e2d3c4b5a496887766554433221100202a7000201502d7e9a416c3b4f189a05c8e1b2d3f46702506f1e2d3c4b5a496887766554433221100300045820010101010101010101010101010101010101010101010101010101010101010105582002020202020202020202020202020202020202020202020202020202020202020658200303030303030303030303030303030303030303030303030303030303030303";
const EVERY_OP = "a4000101a50058209c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c011b000001a0c4506c00021b000001a3185c50000350a0a1a2a3a4a5a6a7a8a9aaabacadaeaf04584051515151515151515151515151515151515151515151515151515151515151515151515151515151515151515151515151515151515151515151515151515151021b000001a10bd6f8000388a2000301502d7e9a416c3b4f189a05c8e1b2d3f467a2000501509b2f6c1e3a474d5b8e216f0a9c3d7e54a8000601506f1e2d3c4b5a4968877665544332211002509b2f6c1e3a474d5b8e216f0a9c3d7e5403717461736b6e6f7465732d706c616e6e657204506f1e2d3c4b5a4968877665544332211005826f636f6c6c656374696f6e2e726561646c7265636f7264732e656469740658200c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c07816650686f746f73a2000701506f1e2d3c4b5a49688776655443322110a30008010102f4a400090150ce7ee39cb8c5c4b32f954bf04d50757d021b000001a108dc078003584052525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252a4000a01504c18af2eb04a4b77b83e493c3695962e0281509b2f6c1e3a474d5b8e216f0a9c3d7e54031b000001a10bd6f800a3000b01f402706375746f76657220636f6d706c657465";
const PRIVATE_SYNC_OPS = "a4000101a50058209c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c011b000001a0c4506c00021b000001a3185c50000350a0a1a2a3a4a5a6a7a8a9aaabacadaeaf04584051515151515151515151515151515151515151515151515151515151515151515151515151515151515151515151515151515151515151515151515151515151021b000001a111ccd9000385a9000201502d7e9a416c3b4f189a05c8e1b2d3f46702506f1e2d3c4b5a4968877665544332211003000458200101010101010101010101010101010101010101010101010101010101010101055820020202020202020202020202020202020202020202020202020202020202020206582003030303030303030303030303030303030303030303030303030303030303030758205c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c0858204c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4ca7000201509b2f6c1e3a474d5b8e216f0a9c3d7e5402506f1e2d3c4b5a496887766554433221100306045820111111111111111111111111111111111111111111111111111111111111111105582012121212121212121212121212121212121212121212121212121212121212120658200000000000000000000000000000000000000000000000000000000000000000a8000601506f1e2d3c4b5a4968877665544332211002509b2f6c1e3a474d5b8e216f0a9c3d7e5403717461736b6e6f7465732d706c616e6e657204506f1e2d3c4b5a4968877665544332211005816f636f6c6c656374696f6e2e726561640658200c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c08f5a400090150ce7ee39cb8c5c4b32f954bf04d50757d021b000001a108dc078003584052525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252525252a5000c0158204c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c02502d7e9a416c3b4f189a05c8e1b2d3f46703500192f3a460007abc8def0123456789ab04584053535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353535353";
const POLICY_ITEM = "a80001010202504c18af2eb04a4b77b83e493c3695962e030104582000000000000000000000000000000000000000000000000000000000000000000650ce7ee39cb8c5c4b32f954bf04d50757d0b41a00c58405b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b";

describe("mdbase-next policy wire", () => {
  it.each([["desktop", 0], ["mobile", 1], ["app-runtime", 2], ["cli", 3]] as const)("preserves the existing %s enrolment kind tag %i", (kind, tag) => {
    const payload = decodeCbor(encodePolicyPayload(fixtureCert, 1791100000000, [
      { op: "device-enrol", device, account: owner, kind, signPublicKey: fill(1,32), kemPublicKey: fill(2,32), noisePublicKey: fill(3,32) }
    ]));
    expect(deviceKindNumber(kind)).toBe(tag);
    expect(((payload as Map<number, unknown>).get(3) as Map<number, unknown>[])[0].get(3)).toBe(tag);
  });
  it("encodes the genesis fixture byte for byte", () => {
    const ops: PolicyOp[] = [
      { op: "genesis", owner, root: fixtureCert.root, state: "e2e" },
      { op: "member-set", account: owner, role: "owner" },
      { op: "device-enrol", device, account: owner, kind: "desktop", signPublicKey: fill(1, 32), kemPublicKey: fill(2, 32), noisePublicKey: fill(3, 32) },
    ];
    expect(Buffer.from(encodePolicyPayload(fixtureCert, 1791100000000, ops)).toString("hex")).toBe(GENESIS);
  });

  it("encodes every remaining op as the fixture does", () => {
    const ops: PolicyOp[] = [
      { op: "device-revoke", device },
      { op: "member-remove", account: other },
      { op: "grant", grant: owner, installation: other, appId: "tasknotes-planner", account: owner, capabilities: ["collection.read", "records.edit"], clientPublicKey: fill(0x0c, 32), fileFolders: ["Photos"] },
      { op: "grant-revoke", grant: owner },
      { op: "collection-state", state: "cloud-copy", compress: false },
      { op: "cp-key-revoke", keyId: hex("ce7ee39cb8c5c4b32f954bf04d50757d"), revokedFrom: 1791150000000, rootSignature: fill(0x52, 64) },
      { op: "migration-cutover", legacyCollection: legacy, revoked: [other], cutoverAt: 1791200000000 },
      { op: "freeze", frozen: false, reason: "cutover complete" },
    ];
    expect(Buffer.from(encodePolicyPayload(fixtureCert, 1791200000000, ops)).toString("hex")).toBe(EVERY_OP);
  });

  it("encodes the #33 private-sync fields and root-handover as the fixture does", () => {
    const mutation = "0192f3a4-6000-7abc-8def-0123456789ab";
    const ops: PolicyOp[] = [
      { op: "device-enrol", device, account: owner, kind: "desktop", signPublicKey: fill(1, 32), kemPublicKey: fill(2, 32), noisePublicKey: fill(3, 32), sasCommit: fill(0x5c, 32), localRoot: fill(0x4c, 32) },
      { op: "device-enrol", device: other, account: owner, kind: "recovery", signPublicKey: fill(0x11, 32), kemPublicKey: fill(0x12, 32), noisePublicKey: fill(0, 32) },
      { op: "grant", grant: owner, installation: other, appId: "tasknotes-planner", account: owner, capabilities: ["collection.read"], clientPublicKey: fill(0x0c, 32), folderScoped: true },
      { op: "cp-key-revoke", keyId: hex("ce7ee39cb8c5c4b32f954bf04d50757d"), revokedFrom: 1791150000000, rootSignature: fill(0x52, 64) },
      { op: "root-handover", newRoot: fill(0x4c, 32), ownerDevice: device, moveId: mutation, ownerSignature: fill(0x53, 64) },
    ];
    expect(Buffer.from(encodePolicyPayload(fixtureCert, 1791300000000, ops)).toString("hex")).toBe(PRIVATE_SYNC_OPS);
  });

  it("encodes approval-request as wire.cddl op 13 {0: 13, 1: device, 2: sas_commit}", () => {
    const payload = Buffer.from(encodePolicyPayload(fixtureCert, 1791300000000, [{ op: "approval-request", device, sasCommit: fill(0x5c, 32) }])).toString("hex");
    // The same bytes as mdbase-next's PolicyOp::ApprovalRequest (#144): map(3), key 0 = 13.
    expect(payload).toContain(`81a3000d0150${device.replaceAll("-", "")}025820${"5c".repeat(32)}`);
    expect(() => encodePolicyPayload(fixtureCert, 1, [{ op: "approval-request", device, sasCommit: fill(1, 31) }])).toThrow(/sas_commit/);
  });

  it("computes the digests the root and owner devices sign (policy/*.digests.txt)", () => {
    const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
    expect(toHex(certDigest(fixtureCert))).toBe("cd94bc8c53b4744dda7b3d0fb9517b5457c90bc5b63397b15e2843d63d0d023e");
    expect(toHex(keyRevocationDigest(keyId(fixtureCert.policyPublicKey), 1791150000000))).toBe("c633a641a6d301f4791097eb86b1de0b378903fc5b4443d9a7c93d1b6d1e7875");
    expect(toHex(rootHandoverDigest(legacy, 7, fill(0x4c, 32), "0192f3a4-6000-7abc-8def-0123456789ab"))).toBe("d625ab24f2b6fa112f0fbff1c9cd78a31d1e2cf1a6de5442f101a31be05fc6f9");
  });

  it("encodes the policy item envelope, its signed digest and chain hash", () => {
    const signer = hex("ce7ee39cb8c5c4b32f954bf04d50757d");
    const body = hex("a0");
    const item = encodePolicyItem(legacy, 1, fill(0, 32), signer, body, fill(0x5b, 64));
    expect(Buffer.from(item).toString("hex")).toBe(POLICY_ITEM);
    expect(Buffer.from(policyItemSignedDigest(legacy, 1, fill(0, 32), signer, body)).toString("hex"))
      .toBe("e4cc915f956f6d530cb584d90ac27ff747576a956b91fb3b61f0f8c7fb409900");
    expect(Buffer.from(chainHash(item)).toString("hex")).toBe("66a8beae1a4c500548adcdc6c67c01b16f44a2481dac4e4a8b26757d4a8937f1");
  });

  it("uses shortest-form integer heads and rejects non-canonical input", () => {
    expect(Buffer.from(encodeCbor([23, 24, 255, 256, 65535, 65536, -1, -25])).toString("hex")).toBe("8817181818ff19010019ffff1a00010000203818");
    expect(() => encodeCbor({ struct: [[2, 1], [1, 2]] })).toThrow(/ascending/);
    expect(() => encodeCbor(1.5)).toThrow(/integers only/);
    expect(() => encodeCbor("a\ud800b")).toThrow(/well-formed/);
  });

  it("can bound nesting and require canonical policy struct encoding without changing legacy decoding", () => {
    const nested = hex("81818100");
    expect(decodeCbor(nested)).toEqual([[[0]]]);
    expect(() => decodeCbor(nested,{maxDepth:1})).toThrow(/nesting/);
    expect(decodeCbor(nested,{maxDepth:3,canonicalStructs:true})).toEqual([[[0]]]);
    for (const noncanonical of [hex("1801"),hex("a201000000"),hex("a1616101")]) {
      expect(() => decodeCbor(noncanonical)).not.toThrow();
      expect(() => decodeCbor(noncanonical,{maxDepth:32,canonicalStructs:true})).toThrow(/noncanonical/);
    }
    expect(() => decodeCbor(hex("00"),{maxDepth:-1})).toThrow(/depth bound/);
  });
  it("signs an item that verifies under the certified policy key", () => {
    const { root, signerConfig } = environment(Date.now());
    const policy = loadPolicySigner(signerConfig, Date.now());
    const ops: PolicyOp[] = [{ op: "freeze", frozen: true }];
    const issuedAt = Date.now();
    const item = signPolicyItem(policy, { collection: legacy, seq: 2, prev: fill(7, 32), issuedAt, previousIssuedAt: issuedAt - 1, ops });
    const signature = item.subarray(item.length - 64);
    const signerId = keyId(policy.cert.policyPublicKey);
    const body = encodePolicyPayload(policy.cert, issuedAt, ops);
    expect(Buffer.from(item).equals(Buffer.from(encodePolicyItem(legacy, 2, fill(7, 32), signerId, body, signature)))).toBe(true);
    const digest = policyItemSignedDigest(legacy, 2, fill(7, 32), signerId, body);
    expect(verify(null, digest, ed25519PublicKeyObject(policy.cert.policyPublicKey), signature)).toBe(true);
    const base = { collection: legacy, seq: 2, prev: fill(7, 32), previousIssuedAt: 0, ops };
    expect(() => signPolicyItem(policy, { ...base, issuedAt: policy.cert.notAfter + 1 })).toThrow(/validity window/);
    expect(() => signPolicyItem(policy, { ...base, issuedAt: policy.cert.notBefore - 1 })).toThrow(/validity window/);
    expect(() => signPolicyItem(policy, { ...base, issuedAt, previousIssuedAt: issuedAt + 1 })).toThrow(/previous policy item/);
    expect(Buffer.from(policy.cert.root).equals(Buffer.from(keyId(ed25519RawPublicKey(root.publicKey))))).toBe(true);
  });
});

function environment(now: number) {
  const root = generateKeyPairSync("ed25519");
  const policy = generateKeyPairSync("ed25519");
  const rootPublicKey = ed25519RawPublicKey(root.publicKey);
  const unsigned = { policyPublicKey: ed25519RawPublicKey(policy.publicKey), notBefore: now - 1000, notAfter: now + 90 * 86_400_000, root: keyId(rootPublicKey) };
  const cert = { ...unsigned, signature: sign(null, certDigest(unsigned), root.privateKey) };
  const signerConfig = { logService: { url: "https://log.example", tokenIssuerKeyPem: "", transportKeyPem: "" }, rootPublicKey, policyPrivateKeyPem: policy.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), policyCert: certToJson(cert) };
  return { root, policy, cert, signerConfig };
}

describe("mdbase-next control-plane keys", () => {
  it("is disabled unless MDBASE_NEXT_CONTROL_PLANE=1, and refuses partial configuration", () => {
    expect(parseNextControlPlaneEnv({})).toBeNull();
    expect(parseNextControlPlaneEnv({ MDBASE_NEXT_CONTROL_PLANE: "0" })).toBeNull();
    expect(() => parseNextControlPlaneEnv({ MDBASE_NEXT_CONTROL_PLANE: "1" })).toThrow(/requires/);
    expect(() => parseNextControlPlaneEnv({ MDBASE_NEXT_CONTROL_PLANE: "yes" })).toThrow(/0 or 1/);
  });

  it("parses a complete configuration", () => {
    const { signerConfig } = environment(Date.now());
    const parsed = parseNextControlPlaneEnv({
      MDBASE_NEXT_CONTROL_PLANE: "1",
      MDBASE_NEXT_ROOT_PUBLIC_KEY: Buffer.from(signerConfig.rootPublicKey).toString("hex"),
      MDBASE_NEXT_POLICY_SIGNING_KEY: signerConfig.policyPrivateKeyPem,
      MDBASE_NEXT_POLICY_KEY_CERT: JSON.stringify(signerConfig.policyCert),
      MDBASE_NEXT_LOG_SERVICE_URL: "https://log.example",
      MDBASE_NEXT_LOG_TOKEN_SIGNING_KEY: signerConfig.policyPrivateKeyPem,
      MDBASE_NEXT_LOG_TRANSPORT_KEY: signerConfig.policyPrivateKeyPem,
    });
    expect(parsed?.policyCert).toEqual(signerConfig.policyCert);
  });

  it("refuses a certificate from another root, for another key, or near expiry", () => {
    const now = Date.now();
    const a = environment(now);
    const b = environment(now);
    expect(() => loadPolicySigner({ ...a.signerConfig, rootPublicKey: b.signerConfig.rootPublicKey }, now)).toThrow(/not signed/);
    expect(() => loadPolicySigner({ ...a.signerConfig, policyPrivateKeyPem: b.signerConfig.policyPrivateKeyPem }, now)).toThrow(/does not match/);
    expect(() => loadPolicySigner(a.signerConfig, a.cert.notAfter - 86_400_000)).toThrow(/rotate/);
    expect(() => loadPolicySigner(a.signerConfig, a.cert.notBefore - 1)).toThrow(/not valid yet/);
  });

  it("issues a certificate through the offline tool, showing what the root signs", () => {
    const root = generateKeyPairSync("ed25519");
    const dir = mkdtempSync(join(tmpdir(), "cp-cert-"));
    try {
      const rootFile = join(dir, "root.pem");
      writeFileSync(rootFile, root.privateKey.export({ format: "pem", type: "pkcs8" }).toString());
      const rootPk = Buffer.from(ed25519RawPublicKey(root.publicKey)).toString("hex");
      const policyPk = /public_key ([0-9a-f]{64})/.exec(runCpCertCommand(["policy-key"]))![1]!;
      const signed = runCpCertCommand(["sign-cert", rootFile, policyPk, "1000", "2000"]);
      expect(signed).toMatch(/^CERTIFY a control-plane policy key/);
      expect(signed).toContain(policyPk);
      const signature = /signature ([0-9a-f]{128})/.exec(signed)![1]!;
      const digest = /digest ([0-9a-f]{64})/.exec(runCpCertCommand(["cert-digest", policyPk, "1000", "2000", rootPk]))![1]!;
      expect(verify(null, Buffer.from(digest, "hex"), root.publicKey, Buffer.from(signature, "hex"))).toBe(true);
      const cert = JSON.parse(runCpCertCommand(["cert", policyPk, "1000", "2000", rootPk, signature])) as { policy_public_key: string };
      expect(cert.policy_public_key).toBe(policyPk);
      expect(() => runCpCertCommand(["cert", policyPk, "1000", "2000", rootPk, "00".repeat(64)])).toThrow(/does not verify/);
      const revocation = runCpCertCommand(["sign-revocation", rootFile, "ce7ee39cb8c5c4b32f954bf04d50757d", "1791150000000"]);
      expect(revocation).toMatch(/^REVOKE a control-plane policy key/);
      const revocationSignature = Buffer.from(/signature ([0-9a-f]{128})/.exec(revocation)![1]!, "hex");
      expect(verify(null, keyRevocationDigest(hex("ce7ee39cb8c5c4b32f954bf04d50757d"), 1791150000000), root.publicKey, revocationSignature)).toBe(true);
      expect(() => runCpCertCommand(["sign", rootFile, digest])).toThrow(/usage/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
