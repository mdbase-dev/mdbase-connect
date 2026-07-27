import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createDatabase } from "./db.js";
import {
  HostedProviderUnavailableError,
  type HostedProviderClient
} from "./hosted-provider.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("portable local collection adoption", () => {
  it("activates the exact fenced snapshot, survives a lost response, and enrolls the old source as a mirror", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const collectionId = randomUUID();
    let completionAttempts = 0;
    const registeredReplicas: Array<{ collectionId: string; id: string }> = [];
    const provider = {
      url: "https://provider.example",
      prepareAuthorityImport: async (input: {
        transferId: string;
        collectionId: string;
        authorityEpoch: number;
      }) => ({
        id: input.transferId,
        collection_id: input.collectionId,
        authority_epoch: input.authorityEpoch,
        state: "receiving",
        manifest_digest: null,
        source_revision: null,
        source_head: null,
        expires_at: new Date(Date.now() + 30 * 60_000).toISOString()
      }),
      completeAuthorityImport: async (
        transferId: string,
        manifestDigest: string,
        sourceRevision: string
      ) => {
        completionAttempts += 1;
        if (completionAttempts === 1) {
          throw new HostedProviderUnavailableError(new Error("response lost after commit"));
        }
        return {
          id: transferId,
          collection_id: collectionId,
          authority_epoch: 2,
          state: "completed",
          manifest_digest: manifestDigest,
          source_revision: sourceRevision,
          source_head: 3,
          contracts: [{ id: "tasks", version: 1 }],
          expires_at: new Date(Date.now() + 30 * 60_000).toISOString()
        };
      },
      abortAuthorityImport: async () => ({ state: "aborted" }),
      registerReplica: async (
        registeredCollectionId: string,
        input: { id: string }
      ) => {
        registeredReplicas.push({
          collectionId: registeredCollectionId,
          id: input.id
        });
      }
    } as unknown as HostedProviderClient;
    const { app } = await buildApp({
      db,
      devAuth: true,
      hostedCollections: true,
      hostedProvider: provider,
      publicUrl: "http://connect.test"
    });
    resources.push(() => app.close());
    const cookie = await ownerSession(app);

    const begun = await app.inject({
      method: "POST",
      url: "/v1/authority-adoptions",
      payload: {
        collection_id: collectionId,
        display_name: "Phone notes",
        source_name: "Callum's phone",
        retain_mirror: true
      }
    });
    expect(begun.statusCode, begun.body).toBe(201);
    const adoptionId = begun.json().adoption_id as string;
    const secret = begun.json().adoption_secret as string;
    expect(begun.json().verification_uri).toBe(`http://connect.test/adopt/${adoptionId}`);
    expect((await app.inject({
      method: "POST",
      url: `/v1/authority-adoptions/${adoptionId}/exchange`,
      headers: { authorization: `Bearer ${secret}` },
      payload: {}
    })).statusCode).toBe(202);

    const approved = await app.inject({
      method: "POST",
      url: `/v1/authority-adoptions/${adoptionId}/approve`,
      headers: { cookie },
      payload: {}
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json().adoption).toMatchObject({
      collection_id: collectionId,
      state: "approved",
      retain_mirror: true,
      authority_epoch: 2
    });

    const exchanged = await app.inject({
      method: "POST",
      url: `/v1/authority-adoptions/${adoptionId}/exchange`,
      headers: { authorization: `Bearer ${secret}` },
      payload: {}
    });
    expect(exchanged.statusCode, exchanged.body).toBe(200);
    expect(exchanged.json()).toMatchObject({
      status: "ready",
      adoption: { id: adoptionId, state: "prepared" },
      import: {
        manifest_url: `https://provider.example/v1/authority-imports/${adoptionId}/manifest`,
        records_url: `https://provider.example/v1/authority-imports/${adoptionId}/records`,
        finalize_url: `https://provider.example/v1/authority-imports/${adoptionId}/finalize`
      }
    });

    const manifestDigest = "a".repeat(64);
    const sourceRevision = `sha256:${"b".repeat(64)}`;
    const completion = {
      manifest_digest: manifestDigest,
      source_revision: sourceRevision,
      source_head: 3
    };
    const forgedContracts = await app.inject({
      method: "POST",
      url: `/v1/authority-adoptions/${adoptionId}/complete`,
      headers: { authorization: `Bearer ${secret}` },
      payload: {
        ...completion,
        contracts: [{ id: "forged.contract", version: 999 }]
      }
    });
    expect(forgedContracts.statusCode).toBe(400);
    const uncertain = await app.inject({
      method: "POST",
      url: `/v1/authority-adoptions/${adoptionId}/complete`,
      headers: { authorization: `Bearer ${secret}` },
      payload: completion
    });
    expect(uncertain.statusCode).toBe(503);

    const activating = await app.inject({
      method: "POST",
      url: `/v1/authority-adoptions/${adoptionId}/exchange`,
      headers: { authorization: `Bearer ${secret}` },
      payload: {}
    });
    expect(activating.json()).toMatchObject({
      status: "activating",
      adoption: {
        manifest_digest: manifestDigest,
        source_revision: sourceRevision,
        final_head: 3
      }
    });
    expect((await app.inject({
      method: "DELETE",
      url: `/v1/authority-adoptions/${adoptionId}`,
      headers: { authorization: `Bearer ${secret}` }
    })).statusCode).toBe(409);
    expect((await app.inject({
      method: "POST",
      url: `/v1/authority-adoptions/${adoptionId}/complete`,
      headers: { authorization: `Bearer ${secret}` },
      payload: { ...completion, manifest_digest: "c".repeat(64) }
    })).statusCode).toBe(409);

    const completed = await app.inject({
      method: "POST",
      url: `/v1/authority-adoptions/${adoptionId}/complete`,
      headers: { authorization: `Bearer ${secret}` },
      payload: completion
    });
    expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.json()).toMatchObject({
      status: "completed",
      adoption: {
        state: "completed",
        collection_id: collectionId,
        authority_epoch: 2
      }
    });
    const metadata = await db.query<{
      authority_state: string;
      authority_epoch: string | number;
      contracts: Array<{ id: string; version: number }>;
    }>(
      "SELECT authority_state, authority_epoch, contracts FROM hosted_collections WHERE id = $1",
      [collectionId]
    );
    expect(metadata.rows[0]).toMatchObject({
      authority_state: "active",
      contracts: [{ id: "tasks", version: 1 }]
    });
    expect(Number(metadata.rows[0].authority_epoch)).toBe(2);

    const mirror = await app.inject({
      method: "POST",
      url: `/v1/mirror-pairing-requests/${adoptionId}/exchange`,
      headers: { authorization: `Bearer ${secret}` }
    });
    expect(mirror.statusCode, mirror.body).toBe(200);
    expect(mirror.json()).toMatchObject({
      status: "paired",
      replica: {
        collection_id: collectionId,
        name: "Callum's phone",
        mode: "read_write"
      }
    });
    expect(registeredReplicas).toHaveLength(1);
  });

  it("cancels staged adoption idempotently and removes both inactive hosted metadata and mirror approval", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    let aborts = 0;
    const provider = {
      url: "https://provider.example",
      prepareAuthorityImport: async (input: {
        transferId: string;
        collectionId: string;
        authorityEpoch: number;
      }) => ({
        id: input.transferId,
        collection_id: input.collectionId,
        authority_epoch: input.authorityEpoch,
        state: "receiving",
        manifest_digest: null,
        source_revision: null,
        source_head: null,
        expires_at: new Date(Date.now() + 30 * 60_000).toISOString()
      }),
      abortAuthorityImport: async () => {
        aborts += 1;
        return { state: "aborted" };
      }
    } as unknown as HostedProviderClient;
    const { app } = await buildApp({
      db,
      devAuth: true,
      hostedCollections: true,
      hostedProvider: provider,
      publicUrl: "http://connect.test"
    });
    resources.push(() => app.close());
    const cookie = await ownerSession(app);
    const collectionId = randomUUID();
    const begun = await app.inject({
      method: "POST",
      url: "/v1/authority-adoptions",
      payload: {
        collection_id: collectionId,
        display_name: "Cancelled",
        source_name: "Phone",
        retain_mirror: true
      }
    });
    const adoptionId = begun.json().adoption_id as string;
    const secret = begun.json().adoption_secret as string;
    expect((await app.inject({
      method: "POST",
      url: `/v1/authority-adoptions/${adoptionId}/approve`,
      headers: { cookie },
      payload: {}
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST",
      url: `/v1/authority-adoptions/${adoptionId}/exchange`,
      headers: { authorization: `Bearer ${secret}` },
      payload: {}
    })).statusCode).toBe(200);

    expect((await app.inject({
      method: "DELETE",
      url: `/v1/authority-adoptions/${adoptionId}`,
      headers: { authorization: `Bearer ${secret}` }
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "DELETE",
      url: `/v1/authority-adoptions/${adoptionId}`,
      headers: { authorization: `Bearer ${secret}` }
    })).statusCode).toBe(200);
    const cancelledExchange = await app.inject({
      method: "POST",
      url: `/v1/authority-adoptions/${adoptionId}/exchange`,
      headers: { authorization: `Bearer ${secret}` },
      payload: {}
    });
    expect(cancelledExchange.statusCode).toBe(409);
    expect(cancelledExchange.json().error.code).toBe("authority_adoption_cancelled");
    expect(aborts).toBe(2);
    expect((await db.query(
      "SELECT id FROM hosted_collections WHERE id = $1",
      [collectionId]
    )).rows).toHaveLength(0);
    expect((await db.query(
      "SELECT id FROM mirror_pairing_requests WHERE id = $1",
      [adoptionId]
    )).rows).toHaveLength(0);
  });

  it("retries provider cleanup after an expired adoption cleanup is interrupted", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    let aborts = 0;
    const provider = {
      url: "https://provider.example",
      abortAuthorityImport: async () => {
        aborts += 1;
        if (aborts === 1) {
          throw new HostedProviderUnavailableError(new Error("provider restart"));
        }
        return { state: "aborted" };
      }
    } as unknown as HostedProviderClient;
    const { app } = await buildApp({
      db,
      devAuth: true,
      hostedCollections: true,
      hostedProvider: provider,
      publicUrl: "http://connect.test"
    });
    resources.push(() => app.close());
    const cookie = await ownerSession(app);
    const collectionId = randomUUID();
    const begun = await app.inject({
      method: "POST",
      url: "/v1/authority-adoptions",
      payload: {
        collection_id: collectionId,
        display_name: "Expiry retry",
        source_name: "Phone",
        retain_mirror: true
      }
    });
    const adoptionId = begun.json().adoption_id as string;
    const secret = begun.json().adoption_secret as string;
    expect((await app.inject({
      method: "POST",
      url: `/v1/authority-adoptions/${adoptionId}/approve`,
      headers: { cookie },
      payload: {}
    })).statusCode).toBe(200);
    await db.query(
      "UPDATE authority_adoption_requests SET expires_at = $2 WHERE id = $1",
      [adoptionId, new Date(Date.now() - 60_000).toISOString()]
    );

    expect((await app.inject({
      method: "GET",
      url: `/v1/authority-adoptions/${adoptionId}`,
      headers: { cookie }
    })).statusCode).toBe(503);
    const interrupted = await db.query<{ state: string; cleanup_completed: boolean }>(
      "SELECT state, cleanup_completed FROM authority_adoption_requests WHERE id = $1",
      [adoptionId]
    );
    expect(interrupted.rows[0]).toEqual({
      state: "expired",
      cleanup_completed: false
    });

    expect((await app.inject({
      method: "GET",
      url: `/v1/authority-adoptions/${adoptionId}`,
      headers: { cookie }
    })).statusCode).toBe(200);
    expect(aborts).toBe(2);
    expect((await db.query(
      "SELECT id FROM hosted_collections WHERE id = $1",
      [collectionId]
    )).rows).toHaveLength(0);
    expect((await db.query<{ cleanup_completed: boolean }>(
      "SELECT cleanup_completed FROM authority_adoption_requests WHERE id = $1",
      [adoptionId]
    )).rows[0].cleanup_completed).toBe(true);
    const expiredExchange = await app.inject({
      method: "POST",
      url: `/v1/authority-adoptions/${adoptionId}/exchange`,
      headers: { authorization: `Bearer ${secret}` },
      payload: {}
    });
    expect(expiredExchange.statusCode).toBe(409);
    expect(expiredExchange.json().error.code).toBe("authority_adoption_expired");
  });
});

async function ownerSession(app: Awaited<ReturnType<typeof buildApp>>["app"]): Promise<string> {
  const session = await app.inject({
    method: "POST",
    url: "/v1/dev/session",
    payload: { name: "Owner", email: `${randomUUID()}@example.com` }
  });
  const setCookie = session.headers["set-cookie"]!;
  return (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0]!;
}
