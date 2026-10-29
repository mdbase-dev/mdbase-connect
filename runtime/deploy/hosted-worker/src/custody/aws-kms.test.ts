import assert from "node:assert/strict";
import test from "node:test";
import { HostedAwsKms } from "./aws-kms.ts";
import { encodeEnvelope, parseEnvelope } from "./envelope.ts";
import { KMS_ALLOW_ALL_TEXT, KmsAllowlist } from "./kms-allowlist.ts";

// Public/non-deployable unit fixtures; NOT a KMS/CP fixture descriptor.
const COLLECTION = "11111111-1111-4111-8111-111111111111";
const DEVICE = "22222222-2222-4222-8222-222222222222";
const ARN = "arn:aws:kms:us-east-1:000000000000:key/33333333-3333-4333-8333-333333333333";
const CONFIG = { keyArn: ARN, region: "us-east-1", environment: "lab" as const, collections: [COLLECTION] };
const NOW = Date.UTC(2026, 9, 5);
// AWS's published documentation EXAMPLE credentials, never live credentials.
const CREDS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
const signal = () => new AbortController().signal;
const response = (field: string, bytes: Uint8Array) => Response.json({
  KeyId: ARN, EncryptionAlgorithm: "SYMMETRIC_DEFAULT", [field]: Buffer.from(bytes).toString("base64"),
});
const factory = (fetchImpl: typeof fetch, creds = () => CREDS) => new HostedAwsKms(CONFIG, creds, fetchImpl, () => NOW);

async function requestBody(input: Parameters<typeof fetch>[0]): Promise<Record<string, unknown>> {
  assert(input instanceof Request);
  assert.equal(input.url, "https://kms.us-east-1.amazonaws.com/");
  assert.equal(input.method, "POST");
  assert.equal(input.redirect, "manual");
  assert.match(input.headers.get("authorization")!, /AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261005\/us-east-1\/kms\/aws4_request/);
  return input.json();
}

test("wrap signs exact configured role/context and MDBK envelope without retaining input", async () => {
  const secret = new Uint8Array(96).fill(7);
  const kms = factory(async (input) => {
    const body = await requestBody(input);
    assert.equal(body.KeyId, ARN);
    assert.equal(body.Plaintext, Buffer.from(new Uint8Array(96).fill(7)).toString("base64"));
    assert.deepEqual(body.EncryptionContext, {
      "mdbase:service": "next-hosted", "mdbase:environment": "lab",
      "mdbase:collection-id": COLLECTION, "mdbase:device-id": DEVICE,
      "mdbase:purpose": "device-key", "mdbase:envelope-version": "1",
    });
    return response("CiphertextBlob", Uint8Array.of(1, 2, 3));
  });
  const work = kms.wrapDeviceKeys({ collection: COLLECTION, device: DEVICE, secret }, signal());
  secret.fill(0); // Caller mutation across sign/fetch does not change request bytes.
  const wrapped = await work;
  assert.equal(wrapped.kmsKeyArn, ARN);
  assert.deepEqual(parseEnvelope(wrapped.envelope), { keyRef: ARN, ciphertext: Uint8Array.of(1, 2, 3) });
});

test("staging escrow binds its own context for both wrap and unwrap; hosted default is unchanged", async () => {
  const seen: string[] = [];
  const kms = new HostedAwsKms({ ...CONFIG, environment: "staging", role: "escrow" }, () => CREDS, async input => {
    const body = await requestBody(input);
    const context = body.EncryptionContext as Record<string, string>;
    assert.equal(context["mdbase:service"], "next-escrow");
    assert.equal(context["mdbase:environment"], "staging");
    assert.equal(context["mdbase:collection-id"], COLLECTION);
    assert.equal(context["mdbase:device-id"], DEVICE);
    seen.push(body.Plaintext === undefined ? "Decrypt" : "Encrypt");
    return body.Plaintext === undefined ? response("Plaintext", new Uint8Array(96)) : response("CiphertextBlob", Uint8Array.of(1, 2, 3));
  }, () => NOW);
  const secret = new Uint8Array(96);
  const wrapped = await kms.wrapDeviceKeys({ collection: COLLECTION, device: DEVICE, secret }, signal());
  const opened = await kms.unwrapDeviceKeys(COLLECTION, DEVICE, wrapped.envelope, ARN, signal());
  assert.equal(opened.length, 96); opened.fill(0);
  assert.deepEqual(seen, ["Encrypt", "Decrypt"]);
  for (const environment of ["lab", "local"]) {
    assert.throws(() => new HostedAwsKms({ ...CONFIG, environment: environment as "lab", role: "escrow" }, () => CREDS), /kms_invalid_config/);
  }
});

test("production escrow generation binds the exact next-escrow production context (allow-all)", async () => {
  // Matches aws/lab-mig-kms.yaml (IsEscrow): exactly these six keys and values.
  const other = "44444444-4444-4444-8444-444444444444";
  const contexts: unknown[] = [];
  const kms = new HostedAwsKms({ ...CONFIG, environment: "production", role: "escrow", collections: KmsAllowlist.parse(KMS_ALLOW_ALL_TEXT) },
    () => CREDS, async input => {
      const body = await requestBody(input);
      contexts.push(body.EncryptionContext);
      return response("CiphertextBlob", Uint8Array.of(1, 2, 3));
    }, () => NOW);
  for (const collection of [COLLECTION, other]) {
    const wrapped = await kms.wrapDeviceKeys({ collection, device: DEVICE, secret: new Uint8Array(96) }, signal());
    assert.equal(wrapped.kmsKeyArn, ARN);
  }
  assert.deepEqual(contexts, [COLLECTION, other].map(collection => ({
    "mdbase:service": "next-escrow", "mdbase:environment": "production",
    "mdbase:collection-id": collection, "mdbase:device-id": DEVICE,
    "mdbase:purpose": "device-key", "mdbase:envelope-version": "1",
  })));
  // Allow-all still refuses malformed collection IDs before any KMS call.
  await assert.rejects(kms.wrapDeviceKeys({ collection: "00000000-0000-0000-0000-000000000000", device: DEVICE, secret: new Uint8Array(96) }, signal()),
    /kms_collection_not_allowed/);
  assert.equal(contexts.length, 2);
});

test("allow-all custody is refused outside staging/production", () => {
  const all = KmsAllowlist.parse(KMS_ALLOW_ALL_TEXT);
  for (const role of ["hosted", "escrow"] as const) for (const environment of ["lab", "local"]) {
    assert.throws(() => new HostedAwsKms({ ...CONFIG, environment: environment as "lab", role, collections: all }, () => CREDS), /kms_invalid_config/);
  }
  for (const role of ["hosted", "escrow"] as const) for (const environment of ["staging", "production"] as const) {
    assert.doesNotThrow(() => new HostedAwsKms({ ...CONFIG, environment, role, collections: all }, () => CREDS));
  }
  // A list can never express allow-all.
  assert.throws(() => new HostedAwsKms({ ...CONFIG, environment: "staging", collections: ["*"] }, () => CREDS), /kms_invalid_config/);
});

test("unwrap checks configured reference, explicit ARN and exact plaintext length", async () => {
  const kms = factory(async (input) => {
    const body = await requestBody(input);
    assert.equal(body.KeyId, ARN);
    assert.equal(body.CiphertextBlob, "AQID");
    return response("Plaintext", new Uint8Array(96).fill(9));
  });
  const plain = await kms.unwrapDeviceKeys(COLLECTION, DEVICE, encodeEnvelope(ARN, Uint8Array.of(1, 2, 3)), ARN, signal());
  assert.equal(plain.length, 96);
  assert.equal(plain[0], 9);
  plain.fill(0); // Caller-owned RAM buffer; no store is involved.
});

test("invalid config and no-scope deployments cannot reach AWS", async () => {
  for (const config of [
    { ...CONFIG, keyArn: "arn:aws:kms:us-east-1:000000000000:alias/test" },
    { ...CONFIG, region: "us-west-2" }, { ...CONFIG, collections: ["00000000-0000-0000-0000-000000000000"] },
  ]) assert.throws(() => new HostedAwsKms(config, () => CREDS));
  let calls = 0;
  const kms = new HostedAwsKms({ ...CONFIG, collections: [] }, () => CREDS, async () => { calls++; throw new Error("unexpected"); });
  await assert.rejects(kms.wrapDeviceKeys({ collection: COLLECTION, device: DEVICE, secret: new Uint8Array(96) }, signal()), /kms_collection_not_allowed/);
  assert.equal(calls, 0);
});

test("foreign reported/envelope key or malformed secret never reaches AWS", async () => {
  let calls = 0;
  const kms = factory(async () => { calls++; throw new Error("unexpected"); });
  await assert.rejects(kms.unwrapDeviceKeys(COLLECTION, DEVICE, encodeEnvelope(ARN, Uint8Array.of(1)), "foreign", signal()), /custody_key_not_configured/);
  await assert.rejects(kms.unwrapDeviceKeys(COLLECTION, DEVICE, encodeEnvelope("foreign", Uint8Array.of(1)), ARN, signal()), /custody_key_not_configured/);
  await assert.rejects(kms.wrapDeviceKeys({ collection: COLLECTION, device: DEVICE, secret: new Uint8Array(95) }, signal()), /custody_secret_invalid/);
  assert.equal(calls, 0);
});

test("no retry, key fallback or raw network error disclosure", async () => {
  let calls = 0;
  const kms = factory(async () => { calls++; throw new Error("SENSITIVE_REQUEST_DATA"); });
  await assert.rejects(kms.wrapDeviceKeys({ collection: COLLECTION, device: DEVICE, secret: new Uint8Array(96) }, signal()), (e: Error) => e.message === "kms_unavailable");
  assert.equal(calls, 1);
  calls = 0;
  const refused = factory(async () => { calls++; return new Response("SENSITIVE_ERROR_BODY", { status: 403 }); });
  await assert.rejects(refused.wrapDeviceKeys({ collection: COLLECTION, device: DEVICE, secret: new Uint8Array(96) }, signal()), /kms_refused/);
  assert.equal(calls, 1);
});

test("redirect response fails without retry or credential forwarding", async () => {
  let calls = 0;
  const kms = factory(async (input) => {
    calls++; assert(input instanceof Request); assert.equal(input.redirect, "manual");
    return new Response(null, {status: 302, headers: {location: "https://untrusted.invalid/"}});
  });
  await assert.rejects(kms.wrapDeviceKeys({collection: COLLECTION, device: DEVICE, secret: new Uint8Array(96)}, signal()), /kms_refused/);
  assert.equal(calls, 1);
});

test("credential provider errors and invalid clocks cannot leak request material", async () => {
  let calls = 0;
  const f: typeof fetch = async () => { calls++; return response("CiphertextBlob", Uint8Array.of(1)); };
  const kms = new HostedAwsKms(CONFIG, () => { throw new Error("SENSITIVE_CREDENTIAL_DATA"); }, f, () => NOW);
  await assert.rejects(kms.wrapDeviceKeys({ collection: COLLECTION, device: DEVICE, secret: new Uint8Array(96) }, signal()), (e: Error) => e.message === "kms_unavailable");
  const badClock = new HostedAwsKms(CONFIG, () => CREDS, f, () => NaN);
  await assert.rejects(badClock.wrapDeviceKeys({ collection: COLLECTION, device: DEVICE, secret: new Uint8Array(96) }, signal()), /kms_credentials_unavailable/);
  assert.equal(calls, 0);
});

test("long-lived credentials need no session token; future STS requires trusted expiry", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    calls++;
    assert(input instanceof Request);
    assert.equal(input.headers.get("x-amz-security-token"), "unit-session");
    return response("CiphertextBlob", Uint8Array.of(1));
  };
  for (const expiresAt of [undefined, NOW, NOW + 30_000]) {
    const kms = new HostedAwsKms(CONFIG, () => ({ ...CREDS, sessionToken: "unit-session", expiresAt }), fetchImpl, () => NOW);
    await assert.rejects(kms.wrapDeviceKeys({ collection: COLLECTION, device: DEVICE, secret: new Uint8Array(96) }, signal()), /kms_credentials_unavailable/);
  }
  assert.equal(calls, 0);
  const kms = new HostedAwsKms(CONFIG, () => ({ ...CREDS, sessionToken: "unit-session", expiresAt: NOW + 60_000 }), fetchImpl, () => NOW);
  await kms.wrapDeviceKeys({ collection: COLLECTION, device: DEVICE, secret: new Uint8Array(96) }, signal());
  assert.equal(calls, 1);
});

test("reject foreign response key/algorithm, noncanonical bytes and wrong secret length", async () => {
  for (const data of [
    { KeyId: "foreign", EncryptionAlgorithm: "SYMMETRIC_DEFAULT", Plaintext: "AA==" },
    { KeyId: ARN, EncryptionAlgorithm: "RSAES_OAEP_SHA_256", Plaintext: "AA==" },
    { KeyId: ARN, EncryptionAlgorithm: "SYMMETRIC_DEFAULT", Plaintext: "AB==" },
    { KeyId: ARN, EncryptionAlgorithm: "SYMMETRIC_DEFAULT", Plaintext: "AA==" },
  ]) {
    const kms = factory(async () => Response.json(data));
    await assert.rejects(kms.unwrapDeviceKeys(COLLECTION, DEVICE, encodeEnvelope(ARN, Uint8Array.of(1)), ARN, signal()), /kms_invalid_response|custody_secret_invalid/);
  }
});

test("response budget is enforced on streaming actual bytes and declared length", async () => {
  for (const resp of [new Response("x", { headers: { "content-length": "16385" } }), new Response("x".repeat(16385))]) {
    const kms = factory(async () => resp);
    await assert.rejects(kms.wrapDeviceKeys({ collection: COLLECTION, device: DEVICE, secret: new Uint8Array(96) }, signal()), /kms_invalid_response/);
  }
});

test("aborted input and abort during a hanging response fail closed", async () => {
  let calls = 0;
  const pre = new AbortController(); pre.abort();
  const kms = factory(async () => { calls++; return response("CiphertextBlob", Uint8Array.of(1)); });
  await assert.rejects(kms.wrapDeviceKeys({ collection: COLLECTION, device: DEVICE, secret: new Uint8Array(96) }, pre.signal));
  assert.equal(calls, 0);
  const mid = new AbortController();
  const hanging = factory(async () => {
    calls++;
    setTimeout(() => mid.abort(), 5);
    return new Response(new ReadableStream());
  });
  await assert.rejects(hanging.wrapDeviceKeys({ collection: COLLECTION, device: DEVICE, secret: new Uint8Array(96) }, mid.signal), /kms_aborted/);
});
