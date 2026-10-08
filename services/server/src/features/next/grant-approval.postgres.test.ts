import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import { approvalAllowsOperation, clientKeyDigest, grantApprovalReportDigest, grantDeviceApproval, reportGrantApproval } from "./grant-approval.js";
import { localGrantFixture } from "./next-fixtures.test-helper.js";
import { ed25519RawPublicKey } from "./policy-keys.js";
import { encodeCbor, uuidBytes } from "./policy-wire.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePostgres = testUrl && approved ? describe : describe.skip;

/** A log holding control items by position, as `read` with `kinds = control` would return them. */
function fakeLog(items: Map<number, Uint8Array>) {
  return { controlItemAt: async (_collection: string, seq: number) => items.get(seq) ?? null };
}

function approvalItem(collection: string, signer: string, kind = 6) {
  return encodeCbor({ struct: [[0, 1], [1, kind], [2, uuidBytes(collection)], [3, 9], [4, randomBytes(32)], [5, 1], [6, uuidBytes(signer)], [7, randomBytes(16)], [11, randomBytes(40)], [12, randomBytes(64)]] });
}

describePostgres("device approvals of private grants", () => {
  let admin: pg.Pool;
  let db: DatabasePool;
  let schema: string;

  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) throw new Error("Approval tests require a dedicated local test database.");
    schema = `mdbase_next_approval_test_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
  }, 60_000);

  afterAll(async () => {
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  }, 60_000);

  const READ = ["describe", "changes", "read", "query", "list_views", "execute_view", "read_view_source", "validate", "read_type"];
  const SCHEDULE = ["list_timers", "put_timer", "cancel_timer", "reconcile_timers"];

  async function privateGrant() {
    const id = await localGrantFixture(db);
    const clientPk = randomBytes(32);
    await db.query(`UPDATE grants SET activated_at = now(), operations = $2,
      application_authorization = jsonb_set(application_authorization, '{binding,contracts,semantic_capabilities}', '2') WHERE id = $1`,
      [id, JSON.stringify([...READ, ...SCHEDULE])]);
    await db.query("INSERT INTO next_grant_client_keys(grant_id, client_pk) VALUES($1,$2)", [id, clientPk]);
    await db.query("INSERT INTO next_collections(collection_id, owner_user_id, runtime, sync, root_key_id) VALUES($1,$2,'next','private',$3)", [id, id, Buffer.alloc(16)]);
    // This fixture represents a published immutable log grant, not just SQL intent.
    await db.query("INSERT INTO next_grant_bindings(grant_id,collection_id,log_grant_id,terms_digest) VALUES($1,$1,$1,$2)", [id, Buffer.alloc(32)]);
    const { privateKey } = generateKeyPairSync("ed25519");
    const device = randomUUID();
    await db.query("INSERT INTO next_devices(id, connector_id, user_id, kind, sign_pk, kem_pk, noise_pk) VALUES($1,$2,$3,'desktop',$4,$5,$6)",
      [device, id, id, Buffer.from(ed25519RawPublicKey(privateKey)), randomBytes(32), randomBytes(32)]);
    const clientFp = clientKeyDigest(clientPk);
    const report = (seq: number, capabilities: string[] = ["collection.read"], key = privateKey, fp: Uint8Array = clientFp) => ({
      device_id: device, seq, capabilities, client_fp: Buffer.from(fp).toString("hex"),
      sig: Buffer.from(sign(null, grantApprovalReportDigest(id, id, seq, capabilities, fp), key)).toString("hex")
    });
    return { id, device, report };
  }

  it("makes a private grant usable only after a verified device approval", async () => {
    const { id, device, report } = await privateGrant();
    expect(await grantDeviceApproval(db, id)).toEqual({ required: true, approved: false, capabilities: null });
    const log = fakeLog(new Map([[9, approvalItem(id, device)], [10, approvalItem(id, randomUUID())], [11, approvalItem(id, device, 2)]]));
    const connector = { id };
    await expect(reportGrantApproval(db, log, connector, id, report(10))).rejects.toMatchObject({ code: "approval_not_in_log" });
    await expect(reportGrantApproval(db, log, connector, id, report(11))).rejects.toMatchObject({ code: "approval_not_in_log" });
    await expect(reportGrantApproval(db, log, connector, id, report(12))).rejects.toMatchObject({ code: "approval_not_in_log" });
    await expect(reportGrantApproval(db, log, connector, id, report(9, undefined, generateKeyPairSync("ed25519").privateKey))).rejects.toMatchObject({ code: "invalid_signature" });
    await expect(reportGrantApproval(db, log, connector, id, report(9, undefined, undefined, randomBytes(32)))).rejects.toMatchObject({ code: "client_key_mismatch" });
    await expect(reportGrantApproval(db, log, connector, id, report(9, ["records.edit"]))).rejects.toMatchObject({ code: "capabilities_not_offered" });
    await expect(reportGrantApproval(db, log, { id: randomUUID() }, id, report(9))).rejects.toMatchObject({ code: "device_not_allowed" });
    expect(await grantDeviceApproval(db, id)).toEqual({ required: true, approved: false, capabilities: null });

    // The user approved read-only although the grant asked for scheduling too.
    expect(await reportGrantApproval(db, log, connector, id, report(9))).toEqual({ grant_id: id, approved_seq: 9, capabilities: ["collection.read"] });
    const approval = await grantDeviceApproval(db, id);
    expect(approval).toEqual({ required: true, approved: true, capabilities: ["collection.read"] });
    expect(approvalAllowsOperation(approval, "read")).toBe(true);
    expect(approvalAllowsOperation(approval, "put_timer")).toBe(false);

    await db.query("UPDATE connectors SET revoked_at = now() WHERE id = $1", [id]);
    expect(await grantDeviceApproval(db, id)).toMatchObject({ approved: false });
  });

  it("needs no approval outside private collections, and refuses reports there", async () => {
    const id = await localGrantFixture(db);
    await db.query("UPDATE grants SET activated_at = now() WHERE id = $1", [id]);
    const unrequired = await grantDeviceApproval(db, id);
    expect(unrequired).toEqual({ required: false, approved: false, capabilities: null });
    expect(approvalAllowsOperation(unrequired, "put_timer")).toBe(true);
    await expect(reportGrantApproval(db, fakeLog(new Map()), { id }, id, { device_id: randomUUID(), seq: 1, capabilities: ["collection.read"], client_fp: "00".repeat(32), sig: "00".repeat(64) }))
      .rejects.toMatchObject({ code: "approval_not_required" });
  });

  it("stops counting an approval once the grant is revoked", async () => {
    const { id, device, report } = await privateGrant();
    await reportGrantApproval(db, fakeLog(new Map([[9, approvalItem(id, device)]])), { id }, id, report(9));
    await db.query("UPDATE grants SET revoked_at = now() WHERE id = $1", [id]);
    expect(await grantDeviceApproval(db, id)).toMatchObject({ approved: false });
  });

  it("keeps the earliest approval in log order and binds it to the grant's terms (SEC-046)", async () => {
    const { id, device, report } = await privateGrant();
    const log = fakeLog(new Map([[20, approvalItem(id, device)], [15, approvalItem(id, device)], [30, approvalItem(id, device)]]));
    await reportGrantApproval(db, log, { id }, id, report(20));
    expect((await reportGrantApproval(db, log, { id }, id, report(30, ["collection.read", "background.schedule"]))).approved_seq).toBe(20);
    expect((await grantDeviceApproval(db, id)).capabilities).toEqual(["collection.read"]);
    expect(await reportGrantApproval(db, log, { id }, id, report(15, ["background.schedule", "collection.read"])))
      .toEqual({ grant_id: id, approved_seq: 15, capabilities: ["background.schedule", "collection.read"] });

    // Connect re-issues the grant under the same ID with wider terms: not approved until a new report.
    await db.query("UPDATE grants SET operations = operations || '[\"create\"]'::jsonb WHERE id = $1", [id]);
    expect(await grantDeviceApproval(db, id)).toMatchObject({ approved: false });
    expect((await reportGrantApproval(db, log, { id }, id, report(30))).approved_seq).toBe(30);
    expect(await grantDeviceApproval(db, id)).toEqual({ required: true, approved: true, capabilities: ["collection.read"] });
  });
});
