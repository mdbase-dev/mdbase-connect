import type { CollectionHold, HoldResolution, NoteMutationProgress } from "./model";
import type { NoteRowStatus } from "./note-list-view";
import type { NoteActivity, NoteSession } from "./note-session";

export function updateMutationActivity(
  session: NoteSession,
  progress: NoteMutationProgress,
  touch: (target: NoteSession) => void
): void {
  if (progress.state === "preflighting") session.activityDetail = "Checking impact";
  else if (progress.state === "applying") {
    if (progress.resumed) session.activityDetail = progress.operation === "rename" ? "Recovering rename" : "Recovering deletion";
    else if (progress.operation === "rename" && (progress.estimate?.affectedRecords ?? 0) > 0) {
      const count = progress.estimate!.affectedRecords;
      session.activityDetail = `Updating ${count.toLocaleString()} linked ${count === 1 ? "note" : "notes"}`;
    } else session.activityDetail = progress.operation === "rename" ? "Moving note" : "Deleting note";
  } else if (progress.state === "submitted") {
    // Captured by the replica: it will sync, and cancelling now could not undo it.
    session.activityDetail = progress.operation === "rename" ? "Moved; can’t be cancelled now" : "Deleted; can’t be cancelled now";
  } else if (progress.state === "cancelled") session.activityDetail = "Stopping safely";
  session.mutationCancellable = progress.cancellable;
  touch(session);
}

export function noteRowStatus(session: NoteSession): NoteRowStatus | undefined {
  if (session.deleted) return { label: "Deleting", tone: "busy", busy: true, disabled: true };
  if (session.pendingRequestId) return { label: "Recovery pending", tone: "error", busy: false };
  if (session.remoteDocument) return { label: "Changed elsewhere", tone: "error", busy: false };
  if (session.saveState === "error") return { label: "Save failed", tone: "error", busy: false };
  if (session.activity === "saving" || session.activity === "properties" || session.saveState === "saving" && !session.activity) return { tone: "busy", busy: true };
  if (session.activity) {
    const labels: Record<NoteActivity, string> = {
      saving: "Saving", properties: "Updating properties", renaming: "Renaming", moving: "Moving",
      deleting: "Deleting", validating: "Checking"
    };
    return { label: session.activityDetail ?? labels[session.activity], tone: "busy", busy: true };
  }
  if (session.error) return { label: "Needs attention", tone: "error", busy: false };
  return undefined;
}

const HOLD_LABELS: Record<CollectionHold["reason"], string> = {
  conflict: "Changed here and elsewhere",
  unknown_provenance: "Changed outside mdbase",
  deleted_elsewhere: "Deleted on another device",
  read_only: "File is read-only",
  editor_busy: "Open in another editor",
  suspect_write: "Save couldn’t be verified"
};

/** Why a held note isn't syncing; shown on its row so edits never look stuck. */
export function holdLabel(reason: CollectionHold["reason"]): string {
  return HOLD_LABELS[reason];
}

/** The choices offered for a hold, most conservative first. `use` needs a document, so it isn't offered here. */
export function holdActions(hold: CollectionHold): Array<{ how: HoldResolution; label: string }> {
  if (hold.reason === "deleted_elsewhere") return [{ how: "keep_mine", label: "Restore mine" }, { how: "delete", label: "Delete it" }];
  const actions: Array<{ how: HoldResolution; label: string }> = [{ how: "keep_mine", label: "Keep mine" }];
  if (hold.hasTheirs) actions.push({ how: "take_theirs", label: "Use theirs" }, { how: "keep_both", label: "Keep both" });
  return actions;
}
