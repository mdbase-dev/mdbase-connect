// Durable wake after each committed CP policy batch (including enrolments).
// ACK covers the captured batch, not keying/serving. Coalesce older batches.
import { createHash } from "node:crypto";
import type { DatabaseQueryable } from "../../database-types.js";
import type { NextControlPlaneConfig } from "./policy-keys.js";
import type { ServiceKind } from "./service-devices.js";
import { pitrCollection, pitrDeployments, type LabPitrConfig } from "./lab-pitr-config.js";
import { migrationDeployments, type MigrationRouting } from "./migration-routing.js";
import { isLogRegion } from "./log-service-client.js";

const LIMIT = 4;
// A cold Hosted actor for a migrated collection took ~14s to wake and emit its
// grant in LAB; an 8s bound abandoned every attempt. Activation is background work.
const TIMEOUT_MS = 30_000;
const MAX_ACK_BYTES = 1024;

/** LAB diagnosis only; opaque UUIDs are domain-separated before correlation. */
function wakeCollectionTag(collection: string): string {
  return createHash("sha256").update("mdbase-service-wake-v1:").update(collection).digest("hex").slice(0, 24);
}
function wakeLog(collection: string, role: ServiceKind, phase: "sent" | "outcome" | "retry" | "refused", facts: { accepted?: boolean; http_status?: number; elapsed_ms?: number; reason?: Refusal } = {}): void {
  if (process.env.MDBASE_CONNECT_ENVIRONMENT !== "lab") return;
  try { console.info(JSON.stringify({ event: "next_service_wake", at: new Date().toISOString(), collection_tag: wakeCollectionTag(collection), role, phase, ...facts })); } catch { /* Logging never changes delivery/commit outcomes. */ }
}

/** The Worker's lasting verdicts (409 `{error}`): the collection is deleted or
 * left sync, or this deployment does not serve it. Retrying the same batch cannot
 * change either; a newer batch is tried again. */
const REFUSALS = ["custody_collection_gone", "custody_collection_not_allowed"] as const;
type Refusal = typeof REFUSALS[number];
export type Outcome = { kind: "accepted" } | { kind: "refused"; reason: Refusal } | { kind: "unknown" };

async function smallJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_ACK_BYTES) { await reader.cancel(); return undefined; }
    chunks.push(next.value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return undefined; }
}

/** The activation answer: accepted, a lasting refusal, or unknown (retry). */
export async function activationOutcome(response: Response): Promise<Outcome> {
  if (response.status !== 200 && response.status !== 409) { await response.body?.cancel(); return { kind: "unknown" }; }
  const body = await smallJson(response);
  if (!body || typeof body !== "object" || Object.keys(body).length !== 1) return { kind: "unknown" };
  if (response.status === 200) return "activated" in body && body.activated === true ? { kind: "accepted" } : { kind: "unknown" };
  const reason = "error" in body ? REFUSALS.find((r) => r === body.error) : undefined;
  return reason ? { kind: "refused", reason } : { kind: "unknown" };
}

/** Run after policy drain, and on every later poll/restart. No network I/O holds a
 * database lock. Concurrent pollers may repeat the idempotent wake. Batch IDs,
 * unlike log positions, remain monotonic across lost-tail repair/replacement.
 * A newer batch bypasses an older backoff; old HTTP completions cannot acknowledge
 * or postpone a newer batch. Unknown HTTP outcomes stay pending for bounded retry. */
export async function activatePendingServices(
  db: DatabaseQueryable,
  deployments: NonNullable<NextControlPlaneConfig["cloudCopyBootstrap"]>,
  fetchImpl: typeof fetch = fetch,
  collectionId?: string,
  pitr?: LabPitrConfig,
  migrationRouting?: MigrationRouting
): Promise<void> {
  const values: unknown[] = [LIMIT];
  let exclusion = "";
  if (pitr) {
    values.push([pitr.active, pitr.deleted]);
    exclusion = `AND NOT (device.kind = 'escrow' AND device.collection_id = ANY($${values.length}::uuid[]))`;
  }
  // A retired migration route (LAB fixture disposal) has no service deployments to
  // wake; a collection moving hosting has none until the move ends.
  if (migrationRouting) exclusion += `
     AND NOT EXISTS (SELECT 1 FROM next_migration_routing_retirements retired WHERE retired.collection_id = device.collection_id)
     AND NOT EXISTS (SELECT 1 FROM next_hosting_moves move WHERE move.collection_id = device.collection_id AND move.state = 'moving')`;
  let selection = "";
  if (collectionId) {
    values.push(collectionId);
    selection = `AND device.collection_id = $${values.length}::uuid`;
  }
  // `region`: the log's recorded region on the genesis outbox row (policy-outbox.ts).
  const pending = await db.query<{ collection_id: string; kind: ServiceKind; batch_id: string; region: string | null }>(
    `SELECT device.collection_id::text, device.kind, latest.id::text AS batch_id,
       (SELECT genesis.ops->>'region' FROM next_policy_outbox genesis WHERE genesis.collection_id = device.collection_id
         ORDER BY genesis.id LIMIT 1) AS region
     FROM next_service_devices device
     JOIN next_collections parent ON parent.collection_id = device.collection_id
     JOIN (SELECT batch.collection_id, max(batch.id) AS id FROM next_policy_batches batch
       WHERE batch.state = 'appended' AND batch.lost_at IS NULL GROUP BY batch.collection_id)
       latest ON latest.collection_id = device.collection_id
     WHERE device.activation_batch_id < latest.id
       AND (device.activation_attempt_batch_id < latest.id OR device.activation_next_at <= now())
       AND parent.sync = 'cloud_copy' AND parent.left_sync_at IS NULL
       AND EXISTS (SELECT 1 FROM next_policy_batches batch WHERE batch.collection_id = device.collection_id
         AND batch.seq = 1 AND batch.state = 'appended' AND batch.lost_at IS NULL)
     ${exclusion}
     ${selection}
     ORDER BY device.activation_next_at, device.collection_id, device.kind LIMIT $1`, values
  );
  await Promise.all(pending.rows.map(async ({ collection_id: collection, kind, batch_id: batch, region: stored }) => {
    // Do not manufacture an activation ACK for an intentionally stateless record.
    if (kind === "escrow" && pitrCollection(pitr, collection)) return;
    const selected = await migrationDeployments(db, pitrDeployments(deployments, pitr, collection), migrationRouting, collection);
    if (!selected) return; // Retired after selection; the next poll excludes it.
    const deployment = selected[kind];
    const url = new URL("internal/v1/collections/activate", `${deployment.url.replace(/\/+$/u, "")}/`);
    // The log's recorded region places a new actor next to it; absent, the Worker's default.
    const region = isLogRegion(stored) ? stored : undefined;
    let result: Outcome = { kind: "unknown" };
    let status: number | undefined;
    const started = Date.now();
    try {
      if (url.protocol !== "https:" || deployment.token.length < 32) throw new Error("invalid deployment");
      wakeLog(collection, kind, "sent");
      const response = await fetchImpl(url, { method: "POST", redirect: "manual",
        headers: { authorization: `Bearer ${deployment.token}`, "content-type": "application/json" },
        body: JSON.stringify({ collection, ...(region ? { region } : {}) }), signal: AbortSignal.timeout(TIMEOUT_MS) });
      status = response.status;
      result = await activationOutcome(response);
    } catch { /* Fixed persisted retry facts only; no response/URL/token/errors stored. */ }
    wakeLog(collection, kind, "outcome", { accepted: result.kind === "accepted", http_status: status, elapsed_ms: Math.max(0, Date.now() - started) });
    if (result.kind === "accepted") {
      await db.query(`UPDATE next_service_devices SET activated_at = now(), activation_batch_id = $3::bigint,
          activation_attempt_batch_id = $3::bigint, activation_attempts = 0, activation_next_at = now()
        WHERE collection_id = $1 AND kind = $2 AND activation_batch_id < $3::bigint
          AND activation_attempt_batch_id <= $3::bigint`, [collection, kind, batch]);
    } else if (result.kind === "refused") {
      // Terminal for this batch: no retry loop. The row stays unactivated, and a
      // newer batch (activation_attempt_batch_id < latest.id) is tried at once.
      wakeLog(collection, kind, "refused", { reason: result.reason });
      await db.query(`UPDATE next_service_devices SET activation_next_at = 'infinity',
          activation_attempts = 0, activation_attempt_batch_id = $3::bigint
        WHERE collection_id = $1 AND kind = $2 AND activation_batch_id < $3::bigint
          AND activation_attempt_batch_id <= $3::bigint`, [collection, kind, batch]);
    } else {
      wakeLog(collection, kind, "retry");
      await db.query(`UPDATE next_service_devices SET activation_next_at = now() +
          make_interval(secs => LEAST(300, (2 * power(2, LEAST(
            CASE WHEN activation_attempt_batch_id = $3::bigint THEN activation_attempts ELSE 0 END, 8)))::int)),
          activation_attempts = CASE WHEN activation_attempt_batch_id = $3::bigint
            THEN LEAST(activation_attempts + 1, 9) ELSE 1 END, activation_attempt_batch_id = $3::bigint
        WHERE collection_id = $1 AND kind = $2 AND activation_batch_id < $3::bigint
          AND activation_attempt_batch_id <= $3::bigint`, [collection, kind, batch]);
    }
  }));
}
