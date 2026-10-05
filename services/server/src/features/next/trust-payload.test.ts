import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { certToJson, ed25519RawPublicKey } from "./policy-keys.js";
import { certDigest, keyId } from "./policy-wire.js";
import { encodeNextTrustPayload, validateNextTrustPayload, type NextTrustPayload, type NextTrustExpectation } from "./trust-payload.js";

// PUBLIC SYNTHETIC fixture seeds, never operational key material.
const key = (seed: number) => createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, seed)]), format: "der", type: "pkcs8" });
const root = key(17); const policy = key(23);
const rootPk = ed25519RawPublicKey(root); const policyPk = ed25519RawPublicKey(policy);
const h = (v: Uint8Array) => Buffer.from(v).toString("hex");
const unsigned = { policyPublicKey: policyPk, notBefore: 1000, notAfter: 20000, root: keyId(rootPk) };
const cert = certToJson({ ...unsigned, signature: sign(null, certDigest(unsigned), root) });
const fixture = (): NextTrustPayload => ({
  schema_version: 1, environment: "lab", control_plane_origin: "https://cp.example.test", log_origin: "https://log.example.test", issued_at: 10000,
  source: { repository: "mdbase-dev/mdbase-connect", commit: "a".repeat(40), version: "0.0.0-synthetic" },
  roots: [{ key_id: h(keyId(rootPk)), public_key: h(rootPk) }],
  policy_keys: [{ key_id: h(keyId(policyPk)), certificate: { ...cert } }]
});
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const expectation = (bytes: Uint8Array): NextTrustExpectation => ({
  environment: "lab", controlPlaneOrigin: "https://cp.example.test", logOrigin: "https://log.example.test", source: fixture().source, sha256: digest(bytes), now: 11000
});

describe("NEXT signed-release public trust asset", () => {
  it("roundtrips synthetic public pins using actual keyId/certificate crypto", () => {
    const bytes = encodeNextTrustPayload(fixture());
    expect(validateNextTrustPayload(bytes, expectation(bytes))).toEqual(fixture());
    expect(h(keyId(rootPk))).toEqual(createHash("sha256").update(rootPk).digest("hex").slice(0, 32));
  });
  it.each(["environment", "controlPlaneOrigin", "logOrigin", "sha256"] as const)("rejects a different authenticated %s", (field) => {
    const bytes = encodeNextTrustPayload(fixture());
    const expected = { ...expectation(bytes), [field]: field === "environment" ? "production" : field === "sha256" ? "0".repeat(64) : "https://other.example.test" };
    expect(() => validateNextTrustPayload(bytes, expected)).toThrow();
  });
  it.each(["repository", "commit", "version"] as const)("rejects different authenticated source %s", (field) => {
    const bytes = encodeNextTrustPayload(fixture());
    const expected = expectation(bytes); expected.source = { ...expected.source, [field]: "wrong" } as NextTrustPayload["source"];
    expect(() => validateNextTrustPayload(bytes, expected)).toThrow();
  });
  it("requires an authenticated digest even in LAB", () => {
    const bytes = encodeNextTrustPayload(fixture());
    expect(() => validateNextTrustPayload(bytes, { ...expectation(bytes), sha256: undefined! })).toThrow();
  });
  it("rejects noncanonical and duplicate-key JSON even if its digest was signed", () => {
    const good = Buffer.from(encodeNextTrustPayload(fixture())).toString();
    for (const text of [good + "\n", JSON.stringify(fixture()), good.replace('"schema_version":1', '"schema_version":1,"schema_version":1')]) {
      const bytes = Buffer.from(text);
      expect(() => validateNextTrustPayload(bytes, expectation(bytes))).toThrow("noncanonical");
    }
  });
  const invalid: Array<[string, (p: NextTrustPayload) => void]> = [
    ["unknown field", (p) => Object.assign(p, { unsigned_lab: true })],
    ["optional empty roots", (p) => { p.roots = []; }],
    ["optional empty policy keys", (p) => { p.policy_keys = []; }],
    ["root key ID", (p) => { p.roots[0]!.key_id = "0".repeat(32); }],
    ["policy key ID", (p) => { p.policy_keys[0]!.key_id = "0".repeat(32); }],
    ["duplicate root", (p) => { p.roots.push({ ...p.roots[0]! }); }],
    ["duplicate policy", (p) => { p.policy_keys.push({ ...p.policy_keys[0]! }); }],
    ["uncertified policy", (p) => { p.policy_keys[0]!.certificate.signature = "0".repeat(128); }],
    ["unknown root", (p) => { p.policy_keys[0]!.certificate.root_key_id = "0".repeat(32); }],
    ["wrong certificate field type", (p) => { Object.assign(p.policy_keys[0]!.certificate, { signature: [cert.signature] }); }],
    ["expired at issue", (p) => { p.issued_at = 20000; }],
    ["future certificate", (p) => { p.issued_at = 999; }],
    ["unsafe time", (p) => { p.issued_at = Number.MAX_SAFE_INTEGER + 1; }],
    ["origin path", (p) => { p.log_origin += "/"; }],
    ["origin query", (p) => { p.log_origin += "?x=1"; }],
    ["origin credentials", (p) => { p.log_origin = "https://u@log.example.test"; }],
    ["origin HTTP", (p) => { p.log_origin = "http://log.example.test"; }],
    ["noncanonical origin", (p) => { p.log_origin = "https://LOG.example.test:443"; }]
  ];
  it.each(invalid)("rejects %s", (_label, mutate) => {
    const p = fixture(); mutate(p); expect(() => encodeNextTrustPayload(p)).toThrow();
  });
  it("rejects future issue, oversized input, invalid UTF-8 and malformed JSON", () => {
    const bytes = encodeNextTrustPayload(fixture());
    expect(() => validateNextTrustPayload(bytes, { ...expectation(bytes), now: 9999 })).toThrow();
    for (const b of [Buffer.alloc(65537), Buffer.from([0xff]), Buffer.from("{")]) expect(() => validateNextTrustPayload(b, expectation(b))).toThrow();
  });
  it("matches the portable public synthetic vector", () => {
    const bytes = encodeNextTrustPayload(fixture());
    const v = JSON.parse(readFileSync(new URL("../../../../../packages/protocol/test/fixtures/next-trust.v1.json", import.meta.url), "utf8"));
    expect(v.payload).toEqual(fixture()); expect(v.canonical_utf8).toEqual(Buffer.from(bytes).toString()); expect(v.sha256).toEqual(digest(bytes));
  });
});
