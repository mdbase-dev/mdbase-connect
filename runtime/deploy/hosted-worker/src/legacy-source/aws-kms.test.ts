import assert from "node:assert/strict";
import test from "node:test";
import { AwsClient } from "aws4fetch";
import { LegacyAwsKms, validateLegacyKmsConfig } from "./aws-kms.ts";
import type { LegacyAwsKmsConfig } from "./aws-kms.ts";
import type { AwsCredentials } from "../custody/aws-kms.ts";
import { kmsContext, LegacyCryptoError } from "./crypto.ts";

// Synthetic, non-deployable unit inputs only. No AWS/environment reads.
const CID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ARN = "arn:aws:kms:us-east-1:000000000000:key/33333333-3333-4333-8333-333333333333";
const OLD = "arn:aws:kms:us-east-1:000000000000:key/44444444-4444-4444-8444-444444444444";
const MRK = "arn:aws:kms:us-east-1:000000000000:key/mrk-123456789012345678901234567890ab";
const REPLICA = MRK.replace("us-east-1", "us-west-2");
const CONFIG: LegacyAwsKmsConfig = { region: "us-east-1", environment: "lab", collections: [CID], keyArns: [ARN, OLD, MRK] };
const CREDS: AwsCredentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "synthetic-unit-test-secret-not-a-credential" };
const NOW = Date.UTC(2026, 9, 20);
const freshSignal = () => new AbortController().signal;
const context = () => kmsContext("lab", CID);
const result = (overrides: Record<string, unknown> = {}) => ({ KeyId: ARN, EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
  Plaintext: Buffer.alloc(32, 7).toString("base64"), ...overrides });
const factory = (f: typeof fetch, credentials: () => AwsCredentials | null = () => CREDS) => new LegacyAwsKms(CONFIG, credentials, f, () => NOW);
const decrypt = (kms: LegacyAwsKms, signal = freshSignal()) => kms.decrypt(Uint8Array.of(1, 2, 3), context(), signal);
const code = (message: string) => (e: unknown) => e instanceof LegacyCryptoError && e.code === "kms" && e.message === message;

async function signedRequest(input: Parameters<typeof fetch>[0]): Promise<Record<string, unknown>> {
  assert(input instanceof Request);
  assert.equal(input.url, "https://kms.us-east-1.amazonaws.com/");
  assert.equal(input.method, "POST");
  assert.equal(input.redirect, "manual");
  assert.equal(input.headers.get("x-amz-target"), "TrentService.Decrypt");
  assert.equal(input.headers.get("content-type"), "application/x-amz-json-1.1");
  assert.match(input.headers.get("authorization")!, /AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261020\/us-east-1\/kms\/aws4_request/);
  return input.json();
}

test("same transport in all tiers signs only Decrypt, exact five-key provider context, NO KeyId", async () => {
  for (const environment of ["lab", "staging", "production"] as const) {
    for (const keyId of [OLD, ARN, MRK, REPLICA]) {
      let calls = 0;
      const kms = new LegacyAwsKms({ ...CONFIG, environment }, () => CREDS, async input => {
        calls++;
        assert.deepEqual(await signedRequest(input), { CiphertextBlob: "AQID", EncryptionContext: {
          "mdbase:service": "hosted-provider", "mdbase:environment": environment,
          "mdbase:purpose": "collection-data-key", "mdbase:envelope-version": "1", "mdbase:collection-id": CID,
        }, EncryptionAlgorithm: "SYMMETRIC_DEFAULT" });
        return Response.json(result({ KeyId: keyId }));
      }, () => NOW);
      const opened = await kms.decrypt(Uint8Array.of(1, 2, 3), kmsContext(environment, CID), freshSignal());
      assert.equal(opened.keyId, keyId);
      assert.deepEqual(opened.plaintext, new Uint8Array(32).fill(7));
      opened.plaintext.fill(0);
      assert.equal(calls, 1);
    }
  }
});

test("bounded exact config rejects aliases, bad partitions/regions/keys/env/collections", () => {
  const invalid: LegacyAwsKmsConfig[] = [
    { ...CONFIG, region: "us-east-1.evil.invalid" }, { ...CONFIG, region: "us-gov-west-1" },
    { ...CONFIG, region: "cn-north-1" }, { ...CONFIG, region: "us-fake-1" },
    { ...CONFIG, environment: "local" as "lab" },
    ...[[], ["alias/writer"], [ARN.replace(":key/", ":alias/")], [ARN.replace("arn:aws:", "arn:aws-cn:")],
      [ARN.replace("us-east-1", "us-gov-west-1")], [ARN + "\n"], [ARN.toUpperCase()],
      [ARN.replace(/key\/.+/, "key/00000000-0000-0000-0000-000000000000")],
      [MRK.replace("mrk-123", "mrk-ABC")], [ARN, ARN], Array(1), Array(33).fill(ARN)].map(keyArns => ({ ...CONFIG, keyArns })),
    ...[[CID, CID], [CID.toUpperCase() + "A"], ["00000000-0000-0000-0000-000000000000"], Array(1), Array(17).fill(CID)]
      .map(collections => ({ ...CONFIG, collections })),
  ];
  for (const config of invalid) {
    assert.throws(() => validateLegacyKmsConfig(config), code("kms_invalid_config"));
    assert.throws(() => new LegacyAwsKms(config, () => { throw new Error("must not read credentials"); }), code("kms_invalid_config"));
  }
  assert.doesNotThrow(() => validateLegacyKmsConfig({ ...CONFIG, collections: [] }));
  assert.doesNotThrow(() => validateLegacyKmsConfig({ ...CONFIG, keyArns: [OLD, ARN, REPLICA] }));
});

test("constructor snapshots allowlists and input context is snapshotted before callbacks", async () => {
  const config = { ...CONFIG, collections: [CID], keyArns: [ARN] };
  const ctx = context();
  const kms = new LegacyAwsKms(config, () => { ctx["mdbase:service"] = "next-hosted"; return CREDS; }, async input => {
    const body = await signedRequest(input);
    assert.deepEqual(body.EncryptionContext, context());
    return Response.json(result());
  }, () => NOW);
  config.collections[0] = OTHER;
  config.keyArns[0] = OLD;
  const opened = await kms.decrypt(Uint8Array.of(1), ctx, freshSignal());
  opened.plaintext.fill(0);
  await assert.rejects(kms.decrypt(Uint8Array.of(1), kmsContext("lab", OTHER), freshSignal()), code("kms_collection_not_allowed"));
});

test("bad context/cross-collection/ciphertext fail before credentials and fetch", async () => {
  let credentials = 0, calls = 0;
  const kms = factory(async () => { calls++; throw new Error("unexpected"); }, () => { credentials++; return CREDS; });
  const missing = context(); delete missing["mdbase:purpose"];
  const hiddenExtra = Object.defineProperty(context(), "hidden", { value: "forbidden" });
  const symbolExtra = { ...context(), [Symbol("extra")]: "forbidden" };
  for (const ctx of [missing, hiddenExtra, symbolExtra, { ...context(), extra: "x" }, kmsContext("staging", CID),
    { ...context(), "mdbase:service": "next-hosted" }, { ...context(), "mdbase:purpose": "provider-key-check" },
    { ...context(), "mdbase:envelope-version": "2" }]) {
    await assert.rejects(kms.decrypt(Uint8Array.of(1), ctx, freshSignal()), code("kms_invalid_context"));
  }
  for (const cid of [OTHER, "not-a-uuid", "00000000-0000-0000-0000-000000000000"]) {
    await assert.rejects(kms.decrypt(Uint8Array.of(1), kmsContext("lab", cid), freshSignal()), code("kms_collection_not_allowed"));
  }
  for (const ct of [new Uint8Array(), new Uint8Array(8193)]) {
    await assert.rejects(kms.decrypt(ct, context(), freshSignal()), code("kms_invalid_ciphertext"));
  }
  assert.equal(credentials, 0); assert.equal(calls, 0);
});

test("ciphertext 8192 is allowed without mutation or any selector", async () => {
  const ct = new Uint8Array(8192).fill(9);
  const kms = factory(async input => {
    const body = await signedRequest(input);
    assert.equal(Buffer.from(body.CiphertextBlob as string, "base64").length, 8192);
    assert.equal(Object.hasOwn(body, "KeyId"), false);
    return Response.json(result());
  });
  const opened = await kms.decrypt(ct, context(), freshSignal()); opened.plaintext.fill(0);
  assert(ct.every(b => b === 9));
});

test("strict response ARN/algorithm/base64/plaintext and JSON/UTF8 validation", async () => {
  const bad = [
    ...["alias/current", ARN.replace("33333333", "55555555"), REPLICA.replace(":000000000000:", ":111111111111:"),
      MRK.replace("arn:aws:", "arn:aws-us-gov:"), MRK.replace("us-east-1", "us-fake-1")].map(KeyId => result({ KeyId })),
    result({ EncryptionAlgorithm: "RSAES_OAEP_SHA_256" }), result({ EncryptionAlgorithm: undefined }),
    ...[null, "", "!!!!", "AQ", "AQ==\n", "AB==", Buffer.alloc(31, 1).toString("base64"),
      Buffer.alloc(33, 1).toString("base64"), Buffer.alloc(96, 1).toString("base64"), Buffer.alloc(8193).toString("base64")]
      .map(Plaintext => result({ Plaintext })),
    null, [], "SENSITIVE_RESPONSE", 3,
  ];
  for (const value of bad) await assert.rejects(decrypt(factory(async () => Response.json(value))), code("kms_invalid_response"));
  for (const bytes of [new TextEncoder().encode("{SENSITIVE_INVALID_JSON"), Uint8Array.of(0xff, 0xfe)]) {
    await assert.rejects(decrypt(factory(async () => new Response(bytes))), code("kms_invalid_response"));
  }
  await assert.rejects(decrypt(factory(async () => new Response(null))), code("kms_invalid_response"));
});

test("Content-Length and streaming bounds are independent; oversized body is canceled", async () => {
  for (const length of ["16385", "-1", "bogus", "9999999999999999999999999"]) {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { canceled = true; } });
    await assert.rejects(decrypt(factory(async () => new Response(body, { headers: { "content-length": length } }))), code("kms_invalid_response"));
    assert(canceled);
  }
  for (const declared of [undefined, "2"]) {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(16384)); c.enqueue(Uint8Array.of(1)); }, cancel() { canceled = true; } });
    await assert.rejects(decrypt(factory(async () => new Response(body, { headers: declared ? { "content-length": declared } : {} }))), code("kms_invalid_response"));
    assert(canceled);
  }
  const json = JSON.stringify(result());
  const exactly = json + " ".repeat(16384 - json.length);
  const opened = await decrypt(factory(async () => new Response(exactly))); opened.plaintext.fill(0);
});

test("network/redirect/service refusal use one call, no retry, no raw errors", async () => {
  for (const status of [301, 302, 307, 308, 400, 403]) {
    let calls = 0;
    await assert.rejects(decrypt(factory(async input => {
      calls++; await signedRequest(input);
      return new Response("SENSITIVE_PROVIDER_ERROR", { status, headers: { location: "https://untrusted.invalid/" } });
    })), code("kms_refused"));
    assert.equal(calls, 1);
  }
  // Throttling and service-side failures are transient: the source retries them.
  for (const [status, body] of [[429, "SENSITIVE"], [500, "SENSITIVE"], [503, "SENSITIVE"],
    [400, JSON.stringify({ __type: "ThrottlingException", message: "SENSITIVE" })],
    [400, JSON.stringify({ __type: "com.amazonaws.kms#DependencyTimeoutException" })]] as const) {
    let calls = 0;
    await assert.rejects(decrypt(factory(async input => { calls++; await signedRequest(input); return new Response(body, { status }); })), code("kms_unavailable"), `${status} ${body}`);
    assert.equal(calls, 1);
  }
  for (const type of ["InvalidCiphertextException", "AccessDeniedException", "IncorrectKeyException"]) {
    await assert.rejects(decrypt(factory(async () => new Response(JSON.stringify({ __type: type }), { status: 400 }))), code("kms_refused"), type);
  }
  let calls = 0;
  await assert.rejects(decrypt(factory(async () => { calls++; throw new Error("SENSITIVE_URL_AND_CREDENTIAL"); })), code("kms_unavailable"));
  assert.equal(calls, 1);
  await assert.rejects(decrypt(factory(async () => Response.json(result()), () => { throw new Error("SENSITIVE_CREDENTIAL"); })), code("kms_unavailable"));
});

test("strict credentials/STS expiry, no fallback", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return Response.json(result()); };
  for (const credentials of [null, { ...CREDS, accessKeyId: "bad" }, { ...CREDS, secretAccessKey: "short" },
    { ...CREDS, sessionToken: "" }, { ...CREDS, sessionToken: "token-without-expiry" },
    { ...CREDS, sessionToken: "x".repeat(8193), expiresAt: NOW + 60_000 },
    { ...CREDS, sessionToken: "sts", expiresAt: NOW + 30_000 }, { ...CREDS, expiresAt: NaN },
    { ...CREDS, expiresAt: NOW - 1 }]) {
    await assert.rejects(decrypt(factory(fetcher, () => credentials)), code("kms_credentials_unavailable"));
  }
  assert.equal(calls, 0);
  const kms = factory(async input => {
    assert(input instanceof Request); assert.equal(input.headers.get("x-amz-security-token"), "synthetic-sts-token");
    return Response.json(result());
  }, () => ({ ...CREDS, sessionToken: "synthetic-sts-token", expiresAt: NOW + 60_000 }));
  (await decrypt(kms)).plaintext.fill(0);
  await assert.rejects(decrypt(new LegacyAwsKms(CONFIG, () => CREDS, fetcher, () => NaN)), code("kms_credentials_unavailable"));
});

test("pre-abort never reads credentials; in-flight fetch and stalled body abort are bounded/redacted", async () => {
  const pre = new AbortController(); pre.abort(new Error("SENSITIVE_REASON"));
  await assert.rejects(decrypt(factory(async () => { throw new Error("unexpected"); }, () => { throw new Error("unexpected"); }), pre.signal), code("kms_aborted"));
  for (const phase of ["fetch", "body"] as const) {
    const ac = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let canceled = false;
    const work = decrypt(factory(async () => {
      if (phase === "fetch") { started(); return new Promise<Response>(() => {}); }
      return new Response(new ReadableStream<Uint8Array>({ pull() { started(); return new Promise<void>(() => {}); }, cancel() { canceled = true; } }));
    }), ac.signal);
    await ready;
    ac.abort(new Error("SENSITIVE_ABORT_REASON"));
    await assert.rejects(work, code("kms_aborted"));
    if (phase === "body") assert(canceled);
  }
});

test("total 8 second deadline covers uncooperative fetch and streaming bodies", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const phase of ["fetch", "body"] as const) {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const work = decrypt(factory(async () => {
      if (phase === "fetch") { started(); return new Promise<Response>(() => {}); }
      return new Response(new ReadableStream<Uint8Array>({ pull() { started(); return new Promise<void>(() => {}); } }));
    }));
    await ready;
    t.mock.timers.tick(8000);
    await assert.rejects(work, code("kms_aborted"));
  }
});

test("signing cache bytes wiped and cache cleared on success, invalid response, network and abort", async t => {
  const original = AwsClient.prototype.sign;
  const caches: Map<string, ArrayBuffer>[] = [];
  const keys: ArrayBuffer[] = [];
  t.mock.method(AwsClient.prototype, "sign", async function(this: AwsClient, ...args: Parameters<AwsClient["sign"]>) {
    assert.equal(this.retries, 0);
    const signed = await original.apply(this, args);
    caches.push(this.cache); keys.push(...this.cache.values());
    return signed;
  });
  for (const phase of ["success", "invalid", "network", "abort"] as const) {
    const ac = new AbortController();
    const work = decrypt(factory(async () => {
      if (phase === "network") throw new Error("SENSITIVE");
      if (phase === "abort") ac.abort("SENSITIVE");
      return Response.json(result(phase === "invalid" ? { KeyId: "alias/wrong" } : {}));
    }), ac.signal);
    if (phase === "success") (await work).plaintext.fill(0);
    else await assert.rejects(work);
  }
  assert.equal(caches.length, 4); assert(keys.length > 0);
  assert(caches.every(cache => cache.size === 0));
  assert(keys.every(key => new Uint8Array(key).every(b => b === 0)));
});

test("deadline while signing bounds caller; late signing-cache insertion still wiped", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const released = new Promise<void>(resolve => { finish = resolve; });
  let cache: Map<string, ArrayBuffer> | undefined;
  const key = new Uint8Array(32).fill(9);
  let finished!: () => void;
  const done = new Promise<void>(resolve => { finished = resolve; });
  t.mock.method(AwsClient.prototype, "sign", async function(this: AwsClient) {
    cache = this.cache;
    started();
    await released;
    cache.set("synthetic-signing-key", key.buffer);
    finished();
    return new Request("https://kms.us-east-1.amazonaws.com/");
  });
  let calls = 0;
  const work = decrypt(factory(async () => { calls++; return Response.json(result()); }));
  await ready;
  t.mock.timers.tick(8000);
  await assert.rejects(work, code("kms_aborted"));
  finish(); await done;
  // Allow the signing completion cleanup handler to run.
  await Promise.resolve();
  assert.equal(cache!.size, 0); assert(key.every(b => b === 0)); assert.equal(calls, 0);
});

test("late fetch response after abort is canceled; stream failures are redacted", async () => {
  let deliver!: (response: Response) => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const ac = new AbortController();
  const work = decrypt(factory(async () => {
    started(); return new Promise<Response>(resolve => { deliver = resolve; });
  }), ac.signal);
  await ready; ac.abort("SENSITIVE_REASON");
  await assert.rejects(work, code("kms_aborted"));
  let canceled!: () => void;
  const cancellation = new Promise<void>(resolve => { canceled = resolve; });
  deliver(new Response(new ReadableStream<Uint8Array>({ cancel() { canceled(); } })));
  await cancellation;
  const body = new ReadableStream<Uint8Array>({ pull(c) { c.error(new Error("SENSITIVE_STREAM_ERROR")); } });
  await assert.rejects(decrypt(factory(async () => new Response(body))), code("kms_invalid_response"));
});

test("invalid returned key/length and post-decode abort wipe decoded plaintext", async t => {
  const original = Uint8Array.from;
  let observed: Uint8Array | undefined;
  let ac: AbortController;
  let abortOnDecode = false;
  // Intercept only the known synthetic raw plaintext decode, not SigV4 hashing.
  t.mock.method(Uint8Array, "from", function(...args: Parameters<typeof Uint8Array.from>) {
    const decoded = Reflect.apply(original, Uint8Array, args) as Uint8Array;
    if (typeof args[0] === "string" && /^\x07+$/.test(args[0])) {
      observed = decoded;
      if (abortOnDecode) ac.abort("SENSITIVE_POST_DECODE_REASON");
    }
    return decoded;
  });
  for (const phase of ["key", "length", "abort"] as const) {
    observed = undefined; ac = new AbortController(); abortOnDecode = phase === "abort";
    const kms = factory(async () => Response.json(result({ KeyId: phase === "key" ? "wrong" : ARN,
      Plaintext: Buffer.alloc(phase === "length" ? 31 : 32, 7).toString("base64") })));
    await assert.rejects(decrypt(kms, ac.signal), code(phase === "abort" ? "kms_aborted" : "kms_invalid_response"));
    assert(observed); assert(observed.every(b => b === 0));
  }
});
