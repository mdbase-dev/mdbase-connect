import type { DatabasePool } from "./db.js";

// Rows the operator usage report reads (docs/usage-report.md) are linked to an
// account. They are kept for a bounded window after they stop mattering to
// authorization, then deleted. Account deletion still cascades immediately.
export const USAGE_RETENTION_DAYS = 395;
const DAY_MS = 24 * 60 * 60 * 1_000;

export interface UsageRetentionResult {
  protocol_usage_telemetry: number;
  access_tokens: number;
  refresh_tokens: number;
  authorization_requests: number;
  pairing_requests: number;
}

export async function pruneUsageHistory(
  db: DatabasePool,
  now = new Date()
): Promise<UsageRetentionResult> {
  const cutoff = new Date(now.getTime() - USAGE_RETENTION_DAYS * DAY_MS);
  const deleted = async (sql: string) =>
    (await db.query(sql, [cutoff])).rowCount ?? 0;
  return {
    protocol_usage_telemetry: await deleted(
      "DELETE FROM protocol_usage_telemetry WHERE last_seen_at < $1"
    ),
    access_tokens: await deleted(
      "DELETE FROM access_tokens WHERE expires_at < $1"
    ),
    refresh_tokens: await deleted(
      "DELETE FROM refresh_tokens WHERE expires_at < $1"
    ),
    // A request that produced a grant stays with that grant.
    authorization_requests: await deleted(
      "DELETE FROM authorization_requests WHERE expires_at < $1 AND grant_id IS NULL"
    ),
    pairing_requests: await deleted(
      "DELETE FROM pairing_requests WHERE expires_at < $1"
    )
  };
}

export class UsageRetentionWorker {
  private timer: NodeJS.Timeout | undefined;
  private pruning: Promise<unknown> | null = null;

  constructor(
    private readonly db: DatabasePool,
    private readonly onError: (error: unknown) => void,
    private readonly intervalMs = DAY_MS
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.pruneOnce(), this.intervalMs);
    this.timer.unref();
    this.pruneOnce();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.pruning;
  }

  private pruneOnce(): void {
    if (this.pruning) return;
    this.pruning = pruneUsageHistory(this.db)
      .catch(this.onError)
      .finally(() => {
        this.pruning = null;
      });
  }
}
