import {
  MDBASE_TIMER_FIRED_CONTRACT,
  type NotificationCriterion
} from "@mdbase-dev/connect-protocol";
import type { DatabaseConnection, DatabasePool, DatabaseQueryable } from "../../../database-types.js";
import { InstallationPairingError, installationApp } from "../../connectors/installation-pairing.js";
import { CreateError, currentCollectionDevice, inTransaction, type Device } from "../bootstrap-common.js";
import { requireInstallationScope } from "../installation-scope.js";
import { readInstallationTimerDeclaration } from "./installation-declaration.js";
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
 * Resolve current timer-relevant facts. Legacy authority keeps its existing
 * checks; the shared background resolver evaluates actual native installation
 * consent against current acknowledged policy and reports opaque-only `e2e`.
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

interface InstallationBackgroundGrant {
  id: string; user_id: string; application_id: string; collection_id: string;
  native_connector_id: string; installation_id: string; device_id: string;
  device_kind: "app-runtime" | "mobile";
  sign_pk: Buffer; kem_pk: Buffer; noise_pk: Buffer;
  timer_declaration: unknown; revoked_at: Date | string | null;
}

/** Typed shared background authority. A recorded native principal never enters
 * the legacy resolver, even when revoked or otherwise unusable. Pool reads own
 * a bounded transaction; engine transactions retain policy locks through commit. */
export function backgroundTimerGrantResolver(db: DatabasePool, environment: "lab" | "staging" | "production"): TimerGrantResolver {
  const native = async (client: DatabaseConnection, grantId: string): Promise<TimerGrant | null> => {
    const row = (await client.query<InstallationBackgroundGrant>(
      "SELECT * FROM next_background_grants WHERE id=$1 AND principal_kind='installation'", [grantId]
    )).rows[0];
    if (!row) return null;
    const declaration = readInstallationTimerDeclaration(row.timer_declaration);
    if (declaration.application_id !== row.application_id || declaration.kind !== row.device_kind) throw new Error("Native timer consent identity mismatch.");
    const grant: TimerGrant = {
      grantId: row.id, userId: row.user_id, applicationId: row.application_id,
      applicationOrigin: declaration.app_origin, collectionIds: [row.collection_id],
      connectorId: row.native_connector_id, state: "e2e", usable: false,
      operations: new Set(declaration.operations), criteria: declaration.notifications.criteria,
    };
    if (row.revoked_at !== null || declaration.environment !== environment) return grant;
    const connector = { id: row.native_connector_id, user_id: row.user_id, installation_device_id: row.device_id };
    try {
      await requireInstallationScope(client,connector);
      // ct_ lives in this dedicated credential; the connector's deliberately
      // unused ordinary-controller token is neither an alias nor this bearer.
      const credential = await client.query(
        `SELECT 1 FROM installation_device_credentials k JOIN connectors c ON c.id=k.connector_id
         WHERE k.connector_id=$1 AND k.installation_id=$2 AND k.device_id=$3 AND k.kind=$4
           AND k.sign_pk=$5 AND k.kem_pk=$6 AND k.noise_pk=$7 AND k.app_id=$8 AND k.app_origin=$9
           AND c.user_id=$10 AND c.revoked_at IS NULL FOR SHARE OF k,c`,
        [row.native_connector_id,row.installation_id,row.device_id,row.device_kind,row.sign_pk,row.kem_pk,row.noise_pk,
          row.application_id,declaration.app_origin,row.user_id]
      );
      if (!credential.rows.length) return grant;
      // Registration/declaration drift cannot be adopted by an old consent.
      const registered = await client.query("SELECT 1 FROM applications WHERE id=$1 FOR SHARE",[row.application_id]);
      if (!registered.rows.length) return grant;
      const app = await installationApp(client,environment,row.application_id,declaration.app_origin,row.device_kind);
      if (app.timerDeclaration?.digest !== declaration.digest) return grant;
      const device: Device = { kind: row.device_kind, sign_pk: row.sign_pk, kem_pk: row.kem_pk, noise_pk: row.noise_pk };
      await currentCollectionDevice(client,connector,row.collection_id,row.device_id,device);
      const scoped = await client.query(
        "SELECT 1 FROM installation_collection_scopes WHERE connector_id=$1 AND collection_id=$2 FOR SHARE",
        [row.native_connector_id,row.collection_id]
      );
      if (!scoped.rows.length) return grant;
      const live = await client.query(
        "SELECT 1 FROM next_background_grants WHERE id=$1 AND principal_kind='installation' AND revoked_at IS NULL FOR SHARE",[row.id]
      );
      grant.usable = live.rows.length === 1;
      return grant;
    } catch (error) {
      if (error instanceof CreateError || error instanceof InstallationPairingError) return grant;
      throw error;
    }
  };
  return {
    async resolve(queryable, grantId) {
      const identity = (await queryable.query<{principal_kind:"legacy"|"installation"}>(
        "SELECT principal_kind FROM next_background_grants WHERE id=$1",[grantId]
      )).rows[0];
      if (identity?.principal_kind !== "installation") return legacyTimerGrantResolver.resolve(queryable,grantId);
      if (queryable === db) return inTransaction(db,client=>native(client,grantId));
      if (!("release" in queryable) || typeof queryable.release !== "function") throw new Error("Native timer authority requires its database pool or an owned transaction connection.");
      return native(queryable as DatabaseConnection,grantId);
    }
  };
}

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
