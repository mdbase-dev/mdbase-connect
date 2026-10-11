import {
  MDBASE_TIMER_FIRED_CONTRACT,
  type NotificationCriterion
} from "@mdbase-dev/connect-protocol";
import type { DatabaseConnection, DatabasePool, DatabaseQueryable } from "../../../database-types.js";
import { createHash } from "node:crypto";
import { canonicalJson } from "../../../canonical-json.js";
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

export interface TimerReceiptAuthority {
  grant: TimerGrant;
  // Actual immutable consent, not caller JSON or an inferred backend marker.
  termsDigest: Buffer;
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
      next_collection_id: string | null;
      connector_id: string | null;
      operations: unknown;
      notification_criteria: NotificationCriterion[] | null;
      revoked_at: string | null;
      activated_at: string | null;
      suspended_at: string | null;
      next_sync: "private" | "cloud_copy" | null;
    }>(
      `SELECT g.id, g.user_id, g.application_id, g.application_origin,
              g.collection_id, c.local_id, g.hosted_collection_id, g.next_collection_id, c.connector_id,
              g.operations, g.notification_criteria, g.revoked_at,
              g.activated_at, u.suspended_at, nc.sync AS next_sync
       FROM grants g
       JOIN users u ON u.id = g.user_id
       LEFT JOIN collections c ON c.id = g.collection_id
       LEFT JOIN next_collections nc
         ON nc.collection_id = COALESCE(c.local_id, g.hosted_collection_id, g.next_collection_id)
       LEFT JOIN next_grant_bindings binding ON binding.grant_id = g.id AND binding.active = true
       WHERE g.id = $1 OR binding.log_grant_id = $1`,
      [grantId]
    );
    const row = result.rows[0];
    if (!row) return null;
    // Fail closed for private sync (end-to-end): this resolver can't check the
    // device approval that makes such a grant effective (policy.md §5.1), so it
    // reports the grant unusable. The next-aware resolver replaces this.
    // A native grant targets a Private collection by definition, even after the
    // collection row changed: it is never usable here.
    const e2e = row.next_sync === "private" || row.next_collection_id !== null;
    return {
      grantId: row.id,
      userId: row.user_id,
      applicationId: row.application_id,
      applicationOrigin: row.application_origin,
      collectionIds: [row.collection_id, row.local_id, row.hosted_collection_id, row.next_collection_id]
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

/** Fixed installation/collection/grant receiver boundary, shared by timers and
 * channels. Caller owns the transaction; policy locks precede timer/channel
 * writes. Public grant metadata never substitutes for its dedicated credential. */
export async function currentInstallationTimerAuthority(
  client: DatabaseConnection, resolver: TimerGrantResolver,
  collectionId: string, grantId: string, credentialHash: string
): Promise<TimerReceiptAuthority & { installationId: string }> {
  // Reject an unrelated bearer before acquiring another principal's policy.
  const credential = await client.query(
    `SELECT b.id FROM next_background_grants b
     JOIN installation_device_credentials k ON k.connector_id=b.native_connector_id
     WHERE b.id=$1 AND b.principal_kind='installation' AND k.token_hash=$2`, [grantId, credentialHash]);
  if (!credential.rows.length) throw new TimerError(401, "unauthenticated", "Installation timer credential is invalid.");
  const current = await resolver.resolve(client, grantId);
  if (!current) throw new TimerError(401, "unauthenticated", "The timer grant does not exist.");
  if (current.grantId !== grantId || current.state !== "e2e") throw new Error("Invalid native timer authority variant.");
  if (!current.collectionIds.includes(collectionId)) throw new TimerError(403, "forbidden", "The timer grant is not for this collection.");
  if (!current.usable) throw new TimerError(403, "forbidden", "The grant is not usable.", { reason: "grant_not_usable" });
  const consent = (await client.query<Record<string, unknown> & {installation_id:string}>(
    `SELECT b.id, b.user_id, b.application_id, b.collection_id, b.native_connector_id,
       b.installation_id, b.device_id, b.device_kind, b.approval_request_id,
       (extract(epoch FROM b.approved_at)*1000000)::bigint::text AS approved_us, b.timer_declaration,
       encode(b.sign_pk,'hex') AS sign_pk, encode(b.kem_pk,'hex') AS kem_pk,
       encode(b.noise_pk,'hex') AS noise_pk
     FROM next_background_grants b
     JOIN installation_device_credentials k ON k.connector_id=b.native_connector_id
     JOIN connectors c ON c.id=k.connector_id JOIN users u ON u.id=b.user_id
     WHERE b.id=$1 AND b.principal_kind='installation' AND b.revoked_at IS NULL
       AND k.token_hash=$2 AND c.user_id=b.user_id AND c.revoked_at IS NULL
       AND u.suspended_at IS NULL AND u.account_backend='next'
     FOR SHARE OF b,k,c,u`, [grantId, credentialHash])).rows[0];
  if (!consent) throw new TimerError(401, "unauthenticated", "The installation timer credential is no longer current.");
  return { grant: current, installationId: consent.installation_id,
    termsDigest: createHash("sha256").update(canonicalJson({
      principal_kind: "installation", consent, state: current.state,
      collection_ids: current.collectionIds, operations: [...current.operations].sort(), criteria: current.criteria
    })).digest() };
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
