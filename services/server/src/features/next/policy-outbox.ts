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
import { isLogRegion, LogServiceError, type LogPlacement, type LogRegion, LogServiceClient } from "./log-service-client.js";
import { signPolicyItem, type PolicyOp, type PolicySigner } from "./policy-wire.js";
import { recoverLostPolicy, withPolicyLock, type PolicyLock } from "./policy-recovery.js";
import { DEFAULT_COLLECTION_DISPLAY_NAME } from "./collection-display-name.js";

const OUTBOX_FORMAT = 1;
const MAX_ROWS_PER_ITEM = 64;
const ZERO_CHAIN = new Uint8Array(32);

// Persisted form: `{version, ops}` with byte fields as `{"$hex": "…"}`. This is
// database state, so any change to it needs a data migration. The genesis row
// may also carry an optional `placement` (`create_log` key 2) and, once the log
// exists, the `region` the log service recorded (`create_log` reply key 2). Readers
// of `ops` ignore both.
function serializeOps(ops: PolicyOp[], placement?: LogPlacement): string {
  // The holder's raw value, because Buffer.toJSON runs before a replacer sees it.
  return JSON.stringify({ version: OUTBOX_FORMAT, ops, ...(placement ? { placement } : {}) }, function (this: Record<string, unknown>, key, value: unknown) {
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

type HostedSync = "private" | "cloud_copy";

/** The genesis row's stored placement; anything malformed is no placement. */
function storedPlacement(value: unknown): LogPlacement | undefined {
  const parsed = (typeof value === "string" ? JSON.parse(value) : value) as { placement?: unknown } | null;
  const placement = parsed?.placement as { timezone?: unknown; ownerTimezones?: unknown } | undefined;
  if (!placement || typeof placement !== "object") return undefined;
  return {
    ...(typeof placement.timezone === "string" ? { timezone: placement.timezone } : {}),
    ...(Array.isArray(placement.ownerTimezones) ? { ownerTimezones: placement.ownerTimezones.filter((zone): zone is string => typeof zone === "string") } : {}),
  };
}

/**
 * The region the log service recorded for the collection, from its `create_log`
 * reply; undefined before the log exists and for a collection with no region. The
 * hosted Worker places a new actor there (activation, migration admission).
 */
export async function collectionRegion(client: DatabaseQueryable, collectionId: string): Promise<LogRegion | undefined> {
  const region = (await client.query<{ region: string | null }>(
    "SELECT ops->>'region' AS region FROM next_policy_outbox WHERE collection_id = $1 ORDER BY id LIMIT 1", [collectionId]
  )).rows[0]?.region;
  return isLogRegion(region) ? region : undefined;
}

/** A new collection's placement: the timezone its owner's device reported at signup. */
async function ownerPlacement(client: DatabaseQueryable, ownerUserId: string): Promise<LogPlacement | undefined> {
  const row = (await client.query<{ timezone: string }>("SELECT timezone FROM account_onboarding WHERE user_id = $1", [ownerUserId])).rows[0];
  return row ? { timezone: row.timezone } : undefined;
}

/**
 * Register a collection whose log the control plane creates on the hosted log
 * service. `ops` must start with its `genesis`, in the state matching `sync`; they
 * become the item at seq 1 (`create_log`). A private collection may not enrol a
 * hosted or escrow device: mdbase never receives its key. Call inside the transaction
 * that creates or converts the collection.
 *
 * `placement` picks the collection's storage region. A migrated (`shadow`)
 * collection passes its legacy timezones; a new one defaults to its owner's
 * signup timezone, and to nothing (the log service's default) without one.
 */
export async function registerNextCollection(
  client: DatabaseQueryable,
  input: { collectionId: string; ownerUserId: string; runtime: "shadow" | "next"; sync: HostedSync; rootKeyId: Uint8Array; ops: PolicyOp[]; displayName?: string;
    placement?: LogPlacement }
): Promise<void> {
  const genesis = input.ops[0];
  if (genesis?.op !== "genesis" || input.ops.slice(1).some((op) => op.op === "genesis")) throw new Error("a new log starts with exactly one genesis op");
  if (!Buffer.from(genesis.root).equals(Buffer.from(input.rootKeyId))) throw new Error("genesis root differs from the collection's root key");
  if (genesis.state !== (input.sync === "private" ? "e2e" : "cloud-copy")) throw new Error("genesis state differs from the collection's sync state");
  if (input.sync === "private") assertPrivateOps(input.ops);
  // Cleartext catalog metadata for either sync mode; never part of private policy/key material.
  // The initial catalog label belongs to the first registration, never a retry.
  const displayName = input.displayName ?? DEFAULT_COLLECTION_DISPLAY_NAME;
  await client.query(
    `INSERT INTO next_collections (collection_id, owner_user_id, runtime, sync, root_key_id, display_name)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.collectionId, input.ownerUserId, input.runtime, input.sync, Buffer.from(input.rootKeyId), displayName]
  );
  const placement = input.placement ?? (input.runtime === "next" ? await ownerPlacement(client, input.ownerUserId) : undefined);
  await client.query("INSERT INTO next_policy_outbox (collection_id, ops) VALUES ($1, $2)", [input.collectionId, serializeOps(input.ops, placement)]);
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
    "SELECT sync FROM next_collections WHERE collection_id = $1 FOR KEY SHARE",
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
/** Foreground wake hints are optional; overflow remains in the durable ledger
 * for the existing poller. Never create an unbounded background request queue. */
const MAX_BACKGROUND_WAKES = 4;
const VERIFICATION_BUDGET_MS = 500;
const MAX_VERIFICATION_PROBES = 32;

export class PolicyEmitter {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<number> | undefined;
  private lastVerificationAt = -Infinity;
  private readonly verificationQueue = new Map<string, { after: string; through?: string } | undefined>();
  private readonly wakeWork = new Map<string, Promise<void>>();
  private readonly committedWork = new Map<string, Promise<void>>();
  private closed = false;

  /** Hints only select a collection for verification, never its ops or positions. */
  hintLostPolicy(collectionId: string): void {
    // An explicit loss hint needs the full fenced recovery, not a healthy scan.
    this.verificationQueue.delete(collectionId);
    this.verificationQueue.set(collectionId, undefined);
  }

  constructor(
    private readonly db: DatabasePool,
    private readonly log: LogServiceClient,
    private readonly signer: PolicySigner,
    private readonly onError: (error: unknown, collectionId: string | undefined, details: ReturnType<typeof LogServiceClient.failureDetails>) => void = () => undefined,
    private readonly pollIntervalMs = 2_000,
    private readonly now: () => number = Date.now,
    private readonly activateServices: (collectionId?: string) => Promise<void> = async () => undefined
  ) {}

  private reportFailure(error: unknown, collectionId?: string, phase?: "recover"): void {
    this.onError(error, collectionId, LogServiceClient.failureDetails(error, phase));
  }

  start(): void {
    if (this.closed) throw new Error("policy emitter closed");
    if (this.timer) return;
    this.timer = setInterval(() => void this.drain().catch((error) => this.reportFailure(error)), this.pollIntervalMs);
    this.timer.unref();
    void this.drain().catch((error) => this.reportFailure(error));
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // A failed global drain must not orphan admitted wakes or their DB writes.
    try { await this.inFlight; }
    finally { await Promise.allSettled([...this.wakeWork.values(), ...this.committedWork.values()]); }
  }

  /** Direct postcommit wake of the SAME durable producer. It must not wait for
   * the global drain's unrelated verification/service activation. This map owns
   * only admitted work, not a queue; overflow remains in the durable outbox.
   * A caller may stop waiting, but an uncertain append remains owned here and
   * every retry still uses the original persisted batch bytes. */
  publishCommitted(collectionId: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error("policy emitter closed"));
    const existing = this.committedWork.get(collectionId);
    if (existing) return existing;
    if (this.committedWork.size >= MAX_BACKGROUND_WAKES) return Promise.reject(new Error("policy publication deferred"));
    const work = Promise.resolve().then(async () => {
      await this.drainCollection(collectionId);
      const pending = await this.db.query(
        `SELECT 1 FROM next_policy_outbox o LEFT JOIN next_policy_batches b ON b.id=o.batch_id
         WHERE o.collection_id=$1 AND (o.batch_id IS NULL OR b.state<>'appended' OR b.lost_at IS NOT NULL) LIMIT 1`, [collectionId]
      );
      if (pending.rows.length) throw new Error("policy publication deferred");
    }).finally(() => { if (this.committedWork.get(collectionId) === work) this.committedWork.delete(collectionId); });
    this.committedWork.set(collectionId, work);
    return work;
  }

  private wakeCommittedCollection(collectionId: string): void {
    if (this.closed || this.wakeWork.has(collectionId) || this.wakeWork.size >= MAX_BACKGROUND_WAKES) return;
    // Only a wake hint, not activation/keying evidence. The original callback
    // retains its 30s transport/body bound and captured-batch ACK/CAS protections.
    const work = Promise.resolve().then(() => this.activateServices(collectionId))
      .catch(error => this.reportFailure(error, collectionId))
      .finally(() => { if (this.wakeWork.get(collectionId) === work) this.wakeWork.delete(collectionId); });
    this.wakeWork.set(collectionId, work);
    // The failure was delivered to onError; a throwing diagnostic callback must
    // not create an unhandled rejection or fail an already committed append.
    void work.catch(() => undefined);
  }

  /** Append everything pending for every collection; returns the number of items appended. */
  async drain(): Promise<number> {
    if (this.closed) throw new Error("policy emitter closed");
    while (this.inFlight) await this.inFlight;
    if (this.closed) throw new Error("policy emitter closed");
    const run = this.drainAll();
    this.inFlight = run;
    try {
      return await run;
    } finally {
      if (this.inFlight === run) this.inFlight = undefined;
    }
  }

  private async drainAll(): Promise<number> {
    // New deliveries never sit behind routine historical verification.
    let appended = await this.drainPending();
    const due = this.now() - this.lastVerificationAt >= 60_000;
    const checks = due ? await this.db.query<{ collection_id: string }>(
      "SELECT DISTINCT collection_id FROM next_policy_batches WHERE state = 'appended' AND lost_at IS NULL"
    ) : { rows: [] };
    if (due) this.lastVerificationAt = this.now();
    for (const { collection_id: id } of checks.rows) {
      if (!this.verificationQueue.has(id)) this.verificationQueue.set(id, { after: "0" });
    }
    // Rotate collection probes within a time/item budget, rather than stretching
    // a sweep across one poll per batch. An in-progress RPC/full loss recovery
    // retains its existing deadline and atomicity; do not cancel it mid-flight.
    const started = performance.now(), failed = new Set<string>();
    let recovered = false;
    for (let probes = 0; probes < MAX_VERIFICATION_PROBES && performance.now() - started < VERIFICATION_BUDGET_MS; probes++) {
      const next = this.verificationQueue.entries().next().value;
      if (!next) break;
      const [collectionId, cursor] = next;
      this.verificationQueue.delete(collectionId);
      if (failed.has(collectionId)) { this.verificationQueue.set(collectionId, cursor); continue; }
      try {
        const reissues = await recoverLostPolicy(this.db, this.log, collectionId, cursor);
        recovered ||= reissues > 0 || cursor === undefined;
        if (cursor && cursor.after !== "0" && !this.verificationQueue.has(collectionId)) this.verificationQueue.set(collectionId, cursor);
      } catch (error) {
        failed.add(collectionId);
        if (!this.verificationQueue.has(collectionId)) this.verificationQueue.set(collectionId, undefined);
        this.reportFailure(error, collectionId, "recover");
      }
    }
    if (recovered) appended += await this.drainPending();
    // Durable service-device rows select only verified appended genesis batches.
    // Retry activation even when there was no new policy work this poll.
    await this.activateServices();
    return appended;
  }

  private async drainPending(): Promise<number> {
    const collections = await this.db.query<{ collection_id: string }>(
      `SELECT collection_id FROM next_policy_outbox WHERE batch_id IS NULL
       UNION SELECT collection_id FROM next_policy_batches WHERE state = 'sending'`
    );
    let appended = 0;
    for (const { collection_id: collectionId } of collections.rows) {
      if (this.verificationQueue.has(collectionId) && this.verificationQueue.get(collectionId) === undefined) continue;
      try {
        appended += await this.drainCollection(collectionId);
      } catch (error) {
        this.reportFailure(error, collectionId);
      }
    }
    return appended;
  }

  /** Append the collection's pending items in order until it is idle, blocked or must retry. */
  async drainCollection(collectionId: string): Promise<number> {
    if (this.closed) throw new Error("policy emitter closed");
    let appended = 0;
    let rebuilds = 0;
    for (;;) {
      const outcome = await this.step(collectionId);
      if (outcome === "appended") {
        appended += 1;
        // step() released the policy lock and committed this original batch.
        // Wake in owned background work; enrollment still verifies exact appended
        // bytes/current principal, and SDK first-read/keying gates remain intact.
        this.wakeCommittedCollection(collectionId);
      }
      else if (outcome !== "rebuild" || ++rebuilds > MAX_REBUILDS) return appended;
    }
  }

  private step(collectionId: string): Promise<DrainOutcome> {
    return withPolicyLock(this.db, collectionId, lock => this.sendStep(lock, collectionId));
  }

  private async sendStep(lock: PolicyLock, collectionId: string): Promise<DrainOutcome> {
    const batch = await this.claim(lock, collectionId);
    if (batch === "idle" || batch === "blocked") return batch;
    const seq = Number(batch.seq);
    try {
      // No send decision after loss of this physical session's ownership. If it
      // dies DURING the request, the original persisted bytes remain uncertain;
      // only a live successor may acknowledge their idempotent retry.
      await lock.assertOwned();
      if (seq === 1) {
        // The genesis row is the collection's first outbox row.
        const genesis = (await lock.query<{ id: string; ops: unknown }>(
          "SELECT id, ops FROM next_policy_outbox WHERE collection_id = $1 ORDER BY id LIMIT 1", [collectionId]
        )).rows[0];
        const { region } = await this.log.createLog(collectionId, batch.item, storedPlacement(genesis?.ops));
        // Recorded before the batch counts as appended, so activation (which waits for
        // an appended genesis) always sees it. A retry answers the same stored region.
        if (region && genesis) {
          await lock.assertOwned();
          await lock.query("UPDATE next_policy_outbox SET ops = jsonb_set(ops, '{region}', to_jsonb($2::text)) WHERE id = $1", [genesis.id, region]);
        }
      } else {
        const result = await this.log.append(collectionId, seq, batch.prev, [batch.item]);
        if (result.kind === "head-moved") {
          await this.release(lock, batch.id);
          return "rebuild";
        }
        if (result.kind === "duplicate") throw new LogServiceError("invalid", "duplicate");
      }
    } catch (error) {
      await lock.assertOwned();
      if (error instanceof LogServiceError && !error.retryable) {
        await lock.query("UPDATE next_policy_batches SET state = 'parked', error = $2, attempts = attempts + 1 WHERE id = $1 AND state = 'sending'", [batch.id, error.message]);
      } else {
        await lock.query("UPDATE next_policy_batches SET attempts = attempts + 1, error = $2 WHERE id = $1 AND state = 'sending'", [batch.id, String((error as Error).message ?? error)]);
      }
      throw error;
    }
    await lock.assertOwned();
    await lock.query("UPDATE next_policy_batches SET state = 'appended', appended_at = now(), error = NULL WHERE id = $1 AND state = 'sending'", [batch.id]);
    return "appended";
  }

  /** One item per lost batch, before fresh policy work; never coalesce reissues. */
  private async pending(lock: PolicyLock, collectionId: string): Promise<Array<{ id: string; ops: unknown; reissue_of: string | null }>> {
    const recovery = await lock.query<{ id: string; ops: unknown; reissue_of: string }>(
      `SELECT id, ops, reissue_of FROM next_policy_outbox WHERE collection_id = $1 AND batch_id IS NULL
       AND reissue_of IS NOT NULL ORDER BY reissue_of LIMIT 1`, [collectionId]
    );
    if (recovery.rows.length) return recovery.rows;
    return (await lock.query<{ id: string; ops: unknown; reissue_of: null }>(
      `SELECT id, ops, reissue_of FROM next_policy_outbox WHERE collection_id = $1 AND batch_id IS NULL
       AND reissue_of IS NULL ORDER BY id LIMIT $2`, [collectionId, MAX_ROWS_PER_ITEM]
    )).rows;
  }

  /** Return the immutable open batch, or persist a new one before sending. */
  private async claim(lock: PolicyLock, collectionId: string): Promise<Batch | "idle" | "blocked"> {
    const open = await lock.query<Batch & { state: string }>(
      "SELECT id, seq, prev, item, state FROM next_policy_batches WHERE collection_id = $1 AND state <> 'appended' ORDER BY id LIMIT 1", [collectionId]
    );
    if (open.rows[0]) return open.rows[0].state === "parked" ? "blocked" : open.rows[0];
    const preview = await this.pending(lock, collectionId);
    if (!preview.length) return "idle";
    const genesis = deserializeOps(preview[0]!.ops)[0]?.op === "genesis";
    const head = genesis ? { seq: 0, chain: ZERO_CHAIN } : await this.log.head(collectionId);

    await lock.query("BEGIN");
    try {
      await lock.assertOwned();
      const collection = await lock.query<{ last_issued_at: string; root_key_id: Buffer }>(
        "SELECT last_issued_at, root_key_id FROM next_collections WHERE collection_id = $1 FOR NO KEY UPDATE", [collectionId]
      );
      const row = collection.rows[0];
      if (!row) { await lock.query("ROLLBACK"); return "idle"; }
      // Queue writers may commit while the head is in flight. Reload their
      // stored ops under the row lock, without keeping a transaction over I/O.
      const pending = await this.pending(lock, collectionId);
      if (!pending.length) { await lock.commit(); return "idle"; }
      const ops = pending.flatMap(entry => deserializeOps(entry.ops));
      if ((ops[0]?.op === "genesis") !== genesis) throw new Error("policy claim changed during head read");
      const previousIssuedAt = Number(row.last_issued_at);
      const issuedAt = Math.max(this.now(), previousIssuedAt + 1);
      const seq = head.seq + 1;
      let item: Uint8Array;
      try {
        if (!Buffer.from(row.root_key_id).equals(Buffer.from(this.signer.cert.root))) {
          throw new Error("the configured policy key is certified by a different root than this collection's");
        }
        item = signPolicyItem(this.signer, { collection: collectionId, seq, prev: head.chain, issuedAt, previousIssuedAt, ops });
      } catch (error) {
        const reissue = pending[0]!.reissue_of;
        if (reissue === null) throw error;
        await lock.query("UPDATE next_policy_batches SET state = 'parked', error = $2 WHERE id = $1", [reissue, String((error as Error).message)]);
        await lock.commit();
        return "blocked";
      }
      const inserted = await lock.query<{ id: string }>(
        `INSERT INTO next_policy_batches (collection_id, seq, prev, item, issued_at, state)
         VALUES ($1, $2, $3, $4, $5, 'sending') RETURNING id`,
        [collectionId, seq, Buffer.from(head.chain), Buffer.from(item), issuedAt]
      );
      const batchId = inserted.rows[0]!.id;
      await lock.query("UPDATE next_policy_outbox SET batch_id = $1 WHERE id = ANY($2::bigint[])", [batchId, pending.map(entry => entry.id)]);
      await lock.query("UPDATE next_collections SET last_issued_at = $2 WHERE collection_id = $1", [collectionId, issuedAt]);
      await lock.commit();
      return { id: batchId, seq: String(seq), prev: Buffer.from(head.chain), item: Buffer.from(item) };
    } catch (error) {
      await lock.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  /** The log moved past this item's position without it: return its ops to the queue. */
  private async release(lock: PolicyLock, batchId: string): Promise<void> {
    await lock.query("BEGIN");
    try {
      await lock.assertOwned();
      await lock.query("UPDATE next_policy_outbox SET batch_id = NULL WHERE batch_id = $1", [batchId]);
      await lock.query("DELETE FROM next_policy_batches WHERE id = $1 AND state = 'sending'", [batchId]);
      await lock.commit();
    } catch (error) {
      await lock.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }
}
