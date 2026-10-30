/** A bounded, sanitized control-plane (or log server) refusal. Only the public
 * problem vocabulary is kept: never messages, stacks or other response fields. */
export interface AppServerProblem {
  readonly status: number;
  /** One of the 15 SDK codes, or a specific CP code (`collection_migrating`, `account_suspended`, `collection_unavailable`, ...). */
  readonly code: string | null;
  /** The specific cause (`details.reason`). */
  readonly reason: string | null;
  readonly retryAfterMs: number | null;
  /** https only, for `update_required`. */
  readonly updateUrl: string | null;
}
/** Outcomes apps must be able to tell apart. */
export type AppServerOutcome = "collection_not_yet_migrated" | "collection_migrating" | "account_suspended" | "update_required" | "account_collection_quota_exceeded";

const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const genuine = new WeakSet<object>();
/** True only for a problem this module parsed (never an adapter-supplied lookalike). */
export function isAppServerProblem(value: unknown): value is AppServerProblem {
  return typeof value === "object" && value !== null && genuine.has(value);
}
/** Server-directed retry is clamped to 5 s..10 min. */
export const MIN_SERVER_RETRY_MS = 5_000, MAX_SERVER_RETRY_MS = 600_000;
const MIN_RETRY = MIN_SERVER_RETRY_MS, MAX_RETRY = MAX_SERVER_RETRY_MS;
/** Where an update link goes when the server's is missing or not allowlisted. */
export const DEFAULT_UPDATE_URL = "https://mdbase.dev/downloads/";
const name = (value: unknown): string | null => typeof value === "string" && NAME.test(value) ? value : null;
const clampRetry = (ms: number) => Math.min(MAX_RETRY, Math.max(MIN_RETRY, Math.round(ms)));

function retryAfter(details: Record<string, unknown> | null, headers: Pick<Headers, "get"> | null): number | null {
  const ms = details?.retry_after_ms, seconds = details?.retry_after_seconds;
  if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) return clampRetry(ms);
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) return clampRetry(seconds * 1000);
  const header = headers?.get("retry-after")?.trim();
  if (header && /^[0-9]{1,6}$/.test(header)) return clampRetry(Number(header) * 1000);
  return null;
}

/** An update link only to mdbase.dev (or a subdomain) or the declared CP
 * origin, https, without credentials or control characters; otherwise null. */
export function trustedUpdateUrl(value: unknown, cpOrigin: string | null = null): string | null {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    const host = url.hostname;
    return host === "mdbase.dev" || host.endsWith(".mdbase.dev") || (cpOrigin !== null && url.origin === cpOrigin) ? url.href : null;
  } catch { return null; }
}

const FIELDS = "code,reason,retryAfterMs,status,updateUrl";
/** Re-validate a problem that crossed a boundary (an SDK error's `server`
 * argument, a structured-cloned snapshot): exact fields, the public name
 * grammar, the clamped retry and an allowlisted link, else null. The result
 * is a fresh parser-genuine object; the input is never kept. */
export function sanitizeAppServerProblem(value: unknown, cpOrigin: string | null = null): AppServerProblem | null {
  try {
    if (isAppServerProblem(value)) return value;
    if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join(",") !== FIELDS) return null;
    const v = value as Record<string, unknown>;
    const status = v.status, retry = v.retryAfterMs;
    if (typeof status !== "number" || !Number.isSafeInteger(status) || status < 0 || status > 999) return null;
    if ((v.code !== null && name(v.code) === null) || (v.reason !== null && name(v.reason) === null)) return null;
    if (retry !== null && (typeof retry !== "number" || !Number.isFinite(retry) || retry < 0)) return null;
    if (v.updateUrl !== null && typeof v.updateUrl !== "string") return null;
    const problem: AppServerProblem = Object.freeze({status, code: name(v.code), reason: name(v.reason),
      retryAfterMs: retry === null ? null : clampRetry(retry as number), updateUrl: trustedUpdateUrl(v.updateUrl, cpOrigin)});
    genuine.add(problem);
    return problem;
  } catch { return null; /* hostile getters/proxies */ }
}

/** Parse a non-2xx response's already-read JSON body (or `undefined` if none). */
export function appServerProblem(status: number, body: unknown, headers: Pick<Headers, "get"> | null = null, cpOrigin: string | null = null): AppServerProblem {
  const error = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).error : undefined;
  const e = error && typeof error === "object" && !Array.isArray(error) ? error as Record<string, unknown> : null;
  const d = e?.details && typeof e.details === "object" && !Array.isArray(e.details) ? e.details as Record<string, unknown> : null;
  const problem: AppServerProblem = Object.freeze({
    status: Number.isSafeInteger(status) ? status : 0,
    code: name(e?.code),
    reason: name(d?.reason),
    retryAfterMs: retryAfter(d, headers),
    updateUrl: trustedUpdateUrl(d?.update_url, cpOrigin),
  });
  genuine.add(problem);
  return problem;
}

/** Classify the outcomes that need their own user copy. */
export function appServerOutcome(problem: AppServerProblem | null | undefined): AppServerOutcome | null {
  if (!problem) return null;
  const names = [problem.reason, problem.code];
  if (problem.status === 429 && problem.code === "account_collection_quota_exceeded") return "account_collection_quota_exceeded";
  if (names.includes("collection_not_yet_migrated")) return "collection_not_yet_migrated";
  if (names.includes("collection_migrating")) return "collection_migrating";
  if (names.includes("account_suspended")) return "account_suspended";
  // CP: 409 collection_unavailable {reason: moved_to_next_runtime, update_url}.
  if (names.some(n => n === "moved_to_next_runtime" || n === "collection_moved" || n === "client_update_required") || problem.status === 426) return "update_required";
  return null;
}

/** Decode a bounded JSON error body; `undefined` if it is not JSON. */
export function appServerBody(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return undefined; }
}
