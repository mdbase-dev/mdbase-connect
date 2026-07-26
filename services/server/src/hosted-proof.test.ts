import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  HOSTED_PROOF_HEADERS,
  HOSTED_PROOF_VERSION
} from "@mdbase/connect-protocol";
import {
  hostedProofMessage,
  HostedProofError,
  verifyHostedRequestProof
} from "./hosted-proof.js";

const timestamp = 1_785_000_000;
const nonce = "01955555-5555-4555-8555-555555555555";

describe("hosted request proof verification", () => {
  it("accepts an exact P-256 proof and rejects body, credential, and time changes", () => {
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const publicJwk = keys.publicKey.export({ format: "jwk" });
    const publicKey = Buffer.concat([
      Buffer.from([4]),
      Buffer.from(publicJwk.x!, "base64url"),
      Buffer.from(publicJwk.y!, "base64url")
    ]).toString("base64url");
    const request = {
      method: "POST",
      target: "/v1/hosted/collections/one/operations/create",
      body: "{\"title\":\"proof\"}",
      credential: "hsa_secret"
    };
    const signature = sign(
      "sha256",
      Buffer.from(hostedProofMessage({ ...request, timestamp, nonce })),
      { key: keys.privateKey, dsaEncoding: "ieee-p1363" }
    ).toString("base64url");
    const headers = {
      [HOSTED_PROOF_HEADERS.version]: String(HOSTED_PROOF_VERSION),
      [HOSTED_PROOF_HEADERS.timestamp]: String(timestamp),
      [HOSTED_PROOF_HEADERS.nonce]: nonce,
      [HOSTED_PROOF_HEADERS.signature]: signature
    };
    expect(() => verifyHostedRequestProof(headers, publicKey, request, timestamp))
      .not.toThrow();
    expect(() => verifyHostedRequestProof(
      headers,
      publicKey,
      { ...request, body: "{\"title\":\"tampered\"}" },
      timestamp
    )).toThrow(HostedProofError);
    expect(() => verifyHostedRequestProof(
      headers,
      publicKey,
      { ...request, credential: "hsa_other" },
      timestamp
    )).toThrow(HostedProofError);
    expect(() => verifyHostedRequestProof(
      headers,
      publicKey,
      request,
      timestamp + 301
    )).toThrow("timestamp");
  });
});
