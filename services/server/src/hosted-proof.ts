import {
  createHash,
  createPublicKey,
  verify
} from "node:crypto";
import {
  HOSTED_PROOF_DOMAIN,
  HOSTED_PROOF_HEADERS,
  HOSTED_PROOF_VERSION
} from "@mdbase/connect-protocol";

const PROOF_WINDOW_SECONDS = 5 * 60;

export interface HostedProofRequest {
  method: string;
  target: string;
  body?: string;
  credential: string;
}

export class HostedProofError extends Error {
  readonly code = "invalid_hosted_proof";
}

export function verifyHostedRequestProof(
  headers: Record<string, string | string[] | undefined>,
  expectedPublicKey: string,
  request: HostedProofRequest,
  nowSeconds = Math.floor(Date.now() / 1_000)
): void {
  const version = header(headers, HOSTED_PROOF_HEADERS.version);
  const timestampText = header(headers, HOSTED_PROOF_HEADERS.timestamp);
  const nonce = header(headers, HOSTED_PROOF_HEADERS.nonce);
  const signatureText = header(headers, HOSTED_PROOF_HEADERS.signature);
  if (
    version !== String(HOSTED_PROOF_VERSION)
    || !timestampText
    || !nonce
    || !signatureText
  ) {
    throw new HostedProofError("The hosted request proof is missing or unsupported.");
  }
  const timestamp = Number(timestampText);
  if (
    !Number.isSafeInteger(timestamp)
    || String(timestamp) !== timestampText
    || Math.abs(nowSeconds - timestamp) > PROOF_WINDOW_SECONDS
  ) {
    throw new HostedProofError("The hosted request proof timestamp is invalid or expired.");
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce)
  ) {
    throw new HostedProofError("The hosted request proof nonce is invalid.");
  }
  const publicBytes = base64Url(expectedPublicKey);
  const signature = base64Url(signatureText);
  if (publicBytes.length !== 65 || publicBytes[0] !== 4 || signature.length !== 64) {
    throw new HostedProofError("The hosted request proof key or signature is invalid.");
  }
  const publicKey = createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: publicBytes.subarray(1, 33).toString("base64url"),
      y: publicBytes.subarray(33).toString("base64url")
    },
    format: "jwk"
  });
  const valid = verify(
    "sha256",
    Buffer.from(hostedProofMessage({
      ...request,
      timestamp,
      nonce
    })),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    signature
  );
  if (!valid) {
    throw new HostedProofError("The hosted request proof signature is invalid.");
  }
}

export function hostedProofMessage(
  request: HostedProofRequest & { timestamp: number; nonce: string }
): string {
  return [
    HOSTED_PROOF_DOMAIN,
    HOSTED_PROOF_VERSION,
    request.method.toUpperCase(),
    request.target,
    digest(request.body ?? ""),
    digest(request.credential),
    request.timestamp,
    request.nonce
  ].join("\n");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function base64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new HostedProofError("The hosted request proof encoding is invalid.");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new HostedProofError("The hosted request proof encoding is not canonical.");
  }
  return decoded;
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}
