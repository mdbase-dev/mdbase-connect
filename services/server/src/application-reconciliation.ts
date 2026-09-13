import type { ApplicationNotifications } from "@mdbase-dev/connect-protocol";
import type { ApplicationRequirements } from "./application-requirements.js";
import type { DatabasePool } from "./db.js";
import {
  ApplicationAuthorizationError,
  MalformedPersistedApplicationAuthorizationError
} from "./application-authorization.js";
import { HostedProviderResponseError, HostedProviderUnavailableError, type HostedProviderClient } from "./hosted-provider.js";
import { RelayUnavailableError } from "./relay-errors.js";
import type { RelayHub } from "./relay.js";
import { reconcileApplicationGrants } from "./features/grants/service.js";
import { claimApplicationReconciliationJob } from "./application-reconciliation-claim.js";

export const RECONCILIATION_TIMING = {
  pollMs: 30_000,
  seedMs: 6 * 60 * 60_000,
  scanMs: 6 * 60 * 60_000,
  // Hosted calls can consume three 15s attempts plus retry delay (~45.3s).
  // Relay calls are bounded at 5s. Keep a wide margin above both native bounds.
  leaseMs: 120_000,
  heartbeatMs: 20_000,
  closeMs: 1_000,
  retryBaseMs: 30_000,
  retryMaxMs: 60 * 60_000,
  quarantineProbeMs: 7 * 24 * 60 * 60_000
} as const;
const PAGE_SIZE = 50;
const MAX_APPLICATIONS_PER_DRAIN = 4;
/** Deterministic bad proofs/ownership are quarantined after this many observations. */
export const PERMANENT_QUARANTINE_ATTEMPTS = 3;

export type ReconciliationEvent = {
  phase: "seed" | "claim" | "scan" | "retry" | "lease";
  errorClass: ErrorClass;
};
type ErrorClass = "timeout" | "provider" | "relay" | "malformed_proof" | "ownership" | "internal";
type Application = {
  id: string; family_identity: string; manifest_digest: string;
  requirements: ApplicationRequirements; notifications: ApplicationNotifications;
};
type Claim = { application: Application; token: string; cursor: string | null; phase: "scan" | "retry" };
type WorkerTiming = Pick<typeof RECONCILIATION_TIMING,
  "leaseMs" | "heartbeatMs" | "closeMs" | "retryBaseMs" | "retryMaxMs" | "quarantineProbeMs" | "scanMs">;
type Reconcile = typeof reconcileApplicationGrants;

export async function ensureApplicationReconciliation(db: { query: DatabasePool["query"] }, applicationId: string): Promise<void> {
  await db.query(`INSERT INTO application_reconciliation_jobs (application_id)
    VALUES ($1) ON CONFLICT (application_id) DO NOTHING`, [applicationId]);
}

export class ApplicationReconciliationWorker {
  private pollTimer?: NodeJS.Timeout;
  private seedTimer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private closing = false;

  constructor(
    private readonly db: DatabasePool,
    private readonly relay: RelayHub,
    private readonly provider?: HostedProviderClient,
    private readonly onEvent: (event: ReconciliationEvent) => void = () => undefined,
    private readonly pollMs = RECONCILIATION_TIMING.pollMs,
    private readonly seedMs = RECONCILIATION_TIMING.seedMs,
    private readonly reconcile: Reconcile = reconcileApplicationGrants,
    private readonly timing: WorkerTiming = RECONCILIATION_TIMING
  ) {}

  start(): void {
    if (this.pollTimer) return;
    void this.seedMissingJobs().then(() => this.drain()).catch((e) => this.emit("seed", e));
    this.pollTimer = setInterval(() => void this.drain().catch((e) => this.emit("claim", e)), this.pollMs);
    this.seedTimer = setInterval(() => void this.seedMissingJobs().catch((e) => this.emit("seed", e)), this.seedMs);
    this.pollTimer.unref(); this.seedTimer.unref();
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.seedTimer) clearInterval(this.seedTimer);
    this.pollTimer = undefined; this.seedTimer = undefined;
    if (this.running) await Promise.race([this.running, delay(this.timing.closeMs)]);
  }

  /** Deterministic test/administration hook: no timers and no sleeps. */
  async drainUntilIdle(maxCycles = 100): Promise<void> {
    if (this.running) await this.running;
    for (let i = 0; i < maxCycles; i += 1) {
      let count = 0;
      this.running = this.drainOnce().then((value) => { count = value; }).finally(() => {
        this.running = undefined;
      });
      await this.running;
      if (count === 0) return;
    }
    throw new Error("reconciliation drain did not become idle");
  }

  async seedMissingJobs(): Promise<void> {
    await this.db.query(`INSERT INTO application_reconciliation_jobs (application_id)
      SELECT id FROM applications ON CONFLICT (application_id) DO NOTHING`);
    await this.db.query(`UPDATE application_reconciliation_jobs
      SET state='pending', phase='scan', available_at=now(), cursor_grant_id=NULL, updated_at=now()
      WHERE state='completed' AND next_scan_at <= now()`);
  }

  async drain(): Promise<void> {
    if (this.running || this.closing) return this.running;
    this.running = this.drainOnce().then(() => undefined).finally(() => { this.running = undefined; });
    return this.running;
  }

  private async drainOnce(): Promise<number> {
    if (this.closing) return 0;
    const handled = new Set<string>();
    for (let i = 0; i < MAX_APPLICATIONS_PER_DRAIN && !this.closing; i += 1) {
      const claim = await this.claim([...handled]);
      if (!claim) break;
      handled.add(claim.application.id);
      await this.process(claim);
    }
    return handled.size;
  }

  private async claim(excluded: string[]): Promise<Claim | null> {
    const claimed = await claimApplicationReconciliationJob(
      this.db, excluded, this.timing.leaseMs
    );
    if (!claimed) return null;
    const application = (await this.db.query<Application>(`SELECT id,family_identity,manifest_digest,
      requirements,notifications FROM applications WHERE id=$1`, [claimed.applicationId])).rows[0];
    return application ? {
      application,
      token: claimed.token,
      cursor: claimed.cursorGrantId,
      phase: claimed.phase
    } : null;
  }

  private async process(claim: Claim): Promise<void> {
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      if (this.closing) return;
      void this.renew(claim).then((ok) => { leaseLost ||= !ok; }).catch((e) => {
        leaseLost = true; this.emit("lease", e);
      });
    }, this.timing.heartbeatMs);
    heartbeat.unref();
    try {
      await this.clearInactiveResults(claim);
      const grants = claim.phase === "scan" ? await this.scanPage(claim) : await this.retryPage(claim);
      for (const grant of grants) {
        if (this.closing || leaseLost || !(await this.renew(claim))) return;
        try {
          // Dependencies own their abortable network bounds. Do not abandon a live
          // call with Promise.race: doing so permits a second worker to overlap it.
          await this.reconcile(this.db, this.relay, this.provider, claim.application, grant.id);
          if (this.closing || !(await this.renew(claim))) return;
          await this.db.query(`DELETE FROM application_reconciliation_results
            WHERE application_id=$1 AND grant_id=$2
              AND EXISTS (SELECT 1 FROM application_reconciliation_jobs
                WHERE application_id=$1 AND lease_token=$3 AND state='leased')`,
          [claim.application.id, grant.id, claim.token]);
        } catch (error) {
          const errorClass = classifyError(error);
          if (this.closing || !(await this.renew(claim))) return;
          const noisy = await this.recordFailure(claim, grant.id, errorClass);
          if (noisy) this.onEvent({ phase: claim.phase, errorClass });
        }
      }
      if (leaseLost) return;
      await this.advance(claim, grants);
    } finally { clearInterval(heartbeat); }
  }

  private async scanPage(claim: Claim): Promise<Array<{ id: string }>> {
    return (await this.db.query<{ id: string }>(`SELECT g.id FROM grants g
      WHERE g.application_id=$1 AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL
        AND ($2::uuid IS NULL OR g.id>$2)
        AND g.id NOT IN (SELECT grant_id FROM application_reconciliation_results
          WHERE application_id=$1 AND status='quarantined')
      ORDER BY g.id LIMIT $3`, [claim.application.id, claim.cursor, PAGE_SIZE])).rows;
  }

  private async retryPage(claim: Claim): Promise<Array<{ id: string }>> {
    return (await this.db.query<{ id: string }>(`SELECT r.grant_id AS id
      FROM application_reconciliation_results r JOIN grants g ON g.id=r.grant_id
      WHERE r.application_id=$1 AND r.status IN ('retryable','quarantined') AND r.next_retry_at<=now()
        AND g.revoked_at IS NULL AND g.activated_at IS NOT NULL
      ORDER BY r.grant_id LIMIT $2`, [claim.application.id, PAGE_SIZE])).rows;
  }

  private async advance(claim: Claim, grants: Array<{ id: string }>): Promise<void> {
    if (claim.phase === "scan" && grants.length === PAGE_SIZE) {
      await this.release(claim, "scan", grants[grants.length - 1].id, 0);
      return;
    }
    const retryDue = (await this.db.query<{ due: Date | null }>(`SELECT min(next_retry_at) AS due
      FROM application_reconciliation_results WHERE application_id=$1 AND status='retryable'`,
    [claim.application.id])).rows[0]?.due;
    if (retryDue) {
      await this.releaseAt(claim, "retry", null, retryDue);
      return;
    }
    const quarantine = (await this.db.query<{ due: Date | null; due_now: boolean }>(`SELECT min(next_retry_at) AS due,
      EXISTS(SELECT 1 FROM application_reconciliation_results
        WHERE application_id=$1 AND status='quarantined' AND next_retry_at<=now()) AS due_now
      FROM application_reconciliation_results WHERE application_id=$1 AND status='quarantined'`,
    [claim.application.id])).rows[0];
    if (quarantine?.due_now) {
      await this.release(claim, "retry", null, 0);
      return;
    }
    await this.db.query(`UPDATE application_reconciliation_jobs SET state='completed',phase='scan',
      lease_token=NULL,lease_expires_at=NULL,cursor_grant_id=NULL,last_error_class=NULL,
      last_completed_at=now(),next_scan_at=CASE
        WHEN $4::timestamptz IS NOT NULL AND $4::timestamptz < now()+(($3::text || ' milliseconds')::interval) THEN $4::timestamptz
        ELSE now()+(($3::text || ' milliseconds')::interval) END,
      available_at=CASE
        WHEN $4::timestamptz IS NOT NULL AND $4::timestamptz < now()+(($3::text || ' milliseconds')::interval) THEN $4::timestamptz
        ELSE now()+(($3::text || ' milliseconds')::interval) END,updated_at=now()
      WHERE application_id=$1 AND lease_token=$2 AND state='leased'`,
    [claim.application.id, claim.token, this.timing.scanMs, quarantine?.due ?? null]);
  }

  private async release(claim: Claim, phase: "scan" | "retry", cursor: string | null, waitMs: number): Promise<void> {
    await this.db.query(`UPDATE application_reconciliation_jobs SET state='pending',phase=$3,
      lease_token=NULL,lease_expires_at=NULL,cursor_grant_id=$4,
      available_at=now()+(($5::text || ' milliseconds')::interval),updated_at=now()
      WHERE application_id=$1 AND lease_token=$2 AND state='leased'`,
    [claim.application.id, claim.token, phase, cursor, waitMs]);
  }

  private async releaseAt(claim: Claim, phase: "scan" | "retry", cursor: string | null, availableAt: Date): Promise<void> {
    await this.db.query(`UPDATE application_reconciliation_jobs SET state='pending',phase=$3,
      lease_token=NULL,lease_expires_at=NULL,cursor_grant_id=$4,available_at=$5,updated_at=now()
      WHERE application_id=$1 AND lease_token=$2 AND state='leased'`,
    [claim.application.id, claim.token, phase, cursor, availableAt]);
  }

  private async renew(claim: Claim): Promise<boolean> {
    return Boolean((await this.db.query(`UPDATE application_reconciliation_jobs
      SET lease_expires_at=now()+(($3::text || ' milliseconds')::interval),updated_at=now()
      WHERE application_id=$1 AND lease_token=$2 AND state='leased' RETURNING application_id`,
    [claim.application.id, claim.token, this.timing.leaseMs])).rows[0]);
  }

  private async clearInactiveResults(claim: Claim): Promise<void> {
    await this.db.query(`DELETE FROM application_reconciliation_results WHERE application_id=$1
      AND grant_id NOT IN (SELECT id FROM grants WHERE application_id=$1
        AND revoked_at IS NULL AND activated_at IS NOT NULL)
      AND EXISTS (SELECT 1 FROM application_reconciliation_jobs
        WHERE application_id=$1 AND lease_token=$2 AND state='leased')`,
    [claim.application.id, claim.token]);
  }

  private async recordFailure(claim: Claim, grantId: string, errorClass: ErrorClass): Promise<boolean> {
    const permanent = errorClass === "malformed_proof" || errorClass === "ownership";
    const result = await this.db.query<{ recorded: boolean; was_quarantined: boolean }>(`WITH owned AS (
      SELECT 1 FROM application_reconciliation_jobs
       WHERE application_id=$1 AND lease_token=$2 AND state='leased'
    ), previous AS (
      SELECT status='quarantined' AS was_quarantined
        FROM application_reconciliation_results WHERE application_id=$1 AND grant_id=$3
    ), upsert AS (
      INSERT INTO application_reconciliation_results
        (application_id,grant_id,status,error_class,consecutive_attempts,next_retry_at)
      SELECT $1,$3,'retryable',$4,1,now()+(($5::text || ' milliseconds')::interval) FROM owned
      ON CONFLICT (application_id,grant_id) DO UPDATE SET
        consecutive_attempts=CASE
          WHEN application_reconciliation_results.error_class=excluded.error_class
          THEN application_reconciliation_results.consecutive_attempts+1 ELSE 1 END,
        error_class=excluded.error_class,last_attempted_at=now(),updated_at=now(),
        status=CASE WHEN $6 AND (CASE
          WHEN application_reconciliation_results.error_class=excluded.error_class
          THEN application_reconciliation_results.consecutive_attempts+1 ELSE 1 END) >= $7
          THEN 'quarantined' ELSE 'retryable' END,
        next_retry_at=CASE WHEN $6 AND (CASE
          WHEN application_reconciliation_results.error_class=excluded.error_class
          THEN application_reconciliation_results.consecutive_attempts+1 ELSE 1 END) >= $7
          THEN now()+(($8::text || ' milliseconds')::interval)
          ELSE now()+((LEAST($9::integer,$10::integer*CASE LEAST(10,CASE
            WHEN application_reconciliation_results.error_class=excluded.error_class
            THEN application_reconciliation_results.consecutive_attempts ELSE 0 END)
            WHEN 1 THEN 2 WHEN 2 THEN 4 WHEN 3 THEN 8 WHEN 4 THEN 16 WHEN 5 THEN 32
            WHEN 6 THEN 64 WHEN 7 THEN 128 WHEN 8 THEN 256 WHEN 9 THEN 512 ELSE 1024 END)::integer::text || ' milliseconds')::interval) END
      RETURNING 1
    ), counted AS (
      UPDATE application_reconciliation_jobs SET failure_count=failure_count+1,last_error_class=$4
       WHERE application_id=$1 AND lease_token=$2 AND state='leased' AND EXISTS (SELECT 1 FROM upsert)
    ) SELECT EXISTS(SELECT 1 FROM upsert) AS recorded,
        COALESCE((SELECT was_quarantined FROM previous),false) AS was_quarantined`,
    [claim.application.id, claim.token, grantId, errorClass,
      this.timing.retryBaseMs, permanent, PERMANENT_QUARANTINE_ATTEMPTS,
      this.timing.quarantineProbeMs, this.timing.retryMaxMs, this.timing.retryBaseMs]);
    return Boolean(result.rows[0]?.recorded) && !result.rows[0]?.was_quarantined;
  }

  private emit(phase: ReconciliationEvent["phase"], error: unknown): void {
    this.onEvent({ phase, errorClass: classifyError(error) });
  }
}

export function classifyError(error: unknown): ErrorClass {
  if (error instanceof Error && error.name === "AbortError") return "timeout";
  if (error instanceof HostedProviderUnavailableError || error instanceof HostedProviderResponseError) return "provider";
  if (error instanceof RelayUnavailableError || (error instanceof Error && error.name === "ConnectorOperationError")) return "relay";
  if (error instanceof MalformedPersistedApplicationAuthorizationError) return "malformed_proof";
  if (error instanceof ApplicationAuthorizationError) return "ownership";
  return "internal";
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
