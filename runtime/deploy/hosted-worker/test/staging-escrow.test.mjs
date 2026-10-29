// Real Worker routing, native WASM generation, factory and SigV4/envelope path.
// Platform import, normalized build-trust/allowlist modules and AWS HTTP are test
// doubles. No live KMS, signed-publication or runtime-acceptance claim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { build } from "esbuild";
import { KMS_ALLOWLIST_SCHEMA, KMS_ALLOW_ALL_TEXT, canonicalKmsAllowlist, kmsAllowlistDigest } from "../src/custody/kms-allowlist.ts";

const collection = "11111111-1111-4111-8111-111111111111";
const foreign = "22222222-2222-4222-8222-222222222222";
const arn = "arn:aws:kms:eu-west-1:000000000000:key/33333333-3333-4333-8333-333333333333";
const token = "e".repeat(40);
const cp = "https://connect-staging.mdbase.dev", log = "https://log-staging.mdbase.dev";
const bytes = readFileSync(new URL("../hosted.wasm", import.meta.url));
const text = canonicalKmsAllowlist([collection]), sha256 = kmsAllowlistDigest(text);
const listBundle = { schema: KMS_ALLOWLIST_SCHEMA, text, sha256 };
const allSha256 = kmsAllowlistDigest(KMS_ALLOW_ALL_TEXT);
const allBundle = (role) => ({ schema: KMS_ALLOWLIST_SCHEMA, text: KMS_ALLOW_ALL_TEXT, sha256: allSha256, role });
const publicKey = (prefix, sk) => createPublicKey(createPrivateKey({ key: Buffer.concat([Buffer.from(prefix, "hex"), sk]),
  format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" }).subarray(12).toString("hex");
async function workerFor(environment, allowlist = listBundle) {
  const trust = environment === null ? "null" : `{schema:"mdbn-app-trust/release/1",environment:${JSON.stringify(environment)},
    cpOrigin:${JSON.stringify(cp)},logOrigin:${JSON.stringify(log)},assetSha256:"${"aa".repeat(32)}",
    source:{repository:"mdbase-dev/mdbase-connect",commit:"${"bb".repeat(20)}",version:"unit"},
    trustedRoots:[new Uint8Array(32).fill(0xab)],policyPins:Uint8Array.of(0x80)}`;
  const compiled = await build({ entryPoints: [new URL("../src/worker.ts", import.meta.url).pathname], bundle: true,
    write: false, format: "esm", platform: "node", plugins: [{ name: "platform-and-build-inputs-only", setup(b) {
      b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "platform", namespace: "fixture" }));
      b.onResolve({ filter: /^#hosted-release-trust$/ }, () => ({ path: "trust", namespace: "fixture" }));
      b.onResolve({ filter: /^#hosted-kms-collections$/ }, () => ({ path: "allowlist", namespace: "fixture" }));
      b.onLoad({ filter: /^platform$/, namespace: "fixture" }, () => ({ contents: "export class DurableObject {}" }));
      b.onLoad({ filter: /^trust$/, namespace: "fixture" }, () => ({ contents: `export function appReleaseTrust(){return ${trust};}` }));
      b.onLoad({ filter: /^allowlist$/, namespace: "fixture" }, () => ({ contents: `export function kmsCollections(){return ${JSON.stringify(allowlist)};}` }));
      b.onLoad({ filter: /hosted\.wasm$/ }, () => ({ contents: `export default new WebAssembly.Module(Uint8Array.from(atob('${bytes.toString("base64")}'), c => c.charCodeAt(0)));` }));
    } }] });
  return (await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`)).default;
}
const stageWorker = await workerFor("staging");
function env(change = {}) {
  return { SERVICE_KIND: "escrow", HOSTED_SERVICE_TOKEN: token, KMS_KEY_ARN: arn,
    AWS_REGION: "eu-west-1", AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "s".repeat(40),
    CP_INBOUND_TOKEN: "i".repeat(40), CP_URL: cp, LOG_URL: log,
    KMS_ENVIRONMENT: "staging", KMS_COLLECTIONS_SHA256: sha256,
    COLLECTIONS: { idFromName() { assert.fail("factory must not create a DO"); }, get() { assert.fail("factory must not open a DO"); } }, ...change };
}
function post(body = { collection }, auth = token) {
  return new Request("https://escrow.test/internal/v1/service-devices", {
    method: "POST", headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify(body),
  });
}

test("staging escrow uses native generation and next-escrow AWS context without LAB or actor lookup", async t => {
  let calls = 0;
  const plaintexts = [];
  t.mock.method(globalThis, "fetch", async request => {
    calls++; assert.equal(request.url, "https://kms.eu-west-1.amazonaws.com/");
    assert.equal(request.headers.get("x-amz-target"), "TrentService.Encrypt");
    assert.ok(request.headers.get("authorization").startsWith("AWS4-HMAC-SHA256 "));
    const body = await request.json();
    assert.equal(body.KeyId, arn);
    assert.equal(body.EncryptionAlgorithm, "SYMMETRIC_DEFAULT");
    const context = body.EncryptionContext;
    assert.deepEqual(context, { "mdbase:service": "next-escrow", "mdbase:environment": "staging",
      "mdbase:collection-id": collection, "mdbase:device-id": context["mdbase:device-id"],
      "mdbase:purpose": "device-key", "mdbase:envelope-version": "1" });
    const plaintext = Buffer.from(body.Plaintext, "base64"); assert.equal(plaintext.length, 96); plaintexts.push(plaintext);
    return Response.json({ KeyId: arn, EncryptionAlgorithm: "SYMMETRIC_DEFAULT", CiphertextBlob: "AQID" });
  });
  try {
    const records = [];
    for (let i = 0; i < 2; i++) {
      const response = await stageWorker.fetch(post(), env()); assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const record = await response.json(), secret = plaintexts[i]; records.push(record);
      assert.equal(record.kind, "escrow"); assert.equal(record.kms_key_arn, arn);
      assert.equal(record.sign_pk, publicKey("302e020100300506032b657004220420", secret.subarray(0, 32)));
      assert.equal(record.kem_pk, publicKey("302e020100300506032b656e04220420", secret.subarray(32, 64)));
      assert.equal(record.noise_pk, publicKey("302e020100300506032b656e04220420", secret.subarray(64, 96)));
      assert.deepEqual(Object.keys(record), ["kind", "device_id", "sign_pk", "kem_pk", "noise_pk", "wrapped_keys", "kms_key_arn"]);
    }
    assert.equal(calls, 2); assert.notEqual(records[0].device_id, records[1].device_id);
    assert.notEqual(records[0].sign_pk, records[1].sign_pk);
  } finally { for (const plaintext of plaintexts) plaintext.fill(0); }
});

test("no token/body role override, foreign collection, partial config or unbundled/LAB trust reaches AWS", async t => {
  let calls = 0; t.mock.method(globalThis, "fetch", async () => { calls++; assert.fail("unexpected AWS request"); });
  assert.equal((await stageWorker.fetch(post(undefined, "wrong"), env())).status, 401);
  for (const body of [{ collection, kind: "hosted" }, { collection, environment: "production" }]) {
    assert.equal((await stageWorker.fetch(post(body), env())).status, 400);
  }
  assert.equal((await stageWorker.fetch(post({ collection: foreign }), env())).status, 503);
  for (const change of [{ AWS_SECRET_ACCESS_KEY: "" }, { CP_URL: "https://foreign.test" },
    { LOG_URL: "https://foreign.test" }, { KMS_ENVIRONMENT: "lab" }, { KMS_COLLECTIONS_SHA256: "00".repeat(32) }]) {
    const response = await stageWorker.fetch(post(), env(change)); assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "custody_unavailable" });
  }
  for (const trust of [null, "lab"]) {
    const worker = await workerFor(trust);
    assert.equal((await worker.fetch(post(), env({ KMS_ENVIRONMENT: trust ?? "staging" }))).status, 503);
  }
  const prodWorker = await workerFor("production");
  for (const change of [{ KMS_ENVIRONMENT: "lab", LAB: "1", LAB_CUSTODY_WRAP_KEY: "ab".repeat(32) }, { KMS_ENVIRONMENT: "staging" }]) {
    assert.equal((await prodWorker.fetch(post(), env(change))).status, 503,
      "runtime LAB flags or a staging KMS env cannot downgrade/relabel a production trust bundle");
  }
  assert.equal(calls, 0);
});

test("KMS failures are closed generic responses with no retry or LAB fallback", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("SENSITIVE_PROVIDER_DETAIL", { status: 403 }); });
  const response = await stageWorker.fetch(post(), env());
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "custody_unavailable" });
  assert.equal(calls, 1);
});

async function generated(worker, environment, change, collections) {
  const contexts = [];
  const original = globalThis.fetch;
  globalThis.fetch = async request => {
    assert.equal(request.headers.get("x-amz-target"), "TrentService.Encrypt");
    const body = await request.json(); contexts.push(body.EncryptionContext);
    Buffer.from(body.Plaintext, "base64").fill(0);
    return Response.json({ KeyId: arn, EncryptionAlgorithm: "SYMMETRIC_DEFAULT", CiphertextBlob: "AQID" });
  };
  try {
    for (const id of collections) {
      const response = await worker.fetch(post({ collection: id }), env({ KMS_ENVIRONMENT: environment, ...change }));
      assert.equal(response.status, 200, `${environment} ${id}`);
      const record = await response.json();
      assert.equal(record.kind, "escrow"); assert.equal(record.kms_key_arn, arn);
      assert.deepEqual(contexts.at(-1), { "mdbase:service": "next-escrow", "mdbase:environment": environment,
        "mdbase:collection-id": id, "mdbase:device-id": record.device_id,
        "mdbase:purpose": "device-key", "mdbase:envelope-version": "1" });
    }
  } finally { globalThis.fetch = original; }
  return contexts.length;
}

test("production escrow generation: exact next-escrow production context for a listed collection", async () => {
  const worker = await workerFor("production");
  assert.equal(await generated(worker, "production", {}, [collection]), 1);
});

test("allow-all CP escrow (staging/production) generates for any collection; migration bindings or role/digest mismatch refuse", async t => {
  for (const environment of ["staging", "production"]) {
    const worker = await workerFor(environment, allBundle("escrow"));
    assert.equal(await generated(worker, environment, { KMS_COLLECTIONS_SHA256: allSha256 }, [collection, foreign]), 2);
  }
  let calls = 0; t.mock.method(globalThis, "fetch", async () => { calls++; assert.fail("unexpected AWS request"); });
  for (const environment of ["staging", "production"]) {
    const worker = await workerFor(environment, allBundle("escrow"));
    for (const change of [{ CP_MIGRATION_TOKEN: "m".repeat(40) }, { LEGACY_SOURCE_COLLECTIONS: collection }, { LEGACY_DB: {} },
      { KMS_COLLECTIONS_SHA256: sha256 }, { KMS_COLLECTIONS_SHA256: undefined }]) {
      const response = await worker.fetch(post(), env({ KMS_ENVIRONMENT: environment, KMS_COLLECTIONS_SHA256: allSha256, ...change }));
      assert.equal(response.status, 503, JSON.stringify(Object.keys(change)));
    }
    // A hosted-role allow-all module cannot serve the escrow service.
    const hosted = await workerFor(environment, allBundle("hosted"));
    assert.equal((await hosted.fetch(post(), env({ KMS_ENVIRONMENT: environment, KMS_COLLECTIONS_SHA256: allSha256 }))).status, 503);
  }
  for (const trust of [null, "lab"]) {
    const worker = await workerFor(trust, allBundle("escrow"));
    assert.equal((await worker.fetch(post(), env({ KMS_ENVIRONMENT: trust ?? "staging", KMS_COLLECTIONS_SHA256: allSha256 }))).status, 503);
  }
  assert.equal(calls, 0);
});
