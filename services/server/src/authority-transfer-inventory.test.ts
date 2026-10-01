import { createHash, randomUUID } from "node:crypto";
import { runAuthAdminCommand } from "./auth-admin.js";
import { assertControlPlaneMigrationsCurrent, runControlPlaneMigrations, repairAuthorityImportSources, migrationExecutableSha256 } from "./migrations.js";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { createDatabase } from "./db.js";
import {
  HostedProviderResponseError,
  HostedProviderUnavailableError,
  type HostedProviderClient
} from "./hosted-provider.js";

const resources: Array<() => Promise<void>> = [];
const snapshot = {
  manifest_digest: "a".repeat(64),
  source_revision: `sha256:${"b".repeat(64)}`,
  source_head: 41
};
const repairSql = await readFile(new URL(
  "../migrations/0036_authority_import_source_repair.sql", import.meta.url
), "utf8");
const repairChecksum = createHash("sha256").update(repairSql).digest("hex");

afterEach(async () => {
  vi.restoreAllMocks();
  while (resources.length) await resources.pop()?.();
});

async function fixture() {
  const db = await createDatabase("memory");
  resources.push(() => db.end());
  const collectionId = randomUUID();
  const epochs = new Map<string, number>();
  const receipt = (id: string) => ({
    id,
    collection_id: collectionId,
    authority_epoch: epochs.get(id)!,
    state: "completed",
    ...snapshot,
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString()
  });
  const prepare = vi.fn(async (input: {
    transferId: string; collectionId: string; authorityEpoch: number;
  }) => {
    epochs.set(input.transferId, input.authorityEpoch);
    return {
      id: input.transferId,
      collection_id: input.collectionId,
      authority_epoch: input.authorityEpoch,
      state: "receiving",
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString()
    };
  });
  const completeProvider = vi.fn(async (id: string) => receipt(id));
  const abort = vi.fn(async () => ({ state: "aborted" }));
  const { app } = await buildApp({
    db, devAuth: true, hostedCollections: true, publicUrl: "http://connect.test",
    hostedProvider: {
      url: "https://provider.example", upsertAccount: async () => ({}),
      prepareAuthorityImport: prepare,
      completeAuthorityImport: completeProvider,
      abortAuthorityImport: abort
    } as unknown as HostedProviderClient
  });
  resources.push(() => app.close());
  const session = await app.inject({
    method: "POST", url: "/v1/dev/session",
    payload: { name: "Owner", email: `${collectionId}@example.test` }
  });
  const setCookie = session.headers["set-cookie"]!;
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
  const createConnector = async () => (await app.inject({
    method: "POST", url: "/v1/connectors", headers: { cookie },
    payload: { name: "Test computer" }
  })).json() as { connector: { id: string }; token: string };
  const connector = await createConnector();
  const headers = { authorization: `Bearer ${connector.token}` };
  let revision = 0;
  const inventory = (enabled = true) => ({
    id: collectionId, display_name: "Test notes", spec_version: "0.3.0",
    enabled, contracts: []
  });
  const sync = (enabled = true) => app.inject({
    method: "POST", url: "/v1/connectors/sync", headers,
    payload: { inventory_revision: ++revision, collections: [inventory(enabled)] }
  });
  const begin = () => app.inject({
    method: "POST", url: `/v1/connectors/collections/${collectionId}/authority-transfers`,
    headers, payload: {}
  });
  const complete = (id: string, input = snapshot) => app.inject({
    method: "POST", url: `/v1/connectors/authority-transfers/${id}/complete`,
    headers, payload: input
  });
  const cancel = (id: string) => app.inject({
    method: "DELETE", url: `/v1/connectors/authority-transfers/${id}`, headers
  });
  const source = async () => (await db.query<{
    id: string; authority_state: string; authority_epoch: number;
    enabled: boolean; reported_enabled: boolean;
  }>(
    "SELECT id, authority_state, authority_epoch, enabled, reported_enabled FROM collections WHERE connector_id=$1 AND local_id=$2",
    [connector.connector.id, collectionId]
  )).rows[0];
  expect((await sync()).statusCode).toBe(200);
  return {
    db, app, collectionId, connector, createConnector, inventory,
    sync, begin, complete, cancel, source, prepare, completeProvider, abort, receipt
  };
}

async function stage(f: Awaited<ReturnType<typeof fixture>>) {
  const begun = await f.begin();
  expect(begun.statusCode, begun.body).toBe(201);
  expect(begun.json().transfer.authority_epoch).toBe(2);
  return begun.json().transfer.id as string;
}

describe("local-to-hosted transfer inventory interleavings (issue 529)", () => {
  it.each(["requested", "prepared"])("preserves the exact source while %s and resumes the same transfer", async (state) => {
    const f = await fixture();
    const id = await stage(f);
    await f.db.query("UPDATE authority_transfers SET state=$2 WHERE id=$1", [id, state]);
    for (let tick = 0; tick < 3; tick++) {
      const synced = await f.sync();
      expect(synced.statusCode, synced.body).toBe(200);
      expect(synced.json().collections[0]).toMatchObject({ authority_state: "active", authority_epoch: 1 });
    }
    expect(await f.source()).toMatchObject({ authority_state: "active", authority_epoch: 1, enabled: true });
    const resumed = await f.begin();
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(resumed.json().transfer.id).toBe(id);
    expect((await f.complete(id)).statusCode).toBe(200);
    expect(await f.source()).toMatchObject({ authority_state: "retired", authority_epoch: 2, enabled: false });
  });

  it("allows inventory between the activation reservation and provider completion", async () => {
    const f = await fixture();
    const id = await stage(f);
    f.completeProvider.mockImplementationOnce(async (transferId) => {
      expect((await f.sync()).statusCode).toBe(200);
      expect(await f.source()).toMatchObject({ authority_state: "active", authority_epoch: 1 });
      return f.receipt(transferId);
    });
    const completed = await f.complete(id);
    expect(completed.statusCode, completed.body).toBe(200);
    expect(await f.source()).toMatchObject({ authority_state: "retired", authority_epoch: 2 });
  });

  it.each(["lost response", "projection pending"])("resumes the fenced snapshot after %s and an inventory tick", async (failure) => {
    const f = await fixture();
    const id = await stage(f);
    f.completeProvider.mockRejectedValueOnce(failure === "lost response"
      ? new HostedProviderUnavailableError(new Error("response lost"))
      : new HostedProviderResponseError(409, "projection_activation_pending", "Still indexing."));
    expect((await f.complete(id)).statusCode).toBe(failure === "lost response" ? 503 : 202);
    expect((await f.sync()).statusCode).toBe(200);
    const resumed = await f.begin();
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(resumed.json().transfer).toMatchObject({ id, state: "activating", ...{
      manifest_digest: snapshot.manifest_digest, source_revision: snapshot.source_revision, final_head: snapshot.source_head
    } });
    expect(resumed.json().import).toBeUndefined();
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect((await f.complete(id, { ...snapshot, source_head: 42 })).statusCode).toBe(409);
    expect((await f.cancel(id)).statusCode).toBe(409);
    expect(f.abort).not.toHaveBeenCalled();
    expect((await f.complete(id)).statusCode).toBe(200);
  });

  it("keeps completed receipts reachable after disabled inventory and historical candidate demotion", async () => {
    const f = await fixture();
    const id = await stage(f);
    expect((await f.complete(id)).statusCode).toBe(200);
    await f.db.query("UPDATE collections SET authority_state='candidate' WHERE id=$1", [(await f.source()).id]);
    const recovered = await f.begin();
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.json().transfer).toMatchObject({ id, state: "completed" });
    expect((await f.sync(false)).statusCode).toBe(200);
    expect(await f.source()).toMatchObject({ authority_state: "retired", authority_epoch: 2, enabled: false });
    expect((await f.begin()).json().transfer).toMatchObject({ id, state: "completed" });
    expect(f.completeProvider).toHaveBeenCalledTimes(1);
  });

  it("does not grant authority to another connector with the importing identity", async () => {
    const f = await fixture();
    await stage(f);
    const other = await f.createConnector();
    const headers = { authorization: `Bearer ${other.token}` };
    const synced = await f.app.inject({
      method: "POST", url: "/v1/connectors/sync", headers,
      payload: { inventory_revision: 1, collections: [f.inventory()] }
    });
    expect(synced.statusCode, synced.body).toBe(200);
    expect(synced.json().collections[0]).toMatchObject({ authority_state: "candidate", authority_epoch: 2 });
    expect((await f.app.inject({
      method: "POST", url: `/v1/connectors/collections/${f.collectionId}/authority-transfers`,
      headers, payload: {}
    })).statusCode).toBe(409);
    expect((await f.sync()).statusCode).toBe(200);
    expect(await f.source()).toMatchObject({ authority_state: "active", authority_epoch: 1 });
  });

  it("cancellation and repeated inventory do not advance the source or next staged epoch", async () => {
    const f = await fixture();
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = await stage(f);
      expect((await f.sync()).statusCode).toBe(200);
      expect((await f.cancel(id)).statusCode).toBe(200);
      expect((await f.cancel(id)).statusCode).toBe(200);
      expect((await f.sync()).statusCode).toBe(200);
      expect(await f.source()).toMatchObject({ authority_state: "active", authority_epoch: 1 });
    }
    expect(f.completeProvider).not.toHaveBeenCalled();
  });

  it("activates a high existing source epoch without resetting it", async () => {
    const f = await fixture();
    await f.db.query("UPDATE collections SET authority_epoch=19 WHERE id=$1", [(await f.source()).id]);
    const begun = await f.begin();
    expect(begun.statusCode, begun.body).toBe(201);
    expect(begun.json().transfer.authority_epoch).toBe(20);
    expect((await f.sync()).json().collections[0].authority_epoch).toBe(19);
    const completed = await f.complete(begun.json().transfer.id);
    expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.json().authority_epoch).toBe(20);
  });

  it("reports a genuine preflight source mismatch without creating a new transfer or activating the provider", async () => {
    const f = await fixture();
    const id = await stage(f);
    await f.db.query("UPDATE collections SET authority_epoch=7 WHERE id=$1", [(await f.source()).id]);
    for (const result of [await f.complete(id), await f.begin()]) {
      expect(result.statusCode, result.body).toBe(409);
      expect(result.json().error).toMatchObject({
        code: "authority_transfer_source_changed",
        details: { transfer_id: id, collection_id: f.collectionId, phase: "preflight", source_state: "active", source_epoch: 7, expected_source_epoch: 1, staged_epoch: 2 }
      });
    }
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.completeProvider).not.toHaveBeenCalled();
    expect((await f.cancel(id)).statusCode).toBe(200);
  });

  it("keeps a genuine post-provider mismatch fenced and does not claim cancellation is safe", async () => {
    const f = await fixture();
    const id = await stage(f);
    f.completeProvider.mockImplementationOnce(async (transferId) => {
      await f.db.query("UPDATE collections SET authority_state='candidate',authority_epoch=2 WHERE id=$1", [(await f.source()).id]);
      return f.receipt(transferId);
    });
    const result = await f.complete(id);
    expect(result.statusCode, result.body).toBe(409);
    expect(result.json().error.details).toMatchObject({ transfer_id: id, phase: "activation", source_state: "candidate", source_epoch: 2 });
    expect(result.json().error.message).toContain("Provider activation may have completed");
    const resumed = await f.begin();
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(resumed.json().transfer).toMatchObject({ id, state: "activating" });
    expect((await f.cancel(id)).statusCode).toBe(409);
    expect(f.abort).not.toHaveBeenCalled();
  });

});

describe("repair of historical inventory-corrupted transfer sources", () => {
  it.each(["prepared", "activating"])("repairs only the staged source epoch and resumes a %s transfer", async (state) => {
    const f = await fixture();
    const id = await stage(f);
    if (state === "activating") {
      f.completeProvider.mockRejectedValueOnce(new HostedProviderUnavailableError(new Error("response lost")));
      expect((await f.complete(id)).statusCode).toBe(503);
    }
    await f.db.query("UPDATE collections SET authority_state='candidate',authority_epoch=2,enabled=false WHERE id=$1", [(await f.source()).id]);
    await f.db.query(repairSql);
    expect(await f.source()).toMatchObject({ authority_state: "active", authority_epoch: 1, enabled: true });
    await f.db.query(repairSql);
    expect(await f.source()).toMatchObject({ authority_state: "active", authority_epoch: 1, enabled: true });
    expect((await f.sync()).statusCode).toBe(200);
    expect((await f.begin()).json().transfer).toMatchObject({ id, state });
    expect((await f.complete(id)).statusCode).toBe(200);
  });

  it("repairs a high staged epoch to its own predecessor, not epoch one", async () => {
    const f = await fixture();
    const sourceId = (await f.source()).id;
    await f.db.query("UPDATE collections SET authority_epoch=18 WHERE id=$1", [sourceId]);
    const begun = await f.begin();
    expect(begun.statusCode, begun.body).toBe(201);
    expect(begun.json().transfer.authority_epoch).toBe(19);
    await f.db.query("UPDATE collections SET authority_state='candidate',authority_epoch=19,enabled=false WHERE id=$1", [sourceId]);
    await f.db.query(repairSql);
    expect(await f.source()).toMatchObject({ authority_state: "active", authority_epoch: 18 });
    const resumed = await f.begin();
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(resumed.json().transfer.id).toBe(begun.json().transfer.id);
    expect((await f.complete(begun.json().transfer.id)).statusCode).toBe(200);
    expect(await f.source()).toMatchObject({ authority_state: "retired", authority_epoch: 19 });
  });

  it("preserves paused availability while repairing the source", async () => {
    const f = await fixture();
    await stage(f);
    await f.db.query("UPDATE collections SET authority_state='candidate',authority_epoch=2,enabled=false,reported_enabled=false WHERE id=$1", [(await f.source()).id]);
    await f.db.query(repairSql);
    expect(await f.source()).toMatchObject({ authority_state: "active", authority_epoch: 1, enabled: false, reported_enabled: false });
    expect((await f.begin()).statusCode).toBe(409);
    expect(f.prepare).toHaveBeenCalledTimes(1);
  });

  it.each(["wrong epoch", "active source", "cancelled", "active target", "revoked connector", "another active source"])("does not repair %s", async (condition) => {
    const f = await fixture();
    const id = await stage(f);
    const sourceId = (await f.source()).id;
    await f.db.query("UPDATE collections SET authority_state='candidate',authority_epoch=2,enabled=false WHERE id=$1", [sourceId]);
    if (condition === "wrong epoch") await f.db.query("UPDATE collections SET authority_epoch=7 WHERE id=$1", [sourceId]);
    if (condition === "active source") await f.db.query("UPDATE collections SET authority_state='active' WHERE id=$1", [sourceId]);
    if (condition === "cancelled") await f.db.query("UPDATE authority_transfers SET state='cancelled' WHERE id=$1", [id]);
    if (condition === "active target") await f.db.query("UPDATE hosted_collections SET authority_state='active' WHERE id=$1", [f.collectionId]);
    if (condition === "revoked connector") await f.db.query("UPDATE connectors SET revoked_at=now() WHERE id=$1", [f.connector.connector.id]);
    if (condition === "another active source") {
      const other = await f.createConnector();
      await f.db.query(
        "INSERT INTO collections (id,user_id,connector_id,local_id,display_name,spec_version,authority_state) SELECT $1,user_id,$2,local_id,'Other','0.3.0','active' FROM collections WHERE id=$3",
        [randomUUID(), other.connector.id, sourceId]
      );
    }
    const before = await f.source();
    await f.db.query(repairSql);
    expect(await f.source()).toEqual(before);
  });
});

describe("post-rollout authority repair", () => {
  const revision = "a".repeat(40);
  const mutation = () => ({
    operationId: randomUUID(), actor: "release-test", reason: "old writers drained"
  });
  const corrupt = async (f: Awaited<ReturnType<typeof fixture>>) => {
    await f.db.query("UPDATE collections SET authority_state='candidate',authority_epoch=2,enabled=false WHERE id=$1", [(await f.source()).id]);
  };
  const ledger = (f: Awaited<ReturnType<typeof fixture>>) => f.db.query(
    "SELECT checksum FROM schema_migrations WHERE id='0036_authority_import_source_repair'"
  );

  it("keeps startup/readiness schema-only, then repairs after the rollout", async () => {
    const f = await fixture();
    await stage(f);
    await corrupt(f);
    await runControlPlaneMigrations(f.db);
    await assertControlPlaneMigrationsCurrent(f.db);
    expect((await ledger(f)).rows).toHaveLength(0);
    expect(await f.source()).toMatchObject({ authority_state: "candidate", authority_epoch: 2 });
    expect((await f.app.inject({ url: "/health" })).statusCode).toBe(200);
    const receipt = await repairAuthorityImportSources(f.db, mutation(), revision, repairChecksum);
    expect(receipt).toMatchObject({ source_revision: revision, repaired_sources: 1 });
    expect((await ledger(f)).rows).toEqual([{ checksum: createHash("sha256").update(repairSql).digest("hex") }]);
    expect(await f.source()).toMatchObject({ authority_state: "active", authority_epoch: 1, enabled: true });
    expect((await f.sync()).statusCode).toBe(200);
    expect((await repairAuthorityImportSources(f.db, mutation(), revision, repairChecksum)).repaired_sources).toBe(0);
  });

  it("reruns the repair even when a legacy startup recorded it before an old writer undid it", async () => {
    const f = await fixture();
    await stage(f);
    await corrupt(f);
    await f.db.query(repairSql);
    await f.db.query("INSERT INTO schema_migrations (id,checksum) VALUES ('0036_authority_import_source_repair',$1)", [createHash("sha256").update(repairSql).digest("hex")]);
    await corrupt(f);
    const before = (await ledger(f)).rows;
    expect((await repairAuthorityImportSources(f.db, mutation(), revision, repairChecksum)).repaired_sources).toBe(1);
    expect((await ledger(f)).rows).toEqual(before);
    expect(await f.source()).toMatchObject({ authority_state: "active", authority_epoch: 1 });
  });

  it.each(["unapplied schema", "changed repair checksum"])("rejects %s without changing data", async (problem) => {
    const f = await fixture();
    await stage(f);
    await corrupt(f);
    if (problem === "unapplied schema") {
      await f.db.query("DELETE FROM schema_migrations WHERE id='0035_portable_people'");
    } else {
      await f.db.query("INSERT INTO schema_migrations (id,checksum) VALUES ('0036_authority_import_source_repair','wrong')");
    }
    await expect(repairAuthorityImportSources(f.db, mutation(), revision, repairChecksum)).rejects.toThrow(/migration.*(not been applied|changed after)/i);
    expect(await f.source()).toMatchObject({ authority_state: "candidate", authority_epoch: 2 });
    expect((await f.db.query("SELECT id FROM audit_events WHERE event_type='authority.import_sources.repaired'")).rows).toHaveLength(0);
  });

  it("binds the operator command to the exact runtime before acquiring a database connection", async () => {
    const f = await fixture();
    const connect = vi.spyOn(f.db, "connect");
    await expect(runAuthAdminCommand([
      "repairs", "authority-import-sources", "--expected-revision", revision,
      "--operation-id", randomUUID(), "--actor", "release-test", "--reason", "old writers drained"
    ], { db: f.db, defaultRegistrationMode: "closed", runtimeRevision: "b".repeat(40) })).rejects.toThrow("runtime revision does not match");
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects SQL and executable mismatches before acquiring a database connection", async () => {
    const f = await fixture();
    const connect = vi.spyOn(f.db, "connect");
    await expect(repairAuthorityImportSources(f.db, mutation(), revision, "f".repeat(64))).rejects.toThrow("SQL does not match");
    await expect(runAuthAdminCommand([
      "repairs", "authority-import-sources", "--expected-revision", revision,
      "--expected-executable-sha256", "f".repeat(64)
    ], { db: f.db, defaultRegistrationMode: "closed", runtimeRevision: revision })).rejects.toThrow("executable does not match");
    expect(connect).not.toHaveBeenCalled();
  });

  it("returns a bounded audited receipt through the operator request envelope", async () => {
    const f = await fixture();
    await stage(f);
    await corrupt(f);
    const input = mutation();
    const argv = ["repairs", "authority-import-sources", "--expected-revision", revision,
      "--expected-executable-sha256", await migrationExecutableSha256(),
      "--expected-migration-sha256", repairChecksum,
      "--operation-id", input.operationId, "--actor", input.actor, "--reason", input.reason];
    const output = await runAuthAdminCommand([
      "request", Buffer.from(JSON.stringify(argv)).toString("base64url")
    ], { db: f.db, defaultRegistrationMode: "closed", runtimeRevision: revision });
    expect(output).toEqual({ operation_id: input.operationId, source_revision: revision,
      migration_id: "0036_authority_import_source_repair", checksum: repairChecksum,
      executable_sha256: await migrationExecutableSha256(), repaired_sources: 1 });
    const audit = await f.db.query<{ metadata: unknown }>("SELECT metadata FROM audit_events WHERE event_type='authority.import_sources.repaired'");
    expect(audit.rows).toEqual([{ metadata: { ...(output as object), actor: input.actor, reason: input.reason } }]);
  });
});
