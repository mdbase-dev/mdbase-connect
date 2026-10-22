import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, type DatabasePool } from "../../db.js";
import { AuthenticationPolicyStore } from "../../authentication-policy.js";
import { PasswordAccountService } from "../../password-auth.js";
import { runControlPlaneMigrations } from "../../migrations.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePg = testUrl && approved ? describe : describe.skip;

describePg("staging fixture invitation forward migration", () => {
  let db: DatabasePool, admin: pg.Pool, schema: string, baseline: string;
  const migration = "0084_staging_fixture_invitation_backend";
  const options = { lock: true, isolatedTestSchema: true };
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/test/i.test(url.pathname)) {
      throw Error("Requires dedicated local test Postgres.");
    }
    schema = `seed_invitation_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await openDatabase(url.toString());
    const root = resolve(".artifacts/tests"); await mkdir(root, { recursive: true });
    baseline = await mkdtemp(join(root, "seed-invitation-migrations-"));
    const directory = resolve(import.meta.dirname, "../../../migrations");
    for (const file of await readdir(directory)) {
      if (file.endsWith(".sql") && file !== `${migration}.sql`) await copyFile(join(directory, file), join(baseline, file));
    }
    await runControlPlaneMigrations(db, { ...options, directory: baseline });
  }, 60_000);
  afterAll(async () => {
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
    if (baseline) await rm(baseline, { recursive: true, force: true });
  });

  it("preserves existing invitations/checksums and extends only the reserved-domain constraint", async () => {
    const policy = new AuthenticationPolicyStore(db, "closed");
    await policy.update({ registrationMode: "invite", passwordAuthEnabled: true, emailDeliveryEnabled: false,
      termsVersion: "terms-test", privacyVersion: "privacy-test", expectedRevision: 0,
      updatedBy: "operator:test", reason: "Isolated staging fixture test" });
    const lab = new PasswordAccountService(db, policy, "next", "lab");
    const input = { email: "fixture@staging.invalid", actor: "operator:test", reason: "[test] staging fixture",
      entitlementProfile: null, accountBackend: "legacy" as const };
    const existing = await lab.createInvitation({ ...input, email: "fixture@lab.invalid" });
    const original = (await db.query("SELECT * FROM invitations WHERE id=$1", [existing.id])).rows;
    const ledger = async () => (await db.query("SELECT id,checksum,applied_at FROM schema_migrations ORDER BY id")).rows;
    const before = await ledger();
    const insertStagingFixture = () => db.query(`INSERT INTO invitations
      (id,email,normalized_email,token_hash,created_by,terms_version,privacy_version,expires_at,account_backend)
      SELECT $1,$2,$2,$3,created_by,terms_version,privacy_version,expires_at,'legacy'
      FROM invitations WHERE id=$4 RETURNING normalized_email,account_backend`,
    [randomUUID(), input.email, randomUUID(), existing.id]);
    await expect(insertStagingFixture()).rejects.toMatchObject({ code: "23514" });
    await runControlPlaneMigrations(db, options);
    const after = await ledger();
    expect(after.filter(row => row.id !== migration)).toEqual(before);
    expect(after.filter(row => row.id === migration)).toHaveLength(1);
    expect((await db.query("SELECT * FROM invitations WHERE id=$1", [existing.id])).rows).toEqual(original);
    expect((await insertStagingFixture()).rows)
      .toEqual([{ normalized_email: input.email, account_backend: "legacy" }]);
    expect((await db.query("SELECT id FROM users")).rows).toEqual([]);
    for (const [email, backend] of [["fixture@example.test", "legacy"], ["fixture@staging.invalid.evil.test", "legacy"],
      ["fixture@staging.invalid", "next"]]) {
      await expect(db.query("UPDATE invitations SET normalized_email=$2,account_backend=$3 WHERE id=$1",
        [existing.id, email, backend])).rejects.toMatchObject({ code: "23514" });
    }
    await runControlPlaneMigrations(db, options);
    expect(await ledger()).toEqual(after);
  }, 60_000);
});
