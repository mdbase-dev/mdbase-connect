import { createHash, randomUUID } from "node:crypto";
import { runAuthAdminCommand } from "../../auth-admin.js";
import { assertControlPlaneMigrationsCurrent, runControlPlaneMigrations, repairAuthorityImportSources, migrationExecutableSha256 } from "../../migrations.js";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app.js";
import { createDatabase } from "../../db.js";
import type { HostedProviderClient } from "../hosted/hosted-provider.js";

const resources: Array<() => Promise<void>> = [];
const snapshot = {
  manifest_digest: "a".repeat(64),
  source_revision: `sha256:${"b".repeat(64)}`,
  source_head: 41
};
const repairSql = await readFile(new URL(
  "../../../migrations/0036_authority_import_source_repair.sql", import.meta.url
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
  const { app } = await buildApp({
    db, devAuth: true, hostedCollections: true, publicUrl: "http://connect.test",
    hostedProvider: {
      url: "https://provider.example", upsertAccount: async () => ({})
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
  const source = async () => (await db.query<{
    id: string; user_id: string; authority_state: string; authority_epoch: number;
    enabled: boolean; reported_enabled: boolean;
  }>(
    "SELECT id, user_id, authority_state, authority_epoch, enabled, reported_enabled FROM collections WHERE connector_id=$1 AND local_id=$2",
    [connector.connector.id, collectionId]
  )).rows[0];
  expect((await sync()).statusCode).toBe(200);
  return { db, app, collectionId, connector, createConnector, inventory, sync, source };
}

// The local-to-hosted routes are gone, but rows a legacy connector staged
// before their removal remain. Seed one exactly as those routes left it.
async function stage(
  f: Awaited<ReturnType<typeof fixture>>,
  state: "requested" | "prepared" | "activating" | "completed" = "prepared"
) {
  const local = await f.source();
  const epoch = Number(local.authority_epoch) + 1;
  const id = randomUUID();
  await f.db.query(
    `INSERT INTO hosted_collections
       (id, user_id, display_name, template, provider_url, contracts,
        authority_state, authority_epoch)
     VALUES ($1, $2, 'Test notes', 'mdbase', 'https://provider.example', '[]'::jsonb, $3, $4)`,
    [f.collectionId, local.user_id, state === "completed" ? "active" : "importing", epoch]
  );
  await f.db.query(
    `INSERT INTO authority_transfers
       (id, user_id, hosted_collection_id, local_collection_id, direction,
        state, next_authority_epoch, manifest_digest, source_revision,
        final_head, expires_at)
     VALUES ($1, $2, $3, $4, 'to_hosted', $5, $6, $7, $8, $9, now() + interval '30 minutes')`,
    [id, local.user_id, f.collectionId, local.id, state, epoch,
      ...(["activating", "completed"].includes(state)
        ? [snapshot.manifest_digest, snapshot.source_revision, snapshot.source_head]
        : [null, null, null])]
  );
  if (state === "completed") {
    await f.db.query(
      "UPDATE collections SET authority_state='retired', enabled=false, authority_epoch=$2 WHERE id=$1",
      [local.id, epoch]
    );
  }
  return id;
}

describe("inventory with a retained local-to-hosted transfer (issue 529)", () => {
  it.each(["requested", "prepared", "activating"] as const)("preserves the exact source while %s", async (state) => {
    const f = await fixture();
    await stage(f, state);
    for (let tick = 0; tick < 3; tick++) {
      const synced = await f.sync();
      expect(synced.statusCode, synced.body).toBe(200);
      expect(synced.json().collections[0]).toMatchObject({ authority_state: "active", authority_epoch: 1 });
    }
    expect(await f.source()).toMatchObject({ authority_state: "active", authority_epoch: 1, enabled: true });
  });

  it("keeps a completed source retired after disabled inventory and historical candidate demotion", async () => {
    const f = await fixture();
    await stage(f, "completed");
    await f.db.query("UPDATE collections SET authority_state='candidate' WHERE id=$1", [(await f.source()).id]);
    expect((await f.sync(false)).statusCode).toBe(200);
    expect(await f.source()).toMatchObject({ authority_state: "retired", authority_epoch: 2, enabled: false });
  });

  it("does not grant authority to another connector with the importing identity", async () => {
    const f = await fixture();
    await stage(f);
    const other = await f.createConnector();
    const synced = await f.app.inject({
      method: "POST", url: "/v1/connectors/sync", headers: { authorization: `Bearer ${other.token}` },
      payload: { inventory_revision: 1, collections: [f.inventory()] }
    });
    expect(synced.statusCode, synced.body).toBe(200);
    expect(synced.json().collections[0]).toMatchObject({ authority_state: "candidate", authority_epoch: 2 });
    expect((await f.sync()).statusCode).toBe(200);
    expect(await f.source()).toMatchObject({ authority_state: "active", authority_epoch: 1 });
  });
});

// The hosted-to-local routes are gone, but collections they moved remain.
// Seed the hosted side exactly as a completed move left it.
describe("inventory with a retained hosted-to-local transfer", () => {
  async function hosted(f: Awaited<ReturnType<typeof fixture>>, transferred: boolean) {
    const local = await f.source();
    await f.db.query(
      `INSERT INTO hosted_collections
         (id, user_id, display_name, template, provider_url, contracts,
          authority_state, authority_epoch, transferred_collection_id)
       VALUES ($1, $2, 'Test notes', 'mdbase', 'https://provider.example', '[]'::jsonb, $3, $4, $5)`,
      [f.collectionId, local.user_id, transferred ? "transferred" : "active",
        transferred ? 2 : 1, transferred ? local.id : null]
    );
    if (transferred) await f.db.query("UPDATE collections SET authority_epoch=2 WHERE id=$1", [local.id]);
  }

  it("keeps the activated local collection active at the transferred epoch", async () => {
    const f = await fixture();
    await hosted(f, true);
    const synced = await f.sync();
    expect(synced.statusCode, synced.body).toBe(200);
    expect(synced.json().collections[0]).toMatchObject({ authority_state: "active", authority_epoch: 2 });
    expect(await f.source()).toMatchObject({ authority_state: "active", authority_epoch: 2, enabled: true });
  });

  it("reports a local copy of a hosted collection that was not transferred as a candidate", async () => {
    const f = await fixture();
    await hosted(f, false);
    const synced = await f.sync();
    expect(synced.statusCode, synced.body).toBe(200);
    expect(synced.json().collections[0].authority_state).toBe("candidate");
  });
});

describe("repair of historical inventory-corrupted transfer sources", () => {
  it.each(["prepared", "activating"] as const)("repairs only the staged source epoch of a %s transfer", async (state) => {
    const f = await fixture();
    await stage(f, state);
    await f.db.query("UPDATE collections SET authority_state='candidate',authority_epoch=2,enabled=false WHERE id=$1", [(await f.source()).id]);
    await f.db.query(repairSql);
    expect(await f.source()).toMatchObject({ authority_state: "active", authority_epoch: 1, enabled: true });
    await f.db.query(repairSql);
    expect(await f.source()).toMatchObject({ authority_state: "active", authority_epoch: 1, enabled: true });
    expect((await f.sync()).statusCode).toBe(200);
    expect(await f.source()).toMatchObject({ authority_state: "active", authority_epoch: 1, enabled: true });
  });

  it("repairs a high staged epoch to its own predecessor, not epoch one", async () => {
    const f = await fixture();
    const sourceId = (await f.source()).id;
    await f.db.query("UPDATE collections SET authority_epoch=18 WHERE id=$1", [sourceId]);
    await stage(f);
    await f.db.query("UPDATE collections SET authority_state='candidate',authority_epoch=19,enabled=false WHERE id=$1", [sourceId]);
    await f.db.query(repairSql);
    expect(await f.source()).toMatchObject({ authority_state: "active", authority_epoch: 18 });
  });

  it("preserves paused availability while repairing the source", async () => {
    const f = await fixture();
    await stage(f);
    await f.db.query("UPDATE collections SET authority_state='candidate',authority_epoch=2,enabled=false,reported_enabled=false WHERE id=$1", [(await f.source()).id]);
    await f.db.query(repairSql);
    expect(await f.source()).toMatchObject({ authority_state: "active", authority_epoch: 1, enabled: false, reported_enabled: false });
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
