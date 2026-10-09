import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app.js";
import { scheduleStarterCollection } from "../../account-onboarding.js";
import { createDatabase, type DatabasePool } from "../../db.js";
import type { HostedProviderClient } from "../../hosted-provider.js";
import { HostedAuthorityRegistry } from "../../hosted.js";
import { addToCohort, createCohort, setCohortFrozen } from "./migration-rollout.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;
const operator = "synthetic-local-test";

// Synthetic local account-management authentication only. No LAB accounts,
// installed native credentials, migration admission or real provider effects.
suite("topology freeze actual route aliases on isolated PostgreSQL", () => {
  let db: DatabasePool, admin: pg.Pool, schema: string;
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Dedicated local test PostgreSQL required");
    schema = `topology_routes_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString() });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
  }, 60_000);
  afterAll(async () => {
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });
  async function account(app: Awaited<ReturnType<typeof buildApp>>["app"]) {
    const email = `${randomUUID()}@example.test`;
    const session = await app.inject({ method: "POST", url: "/v1/dev/session", payload: { name: "Synthetic", email } });
    expect(session.statusCode).toBe(200);
    const cookie = String(session.headers["set-cookie"]).split(";")[0]!;
    const id = (await db.query<{ id: string }>("SELECT id FROM users WHERE email=$1", [email])).rows[0]!.id;
    const cohort = `route-${randomUUID()}`;
    await createCohort(db, cohort, operator); await addToCohort(db, cohort, [id], operator);
    return { id, cohort, cookie };
  }
  async function freeze(cohort: string, value: boolean) {
    await setCohortFrozen(db, cohort, value, value ? "synthetic capture" : "cancel before acceptance", operator);
  }
  const snapshot = { manifest_digest: "a".repeat(64), source_revision: `sha256:${"b".repeat(64)}`, source_head: 0 };

  it("fences account/connector create, rename, delete and onboarding before provider/compensation effects", async () => {
    const create = vi.fn(async () => undefined), rename = vi.fn(async () => undefined), erase = vi.fn(async () => undefined);
    const upsert = vi.fn(async () => ({}));
    const { app } = await buildApp({ db, devAuth: true, hostedCollections: true, hostedProvider: {
      url: "https://synthetic.example.test", upsertAccount: upsert, createCollection: create, renameCollection: rename, deleteCollection: erase
    } as unknown as HostedProviderClient });
    try {
      const a = await account(app);
      const connector = await app.inject({ method: "POST", url: "/v1/connectors", headers: { cookie: a.cookie }, payload: { name: "Synthetic" } });
      expect(connector.statusCode).toBe(201);
      const nativeHeaders = { authorization: `Bearer ${connector.json().token}` };
      const created = await app.inject({ method: "POST", url: "/v1/hosted/collections", headers: { cookie: a.cookie }, payload: { display_name: "Synthetic", template: "mdbase", timezone: "UTC" } });
      expect(created.statusCode).toBe(201);
      const collection = created.json().collection.id as string;
      const starter = await scheduleStarterCollection(db, a.id);
      await freeze(a.cohort, true);
      create.mockClear(); upsert.mockClear();
      const requests = [
        { method: "POST" as const, url: "/v1/hosted/collections", headers: { cookie: a.cookie }, payload: { display_name: "Refused", template: "mdbase", timezone: "UTC" } },
        { method: "POST" as const, url: "/v1/connectors/hosted/collections", headers: nativeHeaders, payload: { display_name: "Refused", template: "mdbase", timezone: "UTC" } },
        { method: "POST" as const, url: "/v1/onboarding/starter-collection", headers: { cookie: a.cookie }, payload: {} },
        ...["/v1/hosted/collections", "/v1/connectors/hosted/collections"].flatMap((root, index) => [
          { method: "PATCH" as const, url: `${root}/${collection}`, headers: index ? nativeHeaders : { cookie: a.cookie }, payload: { display_name: "Refused" } },
          { method: "DELETE" as const, url: `${root}/${collection}`, headers: index ? nativeHeaders : { cookie: a.cookie } }
        ])
      ];
      for (const request of requests) {
        const result = await app.inject(request); expect(result.statusCode).toBe(409); expect(result.json().error.code).toBe("migration_frozen");
      }
      for (const effect of [create, rename, erase, upsert]) expect(effect).not.toHaveBeenCalled();
      expect((await db.query("SELECT display_name FROM hosted_collections WHERE id=$1", [collection])).rows[0].display_name).toBe("Synthetic");
      expect((await db.query("SELECT 1 FROM hosted_collections WHERE id=$1", [starter])).rowCount).toBe(0);
      await freeze(a.cohort, false);
      expect((await app.inject({ method: "POST", url: "/v1/onboarding/starter-collection", headers: { cookie: a.cookie }, payload: {} })).statusCode).toBe(200);
      expect(create).toHaveBeenCalledOnce(); expect(erase).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it.each(["reference", "provider"] as const)("fences the actual hosted-to-local %s request/approve/prepare/complete/abort routes", async (mode) => {
    let { app } = await buildApp({ db, devAuth: true, hostedCollections: true, hostedReferenceAuthority: true });
    const referencePrepare = vi.spyOn(HostedAuthorityRegistry.prototype, "prepareAuthorityTransfer");
    const referenceComplete = vi.spyOn(HostedAuthorityRegistry.prototype, "completeAuthorityTransfer");
    const referenceAbort = vi.spyOn(HostedAuthorityRegistry.prototype, "abortAuthorityTransfer");
    try {
      const a = await account(app);
      const created = await app.inject({ method: "POST", url: "/v1/hosted/collections", headers: { cookie: a.cookie }, payload: { display_name: "Synthetic", template: "mdbase", timezone: "UTC" } });
      expect(created.statusCode).toBe(201);
      const collection = created.json().collection.id as string;
      const pairing = await app.inject({ method: "POST", url: "/v1/mirror-pairing-requests", payload: { collection_id: collection, mirror_name: "Synthetic", mode: "read_write" } });
      expect(pairing.statusCode).toBe(201);
      const pairingId = pairing.json().pairing_id as string, secret = pairing.json().pairing_secret as string;
      expect((await app.inject({ method: "POST", url: `/v1/mirror-pairing-requests/${pairingId}/approve`, headers: { cookie: a.cookie }, payload: { collection_id: collection } })).statusCode).toBe(200);
      const exchanged = await app.inject({ method: "POST", url: `/v1/mirror-pairing-requests/${pairingId}/exchange`, headers: { authorization: `Bearer ${secret}` } });
      expect(exchanged.statusCode).toBe(200);
      const replica = exchanged.json().replica.id as string;
      const prepare = vi.fn(async (_collection: string, input: { transferId: string }) => ({ id: input.transferId, collection_id: collection, replica_id: replica,
        state: "prepared", final_head: 0, authority_epoch: 2, manifest_digest: "a".repeat(64), expires_at: new Date(Date.now() + 15 * 60_000).toISOString() }));
      const complete = vi.fn(async (id: string) => ({ id, collection_id: collection, state: "completed", authority_epoch: 2 }));
      const abort = vi.fn(async () => undefined);
      if (mode === "provider") {
        await app.close();
        ({ app } = await buildApp({ db, devAuth: true, hostedCollections: true, hostedProvider: {
          url: "https://synthetic.example.test", prepareAuthorityTransfer: prepare, completeAuthorityTransfer: complete, abortAuthorityTransfer: abort
        } as unknown as HostedProviderClient }));
      }
      const headers = { authorization: `Bearer ${secret}` }, requestUrl = `/v1/mirror-pairing-requests/${pairingId}/authority-transfers`;
      await freeze(a.cohort, true);
      const refusedRequest = await app.inject({ method: "POST", url: requestUrl, headers, payload: {} });
      expect(refusedRequest.statusCode).toBe(409); expect(refusedRequest.json().error.code).toBe("migration_frozen");
      await freeze(a.cohort, false);
      const requested = await app.inject({ method: "POST", url: requestUrl, headers, payload: {} });
      expect(requested.statusCode).toBe(201);
      const transfer = requested.json().transfer.id as string, url = `/v1/authority-transfers/${transfer}`;
      await freeze(a.cohort, true);
      const refusedApprove = await app.inject({ method: "POST", url: `${url}/approve`, headers: { cookie: a.cookie }, payload: {} });
      expect(refusedApprove.statusCode).toBe(409); expect(refusedApprove.json().error.code).toBe("migration_frozen");
      await freeze(a.cohort, false);
      expect((await app.inject({ method: "POST", url: `${url}/approve`, headers: { cookie: a.cookie }, payload: {} })).statusCode).toBe(200);
      await freeze(a.cohort, true);
      for (const request of [{ method: "POST" as const, url: `${url}/prepare`, payload: {} }, { method: "DELETE" as const, url }]) {
        const result = await app.inject({ ...request, headers }); expect(result.statusCode).toBe(409); expect(result.json().error.code).toBe("migration_frozen");
      }
      for (const effect of [prepare, complete, abort, referencePrepare, referenceComplete, referenceAbort]) expect(effect).not.toHaveBeenCalled();
      await freeze(a.cohort, false);
      const prepared = await app.inject({ method: "POST", url: `${url}/prepare`, headers, payload: {} });
      expect(prepared.statusCode).toBe(200);
      const digest = prepared.json().transfer.manifest_digest as string;
      const connector = await app.inject({ method: "POST", url: "/v1/connectors", headers: { cookie: a.cookie }, payload: { name: "Synthetic" } });
      expect(connector.statusCode).toBe(201);
      expect((await app.inject({ method: "POST", url: "/v1/connectors/sync", headers: { authorization: `Bearer ${connector.json().token}` }, payload: {
        inventory_revision: 1, collections: [{ id: collection, display_name: "Synthetic", spec_version: "0.3.0", enabled: true, contracts: [] }]
      } })).statusCode).toBe(200);
      await freeze(a.cohort, true);
      for (const request of [{ method: "POST" as const, url: `${url}/complete`, payload: { manifest_digest: digest } }, { method: "DELETE" as const, url }]) {
        const result = await app.inject({ ...request, headers }); expect(result.statusCode).toBe(409); expect(result.json().error.code).toBe("migration_frozen");
      }
      for (const effect of [complete, abort, referenceComplete, referenceAbort]) expect(effect).not.toHaveBeenCalled();
      expect(mode === "provider" ? prepare : referencePrepare).toHaveBeenCalledOnce();
      expect((await db.query("SELECT authority_state FROM hosted_collections WHERE id=$1", [collection])).rows[0].authority_state).toBe("transferring");
      await freeze(a.cohort, false);
      expect((await app.inject({ method: "POST", url: `${url}/complete`, headers, payload: { manifest_digest: digest } })).statusCode).toBe(200);
      expect(mode === "provider" ? complete : referenceComplete).toHaveBeenCalledOnce();
      expect((await db.query("SELECT authority_state FROM hosted_collections WHERE id=$1", [collection])).rows[0].authority_state).toBe("transferred");
    } finally { referencePrepare.mockRestore(); referenceComplete.mockRestore(); referenceAbort.mockRestore(); await app.close(); }
  });

  it("fences adoption approve/exchange/complete/abort including prepared replay and durable activation replay", async () => {
    const prepare = vi.fn(async () => ({ state: "prepared", expires_at: new Date(Date.now() + 30 * 60_000).toISOString() }));
    const abort = vi.fn(async () => undefined), complete = vi.fn(async (id: string) => {
      const row = (await db.query<{ collection_id: string }>("SELECT collection_id FROM authority_adoption_requests WHERE id=$1", [id])).rows[0]!;
      return { id, collection_id: row.collection_id, authority_epoch: 2, state: "completed", contracts: [], ...snapshot };
    });
    const { app } = await buildApp({ db, devAuth: true, hostedCollections: true, hostedProvider: {
      url: "https://synthetic.example.test", upsertAccount: async () => ({}), prepareAuthorityImport: prepare, completeAuthorityImport: complete, abortAuthorityImport: abort
    } as unknown as HostedProviderClient });
    try {
      const a = await account(app), collection = randomUUID();
      const begun = await app.inject({ method: "POST", url: "/v1/authority-adoptions", payload: { collection_id: collection, display_name: "Synthetic", source_name: "Synthetic", retain_mirror: false } });
      expect(begun.statusCode).toBe(201);
      const id = begun.json().adoption_id as string, secret = begun.json().adoption_secret as string;
      const headers = { authorization: `Bearer ${secret}` }, url = `/v1/authority-adoptions/${id}`;
      const approve = () => app.inject({ method: "POST", url: `${url}/approve`, headers: { cookie: a.cookie }, payload: {} });
      await freeze(a.cohort, true);
      expect((await approve()).json().error.code).toBe("migration_frozen");
      expect((await db.query("SELECT 1 FROM hosted_collections WHERE id=$1", [collection])).rowCount).toBe(0);
      await freeze(a.cohort, false); expect((await approve()).statusCode).toBe(200);
      await freeze(a.cohort, true);
      for (const request of [{ method: "POST" as const, url: `${url}/exchange`, payload: {} }, { method: "DELETE" as const, url }]) {
        const result = await app.inject({ ...request, headers }); expect(result.statusCode).toBe(409); expect(result.json().error.code).toBe("migration_frozen");
      }
      expect(prepare).not.toHaveBeenCalled(); expect(abort).not.toHaveBeenCalled();
      await freeze(a.cohort, false);
      expect((await app.inject({ method: "POST", url: `${url}/exchange`, headers, payload: {} })).statusCode).toBe(200);
      await freeze(a.cohort, true);
      for (const request of [{ method: "POST" as const, url: `${url}/exchange`, payload: {} }, { method: "POST" as const, url: `${url}/complete`, payload: snapshot }, { method: "DELETE" as const, url }]) {
        const result = await app.inject({ ...request, headers }); expect(result.statusCode).toBe(409); expect(result.json().error.code).toBe("migration_frozen");
      }
      expect(prepare).toHaveBeenCalledOnce(); expect(complete).not.toHaveBeenCalled(); expect(abort).not.toHaveBeenCalled();
      expect((await db.query("SELECT state FROM authority_adoption_requests WHERE id=$1", [id])).rows[0].state).toBe("prepared");
      await freeze(a.cohort, false);
      complete.mockRejectedValueOnce(new Error("synthetic uncertain provider completion"));
      expect((await app.inject({ method: "POST", url: `${url}/complete`, headers, payload: snapshot })).statusCode).toBe(500);
      expect((await db.query("SELECT state FROM authority_adoption_requests WHERE id=$1", [id])).rows[0].state).toBe("activating");
      await freeze(a.cohort, true);
      expect((await app.inject({ method: "POST", url: `${url}/complete`, headers, payload: snapshot })).json().error.code).toBe("migration_frozen");
      expect(complete).toHaveBeenCalledOnce();
      await freeze(a.cohort, false);
      expect((await app.inject({ method: "POST", url: `${url}/complete`, headers, payload: snapshot })).statusCode).toBe(200);
      expect(complete).toHaveBeenCalledTimes(2);
      expect((await db.query("SELECT authority_state FROM hosted_collections WHERE id=$1", [collection])).rows[0].authority_state).toBe("active");
    } finally { await app.close(); }
  });
});
