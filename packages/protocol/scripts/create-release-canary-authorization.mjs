import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign
} from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  applicationInstallationIdFromPublicKey,
  APPLICATION_AUTHORIZATION_PROTOCOL_VERSION,
  authorizationContractRequirements,
  authorizationSigningMessage
} from "../dist/index.js";

const P256_ORDER = BigInt(
  "0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551"
);
const P256_HALF_ORDER = P256_ORDER / 2n;

export async function createReleaseCanaryAuthorization(applicationId, manifestDigest) {
  const installationSigning = keyPair();
  const grantAgreement = keyPair();
  const grantSigning = keyPair();
  const issuedAt = new Date();
  const redirectUri = "http://127.0.0.1:8787/callback";
  const codeChallenge = "A".repeat(43);
  const state = "release-canary";
  const binding = {
    protocol_version: APPLICATION_AUTHORIZATION_PROTOCOL_VERSION,
    authorization_id: randomUUID(),
    application_id: applicationId,
    application_manifest_digest: manifestDigest,
    application_installation_id: await applicationInstallationIdFromPublicKey(
      installationSigning.publicKey
    ),
    installation_signing_public_key: installationSigning.publicKey,
    grant_agreement_public_key: grantAgreement.publicKey,
    grant_signing_public_key: grantSigning.publicKey,
    flow: "authorization_code",
    authorization_nonce: randomBytes(32).toString("base64url"),
    issued_at: issuedAt.toISOString(),
    expires_at: new Date(issuedAt.getTime() + 10 * 60 * 1_000).toISOString(),
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    contracts: authorizationContractRequirements(["describe"]),
    requested_operations: ["describe"]
  };
  const signature = canonicalSignature(sign(
    "sha256",
    authorizationSigningMessage(binding),
    { key: installationSigning.privateKey, dsaEncoding: "ieee-p1363" }
  )).toString("base64url");
  return {
    authorization_id: binding.authorization_id,
    form: {
      client_id: applicationId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      operations: "describe",
      application_authorization: JSON.stringify({ binding, signature })
    }
  };
}

function keyPair() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  if (!jwk.x || !jwk.y) throw new Error("P-256 key export failed.");
  return {
    privateKey: pair.privateKey,
    publicKey: Buffer.concat([
      Buffer.from([4]),
      Buffer.from(jwk.x, "base64url"),
      Buffer.from(jwk.y, "base64url")
    ]).toString("base64url")
  };
}

function canonicalSignature(signature) {
  const s = BigInt(`0x${signature.subarray(32).toString("hex")}`);
  if (s <= P256_HALF_ORDER) return signature;
  const normalized = (P256_ORDER - s).toString(16).padStart(64, "0");
  return Buffer.concat([
    signature.subarray(0, 32),
    Buffer.from(normalized, "hex")
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [applicationId, manifestDigest] = process.argv.slice(2);
  if (!applicationId || !manifestDigest) {
    console.error("Usage: create-release-canary-authorization.mjs APPLICATION_ID MANIFEST_DIGEST");
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify(
      await createReleaseCanaryAuthorization(applicationId, manifestDigest)
    ));
  }
}
