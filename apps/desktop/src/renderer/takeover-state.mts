import { t, plural } from "@lingui/core/macro";
import { i18n } from "@mdbase-dev/ui/i18n";
// Presents the daemon's `migrate.status` (the move from the old Connect engine to
// mdbase). The app never starts a move on its own: the daemon moves automatically
// once the account's rollout allows it. This panel offers an explicit "Move to the
// new sync engine" only to finish a move the server already allowed; it is never
// offered while the account is waiting for, or was returned from, its upgrade.

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

/** Unsent edits captured from an old hosted mirror, and how their import went. */
interface MirrorImport {
  mirror_root?: string;
  captured_at?: string;
  edits?: number;
  applied?: number;
  already_present?: number;
  superseded?: number;
  held?: number;
  recovered?: { path: string; reason: string; file: string }[];
  waiting?: number;
  complete?: boolean;
  registered?: boolean;
  name?: string;
  root?: string;
  error?: string;
  /** Bringing the hosted collection back on this computer (an ordinary join). */
  join?: {
    state: "waiting" | "joined" | "error" | string;
    folder?: string | null;
    reason?: string | null;
    attempts?: number;
    cut_over?: boolean;
  };
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
  /** Why the move waits: `sign_in`, `account_not_upgraded` or `unreachable`. */
  waiting_reason?: string | null;
  /** The server's last answer: the account is on mdbase Connect (not upgraded
   * yet, or its upgrade was rolled back). Absent from older daemons. */
  account_legacy?: boolean;
  /** Whether the server confirmed retiring the old connector after a move. */
  retirement?: { retired: boolean; reason?: string; legacy_connector_id?: string } | null;
  mirror_imports?: Record<string, MirrorImport>;
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
  /** Informational lines that need no action now. */
  notices: string[];
  canStart: boolean;
  offerStopMirrors: boolean;
  inProgress: boolean;
}

const reasons: Record<string, { label: string; advice: string }> = {
  old_daemon_running: {
    get label() { return t(i18n)({ message: "the old mdbase Connect is still running" }); },
    get advice() { return t(i18n)({ message: "Quit mdbase Connect (including its menu-bar or tray icon), then choose Move to the new sync engine." }); }
  },
  folder_locked: {
    get label() { return t(i18n)({ message: "another program is writing to the folder" }); },
    get advice() { return t(i18n)({ message: "Close apps that are editing this folder, then choose Move to the new sync engine." }); }
  },
  mirrors_present: {
    get label() { return t(i18n)({ message: "this computer also syncs hosted collections with the old engine" }); },
    get advice() { return t(i18n)({ message: "Choose Move to the new sync engine and allow hosted mirrors to stop. Edits they have not uploaded yet are kept and added when you join those collections on this computer." }); }
  },
  mirror_queue_not_empty: {
    get label() { return t(i18n)({ message: "hosted collections still have edits waiting to upload" }); },
    get advice() { return t(i18n)({ message: "Stay online until uploads finish, then try again." }); }
  },
  mirror_capture_failed: {
    get label() { return t(i18n)({ message: "edits waiting to upload in hosted collections could not be saved for the move" }); },
    get advice() { return t(i18n)({ message: "Check that the disk is not full, then try again. Nothing was changed." }); }
  },
  mirror_state_unreadable: {
    get label() { return t(i18n)({ message: "the old engine's mirror state could not be read" }); },
    get advice() { return t(i18n)({ message: "Leave mdbase Connect's data in place and contact support with a diagnostics report." }); }
  },
  mirror_folder: {
    get label() { return t(i18n)({ message: "the folder is a copy of a hosted collection" }); },
    get advice() { return t(i18n)({ message: "It moves when you join that hosted collection on this computer." }); }
  },
  claimed_by_other_replica: {
    get label() { return t(i18n)({ message: "the folder belongs to a different mdbase install" }); },
    get advice() { return t(i18n)({ message: "Check whether this folder was copied from another computer. Nothing was changed." }); }
  },
  invalid_marker: {
    get label() { return t(i18n)({ message: "the folder's mdbase marker is unreadable" }); },
    get advice() { return t(i18n)({ message: "Nothing was changed. Contact support with a diagnostics report." }); }
  },
  folder_missing: {
    get label() { return t(i18n)({ message: "the folder is missing", context: "Collection move recovery" }); },
    get advice() { return t(i18n)({ message: "Reconnect the drive or restore the folder; the old engine's data is kept." }); }
  },
  takeover_failed: {
    get label() { return t(i18n)({ message: "the move failed and will be retried" }); },
    get advice() { return t(i18n)({ message: "It retries when mdbase restarts. If it keeps failing, move again to see the error." }); }
  }
};

const MIRROR_REASONS = new Set(["mirrors_present", "mirror_queue_not_empty"]);
const MOVED = new Set(["complete", "held"]);
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
  notices: [],
  canStart: false,
  offerStopMirrors: false,
  inProgress: false
};

const JOIN_WAIT_REASONS: Record<string, string> = {
  get not_signed_in() { return t(i18n)({ message: "Sign in to mdbase to continue" }); },
  get account_changed() { return t(i18n)({ message: "Sign in to mdbase to continue" }); },
  get sync_unreachable() { return t(i18n)({ message: "mdbase will retry when it can reach the server" }); },
  get sync_refused() { return t(i18n)({ message: "mdbase will retry once this collection has finished moving" }); },
  get unexpected_status() { return t(i18n)({ message: "mdbase will retry once this collection has finished moving" }); },
  get folder_not_empty() { return t(i18n)({ message: "mdbase will retry in a new folder" }); }
};

function waitReason(reason: string | null | undefined): string {
  if (!reason) return t(i18n)({ message: "mdbase will retry shortly" });
  return JOIN_WAIT_REASONS[reason] ?? t(i18n)`mdbase will retry (${reason.replaceAll("_", " ")})`;
}

const RECOVERY_REASONS: Record<string, string> = {
  get not_text() { return t(i18n)({ message: "it is not a text file", context: "Collection move recovery" }); }
};

function baseName(path: string | undefined): string | undefined {
  return path?.split(/[\\/]/).filter(Boolean).pop();
}

/** What the user needs to know about unsent edits from old hosted mirrors. */
function presentMirrorImports(
  imports: Record<string, MirrorImport> | undefined,
  names: Record<string, string>
): { incidents: string[]; notices: string[] } {
  const incidents: string[] = [];
  const notices: string[] = [];
  for (const [id, imp] of Object.entries(imports ?? {})) {
    const name = names[id] ?? imp.name ?? baseName(imp.mirror_root) ?? id;
    if (imp.error) {
      incidents.push(t(i18n)`Edits made in “${name}” before the move could not be read (${imp.error}). They are kept in the old Connect data.`);
      continue;
    }
    const waiting = imp.waiting ?? 0;
    const oldPath = imp.mirror_root ?? t(i18n)`the old folder`;
    const join = imp.join;
    const folder = join?.folder ?? undefined;
    const oldFolder = imp.mirror_root && folder && folder !== imp.mirror_root
      ? t(i18n)` The old folder ${imp.mirror_root} is kept as it was.`
      : "";
    if (waiting > 0 && !imp.registered && join?.state === "joined") {
      incidents.push(t(i18n)`${plural(waiting, { one: `You removed “${name}” from this computer, so # edit made in “${name}” before the move was not added to it. It is still in ${oldPath}.`, other: `You removed “${name}” from this computer, so # edits made in “${name}” before the move were not added to it. They are still in ${oldPath}.` })}`);
    } else if (waiting > 0 && !imp.registered) {
      const where = folder ? t(i18n)` in ${folder}` : "";
      const reason = waitReason(join?.reason);
      notices.push(t(i18n)`${plural(waiting, { one: `# edit made in “${name}” before the move was not uploaded yet and is kept. mdbase is adding “${name}” back to this computer${where}. ${reason}.`, other: `# edits made in “${name}” before the move were not uploaded yet and are kept. mdbase is adding “${name}” back to this computer${where}. ${reason}.` })}`);
    } else if (waiting > 0) {
      const after = join && join.cut_over === false && join.reason
        ? ` ${waitReason(join.reason)}.`
        : "";
      const location = folder ? t(i18n)` in ${folder}` : "";
      notices.push(t(i18n)`${plural(waiting, { one: `“${name}” syncs again${location}. # edit made in “${name}” before the move is added once it has caught up.${after}${oldFolder}`, other: `“${name}” syncs again${location}. # edits made in “${name}” before the move are added once it has caught up.${after}${oldFolder}` })}`);
    }
    const held = imp.held ?? 0;
    if (held > 0) {
      incidents.push(t(i18n)`${plural(held, { one: `# unsent edit in “${name}” conflicts with changes made elsewhere. Review it in the collection\'s held files.`, other: `# unsent edits in “${name}” conflict with changes made elsewhere. Review them in the collection\'s held files.` })}`);
    }
    for (const r of imp.recovered ?? []) {
      const why = RECOVERY_REASONS[r.reason] ?? t(i18n)({ message: "the collection did not accept it" });
      incidents.push(t(i18n)`Your unsent edit to ${r.path} in “${name}” could not be added because ${why}. A copy is at ${r.file}.`);
    }
  }
  return { incidents, notices };
}

export function presentTakeover(
  status: TakeoverStatus | null,
  names: Record<string, string> = {},
  starting = false
): TakeoverView {
  if (!status) return hidden;
  const record = status.record;
  const incidents: string[] = [];
  if (status.revived) {
    incidents.push(t(i18n)({ message: "The old mdbase Connect started again after the move. Quit it and remove it from your login items; mdbase has taken over its collections." }));
  }
  if (status.error) incidents.push(t(i18n)`The last move attempt failed: ${status.error}`);
  const mirrors = presentMirrorImports(status.mirror_imports, names);
  incidents.push(...mirrors.incidents);
  const notices = mirrors.notices;
  const interrupted = status.held_interrupted_writes ?? 0;
  if (interrupted > 0) {
    incidents.push(t(i18n)`${plural(interrupted, { one: "# interrupted write was kept for review; your files were left as they were.", other: "# interrupted writes were kept for review; your files were left as they were." })}`);
  }

  const legacy = status.account_legacy === true;
  if (!record) {
    if (starting) return { ...hidden, visible: true, tone: "progress", title: t(i18n)({ message: "Moving your collections to mdbase…" }), detail: t(i18n)({ message: "Keep mdbase open. This can take a few minutes." }), incidents, notices, inProgress: true };
    if (status.waiting_for_migration_batch) {
      // The server has not allowed a move: it would refuse to retire the old
      // connector, so there is nothing to start here.
      const safe = t(i18n)({ message: "Your local collections are safe on disk." });
      if (status.waiting_reason === "sign_in") {
        return {
          ...hidden,
          visible: true,
          tone: "info",
          title: t(i18n)({ message: "Sign in to finish moving your collections" }),
          detail: t(i18n)`${safe} Sign in on this computer so they can move automatically when your account is upgraded.`,
          incidents,
          notices
        };
      }
      return {
        ...hidden,
        visible: true,
        tone: "info",
        title: t(i18n)({ message: "Your collections are waiting to move" }),
        detail: status.waiting_reason === "unreachable"
          ? t(i18n)`${safe} They will move automatically when mdbase can reach the server and confirm your account upgrade.`
          : t(i18n)`${safe} They will move automatically when your account is upgraded, shortly.`,
        incidents,
        notices
      };
    }
    if (status.error) {
      return { ...hidden, visible: true, tone: "attention", title: t(i18n)({ message: "Move to the new sync engine" }), detail: t(i18n)({ message: "The move could not finish." }), incidents, notices, canStart: !legacy };
    }
    if (incidents.length > 0 || notices.length > 0) {
      return { ...hidden, visible: true, tone: incidents.length > 0 ? "attention" : "info", title: t(i18n)({ message: "Your collections moved to mdbase" }), detail: t(i18n)({ message: "Some edits from before the move need your attention." }), incidents, notices };
    }
    return hidden;
  }

  const rows: TakeoverRow[] = Object.entries(record.collections).map(([id, collection]) => {
    const { label, advice } = describe(collection.reason);
    if (collection.marker_incident) {
      incidents.push(t(i18n)`${names[id] ?? id}: the folder's mdbase marker was removed or changed after the move. mdbase stopped serving it so nothing is overwritten.`);
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
  const view = { ...hidden, visible: true, rows, incidents, notices, offerStopMirrors, canStart: !starting && !legacy && unsettled.length > 0 };

  if (starting || record.state === "started") {
    return { ...view, tone: "progress", canStart: false, inProgress: true, title: t(i18n)({ message: "Moving your collections to mdbase…" }), detail: t(i18n)({ message: "Keep mdbase open. Your files stay where they are." }) };
  }
  // Moved on this computer, but the account is on mdbase Connect (it was never
  // upgraded, or its upgrade was paused and returned). Collections look ready
  // here, yet apps that use mdbase Connect cannot reach them: say so.
  if (legacy && (rows.some((row) => MOVED.has(row.state))
      || Object.values(status.mirror_imports ?? {}).some((imp) => imp.registered))) {
    return {
      ...view,
      tone: "attention",
      canStart: false,
      offerStopMirrors: false,
      notices: [],
      title: t(i18n)({ message: "Your account still uses mdbase Connect" }),
      detail: t(i18n)({ message: "This computer moved your collections to the new sync engine, but your mdbase account hasn't been upgraded yet, or its upgrade was paused. Your files are safe in their folders, but changes made on this computer may not reach your other mdbase apps until your account is upgraded." }),
      advice: t(i18n)({ message: "Email support@mdbase.dev and include a diagnostics report. We'll finish your upgrade or move this computer back to mdbase Connect." })
    };
  }
  if (!legacy && status.retirement && status.retirement.retired === false && rows.some((row) => MOVED.has(row.state))) {
    incidents.push(t(i18n)({ message: "The server hasn't confirmed that the old mdbase Connect on this computer is retired. Keep using mdbase as normal. If this message stays, email support@mdbase.dev." }));
  }
  if (record.state === "postponed" || unsettled.length > 0) {
    const first = unsettled.find((row) => row.reason) ?? unsettled[0];
    return {
      ...view,
      tone: "attention",
      title: first?.reason ? t(i18n)`Migration postponed: ${first.reason}` : t(i18n)({ message: "Migration postponed", context: "Collection move recovery" }),
      detail: t(i18n)({ message: "The old mdbase Connect keeps serving these collections until the move finishes. Nothing was changed." }),
      advice: first?.advice
    };
  }
  if (held.length > 0 || incidents.length > 0) {
    return {
      ...view,
      tone: "attention",
      title: t(i18n)({ message: "Your collections moved to mdbase" }),
      detail: held.length > 0
        ? t(i18n)({ message: "Some files were being written during the move. mdbase kept the files in your folder as they are; the unfinished versions are kept in the old Connect data." })
        : t(i18n)({ message: "The move finished, but needs your attention." })
    };
  }
  if (notices.length > 0) {
    return { ...view, tone: "info", title: t(i18n)({ message: "Your collections moved to mdbase" }), detail: t(i18n)({ message: "Some hosted collections have edits from before the move that are not uploaded yet." }) };
  }
  return hidden;
}
