/** Where old clients are sent to update after their collection moves to mdbase-next. */
const DEFAULT_CLIENT_UPDATE_URL = "https://mdbase.dev/downloads";
/** A fenced collection usually finishes its cutover within minutes. */
const COLLECTION_MIGRATING_RETRY_SECONDS = 300;

export interface ClientUpdatePolicy {
  updateUrl: string;
  /** Set by release at cutover; absent until then. */
  minimumClientVersion: string | null;
}

export const DEFAULT_CLIENT_UPDATE_POLICY: ClientUpdatePolicy = {
  updateUrl: DEFAULT_CLIENT_UPDATE_URL,
  minimumClientVersion: null
};

/**
 * A refusal an old client must be able to explain to its user. Apps show
 * `message` verbatim, so it is plain language and never a raw code.
 */
export class CutoverProblemError extends Error {
  constructor(
    readonly kind: "moved" | "onboarding_moved" | "migrating" | "suspended"
  ) {
    super(kind);
  }
}

export function cutoverProblem(error: CutoverProblemError, policy: ClientUpdatePolicy): {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  retryAfterSeconds?: number;
} {
  const moved = {
    reason: "moved_to_next_runtime",
    update_url: policy.updateUrl,
    ...(policy.minimumClientVersion
      ? { minimum_client_version: policy.minimumClientVersion }
      : {})
  };
  if (error.kind === "moved") {
    return {
      status: 409,
      code: "collection_unavailable",
      message: "mdbase was upgraded, and this app needs to update to keep syncing. "
        + "Reload the page, or download the latest version from "
        + `${policy.updateUrl} if you use the desktop or mobile app.`,
      details: moved
    };
  }
  if (error.kind === "onboarding_moved") {
    return {
      status: 409,
      code: "onboarding_moved",
      message: "mdbase was upgraded. Open one of your apps to finish setting up your "
        + `starter collection, or download the latest version from ${policy.updateUrl} `
        + "if you use the desktop or mobile app.",
      details: moved
    };
  }
  if (error.kind === "migrating") {
    return {
      status: 409,
      code: "collection_migrating",
      message: "This collection is being upgraded. Your data is safe, and editing "
        + "will resume once the upgrade finishes. Try again in a few minutes.",
      details: { retry_after_seconds: COLLECTION_MIGRATING_RETRY_SECONDS },
      retryAfterSeconds: COLLECTION_MIGRATING_RETRY_SECONDS
    };
  }
  return {
    status: 403,
    code: "account_suspended",
    message: "This mdbase account is suspended. Contact mdbase support to restore access."
  };
}
