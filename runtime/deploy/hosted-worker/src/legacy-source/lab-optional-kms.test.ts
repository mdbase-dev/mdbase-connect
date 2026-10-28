// Optional LAB custody, never an inferred wrapping mode.
// Public synthetic settings + unchanged Rust provider KAT bytes; no provider I/O.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { LegacyBindingError, legacyBindingSettings, openLegacySource, type LegacySourceEnv } from "./bindings.ts";
import { LegacyCryptoError, openEnvelope, unwrapCollectionKey } from "./crypto.ts";

const names = ["LEGACY_KMS_REGION", "LEGACY_KMS_KEY_ARNS", "LEGACY_KMS_ACCESS_KEY_ID",
  "LEGACY_KMS_SECRET_ACCESS_KEY", "LEGACY_KMS_SESSION_TOKEN", "LEGACY_KMS_CREDENTIALS_EXPIRES_AT"] as const;
const cid = "01911111-1111-7111-8111-111111111111";
const secret = "public-unit-only-dedicated-legacy-secret";
const values = ["us-east-1", "arn:aws:kms:us-east-1:000000000000:key/11111111-1111-4111-8111-111111111111",
  "AKIALEGACYDUMMY000001", secret, "public-unit-only-token", String(Date.now() + 3_600_000)];
function env(tier: "lab" | "staging" | "production" = "lab"): LegacySourceEnv {
  return { ...(tier === "lab" ? { LAB: "1" } : {}), KMS_ENVIRONMENT: tier,
    LEGACY_SOURCE_ENVIRONMENT: tier, LEGACY_SOURCE_COLLECTIONS: cid,
    LEGACY_DB: { connectionString: "postgresql://public:unit@synthetic.invalid/legacy" },
    LEGACY_R2_ENDPOINT: "https://00000000000000000000000000000000.r2.cloudflarestorage.com",
    LEGACY_R2_BUCKET: "legacy-unit-test", LEGACY_R2_ACCESS_KEY_ID: "public-unit-r2-access-key",
    LEGACY_R2_SECRET_ACCESS_KEY: "public-unit-r2-secret-key", LEGACY_MASTER_KEY: Buffer.alloc(32, 7).toString("base64") };
}
const refusal = (code: string) => (e: unknown) => e instanceof LegacyBindingError && e.code === code
  && !e.message.includes(secret) && !e.message.includes(values[1]);
const fixture = JSON.parse(readFileSync(new URL("../../test/fixtures/provider-wrapping-vectors.json", import.meta.url), "utf8"));
const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));

test("LAB with no provider KMS set admits a lazy source without native credential fallback", async () => {
  const e = env();
  for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION"]) {
    Object.defineProperty(e, name, { get() { assert.fail("native credential/settings fallback"); } });
  }
  const settings = legacyBindingSettings(e);
  assert.equal(settings.kms, undefined); assert.equal(settings.kmsCredentials, undefined);
  const source = await openLegacySource(e, cid, { connect() { assert.fail("lazy binding must not create pg client"); },
    fetch: async () => { assert.fail("no source/KMS network I/O"); } });
  assert.equal(source.collection, cid);
  assert.throws(() => legacyBindingSettings({ ...env(), LEGACY_MASTER_KEY: undefined }), refusal("legacy_source_unconfigured"));
});

test("LAB without KMS opens the unchanged real Rust local-wrapping KAT and payload", async () => {
  const v = fixture.cases.find((v: { name: string }) => v.name === "lab-local"); assert.ok(v);
  const settings = legacyBindingSettings(env()); assert.equal(settings.kms, undefined);
  const master = await crypto.subtle.importKey("raw", settings.masterKey, "AES-GCM", false, ["decrypt"]);
  settings.masterKey.fill(0);
  const key = await unwrapCollectionKey({ environment: settings.tier, legacyMasterKey: master }, bytes(v.wrappedKeyHex), cid, new AbortController().signal);
  assert.equal(key.extractable, false); assert.deepEqual(key.usages, ["decrypt"]);
  assert.deepEqual(await openEnvelope(key, bytes(v.payloadCiphertextHex), bytes(v.payloadAadHex)), bytes(v.payloadPlaintextHex));
});

test("LAB without KMS refuses both real Rust MDBK KATs at unwrap, even with the correct local master", async () => {
  const settings = legacyBindingSettings(env()); assert.equal(settings.kms, undefined);
  const master = await crypto.subtle.importKey("raw", settings.masterKey, "AES-GCM", false, ["decrypt"]);
  settings.masterKey.fill(0);
  const vectors = fixture.cases.filter((v: { environment: string; mode: string }) => v.environment === "lab" && v.mode === "mdbk-v1-aws-kms-scheme-1");
  assert.equal(vectors.length, 2);
  for (const v of vectors) await assert.rejects(unwrapCollectionKey({ environment: settings.tier, legacyMasterKey: master },
    bytes(v.wrappedKeyHex), cid, new AbortController().signal), (e: unknown) => e instanceof LegacyCryptoError
      && e.code === "kms" && e.constructor.name === "LegacyKmsUnconfiguredError");
});

test("LAB rejects every partial KMS set, including orphan optional token/expiry, without echoing values", () => {
  for (let mask = 1; mask < 64; mask++) {
    if ((mask & 15) === 15) continue; // Core is complete; ordinary token/expiry validation owns these cases.
    const e = env(); names.forEach((name, i) => { if (mask & (1 << i)) e[name] = values[i]; });
    assert.throws(() => legacyBindingSettings(e), refusal("legacy_source_misconfigured"), `partial mask ${mask}`);
  }
  for (const name of names) for (const value of ["", null]) {
    assert.throws(() => legacyBindingSettings({ ...env(), [name]: value }), refusal("legacy_source_misconfigured"), name);
  }
});

test("LAB complete dedicated KMS core and complete STS set retain the normal transport config", () => {
  for (const count of [4, 6]) {
    const e = env(); names.slice(0, count).forEach((name, i) => { e[name] = values[i]; });
    const settings = legacyBindingSettings(e); assert.ok(settings.kms); assert.ok(settings.kmsCredentials);
    assert.equal(settings.kms.environment, "lab"); assert.deepEqual(settings.kms.collections, [cid]);
    assert.equal(settings.kmsCredentials.accessKeyId, values[2]);
    assert.equal(settings.kmsCredentials.sessionToken, count === 6 ? values[4] : undefined);
  }
});

for (const tier of ["staging", "production"] as const) test(`${tier} still requires the entire dedicated KMS core`, () => {
  assert.throws(() => legacyBindingSettings(env(tier)), refusal("legacy_source_unconfigured"));
  for (let missing = 0; missing < 4; missing++) {
    const e = env(tier); names.slice(0, 4).forEach((name, i) => { if (i !== missing) e[name] = values[i]; });
    assert.throws(() => legacyBindingSettings(e), refusal("legacy_source_unconfigured"), names[missing]);
  }
});
