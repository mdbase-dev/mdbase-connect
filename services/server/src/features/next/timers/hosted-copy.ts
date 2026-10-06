import type { DatabaseQueryable } from "../../../database-types.js";
import type { ImportedTimer } from "./store.js";

/**
 * Read a hosted collection's active legacy timers from the hosted provider's
 * runtime store (`mdbase_runtime_timers`, namespace
 * `connect-hosted:{collection}:notifications`) for the cutover copy.
 *
 * Each row's `record_json` is an mdbase-rs `TimerRecord`. Connect wrote its
 * `data` as `{grant_id, criterion_id, namespace, timer_id, data}`
 * (`connect-runtime/src/timers.rs`). Rows that don't have that shape are not
 * Connect timers and are skipped.
 */
export async function readHostedLegacyTimers(
  provider: DatabaseQueryable,
  collectionId: string
): Promise<{ timers: ImportedTimer[]; skipped: number }> {
  const rows = await provider.query<{ record_json: unknown }>(
    `SELECT record_json FROM mdbase_runtime_timers
     WHERE namespace = $1 AND status IN ('scheduled', 'firing')
     ORDER BY fire_at, id`,
    [`connect-hosted:${collectionId}:notifications`]
  );
  const timers: ImportedTimer[] = [];
  let skipped = 0;
  for (const { record_json } of rows.rows) {
    const timer = legacyTimer(record_json);
    if (timer) timers.push(timer);
    else skipped += 1;
  }
  return { timers, skipped };
}

export function legacyTimer(record: unknown): ImportedTimer | null {
  if (!record || typeof record !== "object") return null;
  const { fire_at: fireAt, data } = record as { fire_at?: unknown; data?: unknown };
  if (typeof fireAt !== "string" || !Number.isFinite(Date.parse(fireAt))) return null;
  if (!data || typeof data !== "object") return null;
  const wrapped = data as Record<string, unknown>;
  const { grant_id, criterion_id, namespace, timer_id } = wrapped;
  if (
    typeof grant_id !== "string"
    || typeof criterion_id !== "string"
    || typeof namespace !== "string"
    || typeof timer_id !== "string"
  ) {
    return null;
  }
  return {
    grant_id,
    criterion_id,
    namespace,
    id: timer_id,
    fire_at: new Date(fireAt).toISOString(),
    data: wrapped.data ?? null
  };
}
