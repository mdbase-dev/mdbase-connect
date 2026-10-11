import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app.js";
import { createDatabase } from "../../db.js";
import { HostedProviderResponseError, type HostedProviderClient } from "../../hosted-provider.js";
import { registerErrorHandler } from "../../platform/error-handler.js";
import { RequestValidationError } from "../../platform/http-errors.js";
import { tokenHash } from "../../security.js";

const resources: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  while (resources.length) await resources.pop()!();
});

describe("cutover refusals old clients can explain", () => {
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
      message: expect.stringContaining("Your data is safe"),
      details: { retry_after_seconds: 300 }
    });
  });
});
