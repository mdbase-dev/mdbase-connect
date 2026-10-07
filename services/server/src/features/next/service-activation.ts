// Durable wake after each committed CP policy batch (including enrolments).
// ACK covers the captured batch, not keying/serving. Coalesce older batches.
import type { DatabaseQueryable } from "../../database-types.js";
import type { NextControlPlaneConfig } from "./policy-keys.js";
import type { ServiceKind } from "./service-devices.js";

const LIMIT = 4;
const TIMEOUT_MS = 8_000;
const MAX_ACK_BYTES = 1024;

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
  fetchImpl: typeof fetch = fetch
): Promise<void> {
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
     ORDER BY device.activation_next_at, device.collection_id, device.kind LIMIT $1`, [LIMIT]
  );
  await Promise.all(pending.rows.map(async ({ collection_id: collection, kind, batch_id: batch }) => {
    const deployment = deployments[kind];
    const url = new URL("internal/v1/collections/activate", `${deployment.url.replace(/\/+$/u, "")}/`);
    let ok = false;
    try {
      if (url.protocol !== "https:" || deployment.token.length < 32) throw new Error("invalid deployment");
      const response = await fetchImpl(url, { method: "POST", redirect: "manual",
        headers: { authorization: `Bearer ${deployment.token}`, "content-type": "application/json" },
        body: JSON.stringify({ collection }), signal: AbortSignal.timeout(TIMEOUT_MS) });
      ok = await accepted(response);
    } catch { /* Fixed persisted retry facts only; no response/URL/token/errors stored. */ }
    if (ok) {
      await db.query(`UPDATE next_service_devices SET activated_at = now(), activation_batch_id = $3::bigint,
          activation_attempt_batch_id = $3::bigint, activation_attempts = 0, activation_next_at = now()
        WHERE collection_id = $1 AND kind = $2 AND activation_batch_id < $3::bigint
          AND activation_attempt_batch_id <= $3::bigint`, [collection, kind, batch]);
    } else {
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
