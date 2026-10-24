// SEC-048: hints are advisory; only our acknowledged bytes establish policy loss.
import type { DatabasePool, DatabaseQueryable } from "../../database-types.js";
import { audit } from "../../platform/audit-events.js";
import type { LogServiceClient } from "./log-service-client.js";

/** One checked-out physical session owns serialization AND every durable write.
 * Never reconnect this owner or borrow another connection inside the callback. */
export interface PolicyLock extends DatabaseQueryable {
  assertOwned(): Promise<void>;
  commit(): Promise<void>;
}

// Per process, shared by every emitter/recovery caller, not per collection or
// pool. Six owners use 30% of the 20-connection CP pool; queued work borrows no
// connection and is not rejected. A handoff reserves the slot for the oldest
// waiter, so a new arrival cannot overtake it or increase the admitted count.
const MAX_POLICY_OWNERS = 6;
let activePolicyOwners = 0;
const policyWaiters: Array<() => void> = [];

export async function withPolicyLock<T>(db: DatabasePool, collectionId: string, run: (lock: PolicyLock) => Promise<T>): Promise<T> {
  if (activePolicyOwners < MAX_POLICY_OWNERS) activePolicyOwners += 1;
  else await new Promise<void>(resolve => { policyWaiters.push(resolve); });
  try {
    return await withPolicySession(db, collectionId, run);
  } finally {
    const next = policyWaiters.shift();
    if (next) next();
    else activePolicyOwners -= 1;
  }
}

async function withPolicySession<T>(db: DatabasePool, collectionId: string, run: (lock: PolicyLock) => Promise<T>): Promise<T> {
  const client = await db.connect();
  let acquired = false;
  let failed = false;
  const lock: PolicyLock = {
    query: client.query.bind(client),
    async assertOwned() {
      // Read ownership; do not reacquire a lost lock or increment its reentrant
      // count. PostgreSQL splits the bigint advisory key into two unsigned OIDs;
      // objsubid=1 distinguishes it from the two-int advisory-lock namespace.
      const result = await client.query<{ owned: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_locks
         WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
         AND classid = ((hashtextextended($1, 20261004) >> 32) & 4294967295)::oid
         AND objid = (hashtextextended($1, 20261004) & 4294967295)::oid
         AND objsubid = 1) AS owned`, [collectionId]
      );
      if (!result.rows[0]?.owned) throw new Error("policy lock ownership lost; outcome unknown");
    },
    async commit() {
      await lock.assertOwned();
      await client.query("COMMIT");
    }
  };
  try {
    // Same key as the former transaction lock, including during rolling upgrades.
    // Pool lock_timeout remains 5s. No transaction spans remote work.
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 20261004))", [collectionId]);
    acquired = true;
    return await run(lock);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      if (acquired) {
        const released = await client.query<{ unlocked: boolean }>(
          "SELECT pg_advisory_unlock(hashtextextended($1, 20261004)) AS unlocked", [collectionId]
        );
        if (!released.rows[0]?.unlocked) throw new Error("policy lock ownership lost; outcome unknown");
      }
    } catch (error) {
      // Preserve the callback failure. A failed query already marks this client
      // for eviction in db.ts, even if a later cleanup query succeeds.
      if (!failed) throw error;
    } finally { client.release(); }
  }
}

export interface UnparkedBatch { batch_id: string; seq: number; error: string | null; attempts: number; resumed: "send" | "reissue" }

/**
 * Operator resume of a collection's parked policy queue (docs/policy-queue.md).
 * Each parked batch goes back to the step it was parked at, with its bytes and
 * position unchanged: a refused send is sent again, and a lost batch whose
 * reissue could not be signed is reissued. A lost batch with nothing to send
 * (`lost_genesis`, `invalid_retained_ops`) cannot be resumed unchanged and is
 * refused. Each resumed batch is audited with the operator and reason.
 */
export function unparkPolicyQueue(db: DatabasePool, collectionId: string, input: { actor: string; reason: string }): Promise<UnparkedBatch[]> {
  const actor = input.actor.trim(), reason = input.reason.trim();
  if (!actor) return Promise.reject(new Error("The operator making this change is required."));
  if (!reason) return Promise.reject(new Error("A reason is required."));
  return withPolicyLock(db, collectionId, async lock => {
    await lock.query("BEGIN");
    try {
      await lock.assertOwned();
      const parked = await lock.query<{ id: string; seq: string; error: string | null; attempts: number; lost: boolean; reissue: boolean }>(
        `SELECT b.id, b.seq, b.error, b.attempts, b.lost_at IS NOT NULL AS lost,
           EXISTS (SELECT 1 FROM next_policy_outbox o WHERE o.reissue_of = b.id AND o.batch_id IS NULL) AS reissue
         FROM next_policy_batches b WHERE b.collection_id = $1 AND b.state = 'parked' ORDER BY b.id FOR UPDATE OF b`, [collectionId]
      );
      const stuck = parked.rows.find(batch => batch.lost && !batch.reissue);
      if (stuck) throw new Error(`Batch ${stuck.id} (seq ${stuck.seq}) is no longer in the log and cannot be sent again unchanged (${stuck.error ?? "no error recorded"}).`);
      const resumed: UnparkedBatch[] = [];
      for (const batch of parked.rows) {
        // A lost batch stays appended-and-lost, so its pending reissue is signed again.
        await lock.query("UPDATE next_policy_batches SET state = $2 WHERE id = $1 AND state = 'parked'", [batch.id, batch.lost ? "appended" : "sending"]);
        const entry: UnparkedBatch = { batch_id: batch.id, seq: Number(batch.seq), error: batch.error, attempts: batch.attempts, resumed: batch.lost ? "reissue" : "send" };
        await audit(lock, null, "next_policy.unparked", collectionId, { ...entry, reason, actor });
        resumed.push(entry);
      }
      await lock.commit();
      return resumed;
    } catch (error) {
      await lock.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });
}

export function recoverLostPolicy(db: DatabasePool, log: LogServiceClient, collectionId: string): Promise<number> {
  return withPolicyLock(db, collectionId, lock => recover(lock, log, collectionId));
}

interface LostBatch { id: string; park?: "lost_genesis" | "invalid_retained_ops" }
interface SendingBatch { id: string; acknowledged: boolean }

async function retainedOps(client: DatabaseQueryable, batchId: string): Promise<{ version: 1; ops: unknown[] } | undefined> {
  const rows = await client.query<{ ops: { version: number; ops: unknown[] } }>(
    "SELECT ops FROM next_policy_outbox WHERE batch_id = $1 ORDER BY id", [batchId]
  );
  if (!rows.rows.length || rows.rows.some(row => !row.ops || typeof row.ops !== "object" || row.ops.version !== 1 || !Array.isArray(row.ops.ops))) return undefined;
  return { version: 1, ops: rows.rows.flatMap(row => row.ops.ops) };
}

async function recover(lock: PolicyLock, log: LogServiceClient, collectionId: string): Promise<number> {
  const collection = await lock.query("SELECT collection_id FROM next_collections WHERE collection_id = $1", [collectionId]);
  if (!collection.rows.length) return 0;
  await lock.assertOwned();
  const head = await log.head(collectionId);
  // Retain decisions only for lost/sending batches, not the healthy history.
  // All remote verification completes BEFORE any scheduling transaction starts:
  // a failed read must not commit even a prefix of the reissue plan.
  const lost: LostBatch[] = [];
  let after = "0", parked = false;
  while (!parked) {
    const batches = await lock.query<{ id: string; seq: string; item: Buffer }>(
      `SELECT id, seq, item FROM next_policy_batches WHERE collection_id = $1
       AND state = 'appended' AND lost_at IS NULL AND id > $2 ORDER BY id LIMIT 64`, [collectionId, after]
    );
    if (!batches.rows.length) break;
    for (const batch of batches.rows) {
      after = batch.id;
      const seq = Number(batch.seq);
      // Stop a dead owner before its next remote read, not only at page end.
      await lock.assertOwned();
      const stored = seq > head.seq ? null : await log.controlItemAt(collectionId, seq);
      if (stored && batch.item.equals(Buffer.from(stored))) continue;
      const park = seq === 1 ? "lost_genesis" : !await retainedOps(lock, batch.id) ? "invalid_retained_ops" : undefined;
      lost.push({ id: batch.id, ...(park ? { park } : {}) });
      if (park) { parked = true; break; }
    }
  }
  const sending: SendingBatch[] = [];
  if (lost.length && !parked) {
    const fresh = await lock.query<{ id: string; seq: string; item: Buffer }>(
      `SELECT b.id, b.seq, b.item FROM next_policy_batches b WHERE b.collection_id = $1
       AND b.state = 'sending' AND NOT EXISTS
       (SELECT 1 FROM next_policy_outbox o WHERE o.batch_id = b.id AND o.reissue_of IS NOT NULL)
       ORDER BY b.id`, [collectionId]
    );
    for (const batch of fresh.rows) {
      await lock.assertOwned();
      const stored = await log.controlItemAt(collectionId, Number(batch.seq));
      sending.push({ id: batch.id, acknowledged: Boolean(stored && batch.item.equals(Buffer.from(stored))) });
    }
  }
  if (!lost.length) return 0;

  await lock.query("BEGIN");
  try {
    await lock.assertOwned();
    const current = await lock.query("SELECT collection_id FROM next_collections WHERE collection_id = $1 FOR NO KEY UPDATE", [collectionId]);
    let queued = 0;
    if (current.rows.length) {
      for (const batch of lost) {
        const ops = batch.park ? undefined : await retainedOps(lock, batch.id);
        const park = batch.park ?? (!ops ? "invalid_retained_ops" : undefined);
        // Batch bytes/positions are immutable. Recheck mutable ledger state in
        // this short fenced transaction before applying the observed decision.
        const marked = await lock.query(
          `UPDATE next_policy_batches SET lost_at = now(), state = CASE WHEN $2::text IS NULL THEN state ELSE 'parked' END,
           error = CASE WHEN $2::text IS NULL THEN error ELSE $2 END
           WHERE id = $1 AND state = 'appended' AND lost_at IS NULL RETURNING id`, [batch.id, park ?? null]
        );
        if (marked.rows.length !== 1) throw new Error("policy recovery state changed; outcome unknown");
        if (park) { await lock.commit(); return queued; }
        await lock.query("INSERT INTO next_policy_outbox(collection_id, ops, reissue_of) VALUES($1, $2, $3)", [collectionId, JSON.stringify(ops), batch.id]);
        queued += 1;
      }
      for (const batch of sending) {
        // An unknown append may have committed the exact bytes. Only acknowledge
        // verified bytes; otherwise preserve the original fresh-work requeue rule.
        if (!batch.acknowledged) await lock.query("UPDATE next_policy_outbox SET batch_id = NULL WHERE batch_id = $1", [batch.id]);
        const changed = batch.acknowledged
          ? await lock.query("UPDATE next_policy_batches SET state = 'appended', appended_at = now(), error = NULL WHERE id = $1 AND state = 'sending' RETURNING id", [batch.id])
          : await lock.query("DELETE FROM next_policy_batches WHERE id = $1 AND state = 'sending' RETURNING id", [batch.id]);
        if (changed.rows.length !== 1) throw new Error("policy recovery state changed; outcome unknown");
      }
    }
    await lock.commit();
    return queued;
  } catch (error) {
    await lock.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
