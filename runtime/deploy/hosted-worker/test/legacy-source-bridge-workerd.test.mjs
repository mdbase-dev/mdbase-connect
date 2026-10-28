// Hermetic COMPOSITION UNIT tests, real workerd/DO SQLite/WebCrypto:
// actual migration-worker entry -> inherited HostedCollection.migrationExecutor
// -> genuine MigrationExecutor wake -> inherited legacyMigrationSource
// -> real openLegacySource/BoundLegacySource -> real encrypted record reader.
// ONLY pg.Client (transport/rows), KMS HTTP, and native MigrationHost are fakes.
// WASM is absent: no engine/admission/CPP/native ledger/security qualification,
// live DB grants/TLS/Hyperdrive, authentic release, real AWS, deployed custody,
// provider-writer LAB-context record creation, or migration completion is proven.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const root = fileURLToPath(new URL("../", import.meta.url));
const CID = "0b6b7f4e-3c1d-4e2a-9f8b-5a6c7d8e9f01";
const FOREIGN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RID = "0192f0c1-7e1a-7b3c-8d4e-000000000001";
const HOLD = "5e1d2c3b-4a59-4687-9a0b-1c2d3e4f5a6b";
const enc = new TextEncoder();
const b64 = bytes => Buffer.from(bytes).toString("base64");
const tuple = values => enc.encode(JSON.stringify(values));
const MODES = ["local-aes-gcm-v1", "mdbk-v1-aws-kms-scheme-1"];
const TIERS = ["lab", "staging", "production"];
function removeKms(env) {
  for (const name of ["LEGACY_KMS_REGION", "LEGACY_KMS_KEY_ARNS", "LEGACY_KMS_ACCESS_KEY_ID",
    "LEGACY_KMS_SECRET_ACCESS_KEY", "LEGACY_KMS_SESSION_TOKEN", "LEGACY_KMS_CREDENTIALS_EXPIRES_AT"]) delete env[name];
}
const LEGACY_ACCESS = "AKIALEGACYDUMMY000001";
const LEGACY_SECRET = "legacy-public-test-only-not-a-real-secret";
const NATIVE_ACCESS = "AKIANATIVEDUMMY000001";
const NATIVE_SECRET = "native-public-test-only-not-a-real-secret";

const compiled = await build({
  entryPoints: [root + "test/fixtures/legacy-source-bridge-worker.mjs"],
  bundle: true, write: false, format: "esm", platform: "browser", external: ["cloudflare:workers"],
  banner: { js: `
    globalThis.__bridgeImports = [];
    globalThis.__bridgeFetches = [];
    const bridgeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = function(input, init) {
      const request = new Request(input, init);
      globalThis.__bridgeFetches.push({ url: request.url, method: request.method, redirect: request.redirect });
      return bridgeFetch(request);
    };
    const bridgeImportKey = crypto.subtle.importKey.bind(crypto.subtle);
    crypto.subtle.importKey = function(format, key, algorithm, extractable, usages) {
      globalThis.__bridgeImports.push({ format, algorithm: typeof algorithm === "string" ? algorithm : algorithm.name, extractable, usages });
      return bridgeImportKey(format, key, algorithm, extractable, usages);
    };
  ` },
  plugins: [{ name: "bridge-unit-boundaries-only", setup(b) {
    b.onResolve({ filter: /^pg$/ }, () => ({ path: root + "test/fixtures/legacy-source-bridge-pg.mjs" }));
    b.onResolve({ filter: /hosted\.wasm$/ }, () => ({ path: "unused", namespace: "bridge-no-wasm" }));
    b.onLoad({ filter: /.*/, namespace: "bridge-no-wasm" }, () => ({ contents: "export default undefined;" }));
  } }],
});

async function seal(raw, plain, aad) {
  const key = await webcrypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, plain));
  return Uint8Array.from([1, ...iv, ...ct]);
}
function mdbk(ref, ciphertext) {
  const r = enc.encode(ref), out = new Uint8Array(12 + r.length + ciphertext.length);
  out.set(enc.encode("MDBK")); out[4] = 1; out[5] = 1;
  const view = new DataView(out.buffer);
  view.setUint16(6, r.length); view.setUint32(8, ciphertext.length);
  out.set(r, 12); out.set(ciphertext, 12 + r.length);
  return out;
}
async function fixture(tier, mode) {
  const n = TIERS.indexOf(tier) + 1;
  // PUBLIC DUMMY material, deliberately distinct per tier. Never read ambient
  // AWS/legacy settings, databases, cloud credentials, or a live LAB fixture.
  const master = new Uint8Array(32).fill(10 + n), dek = new Uint8Array(32).fill(20 + n);
  const keyArn = `arn:aws:kms:us-east-1:00000000000${n}:key/11111111-1111-4111-8111-111111111111`;
  const currentArn = `arn:aws:kms:us-east-1:00000000000${n}:key/22222222-2222-4222-8222-222222222222`;
  const ciphertext = Uint8Array.from([0x71, 0x22, n, 0x44]);
  const document = `---\ntitle: ${tier} bridge unit\n---\nActual authenticated AES record (${mode}).\n`;
  const revision = "sha256:" + Buffer.from(await webcrypto.subtle.digest("SHA-256", enc.encode(document))).toString("hex");
  const record = await seal(dek, enc.encode(JSON.stringify({ record_id: RID, path: "notes/bridge.md", document, revision })),
    tuple(["current_record", CID, RID, 40]));
  const wrapped = mode === MODES[0] ? await seal(master, dek, tuple(["collection_key", CID])) : mdbk(keyArn, ciphertext);
  const connectionString = `postgresql://mdbn_hosted_legacy_reader:public-unit-only@hyperdrive-${tier}.invalid:5432/legacy_unit`;
  const data = { collection: CID, hold: HOLD, recordId: RID, revision, wrapped: b64(wrapped), payload: b64(record), connectionString };
  const env = {
    ...(tier === "lab" ? { LAB: "1" } : {}), KMS_ENVIRONMENT: tier,
    LEGACY_SOURCE_ENVIRONMENT: tier, LEGACY_SOURCE_COLLECTIONS: CID, LEGACY_DB: { connectionString },
    LEGACY_MASTER_KEY: b64(master),
    LEGACY_R2_ENDPOINT: "https://00000000000000000000000000000000.r2.cloudflarestorage.com",
    LEGACY_R2_BUCKET: "legacy-unit-test", LEGACY_R2_ACCESS_KEY_ID: "r2-public-unit-access-key",
    LEGACY_R2_SECRET_ACCESS_KEY: "r2-public-unit-secret-key",
    LEGACY_KMS_REGION: "us-east-1", LEGACY_KMS_KEY_ARNS: `${currentArn},${keyArn}`,
    LEGACY_KMS_ACCESS_KEY_ID: LEGACY_ACCESS, LEGACY_KMS_SECRET_ACCESS_KEY: LEGACY_SECRET,
    // Deliberately present and DIFFERENT: legacy source may never use these.
    AWS_ACCESS_KEY_ID: NATIVE_ACCESS, AWS_SECRET_ACCESS_KEY: NATIVE_SECRET,
    FOREIGN, FIXTURE: data,
  };
  return { env, data, tier, mode, document, dek, keyArn, ciphertext };
}
const emptyTrace = { clients: [], queries: [], connects: 0, ends: 0 };
function noIO(reply, requests) {
  assert.deepEqual(reply.trace, emptyTrace, "no pg constructor, connection, query or teardown");
  assert.deepEqual(requests, [], "zero object/KMS/control-plane network I/O");
  assert.deepEqual(reply.fetches, [], "not even an attempted global fetch");
}

async function runtime(f, work) {
  const prefix = root + ".test-state/legacy-source-bridge-";
  mkdirSync(dirname(prefix), { recursive: true });
  const scratch = mkdtempSync(prefix), oldTmp = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
  const requests = [], violations = [];
  let mf, passed = false;
  try {
    mf = new Miniflare(convertV4MiniflareOptions({ name: "legacy-source-bridge-unit", modules: true,
      script: compiled.outputFiles[0].text, compatibilityDate: "2026-10-05", compatibilityFlags: ["nodejs_compat"], port: 0,
      durableObjects: { PROBE: { className: "BridgeProbe", useSQLite: true } }, bindings: f.env,
      resourcePersistencePath: scratch, resourceTmpPath: scratch,
      // Every global fetch, including accidental object/CP requests, is trapped.
      // Never grant arbitrary endpoint permission or permit real AWS egress.
      outboundService: async request => {
        const body = await request.text();
        requests.push({ url: request.url, method: request.method, body, authorization: request.headers.get("authorization") });
        try {
          assert.equal(request.url, "https://kms.us-east-1.amazonaws.com/");
          assert.equal(request.method, "POST");
          // Miniflare's Node outbound bridge reconstructs Request.redirect as
          // "follow". Assert the original in-Worker Request metadata below.
          assert.equal(request.headers.get("x-amz-target"), "TrentService.Decrypt");
          assert.equal(request.headers.get("content-type"), "application/x-amz-json-1.1");
          assert.match(request.headers.get("authorization") ?? "", new RegExp(`^AWS4-HMAC-SHA256 Credential=${LEGACY_ACCESS}/[0-9]{8}/us-east-1/kms/aws4_request,`));
          assert.ok(!request.headers.get("authorization").includes(NATIVE_ACCESS));
          assert.deepEqual(JSON.parse(body), { CiphertextBlob: b64(f.ciphertext), EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
            EncryptionContext: { "mdbase:service": "hosted-provider", "mdbase:environment": f.tier,
              "mdbase:purpose": "collection-data-key", "mdbase:envelope-version": "1", "mdbase:collection-id": CID } });
          return Response.json({ Plaintext: b64(f.dek), KeyId: f.keyArn, EncryptionAlgorithm: "SYMMETRIC_DEFAULT" });
        } catch (error) {
          violations.push(error);
          return new Response("fixture_boundary_refused", { status: 500 });
        }
      },
    }));
    const call = async path => {
      const res = await mf.dispatchFetch("http://bridge-unit.invalid" + path);
      assert.equal(res.status, 200, await res.clone().text());
      assert.deepEqual(violations.map(error => error.message), [], "exact KMS transport boundary");
      return res.json();
    };
    await work(call, requests);
    assert.deepEqual(violations, [], "transport must satisfy the exact synthetic KMS boundary contract");
    passed = true;
  } finally {
    await mf?.dispose();
    if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
    if (passed) rmSync(scratch, { recursive: true, force: true });
    else console.error(`Retained synthetic bridge-unit state: ${scratch}`);
  }
}

for (const [tier, mode, noKms] of [...TIERS.flatMap(tier => MODES.map(mode => [tier, mode, false])), ["lab", MODES[0], true]]) {
  test(`composition unit: ${tier}/${mode}${noKms ? " without provider KMS" : ""} inherited executor opens and decrypts a real encrypted record`, async () => {
    const f = await fixture(tier, mode);
    if (noKms) removeKms(f.env);
    await runtime(f, async (call, requests) => {
      const entry = await call("/entry");
      assert.equal(entry.defaultPreserved, true); assert.equal(entry.inherited, true); assert.equal(entry.installed, true);
      assert.deepEqual(entry.imports, [], "entry installation and original Worker constructor import NO key");
      noIO(entry, requests);
      const bound = await call("/bound");
      assert.equal(bound.bound, true); assert.equal(bound.realSource, true); assert.equal(bound.collection, CID);
      noIO(bound, requests); // Binding is lazy for pg/S3/KMS, not for local key import.
      assert.deepEqual(bound.imports, [{ format: "raw", algorithm: "AES-GCM", extractable: false, usages: ["decrypt"] }]);
      const reply = await call("/wake");
      assert.equal(reply.realExecutor, true);
      assert.deepEqual(reply.result, { state: "done", reason: null, nextAt: null });
      assert.deepEqual(reply.calls, ["prepare:2", "prepare:3"]);
      assert.equal(reply.native.outstanding, null);
      assert.equal(reply.settlements.length, 2);
      const opened = reply.settlements[0];
      assert.equal(opened.kind, 2); assert.equal(opened.result.kind, "opened");
      assert.deepEqual({ ...opened.result.request, retainUntil: null }, { collection: CID, S0: 40,
        expectedState: "migrating", backupHold: HOLD, retainUntil: null });
      assert.ok(Date.parse(opened.result.request.retainUntil) > Date.now());
      const page = reply.settlements[1].result;
      assert.equal(page.kind, "page"); assert.equal(page.session, opened.result.session); assert.equal(page.after, null);
      assert.equal(page.page.table, "records");
      assert.deepEqual(page.page.page, { collection: CID, S0: 40, holdExpiresAt: "2099-01-01T00:00:00.000Z",
        next: RID, done: true, rows: [{ recordId: RID, path: "notes/bridge.md", revision: f.data.revision,
          sequence: 40, documentBytes: enc.encode(f.document).length, document: f.document, contentRef: null }] });
      assert.deepEqual(reply.trace.clients, [{ connectionString: f.data.connectionString }, { connectionString: f.data.connectionString }]);
      assert.equal(reply.trace.connects, 2); assert.equal(reply.trace.ends, 2, "snapshot and wake-scoped hold frontend end");
      const queries = reply.trace.queries;
      assert.equal(queries[0].sql, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      assert.equal(queries.at(-1).sql, "ROLLBACK");
      const holdQueries = queries.filter(q => q.sql.startsWith("SELECT expires_at"));
      assert.equal(holdQueries.length, 2); assert.ok(holdQueries.every(q => q.client === 1));
      assert.ok(queries.filter(q => /^(SELECT|SHOW)\b/.test(q.sql) && !q.sql.startsWith("SELECT expires_at")).every(q => q.client === 0));
      assert.ok(queries.filter(q => q.sql === "BEGIN READ ONLY").every(q => q.client === 1));
      assert.ok(queries.every(q => /^(SELECT|SHOW)\b/.test(q.sql) || ["ROLLBACK", "BEGIN READ ONLY", "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"].includes(q.sql)));
      const aes = reply.imports.filter(i => i.algorithm === "AES-GCM");
      assert.equal(aes.length, 3, "one direct bind, executor bind, and collection DEK");
      assert.ok(aes.every(i => !i.extractable && JSON.stringify(i.usages) === '["decrypt"]'));
      assert.equal(requests.length, mode === MODES[1] ? 1 : 0, "no object/CP egress; KMS Decrypt only in managed envelope mode");
      assert.deepEqual(reply.fetches, mode === MODES[1] ? [{ url: "https://kms.us-east-1.amazonaws.com/", method: "POST", redirect: "manual" }] : []);
    });
  });
}

for (const tier of TIERS) {
  const negatives = [
    ["wrong source tier", env => { env.LEGACY_SOURCE_ENVIRONMENT = tier === "production" ? "staging" : "production"; }, "legacy_source_misconfigured"],
    ["conflicting LAB/native tier", env => { if (tier === "lab") env.KMS_ENVIRONMENT = "production"; else env.LAB = "1"; }, "legacy_source_misconfigured"],
    ["unselected native tier", env => { if (tier === "lab") delete env.LAB; else delete env.KMS_ENVIRONMENT; }, "legacy_source_unconfigured"],
    ["caller-like KMS endpoint region", env => { env.LEGACY_KMS_REGION = "us-east-1.example.invalid"; }, "legacy_source_misconfigured"],
    ["foreign R2 endpoint", env => { env.LEGACY_R2_ENDPOINT = "https://unapproved-unit.invalid"; }, "legacy_source_misconfigured"],
    ["missing KMS region", env => { delete env.LEGACY_KMS_REGION; }, tier === "lab" ? "legacy_source_misconfigured" : "legacy_source_unconfigured"],
    ["missing KMS approved keys", env => { delete env.LEGACY_KMS_KEY_ARNS; }, tier === "lab" ? "legacy_source_misconfigured" : "legacy_source_unconfigured"],
    ["missing dedicated credentials despite native AWS credentials", env => { delete env.LEGACY_KMS_ACCESS_KEY_ID; delete env.LEGACY_KMS_SECRET_ACCESS_KEY; }, tier === "lab" ? "legacy_source_misconfigured" : "legacy_source_unconfigured"],
    ...(tier === "lab" ? [] : [["entire provider KMS set absent", removeKms, "legacy_source_unconfigured"]]),
    ["unconfigured legacy master", env => { delete env.LEGACY_MASTER_KEY; }, "legacy_source_unconfigured"],
  ];
  for (const [name, mutate, code] of negatives) test(`composition unit: ${tier} ${name} refuses before all I/O/key imports`, async () => {
    const f = await fixture(tier, MODES[0]); mutate(f.env);
    await runtime(f, async (call, requests) => {
      const reply = await call("/wake");
      assert.equal(reply.realExecutor, true);
      assert.deepEqual(reply.result, { state: "stopped", reason: `source_refused:${code}`, nextAt: null });
      assert.deepEqual(reply.settlements, []); assert.deepEqual(reply.imports, []);
      noIO(reply, requests);
    });
  });
  test(`composition unit: ${tier} foreign collection and foreign checkpoint refuse before I/O`, async () => {
    const f = await fixture(tier, MODES[1]);
    await runtime(f, async (call, requests) => {
      const outside = await call(`/bound?collection=${FOREIGN}`);
      assert.equal(outside.code, "legacy_source_foreign_collection"); assert.deepEqual(outside.imports, []); noIO(outside, requests);
      const checkpoint = await call("/foreign-checkpoint");
      assert.equal(checkpoint.code, "legacy_source_foreign_collection"); noIO(checkpoint, requests);
      const wake = await call(`/wake?collection=${FOREIGN}`);
      assert.deepEqual(wake.result, { state: "stopped", reason: "source_refused:legacy_source_foreign_collection", nextAt: null });
      assert.deepEqual(wake.settlements, []); noIO(wake, requests);
    });
  });
}

test("composition unit: LAB MDBK without provider KMS stops at unwrap, closes both frontends, never retries or settles", async () => {
  const f = await fixture("lab", MODES[1]); removeKms(f.env);
  await runtime(f, async (call, requests) => {
    const reply = await call("/wake");
    assert.deepEqual(reply.result, { state: "stopped", reason: "source_refused:legacy_source_unconfigured", nextAt: null });
    assert.deepEqual(reply.settlements, []); assert.deepEqual(reply.calls, ["prepare:2", "release:2"]);
    assert.deepEqual(reply.native.outstanding, { seq: 1, kind: 2 }, "RAM release is not negative settlement or UNKNOWN adoption");
    assert.equal(reply.run.state, "stopped");
    assert.equal(reply.trace.connects, 2); assert.equal(reply.trace.ends, 2);
    assert.equal(reply.trace.queries.at(-1).sql, "ROLLBACK");
    assert.deepEqual(reply.imports, [{ format: "raw", algorithm: "AES-GCM", extractable: false, usages: ["decrypt"] }]);
    assert.deepEqual(requests, []); assert.deepEqual(reply.fetches, []);
  });
});

test("composition unit: LAB source also admits unset native KMS_ENVIRONMENT without relabeling provider context", async () => {
  const f = await fixture("lab", MODES[1]); delete f.env.KMS_ENVIRONMENT;
  await runtime(f, async (call, requests) => {
    const reply = await call("/wake");
    assert.deepEqual(reply.result, { state: "done", reason: null, nextAt: null });
    assert.equal(reply.settlements[1].result.page.page.rows[0].document, f.document);
    assert.equal(requests.length, 1); // boundary checks exact provider environment "lab"
  });
});

for (const tier of TIERS) test(`composition unit: ${tier} original constructor and terminal runs need no legacy custody/factory`, async () => {
  const f = await fixture(tier, MODES[0]);
  for (const name of Object.keys(f.env)) if (name.startsWith("LEGACY_")) delete f.env[name];
  await runtime(f, async (call, requests) => {
    const unset = await call("/unset"); assert.equal(unset.installed, false);
    const entry = await call("/entry"); noIO(entry, requests); assert.deepEqual(entry.imports, []);
    assert.equal(entry.installed, false); assert.equal(entry.defaultPreserved, true);
    for (const [path, state, reason] of [["/retired", "done", null], ["/stopped", "stopped", "operator_stop"]]) {
      const reply = await call(path);
      assert.equal(reply.realExecutor, true); assert.deepEqual(reply.result, { state, reason, nextAt: null });
      assert.deepEqual(reply.settlements, []); assert.deepEqual(reply.imports, []); noIO(reply, requests);
    }
    const active = await call("/wake");
    assert.deepEqual(active.result, { state: "stopped", reason: "source_refused:legacy_source_unconfigured", nextAt: null });
    assert.deepEqual(active.settlements, []); assert.deepEqual(active.imports, []); noIO(active, requests);
    if (tier === "lab") assert.deepEqual(await call("/health"), { status: "ok" });
  });
});
