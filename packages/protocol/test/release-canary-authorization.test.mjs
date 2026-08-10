import {
  createPublicKey,
  verify
} from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import {
  applicationInstallationIdFromPublicKey,
  authorizationSigningMessage
} from "../dist/index.js";
import {
  createReleaseCanaryAuthorization
} from "../scripts/create-release-canary-authorization.mjs";

const P256_HALF_ORDER = BigInt(
  "0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551"
) / 2n;

test("release canary uses the canonical signed authorization flow", async () => {
  const applicationId = "01955555-5555-7555-8555-555555555555";
  const manifestDigest = "ab".repeat(32);
  const canary = await createReleaseCanaryAuthorization(applicationId, manifestDigest);
  const proof = JSON.parse(canary.form.application_authorization);
  const { binding } = proof;

  assert.equal(canary.authorization_id, binding.authorization_id);
  assert.equal(canary.form.client_id, applicationId);
  assert.equal(binding.application_declaration_id, "dev.mdbase.release-canary");
  assert.equal(binding.application_manifest_digest, manifestDigest);
  assert.equal(binding.redirect_uri, canary.form.redirect_uri);
  assert.equal(binding.code_challenge, canary.form.code_challenge);
  assert.deepEqual(binding.requested_operations, ["describe"]);
  assert.deepEqual(binding.contracts, {
    operation_transport: 3,
    authorization_binding: 4,
    semantic_capabilities: 1
  });
  assert.equal(
    binding.application_installation_id,
    await applicationInstallationIdFromPublicKey(
      binding.installation_signing_public_key
    )
  );

  const signature = Buffer.from(proof.signature, "base64url");
  assert.equal(signature.length, 64);
  assert.ok(BigInt(`0x${signature.subarray(32).toString("hex")}`) <= P256_HALF_ORDER);
  assert.equal(verify(
    "sha256",
    authorizationSigningMessage(binding),
    { key: publicKey(binding.installation_signing_public_key), dsaEncoding: "ieee-p1363" },
    signature
  ), true);
});

function publicKey(encoded) {
  const bytes = Buffer.from(encoded, "base64url");
  assert.equal(bytes.length, 65);
  assert.equal(bytes[0], 4);
  return createPublicKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      x: bytes.subarray(1, 33).toString("base64url"),
      y: bytes.subarray(33).toString("base64url")
    }
  });
}
