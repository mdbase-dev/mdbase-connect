import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app.js";
import { createDatabase } from "../../db.js";
import { HostedProviderResponseError, type HostedProviderClient } from "../../hosted-provider.js";
import { registerErrorHandler } from "../../platform/error-handler.js";
import { RequestValidationError } from "../../platform/http-errors.js";
import { tokenHash } from "../../security.js";
import { CutoverProblemError } from "./cutover-problems.js";
// The published old client's own refresh and error decoding, not a re-creation.
import { performAuthorizationRefresh } from "../../../../../packages/client/src/authorization-refresh.js";
import { apiError as legacyClientError } from "../../../../../packages/client/src/runtime-utils.js";

const resources: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  while (resources.length) await resources.pop()!();
});

describe("cutover refusals old clients can explain", () => {
  const reloadGuidance = "mdbase has been updated. Copy any unsaved work somewhere safe, "
    + "then reload this page to continue.";

  it.each(["moved", "onboarding_moved"] as const)("preserves safe reload guidance through the old SDK for %s", async (kind) => {
    const app = Fastify();
    resources.push(() => app.close());
    registerErrorHandler(app);
    app.get("/cutover", async () => { throw new CutoverProblemError(kind); });
    const response = await app.inject({ method: "GET", url: "/cutover" });
    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.error.code).toBe(kind === "moved" ? "collection_unavailable" : "onboarding_moved");
    expect(body.error.message.startsWith(reloadGuidance)).toBe(true);
    expect(body.error.message).not.toMatch(/collection_unavailable|onboarding_moved|moved_to_next_runtime/);
    expect(response.headers["retry-after"]).toBeUndefined();
    expect(legacyClientError(body, "request_failed", "fallback", 409).message).toBe(body.error.message);
  });
  it("tells an old client its moved collection needs an app update", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const [userId, collectionId, replicaId, applicationId, grantId] =
      Array.from({ length: 5 }, () => randomUUID());
    const refreshToken = "refresh-moved-collection-token";
    await db.query("INSERT INTO users (id, email, name) VALUES ($1, 'moved@example.com', 'Moved')", [userId]);
    await db.query(
      `INSERT INTO hosted_collections (id, user_id, display_name, template, contracts)
       VALUES ($1, $2, 'Notes', 'mdbase', '[]'::jsonb)`,
      [collectionId, userId]
    );
    await db.query(
      `INSERT INTO hosted_replicas (id, collection_id, authorized_user_id, name, purpose, mode, allowed_types)
       VALUES ($1, $2, $3, 'Application', 'application', 'read_only', '[]'::jsonb)`,
      [replicaId, collectionId, userId]
    );
    await db.query(
      `INSERT INTO applications (id, canonical_identity, name, homepage, redirect_uris)
       VALUES ($1, 'web:https://moved-app.example', 'Moved app', 'https://moved-app.example',
               '["https://moved-app.example/callback"]'::jsonb)`,
      [applicationId]
    );
    await db.query(
      `INSERT INTO grants (id, user_id, application_id, hosted_collection_id, hosted_replica_id,
                           operations, scope, notification_criteria, application_origin)
       VALUES ($1, $2, $3, $4, $5, '["read"]'::jsonb,
               '{"contracts":[],"access":"full_collection"}'::jsonb, '[]'::jsonb,
               'https://moved-app.example')`,
      [grantId, userId, applicationId, collectionId, replicaId]
    );
    await db.query(
      `INSERT INTO refresh_tokens (id, token_hash, grant_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 day')`,
      [randomUUID(), tokenHash(refreshToken), grantId]
    );
    await db.query(
      `INSERT INTO next_migration_collections
         (collection_id, account_id, s_final, cutover_seq, barrier_f, final_digest)
       VALUES ($1, $2, 0, 1, 1, 'digest')`,
      [collectionId, userId]
    );
    const rotateReplicaToken = vi.fn();
    const { app } = await buildApp({
      db,
      devAuth: true,
      hostedCollections: true,
      hostedProvider: { url: "https://sync.example", ready: vi.fn(), rotateReplicaToken } as unknown as HostedProviderClient,
      publicUrl: "http://connect.test",
      clientUpdate: { updateUrl: "https://example.test/get", minimumClientVersion: "2.0.0" }
    });
    resources.push(() => app.close());
    // The startup scan revokes this undeclared fixture app's grant at a racy
    // moment; settle it and restore the grant so the cutover is what refuses.
    await (app as typeof app & { drainApplicationReconciliation(): Promise<void> })
      .drainApplicationReconciliation();
    await db.query("UPDATE grants SET revoked_at = NULL WHERE id = $1", [grantId]);
    await db.query("UPDATE refresh_tokens SET revoked_at = NULL WHERE grant_id = $1", [grantId]);

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

    expect(refresh.statusCode, refresh.body).toBe(409);
    expect(refresh.json().error).toEqual({
      code: "collection_unavailable",
      message: expect.stringContaining("https://example.test/get"),
      details: {
        reason: "moved_to_next_runtime",
        update_url: "https://example.test/get",
        minimum_client_version: "2.0.0"
      }
    });
    expect(refresh.json().error.message.startsWith(reloadGuidance)).toBe(true);
    expect(refresh.json().error.message).not.toMatch(/collection_unavailable|moved_to_next_runtime/);
    expect(rotateReplicaToken).not.toHaveBeenCalled();
  });

  it("answers the provider's migrating fence with a retry the client can schedule", async () => {
    const app = Fastify();
    resources.push(() => app.close());
    registerErrorHandler(app);
    app.get("/fenced", async () => {
      throw new HostedProviderResponseError(409, "collection_migrating", "provider text");
    });
    app.get("/fenced-invite", async () => {
      throw new RequestValidationError("Invite text.", {
        code: "collection_migrating",
        statusCode: 409,
        details: { retry_after_seconds: 120 }
      });
    });
    const invite = await app.inject({ method: "GET", url: "/fenced-invite" });
    expect(invite.statusCode).toBe(409);
    expect(invite.headers["retry-after"]).toBe("120");
    expect(invite.json().error).toEqual({
      code: "collection_migrating",
      message: "Invite text.",
      details: { retry_after_seconds: 120 }
    });
    const response = await app.inject({ method: "GET", url: "/fenced" });
    expect(response.statusCode).toBe(409);
    expect(response.headers["retry-after"]).toBe("300");
    expect(response.json().error).toMatchObject({
      code: "collection_migrating",
      message: expect.stringContaining("may not be saved"),
      details: { retry_after_seconds: 300 }
    });
    // A refused legacy write is not retried: never claim the data is safe.
    expect(response.json().error.message).not.toMatch(/data is safe/i);
    expect(response.json().error.message).toMatch(/make them again/);
  });
  it("tells an old client its desktop collection moved once mdbase-next took it over", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const [userId, connectorId, rowId, localId, applicationId, grantId] =
      Array.from({ length: 6 }, () => randomUUID());
    const accessToken = "access-taken-over-token", refreshToken = "refresh-taken-over-token";
    await db.query("INSERT INTO users (id, email, name, account_backend) VALUES ($1, 'desk@example.com', 'Desk', 'next')", [userId]);
    await db.query("INSERT INTO connectors (id, user_id, name, token_hash, revoked_at) VALUES ($1, $2, 'Laptop', 'hash', now())", [connectorId, userId]);
    await db.query(
      `INSERT INTO collections (id, user_id, connector_id, local_id, display_name, spec_version, authority_state, enabled)
       VALUES ($1, $2, $3, $4, 'Notes', '0.3.0', 'retired', false)`,
      [rowId, userId, connectorId, localId]
    );
    await db.query(
      `INSERT INTO next_collections (collection_id, owner_user_id, runtime, sync, root_key_id)
       VALUES ($1, $2, 'next', 'private', $3)`,
      [localId, userId, Buffer.alloc(16)]
    );
    await db.query(
      `INSERT INTO applications (id, canonical_identity, name, homepage, redirect_uris)
       VALUES ($1, 'web:https://desk-app.example', 'Desk app', 'https://desk-app.example',
               '["https://desk-app.example/callback"]'::jsonb)`,
      [applicationId]
    );
    await db.query(
      `INSERT INTO grants (id, user_id, application_id, collection_id, operations, scope,
                           notification_criteria, application_origin,
                           application_authorization, application_installation_id)
       VALUES ($1, $2, $3, $4, '["read"]'::jsonb,
               '{"contracts":[],"access":"full_collection"}'::jsonb, '[]'::jsonb, 'https://desk-app.example',
               '{"binding":{"protocol_version":5}}'::jsonb, 'installation-1')`,
      [grantId, userId, applicationId, rowId]
    );
    const { app } = await buildApp({
      db,
      devAuth: true,
      publicUrl: "http://connect.test",
      clientUpdate: { updateUrl: "https://example.test/get", minimumClientVersion: null }
    });
    resources.push(() => app.close());
    await (app as typeof app & { drainApplicationReconciliation(): Promise<void> })
      .drainApplicationReconciliation();
    await db.query("UPDATE grants SET revoked_at = NULL WHERE id = $1", [grantId]);
    await db.query("INSERT INTO access_tokens (id, token_hash, grant_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')",
      [randomUUID(), tokenHash(accessToken), grantId]);
    await db.query("INSERT INTO refresh_tokens (id, token_hash, grant_id, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')",
      [randomUUID(), tokenHash(refreshToken), grantId]);
    // Old clients normalise codes they don't know but keep the message and details.
    const moved = {
      message: expect.stringContaining("https://example.test/get"),
      details: { reason: "moved_to_next_runtime", update_url: "https://example.test/get" }
    };

    // The old client's relay call: Bearer token, JSON body, to the control plane.
    const operation = await app.inject({
      method: "POST",
      url: `/v1/authorities/${localId}/operations/query`,
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      payload: JSON.stringify({ type: "note" })
    });
    expect(operation.statusCode, operation.body).toBe(409);
    expect(operation.json().error.code).toBe("collection_unavailable");
    expect(operation.json().error.message.startsWith(reloadGuidance)).toBe(true);
    expect(legacyClientError(operation.json(), "request_failed", "fallback", 409)).toMatchObject(moved);

    // The old client's refresh after that refusal.
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const response = await app.inject({
        method: "POST", url: new URL(url).pathname,
        headers: init.headers as Record<string, string>, payload: init.body as string
      });
      return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
    });
    resources.push(() => vi.unstubAllGlobals());
    const removeToken = vi.fn();
    const stored = { refreshToken, refreshExpiresAt: Date.now() + 60_000, clientId: applicationId, keyHandle: "k" };
    await expect(performAuthorizationRefresh({
      current: stored as never,
      serverUrl: "http://connect.test",
      keyStore: {} as never,
      currentToken: () => stored as never,
      directCapable: () => false,
      removeToken,
      storeTokenResponse: () => { throw new Error("a moved collection must not be issued a token"); }
    })).rejects.toMatchObject(moved);
  });
});
