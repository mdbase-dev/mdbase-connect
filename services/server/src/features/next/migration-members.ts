// Membership policy for a migrating collection's SHADOW target. The target's
// genesis sets only the owner; every other current member must reach the log as
// policy before the cutover, so the native member-role comparison (the accepted
// policy reducer's member map) equals what Connect holds.
//
// Desired state, from Connect's membership rows:
// - active: member-set with the current policy revision's role;
// - changing: member-set viewer, the same downgrade the ordinary lifecycle
//   publishes while provider cleanup is pending (no early write authority);
// - revoking, revoked: not a member; pending invitations stay in Connect.
//
// Queued state is the fold of the target's member ops in log order. Only the
// difference is queued, one outbox row per member, so a retry or replay queues
// nothing and a member who left mid-run is removed exactly once. A member-remove
// is queued only for an account the queue holds: the log refuses any other, and
// a refused op would park the collection's whole policy queue.
import type { DatabaseQueryable } from "../../database-types.js";
import { RolloutRefused } from "./migration-rollout.js";
import { queueNextPolicy } from "./policy-outbox.js";
import type { PolicyOp } from "./policy-wire.js";

type Role = "owner" | "editor" | "viewer";
type MemberOp = Extract<PolicyOp, { op: "member-set" | "member-remove" }>;
interface MigrationMemberPlan {
  /** The exact expected member map, owner included, sorted by account. */
  members: Array<{ account: string; role: Role }>;
  /** The member ops still to queue; empty when the queue already matches. */
  ops: MemberOp[];
  /** The target's genesis owner is in the queued policy as owner. */
  ownerQueued: boolean;
}

/** The native comparison refuses more than 1000 entries, owner included. */
const MAX_MEMBERS = 1000;
const MAX_MEMBER_ROWS = 4096;
const invalid = (message: string) => new RolloutRefused("migration_members_invalid", message);

/** Call inside the transaction that queues, after the claim and target locks. */
export async function migrationMemberPlan(client: DatabaseQueryable, collection: string, owner: string): Promise<MigrationMemberPlan> {
  const parked = await client.query("SELECT 1 FROM next_policy_batches WHERE collection_id=$1 AND state='parked' LIMIT 1", [collection]);
  if (parked.rows.length) throw new RolloutRefused("migration_policy_blocked", "The target's policy queue is parked.");
  // Row locks: a concurrent membership change waits for this plan's commit.
  const current = (await client.query<{ account: string; state: string; role: string | null }>(
    `SELECT m.user_id::text AS account, m.state, p.role FROM collection_memberships m
     LEFT JOIN collection_membership_policies p
       ON p.id=m.current_policy_id AND p.membership_id=m.id AND p.revision=m.current_policy_revision
     WHERE m.collection_id=$1 AND m.state IN ('active','changing') ORDER BY m.user_id LIMIT $2 FOR UPDATE OF m`,
    [collection, MAX_MEMBERS])).rows;
  if (current.length + 1 > MAX_MEMBERS) {
    throw new RolloutRefused("migration_members_over_cap", "The collection has more members than a migration can carry.");
  }
  const desired = new Map<string, Role>();
  for (const row of current) {
    const role = row.state === "changing" ? "viewer" : row.role;
    if (row.account === owner || (role !== "viewer" && role !== "editor")) throw invalid("A membership has no exact current policy.");
    desired.set(row.account, role);
  }
  // Log order: non-lost batches by position, then reissues of lost batches, then fresh rows.
  const rows = (await client.query<{ ops: unknown }>(
    `SELECT o.ops FROM next_policy_outbox o LEFT JOIN next_policy_batches b ON b.id=o.batch_id
     WHERE o.collection_id=$1 AND b.lost_at IS NULL
       AND (o.ops->'ops' @> '[{"op":"genesis"}]' OR o.ops->'ops' @> '[{"op":"member-set"}]' OR o.ops->'ops' @> '[{"op":"member-remove"}]')
     ORDER BY o.batch_id IS NULL, b.seq, o.reissue_of IS NULL, o.reissue_of, o.id LIMIT $2`,
    [collection, MAX_MEMBER_ROWS + 1])).rows;
  if (rows.length > MAX_MEMBER_ROWS) throw invalid("The target's member policy is too long to compare.");
  const queued = new Map<string, Role>();
  for (const { ops: body } of rows) {
    const ops = (body as { version?: unknown; ops?: unknown } | null)?.ops;
    if ((body as { version?: unknown } | null)?.version !== 1 || !Array.isArray(ops)) throw invalid("The target's queued policy is unreadable.");
    for (const op of ops as Array<Record<string, unknown>>) {
      if (op.op === "genesis") queued.set(String(op.owner), "owner");
      else if (op.op === "member-set") queued.set(String(op.account), op.role as Role);
      else if (op.op === "member-remove") queued.delete(String(op.account));
    }
  }
  const ops: MemberOp[] = [];
  for (const [account, role] of desired) if (queued.get(account) !== role) ops.push({ op: "member-set", account, role });
  for (const account of [...queued.keys()].sort()) {
    if (account !== owner && !desired.has(account)) ops.push({ op: "member-remove", account });
  }
  const members = [...desired].map(([account, role]) => ({ account, role }));
  members.push({ account: owner, role: "owner" });
  members.sort((a, b) => a.account < b.account ? -1 : a.account > b.account ? 1 : 0);
  return { members, ops, ownerQueued: queued.get(owner) === "owner" };
}

/** One outbox row per member op, in the caller's transaction. */
export async function queueMigrationMembers(client: DatabaseQueryable, collection: string, ops: readonly MemberOp[]): Promise<void> {
  for (const op of ops) {
    if (!await queueNextPolicy(client, collection, [op])) throw new RolloutRefused("migration_target_unavailable", "No SHADOW target for this collection.");
  }
}
