import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../../../canonical-json.js";
import { criterionSchema, namespaceSchema, timerIdSchema, TimerError, sameData } from "./model.js";

const unrepresentableText = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const text = z.string().min(1).max(4096).refine((value) => !unrepresentableText.test(value));
const contract = z.object({ id: text, version: text, digest: text }).strict();
const source = z.object({ application: text, implementation: text, version: text, instance_id: text.nullable().optional() }).strict();
const status = z.enum(["scheduled", "fired", "cancelled"]);
const original = z.object({
  id: text, generation: z.number().int().positive().safe(), status,
  fire_at: text, event_contract: contract, event_source: source,
  source_uri: text, subject: z.string().max(4096).nullable(),
  data: z.unknown(), created_at: text, updated_at: text, fired_at: text.nullable()
}).strict();
export const completeTimerImportSchema = z.object({
  grant_id: z.string().uuid(), namespace: namespaceSchema, id: timerIdSchema,
  criterion_id: criterionSchema, fire_at: text, data: z.unknown(),
  generation: z.string().regex(/^[1-9][0-9]*$/u), status,
  created_at: text, updated_at: text, fired_at: text.nullable(),
  runtime_namespace: text, runtime_id: text, record_json: z.string().max(48 * 1024)
}).strict();
export type CompleteTimerImport = z.infer<typeof completeTimerImportSchema>;
export interface LegacyTimerOrigin {
  namespace: string; id: string; generation: string; status: CompleteTimerImport["status"];
  fire_at: string; event_contract: string; event_source: string;
  source_uri_sha256: string; subject_sha256: string; runtime_id: string; record_sha256: string;
  exact_timestamps?: Partial<Record<"fire_at" | "created_at" | "updated_at" | "fired_at", string>>;
}
const invalid = (): never => { throw new TimerError(409, "timer_import_invalid", "The original timer cannot be imported exactly."); };

/** Validate original UTC nanosecond strings without Date reconstruction.
 * Only the TARGET floors operational timestamps to microseconds. */
function originalInstant(input: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|\+00:00)$/u.exec(input);
  if (!match) return invalid();
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) return invalid();
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${(match[7] ?? "").padEnd(9, "0")}Z`;
}
export function importInstant(input: string): string {
  return `${originalInstant(input).slice(0, -4)}Z`;
}

/** Small bounded I-JSON parser: duplicate keys, invalid Unicode and unsafe
 * integers are refused BEFORE they can disappear through ordinary JSON.parse. */
function parseOriginal(raw: string): unknown {
  if (Buffer.byteLength(raw, "utf8") > 48 * 1024) return invalid();
  let at = 0;
  const space = () => { while (/[\t\r\n ]/u.test(raw[at] ?? "") && at < raw.length) at++; };
  const string = (): string => {
    const start = at++;
    let escaped = false;
    while (at < raw.length) {
      const char = raw[at++];
      if (!escaped && char === '"') {
        let value: unknown;
        try { value = JSON.parse(raw.slice(start, at)); } catch { return invalid(); }
        if (typeof value !== "string" || unrepresentableText.test(value)) return invalid();
        return value;
      }
      escaped = !escaped && char === "\\";
    }
    return invalid();
  };
  const value = (depth: number): unknown => {
    if (depth > 32) return invalid();
    space();
    const char = raw[at];
    if (char === '"') return string();
    if (char === "{" || char === "[") {
      at++;
      const close = char === "{" ? "}" : "]";
      const map: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const keys = new Set<string>();
      const array: unknown[] = [];
      space();
      if (raw[at] === close) { at++; return char === "{" ? map : array; }
      while (at < raw.length) {
        if (char === "{") {
          space();
          if (raw[at] !== '"') return invalid();
          const key = string();
          if (keys.has(key)) return invalid();
          keys.add(key); space();
          if (raw[at++] !== ":") return invalid();
          map[key] = value(depth + 1);
        } else array.push(value(depth + 1));
        space();
        if (raw[at] === close) { at++; return char === "{" ? map : array; }
        if (raw[at++] !== ",") return invalid();
      }
      return invalid();
    }
    for (const [token, parsed] of [["true", true], ["false", false], ["null", null]] as const) {
      if (raw.startsWith(token, at)) { at += token.length; return parsed; }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(raw.slice(at));
    if (!number) return invalid();
    at += number[0].length;
    const parsed = Number(number[0]);
    if (!Number.isFinite(parsed) || (Number.isInteger(parsed) && !Number.isSafeInteger(parsed))) return invalid();
    return parsed;
  };
  const parsed = value(0); space();
  if (at !== raw.length) return invalid();
  return parsed;
}

/** Source expectations are DATA, not source-session/fence or flip authority.
 * The original record is ephemeral; persist only the returned content-free origin. */
export function validateTimerImport(input: unknown): { timer: CompleteTimerImport; origin: LegacyTimerOrigin } {
  const parsed = completeTimerImportSchema.safeParse(input);
  if (!parsed.success) return invalid();
  const timer = parsed.data;
  const rawRecord = parseOriginal(timer.record_json);
  const checked = original.safeParse(rawRecord);
  if (!checked.success) return invalid();
  const record = checked.data;
  if (BigInt(timer.generation) > BigInt(Number.MAX_SAFE_INTEGER) || String(record.generation) !== timer.generation || record.id !== timer.runtime_id || record.status !== timer.status) return invalid();
  const exact: NonNullable<LegacyTimerOrigin["exact_timestamps"]> = {};
  for (const key of ["fire_at", "created_at", "updated_at", "fired_at"] as const) {
    const expected = record[key];
    const actual = timer[key];
    if (expected === null || actual === null) {
      if (expected !== actual) return invalid();
      continue;
    }
    const instant = originalInstant(expected);
    if (originalInstant(actual) !== instant) return invalid();
    if (/[1-9]/u.test(instant.slice(-4, -1))) exact[key] = expected;
  }
  if ((timer.status === "fired") !== (timer.fired_at !== null)) return invalid();
  const wrapped = z.object({ grant_id: z.string(), criterion_id: z.string(), namespace: z.string(), timer_id: z.string(), data: z.unknown() }).strict().safeParse(record.data);
  if (!wrapped.success || wrapped.data.grant_id !== timer.grant_id || wrapped.data.criterion_id !== timer.criterion_id || wrapped.data.namespace !== timer.namespace || wrapped.data.timer_id !== timer.id || !sameData(wrapped.data.data, timer.data)) return invalid();
  const digest = (value: unknown): string => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
  const origin: LegacyTimerOrigin = {
    namespace: timer.runtime_namespace, id: timer.id, generation: timer.generation,
    status: timer.status, fire_at: timer.fire_at,
    // Hash the original structured headers, not encoded objects/user content.
    event_contract: digest(record.event_contract), event_source: digest(record.event_source),
    source_uri_sha256: digest(record.source_uri), subject_sha256: digest(record.subject),
    runtime_id: timer.runtime_id, record_sha256: digest(rawRecord),
    ...(Object.keys(exact).length ? { exact_timestamps: exact } : {})
  };
  // JSONB prints a space after every colon/comma, unlike JSON.stringify.
  // These metadata values are strings except the one flat timestamps object.
  // Reserve the erasure marker now: privacy erasure must never exceed the cap.
  const erased = { ...origin, data_erased: true };
  const keyCount = Object.keys(erased).length;
  const timestampCount = Object.keys(exact).length;
  const formattingBytes = keyCount + keyCount - 1 +
    (timestampCount ? timestampCount + timestampCount - 1 : 0);
  if (Buffer.byteLength(JSON.stringify(erased), "utf8") + formattingBytes > 2048) return invalid();
  return { timer, origin };
}
