import {
  createECDH,
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign
} from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type {
  CollectionOperation,
  LegacyMdbaseAppManifest,
  MdbaseAppManifest
} from "@mdbase-dev/connect-protocol";
import {
  AUTHORITY_PROOF_HEADERS,
  AUTHORITY_PROOF_VERSION,
  operationsForApplicationCapabilities
} from "@mdbase-dev/connect-protocol";
import type { ApplicationRequirements } from "./features/applications/application-requirements.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { createDatabase } from "./db.js";
import { authorityProofMessage } from "./features/authority-transfer/authority-proof.js";
import { pkceChallenge, tokenHash } from "./security.js";
import {
  createTestApplicationIdentity,
  testApplicationAuthorization,
  LEGACY_READ_CAPABILITIES, LEGACY_READ_OPERATIONS, legacyOperations
} from "./application-authorization.test-helper.js";

const resources: Array<() => Promise<void>> = [];
const TEST_CONTRACT_DIGEST = `sha256:${"0".repeat(64)}`;
const READ_OPERATIONS = operationsForApplicationCapabilities({
  contract_version: 2,
  required: ["collection.read"]
});

function p256PublicKey(): string {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = keys.publicKey.export({ format: "jwk" });
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x!, "base64url"),
    Buffer.from(jwk.y!, "base64url")
  ]).toString("base64url");
}

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
  vi.restoreAllMocks();
});

// Derive browser request verbs from SDK route implementations and transport method
// contracts, including prepared uploads whose method is forwarded rather than literal
// at fetch(). Do not maintain a second fixed list that misses a new SDK verb.
function browserSdkMethods(): string[] {
  const methods = new Set<string>();
  function directory(url: URL): void {
    for (const entry of readdirSync(url, { withFileTypes: true })) {
      const path = new URL(entry.name, url);
      if (entry.isDirectory()) directory(new URL(`${entry.name}/`, url));
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        const source = readFileSync(path, "utf8");
        // Literal request fields and named method type unions are the SDK's
        // HTTP route/transport declarations; forwarded prepared.method is
        // covered by its typed literal declaration too.
        for (const declaration of source.matchAll(/(?:\bmethod|["']method["'])\s*:\s*((?:["'][A-Z]+["']\s*\|\s*)*["'][A-Z]+["'])/g)) {
          for (const literal of declaration[1]!.matchAll(/["']([A-Z]+)["']/g)) methods.add(literal[1]!);
        }
      }
    }
  }
  directory(new URL("../../../runtime/packages/sdk/src/", import.meta.url));
  return [...methods].sort();
}

describe("mdbase connect server", () => {
  it.each(["https://mdbase-l11-lab.pages.dev", "https://application.example"])("advertises every browser SDK method in unauthenticated preflight from %s", async (origin) => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const { app } = await buildApp({ db, publicUrl: "https://connect.example" });
    resources.push(() => app.close());
    const sdkMethods = browserSdkMethods();
    expect(sdkMethods.length).toBeGreaterThan(0);
    for (const method of sdkMethods) {
      const response = await app.inject({
        method: "OPTIONS",
        url: "/v1/next/collections/00000000-0000-4000-8000-000000000000/timers/lab-l11/preflight-only",
        headers: {
          origin,
          "access-control-request-method": method,
          "access-control-request-headers": "authorization,content-type"
        }
      });
      expect(response.statusCode).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe(origin);
      expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
      const methods = String(response.headers["access-control-allow-methods"]).split(",").map((value) => value.trim());
      expect(methods).toContain(method);
      const headers = String(response.headers["access-control-allow-headers"]).split(",").map((value) => value.trim().toLowerCase());
      expect(headers).toEqual(expect.arrayContaining(["authorization", "content-type"]));
      // Cached by the browser so warm app opens skip the OPTIONS round trip.
      expect(response.headers["access-control-max-age"]).toBe("7200");
    }
  });

  it("permits management mutations from the configured editor origin", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const { app } = await buildApp({
      db,
      devAuth: true,
      publicUrl: "http://connect.test",
      editorOrigin: "http://editor.test",
      managementOrigins: ["http://editor.test"]
    });
    resources.push(() => app.close());

    for (const method of ["PATCH", "DELETE"]) {
      const response = await app.inject({
        method: "OPTIONS",
        url: "/v1/hosted/collections/00000000-0000-4000-8000-000000000000",
        headers: {
          origin: "http://editor.test",
          "access-control-request-method": method
        }
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers["access-control-allow-origin"]).toBe("http://editor.test");
      expect(response.headers["access-control-allow-methods"]).toContain(method);
    }
  });

  it("keeps beta connector account snapshots decodable for password identities", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const { app } = await buildApp({
      db,
      devAuth: true,
      publicUrl: "http://connect.test"
    });
    resources.push(() => app.close());

    const session = await app.inject({
      method: "POST",
      url: "/v1/dev/session",
      payload: { name: "Acceptance user", email: "acceptance@example.com" }
    });
    const setCookie = session.headers["set-cookie"]!;
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
    await db.query(
      `INSERT INTO email_identities
         (id, user_id, email, normalized_email, verified_at, is_primary)
       SELECT $1, id, $2, $2, now(), true FROM users WHERE email = $2`,
      [randomUUID(), "acceptance@example.com"]
    );
    await db.query("UPDATE users SET email = NULL WHERE email = $1", ["acceptance@example.com"]);

    const connector = await app.inject({
      method: "POST",
      url: "/v1/connectors",
      headers: { cookie },
      payload: { name: "Acceptance computer" }
    });
    expect(connector.statusCode).toBe(201);
    const control = await app.inject({
      method: "GET",
      url: "/v1/connectors/control",
      headers: { authorization: `Bearer ${connector.json().token}` }
    });

    expect(control.statusCode).toBe(200);
    expect(control.json().account).toMatchObject({
      connector_name: "Acceptance computer",
      user_name: "Acceptance user",
      user_email: "acceptance@example.com"
    });
  });

  it("publishes the runtime editor handoff without baking it into the portal", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const { app } = await buildApp({
      db,
      devAuth: true,
      publicUrl: "http://connect.test",
      editorOrigin: "http://editor.test"
    });
    resources.push(() => app.close());

    const response = await app.inject({ method: "GET", url: "/v1/ui-configuration" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      editor_url: "http://editor.test/connect?server=http%3A%2F%2Fconnect.test"
    });
  });

  it("reports the deployed revision when one is configured", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const { app } = await buildApp({
      db,
      devAuth: true,
      publicUrl: "http://connect.test",
      revision: "ae3a8d9"
    });
    resources.push(() => app.close());

    const health = await app.inject({ method: "GET", url: "/health" });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({
      ok: true,
      service: "mdbase-connect",
      protocol_version: 1,
      capabilities: ["application-authorization-v2-issuance"],
      revision: "ae3a8d9"
    });
  });

  it("publishes a verifiable non-secret environment identity", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const { app } = await buildApp({
      db,
      devAuth: true,
      publicUrl: "https://connect-lab.example",
      environment: "lab"
    });
    resources.push(() => app.close());

    const health = await app.inject({ method: "GET", url: "/health" });

    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      ok: true,
      service: "mdbase-connect",
      environment: "lab",
      public_origin: "https://connect-lab.example"
    });
  });

  it("reports plugin rate limits as retryable problems with the existing Retry-After", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const { app } = await buildApp({ db, devAuth: true, publicUrl: "http://connect.test" });
    resources.push(() => app.close());
    app.get("/test-rate-limit", { config: { rateLimit: { max: 1, timeWindow: "1 minute" } } }, async () => ({ ok: true }));

    expect((await app.inject("/test-rate-limit")).statusCode).toBe(200);
    const limited = await app.inject("/test-rate-limit");
    const retryAfterSeconds = Number(limited.headers["retry-after"]);
    expect(limited.statusCode).toBe(429);
    expect(retryAfterSeconds).toBeGreaterThan(0);
    expect(retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(limited.json()).toEqual({
      error: {
        code: "rate_limited",
        message: "Too many requests. Please try again later.",
        details: { retry_after_ms: retryAfterSeconds * 1000 }
      }
    });
  });

  it("keeps malformed and oversized request bodies out of the server-error path", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const { app } = await buildApp({
      db,
      devAuth: true,
      publicUrl: "http://connect.test"
    });
    resources.push(() => app.close());

    const malformed = await app.inject({
      method: "POST",
      url: "/v1/dev/session",
      headers: { "content-type": "application/json" },
      payload: "{"
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "The request body is invalid."
      }
    });

    const oversized = await app.inject({
      method: "POST",
      url: "/v1/dev/session",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ padding: "x".repeat(2 * 1024 * 1024 + 1) })
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toEqual({
      error: {
        code: "payload_too_large",
        message: "The request body exceeds the allowed size."
      }
    });
  });

  it("reports an unavailable local collection instead of an invalid token", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const userId = "10000000-0000-4000-8000-000000000081";
    const connectorId = "20000000-0000-4000-8000-000000000081";
    const collectionId = "30000000-0000-4000-8000-000000000081";
    const localId = "70000000-0000-4000-8000-000000000081";
    const applicationId = "40000000-0000-4000-8000-000000000081";
    const grantId = "50000000-0000-4000-8000-000000000081";
    const connectorToken = "connector-unavailable-token";
    const accessToken = "access-unavailable-token";
    // Insert after startup so legacy grant reconciliation leaves the fixture alone.
    const { app } = await buildApp({ db, devAuth: true, publicUrl: "http://connect.test" });
    resources.push(() => app.close());
    await db.query(
      "INSERT INTO users (id, email, name) VALUES ($1, 'claimed@example.com', 'Claimed')",
      [userId]
    );
    await db.query(
      `INSERT INTO connectors (id, user_id, name, token_hash, inventory_revision)
       VALUES ($1, $2, 'Laptop', $3, 0)`,
      [connectorId, userId, tokenHash(connectorToken)]
    );
    await db.query(
      `INSERT INTO collections
         (id, user_id, connector_id, local_id, display_name, spec_version)
       VALUES ($1, $2, $3, $4, 'Notes', '0.3.0')`,
      [collectionId, userId, connectorId, localId]
    );
    await db.query(
      `INSERT INTO applications
         (id, canonical_identity, name, homepage, redirect_uris)
       VALUES ($1, 'web:https://claimed-app.example', 'Claimed app',
         'https://claimed-app.example',
         '["https://claimed-app.example/callback"]'::jsonb)`,
      [applicationId]
    );
    await db.query(
      `INSERT INTO grants
         (id, user_id, application_id, collection_id, operations, scope,
          application_authorization, application_installation_id, activated_at)
       VALUES ($1, $2, $3, $4, '["read"]'::jsonb,
               '{"access":"full_collection","contracts":[]}'::jsonb,
               '{"binding":{"protocol_version":4}}'::jsonb, $5, now())`,
      [grantId, userId, applicationId, collectionId, randomUUID()]
    );
    await db.query(
      `INSERT INTO access_tokens (id, token_hash, grant_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [randomUUID(), tokenHash(accessToken), grantId]
    );
    const inventory = (revision: number, collection: Record<string, unknown>) => app.inject({
      method: "POST",
      url: "/v1/connectors/sync",
      headers: { authorization: `Bearer ${connectorToken}` },
      payload: {
        inventory_revision: revision,
        collections: [{
          id: localId,
          display_name: "Notes",
          spec_version: "0.3.0",
          contracts: [],
          ...collection
        }]
      }
    });
    const read = (token: string) => app.inject({
      method: "POST",
      url: `/v1/authorities/${localId}/operations/read`,
      headers: { authorization: `Bearer ${token}` },
      payload: { path: "note.md" }
    });

    expect((await inventory(1, {
      enabled: false,
      unavailable_reason: "claimed_by_newer_runtime"
    })).statusCode).toBe(200);
    const claimed = await read(accessToken);
    expect(claimed.statusCode).toBe(409);
    expect(claimed.json().error).toMatchObject({
      code: "collection_unavailable",
      details: { reason: "claimed_by_newer_runtime" }
    });
    const files = await app.inject({
      method: "POST",
      url: `/v1/authorities/${localId}/files/control`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {}
    });
    expect(files.statusCode).toBe(409);
    expect(files.json().error.code).toBe("collection_unavailable");

    expect((await inventory(2, { enabled: false })).statusCode).toBe(200);
    const paused = await read(accessToken);
    expect(paused.statusCode).toBe(409);
    expect(paused.json().error.details).toEqual({ reason: "paused" });

    // A connector reporting the collection available clears any old reason,
    // and an explicit null is accepted like an omitted reason.
    expect((await inventory(3, {
      enabled: true,
      unavailable_reason: "claimed_by_newer_runtime"
    })).statusCode).toBe(200);
    expect((await inventory(4, { enabled: true, unavailable_reason: null })).statusCode)
      .toBe(200);
    const stored = await db.query<{ unavailable_reason: string | null }>(
      "SELECT unavailable_reason FROM collections WHERE id = $1",
      [collectionId]
    );
    expect(stored.rows[0]?.unavailable_reason).toBeNull();

    const unknown = await read("not-a-token");
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().error.code).toBe("invalid_token");
  });

  it("enforces account suspension across connector and application credentials", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const userId = "10000000-0000-4000-8000-000000000080";
    const connectorId = "20000000-0000-4000-8000-000000000080";
    const collectionId = "30000000-0000-4000-8000-000000000080";
    const applicationId = "40000000-0000-4000-8000-000000000080";
    const grantId = "50000000-0000-4000-8000-000000000080";
    const connectorToken = "connector-suspension-token";
    const accessToken = "access-suspension-token";
    const refreshToken = "refresh-suspension-token";
    const authorizationCode = "authorization-suspension-code";
    const pairingSecret = "pairing-suspension-secret";
    const pairingId = "60000000-0000-4000-8000-000000000080";
    const verifier = "suspension-verifier-that-is-long-enough-for-pkce-0001";
    await db.query(
      `INSERT INTO users (id, email, name, suspended_at)
       VALUES ($1, 'suspended@example.com', 'Suspended', now())`,
      [userId]
    );
    await db.query(
      `INSERT INTO connectors (id, user_id, name, token_hash)
       VALUES ($1, $2, 'Laptop', $3)`,
      [connectorId, userId, tokenHash(connectorToken)]
    );
    await db.query(
      `INSERT INTO collections
         (id, user_id, connector_id, local_id, display_name, spec_version)
       VALUES ($1, $2, $3, $4, 'Notes', '0.3.0')`,
      [collectionId, userId, connectorId, randomUUID()]
    );
    await db.query(
      `INSERT INTO applications
         (id, canonical_identity, name, homepage, redirect_uris)
       VALUES ($1, 'web:https://suspended-app.example', 'Suspended app',
         'https://suspended-app.example',
         '["https://suspended-app.example/callback"]'::jsonb)`,
      [applicationId]
    );
    await db.query(
      `INSERT INTO grants
         (id, user_id, application_id, collection_id, operations,
          application_authorization, application_installation_id)
       VALUES ($1, $2, $3, $4, '["read"]'::jsonb,
               '{"binding":{"protocol_version":4}}'::jsonb, $5)`,
      [grantId, userId, applicationId, collectionId, randomUUID()]
    );
    await db.query(
      `INSERT INTO access_tokens (id, token_hash, grant_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [randomUUID(), tokenHash(accessToken), grantId]
    );
    await db.query(
      `INSERT INTO refresh_tokens (id, token_hash, grant_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 day')`,
      [randomUUID(), tokenHash(refreshToken), grantId]
    );
    await db.query(
      `INSERT INTO authorization_codes
         (id, code_hash, grant_id, application_id, redirect_uri,
          code_challenge, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + interval '5 minutes')`,
      [
        randomUUID(),
        tokenHash(authorizationCode),
        grantId,
        applicationId,
        "https://suspended-app.example/callback",
        pkceChallenge(verifier)
      ]
    );
    await db.query(
      `INSERT INTO pairing_requests
         (id, secret_hash, connector_name, user_id, approved_at, expires_at)
       VALUES ($1, $2, 'Pending laptop', $3, now(), now() + interval '1 hour')`,
      [pairingId, tokenHash(pairingSecret), userId]
    );
    const { app } = await buildApp({
      db,
      devAuth: true,
      publicUrl: "http://connect.test"
    });
    resources.push(() => app.close());
    // The startup scan revokes this undeclared fixture app's grant at a racy
    // moment; settle it and restore the grant so suspension is what refuses.
    await (app as typeof app & { drainApplicationReconciliation(): Promise<void> })
      .drainApplicationReconciliation();
    await db.query("UPDATE grants SET revoked_at = NULL WHERE id = $1", [grantId]);
    await db.query("UPDATE refresh_tokens SET revoked_at = NULL WHERE grant_id = $1", [grantId]);
    await db.query("UPDATE access_tokens SET revoked_at = NULL WHERE grant_id = $1", [grantId]);

    const connector = await app.inject({
      method: "GET",
      url: "/v1/connectors/control",
      headers: { authorization: `Bearer ${connectorToken}` }
    });
    expect(connector.statusCode).toBe(401);
    expect(connector.json().error.code).toBe("invalid_connector");

    const operation = await app.inject({
      method: "POST",
      url: `/v1/authorities/${collectionId}/operations/read`,
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { path: "note.md" }
    });
    expect(operation.statusCode).toBe(401);
    expect(operation.json().error.code).toBe("invalid_token");
    const refresh = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: applicationId
      }).toString()
    });
    expect(refresh.statusCode).toBe(403);
    expect(refresh.json().error).toMatchObject({
      code: "account_suspended",
      message: expect.stringContaining("Contact mdbase support")
    });

    const code = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        code: authorizationCode,
        client_id: applicationId,
        redirect_uri: "https://suspended-app.example/callback",
        code_verifier: verifier
      }).toString()
    });
    expect(code.statusCode).toBe(403);
    expect(code.json().error.code).toBe("account_suspended");

    const pairing = await app.inject({
      method: "POST",
      url: `/v1/pairing-requests/${pairingId}/exchange`,
      headers: { authorization: `Bearer ${pairingSecret}` }
    });
    expect(pairing.statusCode).toBe(404);
    expect(pairing.json().error.code).toBe("pairing_not_found");
  });

  it("returns complete signed grant summaries to local connectors", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const userId = "10000000-0000-4000-8000-000000000081";
    const connectorId = "20000000-0000-4000-8000-000000000081";
    const localCollectionId = "30000000-0000-4000-8000-000000000081";
    const collectionId = "40000000-0000-4000-8000-000000000081";
    const applicationId = "50000000-0000-4000-8000-000000000081";
    const grantId = "60000000-0000-4000-8000-000000000081";
    const connectorToken = "connector-complete-grant-summary-token";
    const applicationDeclarationId = "dev.mdbase.complete.summary";
    const applicationManifestDigest = "a".repeat(64);
    const proof = await testApplicationAuthorization({
      applicationId,
      applicationDeclarationId,
      applicationManifestDigest,
      flow: "device_code",
      codeChallenge: pkceChallenge(
        "complete-grant-summary-verifier-that-is-long-enough-for-pkce"
      ),
      requestedOperations: ["describe", "query"],
      collectionId: localCollectionId
    });
    await db.query(
      `INSERT INTO users (id, email, name)
       VALUES ($1, 'summary@example.com', 'Summary')`,
      [userId]
    );
    await db.query(
      `INSERT INTO connectors (id, user_id, name, token_hash)
       VALUES ($1, $2, 'Summary computer', $3)`,
      [connectorId, userId, tokenHash(connectorToken)]
    );
    await db.query(
      `INSERT INTO collections
         (id, user_id, connector_id, local_id, display_name, spec_version)
       VALUES ($1, $2, $3, $4, 'Summary collection', '0.3.0')`,
      [collectionId, userId, connectorId, localCollectionId]
    );
    await db.query(
      `INSERT INTO applications
         (id, canonical_identity, family_identity, manifest_digest, name,
          homepage, redirect_uris)
       VALUES ($1, $2, $3, $4, 'Summary application',
         'https://summary.example', '["https://summary.example/callback"]'::jsonb)`,
      [
        applicationId,
        `bundle:${applicationDeclarationId}:sha256:${applicationManifestDigest}`,
        `bundle:${applicationDeclarationId}`,
        applicationManifestDigest
      ]
    );
    await db.query(
      `INSERT INTO grants
         (id, user_id, application_id, collection_id, operations,
          application_authorization, application_installation_id)
       VALUES ($1, $2, $3, $4, '["describe","query"]'::jsonb,
               $5::jsonb, $6)`,
      [
        grantId,
        userId,
        applicationId,
        collectionId,
        JSON.stringify(proof),
        proof.binding.application_installation_id
      ]
    );
    const { app } = await buildApp({
      db,
      devAuth: true,
      publicUrl: "http://connect.test"
    });
    resources.push(() => app.close());

    const response = await app.inject({
      method: "GET",
      url: "/v1/connectors/control",
      headers: { authorization: `Bearer ${connectorToken}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().grants).toEqual([
      expect.objectContaining({
        id: grantId,
        application_declaration_id: applicationDeclarationId,
        application_manifest_digest: applicationManifestDigest,
        contracts: proof.binding.contracts
      })
    ]);
    expect(response.json().grants[0]).not.toHaveProperty(
      "application_authorization"
    );
  });

  it("registers exact bundled declarations as immutable application identities", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const { app } = await buildApp({
      db,
      devAuth: true,
      publicUrl: "http://connect.test"
    });
    resources.push(() => app.close());
    const manifest: MdbaseAppManifest = {
      manifest_version: 1,
      id: "dev.mdbase.tasks",
      name: "Tasks",
      homepage: "https://tasks.example/",
      redirect_uris: [
        "https://tasks.example/auth/mdbase/callback",
        "dev.mdbase.tasks://auth/mdbase/callback"
      ],
      requirements: {
        capabilities: {
          contract_version: 2,
          required: ["collection.read"]
        },
        access: "full_collection",
        contracts: [{
          id: "example.work-item",
          version: "1.0.0",
          digest: TEST_CONTRACT_DIGEST
        }]
      },
      provisions: {
        type_packs: [typePackProvision(
          "example.tasks",
          [
            ["type", "task.md", "_types/task.md", "---\nkind: mdbase.type\nname: task\n---\n"],
            [
              "type",
              "task-comment.md",
              "_types/task_comment.md",
              "---\nkind: mdbase.type\nname: task_comment\n---\n"
            ]
          ],
          [{
            id: "example.work-item",
            version: "1.0.0",
            digest: TEST_CONTRACT_DIGEST
          }]
        )]
      }
    };

    const validated = await app.inject({
      method: "POST",
      url: "/v1/apps/validate",
      payload: { manifest }
    });
    expect(validated.statusCode).toBe(200);
    expect(validated.json()).toMatchObject({
      valid: true,
      declaration: {
        canonical_identity: expect.stringMatching(
          /^bundle:dev\.mdbase\.tasks:sha256:[a-f0-9]{64}$/
        ),
        family_identity: "bundle:dev.mdbase.tasks",
        manifest_digest: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    });
    expect((await db.query("SELECT COUNT(*)::int AS count FROM applications")).rows[0])
      .toEqual({ count: 1 }); // validation adds no row beyond the installation seed

    const first = await app.inject({
      method: "POST",
      url: "/v1/apps/register",
      payload: { manifest }
    });
    const repeated = await app.inject({
      method: "POST",
      url: "/v1/apps/register",
      payload: { manifest }
    });
    const changed = await app.inject({
      method: "POST",
      url: "/v1/apps/register",
      payload: { manifest: { ...manifest, name: "Tasks Next" } }
    });

    expect(first.statusCode).toBe(200);
    expect(repeated.json().application.id).toBe(first.json().application.id);
    expect(first.json().application.canonical_identity)
      .toMatch(/^bundle:dev\.mdbase\.tasks:sha256:[a-f0-9]{64}$/);
    expect(first.json().application.provisions.type_packs).toHaveLength(1);
    expect(changed.statusCode).toBe(200);
    expect(changed.json().application.id).not.toBe(first.json().application.id);
  });

  it("rejects bundled declarations with callbacks outside their declared identity", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const { app } = await buildApp({
      db,
      devAuth: true,
      publicUrl: "http://connect.test"
    });
    resources.push(() => app.close());

    const response = await app.inject({
      method: "POST",
      url: "/v1/apps/register",
      payload: {
        manifest: {
          manifest_version: 1,
          id: "dev.mdbase.tasks",
          name: "Tasks",
          homepage: "https://tasks.example/",
          redirect_uris: ["com.example.impostor://auth/mdbase/callback"]
        }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("invalid_application_manifest");
    expect(response.json().error.details.issues[0]).toMatchObject({
      path: "/redirect_uris/0",
      keyword: "origin"
    });
  });

  it("runs the prelude v1 discovery, consent, token, and offline operation path", async () => {
    const READ_OPERATIONS = LEGACY_READ_OPERATIONS;
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const { app } = await buildApp({
      db,
      devAuth: true,
      publicUrl: "http://connect.test"
    });
    resources.push(() => app.close());

    const session = await app.inject({
      method: "POST",
      url: "/v1/dev/session",
      payload: { name: "Callum", email: "callum@example.com" }
    });
    expect(session.statusCode).toBe(200);
    const setCookie = session.headers["set-cookie"]!;
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];

    const pairingStarted = await app.inject({
      method: "POST",
      url: "/v1/pairing-requests",
      payload: { connector_name: "Browser-paired computer" }
    });
    expect(pairingStarted.statusCode).toBe(201);
    const pairing = pairingStarted.json();
    const pairingApproved = await app.inject({
      method: "POST",
      url: `/v1/pairing-requests/${pairing.pairing_id}/approve`,
      headers: { cookie }
    });
    expect(pairingApproved.statusCode).toBe(200);
    expect(pairingApproved.json().deep_link).toContain("mdbase-connect://paired");
    const pairingExchanged = await app.inject({
      method: "POST",
      url: `/v1/pairing-requests/${pairing.pairing_id}/exchange`,
      headers: { authorization: `Bearer ${pairing.pairing_secret}` }
    });
    expect(pairingExchanged.statusCode).toBe(200);
    expect(pairingExchanged.json().token).toMatch(/^con_/);

    const connectorResponse = await app.inject({
      method: "POST",
      url: "/v1/connectors",
      headers: { cookie },
      payload: { name: "Home computer" }
    });
    expect(connectorResponse.statusCode).toBe(201);
    const connector = connectorResponse.json();
    const malformedKey = await app.inject({
      method: "POST",
      url: "/v1/connectors/sync",
      headers: { authorization: `Bearer ${connector.token}` },
      payload: { relay_public_key: "A".repeat(87), collections: [] }
    });
    expect(malformedKey.statusCode).toBe(400);
    const connectorKey = createECDH("prime256v1");
    connectorKey.generateKeys();
    const localCollectionId = "125cc8cf-dad5-4fc9-b0bc-a1c92e99f3ed";
    const incompatibleLocalCollectionId = "225cc8cf-dad5-4fc9-b0bc-a1c92e99f3ed";
    const legacyLocalCollectionId = "525cc8cf-dad5-4fc9-b0bc-a1c92e99f3ed";
    const synchronized = await app.inject({
      method: "POST",
      url: "/v1/connectors/sync",
      headers: { authorization: `Bearer ${connector.token}` },
      payload: {
        relay_public_key: connectorKey.getPublicKey(undefined, "uncompressed").toString("base64url"),
        inventory_revision: 1,
        collections: [{
          id: localCollectionId,
          display_name: "Workouts",
          spec_version: "0.3.0",
          enabled: true,
          contracts: [contractDescriptor()]
        }, {
          id: incompatibleLocalCollectionId,
          display_name: "Z Archive",
          spec_version: "0.3.0",
          enabled: true,
          contracts: []
        }, {
          id: legacyLocalCollectionId,
          display_name: "Legacy workouts",
          spec_version: "0.2.0",
          enabled: true,
          contracts: [contractDescriptor()]
        }]
      }
    });
    expect(synchronized.statusCode).toBe(200);
    const collectionId = synchronized.json().collections[0].id as string;
    const authorityRows = await db.query<{ id: string; local_id: string }>(
      "SELECT id, local_id FROM collections WHERE connector_id = $1",
      [connector.connector.id]
    );
    const authorityId = (localId: string) =>
      authorityRows.rows.find((collection) => collection.local_id === localId)!.id;

    const manifestServer = applicationManifestFixture();
    manifestServer.manifest.requirements.capabilities = {
      contract_version: 1,
      required: LEGACY_READ_CAPABILITIES
    };
    const discovered = await app.inject({
      method: "POST",
      url: "/v1/apps/register",
      payload: { manifest: manifestServer.manifest }
    });
    expect(discovered.statusCode).toBe(200);
    expect(discovered.json().application.requirements).toEqual({
      access: "full_collection",
      configuration: [],
      contracts: [{
        id: "workout.record",
        version: "1.0.0",
        digest: TEST_CONTRACT_DIGEST
      }],
      capabilities: {
        contract_version: 1,
        required: LEGACY_READ_CAPABILITIES
      }
    });
    const applicationId = discovered.json().application.id as string;
    const applicationManifestDigest =
      discovered.json().application.manifest_digest as string;
    const definitionManager = applicationManifestFixture({
      contracts: [],
      access: "full_collection",
      capabilities: {
        contract_version: 1,
        required: ["definitions.create", "definitions.update"]
      }
    }, "Definition Manager");
    definitionManager.manifest.id = "dev.mdbase.definition-manager";
    definitionManager.manifest.redirect_uris = [definitionManager.redirectUri];
    const registeredDefinitionManager = await app.inject({
      method: "POST",
      url: "/v1/apps/register",
      payload: { manifest: definitionManager.manifest }
    });
    expect(
      registeredDefinitionManager.statusCode,
      registeredDefinitionManager.body
    ).toBe(200);
    const semanticAuthorization = await postWebAuthorization(app, {
      applicationId: registeredDefinitionManager.json().application.id,
      applicationDeclarationId: definitionManager.manifest.id,
      applicationManifestDigest:
        registeredDefinitionManager.json().application.manifest_digest,
      redirectUri: definitionManager.redirectUri,
      verifier: "semantic-capability-verifier-that-is-long-enough-0001",
      state: "semantic-capability",
      operations: legacyOperations(["definitions.create", "definitions.update"]),
      collectionId
    });
    expect(semanticAuthorization.statusCode, semanticAuthorization.body).toBe(200);

    const invalidEncryption = await app.inject({
      method: "GET",
      url: `/oauth/authorize?client_id=${applicationId}&redirect_uri=${encodeURIComponent(manifestServer.redirectUri)}&code_challenge=${"a".repeat(43)}&code_challenge_method=S256&relay_protocol=3&application_agreement_public_key=${"A".repeat(87)}`,
      headers: { cookie }
    });
    expect(invalidEncryption.statusCode).toBe(400);
    expect(invalidEncryption.json().error.code).toBe("invalid_request");
    const reusedApplicationKey = p256PublicKey();
    const reusedEncryptionKey = await app.inject({
      method: "GET",
      url: `/oauth/authorize?client_id=${applicationId}&redirect_uri=${encodeURIComponent(manifestServer.redirectUri)}&code_challenge=${"a".repeat(43)}&code_challenge_method=S256&relay_protocol=1&application_agreement_public_key=${reusedApplicationKey}&application_signing_public_key=${reusedApplicationKey}`,
      headers: { cookie }
    });
    expect(reusedEncryptionKey.statusCode).toBe(400);
    expect(reusedEncryptionKey.json().error.code).toBe("invalid_request");
    const legacyCompatibleGrantId = "325cc8cf-dad5-4fc9-b0bc-a1c92e99f3ed";
    const legacyIncompatibleGrantId = "425cc8cf-dad5-4fc9-b0bc-a1c92e99f3ed";
    const user = await db.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [
      "callum@example.com"
    ]);
    await db.query(
      `INSERT INTO grants
         (id, user_id, application_id, collection_id, operations, scope,
          application_authorization, application_installation_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb,
               '{"binding":{"protocol_version":4}}'::jsonb, $10),
              ($7, $2, $3, $8, $5::jsonb, $9::jsonb,
               '{"binding":{"protocol_version":4}}'::jsonb, $10)`,
      [
        legacyCompatibleGrantId,
        user.rows[0].id,
        applicationId,
        authorityId(localCollectionId),
        JSON.stringify(["read"]),
        JSON.stringify({ contracts: [] }),
        legacyIncompatibleGrantId,
        authorityId(incompatibleLocalCollectionId),
        JSON.stringify({ contracts: [contractDescriptor()] }),
        randomUUID()
      ]
    );
    const rediscovered = await app.inject({
      method: "POST",
      url: "/v1/apps/register",
      payload: { manifest: manifestServer.manifest }
    });
    expect(rediscovered.statusCode).toBe(200);
    await (app as typeof app & { drainApplicationReconciliation(): Promise<void> })
      .drainApplicationReconciliation();
    const reconciled = await db.query<{ id: string; scope: unknown; revoked_at: string | null }>(
      "SELECT id, scope, revoked_at FROM grants WHERE id IN ($1, $2) ORDER BY id",
      [legacyCompatibleGrantId, legacyIncompatibleGrantId]
    );
    expect(reconciled.rows.find((grant) => grant.id === legacyCompatibleGrantId)?.revoked_at)
      .not.toBeNull();
    expect(reconciled.rows.find((grant) => grant.id === legacyIncompatibleGrantId)?.revoked_at)
      .not.toBeNull();
    await db.query("DELETE FROM grants WHERE id IN ($1, $2)", [
      legacyCompatibleGrantId,
      legacyIncompatibleGrantId
    ]);
    const incompatibleGrant = await app.inject({
      method: "POST",
      url: "/v1/connectors/grants",
      headers: { authorization: `Bearer ${connector.token}` },
      payload: {
        application_id: applicationId,
        collection_id: incompatibleLocalCollectionId,
        operations: READ_OPERATIONS
      }
    });
    expect(incompatibleGrant.statusCode).toBe(409);
    expect(incompatibleGrant.json().error.code).toBe("incompatible_collection");
    const legacyGrant = await app.inject({
      method: "POST",
      url: "/v1/connectors/grants",
      headers: { authorization: `Bearer ${connector.token}` },
      payload: {
        application_id: applicationId,
        collection_id: legacyLocalCollectionId,
        operations: READ_OPERATIONS
      }
    });
    expect(legacyGrant.statusCode).toBe(400);
    expect(legacyGrant.json().error.code).toBe("invalid_request");

    const capabilityOnlyAuthorization = await postWebAuthorization(app, {
        applicationId,
        applicationManifestDigest,
        redirectUri: manifestServer.redirectUri,
        verifier: "view-scope-verifier-that-is-long-enough-000001",
        state: "overbroad",
        operations: ["list_views", "execute_view"]
    });
    expect(capabilityOnlyAuthorization.statusCode).toBe(400);

    const verifier = "local-connector-verifier-that-is-long-enough-00001";
    const state = "test-state";
    const authorize = await startWebAuthorization(app, cookie, {
        applicationId,
        applicationManifestDigest,
        redirectUri: manifestServer.redirectUri,
        verifier,
        state,
        operations: READ_OPERATIONS,
        collectionId
    });
    expect(authorize.statusCode).toBe(302);
    const requestId = authorize.headers.location!.split("/").at(-1)!;

    const pending = await app.inject({
      method: "GET",
      url: `/v1/authorization-requests/${requestId}`,
      headers: { cookie }
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json().authorization.application_name).toBe("Workout Tracker");
    expect(pending.json().authorization.collection_id).toBe(collectionId);
    expect(pending.json().authorization.account_backend).toBe("legacy");
    // Retained declarations may predate native-origin validation. Consent must
    // classify the actual persisted authorization origin independently.
    const declaredApp = (await db.query("SELECT application_declaration FROM applications WHERE id=$1",[applicationId])).rows[0].application_declaration;
    await db.query("UPDATE applications SET application_declaration=$2::jsonb WHERE id=$1",[applicationId,JSON.stringify({...declaredApp,platform:"native"})]);
    for (const flow of ["authorization_code","device_code"]) for (const origin of ["http://127.0.0.1:49152","https://remote.example.test","http://localhost:49152","http://[::1]:49152"]) {
      await db.query("UPDATE authorization_requests SET flow=$2,redirect_uri=$3,device_origin=$4 WHERE id=$1",[requestId,flow,`${origin}/callback`,origin]);
      const preview = await app.inject({method:"GET",url:`/v1/authorization-requests/${requestId}`,headers:{cookie}});
      expect(preview.statusCode).toBe(200);
      expect(preview.json().authorization.application_origin).toBe(origin);
      expect(preview.json().authorization).not.toHaveProperty("redirect_uri");
      expect(preview.json().authorization).not.toHaveProperty("device_origin");
      expect(preview.json().authorization.platform).toBe(origin === "http://127.0.0.1:49152" ? "native" : undefined);
    }
    await db.query("UPDATE authorization_requests SET flow='authorization_code',redirect_uri=$2,device_origin=NULL WHERE id=$1",[requestId,manifestServer.redirectUri]);
    await db.query("UPDATE applications SET application_declaration=$2::jsonb WHERE id=$1",[applicationId,JSON.stringify(declaredApp)]);

    await db.query("UPDATE users SET account_backend='next' WHERE email='callum@example.com'");
    const nextPending = await app.inject({ method: "GET", url: `/v1/authorization-requests/${requestId}`, headers: { cookie } });
    expect(nextPending.statusCode).toBe(200);
    expect(nextPending.json().authorization.account_backend).toBe("next");
    await db.query("UPDATE users SET account_backend='legacy' WHERE email='callum@example.com'");
    expect(pending.json().collections).toEqual([]);
    expect(pending.json().unavailable_connectors).toContainEqual(
      expect.objectContaining({
        connector_name: "Home computer",
        reason: "offline"
      })
    );

    const portalLegacyApproval = await app.inject({
      method: "POST",
      url: `/v1/authorization-requests/${requestId}/approve`,
      headers: { cookie },
      payload: {
        collection_id: synchronized.json().collections[2].id,
        operations: READ_OPERATIONS
      }
    });
    expect(portalLegacyApproval.statusCode).toBe(404);

    const localControl = await app.inject({
      method: "GET",
      url: "/v1/connectors/control",
      headers: { authorization: `Bearer ${connector.token}` }
    });
    expect(localControl.statusCode).toBe(200);
    expect(localControl.json().pending_authorizations[0].application_name).toBe("Workout Tracker");
    expect(localControl.json().pending_authorizations[0].collection_id).toBe(localCollectionId);
    expect(localControl.json().pending_authorizations[0].requirements).toEqual({
      access: "full_collection",
      configuration: [],
      contracts: [{
        id: "workout.record",
        version: "1.0.0",
        digest: TEST_CONTRACT_DIGEST
      }],
      capabilities: {
        contract_version: 1,
        required: LEGACY_READ_CAPABILITIES
      }
    });

    const connectorLegacyApproval = await app.inject({
      method: "POST",
      url: `/v1/connectors/authorization-requests/${requestId}/approve`,
      headers: { authorization: `Bearer ${connector.token}` },
      payload: { collection_id: legacyLocalCollectionId, operations: READ_OPERATIONS }
    });
    expect(connectorLegacyApproval.statusCode).toBe(404);
    expect(connectorLegacyApproval.json().error.code)
      .toBe("authorization_not_found");

    const approved = await app.inject({
      method: "POST",
      url: `/v1/connectors/authorization-requests/${requestId}/approve`,
      headers: { authorization: `Bearer ${connector.token}` },
      payload: { collection_id: localCollectionId, operations: READ_OPERATIONS }
    });
    expect(approved.statusCode).toBe(409);
    expect(approved.json().error.code).toBe("connector_offline");

    const deniedState = "denied-state";
    const deniedAuthorization = await startWebAuthorization(app, cookie, {
        applicationId,
        applicationManifestDigest,
        redirectUri: manifestServer.redirectUri,
        verifier,
        state: deniedState,
        operations: READ_OPERATIONS
    });
    const deniedRequestId = deniedAuthorization.headers.location!.split("/").at(-1)!;
    const denied = await app.inject({
      method: "POST",
      url: `/v1/connectors/authorization-requests/${deniedRequestId}/deny`,
      headers: { authorization: `Bearer ${connector.token}` }
    });
    expect(denied.statusCode).toBe(200);
    expect(denied.json()).toEqual({ ok: true });
    const portalDenied = await app.inject({
      method: "POST",
      url: `/v1/authorization-requests/${deniedRequestId}/deny`,
      headers: { cookie }
    });
    expect(portalDenied.statusCode).toBe(404); // Already denied natively; no second decision.
    const deniedStatus = await app.inject({
      method: "GET",
      url: `/v1/authorization-requests/${deniedRequestId}/status`,
      headers: { cookie }
    });
    expect(deniedStatus.json()).toEqual({
      status: "denied",
      redirect_uri: expect.stringContaining("error=access_denied")
    });

    const portalAuthorization = await startWebAuthorization(app, cookie, {
        applicationId,
        applicationManifestDigest,
        redirectUri: manifestServer.redirectUri,
        verifier,
        state: "portal-approval",
        operations: READ_OPERATIONS
    });
    const portalRequestId = portalAuthorization.headers.location!.split("/").at(-1)!;
    const waitingDashboard = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
    expect(waitingDashboard.json().pending_authorizations).toContainEqual(
      expect.objectContaining({
        id: portalRequestId,
        application_name: "Workout Tracker",
        available_collections: []
      })
    );
    const portalApproved = await app.inject({
      method: "POST",
      url: `/v1/authorization-requests/${portalRequestId}/approve`,
      headers: { cookie },
      payload: { collection_id: collectionId, operations: READ_OPERATIONS }
    });
    expect(portalApproved.statusCode).toBe(404);
    const locallyApproved = await app.inject({
      method: "POST",
      url: `/v1/connectors/authorization-requests/${portalRequestId}/approve`,
      headers: { authorization: `Bearer ${connector.token}` },
      payload: { collection_id: localCollectionId, operations: READ_OPERATIONS }
    });
    expect(locallyApproved.statusCode).toBe(409);
    expect(locallyApproved.json().error.code).toBe("connector_offline");
    const policyAfterPortalApproval = await app.inject({
      method: "GET",
      url: "/v1/connectors/control",
      headers: { authorization: `Bearer ${connector.token}` }
    });
    expect(policyAfterPortalApproval.json().grants).toEqual([]);
    expect(policyAfterPortalApproval.json().pending_authorizations).toContainEqual(
      expect.objectContaining({ id: portalRequestId })
    );

    const dashboard = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().collections).toContainEqual(
      expect.objectContaining({ display_name: "Workouts" })
    );
    expect(dashboard.json().grants).toEqual([]);

    const renamedComputer = await app.inject({
      method: "PATCH",
      url: `/v1/connectors/${connector.connector.id}`,
      headers: { cookie },
      payload: { name: "Desk computer" }
    });
    expect(renamedComputer.statusCode).toBe(200);
    expect(renamedComputer.json().connector.name).toBe("Desk computer");
    const locallyRenamedComputer = await app.inject({
      method: "PATCH",
      url: "/v1/connectors/self",
      headers: { authorization: `Bearer ${connector.token}` },
      payload: { name: "Studio computer" }
    });
    expect(locallyRenamedComputer.statusCode).toBe(200);
    expect(locallyRenamedComputer.json().connector.name).toBe("Studio computer");

    const broadenedForTest = await app.inject({
      method: "POST",
      url: "/v1/grants",
      headers: { cookie },
      payload: {
        application_id: applicationId,
        collection_id: collectionId,
        operations: READ_OPERATIONS
      }
    });
    expect(broadenedForTest.statusCode).toBe(409);
    expect(broadenedForTest.json().error.code)
      .toBe("application_authorization_required");
  });

  it("authorizes prelude semantic v1 portable applications with a single-use key-bound device flow", async () => {
    const READ_OPERATIONS = LEGACY_READ_OPERATIONS;
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const { app } = await buildApp({
      db,
      devAuth: true,
      publicUrl: "http://connect.test"
    });
    resources.push(() => app.close());

    const session = await app.inject({
      method: "POST",
      url: "/v1/dev/session",
      payload: { name: "Portable owner", email: "portable@example.com" }
    });
    const setCookie = session.headers["set-cookie"]!;
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
    const otherSession = await app.inject({
      method: "POST",
      url: "/v1/dev/session",
      payload: { name: "Another user", email: "other-portable@example.com" }
    });
    const otherSetCookie = otherSession.headers["set-cookie"]!;
    const otherCookie = (Array.isArray(otherSetCookie) ? otherSetCookie[0] : otherSetCookie)
      .split(";")[0];

    const connectorResponse = await app.inject({
      method: "POST",
      url: "/v1/connectors",
      headers: { cookie },
      payload: { name: "Portable computer" }
    });
    const connector = connectorResponse.json();
    const connectorKey = createECDH("prime256v1");
    connectorKey.generateKeys();
    const localCollectionId = "725cc8cf-dad5-4fc9-b0bc-a1c92e99f3ed";
    const synchronized = await app.inject({
      method: "POST",
      url: "/v1/connectors/sync",
      headers: { authorization: `Bearer ${connector.token}` },
      payload: {
        relay_public_key: connectorKey.getPublicKey(undefined, "uncompressed").toString("base64url"),
        inventory_revision: 1,
        collections: [{
          id: localCollectionId,
          display_name: "Portable notes",
          spec_version: "0.3.0",
          enabled: true,
          contracts: []
        }]
      }
    });
    const collectionId = synchronized.json().collections[0].id as string;
    const manifest: LegacyMdbaseAppManifest = {
      manifest_version: 1,
      distribution: "portable",
      id: "dev.mdbase.portable-notes",
      name: "Portable notes",
      project_url: "https://apps.example/portable-notes",
      requirements: {
        contracts: [],
        access: "full_collection",
        capabilities: {
          contract_version: 1,
          required: LEGACY_READ_CAPABILITIES,
          optional: ["timers.list", "timers.put", "timers.cancel", "timers.reconcile"]
        }
      }
    };
    const registration = await app.inject({
      method: "POST",
      url: "/v1/apps/register",
      payload: { manifest }
    });
    expect(registration.statusCode).toBe(200);
    expect(registration.json().application).toMatchObject({
      distribution: "portable",
      homepage: "",
      project_url: "https://apps.example/portable-notes"
    });
    const applicationId = registration.json().application.id as string;
    const applicationManifestDigest =
      registration.json().application.manifest_digest as string;
    const verifier = "portable-verifier-that-is-long-enough-for-pkce-0001";
    const timerProof = await testApplicationAuthorization({
      semanticCapabilityContractVersion: 1,
      applicationId,
      applicationDeclarationId: manifest.id,
      applicationManifestDigest,
      flow: "device_code",
      codeChallenge: pkceChallenge(verifier),
      requestedOperations: [
        ...READ_OPERATIONS,
        "list_timers", "put_timer", "cancel_timer", "reconcile_timers"
      ],
      collectionId
    });
    const timerDevice = await app.inject({
      method: "POST",
      url: "/oauth/device_authorization",
      headers: {
        origin: "null",
        "content-type": "application/x-www-form-urlencoded"
      },
      payload: new URLSearchParams({
        client_id: applicationId,
        operations: [
          ...READ_OPERATIONS,
          "list_timers", "put_timer", "cancel_timer", "reconcile_timers"
        ].join(","),
        collection_id: collectionId,
        code_challenge: pkceChallenge(verifier),
        code_challenge_method: "S256",
        application_authorization: JSON.stringify(timerProof)
      }).toString()
    });
    expect(timerDevice.statusCode).toBe(400);
    expect(timerDevice.json().error.message).toBe(
      "Timer operations require an mdbase.runtime.timer.fired notification criterion."
    );

    const proof = await testApplicationAuthorization({
      applicationId,
      applicationDeclarationId: manifest.id,
      applicationManifestDigest,
      flow: "device_code",
      codeChallenge: pkceChallenge(verifier),
      requestedOperations: READ_OPERATIONS,
      semanticCapabilityContractVersion: 1,
      collectionId
    });
    const applicationAgreementPublicKey = proof.binding.grant_agreement_public_key;
    const device = await app.inject({
      method: "POST",
      url: "/oauth/device_authorization",
      headers: {
        origin: "null",
        "content-type": "application/x-www-form-urlencoded"
      },
      payload: new URLSearchParams({
        client_id: applicationId,
        operations: READ_OPERATIONS.join(","),
        collection_id: collectionId,
        code_challenge: pkceChallenge(verifier),
        code_challenge_method: "S256",
        application_authorization: JSON.stringify(proof)
      }).toString()
    });
    expect(device.statusCode, JSON.stringify(device.json())).toBe(200);
    expect(device.headers["access-control-allow-origin"]).toBe("null");
    expect(device.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(device.headers["cache-control"]).toContain("no-store");
    expect(device.json()).toMatchObject({
      verification_uri: "http://connect.test/device",
      expires_in: expect.any(Number),
      interval: 5
    });
    expect(device.json().user_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(device.json().verification_uri_complete).toContain(
      encodeURIComponent(device.json().user_code)
    );

    const webAuthorizeBypass = await app.inject({
      method: "GET",
      url: `/oauth/authorize?client_id=${applicationId}&redirect_uri=${encodeURIComponent("https://apps.example/callback")}&code_challenge=${pkceChallenge(verifier)}&code_challenge_method=S256`,
      headers: { cookie }
    });
    expect(webAuthorizeBypass.statusCode).toBe(400);
    expect(webAuthorizeBypass.json().error.code).toBe("invalid_request");

    const manualGrantBypass = await app.inject({
      method: "POST",
      url: "/v1/grants",
      headers: { cookie },
      payload: {
        application_id: applicationId,
        collection_id: collectionId,
        operations: ["query"]
      }
    });
    expect(manualGrantBypass.statusCode).toBe(409);
    expect(manualGrantBypass.json().error.code).toBe("portable_approval_required");

    const pendingPoll = await pollDeviceToken(app, {
      applicationId,
      deviceCode: device.json().device_code,
      verifier
    });
    expect(pendingPoll.statusCode).toBe(400);
    expect(pendingPoll.json()).toMatchObject({ error: "authorization_pending" });
    expect((await pollDeviceToken(app, {
      applicationId,
      deviceCode: device.json().device_code,
      verifier
    })).json()).toMatchObject({ error: "slow_down" });

    const missingSession = await app.inject({
      method: "POST",
      url: "/v1/device-authorization-requests/lookup",
      payload: { user_code: device.json().user_code }
    });
    expect(missingSession.statusCode).toBe(401);
    const wrongCode = await app.inject({
      method: "POST",
      url: "/v1/device-authorization-requests/lookup",
      headers: { cookie },
      payload: { user_code: "AAAA-AAAA" }
    });
    expect(wrongCode.statusCode).toBe(404);
    const lookup = await app.inject({
      method: "POST",
      url: "/v1/device-authorization-requests/lookup",
      headers: { cookie },
      payload: {
        user_code: String(device.json().user_code).toLowerCase().replace("-", "")
      }
    });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.headers["cache-control"]).toContain("no-store");
    const requestId = lookup.json().request_id as string;
    const crossUserLookup = await app.inject({
      method: "POST",
      url: "/v1/device-authorization-requests/lookup",
      headers: { cookie: otherCookie },
      payload: { user_code: device.json().user_code }
    });
    expect(crossUserLookup.statusCode).toBe(404);

    const pending = await app.inject({
      method: "GET",
      url: `/v1/authorization-requests/${requestId}`,
      headers: { cookie }
    });
    expect(pending.json().authorization).toMatchObject({
      id: requestId,
      flow: "device_code",
      distribution: "portable",
      project_url: "https://apps.example/portable-notes",
      user_code: device.json().user_code,
      requested_operations: READ_OPERATIONS
    });
    expect(pending.json().collections).toEqual([]);
    expect(pending.json().unavailable_connectors).toEqual([
      expect.objectContaining({
        connector_name: "Portable computer",
        reason: "offline"
      })
    ]);

    const control = await app.inject({
      method: "GET",
      url: "/v1/connectors/control",
      headers: { authorization: `Bearer ${connector.token}` }
    });
    expect(control.json().pending_authorizations).toContainEqual(
      expect.objectContaining({
        id: requestId,
        flow: "device_code",
        application_distribution: "portable",
        application_project_url: "https://apps.example/portable-notes",
        user_code: device.json().user_code
      })
    );
    const approved = await app.inject({
      method: "POST",
      url: `/v1/connectors/authorization-requests/${requestId}/approve`,
      headers: { authorization: `Bearer ${connector.token}` },
      payload: { collection_id: localCollectionId, operations: ["describe", "query"] }
    });
    expect(approved.statusCode).toBe(409);
    expect(approved.json().error.code).toBe("connector_offline");
    const status = await app.inject({
      method: "GET",
      url: `/v1/authorization-requests/${requestId}/status`,
      headers: { cookie }
    });
    expect(status.json()).toEqual({ status: "pending" });

    const wrongVerifier = await pollDeviceToken(app, {
      applicationId,
      deviceCode: device.json().device_code,
      verifier: "wrong-verifier-that-is-long-enough-for-pkce-000001"
    });
    expect(wrongVerifier.json()).toMatchObject({ error: "invalid_grant" });
    await db.query(
      "UPDATE authorization_requests SET last_polled_at = NULL WHERE id = $1",
      [requestId]
    );
    const token = await pollDeviceToken(app, {
      applicationId,
      deviceCode: device.json().device_code,
      verifier
    });
    expect(token.json()).toMatchObject({ error: "authorization_pending" });

    const deniedProof = await testApplicationAuthorization({
      semanticCapabilityContractVersion: 1,
      applicationId,
      applicationDeclarationId: manifest.id,
      applicationManifestDigest,
      flow: "device_code",
      codeChallenge: pkceChallenge(verifier),
      requestedOperations: READ_OPERATIONS
    });
    const deniedDevice = await app.inject({
      method: "POST",
      url: "/oauth/device_authorization",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        client_id: applicationId,
        operations: READ_OPERATIONS.join(","),
        code_challenge: pkceChallenge(verifier),
        code_challenge_method: "S256",
        application_authorization: JSON.stringify(deniedProof)
      }).toString()
    });
    const deniedLookup = await app.inject({
      method: "POST",
      url: "/v1/device-authorization-requests/lookup",
      headers: { cookie },
      payload: { user_code: deniedDevice.json().user_code }
    });
    await app.inject({
      method: "POST",
      url: `/v1/authorization-requests/${deniedLookup.json().request_id}/deny`,
      headers: { cookie }
    });
    expect((await pollDeviceToken(app, {
      applicationId,
      deviceCode: deniedDevice.json().device_code,
      verifier
    })).json()).toMatchObject({ error: "access_denied" });

    const expiringProof = await testApplicationAuthorization({
      semanticCapabilityContractVersion: 1,
      applicationId,
      applicationDeclarationId: manifest.id,
      applicationManifestDigest,
      flow: "device_code",
      codeChallenge: pkceChallenge(verifier),
      requestedOperations: READ_OPERATIONS
    });
    const expiredDevice = await app.inject({
      method: "POST",
      url: "/oauth/device_authorization",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        client_id: applicationId,
        operations: READ_OPERATIONS.join(","),
        code_challenge: pkceChallenge(verifier),
        code_challenge_method: "S256",
        application_authorization: JSON.stringify(expiringProof)
      }).toString()
    });
    await db.query(
      "UPDATE authorization_requests SET expires_at = now() - interval '1 second' WHERE device_code_hash IS NOT NULL AND device_consumed_at IS NULL"
    );
    expect((await pollDeviceToken(app, {
      applicationId,
      deviceCode: expiredDevice.json().device_code,
      verifier
    })).json()).toMatchObject({ error: "expired_token" });
  });

  it("uses a trusted Tailscale identity instead of a development session", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const { app } = await buildApp({
      db,
      devAuth: false,
      tailscaleAuth: true,
      publicUrl: "https://connect.tailnet.test"
    });
    resources.push(() => app.close());

    const config = await app.inject({ method: "GET", url: "/v1/auth/config" });
    expect(config.json()).toEqual({
      provider: "tailscale",
      providers: [],
      registration: "closed",
      development_login: false
    });

    const unauthenticated = await app.inject({ method: "GET", url: "/v1/me" });
    expect(unauthenticated.statusCode).toBe(401);

    const authenticated = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: {
        "tailscale-user-login": "CallumAlpass@Gmail.com",
        "tailscale-user-name": "Callum Alpass"
      }
    });
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.json()).toEqual(expect.objectContaining({
      user: expect.objectContaining({ email: "callumalpass@gmail.com", name: "Callum Alpass" }),
      authentication: { provider: "tailscale", registration: "closed" },
      pending_authorizations: []
    }));

    const developmentLogin = await app.inject({
      method: "POST",
      url: "/v1/dev/session",
      payload: { name: "Someone else", email: "else@example.com" }
    });
    expect(developmentLogin.statusCode).toBe(404);
  });
});

function pollDeviceToken(
  app: Awaited<ReturnType<typeof buildApp>>["app"],
  input: { applicationId: string; deviceCode: string; verifier: string }
) {
  return app.inject({
    method: "POST",
    url: "/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: input.deviceCode,
      client_id: input.applicationId,
      code_verifier: input.verifier
    }).toString()
  });
}

async function postWebAuthorization(
  app: Awaited<ReturnType<typeof buildApp>>["app"],
  input: {
  applicationId: string;
  applicationDeclarationId?: string;
  applicationManifestDigest: string;
  redirectUri: string;
  verifier: string;
  state: string;
  operations: CollectionOperation[];
  collectionId?: string;
  }
) {
  const challenge = pkceChallenge(input.verifier);
  const proof = await testApplicationAuthorization({
    applicationId: input.applicationId,
    applicationDeclarationId: input.applicationDeclarationId ?? "dev.mdbase.workouts",
    applicationManifestDigest: input.applicationManifestDigest,
    flow: "authorization_code",
    redirectUri: input.redirectUri,
    state: input.state,
    codeChallenge: challenge,
    requestedOperations: input.operations,
    // This helper is exclusively used by the prelude v1 lifecycle scenarios.
    semanticCapabilityContractVersion: 1,
    ...(input.collectionId ? { collectionId: input.collectionId } : {})
  });
  return app.inject({
    method: "POST",
    url: "/oauth/authorization_request",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({
    client_id: input.applicationId,
    redirect_uri: input.redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: input.state,
    operations: input.operations.join(","),
    application_authorization: JSON.stringify(proof),
    ...(input.collectionId ? { collection_id: input.collectionId } : {})
    }).toString()
  });
}

async function startWebAuthorization(
  app: Awaited<ReturnType<typeof buildApp>>["app"],
  cookie: string,
  input: Parameters<typeof postWebAuthorization>[1]
) {
  const started = await postWebAuthorization(app, input);
  expect(started.statusCode, JSON.stringify(started.json())).toBe(200);
  const authorizationUri = new URL(started.json().authorization_uri);
  return app.inject({
    method: "GET",
    url: `${authorizationUri.pathname}${authorizationUri.search}`,
    headers: { cookie }
  });
}

function applicationManifestFixture(
  requirements: ApplicationRequirements = {
    access: "full_collection",
    contracts: [{
      id: "workout.record",
      version: "1.0.0",
      digest: TEST_CONTRACT_DIGEST
    }]
  },
  name = "Workout Tracker",
  provisions?: NonNullable<MdbaseAppManifest["provisions"]>
): {
  manifest: MdbaseAppManifest | LegacyMdbaseAppManifest;
  redirectUri: string;
  nativeRedirectUri: string;
} {
  const origin = "http://localhost:4173";
  const nativeRedirectUri = "dev.mdbase.workouts://auth/mdbase/callback";
  return {
    manifest: {
      manifest_version: 1,
      id: "dev.mdbase.workouts",
      name,
      homepage: origin,
      redirect_uris: [`${origin}/auth/mdbase/callback`, nativeRedirectUri],
      requirements,
      ...(provisions ? { provisions } : {})
    },
    redirectUri: `${origin}/auth/mdbase/callback`,
    nativeRedirectUri
  };
}

function contractDescriptor(
  id = "workout.record",
  typeName = "workout"
) {
  return {
    contract_type: "record",
    id,
    version: "1.0.0",
    digest: TEST_CONTRACT_DIGEST,
    schema: { type: "object" },
    implementations: [{
      type_name: typeName,
      type_version: 1,
      type_path: `_types/${typeName}.md`,
      digest: `sha256:${"1".repeat(64)}`,
      fields: {}
    }]
  };
}

function typePackProvision(
  id: string,
  resources: Array<[
    kind: "contract" | "type" | "schema",
    source: string,
    target: string,
    document: string
  ]>,
  provides: Array<{ id: string; version: string; digest: string }>
) {
  return {
    manifest: {
      kind: "mdbase.type-pack" as const,
      id,
      version: "1.0.0",
      resources: resources.map(([kind, source, target, document]) => ({
        kind,
        mode: kind === "type" ? "seed" as const : "managed" as const,
        source,
        target,
        digest: `sha256:${createHash("sha256").update(document).digest("hex")}`
      }))
    },
    resources: resources.map(([, source, , document]) => ({ source, document })),
    provides
  };
}
