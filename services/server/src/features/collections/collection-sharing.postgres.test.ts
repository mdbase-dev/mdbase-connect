import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabasePool } from "../../db.js";
import {
  createCollectionInvitationCode,
  createHostedCollectionInvitation,
  acceptHostedCollectionInvitation
} from "./collection-invitations.js";

const testUrl = process.env.MDBASE_CONNECT_TEST_DATABASE_URL;
const approved =
  process.env.MDBASE_CONNECT_DESTRUCTIVE_TEST_APPROVAL ===
  "I APPROVE MDBASE CONNECT DESTRUCTIVE POSTGRES TESTS";
const suite = testUrl && approved ? describe : describe.skip;
const schema = `sharing_test_${randomUUID().replaceAll("-", "")}`;
let admin: pg.Pool;
let db: DatabasePool;

suite("collection sharing PostgreSQL boundaries", () => {
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || !/test/i.test(url.pathname)) {
      throw new Error("Sharing tests require a dedicated local test database.");
    }
    admin = new pg.Pool({ connectionString: url.toString() });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("options", `-csearch_path=${schema}`);
    db = await createDatabase(url.toString());
    await db.query("UPDATE entitlement_profiles SET max_collection_member_seats=1");
  }, 60_000);
  afterAll(async () => {
    await db?.end();
    if (admin) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.end();
  });

  it("admits only one of two competing acceptances for the owner's final seat", async () => {
    const owner = await account(true);
    const collections = await Promise.all([collection(owner), collection(owner)]);
    const targets = await Promise.all([account(), account()]);
    const invitations = await Promise.all(
      collections.map((id, i) => invite(owner, id, targets[i]!))
    );
    const results = await Promise.allSettled(
      invitations.map((invitation, i) =>
        acceptHostedCollectionInvitation(db, { userId: targets[i]!, token: invitation.token })
      )
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toMatchObject([
      { reason: { code: "collection_member_seat_unavailable" } }
    ]);
    expect(
      (
        await db.query(
          "SELECT id FROM account_collection_member_seats WHERE owner_user_id=$1 AND released_at IS NULL",
          [owner]
        )
      ).rows
    ).toHaveLength(1);
  });
});

async function account(owner = false): Promise<string> {
  const id = randomUUID();
  await db.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Sharing test')", [
    id,
    `${id}@example.test`
  ]);
  if (owner) {
    await db.query(
      "INSERT INTO account_entitlement_grants(id,user_id,profile_code,source,source_reference) VALUES($1,$2,'beta_v1','operator',$3)",
      [randomUUID(), id, id]
    );
    await db.query(
      "INSERT INTO account_storage_accounts(user_id,provider_account_id) VALUES($1,$2)",
      [id, randomUUID()]
    );
  }
  return id;
}
async function collection(owner: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    "INSERT INTO hosted_collections(id,user_id,display_name,template,provider_url) VALUES($1,$2,'Shared','mdbase','https://provider.example')",
    [id, owner]
  );
  return id;
}
async function invite(owner: string, collectionId: string, target: string) {
  const code = await createCollectionInvitationCode(db, target);
  return createHostedCollectionInvitation(db, {
    collectionId,
    actorUserId: owner,
    role: "editor",
    target: { inviteeCode: code.code }
  });
}
async function member() {
  const owner = await account(true),
    target = await account(),
    collectionId = await collection(owner);
  const invitation = await invite(owner, collectionId, target);
  const accepted = await acceptHostedCollectionInvitation(db, {
    userId: target,
    token: invitation.token
  });
  return { owner, target, collectionId, membershipId: accepted.membershipId };
}
