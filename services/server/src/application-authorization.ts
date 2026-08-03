import {
  createPublicKey,
  verify as verifySignature
} from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  applicationInstallationIdFromPublicKey,
  authorizationSigningMessage,
  type ApplicationAuthorizationFlow,
  type ApplicationAuthorizationProof,
  type ApplicationFileRequirement,
  type CollectionOperation
} from "@mdbase-dev/connect-protocol";
import { z } from "zod";
import { isP256PublicKey } from "./security.js";

const MAX_ENCODED_PROOF_BYTES = 16_384;
const MAX_AUTHORIZATION_LIFETIME_MS = 15 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 2 * 60 * 1_000;
const P256_ORDER = BigInt(
  "0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551"
);
const P256_HALF_ORDER = P256_ORDER / 2n;

const fileRequirementSchema = z.object({
  actions: z.array(z.enum(["list", "read", "add", "replace", "move", "delete"]))
    .min(1)
    .max(6),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("collection") }).strict(),
    z.object({
      kind: z.literal("selected_folders"),
      folders: z.array(z.string().min(1).max(1_024)).min(1).max(100)
    }).strict()
  ])
}).strict();

const bindingSchema = z.object({
  protocol_version: z.literal(2),
  authorization_id: z.uuid(),
  application_id: z.uuid(),
  application_manifest_digest: z.string().regex(/^[0-9a-f]{64}$/),
  application_installation_id: z.uuid(),
  installation_signing_public_key: z.string().min(80).max(200),
  grant_agreement_public_key: z.string().min(80).max(200),
  grant_signing_public_key: z.string().min(80).max(200),
  flow: z.enum(["authorization_code", "device_code"]),
  authorization_nonce: z.string().min(1).max(100),
  issued_at: z.string().min(1).max(40),
  expires_at: z.string().min(1).max(40),
  redirect_uri: z.string().max(2_048).optional(),
  state: z.string().max(500).optional(),
  code_challenge: z.string().min(43).max(128),
  requested_operations: z.array(z.string().min(1).max(100)).max(100),
  requested_files: fileRequirementSchema.optional(),
  collection_id: z.uuid().optional()
}).strict();

const proofSchema = z.object({
  binding: bindingSchema,
  signature: z.string().min(1).max(200)
}).strict();

export interface ExpectedApplicationAuthorization {
  applicationId: string;
  applicationManifestDigest: string;
  flow: ApplicationAuthorizationFlow;
  redirectUri?: string;
  state?: string;
  codeChallenge: string;
  requestedOperations: CollectionOperation[];
  requestedFiles?: ApplicationFileRequirement;
  collectionId?: string;
  now?: Date;
}

export class ApplicationAuthorizationError extends Error {
  constructor(message = "The application authorization proof is invalid.") {
    super(message);
    this.name = "ApplicationAuthorizationError";
  }
}

export function parseApplicationAuthorization(value: unknown): ApplicationAuthorizationProof {
  let decoded = value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_ENCODED_PROOF_BYTES) {
      throw new ApplicationAuthorizationError();
    }
    try {
      decoded = JSON.parse(value);
    } catch {
      throw new ApplicationAuthorizationError();
    }
  }
  try {
    return proofSchema.parse(decoded) as ApplicationAuthorizationProof;
  } catch {
    throw new ApplicationAuthorizationError();
  }
}

export async function verifyApplicationAuthorization(
  value: unknown,
  expected: ExpectedApplicationAuthorization
): Promise<ApplicationAuthorizationProof> {
  const proof = parseApplicationAuthorization(value);
  const binding = proof.binding;
  const now = (expected.now ?? new Date()).getTime();
  const issuedAt = Date.parse(binding.issued_at);
  const expiresAt = Date.parse(binding.expires_at);
  if (
    !Number.isFinite(issuedAt)
    || !Number.isFinite(expiresAt)
    || expiresAt <= now
    || issuedAt > now + MAX_FUTURE_SKEW_MS
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > MAX_AUTHORIZATION_LIFETIME_MS
    || binding.application_id !== expected.applicationId
    || binding.application_manifest_digest !== expected.applicationManifestDigest
    || binding.flow !== expected.flow
    || binding.redirect_uri !== expected.redirectUri
    || binding.state !== expected.state
    || binding.code_challenge !== expected.codeChallenge
    || !isDeepStrictEqual(binding.requested_operations, expected.requestedOperations)
    || !isDeepStrictEqual(binding.requested_files, expected.requestedFiles)
    || binding.collection_id !== expected.collectionId
  ) {
    throw new ApplicationAuthorizationError();
  }
  const keys = [
    binding.installation_signing_public_key,
    binding.grant_agreement_public_key,
    binding.grant_signing_public_key
  ];
  if (
    keys.some((key) => !isP256PublicKey(key))
    || new Set(keys).size !== keys.length
    || await applicationInstallationIdFromPublicKey(keys[0]!)
      !== binding.application_installation_id
  ) {
    throw new ApplicationAuthorizationError();
  }
  const signature = canonicalSignature(proof.signature);
  let signingKey: ReturnType<typeof createPublicKey>;
  try {
    const point = Buffer.from(binding.installation_signing_public_key, "base64url");
    signingKey = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: point.subarray(1, 33).toString("base64url"),
        y: point.subarray(33, 65).toString("base64url")
      },
      format: "jwk"
    });
  } catch {
    throw new ApplicationAuthorizationError();
  }
  let message: Uint8Array;
  try {
    message = authorizationSigningMessage(binding);
  } catch {
    throw new ApplicationAuthorizationError();
  }
  if (!verifySignature(
    "sha256",
    message,
    { key: signingKey, dsaEncoding: "ieee-p1363" },
    signature
  )) {
    throw new ApplicationAuthorizationError();
  }
  return proof;
}

function canonicalSignature(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new ApplicationAuthorizationError();
  const signature = Buffer.from(value, "base64url");
  if (
    signature.length !== 64
    || signature.toString("base64url") !== value
  ) {
    throw new ApplicationAuthorizationError();
  }
  const r = bytesBigInt(signature.subarray(0, 32));
  const s = bytesBigInt(signature.subarray(32));
  if (
    r === 0n
    || r >= P256_ORDER
    || s === 0n
    || s > P256_HALF_ORDER
  ) {
    throw new ApplicationAuthorizationError();
  }
  return signature;
}

function bytesBigInt(value: Uint8Array): bigint {
  return BigInt(`0x${Buffer.from(value).toString("hex")}`);
}
