/**
 * The 15 error codes (`replica-client-api.md` §9). Each has exactly one recovery
 * action. Offline and warming indexes are status/reset or complete:false.
 * Generic query cursor expiry/staleness uses typed invalid_request reasons;
 * paging resets require explicit caller clearing before a fresh first page.
 */
import type { Issue, Problem, Recovery } from "./wire.js";

export const ERROR_CODES = {
  invalid_request: "fix_request",
  invalid_record: "fix_request",
  not_found: "refresh",
  conflict: "resolve_conflict",
  unauthenticated: "reauthorize",
  forbidden: "reauthorize",
  collection_invalid: "repair_collection",
  unavailable: "retry",
  rate_limited: "retry",
  quota_exceeded: "free_space",
  too_large: "fix_request",
  upgrade_required: "upgrade",
  outcome_unknown: "resolve_outcome",
  cancelled: "none",
  internal: "contact_support",
} as const satisfies Record<string, Recovery>;

export type ErrorCode = keyof typeof ERROR_CODES;

export function isErrorCode(code: string): code is ErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_CODES, code);
}

/** The recovery action for a code, or `contact_support` for a code this SDK doesn't know. */
export function recoveryFor(code: string): Recovery {
  return isErrorCode(code) ? ERROR_CODES[code] : "contact_support";
}

/**
 * An error from a replica or from the SDK itself. Apps branch on `code` (and
 * optionally `reason`) and show their own text; `message` is for developers.
 */
export class MdbaseError extends Error {
  readonly code: ErrorCode;
  readonly recovery: Recovery;
  readonly reason?: string;
  readonly details?: unknown;
  readonly retryAfterMs?: number;
  readonly issues?: Issue[];
  readonly traceId?: string;

  constructor(problem: Problem) {
    super(problem.message);
    this.name = "MdbaseError";
    // A code outside the 15 is a replica bug or a newer API; never invent recovery.
    this.code = isErrorCode(problem.code) ? problem.code : "internal";
    this.recovery = isErrorCode(problem.code) ? problem.recovery : "contact_support";
    if (problem.reason !== undefined) this.reason = problem.reason;
    if (problem.details !== undefined) this.details = problem.details;
    if (problem.retryAfterMs !== undefined) this.retryAfterMs = problem.retryAfterMs;
    if (problem.issues !== undefined) this.issues = problem.issues;
    if (problem.traceId !== undefined) this.traceId = problem.traceId;
  }

  toProblem(): Problem {
    const p: Problem = { code: this.code, recovery: this.recovery, message: this.message };
    if (this.reason !== undefined) p.reason = this.reason;
    if (this.details !== undefined) p.details = this.details as Problem["details"];
    if (this.retryAfterMs !== undefined) p.retryAfterMs = this.retryAfterMs;
    if (this.issues !== undefined) p.issues = this.issues;
    if (this.traceId !== undefined) p.traceId = this.traceId;
    return p;
  }
}

/** Build an error locally (transport failures, cancellation, schema mismatches). */
export function mdbaseError(
  code: ErrorCode,
  message: string,
  /** A `reason` string, or more problem fields. */
  extra: string | Partial<Omit<Problem, "code" | "recovery" | "message">> = {},
): MdbaseError {
  const more = typeof extra === "string" ? { reason: extra } : extra;
  return new MdbaseError({ code, recovery: ERROR_CODES[code], message, ...more });
}

export function isMdbaseError(e: unknown, code?: ErrorCode): e is MdbaseError {
  return e instanceof MdbaseError && (code === undefined || e.code === code);
}
