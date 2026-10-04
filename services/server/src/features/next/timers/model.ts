import { z } from "zod";
import { canonicalJson } from "../../../canonical-json.js";

/**
 * Opaque timers for app notifications (mdbase-next
 * `docs/contracts/timer-service-api.md`, design `docs/ship/notifications.md`).
 * Semantics are ported from Connect's runtime timers
 * (`crates/connect-runtime/src/timers.rs`, mdbase-rs `timer.rs`).
 */

export const MAX_TIMERS_PER_RECONCILE = 10_000;
export const MAX_ACTIVE_PER_NAMESPACE = 10_000;
export const MAX_ACTIVE_PER_GRANT = 50_000;
export const MAX_DATA_BYTES = 16 * 1024;
export const LIST_RETENTION_MS = 7 * 24 * 60 * 60_000;

export type TimerStatus = "scheduled" | "firing" | "fired" | "cancelled";
export const ACTIVE_STATUSES: readonly TimerStatus[] = ["scheduled", "firing"];

export const namespaceSchema = z.string().regex(
  /^[A-Za-z0-9._-]{1,64}$/,
  "namespace must be 1-64 characters from [A-Za-z0-9._-]"
);
export const timerIdSchema = z.string().regex(
  /^[A-Za-z0-9._:-]{1,128}$/,
  "timer id must be 1-128 characters from [A-Za-z0-9._:-]"
);
export const criterionSchema = z.string().min(1).max(100);
const instantSchema = z.string().refine(
  (value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i.test(value)
    && Number.isFinite(Date.parse(value)),
  "fire_at must be an RFC 3339 instant with an offset"
);

export const desiredTimerSchema = z.object({
  id: timerIdSchema,
  fire_at: instantSchema,
  data: z.unknown().optional()
}).strict();

export const putBodySchema = z.object({
  criterion_id: criterionSchema,
  fire_at: instantSchema,
  data: z.unknown().optional()
}).strict();

export const reconcileBodySchema = z.object({
  criterion_id: criterionSchema,
  timers: z.array(desiredTimerSchema).max(MAX_TIMERS_PER_RECONCILE)
}).strict();

export interface DesiredTimer {
  id: string;
  fireAt: Date;
  data: unknown;
}

export interface TimerRow {
  grant_id: string;
  namespace: string;
  timer_id: string;
  criterion_id: string;
  fire_at: Date | string;
  generation: number | string;
  status: TimerStatus;
  data: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  fired_at: Date | string | null;
}

export interface TimerView {
  id: string;
  criterion_id: string;
  fire_at: string;
  generation: number;
  status: TimerStatus;
  created_at: string;
  updated_at: string;
  fired_at: string | null;
  data?: unknown;
}

export class TimerError extends Error {
  constructor(
    readonly statusCode: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

export function desiredTimer(input: { id: string; fire_at: string; data?: unknown }): DesiredTimer {
  return { id: input.id, fireAt: new Date(Date.parse(input.fire_at)), data: normalizeData(input.data) };
}

/** `undefined` and `null` both mean "no data". Enforces the 16 KiB bound. */
export function normalizeData(data: unknown): unknown {
  if (data === undefined || data === null) return null;
  let encoded: string;
  try {
    encoded = canonicalJson(data);
  } catch {
    throw new TimerError(400, "invalid_request", "Timer data must be JSON.", { reason: "invalid_timer_data" });
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_DATA_BYTES) {
    throw new TimerError(413, "too_large", "Timer data exceeds 16 KiB.", { limit: MAX_DATA_BYTES });
  }
  return data;
}

export function sameData(left: unknown, right: unknown): boolean {
  return canonicalJson(left ?? null) === canonicalJson(right ?? null);
}

export function instant(value: Date | string): string {
  return new Date(value).toISOString();
}

export function timerView(row: TimerRow, includeData: boolean): TimerView {
  const view: TimerView = {
    id: row.timer_id,
    criterion_id: row.criterion_id,
    fire_at: instant(row.fire_at),
    generation: Number(row.generation),
    status: row.status,
    created_at: instant(row.created_at),
    updated_at: instant(row.updated_at),
    fired_at: row.fired_at ? instant(row.fired_at) : null
  };
  if (includeData) view.data = row.data ?? null;
  return view;
}
