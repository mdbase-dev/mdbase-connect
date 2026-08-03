import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ApplicationAuthorizationProof } from "@mdbase-dev/connect-protocol";
import { describe, expect, it } from "vitest";
import {
  ApplicationAuthorizationError,
  verifyApplicationAuthorization
} from "./application-authorization.js";

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL(
    "../../../packages/protocol/test/fixtures/application-authorization-v2.json",
    import.meta.url
  )),
  "utf8"
)) as ApplicationAuthorizationProof & { signing_message_sha256: string };
const proof: ApplicationAuthorizationProof = {
  binding: fixture.binding,
  signature: fixture.signature
};

const expected = {
  applicationId: fixture.binding.application_id,
  applicationManifestDigest: fixture.binding.application_manifest_digest,
  flow: fixture.binding.flow,
  redirectUri: fixture.binding.redirect_uri,
  state: fixture.binding.state,
  codeChallenge: fixture.binding.code_challenge,
  requestedOperations: fixture.binding.requested_operations,
  requestedFiles: fixture.binding.requested_files,
  collectionId: fixture.binding.collection_id,
  now: new Date("2026-08-02T07:55:00.000Z")
} as const;

describe("application authorization proofs", () => {
  it("verifies the shared Rust/browser fixture", async () => {
    await expect(verifyApplicationAuthorization(proof, expected))
      .resolves.toEqual(expect.objectContaining({ signature: fixture.signature }));
  });

  it("rejects every substituted security boundary", async () => {
    const mutations: ApplicationAuthorizationProof[] = [
      { ...proof, signature: `${fixture.signature.slice(0, -1)}A` },
      { ...proof, binding: { ...fixture.binding, application_manifest_digest: "f".repeat(64) } },
      { ...proof, binding: { ...fixture.binding, requested_operations: ["describe"] } },
      { ...proof, binding: { ...fixture.binding, collection_id: undefined } }
    ];
    for (const mutation of mutations) {
      await expect(verifyApplicationAuthorization(mutation, expected))
        .rejects.toBeInstanceOf(ApplicationAuthorizationError);
    }
  });

  it("rejects expired, future, and overlong proofs", async () => {
    await expect(verifyApplicationAuthorization(proof, {
      ...expected,
      now: new Date("2026-08-02T08:00:00.000Z")
    })).rejects.toBeInstanceOf(ApplicationAuthorizationError);
    await expect(verifyApplicationAuthorization(proof, {
      ...expected,
      now: new Date("2026-08-02T07:47:59.999Z")
    })).rejects.toBeInstanceOf(ApplicationAuthorizationError);
    const overlong = {
      ...proof,
      binding: {
        ...fixture.binding,
        expires_at: "2026-08-02T08:05:00.001Z"
      }
    };
    await expect(verifyApplicationAuthorization(overlong, {
      ...expected,
      now: new Date("2026-08-02T07:55:00.000Z")
    })).rejects.toBeInstanceOf(ApplicationAuthorizationError);
  });
});
