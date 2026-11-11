import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { runAuthAdminCommand } from "../../auth-admin.js";
import { queueNextPolicy, registerNextCollection } from "../next/policy-outbox.js";
import { LocalRelayBroker, RelayBrokerUnavailableError } from "../relay/relay-broker.js";
import { ensureDevelopmentEntitlement } from "../account/entitlements.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePostgres = testUrl && approved ? describe : describe.skip;

describePostgres("read-only collection diagnostics", () => {
  let admin: pg.Pool;
  let db: DatabasePool;
  let schema: string;
  const broker = new LocalRelayBroker();

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) {
      throw new Error("Diagnostics tests require a dedicated local test database.");
    }
    schema = `mdbase_diagnostics_test_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
  }, 60_000);

  afterAll(async () => {
    await broker.close();
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  }, 60_000);

  async function fixture(enrolLater = false) {
    const user = randomUUID(), device = randomUUID(), connector = randomUUID(), collection = randomUUID();
    const keys = { signPublicKey: randomBytes(32), kemPublicKey: randomBytes(32), noisePublicKey: randomBytes(32) };
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Fixture')", [user, `${user}@example.test`]);
    await ensureDevelopmentEntitlement(db, user);
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash,connector_version,relay_generation,last_seen_at) VALUES($1,$2,'Fixture',$3,'0.1.0-beta.1',7,now())", [connector, user, randomUUID()]);
    await db.query("INSERT INTO next_devices(id,connector_id,user_id,kind,sign_pk,kem_pk,noise_pk) VALUES($1,$2,$3,'desktop',$4,$5,$6)",
      [device, connector, user, keys.signPublicKey, keys.kemPublicKey, keys.noisePublicKey]);
    await registerNextCollection(db, { collectionId: collection, ownerUserId: user, runtime: "next", sync: "private", rootKeyId: Buffer.alloc(16, 9), displayName: "Fixture notebook",
      ops: [{ op: "genesis", owner: user, root: Buffer.alloc(16, 9), state: "e2e" },
        { op: "member-set", account: user, role: "owner" },
        ...(enrolLater ? [] : [{ op: "device-enrol" as const, device, account: user, kind: "desktop" as const, ...keys }])] });
    await append(collection);
    if (enrolLater) {
      await queueNextPolicy(db, collection, [{ op: "device-enrol", device, account: user, kind: "desktop", ...keys }]);
      await append(collection);
    }
    return { user, device, connector, collection, keys };
  }

  async function append(collection: string) {
    const sequence = Number((await db.query<{ count: string }>("SELECT count(*) FROM next_policy_batches WHERE collection_id = $1", [collection])).rows[0]!.count) + 1;
    const batch = await db.query<{ id: string }>(
      `INSERT INTO next_policy_batches(collection_id,seq,prev,item,issued_at,state,appended_at)
       VALUES($1,$2,$3,$4,$2,'appended',now()) RETURNING id`, [collection, sequence, Buffer.alloc(32), Buffer.from([sequence])]
    );
    await db.query("UPDATE next_policy_outbox SET batch_id = $1 WHERE collection_id = $2 AND batch_id IS NULL", [batch.rows[0]!.id, collection]);
  }

  async function diagnose(user: string, flags: string[] = [], relayBroker = { request: vi.fn(broker.request.bind(broker)) }) {
    return await runAuthAdminCommand(["collections", "diagnose", "--user", user, ...flags],
      { db, defaultRegistrationMode: "closed", relayBroker, runtimeRevision: "a".repeat(40) }) as {
        collections: Array<{ collection_id: string; availability: { state: string; reason?: string }; devices: Array<Record<string, unknown>>; deleted: boolean }>;
        account_registrations: Array<Record<string, unknown>>; next_cursor: string | null;
      };
  }

  it("matches chooser presence, reports versions and emits no keys or credentials", async () => {
    const fixtureState = await fixture();
    const request = vi.fn(broker.request.bind(broker));
    const binding = await broker.bind({ connectorId: fixtureState.connector, generation: "7", handle: async () => ({ version: 1, ok: true, value: true }),
      handleBinary: async () => ({ version: 1, ok: true, value: new Uint8Array() }), replaced: () => {} });
    try {
      const report = await diagnose(`${fixtureState.user}@example.test`, [], { request });
      expect(report.collections).toEqual([expect.objectContaining({ collection_id: fixtureState.collection, availability: { state: "available" },
        devices: [{ device_id: fixtureState.device, connector_id: fixtureState.connector, presence: "responded", online: true, serving: true, old_connector_running: false }] })]);
      expect(report.account_registrations).toEqual([expect.objectContaining({ connector_version: "0.1.0-beta.1", revoked_at: null })]);
      expect(request).toHaveBeenCalledExactlyOnceWith(fixtureState.connector, "7", { version: 1, kind: "device_presence", message: { device_id: fixtureState.device } }, 1_000);
      const serialized = JSON.stringify(report);
      for (const key of Object.values(fixtureState.keys)) expect(serialized).not.toContain(key.toString("hex"));
      expect(serialized).not.toMatch(/token_hash|noise_pk|root_key|operations|scope.*contracts|relay_generation/);
    } finally {
      await binding.close();
    }
  });

  it("reports absent relay owners without inferring online from recent last_seen", async () => {
    const state = await fixture();
    const report = await diagnose(state.user);
    expect(report.collections[0]).toMatchObject({ availability: { state: "unavailable", reason: "device_offline" }, devices: [{ presence: "unreachable", online: false }] });
    expect(report.account_registrations[0]!.last_seen_at).not.toBeNull();
  });

  it("reports confirmed false presence as offline", async () => {
    const state = await fixture();
    const request = vi.fn().mockResolvedValue({ version: 1, ok: true, value: false });
    expect((await diagnose(state.user, [], { request })).collections[0]).toMatchObject({ availability: { reason: "device_offline" }, devices: [{ presence: "responded", serving: false }] });
  });

  it.each([undefined, null, "unsupported", 0, { online: true }])("refuses malformed successful presence %j", async value => {
    const state = await fixture();
    const request = vi.fn().mockResolvedValue({ version: 1, ok: true, value });
    await expect(diagnose(state.user, [], { request })).rejects.toThrow("Relay presence probe failed internally; no availability report was produced.");
  });

  it.each(["The relay broker is disconnected.", "The relay broker returned an invalid response.", "The relay broker request failed."])("refuses broker failure: %s", async message => {
    const state = await fixture();
    const request = vi.fn().mockRejectedValue(new RelayBrokerUnavailableError(message));
    await expect(diagnose(state.user, [], { request })).rejects.toThrow("Relay presence probe failed internally; no availability report was produced.");
  });

  it("keeps the old-running and desktop-update reasons identical to routing", async () => {
    const state = await fixture();
    const request = vi.fn().mockResolvedValue({ version: 1, ok: true, value: true, detail: { old_connector_running: true } });
    expect((await diagnose(state.user, [], { request })).collections[0]!.availability.reason).toBe("old_connector_running");
    await db.query("UPDATE connectors SET incompatibility_code = 'fixture-old', last_incompatible_at = now(), minimum_connector_version = '0.1.0', connector_update_url = 'https://example.test/update' WHERE id = $1", [state.connector]);
    request.mockRejectedValue(new RelayBrokerUnavailableError("No relay owns the current connector session.", { ownerUnavailable: true }));
    expect((await diagnose(state.user, [], { request })).collections[0]!.availability.reason).toBe("desktop_update_required");
  });

  it("never hides an internal broker failure as offline", async () => {
    const state = await fixture();
    await expect(diagnose(state.user, [], { request: vi.fn().mockRejectedValue(new Error("fixture broker failure")) })).rejects.toThrow("fixture broker failure");
  });

  it("refuses internal reply errors without echoing their private details", async () => {
    const state = await fixture();
    const request = vi.fn().mockResolvedValue({ version: 1, ok: false, error: { kind: "internal", code: "relay_delivery_failed", message: "private-fixture-sentinel" } });
    await expect(diagnose(state.user, [], { request })).rejects.toThrow("Relay presence probe failed internally; no availability report was produced.");
  });

  it("does not treat an obsolete-key enrolment as a current serving association", async () => {
    const state = await fixture();
    await db.query("UPDATE next_devices SET noise_pk = $1 WHERE id = $2", [randomBytes(32), state.device]);
    const request = vi.fn();
    expect((await diagnose(state.user, [], { request })).collections[0]).toMatchObject({ devices: [], availability: { reason: "no_device_registered" } });
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["sending", "parked", "lost"])("does not probe an enrolment in a %s batch", async status => {
    const state = await fixture(true);
    if (status === "lost") await db.query("UPDATE next_policy_batches SET lost_at = now() WHERE collection_id = $1 AND seq = 2", [state.collection]);
    else await db.query("UPDATE next_policy_batches SET state = $1 WHERE collection_id = $2 AND seq = 2", [status, state.collection]);
    const request = vi.fn();
    expect((await diagnose(state.user, [], { request })).collections[0]).toMatchObject({ devices: [], availability: { reason: "no_device_registered" } });
    expect(request).not.toHaveBeenCalled();
  });

  it("retains revoked registrations as metadata but never probes them", async () => {
    const state = await fixture();
    await db.query("UPDATE connectors SET revoked_at = now() WHERE id = $1", [state.connector]);
    const request = vi.fn();
    const report = await diagnose(state.user, [], { request });
    expect(report.account_registrations[0]!.revoked_at).not.toBeNull();
    expect(report.collections[0]).toMatchObject({ devices: [], availability: { reason: "no_device_registered" } });
    expect(request).not.toHaveBeenCalled();
  });

  it("excludes policy-revoked enrolments even while the connector is live", async () => {
    const state = await fixture();
    await queueNextPolicy(db, state.collection, [{ op: "device-revoke", device: state.device }]);
    await append(state.collection);
    const request = vi.fn();
    expect((await diagnose(state.user, [], { request })).collections[0]).toMatchObject({ devices: [], availability: { reason: "no_device_registered" } });
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["deleted", "left_sync", "shadow", "membership_removed", "suspended", "cloud_copy"])("explains %s without presence probes", async fault => {
    const state = await fixture();
    if (fault === "deleted") await db.query("INSERT INTO next_collection_deletion_facts(collection_id,deletion_id,lifecycle_epoch,authority) VALUES($1,$2,1,'native-registry')", [state.collection, randomUUID()]);
    if (fault === "left_sync") await db.query("UPDATE next_collections SET left_sync_at = now() WHERE collection_id = $1", [state.collection]);
    if (fault === "shadow") await db.query("UPDATE next_collections SET runtime = 'shadow' WHERE collection_id = $1", [state.collection]);
    if (fault === "suspended") await db.query("UPDATE users SET suspended_at = now() WHERE id = $1", [state.user]);
    if (fault === "cloud_copy") await db.query("UPDATE next_collections SET sync = 'cloud_copy' WHERE collection_id = $1", [state.collection]);
    if (fault === "membership_removed") await queueNextPolicy(db, state.collection, [{ op: "member-remove", account: state.user }]);
    const request = vi.fn();
    const report = await diagnose(state.user, [], { request });
    const expected = fault === "suspended" ? "account_suspended" : fault === "membership_removed" ? "access_removed"
      : fault === "cloud_copy" ? "hosted_replica_not_probed" : "sync_required";
    expect(report.collections[0]!.availability.reason).toBe(expected);
    expect(report.collections[0]!.deleted).toBe(fault === "deleted");
    expect(request).not.toHaveBeenCalled();
  });

  it("excludes another account's collections and registrations, including explicit UUID lookup", async () => {
    const first = await fixture(), other = await fixture();
    const report = await diagnose(first.user);
    expect(report.collections.map(row => row.collection_id)).toEqual([first.collection]);
    expect(report.account_registrations.map(row => row.connector_id)).toEqual([first.connector]);
    await expect(diagnose(first.user, ["--collection", other.collection])).rejects.toThrow("Owned native collection was not found");
  });

  it("pages in stable UUID order and scopes explicit collection selection", async () => {
    const state = await fixture();
    const second = randomUUID();
    await db.query("INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id) VALUES($1,$2,'next','private',$3)", [second, state.user, Buffer.alloc(16)]);
    const ids = [second, state.collection].sort();
    const firstPage = await diagnose(state.user, ["--limit", "1"]);
    expect(firstPage.collections.map(row => row.collection_id)).toEqual(ids.slice(0, 1));
    expect(firstPage.next_cursor).toBe(ids[0]);
    const lastPage = await diagnose(state.user, ["--limit", "1", "--cursor", firstPage.next_cursor!]);
    expect(lastPage.collections.map(row => row.collection_id)).toEqual(ids.slice(1));
    expect(lastPage.next_cursor).toBeNull();
    expect((await diagnose(state.user, ["--collection", state.collection.toUpperCase()])).collections.map(row => row.collection_id)).toEqual([state.collection]);
  });

  it("fails closed when the broker is unconfigured or an inventory is too large", async () => {
    const state = await fixture();
    await expect(runAuthAdminCommand(["collections", "diagnose", "--user", state.user], { db, defaultRegistrationMode: "closed" })).rejects.toThrow("Relay broker is not configured");
    await db.query(`INSERT INTO connectors(id,user_id,name,token_hash)
      SELECT gen_random_uuid(),$1,'Fixture',gen_random_uuid()::text FROM generate_series(1,100)`, [state.user]);
    await expect(diagnose(state.user)).rejects.toThrow("100 registrations");
  });

  it("bounds presence fanout before probing and allows a narrower collection selection", async () => {
    const state = await fixture();
    const enrolments = [{ op: "device-enrol" as const, device: state.device, account: state.user, kind: "desktop" as const, ...state.keys }];
    for (let index = 0; index < 50; index++) {
      const device = randomUUID(), connector = randomUUID();
      const keys = { signPublicKey: randomBytes(32), kemPublicKey: randomBytes(32), noisePublicKey: randomBytes(32) };
      await db.query("INSERT INTO connectors(id,user_id,name,token_hash,relay_generation) VALUES($1,$2,'Fixture',$3,7)", [connector, state.user, randomUUID()]);
      await db.query("INSERT INTO next_devices(id,connector_id,user_id,kind,sign_pk,kem_pk,noise_pk) VALUES($1,$2,$3,'desktop',$4,$5,$6)",
        [device, connector, state.user, keys.signPublicKey, keys.kemPublicKey, keys.noisePublicKey]);
      enrolments.push({ op: "device-enrol", device, account: state.user, kind: "desktop", ...keys });
    }
    await queueNextPolicy(db, state.collection, enrolments.slice(1));
    await append(state.collection);
    const second = randomUUID();
    await db.query("INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id) VALUES($1,$2,'next','private',$3)", [second, state.user, Buffer.alloc(16)]);
    await queueNextPolicy(db, second, [{ op: "member-set", account: state.user, role: "owner" }, ...enrolments]);
    await append(second);
    const request = vi.fn().mockResolvedValue({ version: 1, ok: true, value: false });
    await expect(diagnose(state.user, [], { request })).rejects.toThrow("100 presence probes");
    expect(request).not.toHaveBeenCalled();
    expect((await diagnose(state.user, ["--collection", second], { request })).collections).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(51);
  });

  it("uses a database-enforced read-only snapshot and leaves persistent state unchanged", async () => {
    const state = await fixture();
    const connection = await db.connect();
    const before = await db.query("SELECT row_to_json(n) AS value FROM next_collections n WHERE collection_id = $1", [state.collection]);
    let readOnly = false;
    const query = vi.fn(async (text: string, values?: unknown[]) => {
      const result = await connection.query(text, values);
      if (text.startsWith("BEGIN")) readOnly = (await connection.query("SHOW transaction_read_only")).rows[0]!.transaction_read_only === "on";
      return result;
    });
    await runAuthAdminCommand(["collections", "diagnose", "--user", state.user], {
      db: { ...db, connect: async () => ({ query: query as typeof connection.query, release: () => connection.release() }) },
      defaultRegistrationMode: "closed", relayBroker: broker
    });
    expect(readOnly).toBe(true);
    expect(query.mock.calls.every(([text]) => /^(BEGIN|COMMIT|SELECT|WITH)/.test(text))).toBe(true);
    expect((await db.query("SELECT row_to_json(n) AS value FROM next_collections n WHERE collection_id = $1", [state.collection])).rows).toEqual(before.rows);
  });
});
