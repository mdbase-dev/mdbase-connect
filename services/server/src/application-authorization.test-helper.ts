import {
  generateKeyPairSync,
  randomUUID,
  sign
} from "node:crypto";
import {
  applicationInstallationIdFromPublicKeys,
  authorizationSigningMessage,
  type ApplicationAuthorizationBinding,
  type ApplicationAuthorizationProof,
  type ApplicationFileRequirement,
  type CollectionOperation
} from "@mdbase-dev/connect-protocol";

const P256_ORDER = BigInt(
  "0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551"
);
const P256_HALF_ORDER = P256_ORDER / 2n;

export async function testApplicationAuthorization(input: {
  applicationId: string;
  applicationManifestDigest: string;
  flow: "authorization_code" | "device_code";
  codeChallenge: string;
  requestedOperations: CollectionOperation[];
  requestedFiles?: ApplicationFileRequirement;
  redirectUri?: string;
  state?: string;
  collectionId?: string;
  authorizationId?: string;
  issuedAt?: Date;
  grantAgreementPublicKey?: string;
  grantSigningPublicKey?: string;
}): Promise<ApplicationAuthorizationProof> {
  const installationAgreement = keyPair();
  const installationSigning = keyPair();
  const grantAgreement = keyPair();
  const grantSigning = keyPair();
  const issuedAt = input.issuedAt ?? new Date();
  const binding: ApplicationAuthorizationBinding = {
    protocol_version: 1,
    authorization_id: input.authorizationId ?? randomUUID(),
    application_id: input.applicationId,
    application_manifest_digest: input.applicationManifestDigest,
    application_installation_id: await applicationInstallationIdFromPublicKeys(
      installationAgreement.publicKey,
      installationSigning.publicKey
    ),
    installation_agreement_public_key: installationAgreement.publicKey,
    installation_signing_public_key: installationSigning.publicKey,
    grant_agreement_public_key:
      input.grantAgreementPublicKey ?? grantAgreement.publicKey,
    grant_signing_public_key:
      input.grantSigningPublicKey ?? grantSigning.publicKey,
    flow: input.flow,
    authorization_nonce: Buffer.alloc(32, 7).toString("base64url"),
    issued_at: issuedAt.toISOString(),
    expires_at: new Date(issuedAt.getTime() + 10 * 60 * 1_000).toISOString(),
    code_challenge: input.codeChallenge,
    requested_operations: input.requestedOperations,
    ...(input.requestedFiles ? { requested_files: input.requestedFiles } : {}),
    ...(input.redirectUri ? { redirect_uri: input.redirectUri } : {}),
    ...(input.state ? { state: input.state } : {}),
    ...(input.collectionId ? { collection_id: input.collectionId } : {})
  };
  const signature = canonicalSignature(sign(
    "sha256",
    authorizationSigningMessage(binding),
    { key: installationSigning.privateKey, dsaEncoding: "ieee-p1363" }
  ));
  return { binding, signature: signature.toString("base64url") };
}

function keyPair() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  if (!jwk.x || !jwk.y) throw new Error("Test P-256 key export failed.");
  return {
    privateKey: pair.privateKey,
    publicKey: Buffer.concat([
      Buffer.from([4]),
      Buffer.from(jwk.x, "base64url"),
      Buffer.from(jwk.y, "base64url")
    ]).toString("base64url")
  };
}

function canonicalSignature(signature: Buffer): Buffer {
  const s = BigInt(`0x${signature.subarray(32).toString("hex")}`);
  if (s <= P256_HALF_ORDER) return signature;
  const normalized = (P256_ORDER - s).toString(16).padStart(64, "0");
  return Buffer.concat([
    signature.subarray(0, 32),
    Buffer.from(normalized, "hex")
  ]);
}
