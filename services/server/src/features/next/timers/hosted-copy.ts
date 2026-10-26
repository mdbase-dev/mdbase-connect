import type { DatabaseQueryable } from "../../../database-types.js";

/** Complete original DATA. This is not an admission or a completion receipt. */
export interface HostedLegacyTimer {
  grant_id: string;
  namespace: string;
  id: string;
  criterion_id: string;
  fire_at: string;
  data: unknown;
  generation: string;
  status: "scheduled" | "fired" | "cancelled";
  created_at: string;
  updated_at: string;
  fired_at: string | null;
  runtime_namespace: string;
  runtime_id: string;
  /** Raw SQL JSON text, ephemeral; never an archival CP column. */
  record_json: string;
}

export interface HostedLegacyTimerRow {
  runtime_namespace: string;
  runtime_id: string;
  generation: string;
  status: string;
  fire_at: string;
  created_at: string;
  updated_at: string;
  fired_at: string | null;
  record_json: string;
  leased: boolean;
}

export interface HostedLegacyTimerCursor {
  runtime_namespace: string;
  runtime_id: string;
  fence: { collection_id: string; migration_id: string; started_at: string; head: string };
}

type SnapshotRow = Partial<HostedLegacyTimerRow> & {
  schema_version: number;
  state: string;
  migration_id: string | null;
  started_at: string | null;
  head: string;
  unsettled: boolean;
};
const MAX_TIMERS = 64;
const MAX_BYTES = 48 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function refuse(why: string): never { throw new Error(`Legacy timer snapshot refused: ${why}.`); }

/**
 * One SELECT-only statement/snapshot, all statuses, original namespace. Requires
 * existing schema2 and a drained fence; does not initialize runtime storage.
 * Run settlement matches the provider's drain rule: an unleased `failed` run
 * whose attempts all have outcomes is settled. Mutation journal settlement is
 * the provider's in_flight rule: only a live claimed/prepared lease can still
 * apply; expired and applied rows are retained evidence (fenced, or in head).
 * The authenticated original caller must independently bind returned fence DATA
 * to its original source session, and re-read the provider watermark pre-flip.
 * Keyset pages preserve the original fence and reserve native envelope bytes.
 * No total-inventory limit. Only malformed/oversized single rows STOP; a full
 * page resumes at the last INCLUDED key. Caller watermark covers all pages.
 */
export async function readHostedLegacyTimers(
  provider: DatabaseQueryable, collectionId: string, cursor: HostedLegacyTimerCursor | null = null
) {
  if (!UUID.test(collectionId)) refuse("noncanonical collection identity");
  const runtimeNamespace = `connect-hosted:${collectionId}:notifications`;
  if (cursor && (cursor.runtime_namespace !== runtimeNamespace || !cursor.runtime_id
      || Buffer.byteLength(cursor.runtime_id, "utf8") > 4096)) refuse("cursor namespace/identity mismatch");
  const result = await provider.query<SnapshotRow>(
    `SELECT s.version AS schema_version, c.state, c.legacy_migration_id::text AS migration_id,
       to_char(c.legacy_migration_started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at,
       c.head::text AS head,
       EXISTS (SELECT 1 FROM mdbase_runtime_runs r WHERE r.namespace=$2
         AND (r.status NOT IN ('succeeded','cancelled','failed') OR r.lease_token IS NOT NULL
           OR r.lease_worker IS NOT NULL OR r.lease_expires_at IS NOT NULL
           OR (r.status='failed' AND (
             jsonb_typeof(r.record_json->'attempts') IS DISTINCT FROM 'array'
             OR COALESCE(jsonb_typeof(r.record_json->'active_attempt'),'null')<>'null'
             OR EXISTS (SELECT 1 FROM jsonb_array_elements(
                 CASE WHEN jsonb_typeof(r.record_json->'attempts')='array'
                   THEN r.record_json->'attempts' ELSE '[]'::jsonb END) a
               WHERE (a->>'status') IS NULL OR (a->>'status') NOT IN ('succeeded','failed'))))))
       OR EXISTS (SELECT 1 FROM hosted_provider_runtime_outbox o WHERE o.collection_id=c.id
         AND (o.processed_at IS NULL OR o.lease_token IS NOT NULL OR o.leased_until IS NOT NULL))
       OR EXISTS (SELECT 1 FROM hosted_provider_mutation_journal j
         JOIN hosted_provider_replicas r ON r.id=j.replica_id WHERE r.collection_id=c.id
         AND j.state IN ('claimed','prepared') AND j.lease_expires_at > now()) AS unsettled,
       t.namespace AS runtime_namespace, t.id AS runtime_id, t.generation::text AS generation,
       t.status, to_char(t.fire_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS fire_at,
       CASE WHEN octet_length(t.record_json::text)<=49152 THEN t.record_json->>'created_at' END AS created_at,
       CASE WHEN octet_length(t.record_json::text)<=49152 THEN t.record_json->>'updated_at' END AS updated_at,
       CASE WHEN octet_length(t.record_json::text)<=49152 THEN t.record_json->>'fired_at' END AS fired_at,
       CASE WHEN octet_length(t.record_json::text)<=49152 THEN t.record_json::text END AS record_json,
       (t.lease_token IS NOT NULL OR t.lease_worker IS NOT NULL OR t.lease_expires_at IS NOT NULL) AS leased
     FROM hosted_provider_collections c CROSS JOIN mdbase_runtime_schema s
     LEFT JOIN LATERAL (SELECT * FROM mdbase_runtime_timers WHERE namespace=$2
       AND ($3::text IS NULL OR (namespace COLLATE "C", id COLLATE "C") > ($2::text COLLATE "C", $3::text COLLATE "C"))
       ORDER BY namespace COLLATE "C", id COLLATE "C" LIMIT 65) t ON TRUE
     WHERE c.id=$1::uuid AND s.singleton=TRUE`,
    [collectionId, runtimeNamespace, cursor?.runtime_id ?? null]
  );
  const first = result.rows[0];
  // `migrated` (after a recorded cutover) keeps the same fence: same run, head
  // frozen. The cursor binds the run, not the state, so pages span the move.
  if (!first || first.schema_version !== 2 || (first.state !== "migrating" && first.state !== "migrated")
      || !first.migration_id || !UUID.test(first.migration_id) || !first.started_at
      || first.unsettled !== false || !/^\d+$/.test(first.head)) refuse("source fence/schema/drain unavailable");
  const fence = { collection_id: collectionId, migration_id: first.migration_id,
    started_at: timestamp(first.started_at), head: first.head };
  if (cursor && (!cursor.fence || cursor.fence.collection_id !== fence.collection_id
      || cursor.fence.migration_id !== fence.migration_id || cursor.fence.started_at !== fence.started_at
      || cursor.fence.head !== fence.head)) refuse("original fence changed between pages");
  const candidates = result.rows.filter(row => row.runtime_id != null);
  const timers: HostedLegacyTimer[] = [];
  let nextCursor: HostedLegacyTimerCursor | null = null;
  for (const row of candidates) {
    if (row.runtime_namespace !== runtimeNamespace) refuse("namespace mismatch");
    if (row.unsettled !== false) refuse("delivery unsettled");
    const timer = legacyTimer(row);
    const included = timers.at(-1);
    if (timers.length === MAX_TIMERS || Buffer.byteLength(JSON.stringify({ timers: [...timers, timer], fence }), "utf8") > MAX_BYTES) {
      if (!included) refuse("oversized single original timer DTO");
      nextCursor = { runtime_namespace: runtimeNamespace, runtime_id: included.runtime_id, fence };
      break;
    }
    timers.push(timer);
  }
  return { timers, skipped: 0 as const, fence, nextCursor };
}

/** Strict SQL/full-record/wrapper equality; no role/status/generation defaults. */
export function legacyTimer(row: Partial<HostedLegacyTimerRow>): HostedLegacyTimer {
  if (!row || typeof row.record_json !== "string" || Buffer.byteLength(row.record_json, "utf8") > MAX_BYTES) {
    refuse("missing or oversized original raw record");
  }
  if (row.leased !== false || !row.generation || !/^[1-9]\d*$/.test(row.generation)
      || BigInt(row.generation) > BigInt(Number.MAX_SAFE_INTEGER)) refuse("unrepresentable generation or lease");
  if (row.status !== "scheduled" && row.status !== "fired" && row.status !== "cancelled") refuse("unsettled status");
  const record = object(losslessJson(row.record_json));
  if (!["event_contract", "event_source", "source_uri", "subject"].every(field => Object.hasOwn(record, field))) {
    refuse("incomplete record");
  }
  const contract = object(record.event_contract);
  const source = object(record.event_source);
  for (const field of [contract.id, contract.version, contract.digest,
    source.application, source.implementation, source.version, record.source_uri]) text(field);
  if ((record.subject !== null && typeof record.subject !== "string")
      || (source.instance_id !== undefined && typeof source.instance_id !== "string")) refuse("incomplete event identity");
  const wrapped = object(record.data);
  const grant_id = text(wrapped.grant_id);
  if (!UUID.test(grant_id)) refuse("grant identity");
  const namespace = text(wrapped.namespace);
  const id = text(wrapped.timer_id);
  const criterion_id = text(wrapped.criterion_id);
  const runtime_id = `connect:${grant_id}:${namespace}:timer.${Buffer.from(id, "utf8").toString("hex")}`;
  const fire_at = timestamp(record.fire_at);
  const sqlFireAt = timestamp(row.fire_at);
  const created_at = timestamp(row.created_at);
  const updated_at = timestamp(row.updated_at);
  const fired_at = row.fired_at === null ? null : timestamp(row.fired_at);
  if (row.runtime_id !== runtime_id || record.id !== runtime_id || record.status !== row.status
      || typeof record.generation !== "number" || String(record.generation) !== row.generation || microsecondFloor(fire_at) !== microsecondFloor(sqlFireAt)
      || timestamp(record.created_at) !== created_at || timestamp(record.updated_at) !== updated_at
      || (record.fired_at === null ? null : timestamp(record.fired_at)) !== fired_at
      || typeof row.runtime_namespace !== "string" || !/^connect-hosted:[0-9a-f-]+:notifications$/.test(row.runtime_namespace)
      || (row.status === "fired" && fired_at === null) || (row.status === "scheduled" && fired_at !== null)
      || !Object.hasOwn(wrapped, "data")) refuse("SQL/record/wrapper disagreement or incomplete record");
  return { grant_id, namespace, id, criterion_id, fire_at, data: wrapped.data,
    generation: row.generation, status: row.status, created_at, updated_at, fired_at,
    runtime_namespace: row.runtime_namespace, runtime_id, record_json: row.record_json };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse("incomplete record/wrapper");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 1024) refuse("invalid identity");
  return value as string;
}

/** Validate the original UTC RFC3339 string without changing its precision. */
function timestamp(value: unknown): string {
  if (typeof value !== "string") refuse("missing original timestamp");
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(value as string);
  if (!m) refuse("unrepresentable timestamp");
  const [, y, mo, d, h, mi, s] = m!;
  const year = Number(y), month = Number(mo), day = Number(d);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]!
      || Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) refuse("unrepresentable timestamp");
  return value;
}

// Comparison only: original strings/record are never changed. Target floors
// operational timestamptz and preserves lost digits in approved origin metadata.
function microsecondFloor(value: string): string {
  const [whole, fraction = ""] = value.slice(0, -1).split(".");
  return `${whole}.${fraction.slice(0, 6).padEnd(6, "0")}Z`;
}

/** Node24's original primitive lexeme prevents JSON.parse numeric loss. */
function losslessJson(raw: string): unknown {
  return JSON.parse(raw, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value === "string" && /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) refuse("unrepresentable JSON Unicode");
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Object.is(value, -0) || (Number.isInteger(value) && !Number.isSafeInteger(value))
          || !context?.source || decimal(context.source) !== decimal(String(value))) refuse("lossy JSON number");
    }
    return value;
  });
}
function decimal(value: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) refuse("invalid JSON number");
  const [, sign, integral, fraction = "", exponent = "0"] = match!;
  let digits = `${integral}${fraction}`.replace(/^0+/, "");
  let power = Number(exponent) - fraction.length;
  if (!Number.isSafeInteger(power)) refuse("unrepresentable JSON exponent");
  if (!digits) return "0";
  while (digits.endsWith("0")) { digits = digits.slice(0, -1); power += 1; }
  return `${sign}${digits}e${power}`;
}
