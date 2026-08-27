import { randomUUID } from "node:crypto";
import type { ApplicationNotifications, ApplicationRequirements } from "@mdbase-dev/connect-protocol";
import type { DatabasePool } from "./db.js";
import type { HostedProviderClient } from "./hosted-provider.js";
import type { RelayHub } from "./relay.js";
import { reconcileApplicationGrants } from "./features/grants/service.js";

const PAGE_SIZE = 50;
const MAX_PAGES_PER_DRAIN = 4;
const SWEEP_MS = 6 * 60 * 60_000;

export async function ensureApplicationReconciliation(
  db: DatabasePool,
  applicationId: string
): Promise<void> {
  await db.query(
    `INSERT INTO application_reconciliation_jobs (application_id)
     VALUES ($1) ON CONFLICT (application_id) DO NOTHING`,
    [applicationId]
  );
}

type Application = {
  id: string;
  family_identity: string;
  manifest_digest: string;
  requirements: ApplicationRequirements;
  notifications: ApplicationNotifications;
};

export class ApplicationReconciliationWorker {
  private timer?: NodeJS.Timeout;
  private running = false;
  private closing = false;

  constructor(
    private readonly db: DatabasePool,
    private readonly relay: RelayHub,
    private readonly provider?: HostedProviderClient,
    private readonly onError: (error: unknown) => void = () => undefined,
    private readonly intervalMs = 30_000
  ) {}

  start(): void {
    if (this.timer) return;
    void this.scheduleSweep().then(() => this.drain()).catch(this.onError);
    this.timer = setInterval(() => {
      void this.scheduleSweep().then(() => this.drain()).catch(this.onError);
    }, this.intervalMs);
    this.timer.unref();
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  async scheduleSweep(): Promise<void> {
    await this.db.query(
      `INSERT INTO application_reconciliation_jobs (application_id)
       SELECT id FROM applications ON CONFLICT (application_id) DO NOTHING`
    );
    await this.db.query(
      `UPDATE application_reconciliation_jobs
       SET state = 'pending', available_at = now(), cursor_grant_id = NULL,
           updated_at = now()
       WHERE state = 'completed' AND next_scan_at <= now()`
    );
  }

  async drain(): Promise<void> {
    if (this.running || this.closing) return;
    this.running = true;
    try {
      for (let page = 0; page < MAX_PAGES_PER_DRAIN; page += 1) {
        const claimed = await this.claim();
        if (!claimed) break;
        await this.process(claimed);
      }
    } finally {
      this.running = false;
    }
  }

  private async claim(): Promise<{ application: Application; token: string; cursor: string | null } | null> {
    const token = randomUUID();
    const result = await this.db.query<Application & { lease_token: string; cursor_grant_id: string | null }>(
      `WITH candidate AS (
         SELECT application_id FROM application_reconciliation_jobs
         WHERE available_at <= now()
           AND (state = 'pending' OR (state = 'leased' AND lease_expires_at <= now()))
         ORDER BY available_at, application_id LIMIT 1 FOR UPDATE SKIP LOCKED
       ), claimed AS (
         UPDATE application_reconciliation_jobs j
         SET state = 'leased', lease_token = $1,
             lease_expires_at = now() + interval '5 minutes',
             attempts = attempts + 1, updated_at = now()
         FROM candidate c WHERE j.application_id = c.application_id
         RETURNING j.application_id, j.lease_token, j.cursor_grant_id
       )
       SELECT a.id, a.family_identity, a.manifest_digest, a.requirements,
              a.notifications, c.lease_token, c.cursor_grant_id
       FROM claimed c JOIN applications a ON a.id = c.application_id`,
      [token]
    );
    const row = result.rows[0];
    return row ? { application: row, token, cursor: row.cursor_grant_id } : null;
  }

  private async process(claimed: { application: Application; token: string; cursor: string | null }): Promise<void> {
    const grants = await this.db.query<{ id: string }>(
      `SELECT id FROM grants WHERE application_id = $1 AND revoked_at IS NULL
         AND activated_at IS NOT NULL AND ($2::uuid IS NULL OR id > $2)
       ORDER BY id LIMIT $3`,
      [claimed.application.id, claimed.cursor, PAGE_SIZE]
    );
    let failures = 0;
    let errorClass: string | null = null;
    for (const grant of grants.rows) {
      const renewed = await this.db.query(
        `UPDATE application_reconciliation_jobs
         SET lease_expires_at = now() + interval '5 minutes', updated_at = now()
         WHERE application_id = $1 AND lease_token = $2 AND state = 'leased'
         RETURNING application_id`,
        [claimed.application.id, claimed.token]
      );
      if (!renewed.rows[0]) return;
      try {
        await reconcileApplicationGrants(
          this.db, this.relay, this.provider, claimed.application, grant.id
        );
      } catch (error) {
        failures += 1;
        errorClass = classifyError(error);
        this.onError(error);
      }
    }
    const cursor = grants.rows.at(-1)?.id ?? claimed.cursor;
    const complete = grants.rows.length < PAGE_SIZE;
    const retrySeconds = Math.min(3600, 30 * (2 ** Math.min(6, failures)));
    await this.db.query(
      complete
        ? `UPDATE application_reconciliation_jobs
           SET state = $3, lease_token = NULL, lease_expires_at = NULL,
               cursor_grant_id = NULL, failure_count = failure_count + $4,
               last_error_class = $5, last_completed_at = CASE WHEN $4 = 0 THEN now() ELSE last_completed_at END,
               next_scan_at = CASE WHEN $4 = 0 THEN now() + interval '6 hours' ELSE next_scan_at END,
               available_at = CASE WHEN $4 = 0 THEN now() + interval '6 hours'
                                   ELSE now() + ($6 * interval '1 second') END,
               updated_at = now()
           WHERE application_id = $1 AND lease_token = $2`
        : `UPDATE application_reconciliation_jobs
           SET state = 'pending', lease_token = NULL, lease_expires_at = NULL,
               cursor_grant_id = $7, failure_count = failure_count + $4,
               last_error_class = $5, available_at = now(), updated_at = now()
           WHERE application_id = $1 AND lease_token = $2`,
      complete
        ? [claimed.application.id, claimed.token, failures === 0 ? "completed" : "pending",
            failures, errorClass, retrySeconds]
        : [claimed.application.id, claimed.token, failures === 0 ? "completed" : "pending",
            failures, errorClass, retrySeconds, cursor]
    );
  }
}

function classifyError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError" || /timeout/i.test(error.message)) return "timeout";
    if (/provider/i.test(error.message)) return "provider";
    if (/relay/i.test(error.message)) return "relay";
  }
  return "internal";
}
