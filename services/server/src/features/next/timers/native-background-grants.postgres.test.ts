import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MDBASE_TIMER_FIRED_CONTRACT } from "@mdbase-dev/connect-protocol";
import { openDatabase, type DatabasePool } from "../../../db.js";
import { runControlPlaneMigrations } from "../../../migrations.js";
import { tokenHash } from "../../../security.js";
import { PushTargetSealer } from "../push-target-seal.js";
import { installationApp, inspectInstallationPairing, startInstallationPairing } from "../../connectors/installation-pairing.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;
const migrations = new URL("../../../../migrations/", import.meta.url);
const migrationId = "0069_native_background_grants";
const criterion = { id: "synthetic.reminder", event: MDBASE_TIMER_FIRED_CONTRACT, presentation: { title: "Reminder" } };
const inventoryTables = ["grants", "next_timers", "next_timer_events", "next_timer_event_receipts",
  "next_timer_namespace_intents", "next_timer_operation_receipts", "push_channels", "notification_subscriptions",
  "notification_signals", "notification_deliveries", "notification_webhook_deliveries"] as const;
const children = ["next_timers", "next_timer_events", "next_timer_namespace_intents", "push_channels",
  "notification_subscriptions", "notification_signals"] as const;

suite("background grant migration (real PG; synthetic production-shaped data, not consent authority)", () => {
  let admin: pg.Pool, db: DatabasePool, beforeDirectory: string;
  const schemas: string[] = [];
  const seal = new PushTargetSealer({ keyId: "synthetic", key: Buffer.alloc(32, 42), previousKeys: {} });
  const grants: string[] = [];
  const targets: Array<{ grant: string; installation: string; sealed: string; token: string }> = [];
  let user: string, application: string, collection: string;
  const historical = { request_id: randomUUID(), pairing_secret: randomBytes(32).toString("hex"), installation_id: randomUUID(), device_id: randomUUID(), kind: "app-runtime" as const };

  async function predecessor(): Promise<DatabasePool> {
    const schema = `native_background_${randomUUID().replaceAll("-", "")}`;
    schemas.push(schema);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(testUrl!);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    const result = await openDatabase(url.toString());
    try {
      await runControlPlaneMigrations(result, { directory: beforeDirectory, lock: true, isolatedTestSchema: true });
      return result;
    } catch (error) { await result.end(); throw error; }
  }
  async function upgrade(pool: DatabasePool): Promise<void> {
    await runControlPlaneMigrations(pool, { lock: true, isolatedTestSchema: true });
  }
  async function inventory(pool: DatabasePool) {
    const rows: Record<string, unknown[]> = {};
    for (const table of inventoryTables) {
      rows[table] = (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows.map(row => row.row);
    }
    return rows;
  }

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
      throw new Error("Dedicated local test PostgreSQL required");
    }
    const target = new URL("../../../../../../target/", import.meta.url);
    await mkdir(target, { recursive: true });
    beforeDirectory = await mkdtemp(fileURLToPath(new URL("native-timer-predecessor-", target)));
    for (const name of await readdir(migrations)) {
      if (name.endsWith(".sql") && name !== `${migrationId}.sql`) {
        await copyFile(new URL(name, migrations), `${beforeDirectory}/${name}`);
      }
    }
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    db = await predecessor();
    user = randomUUID(); application = randomUUID(); collection = randomUUID();
    const connector = randomUUID();
    await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Synthetic migration')", [user, `${user}@example.test`]);
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'Synthetic device',$3)", [connector, user, randomUUID()]);
    await db.query("INSERT INTO collections(id,user_id,connector_id,local_id,display_name,spec_version,enabled) VALUES($1,$2,$3,$4,'Synthetic','0.3.0',true)", [collection, user, connector, randomUUID()]);
    await db.query(`INSERT INTO applications(id,canonical_identity,manifest_version,name,homepage,redirect_uris,notifications)
      VALUES($1,$2,1,'Synthetic reminders','https://reminders.example.test','[]'::jsonb,$3::jsonb)`,
    [application, `bundle:synthetic:${application}`, JSON.stringify({ criteria: [criterion] })]);

    for (let i = 0; i < 48; i += 1) {
      const grant = randomUUID(), channel = randomUUID(), subscription = randomUUID(), signal = randomUUID();
      const installation = randomUUID(), token = `synthetic-token-${i}`, sealed = seal.seal(grant, installation, { fcm_token: token });
      grants.push(grant); targets.push({ grant, installation, sealed, token });
      await db.query(`INSERT INTO grants(id,user_id,application_id,collection_id,operations,notification_criteria,
        application_origin,application_authorization,application_installation_id)
        VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,'https://reminders.example.test','{"binding":{"protocol_version":4}}'::jsonb,$7)`,
      [grant, user, application, collection, JSON.stringify(["list_timers", "put_timer", "cancel_timer", "reconcile_timers"]), JSON.stringify([criterion]), installation]);
      await db.query("INSERT INTO next_timer_namespace_intents(grant_id,namespace,intent_revision) VALUES($1,'reminders',$2)", [grant, 100 + i]);
      for (const [j, status] of ["scheduled", "firing", "fired", "cancelled"].entries()) {
        await db.query(`INSERT INTO next_timers(grant_id,namespace,timer_id,criterion_id,fire_at,generation,status,fired_at)
          VALUES($1,'reminders',$2,$3,now()+interval '1 hour',$4,$5,CASE WHEN $5='fired' THEN now() ELSE NULL END)`,
        [grant, `synthetic-${j}`, criterion.id, 7 + i + j, status]);
      }
      const event = `synthetic-event-${i}`;
      await db.query(`INSERT INTO next_timer_events(event_id,grant_id,criterion_id,namespace,timer_id,generation,scheduled_for,fired_at,late_by_ms)
        VALUES($1,$2,$3,'reminders','synthetic-2',$4,now()-interval '1 minute',now(),60000)`, [event, grant, criterion.id, 9 + i]);
      await db.query("INSERT INTO next_timer_event_receipts(consumer,event_id) VALUES('notifications',$1)", [event]);
      await db.query(`INSERT INTO next_timer_operation_receipts(grant_id,operation_id,namespace,request_digest,terms_digest,
        expected_revision,committed_revision,result_metadata) VALUES($1,$2,'reminders',$3,$4,$5,$6,$7::jsonb)`,
      [grant, randomUUID(), Buffer.alloc(32, i), Buffer.alloc(32, i + 1), 99 + i, 100 + i,
        JSON.stringify({ namespace: "reminders", timers: [], cancelled_ids: [`synthetic-cancelled-${i}`] })]);
      await db.query(`INSERT INTO push_channels(id,grant_id,installation_id,kind,fcm_project_id,fcm_token_hash,sealed_target,sealed_key_id)
        VALUES($1,$2,$3,'fcm','synthetic-project',$4,$5,'synthetic')`, [channel, grant, installation, `synthetic-hash-${i}`, sealed]);
      await db.query("INSERT INTO notification_subscriptions(id,grant_id,channel_id,criterion_id) VALUES($1,$2,$3,$4)", [subscription, grant, channel, criterion.id]);
      await db.query("INSERT INTO notification_signals(id,signal_id,grant_id,criterion_id,cursor) VALUES($1,$2,$3,$4,$2)", [signal, event, grant, criterion.id]);
      await db.query(`INSERT INTO notification_deliveries(id,signal_id,subscription_id,status,attempts,lease_token,leased_until)
        VALUES($1,$2,$3,'sending',$4,$5,now()+interval '30 seconds')`, [randomUUID(), signal, subscription, i, randomUUID()]);
      await db.query("INSERT INTO notification_webhook_deliveries(id,signal_id,url,status,attempts) VALUES($1,$2,'https://hooks.example.test','retry',$3)", [randomUUID(), signal, i]);
    }
    // An actual predecessor consumed request has no timer snapshot or permission.
    await db.query(`INSERT INTO pairing_requests(id,secret_hash,connector_name,user_id,expires_at,approved_at,consumed_at)
      VALUES($1,$2,'Synthetic old request',$3,now()-interval '1 hour',now()-interval '2 hours',now()-interval '2 hours')`,
    [historical.request_id, tokenHash(historical.pairing_secret), user]);
    await db.query(`INSERT INTO installation_device_pairings(pairing_id,installation_id,device_id,connector_id,app_id,app_origin,kind,challenge)
      VALUES($1,$2,$3,$4,$5,'https://reminders.example.test','app-runtime',$6)`,
    [historical.request_id, historical.installation_id, historical.device_id, randomUUID(), application, randomBytes(32)]);
    // A production-shaped predecessor need not use the generated FK spelling.
    await db.query("ALTER TABLE push_channels RENAME CONSTRAINT push_channels_grant_id_fkey TO synthetic_historical_channel_fk");
  }, 60_000);

  afterAll(async () => {
    await db?.end();
    if (admin) for (const schema of schemas) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
    if (beforeDirectory) await rm(beforeDirectory, { recursive: true, force: true });
  });

  it("upgrades the actual predecessor with exact row counts, generations, revisions, receipt bytes and sealed targets", async () => {
    const predecessorId = "0068_next_service_claim_challenges";
    const predecessorBytes = await readFile(new URL(`${predecessorId}.sql`, migrations));
    expect((await db.query("SELECT checksum FROM schema_migrations WHERE id=$1", [predecessorId])).rows)
      .toEqual([{ checksum: createHash("sha256").update(predecessorBytes).digest("hex") }]);
    const before = await inventory(db);
    expect(before.grants).toHaveLength(48); expect(before.next_timers).toHaveLength(192);
    for (const table of inventoryTables.filter(table => table !== "next_timers")) expect(before[table]).toHaveLength(48);
    expect((await db.query("SELECT to_regclass('next_background_grants') AS relation")).rows[0].relation).toBeNull();
    await upgrade(db);
    expect(await inventory(db)).toEqual(before);
    expect((await db.query("SELECT id,legacy_grant_id,principal_kind FROM next_background_grants ORDER BY id")).rows)
      .toEqual([...grants].sort().map(id => ({ id, legacy_grant_id: id, principal_kind: "legacy" })));
    const foreignKeys = (await db.query(`SELECT conrelid::regclass::text AS child FROM pg_constraint
      WHERE contype='f' AND confrelid='next_background_grants'::regclass ORDER BY child`)).rows;
    expect(foreignKeys.map(row => row.child)).toEqual([...children].sort());
    for (const target of targets) {
      const saved = (await db.query("SELECT sealed_target FROM push_channels WHERE grant_id=$1", [target.grant])).rows[0].sealed_target;
      expect(saved).toBe(target.sealed);
      expect(seal.open(target.grant, target.installation, saved).fcm_token).toBe(target.token);
    }
    await upgrade(db);
    expect(await inventory(db)).toEqual(before);
  });

  it("preserves raw legacy INSERT and DELETE cascades after repointing", async () => {
    const grant = randomUUID();
    await db.query(`INSERT INTO grants(id,user_id,application_id,collection_id,operations,application_authorization,application_installation_id)
      VALUES($1,$2,$3,$4,'[]'::jsonb,'{"binding":{"protocol_version":4}}'::jsonb,$5)`, [grant, user, application, collection, randomUUID()]);
    expect((await db.query("SELECT id,principal_kind,legacy_grant_id FROM next_background_grants WHERE id=$1", [grant])).rows[0])
      .toEqual({ id: grant, principal_kind: "legacy", legacy_grant_id: grant });
    await db.query("INSERT INTO next_timers(grant_id,namespace,timer_id,criterion_id,fire_at) VALUES($1,'raw','one',$2,now())", [grant, criterion.id]);
    await db.query("DELETE FROM grants WHERE id=$1", [grant]);
    expect((await db.query("SELECT 1 FROM next_background_grants WHERE id=$1", [grant])).rowCount).toBe(0);
    expect((await db.query("SELECT 1 FROM next_timers WHERE grant_id=$1", [grant])).rowCount).toBe(0);
    await db.query("DELETE FROM grants WHERE id=$1", [grants[0]]);
    const after = await inventory(db);
    for (const table of inventoryTables) expect(after[table]).toHaveLength(table === "next_timers" ? 188 : 47);
    expect((await db.query("SELECT count(*)::integer AS n FROM next_background_grants")).rows[0].n).toBe(47);
  });

  it("rolls back an incomplete predecessor's failed migration without partial new schema or ledger admission", async () => {
    const other = await predecessor();
    try {
      // Copy only this suite's synthetic predecessor-shaped graph, including
      // in-flight rows and bytea values. No production reads or native relabeling.
      for (const table of ["users", "connectors", "collections", "applications", ...inventoryTables]) {
        const rows = (await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t`)).rows.map(row => row.row);
        await other.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table},$1::jsonb) ON CONFLICT DO NOTHING`, [JSON.stringify(rows)]);
      }
      await other.query("ALTER TABLE next_timer_events DROP CONSTRAINT next_timer_events_grant_id_fkey");
      const before = await inventory(other);
      expect(before.grants.length).toBeGreaterThan(0);
      expect(before.next_timers.length).toBe(before.grants.length * 4);
      await expect(upgrade(other)).rejects.toThrow("Expected one original background grant foreign key");
      expect(await inventory(other)).toEqual(before);
      expect((await other.query("SELECT to_regclass('next_background_grants') AS relation")).rows[0].relation).toBeNull();
      expect((await other.query("SELECT 1 FROM schema_migrations WHERE id=$1", [migrationId])).rowCount).toBe(0);
      expect((await other.query("SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='installation_device_pairings' AND column_name='timer_consent'")).rowCount).toBe(0);
    } finally { await other.end(); }
  });

  it("freezes the actual registry declaration on the original request without fabricating approval on retry or historical rows", async () => {
    const origin = "https://reminders.example.test";
    await db.query(`UPDATE applications SET family_identity='bundle:synthetic.reminders',
      installation_origins=$2::jsonb,requirements=$3::jsonb WHERE id=$1`, [application,
      JSON.stringify({ lab: { "app-runtime": [origin] } }),
      JSON.stringify({ contracts: [], access: "full_collection", capabilities: { contract_version: 2, required: ["collection.read"], optional: ["background.schedule"] } })]);
    const originalApp = await installationApp(db, "lab", application, origin, "app-runtime");
    expect(originalApp.timerDeclaration?.operations).toHaveLength(4);
    const input = { request_id: randomUUID(), pairing_secret: randomBytes(32).toString("hex"), installation_id: randomUUID(), device_id: randomUUID(), kind: "app-runtime" as const };
    await startInstallationPairing(db, input, originalApp, "https://connect.example.test");
    const before = (await db.query("SELECT timer_declaration,timer_consent FROM installation_device_pairings WHERE pairing_id=$1", [input.request_id])).rows[0];
    expect(before).toEqual({ timer_declaration: originalApp.timerDeclaration, timer_consent: null });
    expect((await inspectInstallationPairing(db, input.request_id, user, false, `${user}@example.test`)).pairing.timer_declaration).toEqual(before.timer_declaration);
    const changed = { criteria: [{ ...criterion, presentation: { title: "Changed reminder" } }] };
    await db.query("UPDATE applications SET notifications=$2::jsonb WHERE id=$1", [application, JSON.stringify(changed)]);
    const currentApp = await installationApp(db, "lab", application, origin, "app-runtime");
    expect(currentApp.timerDeclaration?.digest).not.toBe(originalApp.timerDeclaration?.digest);
    await startInstallationPairing(db, input, currentApp, "https://connect.example.test");
    expect((await db.query("SELECT timer_declaration,timer_consent FROM installation_device_pairings WHERE pairing_id=$1", [input.request_id])).rows[0]).toEqual(before);
    expect((await db.query("SELECT 1 FROM next_background_grants WHERE approval_request_id=$1", [input.request_id])).rowCount).toBe(0);
    await expect(db.query("UPDATE installation_device_pairings SET timer_declaration=NULL WHERE pairing_id=$1", [input.request_id])).rejects.toThrow(/immutable/);
    await db.query("UPDATE installation_device_pairings SET timer_consent=false WHERE pairing_id=$1", [input.request_id]);
    await expect(db.query("UPDATE installation_device_pairings SET timer_consent=true WHERE pairing_id=$1", [input.request_id])).rejects.toThrow(/immutable/);
    // The real pre-migration consumed row stays absent on identical terminal replay.
    await startInstallationPairing(db, historical, currentApp, "https://connect.example.test");
    expect((await db.query("SELECT timer_declaration,timer_consent FROM installation_device_pairings WHERE pairing_id=$1", [historical.request_id])).rows[0])
      .toEqual({ timer_declaration: null, timer_consent: null });
    await expect(db.query("UPDATE installation_device_pairings SET timer_declaration=$2::jsonb,timer_consent=true WHERE pairing_id=$1", [historical.request_id, JSON.stringify(currentApp.timerDeclaration)]))
      .rejects.toThrow(/immutable/);
  });

  async function nativeFixture() {
    const connector = randomUUID(), device = randomUUID(), installation = randomUUID(), nativeCollection = randomUUID();
    const keys = [randomBytes(32), randomBytes(32), randomBytes(32)];
    await db.query("INSERT INTO connectors(id,user_id,name,token_hash) VALUES($1,$2,'Synthetic native',$3)", [connector, user, randomUUID()]);
    await db.query("INSERT INTO next_devices(id,connector_id,user_id,kind,sign_pk,kem_pk,noise_pk) VALUES($1,$2,$3,'app-runtime',$4,$5,$6)", [device, connector, user, ...keys]);
    await db.query(`INSERT INTO installation_device_credentials(pairing_id,connector_id,device_id,installation_id,app_id,app_origin,kind,sign_pk,kem_pk,noise_pk,token_hash)
      VALUES($1,$2,$3,$4,$5,'https://reminders.example.test','app-runtime',$6,$7,$8,$9)`, [randomUUID(), connector, device, installation, application, ...keys, randomUUID()]);
    await db.query("INSERT INTO next_collections(collection_id,owner_user_id,runtime,sync,root_key_id) VALUES($1,$2,'next','private',$3)", [nativeCollection, user, randomBytes(16)]);
    await db.query("INSERT INTO installation_collection_scopes(connector_id,collection_id) VALUES($1,$2)", [connector, nativeCollection]);
    const id = randomUUID();
    await db.query(`INSERT INTO next_background_grants(id,principal_kind,native_connector_id,installation_id,device_id,device_kind,
      sign_pk,kem_pk,noise_pk,user_id,application_id,collection_id,approval_request_id,timer_declaration,approved_at)
      VALUES($1,'installation',$2,$3,$4,'app-runtime',$5,$6,$7,$8,$9,$10,$11,$12::jsonb,now())`,
    [id, connector, installation, device, ...keys, user, application, nativeCollection, randomUUID(), JSON.stringify({ operations: ["reconcile_timers"], criteria: [criterion] })]);
    return { id, connector, collection: nativeCollection, keys };
  }

  it("keeps native identities exclusive and immutable, bound to the original three registered keys", async () => {
    const f = await nativeFixture();
    await db.query("INSERT INTO next_timers(grant_id,namespace,timer_id,criterion_id,fire_at) VALUES($1,'native','one',$2,now())", [f.id, criterion.id]);
    await expect(db.query("UPDATE next_background_grants SET legacy_grant_id=$2 WHERE id=$1", [f.id, grants[1]])).rejects.toThrow(/immutable/);
    await expect(db.query("UPDATE next_background_grants SET collection_id=$2 WHERE id=$1", [f.id, randomUUID()])).rejects.toThrow(/immutable/);
    await expect(db.query("UPDATE installation_device_credentials SET sign_pk=$2 WHERE connector_id=$1", [f.connector, randomBytes(32)])).rejects.toThrow(/foreign key/);
    expect((await db.query("SELECT 1 FROM grants WHERE id=$1", [f.id])).rowCount).toBe(0);
    // Reverting to legacy-only FKs would discard/unrepresent these native IDs.
    expect((await db.query("SELECT EXISTS(SELECT 1 FROM next_background_grants WHERE principal_kind='installation') AS unsafe_downgrade")).rows[0].unsafe_downgrade).toBe(true);
    await expect(db.query("ALTER TABLE next_timers ADD CONSTRAINT synthetic_unsafe_down_fk FOREIGN KEY(grant_id) REFERENCES grants(id) ON DELETE CASCADE"))
      .rejects.toThrow(/foreign key/);
    expect((await db.query("SELECT 1 FROM next_timers WHERE grant_id=$1", [f.id])).rowCount).toBe(1);
  });

  it("permanently revokes native consent with connector revocation or exact scope removal", async () => {
    const connector = await nativeFixture(), scope = await nativeFixture();
    await db.query("UPDATE connectors SET revoked_at=now() WHERE id=$1", [connector.connector]);
    await db.query("DELETE FROM installation_collection_scopes WHERE connector_id=$1 AND collection_id=$2", [scope.connector, scope.collection]);
    for (const f of [connector, scope]) {
      expect((await db.query("SELECT revoked_at FROM next_background_grants WHERE id=$1", [f.id])).rows[0].revoked_at).toBeInstanceOf(Date);
      await expect(db.query("UPDATE next_background_grants SET revoked_at=NULL WHERE id=$1", [f.id])).rejects.toThrow(/permanent/);
    }
    await db.query("INSERT INTO installation_collection_scopes(connector_id,collection_id) VALUES($1,$2)", [scope.connector, scope.collection]);
    expect((await db.query("SELECT revoked_at FROM next_background_grants WHERE id=$1", [scope.id])).rows[0].revoked_at).toBeInstanceOf(Date);
  });
});
