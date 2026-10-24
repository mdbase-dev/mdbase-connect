// The production custody factory: fail closed on partial configuration, one
// collection per DO, hosted records only.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
// Test-only module replacement, never a shipped/runtime trust override.
let bundled = { schema: "mdbn-app-trust/release/1", environment: "lab", cpOrigin: "https://cp.test", logOrigin: "https://log.test",
  assetSha256: "aa".repeat(32), source: { repository: "mdbase-dev/mdbase-connect", commit: "bb".repeat(20), version: "unit" },
  trustedRoots: [new Uint8Array(32).fill(0xab)], policyPins: Uint8Array.of(0x80) };
const configured = bundled;
mock.module("#hosted-release-trust", { namedExports: { appReleaseTrust: () => bundled } });
// Test-only stand-in for the generated allowlist module (null = source default).
let allowlistModule = null;
mock.module("#hosted-kms-collections", { namedExports: { kmsCollections: () => allowlistModule } });
const { ProductionCustody, hostedPort, productionParts, productionWrapper, ownedCppControlOrigin } = await import("../src/factory.ts");
import { ControlClient } from "../src/control.ts";
import { LocalSoftwareKms } from "../src/custody/local-kms.ts";
import { localOrigin } from "../src/local-origin.ts";
import { connectClient } from "../src/migration-connect.ts";
import { encodeEnvelope } from "../src/custody/envelope.ts";
import { KMS_ALLOWLIST_SCHEMA, canonicalKmsAllowlist, kmsAllowlistDigest } from "../src/custody/kms-allowlist.ts";

const full = {
  KMS_KEY_ARN: "arn:aws:kms:eu-west-1:123456789012:key/11111111-1111-4111-8111-111111111111",
  AWS_REGION: "eu-west-1", AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "s".repeat(40),
  KMS_ENVIRONMENT: "lab", KMS_COLLECTIONS: "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e",
  LOG_URL: "https://log.test", CP_URL: "https://cp.test", CP_INBOUND_TOKEN: "t".repeat(40), CP_ROOTS: "ab".repeat(32),
  HOSTED_SIGNERS: "22222222-2222-4222-8222-222222222222",
};

test("CPP origin requires the actual fully configured factory's ControlClient object", () => {
  const parts = productionParts(full);
  assert.equal(ownedCppControlOrigin(parts.control), "https://cp.test");
  const manual = new ControlClient({ url: "https://cp.test", token: "t".repeat(40) });
  assert.equal(manual.cppClaimOriginData(), "https://cp.test", "parsed DATA is not provenance");
  assert.equal(ownedCppControlOrigin(manual), null);
  assert.equal(ownedCppControlOrigin({ cppClaimOriginData: () => "https://cp.test" }), null);
  assert.equal(ownedCppControlOrigin(Object.create(parts.control)), null);
  assert.equal(ownedCppControlOrigin(new Proxy(parts.control, {})), null);
  assert.equal(ownedCppControlOrigin({ ...parts, control: manual }.control), null);
  parts.control.cppClaimOriginData = () => "https://foreign.test";
  parts.control.base = "https://foreign.test";
  parts.control.cppOrigin = "https://foreign.test";
  assert.equal(ownedCppControlOrigin(parts.control), "https://cp.test", "captured intrinsic reads immutable private origin");
  for (const kind of ["hosted", "escrow"]) {
    const other = new ControlClient({ url: "https://cp.test", token: "t".repeat(40), kind });
    assert.equal(ownedCppControlOrigin(other), null);
  }
});

test("CPP origin DATA rejects non-origin configurations without changing ordinary ControlClient", () => {
  for (const url of ["https://u:p@cp.test", "https://cp.test/path", "https://cp.test?x", "https://cp.test#x"]) {
    const control = new ControlClient({ url, token: "t".repeat(40) });
    assert.equal(control.cppClaimOriginData(), null, url);
    assert.equal(ownedCppControlOrigin(control), null);
  }
  assert.equal(new ControlClient({ url: "https://cp.test", token: "t".repeat(40), kind: "escrow" }).cppClaimOriginData(), null);
  assert.equal(productionParts({ ...full, CP_URL: "https://foreign.test" }), null);
});

test("actual factory-owned transport keeps its original immutable HTTPS base", async () => {
  let called;
  const parts = productionParts(full, async (url) => { called = url; return new Response("", { status: 401 }); });
  parts.control.base = "https://foreign.test";
  parts.control.cppOrigin = "https://foreign.test";
  await assert.rejects(parts.control.serviceDevice("0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e", AbortSignal.timeout(1000)));
  assert.ok(called.startsWith("https://cp.test/"));
  assert.equal(ownedCppControlOrigin(parts.control), "https://cp.test");
});

test("managed builds reject local roots/KMS/HTTP even with local runtime configuration", () => {
  const local = { ...configured, environment: "local", cpOrigin: "http://127.0.0.1:8111", logOrigin: "http://127.0.0.1:8222" };
  const arn = "arn:local:kms:local:000000000000:key/11111111-1111-4111-8111-111111111111";
  const col = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
  bundled = local;
  assert.equal(productionParts({ ...full, KMS_ENVIRONMENT: "local", KMS_KEY_ARN: arn, LOCAL_KMS_KEY: "ab".repeat(32), CP_URL: local.cpOrigin, LOG_URL: local.logOrigin }), null);
  bundled = configured;
  for (const environment of ["local", "lab", "staging", "production"]) {
    assert.throws(() => new LocalSoftwareKms(arn, "ab".repeat(32), environment, [col]), /invalid_config/);
    assert.equal(localOrigin(local.cpOrigin, environment), false);
    assert.throws(() => new ControlClient({ url: local.cpOrigin, token: "t".repeat(40), environment }));
    assert.throws(() => connectClient({ url: local.cpOrigin, token: "t".repeat(40), environment }));
  }
  assert.equal(productionParts({ ...full, LOCAL_KMS_KEY: "ab".repeat(32) }), null);
});

test("fails closed unless fully configured", () => {
  assert.ok(productionParts(full));
  for (const k of Object.keys(full).filter((k) => k !== "KMS_COLLECTIONS" && k !== "CP_ROOTS" && k !== "HOSTED_SIGNERS")) {
    assert.equal(productionParts({ ...full, [k]: "" }), null, k);
  }
  assert.ok(productionParts({ ...full, CP_ROOTS: undefined }), "only bundle supplies authority");
  for (const HOSTED_SIGNERS of ["", undefined]) {
    assert.deepEqual(productionParts({ ...full, HOSTED_SIGNERS }).signers, [], "service devices have no external SAS signers");
  }
  for (const HOSTED_SIGNERS of ["not-a-uuid", "00000000-0000-0000-0000-000000000000", ",", full.HOSTED_SIGNERS + ",", Array(17).fill(full.HOSTED_SIGNERS).join(",")]) {
    assert.equal(productionParts({ ...full, HOSTED_SIGNERS }), null, "malformed/unbounded declarations still deny");
  }
  assert.equal(productionParts({ ...full, CP_ROOTS: "zz" }), null);
  assert.equal(productionParts({ ...full, LOG_URL: "https://wrong.test" }), null);
  bundled = null;
  assert.equal(productionParts(full), null, "unsigned runtime roots cannot replace missing build asset");
  bundled = configured;
  assert.equal(productionParts({ ...full, KMS_ENVIRONMENT: "dev" }), null);
  assert.equal(productionParts({ ...full, AWS_REGION: "us-east-1" }), null, "ARN region must match");
  assert.equal(productionParts({ ...full, CP_URL: "http://cp.test" }), null);
  assert.equal(productionWrapper(null), null);
  assert.ok(productionWrapper(productionParts(full)));
});

test("one collection per DO; replica ID asked once", async () => {
  let asked = 0;
  const failing = async () => { throw new TypeError("offline"); };
  const parts = productionParts(full, failing);
  const c = new ProductionCustody(parts, async () => { asked++; return "33333333-3333-4333-8333-333333333333"; }, () => null, () => false);
  const col = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
  await assert.rejects(c.openSealer(col, AbortSignal.timeout(1000)));
  await assert.rejects(c.logToken(col, AbortSignal.timeout(1000)));
  assert.equal(asked, 1);
  await assert.rejects(c.openSealer("1b1b1b1b-1b1b-4b1b-8b1b-1b1b1b1b1b1b", AbortSignal.timeout(1000)), /custody_unavailable/);
  c.close();
});

test("the port passes hosted records only", async () => {
  const rec = (kind) => async () => Response.json({ kind, device_id: "11111111-1111-4111-8111-111111111111", sign_pk: "aa".repeat(32),
    kem_pk: "bb".repeat(32), noise_pk: "cc".repeat(32), wrapped_keys: Buffer.from("e").toString("base64"), kms_key_arn: "arn:aws:kms:x", genesis: { seq: 1, item: "oA==", hash: "dd".repeat(32) } });
  const col = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
  const ok = await hostedPort(new ControlClient({ url: "https://cp.test", token: "t".repeat(40) }, rec("hosted"))).serviceDevice(col, AbortSignal.timeout(1000));
  assert.equal(ok.kind, "hosted");
  await assert.rejects(hostedPort(new ControlClient({ url: "https://cp.test", token: "t".repeat(40) }, rec("escrow"))).serviceDevice(col, AbortSignal.timeout(1000)));
});

test("terminal close: no custody is created or handed out after close; one instance under races", async () => {
  const parts = productionParts(full, async () => { throw new TypeError("offline"); });
  let release;
  const gate = new Promise((r) => { release = r; });
  let asked = 0;
  const c = new ProductionCustody(parts, async () => { asked++; await gate; return "33333333-3333-4333-8333-333333333333"; }, () => null, () => false);
  const col = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
  const a = c.openSealer(col, AbortSignal.timeout(1000));
  const b = c.logToken(col, AbortSignal.timeout(1000));
  c.close();
  release();
  await assert.rejects(a, /custody_aborted/);
  await assert.rejects(b, /custody_aborted/);
  assert.equal(asked, 1, "single flight");
  await assert.rejects(c.openSealer(col, AbortSignal.timeout(1000)), /custody_unavailable/);
});

test("terminal close after creation: a token minted during close is not handed out", async () => {
  const parts = productionParts(full, async () => { throw new TypeError("offline"); });
  const c = new ProductionCustody(parts, async () => "33333333-3333-4333-8333-333333333333", () => null, () => false);
  const col = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
  // Create the custody, then stand in for its token mint and close mid-flight.
  await assert.rejects(c.openSealer(col, AbortSignal.timeout(1000)));
  const inner = c["custody"];
  assert.ok(inner, "custody created");
  inner.logToken = async () => { c.close(); return "late-token"; };
  await assert.rejects(c.logToken(col, AbortSignal.timeout(1000)), /custody_aborted/);
});

test("bundled KMS allowlist: digest pinned by KMS_COLLECTIONS_SHA256, wins over the transitional secret, refuses non-members", async () => {
  const ids = Array.from({ length: 1_200 }, (_, i) => `${(i + 1).toString(16).padStart(8, "0")}-abcd-4000-8000-${(i + 1).toString(16).padStart(12, "0")}`);
  const text = canonicalKmsAllowlist(ids);
  const sha256 = kmsAllowlistDigest(text);
  allowlistModule = Object.freeze({ schema: KMS_ALLOWLIST_SCHEMA, sha256, text });
  try {
    const { KMS_COLLECTIONS: _secret, ...noSecret } = full;
    const pinned = { ...noSecret, KMS_COLLECTIONS_SHA256: sha256 };
    const parts = productionParts(pinned);
    assert.ok(parts, "1,200 bundled entries accepted");
    // Digest mismatch (or no declared digest) refuses: no custody parts at all.
    assert.equal(productionParts({ ...pinned, KMS_COLLECTIONS_SHA256: "00".repeat(32) }), null);
    assert.equal(productionParts(noSecret), null);
    // Transition: the secret may stay set only while it lists exactly the bundled set.
    assert.ok(productionParts({ ...pinned, KMS_COLLECTIONS: [...ids].reverse().join(",") }));
    assert.equal(productionParts({ ...pinned, KMS_COLLECTIONS: full.KMS_COLLECTIONS }), null, "data module wins; disagreement refuses");
    const arn = full.KMS_KEY_ARN, envelope = encodeEnvelope(arn, Uint8Array.of(1, 2, 3));
    await assert.rejects(parts.kms.unwrapDeviceKeys(full.KMS_COLLECTIONS, ids[0], envelope, arn, AbortSignal.timeout(1000)),
      (e) => e.message === "kms_collection_not_allowed", "a collection outside the bundled allowlist is refused");
    // A member passes the allowlist and reaches KMS (unreachable here).
    let reached = 0;
    const transport = productionParts(pinned, async () => { reached++; throw new TypeError("offline"); });
    await assert.rejects(transport.kms.unwrapDeviceKeys(ids[700], ids[0], envelope, arn, AbortSignal.timeout(1000)), /kms_unavailable/);
    assert.equal(reached, 1);
  } finally { allowlistModule = null; }
  assert.equal(productionParts({ ...full, KMS_COLLECTIONS_SHA256: "00".repeat(32) }), null, "declared digest without a bundled module refuses");
});
