import { randomUUID } from "node:crypto";
import { capabilityOperationsForContractVersion } from "@mdbase-dev/connect-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createDatabase } from "./db.js";
import { testApplicationAuthorization } from "./application-authorization.test-helper.js";
import { assertFreshApplicationAuthorization } from "./application-requirements.js";
import { pkceChallenge } from "./security.js";

const resources: Array<() => Promise<void>> = [];
afterEach(async () => { while (resources.length) await resources.pop()!(); });

describe("server fresh application issuance policy", () => {
  it("allows legacy v1, including declarations without semantic requirements", () => {
    expect(() => assertFreshApplicationAuthorization({ contracts: [], access: "full_collection" })).not.toThrow();
    expect(() => assertFreshApplicationAuthorization({ contracts: [], access: "full_collection", capabilities: { contract_version: 1, required: ["records.read"] } })).not.toThrow();
  });

  it.each([1, 2] as const)("checks v%s code/device requests after proof verification without inserting denied requests", async (version) => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const { app } = await buildApp({ db, devAuth: true, publicUrl: "http://connect.test" });
    resources.push(() => app.close());
    for (const flow of ["authorization_code", "device_code"] as const) {
      const capability = version === 1 ? "records.read" : "collection.read";
      const operations = [...capabilityOperationsForContractVersion(version, capability)!];
      const applicationId = randomUUID();
      const declarationId = `dev.mdbase.issuance-${flow}`;
      const digest = "a".repeat(64);
      const redirectUri = "http://localhost:4180/callback";
      await db.query(
        `INSERT INTO applications (id, canonical_identity, family_identity, manifest_digest, distribution, name, homepage, redirect_uris, requirements, provisions, notifications)
         VALUES ($1, $2, $3, $4, $5, 'Issuance test', 'http://localhost:4180', $6::jsonb, $7::jsonb, '{"type_packs":[],"configuration":[]}'::jsonb, '{"criteria":[]}'::jsonb)`,
        [applicationId, `${declarationId}:${applicationId}`, `bundle:${declarationId}`, digest,
          flow === "device_code" ? "portable" : "web", JSON.stringify([redirectUri]),
          JSON.stringify({ contracts: [], access: "full_collection", capabilities: { contract_version: version, required: [capability] } })]
      );
      const challenge = pkceChallenge("issuance-policy-verifier-long-enough-for-pkce-0001");
      const proof = await testApplicationAuthorization({
        applicationId, applicationDeclarationId: declarationId, applicationManifestDigest: digest,
        flow, codeChallenge: challenge, requestedOperations: operations,
        semanticCapabilityContractVersion: version,
        ...(flow === "authorization_code" ? { redirectUri, state: "issuance-state" } : {})
      });
      const payload = { client_id: applicationId, operations: operations.join(","), code_challenge: challenge,
        code_challenge_method: "S256", application_authorization: JSON.stringify(proof),
        ...(flow === "authorization_code" ? { redirect_uri: redirectUri, state: "issuance-state" } : {}) };
      const url = flow === "authorization_code" ? "/oauth/authorization_request" : "/oauth/device_authorization";
      const invalid = await app.inject({ method: "POST", url, payload: { ...payload, application_authorization: "invalid" } });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe("invalid_application_authorization");
      const response = await app.inject({ method: "POST", url, payload });
      expect(response.statusCode).toBe(version === 1 ? 200 : 400);
      if (version === 2) expect(response.json().error).toEqual({ code: "invalid_request", message: "Fresh application authorization issuance is disabled for semantic capability contract version 2." });
      const requests = await db.query("SELECT id FROM authorization_requests WHERE application_id = $1", [applicationId]);
      expect(requests.rows).toHaveLength(version === 1 ? 1 : 0);
    }
  });

  it("denies direct v2 grant issuance without creating a grant", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const { app } = await buildApp({ db, devAuth: true, publicUrl: "http://connect.test", allowInsecureManifests: true });
    resources.push(() => app.close());
    const session = await app.inject({ method: "POST", url: "/v1/dev/session", payload: { name: "Owner", email: "issuance@example.test" } });
    const setCookie = session.headers["set-cookie"]!;
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
    const registered = await app.inject({ method: "POST", url: "/v1/apps/register", payload: { manifest: {
      manifest_version: 1, id: "dev.mdbase.direct-issuance", name: "Direct issuance", homepage: "http://localhost:4180",
      redirect_uris: ["http://localhost:4180/callback"], requirements: { contracts: [], access: "full_collection", capabilities: { contract_version: 2, required: ["collection.read"] } }
    } } });
    expect(registered.statusCode).toBe(200);
    const connector = (await app.inject({ method: "POST", url: "/v1/connectors", headers: { cookie }, payload: { name: "Issuance computer" } })).json();
    const collectionId = randomUUID();
    const sync = await app.inject({ method: "POST", url: "/v1/connectors/sync", headers: { authorization: `Bearer ${connector.token}` }, payload: {
      inventory_revision: 1, collections: [{ id: collectionId, display_name: "Issuance collection", spec_version: "0.3.0", enabled: true, contracts: [] }]
    } });
    expect(sync.statusCode).toBe(200);
    const response = await app.inject({ method: "POST", url: "/v1/grants", headers: { cookie }, payload: {
      application_id: registered.json().application.id, collection_id: collectionId, operations: ["read", "query"]
    } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("issuance is disabled");
    expect((await db.query("SELECT id FROM grants")).rows).toHaveLength(0);
  });
});
