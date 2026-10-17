import { describe, expect, it } from "vitest";
import { nativeCompletionFromToken, type ExpectedNativeCompletion } from "../src/app-grant/native-completion.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
// Public standard P-256 generator point and X25519 basepoint; no credentials.
const point = "046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5";
const signing = b64(Uint8Array.from(point.match(/../g)!, hex => parseInt(hex, 16)));
const noise = b64(Uint8Array.from({ length: 32 }, (_, i) => i === 0 ? 9 : 0));
function fixture() {
  const expected: ExpectedNativeCompletion = {
    accountId: id(1), authorizationRequestId: id(2), applicationId: id(3), declarationId: "test.native-completion",
    manifestDigest: "a".repeat(64), applicationInstallationId: id(4), applicationOrigin: "https://app.example.test",
    collectionId: id(5), grantSigningPublicKey: signing, clientNoisePublicKey: noise,
  };
  const completion = {
    version: 1, account_id: expected.accountId, authorization_request_id: expected.authorizationRequestId,
    application_id: expected.applicationId, application_declaration_id: expected.declarationId,
    application_manifest_digest: expected.manifestDigest, application_installation_id: expected.applicationInstallationId,
    application_origin: expected.applicationOrigin, collection_id: expected.collectionId, grant_id: id(6),
    grant_signing_public_key: expected.grantSigningPublicKey, client_noise_public_key: expected.clientNoisePublicKey,
  };
  return { expected, completion, token: { grant_id: id(6), collection_id: expected.collectionId, application_origin: expected.applicationOrigin, native_completion: completion } };
}
function refuses(value: unknown, expected: ExpectedNativeCompletion): void {
  expect(() => nativeCompletionFromToken(value, expected)).toThrowError(expect.objectContaining({ code: "unauthenticated" }));
}

describe("original native completion metadata boundary (not admission or recovery)", () => {
  it("accepts the exact account/manifest/authorization/native-installation/keys tuple", () => {
    const f = fixture();
    const accepted = nativeCompletionFromToken(f.token, f.expected);
    expect(accepted).toEqual(f.completion);
    expect(Object.isFrozen(accepted)).toBe(true);
    f.completion.account_id = id(9);
    expect(accepted.account_id).toBe(f.expected.accountId);
  });
  it("accepts an independently known original authorization grant, not a log alias", () => {
    const f = fixture();
    expect(nativeCompletionFromToken(f.token, { ...f.expected, grantId: id(6) }).grant_id).toBe(id(6));
    refuses(f.token, { ...f.expected, grantId: id(99) });
  });
  it("refuses member/owner or wrong-account substitution even with the identical collection", () => {
    const f = fixture();
    f.completion.account_id = id(9);
    refuses(f.token, f.expected);
    expect(f.token.collection_id).toBe(f.expected.collectionId);
  });
  it.each([
    ["authorization_request_id", id(9)], ["application_id", id(9)], ["application_declaration_id", "test.other"],
    ["application_manifest_digest", "b".repeat(64)], ["application_installation_id", id(9)],
    ["application_origin", "https://other.example.test"], ["collection_id", id(9)],
    ["grant_signing_public_key", b64(Uint8Array.from({ length: 65 }, (_, i) => i === 0 ? 4 : 9))],
    ["client_noise_public_key", b64(new Uint8Array(32).fill(9))],
  ])("refuses replacement original binding %s", (field, value) => {
    const f = fixture();
    refuses({ ...f.token, native_completion: { ...f.completion, [field!]: value } }, f.expected);
  });
  it.each(["collection_id", "grant_id", "application_origin"] as const)("refuses a contradictory generic token %s", field => {
    const f = fixture();
    refuses({ ...f.token, [field]: field === "application_origin" ? "https://other.example.test" : id(9) }, f.expected);
  });
  it.each([undefined, null, [], {}, { status: "pending" }, { version: 2 }])("refuses absent, legacy, pending or unsupported completion %j", completion => {
    const f = fixture();
    refuses({ ...f.token, native_completion: completion }, f.expected);
  });
  it("refuses the request's attestation-object name in place of the public-key string", () => {
    const f = fixture();
    const { client_noise_public_key: _removed, ...rest } = f.completion;
    refuses({ ...f.token, native_completion: { ...rest, client_noise_key: { public_key: noise, signature: "not-a-receipt" } } }, f.expected);
  });
  it.each(["ready", "worker_device_id", "account_epoch"])("does not accept unratified completion field %s", field => {
    const f = fixture();
    refuses({ ...f.token, native_completion: { ...f.completion, [field]: true } }, f.expected);
  });
  it("requires an own version field rather than an inherited substitute", () => {
    const f = fixture();
    const { version: _removed, ...rest } = f.completion;
    refuses({ ...f.token, native_completion: Object.assign(Object.create({ version: 1 }), rest, { unexpected: true }) }, f.expected);
  });
  it.each(["account_id", "authorization_request_id", "application_id", "application_installation_id", "collection_id", "grant_id", "grant_signing_public_key", "client_noise_public_key"])("requires every original field including %s", field => {
    const f = fixture();
    const c: Record<string, unknown> = { ...f.completion };
    delete c[field];
    refuses({ ...f.token, native_completion: c }, f.expected);
  });
  it("does not use request freshness, computer presence, or arbitrary availability to infer admission", () => {
    const f = fixture();
    const accepted = nativeCompletionFromToken({ ...f.token, expires_at: 0, computer_online: false }, f.expected);
    expect(accepted).toEqual(f.completion);
    expect(accepted).not.toHaveProperty("ready");
  });
});
