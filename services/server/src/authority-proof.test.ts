import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AUTHORITY_PROOF_HEADERS,
  AUTHORITY_PROOF_VERSION
} from "@mdbase-dev/connect-protocol";
import {
  authorityProofMessage,
  AuthorityProofError,
  verifyAuthorityRequestProof
} from "./authority-proof.js";

const timestamp = 1_785_000_000;
const nonce = "01955555-5555-4555-8555-555555555555";

describe("authority request proof verification", () => {
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
      target: "/v1/authorities/one/operations/create",
      body: "{\"title\":\"proof\"}",
      credential: "hsa_secret"
    };
    const signature = sign(
      "sha256",
      Buffer.from(authorityProofMessage({ ...request, timestamp, nonce })),
      { key: keys.privateKey, dsaEncoding: "ieee-p1363" }
    ).toString("base64url");
    const headers = {
      [AUTHORITY_PROOF_HEADERS.version]: String(AUTHORITY_PROOF_VERSION),
      [AUTHORITY_PROOF_HEADERS.timestamp]: String(timestamp),
      [AUTHORITY_PROOF_HEADERS.nonce]: nonce,
      [AUTHORITY_PROOF_HEADERS.signature]: signature
    };
    expect(() => verifyAuthorityRequestProof(headers, publicKey, request, timestamp))
      .not.toThrow();
    expect(() => verifyAuthorityRequestProof(
      headers,
      publicKey,
      { ...request, body: "{\"title\":\"tampered\"}" },
      timestamp
    )).toThrow(AuthorityProofError);
    expect(() => verifyAuthorityRequestProof(
      headers,
      publicKey,
      { ...request, credential: "hsa_other" },
      timestamp
    )).toThrow(AuthorityProofError);
    expect(() => verifyAuthorityRequestProof(
      headers,
      publicKey,
      request,
      timestamp + 301
    )).toThrow("timestamp");
  });
});
