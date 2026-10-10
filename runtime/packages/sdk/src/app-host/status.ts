/** First-party app-host status. Local persistence is not a log acknowledgement. */
export interface AppStoragePolicy {
  /** True only after navigator.storage.persisted()/persist() returned true. */
  persistent: boolean;
  /** PWA standalone (including iOS standalone) or an installed native app. */
  installed: boolean;
}

export type AppSaveState =
  | { kind: "no_pending_edits"; unsynced: 0; warning: null }
  | { kind: "not_yet_synced"; unsynced: number; warning: "storage_may_be_evicted" | null };

/** `unsynced` comes from the recovered replica's pending count, never a transport
 * heuristic. Zero pending is NOT proof that an individual mutation was saved:
 * rejected/unknown receipts remain separate, explicit outcomes. */
export function appSaveState(unsynced: number, policy: AppStoragePolicy): AppSaveState {
  if (!Number.isSafeInteger(unsynced) || unsynced < 0) throw new RangeError("invalid unsynced count");
  if (unsynced === 0) return { kind: "no_pending_edits", unsynced: 0, warning: null };
  return {
    kind: "not_yet_synced",
    unsynced,
    warning: !policy.persistent || !policy.installed ? "storage_may_be_evicted" : null,
  };
}

/** Only a log-confirmed receipt may produce the user-facing "saved" state. */
export function appMutationSaveState(
  receiptState: "pending" | "confirmed" | "rejected" | "unknown",
): "not_yet_synced" | "saved" | "rejected" | "outcome_unknown" {
  switch (receiptState) {
    case "pending": return "not_yet_synced";
    case "confirmed": return "saved";
    case "rejected": return "rejected";
    case "unknown": return "outcome_unknown";
    default: throw new RangeError("invalid receipt state");
  }
}

export const UNSYNCED_STORAGE_WARNING =
  "Changes are not yet synced. Device storage may be cleared before they sync. Connect to sync now; persistent storage and installing the app reduce this risk but do not guarantee against deletion.";

/** Host progress is not a new replica-client wire slot. */
export type AppReplicaReadiness =
  | { phase: "opening" | "waiting_for_key"; readable: false; writable: false }
  | { phase: "installing"; readable: boolean; writable: false; complete: false; installed: number; total: number | null }
  | { phase: "ready"; readable: true; writable: boolean; complete: true; stale: boolean }
  | { phase: "blocked"; readable: boolean; writable: false; reason: "storage" | "integrity" | "upgrade_required" | "authorization" };

/** Small injected navigator surface: no Capacitor dependency and no Worker→UI RPC. */
export interface PersistencePort {
  persisted(): Promise<boolean>;
  persist?(): Promise<boolean>;
}

/** Asking for persistence is explicit; a denied/unsupported/error result is false,
 * never permission to reset the database. Installation status is supplied by UI. */
export async function appStoragePolicy(
  storage: PersistencePort | undefined,
  installed: boolean,
  requestPersistence = false,
): Promise<AppStoragePolicy> {
  let persistent = false;
  try {
    persistent = (await storage?.persisted()) === true;
    if (!persistent && requestPersistence) persistent = (await storage?.persist?.()) === true;
  } catch {
    // Preserve a verified positive result; otherwise report the conservative state.
  }
  return { persistent, installed };
}
