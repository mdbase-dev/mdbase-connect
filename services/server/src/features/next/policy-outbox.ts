// The policy outbox (mdbase-next docs/ship/control-plane.md §2.1).
//
// Connect records the policy ops a change implies in the *same transaction* as the
// change (`queueNextPolicy`). The emitter turns pending ops into one signed policy item
// per collection, stores its bytes and position, and only then sends it. So:
// - an unknown outcome is retried with the same bytes (log-service-api.md §4.2, I4);
// - `head-moved` means these bytes are not in the log, and the item is rebuilt at the
//   new head;
// - any other refusal parks the collection's queue (order matters) until an operator
//   looks at it. Nothing is dropped silently.
import type { DatabasePool, DatabaseQueryable } from "../../database-types.js";
import { LogServiceError, type LogServiceClient } from "./log-service-client.js";
import { signPolicyItem, type PolicyOp, type PolicySigner } from "./policy-wire.js";

const OUTBOX_FORMAT = 1;
const MAX_ROWS_PER_ITEM = 64;
const ZERO_CHAIN = new Uint8Array(32);

// Persisted form: `{version, ops}` with byte fields as `{"$hex": "…"}`. This is
// database state, so any change to it needs a data migration.
function serializeOps(ops: PolicyOp[]): string {
  // The holder's raw value, because Buffer.toJSON runs before a replacer sees it.
  return JSON.stringify({ version: OUTBOX_FORMAT, ops }, function (this: Record<string, unknown>, key, value: unknown) {
    const raw = this[key];
    return raw instanceof Uint8Array ? { $hex: Buffer.from(raw).toString("hex") } : value;
  });
}

function deserializeOps(value: unknown): PolicyOp[] {
  const revived = JSON.parse(typeof value === "string" ? value : JSON.stringify(value), (_key, field: unknown) =>
    field && typeof field === "object" && "$hex" in field ? Uint8Array.from(Buffer.from(String((field as { $hex: string }).$hex), "hex")) : field) as { version: number; ops: PolicyOp[] };
  if (revived.version !== OUTBOX_FORMAT) throw new Error(`unknown policy outbox format ${revived.version}`);
  return revived.ops;
}

export type HostedSync = "private" | "cloud_copy";

/**
 * Register a collection whose log the control plane creates on the hosted log
 * service. `ops` must start with its `genesis`, in the state matching `sync`; they
 * become the item at seq 1 (`create_log`). A private collection may not enrol a
 * hosted or escrow device: mdbase never receives its key. Call inside the transaction
 * that creates or converts the collection.
 */
export async function registerNextCollection(
  client: DatabaseQueryable,
  input: { collectionId: string; ownerUserId: string; runtime: "shadow" | "next"; sync: HostedSync; rootKeyId: Uint8Array; ops: PolicyOp[] }
): Promise<void> {
  const genesis = input.ops[0];
  if (genesis?.op !== "genesis" || input.ops.slice(1).some((op) => op.op === "genesis")) throw new Error("a new log starts with exactly one genesis op");
  if (!Buffer.from(genesis.root).equals(Buffer.from(input.rootKeyId))) throw new Error("genesis root differs from the collection's root key");
  if (genesis.state !== (input.sync === "private" ? "e2e" : "cloud-copy")) throw new Error("genesis state differs from the collection's sync state");
  if (input.sync === "private") assertPrivateOps(input.ops);
  await client.query(
    `INSERT INTO next_collections (collection_id, owner_user_id, runtime, location, sync, root_key_id)
     VALUES ($1, $2, $3, 'hosted', $4, $5)`,
    [input.collectionId, input.ownerUserId, input.runtime, input.sync, Buffer.from(input.rootKeyId)]
  );
  await client.query("INSERT INTO next_policy_outbox (collection_id, ops) VALUES ($1, $2)", [input.collectionId, serializeOps(input.ops)]);
}

/**
 * Refuse ops a private collection must never carry: anything that would give mdbase
 * its key (SEC-003), and folder names in clear (SEC-013; the device-signed approval
 * carries them sealed, flagged by `folderScoped`).
 */
function assertPrivateOps(ops: PolicyOp[]): void {
  if (ops.some((op) => (op.op === "device-enrol" && (op.kind === "hosted" || op.kind === "escrow")) || (op.op === "collection-state" && op.state === "cloud-copy"))) {
    throw new Error("a private collection never enrols a hosted or escrow device");
  }
  if (ops.some((op) => op.op === "grant" && op.fileFolders !== undefined)) {
    throw new Error("a private collection never carries folder names in clear");
  }
}

/**
 * Queue policy ops for a collection with a hosted log, inside the caller's transaction.
 * Returns false, and queues nothing, when the collection is not served by the new
 * runtime or its log is on a device. Turning the cloud copy on is its own flow, never
 * a side effect of these ops.
 */
export async function queueNextPolicy(client: DatabaseQueryable, collectionId: string, ops: PolicyOp[]): Promise<boolean> {
  if (ops.length === 0) return false;
  if (ops.some((op) => op.op === "genesis")) throw new Error("genesis is only valid when registering a collection");
  const collection = await client.query<{ sync: HostedSync }>(
    "SELECT sync FROM next_collections WHERE collection_id = $1 AND location = 'hosted' FOR KEY SHARE",
    [collectionId]
  );
  const sync = collection.rows[0]?.sync;
  if (!sync) return false;
  if (sync === "private") assertPrivateOps(ops);
  await client.query("INSERT INTO next_policy_outbox (collection_id, ops) VALUES ($1, $2)", [collectionId, serializeOps(ops)]);
  return true;
}

interface Batch {
  id: string;
  seq: string;
  prev: Buffer;
  item: Buffer;
}

type DrainOutcome = "appended" | "rebuild" | "idle" | "blocked";
/** Rebuilds after `head-moved` before yielding to the next poll. */
const MAX_REBUILDS = 8;

export class PolicyEmitter {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<number> | undefined;

  constructor(
    private readonly db: DatabasePool,
    private readonly log: LogServiceClient,
    private readonly signer: PolicySigner,
    private readonly onError: (error: unknown, collectionId?: string) => void = () => undefined,
    private readonly pollIntervalMs = 2_000,
    private readonly now: () => number = Date.now
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.drain().catch((error) => this.onError(error)), this.pollIntervalMs);
    this.timer.unref();
    void this.drain().catch((error) => this.onError(error));
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  /** Append everything pending for every collection; returns the number of items appended. */
  async drain(): Promise<number> {
    while (this.inFlight) await this.inFlight;
    const run = this.drainAll();
    this.inFlight = run;
    try {
      return await run;
    } finally {
      if (this.inFlight === run) this.inFlight = undefined;
    }
  }

  private async drainAll(): Promise<number> {
    const collections = await this.db.query<{ collection_id: string }>(
      `SELECT collection_id FROM next_policy_outbox WHERE batch_id IS NULL
       UNION SELECT collection_id FROM next_policy_batches WHERE state = 'sending'`
    );
    let appended = 0;
    for (const { collection_id: collectionId } of collections.rows) {
      try {
        appended += await this.drainCollection(collectionId);
      } catch (error) {
        this.onError(error, collectionId);
      }
    }
    return appended;
  }

  /** Append the collection's pending items in order until it is idle, blocked or must retry. */
  async drainCollection(collectionId: string): Promise<number> {
    let appended = 0;
    let rebuilds = 0;
    for (;;) {
      const outcome = await this.step(collectionId);
      if (outcome === "appended") appended += 1;
      else if (outcome !== "rebuild" || ++rebuilds > MAX_REBUILDS) return appended;
    }
  }

  private async step(collectionId: string): Promise<DrainOutcome> {
    const batch = await this.claim(collectionId);
    if (batch === "idle" || batch === "blocked") return batch;
    const seq = Number(batch.seq);
    try {
      if (seq === 1) {
        await this.log.createLog(collectionId, batch.item);
      } else {
        const result = await this.log.append(collectionId, seq, batch.prev, [batch.item]);
        if (result.kind === "head-moved") {
          await this.release(batch.id);
          return "rebuild";
        }
        if (result.kind === "duplicate") throw new LogServiceError("invalid", "duplicate");
      }
    } catch (error) {
      if (error instanceof LogServiceError && !error.retryable) {
        await this.db.query("UPDATE next_policy_batches SET state = 'parked', error = $2, attempts = attempts + 1 WHERE id = $1 AND state = 'sending'", [batch.id, error.message]);
      } else {
        await this.db.query("UPDATE next_policy_batches SET attempts = attempts + 1, error = $2 WHERE id = $1 AND state = 'sending'", [batch.id, String((error as Error).message ?? error)]);
      }
      throw error;
    }
    await this.db.query("UPDATE next_policy_batches SET state = 'appended', appended_at = now(), error = NULL WHERE id = $1 AND state = 'sending'", [batch.id]);
    return "appended";
  }

  /** Return the collection's open batch, or build and persist the next one. */
  private async claim(collectionId: string): Promise<Batch | "idle" | "blocked"> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const collection = await client.query<{ last_issued_at: string; root_key_id: Buffer }>(
        "SELECT last_issued_at, root_key_id FROM next_collections WHERE collection_id = $1 FOR NO KEY UPDATE",
        [collectionId]
      );
      const row = collection.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return "idle";
      }
      const open = await client.query<Batch & { state: string }>(
        "SELECT id, seq, prev, item, state FROM next_policy_batches WHERE collection_id = $1 AND state <> 'appended' ORDER BY id LIMIT 1",
        [collectionId]
      );
      if (open.rows[0]) {
        await client.query("COMMIT");
        return open.rows[0].state === "parked" ? "blocked" : open.rows[0];
      }
      const pending = await client.query<{ id: string; ops: unknown }>(
        "SELECT id, ops FROM next_policy_outbox WHERE collection_id = $1 AND batch_id IS NULL ORDER BY id LIMIT $2",
        [collectionId, MAX_ROWS_PER_ITEM]
      );
      if (pending.rows.length === 0) {
        await client.query("COMMIT");
        return "idle";
      }
      const ops = pending.rows.flatMap((entry) => deserializeOps(entry.ops));
      if (!Buffer.from(row.root_key_id).equals(Buffer.from(this.signer.cert.root))) {
        throw new Error("the configured policy key is certified by a different root than this collection's");
      }
      // Monotonic per collection (policy.md §3 rule 4), even if the clock steps back.
      const previousIssuedAt = Number(row.last_issued_at);
      const issuedAt = Math.max(this.now(), previousIssuedAt + 1);
      const genesis = ops[0]?.op === "genesis";
      const head = genesis ? { seq: 0, chain: ZERO_CHAIN } : await this.log.head(collectionId);
      const seq = head.seq + 1;
      const item = signPolicyItem(this.signer, { collection: collectionId, seq, prev: head.chain, issuedAt, previousIssuedAt, ops });
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO next_policy_batches (collection_id, seq, prev, item, issued_at, state)
         VALUES ($1, $2, $3, $4, $5, 'sending') RETURNING id`,
        [collectionId, seq, Buffer.from(head.chain), Buffer.from(item), issuedAt]
      );
      const batchId = inserted.rows[0]!.id;
      await client.query("UPDATE next_policy_outbox SET batch_id = $1 WHERE id = ANY($2::bigint[])", [batchId, pending.rows.map((entry) => entry.id)]);
      await client.query("UPDATE next_collections SET last_issued_at = $2 WHERE collection_id = $1", [collectionId, issuedAt]);
      await client.query("COMMIT");
      return { id: batchId, seq: String(seq), prev: Buffer.from(head.chain), item: Buffer.from(item) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** The log moved past this item's position without it: return its ops to the queue. */
  private async release(batchId: string): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE next_policy_outbox SET batch_id = NULL WHERE batch_id = $1", [batchId]);
      await client.query("DELETE FROM next_policy_batches WHERE id = $1 AND state = 'sending'", [batchId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
