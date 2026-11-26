import { setTimeout as sleep } from "node:timers/promises";
import type { DatabasePool } from "../../db.js";
import { usageReport } from "./usage-report.js";

// Pushes the operator usage report (docs/usage-report.md) to the operations
// metrics ingest, replacing the cloud-ops job that ran `usage report` through
// Render every six hours. The body is what `usage report --days N` prints,
// less the per-signup list. Each snapshot writes hundreds of rollup rows, so the cadence stays
// at four fixed UTC slots.

export interface OpsMetricsPushConfig {
  /** Full HTTPS URL of the ingest's /v1/snapshots route. */
  url: string;
  token: string;
}

interface OpsMetricsLogger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
}

export const OPS_METRICS_WINDOWS = [1, 7, 30, 90] as const;

const MINUTE_MS = 60 * 1_000;
const SLOT_PERIOD_MS = 6 * 60 * MINUTE_MS;
// 00:40, 06:40, 12:40 and 18:40 UTC.
const SLOT_OFFSET_MS = 40 * MINUTE_MS;
// "mdba", "opsm": one session lock across every server instance.
const PUSH_LOCK = [1835295329, 1869640557] as const;
// The winner holds the lock until this long after the slot, and an instance
// that acquires it later skips the slot, so instances whose timers fire a
// little apart cannot both push it.
const LOCK_HOLD_MS = 2 * MINUTE_MS;
const REQUEST_TIMEOUT_MS = 30_000;
const ATTEMPTS_PER_WINDOW = 2;
const RETRY_DELAY_MS = 5_000;

/** First push slot strictly after `afterMs`; a slot already reached is past. */
export function nextOpsMetricsSlot(afterMs: number): number {
  return Math.floor((afterMs - SLOT_OFFSET_MS) / SLOT_PERIOD_MS) * SLOT_PERIOD_MS
    + SLOT_OFFSET_MS + SLOT_PERIOD_MS;
}

/**
 * The push is best effort, so its configuration never stops the server: a
 * value it cannot use leaves it off with a reason naming the variable, never
 * its value.
 */
export type OpsMetricsPushSetting =
  | { enabled: true; config: OpsMetricsPushConfig }
  | { enabled: false; reason: string | null };

export function opsMetricsPushSetting(
  env: NodeJS.ProcessEnv,
  environment: string
): OpsMetricsPushSetting {
  const url = env.OPS_METRICS_INGEST_URL?.trim() ?? "";
  const token = env.OPS_METRICS_INGEST_TOKEN?.trim() ?? "";
  if (!url && !token) return { enabled: false, reason: null };
  if (!url) return { enabled: false, reason: "OPS_METRICS_INGEST_URL is not set" };
  if (!token) return { enabled: false, reason: "OPS_METRICS_INGEST_TOKEN is not set" };
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    // Reported below.
  }
  if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    return {
      enabled: false,
      reason: "OPS_METRICS_INGEST_URL must be an HTTPS URL without credentials or a fragment"
    };
  }
  if (/\s/u.test(token)) {
    return { enabled: false, reason: "OPS_METRICS_INGEST_TOKEN contains whitespace" };
  }
  // The report carries no environment, and the ingest files such snapshots
  // under production. Another environment would overwrite production's rows.
  if (environment !== "production") {
    return { enabled: false, reason: "MDBASE_CONNECT_ENVIRONMENT is not production" };
  }
  return { enabled: true, config: { url, token } };
}

/**
 * The pushed body: the operator report without `beta.recent_signups`, the one
 * per-signup list, which the ingest discards.
 */
export function opsMetricsSnapshot(report: unknown): unknown {
  const snapshot = report as { beta?: { recent_signups?: unknown } };
  if (snapshot.beta) delete snapshot.beta.recent_signups;
  return snapshot;
}

interface OpsMetricsPushOptions {
  db: DatabasePool;
  config: OpsMetricsPushConfig;
  log: OpsMetricsLogger;
  now?: () => number;
  lockHoldMs?: number;
  retryDelayMs?: number;
  requestTimeoutMs?: number;
}

type PostOutcome =
  | { ok: true; status: number }
  | { ok: false; retryable: boolean; status?: number; errorClass?: string };

export class OpsMetricsPushWorker {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> | null = null;
  private readonly closing = new AbortController();
  private readonly now: () => number;

  constructor(private readonly options: OpsMetricsPushOptions) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer || this.closing.signal.aborted) return;
    this.schedule(this.now());
  }

  async close(): Promise<void> {
    this.closing.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** Pushes every window for `slot` unless another instance holds the slot. */
  async pushSlot(slot: number): Promise<"pushed" | "skipped"> {
    let connection;
    try {
      connection = await this.options.db.connect();
    } catch (error) {
      this.options.log.warn({ error_class: errorClass(error) }, "ops metrics push could not reach the database");
      return "skipped";
    }
    let locked = false;
    try {
      const lock = await connection.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1, $2) AS acquired",
        [...PUSH_LOCK]
      );
      locked = lock.rows[0]?.acquired === true;
      if (!locked) return "skipped";
      const holdUntil = slot + (this.options.lockHoldMs ?? LOCK_HOLD_MS);
      if (this.now() >= holdUntil) {
        this.options.log.warn({ slot: new Date(slot).toISOString() }, "ops metrics push slot missed");
        return "skipped";
      }
      for (const days of OPS_METRICS_WINDOWS) {
        if (this.closing.signal.aborted) break;
        await this.pushWindow(days);
      }
      await this.pause(holdUntil - this.now());
      return "pushed";
    } catch (error) {
      this.options.log.warn({ error_class: errorClass(error) }, "ops metrics push failed");
      return "skipped";
    } finally {
      if (locked) {
        await connection.query("SELECT pg_advisory_unlock($1, $2)", [...PUSH_LOCK]).catch(() => undefined);
      }
      connection.release();
    }
  }

  private schedule(after: number): void {
    const slot = nextOpsMetricsSlot(after);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.pushSlot(slot).finally(() => {
        this.running = null;
        if (!this.closing.signal.aborted) this.schedule(Math.max(this.now(), slot));
      });
    }, slot - this.now());
    this.timer.unref();
  }

  private async pushWindow(days: number): Promise<void> {
    let body: string;
    try {
      body = JSON.stringify(opsMetricsSnapshot(await usageReport(
        ["--days", String(days)],
        { db: this.options.db },
        (message) => { throw new Error(message); }
      )));
    } catch (error) {
      this.options.log.warn({ window_days: days, error_class: errorClass(error) }, "ops metrics report failed");
      return;
    }
    for (let attempt = 1; ; attempt += 1) {
      const outcome = await this.post(body);
      if (outcome.ok) {
        this.options.log.info({ window_days: days, status: outcome.status }, "ops metrics snapshot pushed");
        return;
      }
      if (!outcome.retryable || attempt >= ATTEMPTS_PER_WINDOW || this.closing.signal.aborted) {
        this.options.log.warn({
          window_days: days,
          attempts: attempt,
          ...(outcome.status === undefined ? {} : { status: outcome.status }),
          ...(outcome.errorClass === undefined ? {} : { error_class: outcome.errorClass })
        }, "ops metrics snapshot push failed");
        return;
      }
      await this.pause(this.options.retryDelayMs ?? RETRY_DELAY_MS);
    }
  }

  private async post(body: string): Promise<PostOutcome> {
    try {
      const response = await fetch(this.options.config.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.config.token}`,
          "content-type": "application/json"
        },
        body,
        // Never forward the bearer to another location.
        redirect: "error",
        signal: AbortSignal.any([
          AbortSignal.timeout(this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS),
          this.closing.signal
        ])
      });
      // The response may echo submitted figures; it is never read or logged.
      await response.body?.cancel().catch(() => undefined);
      if (response.ok) return { ok: true, status: response.status };
      return {
        ok: false,
        status: response.status,
        retryable: response.status === 429 || response.status >= 500
      };
    } catch (error) {
      return { ok: false, retryable: true, errorClass: errorClass(error) };
    }
  }

  private async pause(ms: number): Promise<void> {
    if (ms <= 0) return;
    await sleep(ms, undefined, { signal: this.closing.signal, ref: false }).catch(() => undefined);
  }
}

// Error messages can carry URLs or SQL; only the class is logged.
function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
