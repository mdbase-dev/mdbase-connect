// SEC-048: hints are advisory; only our acknowledged bytes establish policy loss.
// Lock the same collection row as the emitter while marking and scheduling loss,
// so concurrent workers never queue two reissues of the same source batch.
import type { DatabasePool } from "../../database-types.js";
import type { LogServiceClient } from "./log-service-client.js";

// A transaction-scoped advisory lock spans the emitter's claim COMMIT and network
// append. Stored bytes remain durable before sending, without a race with recovery.
export async function withPolicyLock<T>(db: DatabasePool, collectionId: string, run: () => Promise<T>): Promise<T> {
  const lock = await db.connect();
  try {
    await lock.query("BEGIN");
    await lock.query("SET LOCAL lock_timeout = '5s'");
    await lock.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 20261004))", [collectionId]);
    return await run();
  } finally {
    try { await lock.query("ROLLBACK"); } finally { lock.release(); }
  }
}

export function recoverLostPolicy(db: DatabasePool, log: LogServiceClient, collectionId: string): Promise<number> {
  return withPolicyLock(db, collectionId, () => recover(db, log, collectionId));
}

async function recover(db: DatabasePool, log: LogServiceClient, collectionId: string): Promise<number> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const collection = await client.query("SELECT collection_id FROM next_collections WHERE collection_id = $1 FOR NO KEY UPDATE", [collectionId]);
    if (!collection.rows.length) {
      await client.query("COMMIT");
      return 0;
    }
    const head = await log.head(collectionId);
    let after = "0";
    let queued = 0;
    for (;;) {
      const batches = await client.query<{ id: string; seq: string; item: Buffer }>(
        `SELECT id, seq, item FROM next_policy_batches WHERE collection_id = $1
         AND state = 'appended' AND lost_at IS NULL AND id > $2 ORDER BY id LIMIT 64`, [collectionId, after]
      );
      if (!batches.rows.length) break;
      for (const batch of batches.rows) {
        after = batch.id;
        const seq = Number(batch.seq);
        const stored = seq > head.seq ? null : await log.controlItemAt(collectionId, seq);
        if (stored && batch.item.equals(Buffer.from(stored))) continue;
        // A lost genesis has no safe new-position equivalent. Park instead of
        // changing the root or accepting a replacement history.
        if (seq === 1) {
          await client.query("UPDATE next_policy_batches SET state = 'parked', error = 'lost_genesis', lost_at = now() WHERE id = $1", [batch.id]);
          await client.query("COMMIT");
          return queued;
        }
        const rows = await client.query<{ ops: { version: number; ops: unknown[] } }>(
          "SELECT ops FROM next_policy_outbox WHERE batch_id = $1 ORDER BY id", [batch.id]
        );
        if (!rows.rows.length || rows.rows.some((row) => !row.ops || typeof row.ops !== "object" || row.ops.version !== 1 || !Array.isArray(row.ops.ops))) {
          await client.query("UPDATE next_policy_batches SET state = 'parked', error = 'invalid_retained_ops', lost_at = now() WHERE id = $1", [batch.id]);
          await client.query("COMMIT");
          return queued;
        }
        const ops = { version: 1, ops: rows.rows.flatMap((row) => row.ops.ops) };
        await client.query("INSERT INTO next_policy_outbox(collection_id, ops, reissue_of) VALUES($1, $2, $3)", [collectionId, JSON.stringify(ops), batch.id]);
        await client.query("UPDATE next_policy_batches SET lost_at = now() WHERE id = $1", [batch.id]);
        queued += 1;
      }
    }
    if (queued > 0) {
      const fresh = await client.query<{ id: string; seq: string; item: Buffer }>(
        `SELECT b.id, b.seq, b.item FROM next_policy_batches b WHERE b.collection_id = $1
         AND b.state = 'sending' AND NOT EXISTS
         (SELECT 1 FROM next_policy_outbox o WHERE o.batch_id = b.id AND o.reissue_of IS NOT NULL)
         ORDER BY b.id`, [collectionId]
      );
      for (const batch of fresh.rows) {
        // An unknown response might already have committed the exact bytes. Never
        // discard that effect or blindly resend it against restored history.
        const stored = await log.controlItemAt(collectionId, Number(batch.seq));
        if (stored && batch.item.equals(Buffer.from(stored))) {
          await client.query("UPDATE next_policy_batches SET state = 'appended', appended_at = now(), error = NULL WHERE id = $1", [batch.id]);
        } else {
          await client.query("UPDATE next_policy_outbox SET batch_id = NULL WHERE batch_id = $1", [batch.id]);
          await client.query("DELETE FROM next_policy_batches WHERE id = $1", [batch.id]);
        }
      }
    }
    await client.query("COMMIT");
    return queued;
  } catch (error) {
    // A network failure rolls back all scheduling: it never establishes loss.
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
