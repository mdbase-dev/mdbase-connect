import { createHash } from "node:crypto";
import type { DatabasePool, DatabaseQueryable } from "../../../database-types.js";
import { insertNotificationSignal } from "../../../notifications.js";
import {
  dataPermitted,
  grantMayFire,
  legacyTimerGrantResolver,
  type TimerGrantResolver
} from "./grants.js";
import { cancelRevokedGrantTimers } from "./store.js";

/**
 * Fires due timers and hands each fired generation to consumers through the
 * fired-timer event (`next_timer_events`), the timer service's single output.
 */

/**
 * Events, receipts and fired or cancelled timers are a history of reminder
 * times: for local and end-to-end collections, the only data mdbase holds about
 * them. Keep them only for a short debug window (SEC-043 §2).
 */
export const EVENT_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** The data of `mdbase.runtime.timer.fired@1.0.0`, plus routing fields. */
export interface TimerFiredEvent {
  event_id: string;
  grant_id: string;
  criterion_id: string;
  namespace: string;
  timer_id: string;
  generation: number;
  scheduled_for: string;
  fired_at: string;
  late_by_ms: number;
  /** Non-null only for cloud-copy collections. */
  data: unknown;
}

/**
 * A consumer of fired-timer events. `handle` runs inside the transaction that
 * records the consumer's receipt, so each event is handled exactly once.
 */
export interface TimerEventConsumer {
  readonly name: string;
  handle(db: DatabaseQueryable, event: TimerFiredEvent): Promise<void>;
  /** Called after commits that handled at least one event. */
  afterCommit?(): void;
}

export function timerEventId(
  grantId: string,
  namespace: string,
  timerId: string,
  generation: number
): string {
  const generationBytes = Buffer.alloc(8);
  generationBytes.writeBigUInt64BE(BigInt(generation));
  const digest = createHash("sha256")
    .update("mdbase/v1/timer-signal")
    .update(lengthPrefixed(grantId))
    .update(lengthPrefixed(namespace))
    .update(lengthPrefixed(timerId))
    .update(generationBytes)
    .digest("base64url");
  return `tmr_${digest.slice(0, 32)}`;
}

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** Turns fired-timer events into opaque notification signals (push and webhooks). */
export function notificationsConsumer(wake: () => void): TimerEventConsumer {
  return {
    name: "notifications",
    async handle(db, event) {
      await insertNotificationSignal(db, {
        signalId: event.event_id,
        grantId: event.grant_id,
        criterionId: event.criterion_id,
        cursor: event.event_id
      });
    },
    afterCommit: wake
  };
}

interface DueRow {
  grant_id: string;
  namespace: string;
  timer_id: string;
  generation: number | string;
}

export class TimerWorker {
  private interval: NodeJS.Timeout | undefined;
  private running: Promise<void> | null = null;
  private queued: Promise<void> | null = null;
  private lastPrune = 0;

  constructor(
    private readonly db: DatabasePool,
    private readonly consumers: TimerEventConsumer[],
    private readonly options: {
      pollIntervalMs?: number;
      batchSize?: number;
      resolver?: TimerGrantResolver;
      onError?: (error: unknown) => void;
    } = {}
  ) {}

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.wake(), this.options.pollIntervalMs ?? 1_000);
    this.interval.unref();
    this.wake();
  }

  async close(): Promise<void> {
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
    await this.running;
  }

  /** Run one tick unless one is already running. */
  wake(): void {
    void this.tick().catch((error) => this.options.onError?.(error));
  }

  /**
   * Run a tick that starts after any running one. Calls made while a tick is
   * queued share it, so a burst of wakes costs at most one extra tick.
   */
  tick(): Promise<void> {
    if (this.queued) return this.queued;
    const previous = this.running ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => {
      this.queued = null;
      return this.performTick();
    });
    this.queued = next;
    const tracked = next.finally(() => {
      if (this.running === tracked) this.running = null;
    });
    this.running = tracked;
    return next;
  }

  private async performTick(): Promise<void> {
    await cancelRevokedGrantTimers(this.db);
    await this.fireDue();
    for (const consumer of this.consumers) await this.drainConsumer(consumer);
    await this.prune();
  }

  /** Fire every due timer, one transaction each. Returns the number fired. */
  async fireDue(): Promise<number> {
    const resolver = this.options.resolver ?? legacyTimerGrantResolver;
    const due = await this.db.query<DueRow>(
      `SELECT grant_id, namespace, timer_id, generation FROM next_timers
       WHERE status IN ('scheduled', 'firing') AND fire_at <= now()
       ORDER BY fire_at, grant_id, namespace, timer_id
       LIMIT $1`,
      [this.options.batchSize ?? 100]
    );
    let fired = 0;
    for (const row of due.rows) {
      const connection = await this.db.connect();
      try {
        await connection.query("BEGIN");
        // Compare-and-set on the generation. A concurrent worker blocks on the
        // row lock and then matches nothing.
        const claimed = await connection.query<{
          criterion_id: string;
          fire_at: Date | string;
          data: unknown;
          now: Date | string;
        }>(
          `UPDATE next_timers
           SET status = 'fired', fired_at = now(), updated_at = now()
           WHERE grant_id = $1 AND namespace = $2 AND timer_id = $3
             AND generation = $4 AND status IN ('scheduled', 'firing')
             AND fire_at <= now()
           RETURNING criterion_id, fire_at, data, now() AS now`,
          [row.grant_id, row.namespace, row.timer_id, Number(row.generation)]
        );
        const timer = claimed.rows[0];
        if (!timer) {
          await connection.query("ROLLBACK");
          continue;
        }
        const grant = await resolver.resolve(connection, row.grant_id);
        if (!grant || !grantMayFire(grant, timer.criterion_id)) {
          await connection.query(
            `UPDATE next_timers SET status = 'cancelled', fired_at = NULL
             WHERE grant_id = $1 AND namespace = $2 AND timer_id = $3`,
            [row.grant_id, row.namespace, row.timer_id]
          );
          await connection.query("COMMIT");
          continue;
        }
        const scheduledFor = new Date(timer.fire_at);
        const firedAt = new Date(timer.now);
        const generation = Number(row.generation);
        await connection.query(
          `INSERT INTO next_timer_events
             (event_id, grant_id, criterion_id, namespace, timer_id, generation,
              scheduled_for, fired_at, late_by_ms, data)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
           ON CONFLICT (event_id) DO NOTHING`,
          [
            timerEventId(row.grant_id, row.namespace, row.timer_id, generation),
            row.grant_id,
            timer.criterion_id,
            row.namespace,
            row.timer_id,
            generation,
            scheduledFor.toISOString(),
            firedAt.toISOString(),
            Math.max(0, firedAt.getTime() - scheduledFor.getTime()),
            dataPermitted(grant) && timer.data !== null && timer.data !== undefined
              ? JSON.stringify(timer.data)
              : null
          ]
        );
        await connection.query("COMMIT");
        fired += 1;
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
    }
    return fired;
  }

  /** Hand unhandled events to one consumer, oldest first. Returns events handled. */
  async drainConsumer(consumer: TimerEventConsumer, limit = 100): Promise<number> {
    const pending = await this.db.query<EventRow>(
      `SELECT e.event_id, e.grant_id, e.criterion_id, e.namespace, e.timer_id,
              e.generation, e.scheduled_for, e.fired_at, e.late_by_ms, e.data
       FROM next_timer_events e
       LEFT JOIN next_timer_event_receipts r
         ON r.event_id = e.event_id AND r.consumer = $1
       WHERE r.event_id IS NULL
       ORDER BY e.fired_at, e.event_id
       LIMIT $2`,
      [consumer.name, limit]
    );
    let handled = 0;
    for (const row of pending.rows) {
      const connection = await this.db.connect();
      try {
        await connection.query("BEGIN");
        const handledAlready = await connection.query(
          `SELECT event_id FROM next_timer_event_receipts
           WHERE consumer = $1 AND event_id = $2`,
          [consumer.name, row.event_id]
        );
        if (handledAlready.rows.length > 0) {
          await connection.query("ROLLBACK");
          continue;
        }
        const receipt = await connection.query(
          `INSERT INTO next_timer_event_receipts (consumer, event_id)
           VALUES ($1, $2)
           ON CONFLICT (consumer, event_id) DO NOTHING
           RETURNING event_id`,
          [consumer.name, row.event_id]
        );
        if (receipt.rows.length === 0) {
          await connection.query("ROLLBACK");
          continue;
        }
        await consumer.handle(connection, eventFromRow(row));
        await connection.query("COMMIT");
        handled += 1;
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally {
        connection.release();
      }
    }
    if (handled > 0) consumer.afterCommit?.();
    return handled;
  }

  /** Drop events older than the retention window that every consumer has handled. */
  async prune(now = Date.now()): Promise<void> {
    if (now - this.lastPrune < 60 * 60_000) return;
    this.lastPrune = now;
    await this.pruneTimers(now);
    if (this.consumers.length === 0) return;
    const old = await this.db.query<{ event_id: string }>(
      `SELECT event_id FROM next_timer_events WHERE created_at < $1
       ORDER BY created_at LIMIT 500`,
      [new Date(now - EVENT_RETENTION_MS).toISOString()]
    );
    if (old.rows.length === 0) return;
    const ids = old.rows.map((row) => row.event_id);
    const receipts = await this.db.query<{ event_id: string; consumer: string }>(
      `SELECT event_id, consumer FROM next_timer_event_receipts
       WHERE event_id IN (${placeholders(ids.length)})`,
      ids
    );
    const names = new Set(this.consumers.map((consumer) => consumer.name));
    const handled = new Map<string, Set<string>>();
    for (const row of receipts.rows) {
      if (!names.has(row.consumer)) continue;
      const set = handled.get(row.event_id) ?? new Set<string>();
      set.add(row.consumer);
      handled.set(row.event_id, set);
    }
    const done = ids.filter((id) => (handled.get(id)?.size ?? 0) === names.size);
    if (done.length > 0) {
      const list = placeholders(done.length);
      await this.db.query(`DELETE FROM next_timer_event_receipts WHERE event_id IN (${list})`, done);
      await this.db.query(`DELETE FROM next_timer_events WHERE event_id IN (${list})`, done);
    }
  }

  /** Delete fired and cancelled timers past the debug window. */
  private async pruneTimers(now: number): Promise<void> {
    await this.db.query(
      `DELETE FROM next_timers
       WHERE status IN ('fired', 'cancelled') AND updated_at < $1`,
      [new Date(now - EVENT_RETENTION_MS).toISOString()]
    );
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, (_, i) => `$${i + 1}`).join(", ");
}

interface EventRow {
  event_id: string;
  grant_id: string;
  criterion_id: string;
  namespace: string;
  timer_id: string;
  generation: number | string;
  scheduled_for: Date | string;
  fired_at: Date | string;
  late_by_ms: number | string;
  data: unknown;
}

function eventFromRow(row: EventRow): TimerFiredEvent {
  return {
    event_id: row.event_id,
    grant_id: row.grant_id,
    criterion_id: row.criterion_id,
    namespace: row.namespace,
    timer_id: row.timer_id,
    generation: Number(row.generation),
    scheduled_for: new Date(row.scheduled_for).toISOString(),
    fired_at: new Date(row.fired_at).toISOString(),
    late_by_ms: Number(row.late_by_ms),
    data: row.data ?? null
  };
}
