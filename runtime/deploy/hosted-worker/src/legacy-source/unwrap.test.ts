import assert from "node:assert/strict";
import test from "node:test";
import { aad, kmsContext, LegacyCryptoError, openEnvelope, parseWrappedKey, sameKmsKey, unwrapCollectionKey } from "./crypto.ts";
import type { LegacyUnwrapper } from "./crypto.ts";

// Synthetic keys and envelopes only, never a deployment/source fixture.
const CID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ARN = "arn:aws:kms:us-east-1:000000000000:key/33333333-3333-4333-8333-333333333333";
const OLD = ARN.replace("33333333", "44444444");
const MRK = "arn:aws:kms:us-east-1:000000000000:key/mrk-123456789012345678901234567890ab";
const signal = () => new AbortController().signal;
const safeError = (code: LegacyCryptoError["code"]) => (e: unknown) => e instanceof LegacyCryptoError && e.code === code;

function mdbk(ref = ARN, ct = Uint8Array.of(1, 2, 3)): Uint8Array {
  const text = new TextEncoder().encode(ref);
  const out = new Uint8Array(12 + text.length + ct.length);
  out.set([0x4d, 0x44, 0x42, 0x4b, 1, 1]);
  const view = new DataView(out.buffer);
  view.setUint16(6, text.length); view.setUint32(8, ct.length);
  out.set(text, 12); out.set(ct, 12 + text.length);
  return out;
}
async function aes(raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, usages);
}
async function seal(key: CryptoKey, data: Uint8Array, additionalData: Uint8Array): Promise<Uint8Array> {
  const iv = new Uint8Array(12).fill(5); // Synthetic deterministic fixture nonce, never production encryption.
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, data));
  const out = new Uint8Array(13 + ct.length); out[0] = 1; out.set(iv, 1); out.set(ct, 13); return out;
}

test("MDBK supports old/new stored ARN and MRK replica, imports nonextractable decrypt-only and wipes", async () => {
  for (const [stored, returned] of [[OLD, OLD], [ARN, ARN], [MRK, MRK.replace("us-east-1", "us-west-2")]]) {
    const raw = new Uint8Array(32).fill(7);
    const fixture = raw.slice();
    const u: LegacyUnwrapper = { environment: "production", kms: { async decrypt(ct, ctx, s) {
      assert.deepEqual(ct, Uint8Array.of(1, 2, 3));
      assert.deepEqual(ctx, kmsContext("production", CID));
      assert.equal(s.aborted, false);
      return { keyId: returned, plaintext: raw };
    } } };
    const opened = await unwrapCollectionKey(u, mdbk(stored), CID, signal());
    assert(raw.every(b => b === 0));
    assert.equal(opened.extractable, false); assert.deepEqual(opened.usages, ["decrypt"]);
    assert.equal(opened.algorithm.name, "AES-GCM");
    await assert.rejects(crypto.subtle.exportKey("raw", opened));
    // Verify no algorithm/AAD change by opening an independently sealed value.
    const encryptionKey = await aes(fixture, ["encrypt"]);
    const plaintext = new TextEncoder().encode("synthetic document");
    const wrapped = await seal(encryptionKey, plaintext, aad.resourceDocument(CID, "a.md"));
    assert.deepEqual(await openEnvelope(opened, wrapped, aad.resourceDocument(CID, "a.md")), plaintext);
    fixture.fill(0);
  }
});

test("malformed stored KMS references refuse before the KMS callback or key import", async t => {
  const resource = MRK.slice(MRK.lastIndexOf(":key/") + 5);
  const invalid = [
    `garbage/key/${resource}`, `garbage:key/${resource}`, `https://example.invalid/key/${resource}`,
    MRK.replace(":key/", ":alias/"), MRK.slice(0, MRK.lastIndexOf("/") + 1), `${MRK}/extra`,
    MRK.replace(resource, "bad_resource"), MRK.replace(resource, "mrk-short"), `${MRK}?query=1`,
    MRK.replace(":kms:", ":s3:"), MRK.replace(":us-east-1:", "::"),
    MRK.replace(":000000000000:", ":not-an-account:"), MRK.replace("arn:aws:", "arn:aws-cn:"),
    "SENSITIVE_HEADER_DO_NOT_ECHO",
  ];
  let calls = 0;
  const imports = t.mock.method(crypto.subtle, "importKey");
  const u: LegacyUnwrapper = { environment: "production", kms: { async decrypt() {
    calls++; return { keyId: MRK, plaintext: new Uint8Array(32).fill(7) };
  } } };
  for (const ref of invalid) {
    // The original provider's envelope parser checks framing; stored-key
    // semantic validation belongs BEFORE the managed decrypt callback.
    const wrapped = mdbk(ref);
    assert.equal(parseWrappedKey(wrapped).kind, "kms");
    await assert.rejects(unwrapCollectionKey(u, wrapped, CID, signal()), (e: unknown) =>
      safeError("wrapped_key")(e) && !String(e).includes(ref));
  }
  assert.equal(calls, 0);
  assert.equal(imports.mock.callCount(), 0);
});

test("MRK identity requires well-formed immutable ARNs and the same partition/account", () => {
  assert.equal(sameKmsKey(ARN, ARN), true);
  assert.equal(sameKmsKey(OLD, OLD), true);
  assert.equal(sameKmsKey(MRK.replace("us-east-1", "us-west-2"), MRK), true);
  assert.equal(sameKmsKey(MRK.replace("000000000000", "111111111111"), MRK), false);
  assert.equal(sameKmsKey(MRK.replace("arn:aws:", "arn:aws-cn:"), MRK), false);
  assert.equal(sameKmsKey(ARN.replace("us-east-1", "us-west-2"), ARN), false);
  assert.equal(sameKmsKey("garbage/key/mrk-123", "garbage/key/mrk-123"), false);
  assert.equal(sameKmsKey(MRK, `garbage/key/${MRK.split(":key/")[1]}`), false);
});

test("wrong-account MRK header is refused after response with plaintext wiped and no import", async t => {
  const raw = new Uint8Array(32).fill(9);
  let calls = 0;
  const imports = t.mock.method(crypto.subtle, "importKey");
  const u: LegacyUnwrapper = { environment: "staging", kms: { async decrypt() {
    calls++; return { keyId: MRK, plaintext: raw };
  } } };
  await assert.rejects(unwrapCollectionKey(u, mdbk(MRK.replace("000000000000", "111111111111")), CID, signal()), safeError("kms"));
  assert.equal(calls, 1);
  assert.equal(imports.mock.callCount(), 0);
  assert(raw.every(b => b === 0));
});

test("KMS plaintext wiped when abort arrives with decrypt result (no import, no leaked abort reason)", async t => {
  const raw = new Uint8Array(32).fill(9);
  const ac = new AbortController();
  let imports = 0;
  t.mock.method(crypto.subtle, "importKey", async () => { imports++; throw new Error("must not import"); });
  const u: LegacyUnwrapper = { environment: "lab", kms: { async decrypt() {
    ac.abort(new Error("SENSITIVE_ABORT_REASON")); return { keyId: ARN, plaintext: raw };
  } } };
  await assert.rejects(unwrapCollectionKey(u, mdbk(), CID, ac.signal), (e: unknown) =>
    safeError("kms")(e) && (e as Error).message === "KMS unwrap aborted");
  assert(raw.every(b => b === 0)); assert.equal(imports, 0);
});

test("KMS plaintext wiped on wrong stored identity, wrong length, import failure and abort during import", async t => {
  const original = crypto.subtle.importKey.bind(crypto.subtle);
  for (const phase of ["identity", "short", "long", "import", "abort-import"] as const) {
    const raw = new Uint8Array(phase === "short" ? 31 : phase === "long" ? 33 : 32).fill(9);
    const ac = new AbortController();
    const mocked = t.mock.method(crypto.subtle, "importKey", async (...args: Parameters<SubtleCrypto["importKey"]>) => {
      if (phase === "import") throw new Error("SENSITIVE_CRYPTO_FAILURE");
      if (phase === "abort-import") ac.abort("SENSITIVE_ABORT_REASON");
      return Reflect.apply(original, crypto.subtle, args);
    });
    const u: LegacyUnwrapper = { environment: "staging", kms: { async decrypt() { return { keyId: phase === "identity" ? OLD : ARN, plaintext: raw }; } } };
    await assert.rejects(unwrapCollectionKey(u, mdbk(), CID, ac.signal), (e: unknown) =>
      safeError(phase === "identity" || phase === "abort-import" ? "kms" : "wrapped_key")(e) && !String(e).includes("SENSITIVE"));
    assert(raw.every(b => b === 0), phase);
    if (["identity", "short", "long"].includes(phase)) assert.equal(mocked.mock.callCount(), 0);
    mocked.mock.restore();
  }
});

test("local AES-GCM v1 uses exact historical collection AAD and wipes raw imported DEK", async t => {
  assert.equal(new TextDecoder().decode(aad.collectionKey(CID)), `["collection_key","${CID}"]`);
  const master = await aes(new Uint8Array(32).fill(2), ["encrypt", "decrypt"]);
  const raw = new Uint8Array(32).fill(7);
  const envelope = await seal(master, raw, aad.collectionKey(CID));
  assert.equal(envelope.length, 61);
  const original = crypto.subtle.decrypt.bind(crypto.subtle);
  let unwrapped: ArrayBuffer | undefined;
  t.mock.method(crypto.subtle, "decrypt", async (...args: Parameters<SubtleCrypto["decrypt"]>) => {
    unwrapped = await original(...args); return unwrapped;
  });
  const opened = await unwrapCollectionKey({ environment: "lab", legacyMasterKey: master }, envelope, CID, signal());
  assert(unwrapped); assert(new Uint8Array(unwrapped).every(b => b === 0));
  assert.equal(opened.extractable, false); assert.deepEqual(opened.usages, ["decrypt"]);
  await assert.rejects(unwrapCollectionKey({ environment: "production", legacyMasterKey: master }, envelope, OTHER, signal()), safeError("authentication"));
  raw.fill(0);
});

test("local decrypted buffer wiped on invalid length/import failure, with safe errors", async t => {
  const master = await aes(new Uint8Array(32).fill(2), ["encrypt", "decrypt"]);
  const originalDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
  const originalImport = crypto.subtle.importKey.bind(crypto.subtle);
  for (const phase of ["length", "import"] as const) {
    const envelope = await seal(master, new Uint8Array(phase === "length" ? 31 : 32).fill(9), aad.collectionKey(CID));
    let raw: ArrayBuffer | undefined;
    const decryptMock = t.mock.method(crypto.subtle, "decrypt", async (...args: Parameters<SubtleCrypto["decrypt"]>) => {
      raw = await originalDecrypt(...args); return raw;
    });
    const importMock = t.mock.method(crypto.subtle, "importKey", async (...args: Parameters<SubtleCrypto["importKey"]>) => {
      if (phase === "import") throw new Error("SENSITIVE_IMPORT_FAILURE");
      return Reflect.apply(originalImport, crypto.subtle, args);
    });
    await assert.rejects(unwrapCollectionKey({ environment: "lab", legacyMasterKey: master }, envelope, CID, signal()), (e: unknown) => safeError("wrapped_key")(e) && !String(e).includes("SENSITIVE"));
    assert(raw); assert(new Uint8Array(raw).every(b => b === 0));
    decryptMock.mock.restore(); importMock.mock.restore();
  }
});

test("invalid MDBK headers/lengths/ref/UTF8 and unknown formats fail closed without fallback", async () => {
  const invalid: Uint8Array[] = [new Uint8Array(), Uint8Array.of(2, 0, 0), new TextEncoder().encode('{"plaintext":"not-a-mode"}'),
    mdbk(""), mdbk("x".repeat(2049)), mdbk(ARN, new Uint8Array()), mdbk(ARN, new Uint8Array(8193)),
    mdbk('bad"ref'), mdbk("bad\\ref"), mdbk("bad ref"), mdbk("bad\nref"), mdbk("non-ascii-é"),
    mdbk("\ufeff" + ARN), mdbk(ARN + "\ufeff"),
    mdbk().slice(0, -1), Uint8Array.from([...mdbk(), 0]), mdbk().slice(0, 11)];
  for (const [offset, value] of [[4, 2], [5, 2], [6, 255], [8, 255], [12, 255]]) {
    const bad = mdbk(); bad[offset] = value; invalid.push(bad);
  }
  let kmsCalls = 0;
  const master = await aes(new Uint8Array(32).fill(2), ["decrypt"]);
  const u: LegacyUnwrapper = { environment: "lab", legacyMasterKey: master, kms: { async decrypt() { kmsCalls++; throw new Error("unexpected KMS fallback"); } } };
  for (const wrapped of invalid) {
    assert.throws(() => parseWrappedKey(wrapped), safeError("wrapped_key"));
    await assert.rejects(unwrapCollectionKey(u, wrapped, CID, signal()), safeError("wrapped_key"));
  }
  assert.equal(kmsCalls, 0);
});

test("invalid local envelope/authentication, missing custody, and provider-check purpose fail closed", async () => {
  const master = await aes(new Uint8Array(32).fill(2), ["encrypt", "decrypt"]);
  const u = { environment: "lab", legacyMasterKey: master };
  await assert.rejects(unwrapCollectionKey(u, Uint8Array.of(1), CID, signal()), safeError("envelope"));
  const valid = await seal(master, new Uint8Array(32).fill(7), aad.collectionKey(CID));
  const corrupt = valid.slice(); corrupt[corrupt.length - 1] ^= 1;
  await assert.rejects(unwrapCollectionKey(u, corrupt, CID, signal()), safeError("authentication"));
  const providerCheck = await seal(master, new TextEncoder().encode("mdbase-connect-hosted-provider-key-check-v1"), new TextEncoder().encode("provider-key-check-v1"));
  await assert.rejects(unwrapCollectionKey(u, providerCheck, CID, signal()), safeError("authentication"));
  await assert.rejects(unwrapCollectionKey({ environment: "lab" }, valid, CID, signal()), safeError("wrapped_key"));
  await assert.rejects(unwrapCollectionKey({ environment: "lab" }, mdbk(), CID, signal()), safeError("kms"));
});
