/** Public diagnostic vocabulary only. Never inspect messages, stacks, causes,
 * response details or arbitrary name/reason properties on adapter exceptions. */
import { MdbaseError, isErrorCode } from "../errors.js";
import { AppInstallationSignInError } from "./installation-sign-in.js";
import { AppCloudCopyHostError } from "./cloud-copy-host.js";
import { AppCloudCopyBootstrapError } from "./cloud-copy-bootstrap.js";
import { AppCollectionSetupError } from "./collection-setup-journal.js";
import { AppCollectionControlError } from "./collection-control.js";
import { AppCollectionJoinError } from "./collection-join-ledger.js";
import { AppCpAuthorityError } from "./cp-authority.js";
import { AppHttpLogError } from "./http-log.js";
import { sanitizeAppServerProblem, type AppServerProblem } from "./cp-problem.js";
import type { RegistrationRefusal } from "../application/registration-refusal.js";

export interface AppWebSignInProblemDetail {
  readonly name: string;
  readonly code: string | null;
  /** Sanitized server refusal (status, problem code/reason, retry, update URL). */
  readonly server?: AppServerProblem;
  /** A refused app registration's typed code and manifest paths. */
  readonly registration?: RegistrationRefusal;
}
const reasons = new Set(["binding", "fenced", "busy", "account_confirmation_required", "outcome_unknown", "response", "refused", "expired", "recovery_required", "unavailable", "collection_migrating", "account_suspended", "update_required"]);
const domCodes = new Set(["AbortError", "ConstraintError", "DataCloneError", "InvalidStateError", "NotAllowedError", "NotFoundError", "NotReadableError", "OperationError", "QuotaExceededError", "SecurityError", "TimeoutError", "TransactionInactiveError", "UnknownError", "VersionError"]);
const result = (problem: string, name: string, code: string | null, server?: AppServerProblem) => Object.freeze({problem, detail: Object.freeze({name, code, ...(server ? {server} : {})})});

export function webSignInProblem(error: unknown): Readonly<{problem: string; detail: AppWebSignInProblemDetail}> {
  try {
    for (const [type, name] of [
      [AppInstallationSignInError, "AppInstallationSignInError"],
      [AppCloudCopyHostError, "AppCloudCopyHostError"],
      [AppCloudCopyBootstrapError, "AppCloudCopyBootstrapError"],
      [AppCollectionSetupError, "AppCollectionSetupError"],
      [AppCollectionControlError, "AppCollectionControlError"],
      [AppCollectionJoinError, "AppCollectionJoinError"],
      [AppCpAuthorityError, "AppCpAuthorityError"],
      [AppHttpLogError, "AppHttpLogError"],
    ] as const) {
      if (error instanceof type) {
        const code = error.reason;
        // An SDK error class does not prove its server detail: re-validate it.
        const server = ("server" in error ? sanitizeAppServerProblem(error.server) : null) ?? undefined;
        return reasons.has(code) ? result(code, name, code, server) : result("open_failed", name, null, server);
      }
    }
    if (error instanceof MdbaseError) {
      const code = isErrorCode(error.code) ? error.code : null;
      return result(code === "outcome_unknown" ? code : "open_failed", "MdbaseError", code);
    }
    if (typeof DOMException !== "undefined" && error instanceof DOMException) {
      const code = domCodes.has(error.name) ? error.name : null;
      return result("open_failed", "DOMException", code);
    }
    for (const [type, name] of [[TypeError, "TypeError"], [RangeError, "RangeError"], [SyntaxError, "SyntaxError"], [ReferenceError, "ReferenceError"], [URIError, "URIError"], [EvalError, "EvalError"], [Error, "Error"]] as const) {
      if (error instanceof type) return result("open_failed", name, null);
    }
  } catch { /* Hostile getters/proxies cannot replace the original rejection. */ }
  return result("open_failed", "UnknownError", null);
}
