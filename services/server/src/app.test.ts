import {
  createECDH,
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign
} from "node:crypto";
import type {
  ApplicationRequirements,
  MdbaseAppManifest
} from "@mdbase/connect-protocol";
import {
  AUTHORITY_PROOF_HEADERS,
  AUTHORITY_PROOF_VERSION
} from "@mdbase/connect-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { createDatabase } from "./db.js";
import type { HostedProviderClient } from "./hosted-provider.js";
import { authorityProofMessage } from "./authority-proof.js";
import { pkceChallenge, tokenHash } from "./security.js";

const resources: Array<() => Promise<void>> = [];

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
});

describe("mdbase connect server", () => {
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
      revision: "ae3a8d9"
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
         (id, user_id, application_id, collection_id, operations)
       VALUES ($1, $2, $3, $4, '["read"]'::jsonb)`,
      [grantId, userId, applicationId, collectionId]
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
    expect(refresh.statusCode).toBe(400);
    expect(refresh.json().error.code).toBe("invalid_grant");

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
    expect(code.statusCode).toBe(400);
    expect(code.json().error.code).toBe("invalid_grant");

    const pairing = await app.inject({
      method: "POST",
      url: `/v1/pairing-requests/${pairingId}/exchange`,
      headers: { authorization: `Bearer ${pairingSecret}` }
    });
    expect(pairing.statusCode).toBe(404);
    expect(pairing.json().error.code).toBe("pairing_not_found");
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
        contracts: [{ id: "example.work-item", version: "1.0.0" }]
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
          [{ id: "example.work-item", version: "1.0.0" }]
        )]
      }
    };

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
  });

  it("runs the discovery, consent, token, and offline operation path", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const { app } = await buildApp({
      db,
      devAuth: true,
      publicUrl: "http://connect.test",
      allowInsecureManifests: true
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
    const discovered = await app.inject({
      method: "POST",
      url: "/v1/apps/register",
      payload: { manifest: manifestServer.manifest }
    });
    expect(discovered.statusCode).toBe(200);
    expect(discovered.json().application.requirements).toEqual({
      contracts: [{ id: "workout.record", version: "1.0.0" }]
    });
    const applicationId = discovered.json().application.id as string;
    const invalidEncryption = await app.inject({
      method: "GET",
      url: `/oauth/authorize?client_id=${applicationId}&redirect_uri=${encodeURIComponent(manifestServer.redirectUri)}&code_challenge=${"a".repeat(43)}&code_challenge_method=S256&relay_protocol=3&application_agreement_public_key=${"A".repeat(87)}`,
      headers: { cookie }
    });
    expect(invalidEncryption.statusCode).toBe(400);
    expect(invalidEncryption.json().error.code).toBe("invalid_encryption_request");
    const reusedApplicationKey = p256PublicKey();
    const reusedEncryptionKey = await app.inject({
      method: "GET",
      url: `/oauth/authorize?client_id=${applicationId}&redirect_uri=${encodeURIComponent(manifestServer.redirectUri)}&code_challenge=${"a".repeat(43)}&code_challenge_method=S256&relay_protocol=1&application_agreement_public_key=${reusedApplicationKey}&application_signing_public_key=${reusedApplicationKey}`,
      headers: { cookie }
    });
    expect(reusedEncryptionKey.statusCode).toBe(400);
    expect(reusedEncryptionKey.json().error.code).toBe("invalid_encryption_request");
    const legacyCompatibleGrantId = "325cc8cf-dad5-4fc9-b0bc-a1c92e99f3ed";
    const legacyIncompatibleGrantId = "425cc8cf-dad5-4fc9-b0bc-a1c92e99f3ed";
    const user = await db.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [
      "callum@example.com"
    ]);
    await db.query(
      `INSERT INTO grants (id, user_id, application_id, collection_id, operations, scope)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb),
              ($7, $2, $3, $8, $5::jsonb, $9::jsonb)`,
      [
        legacyCompatibleGrantId,
        user.rows[0].id,
        applicationId,
        authorityId(localCollectionId),
        JSON.stringify(["read"]),
        JSON.stringify({ contracts: [] }),
        legacyIncompatibleGrantId,
        authorityId(incompatibleLocalCollectionId),
        JSON.stringify({ contracts: [contractDescriptor()] })
      ]
    );
    const rediscovered = await app.inject({
      method: "POST",
      url: "/v1/apps/register",
      payload: { manifest: manifestServer.manifest }
    });
    expect(rediscovered.statusCode).toBe(200);
    const reconciled = await db.query<{ id: string; scope: unknown; revoked_at: string | null }>(
      "SELECT id, scope, revoked_at FROM grants WHERE id IN ($1, $2) ORDER BY id",
      [legacyCompatibleGrantId, legacyIncompatibleGrantId]
    );
    expect(reconciled.rows.find((grant) => grant.id === legacyCompatibleGrantId)).toEqual(
      expect.objectContaining({
        scope: {
          access: "contract",
          contracts: [contractDescriptor()]
        },
        revoked_at: null
      })
    );
    expect(reconciled.rows.find((grant) => grant.id === legacyIncompatibleGrantId)?.revoked_at)
      .not.toBeNull();
    const incompatibleGrant = await app.inject({
      method: "POST",
      url: "/v1/connectors/grants",
      headers: { authorization: `Bearer ${connector.token}` },
      payload: {
        application_id: applicationId,
        collection_id: incompatibleLocalCollectionId,
        operations: ["read"]
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
        operations: ["read"]
      }
    });
    expect(legacyGrant.statusCode).toBe(201);

    const overbroadAuthorization = await app.inject({
      method: "GET",
      url: `/oauth/authorize?client_id=${applicationId}&redirect_uri=${encodeURIComponent(manifestServer.redirectUri)}&code_challenge=${pkceChallenge("view-scope-verifier-that-is-long-enough-000001")}&code_challenge_method=S256&operations=list_views,execute_view`,
      headers: { cookie }
    });
    expect(overbroadAuthorization.statusCode).toBe(400);
    expect(overbroadAuthorization.json().error.message).toContain("full collection access");

    const verifier = "local-connector-verifier-that-is-long-enough-00001";
    const state = "test-state";
    const authorize = await app.inject({
      method: "GET",
      url: `/oauth/authorize?client_id=${applicationId}&redirect_uri=${encodeURIComponent(manifestServer.redirectUri)}&code_challenge=${pkceChallenge(verifier)}&code_challenge_method=S256&state=${state}&operations=read,query&collection_id=${collectionId}`,
      headers: { cookie }
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
        operations: ["read", "query"]
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
      contracts: [{ id: "workout.record", version: "1.0.0" }]
    });

    const connectorLegacyApproval = await app.inject({
      method: "POST",
      url: `/v1/connectors/authorization-requests/${requestId}/approve`,
      headers: { authorization: `Bearer ${connector.token}` },
      payload: { collection_id: legacyLocalCollectionId, operations: ["read", "query"] }
    });
    expect(connectorLegacyApproval.statusCode).toBe(400);
    expect(connectorLegacyApproval.json().error.message).toContain(
      "restricted to a different collection"
    );

    const approved = await app.inject({
      method: "POST",
      url: `/v1/connectors/authorization-requests/${requestId}/approve`,
      headers: { authorization: `Bearer ${connector.token}` },
      payload: { collection_id: localCollectionId, operations: ["read", "query"] }
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toEqual({ ok: true });

    const completed = await app.inject({
      method: "GET",
      url: `/v1/authorization-requests/${requestId}/status`,
      headers: { cookie }
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().status).toBe("approved");
    const redirect = new URL(completed.json().redirect_uri);
    expect(redirect.searchParams.get("state")).toBe(state);

    const token = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        code: redirect.searchParams.get("code")!,
        client_id: applicationId,
        redirect_uri: manifestServer.redirectUri,
        code_verifier: verifier
      }).toString()
    });
    expect(token.statusCode).toBe(200);
    expect(token.json().collection_id).toBe(collectionId);
    expect(token.json().operations).toEqual(["read", "query"]);
    expect(token.json().scope).toEqual({
      access: "contract",
      contracts: [contractDescriptor()]
    });
    expect(token.json().application_origin).toBe(new URL(manifestServer.redirectUri).origin);
    expect(token.json().refresh_token).toMatch(/^ref_/);

    const nativeVerifier = "native-verifier-that-is-long-enough-for-pkce-00001";
    const nativeAuthorization = await app.inject({
      method: "GET",
      url: `/oauth/authorize?client_id=${applicationId}&redirect_uri=${encodeURIComponent(manifestServer.nativeRedirectUri)}&code_challenge=${pkceChallenge(nativeVerifier)}&code_challenge_method=S256&state=native-state&operations=read`,
      headers: { cookie }
    });
    expect(nativeAuthorization.statusCode).toBe(302);
    const nativeRequestId = nativeAuthorization.headers.location!.split("/").at(-1)!;
    const nativeApproved = await app.inject({
      method: "POST",
      url: `/v1/connectors/authorization-requests/${nativeRequestId}/approve`,
      headers: { authorization: `Bearer ${connector.token}` },
      payload: { collection_id: localCollectionId, operations: ["read"] }
    });
    expect(nativeApproved.statusCode).toBe(200);
    const nativeStatus = await app.inject({
      method: "GET",
      url: `/v1/authorization-requests/${nativeRequestId}/status`,
      headers: { cookie }
    });
    const nativeRedirect = new URL(nativeStatus.json().redirect_uri);
    expect(nativeRedirect.protocol).toBe("dev.mdbase.workouts:");
    expect(nativeRedirect.searchParams.get("state")).toBe("native-state");
    const nativeToken = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        code: nativeRedirect.searchParams.get("code")!,
        client_id: applicationId,
        redirect_uri: manifestServer.nativeRedirectUri,
        code_verifier: nativeVerifier
      }).toString()
    });
    expect(nativeToken.statusCode).toBe(200);
    expect(nativeToken.json().application_origin).toBe(new URL(manifestServer.redirectUri).origin);

    const refreshed = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.json().refresh_token,
        client_id: applicationId
      }).toString()
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().access_token).not.toBe(token.json().access_token);
    expect(refreshed.json().refresh_token).not.toBe(token.json().refresh_token);
    const reusedRefresh = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.json().refresh_token,
        client_id: applicationId
      }).toString()
    });
    expect(reusedRefresh.statusCode).toBe(400);
    expect(reusedRefresh.json().error.code).toBe("invalid_grant");

    const operation = await app.inject({
      method: "POST",
      url: `/v1/authorities/${collectionId}/operations/query`,
      headers: { authorization: `Bearer ${refreshed.json().access_token}` },
      payload: {
        protocol_version: 1,
        request_id: "01911111-1111-7111-8111-111111111111",
        input: { types: ["workout"] }
      }
    });
    expect(operation.statusCode).toBe(503);
    expect(operation.json().error.code).toBe("connector_offline");

    const deniedState = "denied-state";
    const deniedAuthorization = await app.inject({
      method: "GET",
      url: `/oauth/authorize?client_id=${applicationId}&redirect_uri=${encodeURIComponent(manifestServer.redirectUri)}&code_challenge=${pkceChallenge(verifier)}&code_challenge_method=S256&state=${deniedState}&operations=read`,
      headers: { cookie }
    });
    const deniedRequestId = deniedAuthorization.headers.location!.split("/").at(-1)!;
    const denied = await app.inject({
      method: "POST",
      url: `/v1/connectors/authorization-requests/${deniedRequestId}/deny`,
      headers: { authorization: `Bearer ${connector.token}` }
    });
    expect(denied.statusCode).toBe(200);
    expect(denied.json()).toEqual({ ok: true });
    const deniedStatus = await app.inject({
      method: "GET",
      url: `/v1/authorization-requests/${deniedRequestId}/status`,
      headers: { cookie }
    });
    const deniedRedirect = new URL(deniedStatus.json().redirect_uri);
    expect(deniedStatus.json().status).toBe("denied");
    expect(deniedRedirect.searchParams.get("error")).toBe("access_denied");
    expect(deniedRedirect.searchParams.get("state")).toBe(deniedState);

    const portalAuthorization = await app.inject({
      method: "GET",
      url: `/oauth/authorize?client_id=${applicationId}&redirect_uri=${encodeURIComponent(manifestServer.redirectUri)}&code_challenge=${pkceChallenge(verifier)}&code_challenge_method=S256&state=portal-approval&operations=read,query`,
      headers: { cookie }
    });
    const portalRequestId = portalAuthorization.headers.location!.split("/").at(-1)!;
    const waitingDashboard = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
    expect(waitingDashboard.json().pending_authorizations).toEqual([
      expect.objectContaining({
        id: portalRequestId,
        application_name: "Workout Tracker",
        available_collections: []
      })
    ]);
    const portalApproved = await app.inject({
      method: "POST",
      url: `/v1/authorization-requests/${portalRequestId}/approve`,
      headers: { cookie },
      payload: { collection_id: collectionId, operations: ["read"] }
    });
    expect(portalApproved.statusCode).toBe(404);
    const locallyApproved = await app.inject({
      method: "POST",
      url: `/v1/connectors/authorization-requests/${portalRequestId}/approve`,
      headers: { authorization: `Bearer ${connector.token}` },
      payload: { collection_id: localCollectionId, operations: ["read"] }
    });
    expect(locallyApproved.statusCode).toBe(200);
    expect(locallyApproved.json()).toEqual({ ok: true });
    const policyAfterPortalApproval = await app.inject({
      method: "GET",
      url: "/v1/connectors/control",
      headers: { authorization: `Bearer ${connector.token}` }
    });
    expect(policyAfterPortalApproval.json().grants).toContainEqual(
      expect.objectContaining({
        collection_id: localCollectionId,
        operations: ["read"],
        application_origin: new URL(manifestServer.redirectUri).origin
      })
    );
    expect(policyAfterPortalApproval.json().pending_authorizations).toHaveLength(0);

    const dashboard = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().collections).toContainEqual(
      expect.objectContaining({ display_name: "Workouts" })
    );
    expect(dashboard.json().grants[0].application_name).toBe("Workout Tracker");

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
        operations: ["read", "query"]
      }
    });
    expect(broadenedForTest.statusCode).toBe(201);
    const managedGrantId = broadenedForTest.json().grant.id as string;
    const narrowed = await app.inject({
      method: "PATCH",
      url: `/v1/grants/${managedGrantId}`,
      headers: { cookie },
      payload: { operations: ["read"] }
    });
    expect(narrowed.statusCode).toBe(200);
    expect(narrowed.json().grant.operations).toEqual(["read"]);
    const permissionExpansion = await app.inject({
      method: "PATCH",
      url: `/v1/grants/${managedGrantId}`,
      headers: { cookie },
      payload: { operations: ["read", "query"] }
    });
    expect(permissionExpansion.statusCode).toBe(409);
    expect(permissionExpansion.json().error.code).toBe("permission_expansion_requires_approval");
    const narrowedPolicy = await app.inject({
      method: "GET",
      url: "/v1/connectors/control",
      headers: { authorization: `Bearer ${connector.token}` }
    });
    expect(narrowedPolicy.json().grants).toContainEqual(
      expect.objectContaining({ id: managedGrantId, operations: ["read"] })
    );
  });

  it("authorizes portable v1 applications with a single-use key-bound device flow", async () => {
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
    const manifest: MdbaseAppManifest = {
      manifest_version: 1,
      distribution: "portable",
      id: "dev.mdbase.portable-notes",
      name: "Portable notes",
      project_url: "https://apps.example/portable-notes",
      requirements: {
        contracts: [],
        access: "full_collection"
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

    const applicationAgreementPublicKey = p256PublicKey();
    const applicationSigningPublicKey = p256PublicKey();
    const verifier = "portable-verifier-that-is-long-enough-for-pkce-0001";
    const device = await app.inject({
      method: "POST",
      url: "/oauth/device_authorization",
      headers: {
        origin: "null",
        "content-type": "application/x-www-form-urlencoded"
      },
      payload: new URLSearchParams({
        client_id: applicationId,
        operations: "describe, query,query",
        collection_id: collectionId,
        code_challenge: pkceChallenge(verifier),
        code_challenge_method: "S256",
        relay_protocol: "1",
        application_agreement_public_key: applicationAgreementPublicKey,
        application_signing_public_key: applicationSigningPublicKey
      }).toString()
    });
    expect(device.statusCode, JSON.stringify(device.json())).toBe(200);
    expect(device.headers["access-control-allow-origin"]).toBe("null");
    expect(device.headers["cache-control"]).toContain("no-store");
    expect(device.json()).toMatchObject({
      verification_uri: "http://connect.test/device",
      expires_in: 600,
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
    expect(webAuthorizeBypass.json().error.code).toBe("invalid_client");

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
      requested_operations: ["describe", "query"]
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
    expect(approved.statusCode).toBe(200);
    const status = await app.inject({
      method: "GET",
      url: `/v1/authorization-requests/${requestId}/status`,
      headers: { cookie }
    });
    expect(status.json()).toEqual({ status: "approved" });

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
    expect(token.statusCode).toBe(200);
    expect(token.json()).toMatchObject({
      collection_id: collectionId,
      application_origin: "null",
      operations: ["describe", "query"],
      encryption: {
        protocol_version: 1,
        connector_id: connector.connector.id,
        collection_id: localCollectionId,
        application_agreement_public_key: applicationAgreementPublicKey
      }
    });
    const policy = await app.inject({
      method: "GET",
      url: "/v1/connectors/control",
      headers: { authorization: `Bearer ${connector.token}` }
    });
    expect(policy.json().grants).toContainEqual(expect.objectContaining({
      application_distribution: "portable",
      application_project_url: "https://apps.example/portable-notes",
      application_origin: "null"
    }));
    expect((await pollDeviceToken(app, {
      applicationId,
      deviceCode: device.json().device_code,
      verifier
    })).json()).toMatchObject({ error: "invalid_grant" });

    const mutated = await app.inject({
      method: "POST",
      url: "/v1/apps/register",
      payload: { manifest: { ...manifest, name: "Portable notes changed" } }
    });
    expect(mutated.json().application.id).not.toBe(applicationId);
    expect((await pollDeviceToken(app, {
      applicationId: mutated.json().application.id,
      deviceCode: device.json().device_code,
      verifier
    })).json()).toMatchObject({ error: "invalid_grant" });

    const deniedKey = createECDH("prime256v1");
    deniedKey.generateKeys();
    const deniedDevice = await app.inject({
      method: "POST",
      url: "/oauth/device_authorization",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        client_id: applicationId,
        operations: "query",
        code_challenge: pkceChallenge(verifier),
        code_challenge_method: "S256",
        relay_protocol: "1",
        application_agreement_public_key: deniedKey
          .getPublicKey(undefined, "uncompressed")
          .toString("base64url"),
        application_signing_public_key: p256PublicKey()
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

    const expiringKey = createECDH("prime256v1");
    expiringKey.generateKeys();
    const expiredDevice = await app.inject({
      method: "POST",
      url: "/oauth/device_authorization",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        client_id: applicationId,
        operations: "query",
        code_challenge: pkceChallenge(verifier),
        code_challenge_method: "S256",
        relay_protocol: "1",
        application_agreement_public_key: expiringKey
          .getPublicKey(undefined, "uncompressed")
          .toString("base64url"),
        application_signing_public_key: p256PublicKey()
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

  it("authorizes a portable v1 application directly against a hosted collection", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const hostedProvider = {
      url: "https://sync.example",
      ready: vi.fn(),
      createCollection: vi.fn(),
      renameCollection: vi.fn(),
      deleteCollection: vi.fn(),
      provisionTypePacks: vi.fn(),
      registerReplica: vi.fn(),
      updateApplicationReplica: vi.fn(),
      revokeReplica: vi.fn(),
      upsertNotificationGrant: vi.fn(),
      revokeNotificationGrant: vi.fn(),
      rotateReplicaToken: vi.fn(),
      compactThrough: vi.fn()
    } as unknown as HostedProviderClient;
    const { app } = await buildApp({
      db,
      devAuth: true,
      hostedCollections: true,
      hostedProvider,
      publicUrl: "http://connect.test"
    });
    resources.push(() => app.close());

    const session = await app.inject({
      method: "POST",
      url: "/v1/dev/session",
      payload: { name: "Portable cloud owner", email: "portable-cloud@example.com" }
    });
    const setCookie = session.headers["set-cookie"]!;
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
    const created = await app.inject({
      method: "POST",
      url: "/v1/hosted/collections",
      headers: { cookie },
      payload: { display_name: "Portable cloud notes", template: "mdbase" }
    });
    expect(created.statusCode).toBe(201);
    const collectionId = created.json().collection.id as string;
    const manifest: MdbaseAppManifest = {
      manifest_version: 1,
      distribution: "portable",
      id: "dev.mdbase.portable-cloud-notes",
      name: "Portable cloud notes",
      project_url: "https://apps.example/portable-cloud-notes",
      requirements: {
        contracts: [],
        access: "full_collection",
        collection_kind: "hosted"
      }
    };
    const registration = await app.inject({
      method: "POST",
      url: "/v1/apps/register",
      payload: { manifest }
    });
    expect(registration.statusCode, JSON.stringify(registration.json())).toBe(200);
    const applicationId = registration.json().application.id as string;
    const applicationAgreementPublicKey = p256PublicKey();
    const applicationSigningKeys = generateKeyPairSync("ec", {
      namedCurve: "prime256v1"
    });
    const applicationSigningJwk = applicationSigningKeys.publicKey.export({
      format: "jwk"
    });
    const applicationSigningPublicKey = Buffer.concat([
      Buffer.from([4]),
      Buffer.from(applicationSigningJwk.x!, "base64url"),
      Buffer.from(applicationSigningJwk.y!, "base64url")
    ]).toString("base64url");
    const verifier = "portable-hosted-verifier-that-is-long-enough-0001";
    const device = await app.inject({
      method: "POST",
      url: "/oauth/device_authorization",
      headers: {
        origin: "null",
        "content-type": "application/x-www-form-urlencoded"
      },
      payload: new URLSearchParams({
        client_id: applicationId,
        operations: "describe,query,create,update,sync",
        collection_id: collectionId,
        code_challenge: pkceChallenge(verifier),
        code_challenge_method: "S256",
        relay_protocol: "1",
        application_agreement_public_key: applicationAgreementPublicKey,
        application_signing_public_key: applicationSigningPublicKey
      }).toString()
    });
    expect(device.statusCode, JSON.stringify(device.json())).toBe(200);
    const lookup = await app.inject({
      method: "POST",
      url: "/v1/device-authorization-requests/lookup",
      headers: { cookie },
      payload: { user_code: device.json().user_code }
    });
    expect(lookup.statusCode).toBe(200);
    const requestId = lookup.json().request_id as string;
    const pending = await app.inject({
      method: "GET",
      url: `/v1/authorization-requests/${requestId}`,
      headers: { cookie }
    });
    expect(pending.json().collections).toEqual([
      expect.objectContaining({ id: collectionId, kind: "hosted" })
    ]);

    const approved = await app.inject({
      method: "POST",
      url: `/v1/authorization-requests/${requestId}/approve`,
      headers: { cookie },
      payload: {
        collection_id: collectionId,
        operations: ["describe", "query", "create", "update", "sync"]
      }
    });
    expect(approved.statusCode, JSON.stringify(approved.json())).toBe(200);
    expect(hostedProvider.registerReplica).toHaveBeenCalledWith(
      collectionId,
      expect.objectContaining({
        purpose: "application",
        fullCollection: true,
        allowedOperations: ["describe", "query", "create", "update"],
        allowedOrigin: "null",
        proofPublicKey: applicationSigningPublicKey
      })
    );
    const token = await pollDeviceToken(app, {
      applicationId,
      deviceCode: device.json().device_code,
      verifier
    });
    expect(token.statusCode, JSON.stringify(token.json())).toBe(200);
    expect(token.json()).toMatchObject({
      collection_id: collectionId,
      application_origin: "null",
      operations: ["describe", "query", "create", "update", "sync"],
      encryption: null,
      authority: {
        operations_url: `https://sync.example/v1/authorities/${collectionId}/operations`,
        sync_url: `https://sync.example/v1/authorities/${collectionId}/sync`,
        proof_public_key: applicationSigningPublicKey
      }
    });
    expect(token.json().authority.replica_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(token.json().authority.access_token).toMatch(/^hsa_/);
    expect(hostedProvider.rotateReplicaToken).toHaveBeenCalledWith(
      token.json().authority.replica_id,
      token.json().authority.access_token,
      3_600
    );

    const refreshBody = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token.json().refresh_token,
      client_id: applicationId
    }).toString();
    const unsignedRefresh = await app.inject({
      method: "POST",
      url: "/oauth/token",
      payload: refreshBody,
      headers: {
        origin: "null",
        "content-type": "application/x-www-form-urlencoded"
      }
    });
    expect(unsignedRefresh.statusCode).toBe(400);
    expect(unsignedRefresh.json()).toMatchObject({ error: "invalid_grant" });
    const proofTimestamp = Math.floor(Date.now() / 1_000);
    const proofNonce = randomUUID();
    const proofSignature = sign(
      "sha256",
      Buffer.from(authorityProofMessage({
        method: "POST",
        target: "/oauth/token",
        body: refreshBody,
        credential: token.json().refresh_token,
        timestamp: proofTimestamp,
        nonce: proofNonce
      })),
      { key: applicationSigningKeys.privateKey, dsaEncoding: "ieee-p1363" }
    ).toString("base64url");
    const refreshed = await app.inject({
      method: "POST",
      url: "/oauth/token",
      payload: refreshBody,
      headers: {
        origin: "null",
        "content-type": "application/x-www-form-urlencoded",
        [AUTHORITY_PROOF_HEADERS.version]: String(AUTHORITY_PROOF_VERSION),
        [AUTHORITY_PROOF_HEADERS.timestamp]: String(proofTimestamp),
        [AUTHORITY_PROOF_HEADERS.nonce]: proofNonce,
        [AUTHORITY_PROOF_HEADERS.signature]: proofSignature
      }
    });
    expect(refreshed.statusCode, JSON.stringify(refreshed.json())).toBe(200);
    expect(refreshed.json()).toMatchObject({
      collection_id: collectionId,
      application_origin: "null",
      encryption: null,
      authority: {
        operations_url: `https://sync.example/v1/authorities/${collectionId}/operations`,
        sync_url: `https://sync.example/v1/authorities/${collectionId}/sync`,
        replica_id: token.json().authority.replica_id,
        proof_public_key: applicationSigningPublicKey
      }
    });
    expect(refreshed.json().authority.access_token).not.toBe(token.json().authority.access_token);
    const grant = await db.query<{
      application_origin: string;
      encryption: unknown;
      proof_public_key: string | null;
    }>(
      "SELECT application_origin, encryption, proof_public_key FROM grants WHERE id = $1",
      [token.json().grant_id]
    );
    expect(grant.rows[0]).toEqual({
      application_origin: "null",
      encryption: null,
      proof_public_key: applicationSigningPublicKey
    });
  });

  it("lets a paired desktop manage only its owner's hosted collections and mirrors", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const hostedProvider = {
      url: "https://sync.example",
      ready: vi.fn(),
      createCollection: vi.fn(),
      renameCollection: vi.fn(),
      deleteCollection: vi.fn(),
      provisionTypePacks: vi.fn(),
      registerReplica: vi.fn(),
      updateApplicationReplica: vi.fn(),
      revokeReplica: vi.fn(),
      replicaStatuses: vi.fn().mockResolvedValue([]),
      upsertNotificationGrant: vi.fn(),
      revokeNotificationGrant: vi.fn(),
      rotateReplicaToken: vi.fn(),
      compactThrough: vi.fn()
    } as unknown as HostedProviderClient;
    const { app } = await buildApp({
      db,
      devAuth: true,
      hostedCollections: true,
      hostedProvider,
      publicUrl: "http://connect.test"
    });
    resources.push(() => app.close());

    const ownerSession = await app.inject({
      method: "POST",
      url: "/v1/dev/session",
      payload: { name: "Desktop owner", email: "desktop-owner@example.com" }
    });
    const ownerCookieHeader = ownerSession.headers["set-cookie"]!;
    const ownerCookie = (Array.isArray(ownerCookieHeader) ? ownerCookieHeader[0] : ownerCookieHeader)
      .split(";")[0];
    const ownerConnector = await app.inject({
      method: "POST",
      url: "/v1/connectors",
      headers: { cookie: ownerCookie },
      payload: { name: "Owner desktop" }
    });
    const ownerToken = ownerConnector.json().token as string;

    const created = await app.inject({
      method: "POST",
      url: "/v1/connectors/hosted/collections",
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { display_name: "Desktop notes", template: "mdbase" }
    });
    expect(created.statusCode, JSON.stringify(created.json())).toBe(201);
    const collectionId = created.json().collection.id as string;
    expect(hostedProvider.createCollection).toHaveBeenCalledWith(
      collectionId,
      "mdbase",
      "Desktop notes"
    );

    const snapshot = await app.inject({
      method: "GET",
      url: "/v1/connectors/hosted-control",
      headers: { authorization: `Bearer ${ownerToken}` }
    });
    expect(snapshot.statusCode, JSON.stringify(snapshot.json())).toBe(200);
    expect(snapshot.json().hosted_collections_available).toBe(true);
    expect(snapshot.json().hosted_collections).toEqual([
      expect.objectContaining({
        id: collectionId,
        display_name: "Desktop notes",
        authority_state: "active",
        replicas: []
      })
    ]);

    const renamed = await app.inject({
      method: "PATCH",
      url: `/v1/connectors/hosted/collections/${collectionId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { display_name: "Desktop journal" }
    });
    expect(renamed.statusCode).toBe(200);
    expect(hostedProvider.renameCollection).toHaveBeenCalledWith(
      collectionId,
      "Desktop journal"
    );

    const otherSession = await app.inject({
      method: "POST",
      url: "/v1/dev/session",
      payload: { name: "Other owner", email: "desktop-other@example.com" }
    });
    const otherCookieHeader = otherSession.headers["set-cookie"]!;
    const otherCookie = (Array.isArray(otherCookieHeader) ? otherCookieHeader[0] : otherCookieHeader)
      .split(";")[0];
    const otherConnector = await app.inject({
      method: "POST",
      url: "/v1/connectors",
      headers: { cookie: otherCookie },
      payload: { name: "Other desktop" }
    });
    const forbiddenRename = await app.inject({
      method: "PATCH",
      url: `/v1/connectors/hosted/collections/${collectionId}`,
      headers: { authorization: `Bearer ${otherConnector.json().token}` },
      payload: { display_name: "Stolen" }
    });
    expect(forbiddenRename.statusCode).toBe(404);

    const pairing = await app.inject({
      method: "POST",
      url: "/v1/mirror-pairing-requests",
      payload: {
        mirror_name: "Owner desktop mirror",
        mode: "read_write",
        collection_id: collectionId
      }
    });
    const approved = await app.inject({
      method: "POST",
      url: `/v1/connectors/mirror-pairing-requests/${pairing.json().pairing_id}/approve`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { collection_id: collectionId }
    });
    expect(approved.statusCode).toBe(200);
    const exchanged = await app.inject({
      method: "POST",
      url: `/v1/mirror-pairing-requests/${pairing.json().pairing_id}/exchange`,
      headers: { authorization: `Bearer ${pairing.json().pairing_secret}` }
    });
    expect(exchanged.statusCode, JSON.stringify(exchanged.json())).toBe(200);
    expect(exchanged.json()).toMatchObject({
      status: "paired",
      sync_url: `https://sync.example/v1/authorities/${collectionId}/sync`,
      replica: {
        collection_id: collectionId,
        name: "Owner desktop mirror",
        mode: "read_write"
      }
    });
    expect(hostedProvider.registerReplica).toHaveBeenCalledWith(
      collectionId,
      expect.objectContaining({
        id: exchanged.json().replica.id,
        name: "Owner desktop mirror",
        mode: "read_write"
      })
    );

    const revoked = await app.inject({
      method: "DELETE",
      url: `/v1/connectors/hosted/replicas/${exchanged.json().replica.id}`,
      headers: { authorization: `Bearer ${ownerToken}` }
    });
    expect(revoked.statusCode).toBe(200);
    expect(hostedProvider.revokeReplica).toHaveBeenCalledWith(exchanged.json().replica.id);

    const removed = await app.inject({
      method: "DELETE",
      url: `/v1/connectors/hosted/collections/${collectionId}`,
      headers: { authorization: `Bearer ${ownerToken}` }
    });
    expect(removed.statusCode).toBe(200);
    expect(hostedProvider.deleteCollection).toHaveBeenCalledWith(collectionId);
  });

  it("provisions and reconciles contract-free hosted application access as unrestricted", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const hostedProvider = {
      url: "https://sync.example",
      ready: vi.fn(),
      createCollection: vi.fn(),
      renameCollection: vi.fn(),
      deleteCollection: vi.fn(),
      registerReplica: vi.fn(),
      updateApplicationReplica: vi.fn(),
      revokeReplica: vi.fn(),
      upsertNotificationGrant: vi.fn(),
      revokeNotificationGrant: vi.fn(),
      rotateReplicaToken: vi.fn(),
      compactThrough: vi.fn()
    } as unknown as HostedProviderClient;
    const { app } = await buildApp({
      db,
      devAuth: true,
      hostedCollections: true,
      hostedProvider,
      publicUrl: "http://connect.test",
      allowInsecureManifests: true
    });
    resources.push(() => app.close());

    const session = await app.inject({
      method: "POST",
      url: "/v1/dev/session",
      payload: { name: "Writer", email: "writer@example.com" }
    });
    const setCookie = session.headers["set-cookie"]!;
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
    const connectorResponse = await app.inject({
      method: "POST",
      url: "/v1/connectors",
      headers: { cookie },
      payload: { name: "Writing computer" }
    });
    const connector = connectorResponse.json();
    const localCollectionId = "32f95339-c600-427f-a187-85758dc2662e";
    const synchronized = await app.inject({
      method: "POST",
      url: "/v1/connectors/sync",
      headers: { authorization: `Bearer ${connector.token}` },
      payload: {
        inventory_revision: 1,
        collections: [{
          id: localCollectionId,
          display_name: "Local writing",
          spec_version: "0.3.0",
          enabled: true,
          contracts: []
        }]
      }
    });
    expect(synchronized.statusCode).toBe(200);
    const localControlCollectionId = synchronized.json().collections[0].id as string;
    const collection = await app.inject({
      method: "POST",
      url: "/v1/hosted/collections",
      headers: { cookie },
      payload: { display_name: "Writing", template: "mdbase" }
    });
    const collectionId = collection.json().collection.id as string;

    const manifestServer = applicationManifestFixture(
      { contracts: [], access: "full_collection", collection_kind: "hosted" },
      "Writing Editor"
    );
    const discovered = await app.inject({
      method: "POST",
      url: "/v1/apps/register",
      payload: { manifest: manifestServer.manifest }
    });
    const applicationId = discovered.json().application.id as string;
    const verifier = "hosted-unrestricted-verifier-that-is-long-enough-0001";
    const applicationAgreementPublicKey = p256PublicKey();
    const applicationSigningPublicKey = p256PublicKey();
    const authorization = await app.inject({
      method: "GET",
      url: `/oauth/authorize?client_id=${applicationId}&redirect_uri=${encodeURIComponent(manifestServer.redirectUri)}&code_challenge=${pkceChallenge(verifier)}&code_challenge_method=S256&operations=describe,query,create,update,sync&relay_protocol=1&application_agreement_public_key=${applicationAgreementPublicKey}&application_signing_public_key=${applicationSigningPublicKey}`,
      headers: { cookie }
    });
    const requestId = authorization.headers.location!.split("/").at(-1)!;
    const pending = await app.inject({
      method: "GET",
      url: `/v1/authorization-requests/${requestId}`,
      headers: { cookie }
    });
    expect(pending.json().authorization.requirements).toEqual({
      contracts: [],
      access: "full_collection",
      collection_kind: "hosted"
    });
    expect(pending.json().hosted_collections_available).toBe(true);
    expect(pending.json().collections).toEqual([
      expect.objectContaining({ id: collectionId, kind: "hosted" })
    ]);
    const connectorControl = await app.inject({
      method: "GET",
      url: "/v1/connectors/control",
      headers: { authorization: `Bearer ${connector.token}` }
    });
    expect(connectorControl.json().pending_authorizations).toEqual([]);
    const hostedControl = await app.inject({
      method: "GET",
      url: "/v1/connectors/hosted-control",
      headers: { authorization: `Bearer ${connector.token}` }
    });
    expect(hostedControl.json().pending_authorizations).toEqual([
      expect.objectContaining({ id: requestId, application_name: "Writing Editor" })
    ]);
    const localApproval = await app.inject({
      method: "POST",
      url: `/v1/authorization-requests/${requestId}/approve`,
      headers: { cookie },
      payload: {
        collection_id: localControlCollectionId,
        operations: ["describe", "query", "create", "update", "sync"]
      }
    });
    expect(localApproval.statusCode).toBe(404);
    const approved = await app.inject({
      method: "POST",
      url: `/v1/connectors/hosted/authorization-requests/${requestId}/approve`,
      headers: { authorization: `Bearer ${connector.token}` },
      payload: {
        collection_id: collectionId,
        operations: ["describe", "query", "create", "update", "sync"]
      }
    });
    expect(approved.statusCode).toBe(200);
    expect(hostedProvider.registerReplica).toHaveBeenCalledWith(
      collectionId,
      expect.objectContaining({
        purpose: "application",
        allowedTypes: [],
        fullCollection: true,
        allowedOperations: ["describe", "query", "create", "update"]
      })
    );

    const provisioned = await db.query<{ id: string; allowed_types: string[] }>(
      "SELECT id, allowed_types FROM hosted_replicas WHERE purpose = 'application'"
    );
    expect(provisioned.rows[0].allowed_types).toEqual([]);

    await db.query("UPDATE hosted_replicas SET allowed_types = $2::jsonb WHERE id = $1", [
      provisioned.rows[0].id,
      JSON.stringify(["task"])
    ]);
    vi.mocked(hostedProvider.updateApplicationReplica).mockClear();
    const rediscovered = await app.inject({
      method: "POST",
      url: "/v1/apps/register",
      payload: { manifest: manifestServer.manifest }
    });
    expect(rediscovered.statusCode).toBe(200);
    expect(hostedProvider.updateApplicationReplica).toHaveBeenCalledWith(
      provisioned.rows[0].id,
      expect.objectContaining({
        allowedTypes: [],
        fullCollection: true,
        allowedOperations: ["describe", "query", "create", "update"]
      })
    );
    const reconciled = await db.query<{ allowed_types: string[] }>(
      "SELECT allowed_types FROM hosted_replicas WHERE id = $1",
      [provisioned.rows[0].id]
    );
    expect(reconciled.rows[0].allowed_types).toEqual([]);

    const activeControl = await app.inject({
      method: "GET",
      url: "/v1/connectors/hosted-control",
      headers: { authorization: `Bearer ${connector.token}` }
    });
    const grantId = activeControl.json().grants[0].id as string;
    const narrowed = await app.inject({
      method: "PATCH",
      url: `/v1/connectors/hosted/grants/${grantId}`,
      headers: { authorization: `Bearer ${connector.token}` },
      payload: { operations: ["describe", "query", "sync"] }
    });
    expect(narrowed.statusCode, JSON.stringify(narrowed.json())).toBe(200);
    expect(narrowed.json().grant.operations).toEqual(["describe", "query", "sync"]);
    expect(hostedProvider.updateApplicationReplica).toHaveBeenLastCalledWith(
      provisioned.rows[0].id,
      expect.objectContaining({ mode: "read_only", allowedOperations: ["describe", "query"] })
    );
    const broadened = await app.inject({
      method: "PATCH",
      url: `/v1/connectors/hosted/grants/${grantId}`,
      headers: { authorization: `Bearer ${connector.token}` },
      payload: { operations: ["describe", "query", "create", "sync"] }
    });
    expect(broadened.statusCode).toBe(400);
    const revoked = await app.inject({
      method: "DELETE",
      url: `/v1/connectors/hosted/grants/${grantId}`,
      headers: { authorization: `Bearer ${connector.token}` }
    });
    expect(revoked.statusCode).toBe(200);
    expect(hostedProvider.revokeReplica).toHaveBeenCalledWith(provisioned.rows[0].id);
  });

  it("provisions required types before creating a full-collection grant", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const contract = contractDescriptor();
    const hostedProvider = {
      url: "https://sync.example",
      ready: vi.fn(),
      createCollection: vi.fn(),
      renameCollection: vi.fn(),
      deleteCollection: vi.fn(),
      provisionTypePacks: vi.fn().mockResolvedValue([contract]),
      registerReplica: vi.fn(),
      updateApplicationReplica: vi.fn(),
      revokeReplica: vi.fn(),
      upsertNotificationGrant: vi.fn(),
      revokeNotificationGrant: vi.fn(),
      rotateReplicaToken: vi.fn(),
      compactThrough: vi.fn()
    } as unknown as HostedProviderClient;
    const { app } = await buildApp({
      db,
      devAuth: true,
      hostedCollections: true,
      hostedProvider,
      publicUrl: "http://connect.test",
      allowInsecureManifests: true
    });
    resources.push(() => app.close());
    const session = await app.inject({
      method: "POST",
      url: "/v1/dev/session",
      payload: { name: "Athlete", email: "athlete@example.com" }
    });
    const setCookie = session.headers["set-cookie"]!;
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
    const collection = await app.inject({
      method: "POST",
      url: "/v1/hosted/collections",
      headers: { cookie },
      payload: { display_name: "Training", template: "mdbase" }
    });
    const collectionId = collection.json().collection.id as string;
    const contractDocument = "---\nkind: mdbase.contract\ncontract_type: record\nid: workout.record\nversion: 1.0.0\nrecord_schema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n---\n";
    const typeDocument = "---\nkind: mdbase.type\nname: workout\nversion: 1\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\nimplements:\n  - contract: workout.record\n    version: 1.0.0\n    fields: {}\n---\n";
    const auxiliaryDocument = "---\nkind: mdbase.type\nname: workout_note\nversion: 1\nschema:\n  dialect: json-schema-2020-12\n  value:\n    type: object\n---\n";
    const pack = typePackProvision(
      "example.workouts",
      [
        ["contract", "contract.md", "_contracts/workout.record.md", contractDocument],
        ["type", "workout.md", "_types/workout.md", typeDocument],
        ["type", "workout-note.md", "_types/workout_note.md", auxiliaryDocument]
      ],
      [{ id: "workout.record", version: "1.0.0" }]
    );
    const manifestServer = applicationManifestFixture(
      {
        contracts: [{ id: "workout.record", version: "1.0.0" }],
        access: "full_collection"
      },
      "Workout Tracker",
      { type_packs: [pack] }
    );
    const discovered = await app.inject({
      method: "POST",
      url: "/v1/apps/register",
      payload: { manifest: manifestServer.manifest }
    });
    const applicationId = discovered.json().application.id as string;
    expect(discovered.json().application.provisions.type_packs[0].manifest.id)
      .toBe("example.workouts");
    const applicationAgreementPublicKey = p256PublicKey();
    const applicationSigningPublicKey = p256PublicKey();
    const authorization = await app.inject({
      method: "GET",
      url: `/oauth/authorize?client_id=${applicationId}&redirect_uri=${encodeURIComponent(manifestServer.redirectUri)}&code_challenge=${pkceChallenge("hosted-provision-verifier-that-is-long-enough-0001")}&code_challenge_method=S256&operations=read,query,create&relay_protocol=1&application_agreement_public_key=${applicationAgreementPublicKey}&application_signing_public_key=${applicationSigningPublicKey}`,
      headers: { cookie }
    });
    const requestId = authorization.headers.location!.split("/").at(-1)!;
    const pending = await app.inject({
      method: "GET",
      url: `/v1/authorization-requests/${requestId}`,
      headers: { cookie }
    });
    expect(pending.json().authorization.provisions.type_packs[0].provides).toEqual([
      { id: "workout.record", version: "1.0.0" }
    ]);
    const approved = await app.inject({
      method: "POST",
      url: `/v1/authorization-requests/${requestId}/approve`,
      headers: { cookie },
      payload: { collection_id: collectionId, operations: ["read", "query", "create"] }
    });
    expect(approved.statusCode).toBe(200);
    expect(hostedProvider.provisionTypePacks).toHaveBeenCalledWith(
      collectionId,
      [pack]
    );
    expect(hostedProvider.registerReplica).toHaveBeenCalledWith(
      collectionId,
      expect.objectContaining({ allowedTypes: [], fullCollection: true })
    );
    const grant = await db.query<{ scope: { access: string; contracts: unknown[] } }>(
      "SELECT scope FROM grants WHERE hosted_collection_id = $1",
      [collectionId]
    );
    expect(grant.rows[0].scope.contracts).toEqual([]);
    expect(grant.rows[0].scope.access).toBe("full_collection");
    const stored = await db.query<{ contracts: unknown[] }>(
      "SELECT contracts FROM hosted_collections WHERE id = $1",
      [collectionId]
    );
    expect(stored.rows[0].contracts).toEqual([contract]);
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

function applicationManifestFixture(
  requirements: ApplicationRequirements = {
    contracts: [{ id: "workout.record", version: "1.0.0" }]
  },
  name = "Workout Tracker",
  provisions?: NonNullable<MdbaseAppManifest["provisions"]>
): {
  manifest: MdbaseAppManifest;
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
    digest: `sha256:${"0".repeat(64)}`,
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
  provides: Array<{ id: string; version: string }>
) {
  return {
    manifest: {
      kind: "mdbase.type-pack" as const,
      id,
      version: "1.0.0",
      resources: resources.map(([kind, source, target, document]) => ({
        kind,
        source,
        target,
        digest: `sha256:${createHash("sha256").update(document).digest("hex")}`
      }))
    },
    resources: resources.map(([, source, , document]) => ({ source, document })),
    provides
  };
}
