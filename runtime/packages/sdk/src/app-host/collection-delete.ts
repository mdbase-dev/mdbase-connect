/** Bounded outcomes of an owner's collection delete. Codes only: no server
 * message, body or identity crosses the Worker boundary. */
import { AppInstallationSignInError } from "./installation-sign-in.js";
import { sanitizeAppServerProblem } from "./cp-problem.js";

export const COLLECTION_DELETE_CODES = [
  "collection_delete_name_mismatch", "collection_delete_not_owner", "collection_delete_not_found",
  "collection_delete_frozen", "collection_delete_busy", "collection_delete_not_approved",
  "collection_delete_sign_in", "collection_delete_invalid", "collection_delete_outcome_unknown",
  "collection_delete_failed",
] as const;
export type AppCollectionDeleteCode = (typeof COLLECTION_DELETE_CODES)[number];

export class AppCollectionDeleteError extends Error {
  constructor(readonly code: AppCollectionDeleteCode) {
    super(`collection delete: ${code}`); this.name = "AppCollectionDeleteError";
  }
}

/** CP refusal code → delete outcome. Null prototype: inherited names never match. */
const SERVER: Readonly<Record<string, AppCollectionDeleteCode>> = Object.assign(Object.create(null) as Record<string, AppCollectionDeleteCode>, {
  collection_name_mismatch: "collection_delete_name_mismatch",
  not_owner: "collection_delete_not_owner",
  not_found: "collection_delete_not_found",
  migration_frozen: "collection_delete_frozen",
  busy: "collection_delete_busy",
  not_member: "collection_delete_not_approved",
  device_not_enrolled: "collection_delete_not_approved",
  installation_collection_not_approved: "collection_delete_not_approved",
  installation_not_current: "collection_delete_sign_in",
  identity_not_current: "collection_delete_sign_in",
  device_revoked: "collection_delete_sign_in",
  invalid_request: "collection_delete_invalid",
});

export function collectionDeleteError(error: unknown): AppCollectionDeleteError {
  try {
    if (error instanceof AppCollectionDeleteError) return error;
    if (error instanceof AppInstallationSignInError) {
      if (error.reason === "outcome_unknown") return new AppCollectionDeleteError("collection_delete_outcome_unknown");
      if (error.reason === "binding") return new AppCollectionDeleteError("collection_delete_invalid");
      const code = sanitizeAppServerProblem(error.server)?.code;
      if (code && Object.hasOwn(SERVER, code)) return new AppCollectionDeleteError(SERVER[code]!);
      // Refused locally: not in this installation's approved scope.
      if (error.reason === "refused" && !error.server) return new AppCollectionDeleteError("collection_delete_not_approved");
    }
  } catch { /* hostile error objects never pick the outcome */ }
  return new AppCollectionDeleteError("collection_delete_failed");
}
