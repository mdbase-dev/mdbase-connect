import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ApplicationAuthorizationProof } from "@mdbase-dev/connect-protocol";
import { CONNECT_CONTRACT_SUPPORT } from "@mdbase-dev/connect-protocol";
import { describe, expect, it } from "vitest";
import {
  ApplicationAuthorizationError,
  ApplicationContractMismatchError,
  verifyApplicationAuthorization
} from "./application-authorization.js";

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL(
    "../../../packages/protocol/test/fixtures/application-authorization-v4.json",
    import.meta.url
  )),
  "utf8"
)) as ApplicationAuthorizationProof & { signing_message_sha256: string };
const proof: ApplicationAuthorizationProof = {
  binding: fixture.binding,
  signature: fixture.signature
};
const beta55FixtureDocument = JSON.parse(readFileSync(
  fileURLToPath(new URL(
    "../../../packages/protocol/test/fixtures/application-authorization-beta55-v4.json",
    import.meta.url
  )),
  "utf8"
)) as ApplicationAuthorizationProof & { signing_message_sha256: string };
const beta55Fixture: ApplicationAuthorizationProof = {
  binding: beta55FixtureDocument.binding,
  signature: beta55FixtureDocument.signature
};

const expected = {
  applicationId: fixture.binding.application_id,
  applicationDeclarationId: fixture.binding.application_declaration_id,
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

  it("verifies the frozen beta55 protocol-2/v4 proof without rewriting it", async () => {
    await expect(verifyApplicationAuthorization(beta55Fixture, {
      ...expected,
      requestedOperations: beta55Fixture.binding.requested_operations,
      requestedFiles: beta55Fixture.binding.requested_files
    })).resolves.toEqual(beta55Fixture);
  });

  it("rejects every substituted security boundary", async () => {
    const mutations: ApplicationAuthorizationProof[] = [
      { ...proof, signature: `${fixture.signature.slice(0, -1)}B` },
      { ...proof, binding: { ...fixture.binding, application_declaration_id: "dev.mdbase.other" } },
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

  it("classifies every independently versioned authorization contract", async () => {
    const cases = [
      ["operation_transport", 99, "transport_protocol_incompatible"],
      ["authorization_binding", 99, "authorization_binding_incompatible"],
      ["semantic_capabilities", 99, "capability_contract_incompatible"]
    ] as const;
    for (const [axis, version, code] of cases) {
      await expect(verifyApplicationAuthorization({
        ...proof,
        binding: {
          ...proof.binding,
          contracts: { ...proof.binding.contracts, [axis]: version }
        }
      }, expected)).rejects.toMatchObject({
        code,
        details: { contract: axis, required: CONNECT_CONTRACT_SUPPORT[axis] }
      });
    }
  });

  it("reports a v2 binding as incompatible instead of malformed", async () => {
    const legacy = JSON.stringify({
      ...proof,
      binding: { ...proof.binding, protocol_version: 2 }
    });
    await expect(verifyApplicationAuthorization(legacy, expected))
      .rejects.toBeInstanceOf(ApplicationContractMismatchError);
    await expect(verifyApplicationAuthorization(legacy, expected)).rejects.toMatchObject({
      code: "authorization_binding_incompatible",
      details: {
        contract: "authorization_binding",
        required: [5, 4],
        supported: [2],
        peer: "application"
      }
    });
  });

  it("requires durable mutation v1 only when the authorization can write", async () => {
    await expect(verifyApplicationAuthorization({
      ...proof,
      binding: {
        ...proof.binding,
        requested_operations: ["create"],
        contracts: { ...proof.binding.contracts }
      }
    }, {
      ...expected,
      requestedOperations: ["create"]
    })).rejects.toMatchObject({
      code: "durable_mutation_unsupported",
      details: {
        contract: "durable_mutation",
        required: [1],
        supported: [],
        peer: "application",
        operation: "create"
      }
    });
  });
});
