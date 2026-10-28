import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { LegacyAwsKms } from "./aws-kms.ts";
import {
  aad, kmsContext, LegacyCryptoError, openEnvelope, parseWrappedKey, unwrapCollectionKey,
} from "./crypto.ts";
import type { LegacyKmsDecrypt, LegacyUnwrapper } from "./crypto.ts";

/**
 * Cross-language known answers, not an AWS integration test. The committed JSON
 * must come from the real Rust provider at the pinned source commit below.
 * Rust's KMS transport is a STUB: these are public, nonproduction fixtures, not
 * evidence of AWS cryptography, IAM/grants, or real provider record creation.
 * ProviderCrypto.encrypt_bytes produces the payload envelopes; the Worker opens
 * those exact bytes using the actually unwrapped, nonextractable collection key.
 * Random Rust wrapping nonces were captured once. Never regenerate ciphertext
 * here, assert deterministic regeneration, or substitute JS-generated vectors.
 * Missing/invalid fixture is a failure, never a skip or a fallback.
 */
const SOURCE = "8a014fe2abd2d9c6a8b1ed3e77c35cfda3392d3e";
const MODES = ["local-aes-gcm-v1", "mdbk-v1-aws-kms-scheme-1"] as const;
const TIERS = ["lab", "staging", "production"] as const;
type Mode = typeof MODES[number];
type Tier = typeof TIERS[number];
interface Vector {
  readonly name: string;
  readonly mode: Mode;
  readonly environment: Tier;
  readonly collectionId: string;
  readonly recordId: string;
  readonly sequence: 40;
  readonly masterKeyHex: string;
  readonly dekHex: string;
  readonly wrappedKeyHex: string;
  readonly legacyAadHex: string;
  readonly kmsContext: Readonly<Record<string, string>>;
  readonly keyRef: string | null;
  readonly kmsCiphertextHex: string | null;
  readonly payloadAadHex: string;
  readonly payloadPlaintextHex: string;
  readonly payloadCiphertextHex: string;
}
interface Fixture {
  readonly schema: "mdbase-provider-wrapping-kat/1";
  readonly providerSourceCommit: typeof SOURCE;
  readonly publicFixedTestValuesOnly: true;
  readonly realAws: false;
  readonly cases: readonly Vector[];
  readonly refusals?: readonly unknown[];
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const signal = () => new AbortController().signal;
function object(value: unknown, label: string): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), label);
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  for (const key of required) assert(Object.hasOwn(value, key), `missing ${key}`);
  for (const key of Object.keys(value)) assert([...required, ...optional].includes(key), `unknown field ${key}`);
}
function hex(value: unknown, label: string, byteLength?: number): asserts value is string {
  assert.equal(typeof value, "string", label);
  assert.match(value as string, /^(?:[0-9a-f]{2})*$/, label);
  if (byteLength !== undefined) assert.equal((value as string).length, byteLength * 2, label);
}
// Fresh copies on every call; all negative cases mutate copies of frozen vectors.
const bytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "hex"));
function expectedContext(environment: Tier, collectionId: string): Record<string, string> {
  return {
    "mdbase:service": "hosted-provider",
    "mdbase:environment": environment,
    "mdbase:purpose": "collection-data-key",
    "mdbase:envelope-version": "1",
    "mdbase:collection-id": collectionId,
  };
}
function readFixture(): Fixture {
  const decoded: unknown = JSON.parse(readFileSync(
    new URL("../../test/fixtures/provider-wrapping-vectors.json", import.meta.url), "utf8"));
  const root = object(decoded, "fixture object");
  fields(root, ["schema", "providerSourceCommit", "publicFixedTestValuesOnly", "realAws", "cases"], ["refusals"]);
  assert.equal(root.schema, "mdbase-provider-wrapping-kat/1");
  assert.equal(root.providerSourceCommit, SOURCE);
  assert.equal(root.publicFixedTestValuesOnly, true);
  assert.equal(root.realAws, false);
  // No refusal DTO was specified. Our mandatory refusal suite below is derived
  // directly from cases, not conditional on optional emitter annotations.
  if (Object.hasOwn(root, "refusals")) assert(Array.isArray(root.refusals), "refusals array");
  assert(Array.isArray(root.cases) && root.cases.length >= 6, "at least two modes x three tiers");
  const names = new Set<string>();
  const coverage = new Set<string>();
  for (const item of root.cases) {
    const v = object(item, "case object");
    fields(v, ["name", "mode", "environment", "collectionId", "recordId", "sequence", "masterKeyHex", "dekHex",
      "wrappedKeyHex", "legacyAadHex", "kmsContext", "keyRef", "kmsCiphertextHex", "payloadAadHex",
      "payloadPlaintextHex", "payloadCiphertextHex"]);
    assert(typeof v.name === "string" && v.name.length > 0 && !names.has(v.name), "unique case name");
    names.add(v.name);
    assert(MODES.includes(v.mode as Mode), "known wrapping mode");
    assert(TIERS.includes(v.environment as Tier), "known environment");
    for (const field of ["collectionId", "recordId"] as const) {
      assert.equal(typeof v[field], "string", field);
      assert.match(v[field] as string, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/, field);
      assert.notEqual(v[field], "00000000-0000-0000-0000-000000000000", field);
    }
    assert.equal(v.sequence, 40);
    hex(v.masterKeyHex, "masterKeyHex", 32);
    hex(v.dekHex, "dekHex", 32);
    for (const field of ["wrappedKeyHex", "legacyAadHex", "payloadAadHex", "payloadPlaintextHex", "payloadCiphertextHex"] as const) {
      hex(v[field], field);
    }
    const context = object(v.kmsContext, "kmsContext");
    assert.deepEqual(context, expectedContext(v.environment as Tier, v.collectionId as string));
    Object.freeze(context);
    if (v.mode === MODES[0]) {
      assert.equal(v.keyRef, null);
      assert.equal(v.kmsCiphertextHex, null);
      assert.equal((v.wrappedKeyHex as string).length / 2, 1 + 12 + 32 + 16);
    } else {
      assert.equal(typeof v.keyRef, "string");
      assert.match(v.keyRef as string, /^arn:aws:kms:[a-z0-9-]+:\d{12}:key\/(?:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}|mrk-[0-9a-f]{32})$/);
      hex(v.kmsCiphertextHex, "kmsCiphertextHex");
      assert(v.kmsCiphertextHex.length > 0 && v.kmsCiphertextHex.length / 2 <= 8192);
    }
    const payload = bytes(v.payloadCiphertextHex as string);
    assert.equal(payload[0], 1, "provider payload envelope version");
    assert.equal(payload.length, 1 + 12 + (v.payloadPlaintextHex as string).length / 2 + 16);
    coverage.add(`${v.mode}/${v.environment}`);
    Object.freeze(v);
  }
  for (const mode of MODES) for (const tier of TIERS) assert(coverage.has(`${mode}/${tier}`), `${mode}/${tier}`);
  Object.freeze(root.cases);
  Object.freeze(root);
  // This cast follows validation at the JSON unknown boundary, not a JSON DTO assertion.
  return root as unknown as Fixture;
}

// PUBLIC dummy legacy-domain credentials; never native/device custody credentials,
// process.env, a credential chain, or an AWS network connection. Real SigV4 code
// signs the request, but the sole transport is the strict synthetic fetch below.
const CREDS = Object.freeze({
  accessKeyId: "AKIAPUBLICPROVIDERKAT01",
  secretAccessKey: "PUBLIC_ONLY_LEGACY_PROVIDER_KAT_NOT_A_SECRET",
});
const NOW = Date.UTC(2026, 0, 1);
const ENDPOINT = "https://kms.us-east-1.amazonaws.com/";
interface Boundary {
  kms: LegacyKmsDecrypt;
  counts: { decrypt: number; credentials: number; fetch: number };
  violations: string[];
}
function boundary(v: Vector, responseKeyRef = v.keyRef!, allowResponseKey = false): Boundary {
  assert.equal(v.mode, MODES[1]);
  assert(v.keyRef !== null && v.kmsCiphertextHex !== null);
  const counts = { decrypt: 0, credentials: 0, fetch: 0 };
  const violations: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    counts.fetch++;
    const start = violations.length;
    const check = (ok: boolean, label: string) => { if (!ok) violations.push(label); };
    // Never throw an assertion inside fetch: LegacyAwsKms intentionally sanitizes
    // transport exceptions. Persist violations, return 400, assert them OUTSIDE.
    try {
      check(init === undefined, "fetch.init");
      if (!(input instanceof Request)) {
        violations.push("request.type");
      } else {
        check(input.url === ENDPOINT, "url");
        check(input.method === "POST", "method");
        check(input.redirect === "manual", "redirect");
        check(input.headers.get("x-amz-target") === "TrentService.Decrypt", "target");
        check(input.headers.get("content-type") === "application/x-amz-json-1.1", "content-type");
        check(input.headers.get("x-amz-date") === "20260101T000000Z", "date");
        check(input.headers.get("x-amz-security-token") === null, "unexpected-session-token");
        const authorization = input.headers.get("authorization") ?? "";
        check(authorization.startsWith(`AWS4-HMAC-SHA256 Credential=${CREDS.accessKeyId}/20260101/us-east-1/kms/aws4_request, SignedHeaders=`) &&
          /, Signature=[0-9a-f]{64}$/.test(authorization), "authorization");
        const raw: unknown = await input.json();
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
          violations.push("body.type");
        } else {
          const body = raw as Record<string, unknown>;
          check(isDeepStrictEqual(Object.keys(body).sort(), ["CiphertextBlob", "EncryptionAlgorithm", "EncryptionContext"]), "body.fields");
          check(!Object.hasOwn(body, "KeyId"), "forbidden-KeyId");
          check(body.CiphertextBlob === Buffer.from(v.kmsCiphertextHex!, "hex").toString("base64"), "ciphertext");
          check(isDeepStrictEqual(body.EncryptionContext, v.kmsContext), "context");
          check(body.EncryptionAlgorithm === "SYMMETRIC_DEFAULT", "algorithm");
        }
      }
    } catch {
      violations.push("request.decode");
    }
    if (violations.length !== start) return new Response("public fixture boundary refused", { status: 400 });
    return Response.json({
      Plaintext: Buffer.from(v.dekHex, "hex").toString("base64"),
      KeyId: responseKeyRef,
      EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
    });
  };
  const client = new LegacyAwsKms({
    region: "us-east-1", environment: v.environment, collections: [v.collectionId],
    keyArns: allowResponseKey ? [...new Set([v.keyRef, responseKeyRef])] : [v.keyRef],
  }, () => { counts.credentials++; return CREDS; }, fetcher, () => NOW);
  return {
    counts, violations,
    // Invocation accounting around the REAL client, not a replacement decryptor.
    kms: { decrypt: (...args) => { counts.decrypt++; return client.decrypt(...args); } },
  };
}
function traffic(b: Boundary, decrypt: number, credentials: number, fetch: number, violations: string[] = []): void {
  assert.deepEqual(b.counts, { decrypt, credentials, fetch });
  assert.deepEqual(b.violations, violations, "no swallowed synthetic fetch boundary violations");
}
const error = (code: LegacyCryptoError["code"], message: string) => (e: unknown) =>
  e instanceof LegacyCryptoError && e.code === code && e.message === message;
async function master(v: Vector): Promise<CryptoKey> {
  const key = await crypto.subtle.importKey("raw", bytes(v.masterKeyHex), "AES-GCM", false, ["decrypt"]);
  await keyContract(key);
  return key;
}
async function keyContract(key: CryptoKey): Promise<void> {
  assert.equal(key.type, "secret");
  assert.equal(key.extractable, false);
  assert.deepEqual(key.usages, ["decrypt"]);
  assert.equal(key.algorithm.name, "AES-GCM");
  assert.equal((key.algorithm as AesKeyAlgorithm).length, 256, "32-byte AES key");
  await assert.rejects(crypto.subtle.exportKey("raw", key), (e: unknown) =>
    // Node 22 reports InvalidAccessException; Node 24 and workerd use the
    // WebCrypto-standard InvalidAccessError.
    e instanceof Error && (e.name === "InvalidAccessError" || e.name === "InvalidAccessException"));
}
function changedLastHex(s: string): string {
  return s.slice(0, -1) + (s.endsWith("0") ? "1" : "0");
}
function changed(v: Vector, offset: number, value: number): Uint8Array {
  const out = bytes(v.wrappedKeyHex);
  out[offset] = value;
  return out;
}
function lengthField(v: Vector, offset: 6 | 8, value: number): Uint8Array {
  const out = bytes(v.wrappedKeyHex);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  if (offset === 6) view.setUint16(offset, value, false);
  else view.setUint32(offset, value, false);
  return out;
}
function assertWire(v: Vector): void {
  // Compare literal Rust JSON bytes, not just parsed tuples or a JS round trip.
  assert.deepEqual(bytes(v.legacyAadHex), utf8(`["collection_key","${v.collectionId}"]`));
  assert.deepEqual(bytes(v.legacyAadHex), aad.collectionKey(v.collectionId));
  assert.deepEqual(bytes(v.payloadAadHex), utf8(`["current_record","${v.collectionId}","${v.recordId}",40]`));
  assert.deepEqual(bytes(v.payloadAadHex), aad.currentRecord(v.collectionId, v.recordId, v.sequence));
  assert.deepEqual(kmsContext(v.environment, v.collectionId), v.kmsContext);
  const wrapped = bytes(v.wrappedKeyHex);
  const parsed = parseWrappedKey(wrapped);
  if (v.mode === MODES[0]) {
    assert.equal(wrapped[0], 1);
    assert.equal(parsed.kind, "legacy");
    if (parsed.kind === "legacy") assert.deepEqual(parsed.envelope, wrapped);
  } else {
    assert.deepEqual(wrapped.subarray(0, 6), Uint8Array.of(0x4d, 0x44, 0x42, 0x4b, 1, 1));
    const view = new DataView(wrapped.buffer, wrapped.byteOffset, wrapped.byteLength);
    const refLength = view.getUint16(6, false);
    const ctLength = view.getUint32(8, false);
    assert.equal(refLength, utf8(v.keyRef!).length);
    assert.equal(ctLength, v.kmsCiphertextHex!.length / 2);
    assert.equal(wrapped.length, 12 + refLength + ctLength);
    assert.deepEqual(wrapped.subarray(12, 12 + refLength), utf8(v.keyRef!));
    assert.deepEqual(wrapped.subarray(12 + refLength), bytes(v.kmsCiphertextHex!));
    assert.deepEqual(parsed, { kind: "kms", keyRef: v.keyRef, ciphertext: bytes(v.kmsCiphertextHex!) });
  }
}

// Parent runs only AFTER committing the real Rust-emitted JSON:
// node --experimental-transform-types --test src/legacy-source/provider-vectors.test.ts
test("real Rust provider fixed vectors; KMS STUB / public nonproduction / no AWS", async t => {
  const fixture = readFixture();
  for (const v of fixture.cases) {
    await t.test(`${v.environment}/${v.mode}/${v.name}`, async t => {
      assertWire(v);
      const managed = fixture.cases.find(c => c.mode === MODES[1] && c.environment === v.environment)!;
      const localMaster = await master(v);
      const make = (b: Boundary): LegacyUnwrapper => ({ environment: v.environment, legacyMasterKey: localMaster, kms: b.kms });
      await t.test("real unwrap opens exact provider-encrypted payload with a nonextractable decrypt-only key", async () => {
        const b = boundary(v.mode === MODES[1] ? v : managed);
        const key = await unwrapCollectionKey(make(b), bytes(v.wrappedKeyHex), v.collectionId, signal());
        await keyContract(key);
        assert.deepEqual(await openEnvelope(key, bytes(v.payloadCiphertextHex), bytes(v.payloadAadHex)), bytes(v.payloadPlaintextHex));
        // The published DEK itself must describe the same Rust payload; no export
        // of the unwrapped key and no freshly encrypted surrogate ciphertext.
        const knownDek = await crypto.subtle.importKey("raw", bytes(v.dekHex), "AES-GCM", false, ["decrypt"]);
        assert.deepEqual(await openEnvelope(knownDek, bytes(v.payloadCiphertextHex), bytes(v.payloadAadHex)), bytes(v.payloadPlaintextHex));
        const corrupt = bytes(v.payloadCiphertextHex); corrupt[corrupt.length - 1] ^= 1;
        await assert.rejects(openEnvelope(key, corrupt, bytes(v.payloadAadHex)), error("authentication", "ciphertext failed authentication"));
        await assert.rejects(openEnvelope(key, bytes(v.payloadCiphertextHex), aad.currentRecord(v.collectionId, changedLastHex(v.recordId), 40)),
          error("authentication", "ciphertext failed authentication"));
        await assert.rejects(openEnvelope(key, bytes(v.payloadCiphertextHex), aad.currentRecord(v.collectionId, v.recordId, 41)),
          error("authentication", "ciphertext failed authentication"));
        const calls = v.mode === MODES[1] ? 1 : 0;
        traffic(b, calls, calls, calls);
      });
      await t.test("unknown prefix never falls back to local or KMS", async () => {
        const b = boundary(v.mode === MODES[1] ? v : managed);
        await assert.rejects(unwrapCollectionKey(make(b), changed(v, 0, 2), v.collectionId, signal()),
          error("wrapped_key", "not an MDBK envelope"));
        traffic(b, 0, 0, 0);
      });
      if (v.mode === MODES[0]) {
        await t.test("wrong collection, damaged local tag and truncated envelope never invoke KMS", async () => {
          const b = boundary(managed);
          await assert.rejects(unwrapCollectionKey(make(b), bytes(v.wrappedKeyHex), changedLastHex(v.collectionId), signal()),
            error("authentication", "ciphertext failed authentication"));
          const corrupt = bytes(v.wrappedKeyHex); corrupt[corrupt.length - 1] ^= 1;
          await assert.rejects(unwrapCollectionKey(make(b), corrupt, v.collectionId, signal()),
            error("authentication", "ciphertext failed authentication"));
          await assert.rejects(unwrapCollectionKey(make(b), bytes(v.wrappedKeyHex).slice(0, 1), v.collectionId, signal()),
            error("envelope", "ciphertext envelope is invalid"));
          traffic(b, 0, 0, 0);
        });
      } else {
        await t.test("malformed MDBK is rejected before KMS or local fallback", async () => {
          const b = boundary(v);
          const original = bytes(v.wrappedKeyHex);
          const refLength = utf8(v.keyRef!).length;
          const malformed: [string, Uint8Array, string][] = [
            ["unknown version", changed(v, 4, 2), "unsupported MDBK version or scheme"],
            ["unknown scheme", changed(v, 5, 2), "unsupported MDBK version or scheme"],
            ["truncated header", original.slice(0, 11), "not an MDBK envelope"],
            ["truncated key ref", original.slice(0, 12 + refLength - 1), "MDBK lengths are inconsistent"],
            ["truncated ciphertext", original.slice(0, -1), "MDBK lengths are inconsistent"],
            ["trailing bytes", Uint8Array.from([...original, 0]), "MDBK lengths are inconsistent"],
            ["zero key-ref length", lengthField(v, 6, 0), "MDBK lengths are inconsistent"],
            ["oversized key-ref length", lengthField(v, 6, 2049), "MDBK lengths are inconsistent"],
            ["wrong key-ref length", lengthField(v, 6, refLength + 1), "MDBK lengths are inconsistent"],
            ["zero ciphertext length", lengthField(v, 8, 0), "MDBK lengths are inconsistent"],
            ["oversized ciphertext length", lengthField(v, 8, 8193), "MDBK lengths are inconsistent"],
            ["wrong ciphertext length", lengthField(v, 8, v.kmsCiphertextHex!.length / 2 + 1), "MDBK lengths are inconsistent"],
            ["invalid UTF-8 key ref", changed(v, 12, 0xff), "key_ref is not UTF-8"],
            ...[0x20, 0x22, 0x5c, 0x7f].map(byte =>
              [`invalid key-ref character ${byte}`, changed(v, 12, byte), "key_ref has invalid characters"] as [string, Uint8Array, string]),
          ];
          for (const [name, wrapped, message] of malformed) {
            assert.throws(() => parseWrappedKey(wrapped), error("wrapped_key", message), name);
            await assert.rejects(unwrapCollectionKey(make(b), wrapped, v.collectionId, signal()), error("wrapped_key", message), name);
          }
          traffic(b, 0, 0, 0);
        });
        await t.test("wrong tier/context and wrong collection fail before credentials/fetch", async () => {
          const b = boundary(v);
          const wrongTier: Tier = v.environment === "lab" ? "staging" : "lab";
          await assert.rejects(unwrapCollectionKey({ ...make(b), environment: wrongTier }, bytes(v.wrappedKeyHex), v.collectionId, signal()),
            error("kms", "kms_invalid_context"));
          await assert.rejects(unwrapCollectionKey(make(b), bytes(v.wrappedKeyHex), changedLastHex(v.collectionId), signal()),
            error("kms", "kms_collection_not_allowed"));
          traffic(b, 2, 0, 0);
        });
        await t.test("wrong response key fails the real client allowlist", async () => {
          const b = boundary(v, changedLastHex(v.keyRef!));
          await assert.rejects(unwrapCollectionKey(make(b), bytes(v.wrappedKeyHex), v.collectionId, signal()),
            error("kms", "kms_invalid_response"));
          traffic(b, 1, 1, 1);
        });
        await t.test("even an allowed response key must match the stored envelope identity", async () => {
          const b = boundary(v, changedLastHex(v.keyRef!), true);
          await assert.rejects(unwrapCollectionKey(make(b), bytes(v.wrappedKeyHex), v.collectionId, signal()),
            error("kms", "decrypted by a different key"));
          traffic(b, 1, 1, 1);
        });
        await t.test("corrupt opaque KMS ciphertext is refused by the strict synthetic boundary, not decrypted locally", async () => {
          const b = boundary(v);
          const corrupt = bytes(v.wrappedKeyHex);
          corrupt[12 + utf8(v.keyRef!).length] ^= 1;
          await assert.rejects(unwrapCollectionKey(make(b), corrupt, v.collectionId, signal()), error("kms", "kms_refused"));
          traffic(b, 1, 1, 1, ["ciphertext"]);
        });
      }
    });
  }
});
