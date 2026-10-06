import { generateKeyPairSync, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { localGrantFixture } from "./next-fixtures.test-helper.js";
import { currentNextNoiseAuthorization } from "./consent-transport.js";

const url = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = url && approved ? describe : describe.skip;
const noise = () => generateKeyPairSync("x25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32);

describePg("retained Noise consent tuple (dedicated PostgreSQL, not native enrollment)", () => {
  let db: DatabasePool; let admin: pg.Pool; let schema: string;
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) || !/test/i.test(parsed.pathname)) throw new Error("Dedicated local test PostgreSQL required.");
    schema = `noise_consent_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: parsed.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    parsed.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(parsed.toString());
  }, 60_000);
  afterAll(async () => {
    await db?.end(); if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin?.end();
  }, 60_000);
  async function fixture() {
    const id = await localGrantFixture(db); const pk = noise(); const device = randomUUID();
    await db.query("UPDATE users SET account_backend = 'next' WHERE id = $1", [id]);
    // Deliberate isolated DB fixture: this does not qualify device-enrollment PoP.
    await db.query("INSERT INTO next_devices(id,connector_id,user_id,kind,sign_pk,kem_pk,noise_pk) VALUES($1,$2,$2,'desktop',$3,$4,$5)", [device, id, Buffer.alloc(32, 7), noise(), pk]);
    const descriptor = { protocol_version: 1 as const, connector_id: id, device_id: device, collection_id: id, device_noise_pk: pk.toString("hex") };
    await db.query("UPDATE grants SET next_noise = $2::jsonb WHERE id = $1", [id, JSON.stringify(descriptor)]);
    return { id, device, descriptor };
  }
  it("returns the exact approved tuple while all dependencies remain current", async () => {
    const f = await fixture(); expect(await currentNextNoiseAuthorization(db, f.descriptor, f.id, f.id)).toEqual(f.descriptor);
  });
  it("never reconstructs a grant after its device was deleted and replaced", async () => {
    const f = await fixture(); await db.query("DELETE FROM next_devices WHERE id = $1", [f.device]);
    expect((await db.query("SELECT next_noise FROM grants WHERE id = $1", [f.id])).rows[0].next_noise).toEqual(f.descriptor);
    await expect(currentNextNoiseAuthorization(db, f.descriptor, f.id, f.id)).rejects.toThrow();
    await db.query("INSERT INTO next_devices(id,connector_id,user_id,kind,sign_pk,kem_pk,noise_pk) VALUES($1,$2,$2,'desktop',$3,$4,$5)", [f.device, f.id, Buffer.alloc(32, 7), noise(), noise()]);
    await expect(currentNextNoiseAuthorization(db, f.descriptor, f.id, f.id)).rejects.toThrow();
  });
  it.each(["legacy", "suspended", "revoked", "foreign-account", "foreign-collection"])("denies %s rather than a legacy fallback", async (state) => {
    const f = await fixture();
    if (state === "legacy") await db.query("UPDATE users SET account_backend = 'legacy' WHERE id = $1", [f.id]);
    if (state === "suspended") await db.query("UPDATE users SET suspended_at = now() WHERE id = $1", [f.id]);
    if (state === "revoked") await db.query("UPDATE connectors SET revoked_at = now() WHERE id = $1", [f.id]);
    await expect(currentNextNoiseAuthorization(db, f.descriptor, state === "foreign-account" ? randomUUID() : f.id,
      state === "foreign-collection" ? randomUUID() : f.id)).rejects.toThrow();
  });
  it("forbids a mixed legacy encryption and persisted Noise mode", async () => {
    const f = await fixture(); await expect(db.query("UPDATE grants SET encryption = '{}'::jsonb WHERE id = $1", [f.id])).rejects.toThrow();
    await expect(db.query("UPDATE grants SET next_noise = 'null'::jsonb WHERE id = $1", [f.id])).rejects.toThrow();
  });
});
