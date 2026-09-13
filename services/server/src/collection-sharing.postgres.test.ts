import { randomUUID } from "node:crypto";
import { renameHostedCollectionForUser } from "./features/hosted/service.js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabasePool } from "./db.js";
import {
  createCollectionInvitationCode,
  createHostedCollectionInvitation,
  acceptHostedCollectionInvitation
} from "./collection-invitations.js";
import {
  revokeHostedCollectionMembership,
  changeHostedCollectionMembershipRole
} from "./collection-membership-lifecycle.js";
import { lockHostedMirrorAccess, insertHostedMirror } from "./hosted-mirror-policy.js";
import { deleteAccountLocally } from "./account-management.js";
import { ProviderRevocationWorker } from "./hosted-capability-lifecycle.js";
import type { HostedProviderClient } from "./hosted-provider.js";

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

  it("serializes mirror issuance against removal and revokes the committed replica", async () => {
    const f = await member();
    const connection = await db.connect();
    const replicaId = randomUUID();
    await connection.query("BEGIN");
    try {
      const access = await lockHostedMirrorAccess(
        connection,
        f.target,
        f.collectionId,
        "read_write"
      );
      const removal = revokeHostedCollectionMembership(db, {
        collectionId: f.collectionId,
        actorUserId: f.owner,
        membershipId: f.membershipId
      });
      await insertHostedMirror(connection, access, {
        id: replicaId,
        name: "Concurrent mirror",
        mode: "read_write",
        allowedTypes: [],
        tokenHash: null
      });
      await connection.query("COMMIT");
      expect(await removal).toMatchObject({ state: "revoking", pendingProviderRevocations: 1 });
      expect(
        (await db.query("SELECT revoked_at FROM hosted_replicas WHERE id=$1", [replicaId])).rows[0]
          .revoked_at
      ).not.toBeNull();
      expect(
        (
          await db.query("SELECT replica_id FROM provider_revocation_jobs WHERE replica_id=$1", [
            replicaId
          ])
        ).rows
      ).toHaveLength(1);
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
    }
  });

  it("checks rename authority after an overlapping membership removal commits", async () => {
    const f = await member();
    const holder = await db.connect();
    const contender = await db.connect();
    const provider = { renameCollection: vi.fn() } as unknown as HostedProviderClient;
    let renaming: ReturnType<typeof renameHostedCollectionForUser> | undefined;
    try {
      const pid = (await contender.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM hosted_collections WHERE id=$1 FOR UPDATE", [f.collectionId]);
      await holder.query("UPDATE collection_memberships SET state='revoked', revoked_at=now() WHERE id=$1", [f.membershipId]);
      renaming = renameHostedCollectionForUser({
        db: { query: db.query.bind(db), connect: async () => contender, end: async () => {} },
        hostedProvider: provider
      }, f.target, f.collectionId, "Revoked rename");
      await expect.poll(async () => (await admin.query(
        "SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked", [pid]
      )).rows[0].blocked).toBe(true);
      expect(provider.renameCollection).not.toHaveBeenCalled();
      await holder.query("COMMIT");
      expect(await renaming).toBeNull();
      expect(provider.renameCollection).not.toHaveBeenCalled();
      expect((await db.query("SELECT display_name FROM hosted_collections WHERE id=$1", [f.collectionId])).rows[0].display_name).toBe("Shared");
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      if (renaming) await renaming;
      else contender.release();
    }
  });

  it.each([false, true])(
    "preserves member deletion cleanup through provider outage with prior transition=%s",
    async (pending) => {
      const f = await member();
      const connection = await db.connect();
      const replicaId = randomUUID();
      try {
        await connection.query("BEGIN");
        const access = await lockHostedMirrorAccess(
          connection,
          f.target,
          f.collectionId,
          "read_write"
        );
        await insertHostedMirror(connection, access, {
          id: replicaId,
          name: "Deleted member",
          mode: "read_write",
          allowedTypes: [],
          tokenHash: null
        });
        await connection.query("COMMIT");
      } finally {
        connection.release();
      }
      if (pending)
        await changeHostedCollectionMembershipRole(db, {
          collectionId: f.collectionId,
          actorUserId: f.owner,
          membershipId: f.membershipId,
          role: "viewer"
        });
      await deleteAccountLocally(db, {
        userId: f.target,
        sessionId: randomUUID(),
        authorized: true,
        queueProviderCleanup: true
      });
      expect(
        (
          await db.query(
            "SELECT membership_id, authorized_user_id FROM hosted_replicas WHERE id=$1",
            [replicaId]
          )
        ).rows
      ).toEqual([{ membership_id: null, authorized_user_id: null }]);
      const target = await account();
      const invitation = await invite(f.owner, f.collectionId, target);
      await expect(
        acceptHostedCollectionInvitation(db, { userId: target, token: invitation.token })
      ).rejects.toMatchObject({ code: "collection_member_seat_unavailable" });
      let offline = true;
      const worker = new ProviderRevocationWorker(db, {
        async revokeReplica() {
          if (offline) throw new Error("Provider offline");
        },
        async revokeNotificationGrant() {}
      } as unknown as HostedProviderClient);
      await worker.drain();
      await expect(
        acceptHostedCollectionInvitation(db, { userId: target, token: invitation.token })
      ).rejects.toMatchObject({ code: "collection_member_seat_unavailable" });
      offline = false;
      await db.query("UPDATE provider_revocation_jobs SET available_at=now() WHERE replica_id=$1", [
        replicaId
      ]);
      await worker.drain();
      await expect(
        acceptHostedCollectionInvitation(db, { userId: target, token: invitation.token })
      ).resolves.toMatchObject({ role: "editor" });
    }
  );
  it.each(["owner", "member"] as const)(
    "deletes the %s account with bound application grants",
    async (actor) => {
      const f = await member();
      const replicaId = randomUUID(),
        applicationId = randomUUID(),
        grantId = randomUUID();
      const connection = await db.connect();
      try {
        await connection.query("BEGIN");
        const access = await lockHostedMirrorAccess(
          connection,
          f.target,
          f.collectionId,
          "read_write"
        );
        await insertHostedMirror(connection, access, {
          id: replicaId,
          name: "Application replica",
          mode: "read_write",
          allowedTypes: [],
          tokenHash: null
        });
        await connection.query("UPDATE hosted_replicas SET purpose='application' WHERE id=$1", [
          replicaId
        ]);
        await connection.query(
          "INSERT INTO applications(id,canonical_identity,name,homepage,redirect_uris) VALUES($1,$2,'Application','https://application.test','[]')",
          [applicationId, `https://application.test/${applicationId}`]
        );
        await connection.query(
          `INSERT INTO grants(id,user_id,application_id,hosted_collection_id,hosted_replica_id,logical_collection_id,
        operations,scope,membership_id,membership_policy_id,membership_policy_revision)
        VALUES($1,$2,$3,$4,$5,$4,'["read"]','{"access":"full_collection","contracts":[]}',$6,$7,$8)`,
          [
            grantId,
            f.target,
            applicationId,
            f.collectionId,
            replicaId,
            access.membershipId,
            access.policyId,
            access.policyRevision
          ]
        );
        await connection.query("COMMIT");
      } finally {
        connection.release();
      }
      await deleteAccountLocally(db, {
        userId: actor === "owner" ? f.owner : f.target,
        sessionId: randomUUID(),
        authorized: true,
        queueProviderCleanup: true
      });
      expect((await db.query("SELECT id FROM grants WHERE id=$1", [grantId])).rows).toHaveLength(0);
      if (actor === "owner") {
        expect(
          (
            await db.query(
              "SELECT collection_id FROM provider_collection_deletion_jobs WHERE collection_id=$1 AND completed_at IS NULL",
              [f.collectionId]
            )
          ).rows
        ).toHaveLength(1);
      } else {
        expect(
          (
            await db.query(
              "SELECT grant_id,seat_membership_id FROM provider_revocation_jobs WHERE replica_id=$1 AND completed_at IS NULL",
              [replicaId]
            )
          ).rows
        ).toEqual([{ grant_id: grantId, seat_membership_id: f.membershipId }]);
      }
    }
  );
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
