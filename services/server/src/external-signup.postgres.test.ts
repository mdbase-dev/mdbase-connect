import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthenticationPolicyStore } from "./authentication-policy.js";
import { createDatabase, type DatabasePool } from "./db.js";
import { ExternalSignupService } from "./external-signup.js";
import { AccountUnavailableError, createExternalSession } from "./external-auth.js";
import { tokenHash } from "./security.js";

// Only an explicitly approved, local disposable database is accepted. The suite
// creates and drops its own unique schema, never public or another test's data.
const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved = process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL === "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const describePostgres = testUrl && approved ? describe : describe.skip;
let admin: pg.Pool;
let db: DatabasePool;
let service: ExternalSignupService;
let schema: string;
const input = { name: "New Person", termsVersion: "terms-v1", privacyVersion: "privacy-v1", timezone: "UTC", clientName: "Postgres test" };
function complete(proof: string, values = input) {
  return service.complete(proof, { ...values, proofId: tokenHash(proof) });
}
function identity(subject = randomUUID(), email = `${randomUUID()}@example.com`) {
  return { provider: "google" as const, subject, email, emailVerified: true, name: "New Person", login: null, avatarUrl: null };
}

describePostgres("external signup PostgreSQL transactions", () => {
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) {
      throw new Error("External signup tests require a dedicated local test database.");
    }
    schema = `mdbase_social_signup_test_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    const policy = new AuthenticationPolicyStore(db, "closed");
    await policy.update({ registrationMode: "open", passwordAuthEnabled: false, emailDeliveryEnabled: false, termsVersion: input.termsVersion, privacyVersion: input.privacyVersion, expectedRevision: 0, updatedBy: "operator:test", reason: "Isolated transaction tests" });
    service = new ExternalSignupService(db, policy, new Set(["google", "github"]));
  }, 60_000);

  afterAll(async () => {
    await db?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  }, 60_000);

  it("does not reopen an account through a previously disconnected provider subject", async () => {
    const person = { ...identity(), email: null, emailVerified: false };
    const first = await createExternalSession(db, person);
    await db.query("DELETE FROM external_identities WHERE user_id = $1", [first.userId]);
    await expect(createExternalSession(db, person)).rejects.toBeInstanceOf(AccountUnavailableError);
    expect((await db.query("SELECT id FROM sessions WHERE user_id = $1", [first.userId])).rows).toHaveLength(1);
    expect((await db.query("SELECT subject FROM external_identities WHERE user_id = $1", [first.userId])).rows).toHaveLength(0);
  });

  it("allows exactly one redemption of a proof across connections", async () => {
    const proof = await service.create(identity(), "/");
    const results = await Promise.allSettled([complete(proof), complete(proof)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("serializes two independent proofs of one subject without duplicate onboarding", async () => {
    const person = identity();
    const first = await service.create(person, "/");
    const second = await service.create(person, "/");
    const sessions = await Promise.all([complete(first), complete(second)]);
    expect(new Set(sessions.map((session) => session.userId)).size).toBe(1);
    expect(sessions.filter((session) => session.createdAccount)).toHaveLength(1);
    for (const table of ["account_onboarding", "account_entitlement_grants", "email_identities", "email_jobs"]) {
      expect((await db.query(`SELECT user_id FROM ${table} WHERE user_id = $1`, [sessions[0].userId])).rows).toHaveLength(1);
    }
  });

  it("allows only one provider to claim a verified email and rolls back the loser", async () => {
    const email = `${randomUUID()}@example.com`;
    const google = await service.create(identity(randomUUID(), email), "/");
    const github = await service.create({ ...identity(randomUUID(), email), provider: "github" }, "/");
    const results = await Promise.allSettled([complete(google), complete(github)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await db.query("SELECT user_id FROM external_identities WHERE normalized_email = $1", [email])).rows).toHaveLength(1);
    expect((await db.query("SELECT user_id FROM account_creation_email_claims WHERE normalized_email = $1", [email])).rows).toHaveLength(1);
  });

  it("rolls back proof consumption, account, session, legal acceptance and grants when onboarding fails", async () => {
    const person = identity();
    const proof = await service.create(person, "/");
    const before = (await db.query("SELECT id FROM users")).rows.length;
    await db.query("ALTER TABLE account_onboarding ADD CONSTRAINT test_signup_failure CHECK (timezone <> 'Etc/GMT+1')");
    try {
      await expect(complete(proof, { ...input, timezone: "Etc/GMT+1" })).rejects.toThrow();
      expect((await db.query("SELECT id FROM users")).rows).toHaveLength(before);
      expect((await db.query("SELECT user_id FROM external_identities WHERE subject = $1", [person.subject])).rows).toHaveLength(0);
      expect((await db.query("SELECT user_id FROM account_creation_email_claims WHERE normalized_email = $1", [person.email])).rows).toHaveLength(0);
      expect((await db.query("SELECT token_hash FROM external_signup_challenges WHERE token_hash = $1", [tokenHash(proof)])).rows).toHaveLength(1);
    } finally {
      await db.query("ALTER TABLE account_onboarding DROP CONSTRAINT test_signup_failure");
    }
    const retried = await complete(proof);
    expect(retried.createdAccount).toBe(true);
  });
});
