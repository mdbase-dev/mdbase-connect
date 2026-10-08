import {
  MDBASE_TIMER_FIRED_CONTRACT,
  type NotificationCriterion
} from "@mdbase-dev/connect-protocol";
import type { DatabaseQueryable } from "../../../database-types.js";
import { TimerError } from "./model.js";

/**
 * The collection state a timer call is evaluated in (collection-states doc §2).
 * - `cloud_copy`: synced with the hosted replica; timer `data` is allowed.
 * - `e2e`: synced end-to-end; opaque timers only.
 * - `local`: on this device; served by the daemon. Its timers are cloud opaque
 *   timers like e2e (decided 2026-10-04).
 */
export type TimerCollectionState = "cloud_copy" | "e2e" | "local";

export interface TimerGrant {
  grantId: string;
  userId: string;
  applicationId: string;
  applicationOrigin: string;
  /**
   * IDs a caller may name the collection by: the logical collection ID (a local
   * collection's `local_id`, or the hosted collection's ID, as in
   * `next_collections`) or Connect's authority-row ID.
   */
  collectionIds: string[];
  /** Connect's connector that serves a local collection, when there is one. */
  connectorId: string | null;
  state: TimerCollectionState;
  /**
   * Active, activated, user not suspended and, where the collection requires
   * device approval of grants (e2e, device-located logs), approved.
   */
  usable: boolean;
  operations: ReadonlySet<string>;
  criteria: NotificationCriterion[];
}

/**
 * Seam: resolve a grant's timer-relevant facts. The default reads Connect's
 * grant rows. The mdbase-next control plane replaces it once `next_collections`
 * and grant approvals exist, to report `e2e` and the device-approval test.
 */
export interface TimerGrantResolver {
  resolve(db: DatabaseQueryable, grantId: string): Promise<TimerGrant | null>;
}

export const legacyTimerGrantResolver: TimerGrantResolver = {
  async resolve(db, grantId) {
    const result = await db.query<{
      id: string;
      user_id: string;
      application_id: string;
      application_origin: string;
      collection_id: string | null;
      local_id: string | null;
      hosted_collection_id: string | null;
      connector_id: string | null;
      operations: unknown;
      notification_criteria: NotificationCriterion[] | null;
      revoked_at: string | null;
      activated_at: string | null;
      suspended_at: string | null;
      next_sync: "private" | "cloud_copy" | null;
    }>(
      `SELECT g.id, g.user_id, g.application_id, g.application_origin,
              g.collection_id, c.local_id, g.hosted_collection_id, c.connector_id,
              g.operations, g.notification_criteria, g.revoked_at,
              g.activated_at, u.suspended_at, nc.sync AS next_sync
       FROM grants g
       JOIN users u ON u.id = g.user_id
       LEFT JOIN collections c ON c.id = g.collection_id
       LEFT JOIN next_collections nc
         ON nc.collection_id = COALESCE(c.local_id, g.hosted_collection_id)
       LEFT JOIN next_grant_bindings binding ON binding.grant_id = g.id AND binding.active = true
       WHERE g.id = $1 OR binding.log_grant_id = $1`,
      [grantId]
    );
    const row = result.rows[0];
    if (!row) return null;
    // Fail closed for private sync (end-to-end): this resolver can't check the
    // device approval that makes such a grant effective (policy.md §5.1), so it
    // reports the grant unusable. The next-aware resolver replaces this.
    const e2e = row.next_sync === "private";
    return {
      grantId: row.id,
      userId: row.user_id,
      applicationId: row.application_id,
      applicationOrigin: row.application_origin,
      collectionIds: [row.collection_id, row.local_id, row.hosted_collection_id]
        .filter((id): id is string => id !== null),
      connectorId: row.connector_id,
      state: e2e ? "e2e" : row.hosted_collection_id ? "cloud_copy" : "local",
      usable: !e2e && !row.revoked_at && row.activated_at !== null && !row.suspended_at,
      operations: new Set(Array.isArray(row.operations)
        ? row.operations.filter((op): op is string => typeof op === "string")
        : []),
      criteria: row.notification_criteria ?? []
    };
  }
};

export type TimerOperation = "list_timers" | "put_timer" | "cancel_timer" | "reconcile_timers";
const WRITE_OPERATIONS: readonly TimerOperation[] = ["put_timer", "cancel_timer", "reconcile_timers"];

function isTimerCriterion(criterion: NotificationCriterion): boolean {
  return criterion.event.id === MDBASE_TIMER_FIRED_CONTRACT.id
    && criterion.event.version === MDBASE_TIMER_FIRED_CONTRACT.version
    && criterion.event.digest === MDBASE_TIMER_FIRED_CONTRACT.digest;
}

/** The grant may still be woken by timers on this criterion (checked at fire time too). */
export function grantMayFire(grant: TimerGrant, criterionId: string): boolean {
  return grant.usable
    && WRITE_OPERATIONS.some((op) => grant.operations.has(op))
    && grant.criteria.some((criterion) => criterion.id === criterionId && isTimerCriterion(criterion));
}

/** Throws a `TimerError` unless the grant may perform `operation`. */
export function authorizeTimerOperation(
  grant: TimerGrant,
  operation: TimerOperation,
  criterionId?: string
): void {
  if (!grant.usable) {
    throw new TimerError(403, "forbidden", "The grant is not usable.", { reason: "grant_not_usable" });
  }
  if (!grant.operations.has(operation)) {
    throw new TimerError(403, "forbidden", `The grant does not allow ${operation}.`, {
      reason: "missing_operation",
      capability: "background.schedule"
    });
  }
  if (criterionId !== undefined && !grant.criteria.some(
    (criterion) => criterion.id === criterionId && isTimerCriterion(criterion)
  )) {
    throw new TimerError(403, "forbidden", "The grant does not authorize this timer criterion.", {
      reason: "timer_criterion_not_authorized"
    });
  }
}

/** Timer `data` may be stored only where mdbase can already read the collection. */
export function dataPermitted(grant: TimerGrant): boolean {
  return grant.state === "cloud_copy";
}
