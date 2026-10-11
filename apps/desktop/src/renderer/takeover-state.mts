// Presents the daemon's `migrate.status` (the move from the old Connect engine to
// mdbase). The app never starts a move on its own: the daemon moves automatically
// once the account's rollout allows it, and this panel only offers an explicit,
// user-initiated "Move to the new sync engine".

export interface TakeoverCollection {
  state: "pending" | "postponed" | "complete" | "held" | "rolled_back" | string;
  reason?: string;
  rolled_forward?: number;
  holds?: number;
  registered?: boolean;
  marker_incident?: boolean;
}

export interface TakeoverHold {
  path: string;
  reason: string;
}

export interface TakeoverStatus {
  record: null | {
    state: "started" | "complete" | "postponed" | string;
    updated_at?: string;
    old_state_dir?: string;
    collections: Record<string, TakeoverCollection>;
  };
  revived?: boolean;
  error?: string | null;
  holds?: Record<string, TakeoverHold[]>;
  held_interrupted_writes?: number;
  waiting_for_migration_batch?: boolean;
}

export interface TakeoverRow {
  id: string;
  label: string;
  state: string;
  reason?: string;
  advice?: string;
  holds: TakeoverHold[];
}

export interface TakeoverView {
  visible: boolean;
  tone: "info" | "progress" | "attention" | "done";
  title: string;
  detail: string;
  advice?: string;
  rows: TakeoverRow[];
  incidents: string[];
  canStart: boolean;
  offerStopMirrors: boolean;
  inProgress: boolean;
}

const reasons: Record<string, { label: string; advice: string }> = {
  old_daemon_running: {
    label: "the old mdbase Connect is still running",
    advice: "Quit mdbase Connect (including its menu-bar or tray icon), then choose Move to the new sync engine."
  },
  folder_locked: {
    label: "another program is writing to the folder",
    advice: "Close apps that are editing this folder, then choose Move to the new sync engine."
  },
  mirrors_present: {
    label: "this computer also syncs hosted collections with the old engine",
    advice: "Let those collections finish uploading, then move again and allow hosted mirrors to stop. They pause until you join them again."
  },
  mirror_queue_not_empty: {
    label: "hosted collections still have edits waiting to upload",
    advice: "Stay online until uploads finish, then try again."
  },
  mirror_state_unreadable: {
    label: "the old engine's mirror state could not be read",
    advice: "Leave mdbase Connect's data in place and contact support with a diagnostics report."
  },
  mirror_folder: {
    label: "the folder is a copy of a hosted collection",
    advice: "It moves when you join that hosted collection on this computer."
  },
  claimed_by_other_replica: {
    label: "the folder belongs to a different mdbase install",
    advice: "Check whether this folder was copied from another computer. Nothing was changed."
  },
  invalid_marker: {
    label: "the folder's mdbase marker is unreadable",
    advice: "Nothing was changed. Contact support with a diagnostics report."
  },
  folder_missing: {
    label: "the folder is missing",
    advice: "Reconnect the drive or restore the folder; the old engine's data is kept."
  },
  takeover_failed: {
    label: "the move failed and will be retried",
    advice: "It retries when mdbase restarts. If it keeps failing, move again to see the error."
  }
};

const MIRROR_REASONS = new Set(["mirrors_present", "mirror_queue_not_empty"]);
const UNSETTLED = new Set(["pending", "postponed"]);

function describe(reason: string | undefined): { label?: string; advice?: string } {
  if (!reason) return {};
  return reasons[reason] ?? { label: reason.replaceAll("_", " ") };
}

const hidden: TakeoverView = {
  visible: false,
  tone: "done",
  title: "",
  detail: "",
  rows: [],
  incidents: [],
  canStart: false,
  offerStopMirrors: false,
  inProgress: false
};

export function presentTakeover(
  status: TakeoverStatus | null,
  names: Record<string, string> = {},
  starting = false
): TakeoverView {
  if (!status) return hidden;
  const record = status.record;
  const incidents: string[] = [];
  if (status.revived) {
    incidents.push("The old mdbase Connect started again after the move. Quit it and remove it from your login items; mdbase has taken over its collections.");
  }
  if (status.error) incidents.push(`The last move attempt failed: ${status.error}`);
  const interrupted = status.held_interrupted_writes ?? 0;
  if (interrupted > 0) {
    incidents.push(`${interrupted} interrupted ${interrupted === 1 ? "write was" : "writes were"} kept for review; your files were left as they were.`);
  }

  if (!record) {
    if (starting) return { ...hidden, visible: true, tone: "progress", title: "Moving your collections to mdbase…", detail: "Keep mdbase open. This can take a few minutes.", incidents, inProgress: true };
    if (status.waiting_for_migration_batch) {
      return {
        ...hidden,
        visible: true,
        tone: "info",
        title: "Move to the new sync engine",
        detail: "Your collections still run on the old mdbase Connect engine. They move automatically when your account is scheduled, or you can move them now. Your files stay where they are.",
        incidents,
        canStart: true
      };
    }
    if (status.error) {
      return { ...hidden, visible: true, tone: "attention", title: "Move to the new sync engine", detail: "The move could not finish.", incidents, canStart: true };
    }
    return hidden;
  }

  const rows: TakeoverRow[] = Object.entries(record.collections).map(([id, collection]) => {
    const { label, advice } = describe(collection.reason);
    if (collection.marker_incident) {
      incidents.push(`${names[id] ?? id}: the folder's mdbase marker was removed or changed after the move. mdbase stopped serving it so nothing is overwritten.`);
    }
    return {
      id,
      label: names[id] ?? id,
      state: collection.state,
      reason: label,
      advice,
      holds: status.holds?.[id] ?? []
    };
  }).sort((a, b) => a.label.localeCompare(b.label));
  const unsettled = rows.filter((row) => UNSETTLED.has(row.state));
  const offerStopMirrors = Object.values(record.collections)
    .some((collection) => MIRROR_REASONS.has(collection.reason ?? ""));
  const held = rows.filter((row) => row.state === "held");
  const view = { ...hidden, visible: true, rows, incidents, offerStopMirrors, canStart: !starting && unsettled.length > 0 };

  if (starting || record.state === "started") {
    return { ...view, tone: "progress", canStart: false, inProgress: true, title: "Moving your collections to mdbase…", detail: "Keep mdbase open. Your files stay where they are." };
  }
  if (record.state === "postponed" || unsettled.length > 0) {
    const first = unsettled.find((row) => row.reason) ?? unsettled[0];
    return {
      ...view,
      tone: "attention",
      title: first?.reason ? `Migration postponed: ${first.reason}` : "Migration postponed",
      detail: "The old mdbase Connect keeps serving these collections until the move finishes. Nothing was changed.",
      advice: first?.advice
    };
  }
  if (held.length > 0 || incidents.length > 0) {
    return {
      ...view,
      tone: "attention",
      title: "Your collections moved to mdbase",
      detail: held.length > 0
        ? "Some files were being written during the move. mdbase kept the files in your folder as they are; the unfinished versions are kept in the old Connect data."
        : "The move finished, but needs your attention."
    };
  }
  return hidden;
}
