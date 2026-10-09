// Durable wake after each committed CP policy batch (including enrolments).
// ACK covers the captured batch, not keying/serving. Coalesce older batches.
import { createHash } from "node:crypto";
import type { DatabaseQueryable } from "../../database-types.js";
import type { NextControlPlaneConfig } from "./policy-keys.js";
import type { ServiceKind } from "./service-devices.js";
import { pitrCollection, pitrDeployments, type LabPitrConfig } from "./lab-pitr-config.js";

const LIMIT = 4;
const TIMEOUT_MS = 8_000;
const MAX_ACK_BYTES = 1024;

/** LAB diagnosis only; opaque UUIDs are domain-separated before correlation. */
function wakeCollectionTag(collection: string): string {
  return createHash("sha256").update("mdbase-service-wake-v1:").update(collection).digest("hex").slice(0, 24);
}
function wakeLog(collection: string, role: ServiceKind, phase: "sent" | "outcome" | "retry", facts: { accepted?: boolean; http_status?: number; elapsed_ms?: number } = {}): void {
  if (process.env.MDBASE_CONNECT_ENVIRONMENT !== "lab") return;
  try { console.info(JSON.stringify({ event: "next_service_wake", at: new Date().toISOString(), collection_tag: wakeCollectionTag(collection), role, phase, ...facts })); } catch { /* Logging never changes delivery/commit outcomes. */ }
}

async function accepted(response: Response): Promise<boolean> {
  if (response.status !== 200) { await response.body?.cancel(); return false; }
  const reader = response.body?.getReader();
  if (!reader) return false;
  const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_ACK_BYTES) { await reader.cancel(); return false; }
    chunks.push(next.value);
  }
  try {
    const ack: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return !!ack && typeof ack === "object" && Object.keys(ack).length === 1 && "activated" in ack && ack.activated === true;
  } catch { return false; }
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
  pitr?: LabPitrConfig
): Promise<void> {
  const values: unknown[] = [LIMIT];
  let exclusion = "";
  if (pitr) {
    values.push([pitr.active, pitr.deleted]);
    exclusion = `AND NOT (device.kind = 'escrow' AND device.collection_id = ANY($${values.length}::uuid[]))`;
  }
  let selection = "";
  if (collectionId) {
    values.push(collectionId);
    selection = `AND device.collection_id = $${values.length}::uuid`;
  }
  const pending = await db.query<{ collection_id: string; kind: ServiceKind; batch_id: string }>(
    `SELECT device.collection_id::text, device.kind, latest.id::text AS batch_id FROM next_service_devices device
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
  await Promise.all(pending.rows.map(async ({ collection_id: collection, kind, batch_id: batch }) => {
    // Do not manufacture an activation ACK for an intentionally stateless record.
    if (kind === "escrow" && pitrCollection(pitr, collection)) return;
    const deployment = pitrDeployments(deployments, pitr, collection)[kind];
    const url = new URL("internal/v1/collections/activate", `${deployment.url.replace(/\/+$/u, "")}/`);
    let ok = false;
    let status: number | undefined;
    const started = Date.now();
    try {
      if (url.protocol !== "https:" || deployment.token.length < 32) throw new Error("invalid deployment");
      wakeLog(collection, kind, "sent");
      const response = await fetchImpl(url, { method: "POST", redirect: "manual",
        headers: { authorization: `Bearer ${deployment.token}`, "content-type": "application/json" },
        body: JSON.stringify({ collection }), signal: AbortSignal.timeout(TIMEOUT_MS) });
      status = response.status;
      ok = await accepted(response);
    } catch { /* Fixed persisted retry facts only; no response/URL/token/errors stored. */ }
    wakeLog(collection, kind, "outcome", { accepted: ok, http_status: status, elapsed_ms: Math.max(0, Date.now() - started) });
    if (ok) {
      await db.query(`UPDATE next_service_devices SET activated_at = now(), activation_batch_id = $3::bigint,
          activation_attempt_batch_id = $3::bigint, activation_attempts = 0, activation_next_at = now()
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
