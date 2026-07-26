import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createDatabase } from "./db.js";
import { tokenHash } from "./security.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("hosted-to-local authority transfer", () => {
  it("fences hosted writes, activates one local candidate, and revokes hosted access", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const { app } = await buildApp({
      db,
      devAuth: true,
      hostedCollections: true,
      hostedReferenceAuthority: true,
      publicUrl: "http://connect.test"
    });
    resources.push(() => app.close());

    const session = await app.inject({
      method: "POST",
      url: "/v1/dev/session",
      payload: { name: "Owner", email: "owner@example.com" }
    });
    const setCookie = session.headers["set-cookie"]!;
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
    const user = await db.query<{ id: string }>(
      "SELECT id FROM users WHERE email = 'owner@example.com'"
    );
    const userId = user.rows[0].id;

    const created = await app.inject({
      method: "POST",
      url: "/v1/hosted/collections",
      headers: { cookie },
      payload: { display_name: "Writing", template: "mdbase" }
    });
    const collectionId = created.json().collection.id as string;
    const pairing = await app.inject({
      method: "POST",
      url: "/v1/mirror-pairing-requests",
      payload: {
        mirror_name: "Writing folder",
        mode: "read_write",
        collection_id: collectionId
      }
    });
    const pairingId = pairing.json().pairing_id as string;
    const refreshToken = pairing.json().pairing_secret as string;
    expect((await app.inject({
      method: "POST",
      url: `/v1/mirror-pairing-requests/${pairingId}/approve`,
      headers: { cookie },
      payload: { collection_id: collectionId }
    })).statusCode).toBe(200);
    const exchanged = await app.inject({
      method: "POST",
      url: `/v1/mirror-pairing-requests/${pairingId}/exchange`,
      headers: { authorization: `Bearer ${refreshToken}` }
    });
    const replicaId = exchanged.json().replica.id as string;
    let replicaToken = exchanged.json().token as string;

    const sessionOpened = await app.inject({
      method: "POST",
      url: `/v1/hosted/collections/${collectionId}/sync/sessions`,
      headers: { authorization: `Bearer ${replicaToken}` }
    });
    expect(sessionOpened.statusCode).toBe(200);
    const firstRecordId = randomUUID();
    const firstMutation = await app.inject({
      method: "POST",
      url: `/v1/hosted/collections/${collectionId}/sync/mutations`,
      headers: { authorization: `Bearer ${replicaToken}` },
      payload: {
        mutation_id: randomUUID(),
        replica_id: replicaId,
        scope_epoch: 1,
        operation: "create",
        record_id: firstRecordId,
        input: {
          path: "notes/one.md",
          frontmatter: { title: "One" },
          body: "Body",
          types: []
        },
        created_at: new Date().toISOString()
      }
    });
    expect(firstMutation.statusCode).toBe(200);
    expect(firstMutation.json().status).toBe("applied");
    const renewed = await app.inject({
      method: "POST",
      url: `/v1/mirror-pairing-requests/${pairingId}/renew`,
      headers: { authorization: `Bearer ${refreshToken}` }
    });
    expect(renewed.statusCode, renewed.body).toBe(200);
    replicaToken = renewed.json().token as string;

    const applicationId = randomUUID();
    const grantId = randomUUID();
    await db.query(
      `INSERT INTO applications
         (id, canonical_identity, name, homepage, redirect_uris)
       VALUES ($1, $2, 'Editor', 'https://editor.example', '[]'::jsonb)`,
      [applicationId, `bundle:test:${applicationId}`]
    );
    await db.query(
      `INSERT INTO grants
         (id, user_id, application_id, hosted_collection_id, operations)
       VALUES ($1, $2, $3, $4, '["read","update"]'::jsonb)`,
      [grantId, userId, applicationId, collectionId]
    );
    await db.query(
      `INSERT INTO access_tokens (id, token_hash, grant_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [randomUUID(), `access-${grantId}`, grantId]
    );
    await db.query(
      `INSERT INTO refresh_tokens (id, token_hash, grant_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [randomUUID(), `refresh-${grantId}`, grantId]
    );

    const promotionMirror = await db.query(
      `SELECT pairing.id, pairing.secret_hash, pairing.user_id, pairing.collection_id, pairing.replica_id,
              pairing.consumed_at, replica.purpose, replica.mode, replica.allowed_types,
              replica.revoked_at, hosted.authority_state,
              replica.collection_id AS replica_collection_id
       FROM mirror_pairing_requests pairing
       JOIN hosted_replicas replica ON replica.id = pairing.replica_id
       JOIN hosted_collections hosted ON hosted.id = pairing.collection_id
       WHERE pairing.id = $1`,
      [pairingId]
    );
    expect(promotionMirror.rows[0]).toMatchObject({
      user_id: userId,
      collection_id: collectionId,
      replica_id: replicaId,
      consumed_at: expect.anything(),
      purpose: "mirror",
      mode: "read_write",
      allowed_types: [],
      revoked_at: null,
      authority_state: "active"
    });
    expect(promotionMirror.rows[0].replica_collection_id).toBe(collectionId);
    expect(promotionMirror.rows[0].secret_hash).toBe(tokenHash(refreshToken));
    const requested = await app.inject({
      method: "POST",
      url: `/v1/mirror-pairing-requests/${pairingId}/authority-transfers`,
      headers: { authorization: `Bearer ${refreshToken}` },
      payload: {}
    });
    expect(requested.statusCode, requested.body).toBe(201);
    const transferId = requested.json().transfer.id as string;
    const browserView = await app.inject({
      method: "GET",
      url: `/v1/authority-transfers/${transferId}`,
      headers: { cookie }
    });
    expect(browserView.json().transfer).toMatchObject({
      collection_name: "Writing",
      mirror_name: "Writing folder",
      state: "requested"
    });
    expect((await app.inject({
      method: "POST",
      url: `/v1/authority-transfers/${transferId}/approve`,
      headers: { cookie },
      payload: {}
    })).statusCode).toBe(200);
    const prepared = await app.inject({
      method: "POST",
      url: `/v1/authority-transfers/${transferId}/prepare`,
      headers: { authorization: `Bearer ${refreshToken}` },
      payload: {}
    });
    expect(prepared.statusCode).toBe(200);
    expect(prepared.json().transfer).toMatchObject({
      state: "prepared",
      final_head: 1,
      authority_epoch: 2
    });
    const manifestDigest = prepared.json().transfer.manifest_digest as string;
    expect(manifestDigest).toMatch(/^[a-f0-9]{64}$/);

    const fencedWrite = await app.inject({
      method: "POST",
      url: `/v1/hosted/collections/${collectionId}/sync/mutations`,
      headers: { authorization: `Bearer ${replicaToken}` },
      payload: {
        mutation_id: randomUUID(),
        replica_id: replicaId,
        scope_epoch: 1,
        operation: "create",
        record_id: randomUUID(),
        input: {
          path: "notes/two.md",
          frontmatter: { title: "Two" },
          body: "",
          types: []
        },
        created_at: new Date().toISOString()
      }
    });
    expect(fencedWrite.statusCode).toBe(400);
    expect(fencedWrite.json().error.code).toBe("authority_transfer_in_progress");
    expect((await app.inject({
      method: "GET",
      url: `/v1/hosted/collections/${collectionId}/sync/changes?after=0&limit=50`,
      headers: { authorization: `Bearer ${replicaToken}` }
    })).statusCode).toBe(200);

    const connector = await app.inject({
      method: "POST",
      url: "/v1/connectors",
      headers: { cookie },
      payload: { name: "Writing computer" }
    });
    const synchronized = await app.inject({
      method: "POST",
      url: "/v1/connectors/sync",
      headers: { authorization: `Bearer ${connector.json().token}` },
      payload: {
        inventory_revision: 1,
        collections: [{
          id: collectionId,
          display_name: "Writing",
          spec_version: "0.3.0",
          enabled: true,
          contracts: []
        }]
      }
    });
    expect(synchronized.json().collections[0]).toMatchObject({
      authority_state: "candidate",
      authority_epoch: 1
    });

    const completed = await app.inject({
      method: "POST",
      url: `/v1/authority-transfers/${transferId}/complete`,
      headers: { authorization: `Bearer ${refreshToken}` },
      payload: { manifest_digest: manifestDigest }
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({
      status: "completed",
      collection_id: collectionId,
      authority_epoch: 2
    });
    const repeated = await app.inject({
      method: "POST",
      url: `/v1/authority-transfers/${transferId}/complete`,
      headers: { authorization: `Bearer ${refreshToken}` },
      payload: { manifest_digest: manifestDigest }
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({ status: "completed", authority_epoch: 2 });

    const local = await db.query<{
      authority_state: string;
      authority_epoch: string | number;
      enabled: boolean;
    }>("SELECT authority_state, authority_epoch, enabled FROM collections WHERE local_id = $1", [
      collectionId
    ]);
    expect(local.rows[0]).toMatchObject({ authority_state: "active", enabled: true });
    expect(Number(local.rows[0].authority_epoch)).toBe(2);
    const hosted = await db.query<{
      authority_state: string;
      authority_epoch: string | number;
      transferred_collection_id: string;
    }>(
      `SELECT authority_state, authority_epoch, transferred_collection_id
       FROM hosted_collections WHERE id = $1`,
      [collectionId]
    );
    expect(hosted.rows[0].authority_state).toBe("transferred");
    expect(Number(hosted.rows[0].authority_epoch)).toBe(2);
    expect(hosted.rows[0].transferred_collection_id).toBe(completed.json().local_collection_id);
    const revoked = await db.query<{
      grant_revoked: string | null;
      access_revoked: string | null;
      refresh_revoked: string | null;
    }>(
      `SELECT g.revoked_at AS grant_revoked,
              atok.revoked_at AS access_revoked,
              rtok.revoked_at AS refresh_revoked
       FROM grants g
       JOIN access_tokens atok ON atok.grant_id = g.id
       JOIN refresh_tokens rtok ON rtok.grant_id = g.id
       WHERE g.id = $1`,
      [grantId]
    );
    expect(revoked.rows[0].grant_revoked).not.toBeNull();
    expect(revoked.rows[0].access_revoked).not.toBeNull();
    expect(revoked.rows[0].refresh_revoked).not.toBeNull();
    expect((await app.inject({
      method: "POST",
      url: `/v1/hosted/collections/${collectionId}/sync/sessions`,
      headers: { authorization: `Bearer ${replicaToken}` }
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: "DELETE",
      url: `/v1/hosted/collections/${collectionId}`,
      headers: { cookie }
    })).statusCode).toBe(200);
    const afterArchiveDeletion = await app.inject({
      method: "POST",
      url: "/v1/connectors/sync",
      headers: { authorization: `Bearer ${connector.json().token}` },
      payload: {
        inventory_revision: 2,
        collections: [{
          id: collectionId,
          display_name: "Writing",
          spec_version: "0.3.0",
          enabled: true,
          contracts: []
        }]
      }
    });
    expect(afterArchiveDeletion.json().collections[0]).toMatchObject({
      authority_state: "active",
      authority_epoch: 2
    });

    const cancellable = await app.inject({
      method: "POST",
      url: "/v1/hosted/collections",
      headers: { cookie },
      payload: { display_name: "Keep hosted", template: "mdbase" }
    });
    const cancellableCollectionId = cancellable.json().collection.id as string;
    const cancellablePairing = await app.inject({
      method: "POST",
      url: "/v1/mirror-pairing-requests",
      payload: {
        mirror_name: "Cancelled folder",
        mode: "read_write",
        collection_id: cancellableCollectionId
      }
    });
    const cancellablePairingId = cancellablePairing.json().pairing_id as string;
    const cancellableRefresh = cancellablePairing.json().pairing_secret as string;
    expect((await app.inject({
      method: "POST",
      url: `/v1/mirror-pairing-requests/${cancellablePairingId}/approve`,
      headers: { cookie },
      payload: { collection_id: cancellableCollectionId }
    })).statusCode).toBe(200);
    const cancellableExchange = await app.inject({
      method: "POST",
      url: `/v1/mirror-pairing-requests/${cancellablePairingId}/exchange`,
      headers: { authorization: `Bearer ${cancellableRefresh}` }
    });
    const cancellableReplicaToken = cancellableExchange.json().token as string;
    const cancellableRequest = await app.inject({
      method: "POST",
      url: `/v1/mirror-pairing-requests/${cancellablePairingId}/authority-transfers`,
      headers: { authorization: `Bearer ${cancellableRefresh}` },
      payload: {}
    });
    const cancellableTransferId = cancellableRequest.json().transfer.id as string;
    expect((await app.inject({
      method: "POST",
      url: `/v1/authority-transfers/${cancellableTransferId}/approve`,
      headers: { cookie },
      payload: {}
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST",
      url: `/v1/authority-transfers/${cancellableTransferId}/prepare`,
      headers: { authorization: `Bearer ${cancellableRefresh}` },
      payload: {}
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST",
      url: "/v1/connectors/sync",
      headers: { authorization: `Bearer ${connector.json().token}` },
      payload: {
        inventory_revision: 3,
        collections: [{
          id: cancellableCollectionId,
          display_name: "Keep hosted",
          spec_version: "0.3.0",
          enabled: true,
          contracts: []
        }]
      }
    })).json().collections[0].authority_state).toBe("candidate");
    expect((await app.inject({
      method: "DELETE",
      url: `/v1/authority-transfers/${cancellableTransferId}`,
      headers: { cookie }
    })).statusCode).toBe(200);
    const cancelledState = await db.query<{
      hosted_state: string;
      local_state: string;
      enabled: boolean;
    }>(
      `SELECT hosted.authority_state AS hosted_state,
              local.authority_state AS local_state, local.enabled
       FROM hosted_collections hosted
       JOIN collections local ON local.local_id = hosted.id
       WHERE hosted.id = $1`,
      [cancellableCollectionId]
    );
    expect(cancelledState.rows[0]).toMatchObject({
      hosted_state: "active",
      local_state: "retired",
      enabled: false
    });
    expect((await app.inject({
      method: "POST",
      url: `/v1/hosted/collections/${cancellableCollectionId}/sync/sessions`,
      headers: { authorization: `Bearer ${cancellableReplicaToken}` }
    })).statusCode).toBe(200);
  }, 15_000);
});
