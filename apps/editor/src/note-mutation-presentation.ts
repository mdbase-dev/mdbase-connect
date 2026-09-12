import type { MutationProgress } from "@mdbase-dev/connect";
import type { NoteRowStatus } from "./NoteList";
import type { NoteActivity, NoteSession } from "./note-session";

export function updateMutationActivity(
  session: NoteSession,
  progress: MutationProgress,
  touch: (target: NoteSession) => void
): void {
  if (progress.state === "preflighting") session.activityDetail = "Checking impact";
  else if (progress.state === "applying") {
    if (progress.resumed) session.activityDetail = progress.operation === "rename" ? "Recovering rename" : "Recovering deletion";
    else if (progress.operation === "rename" && (progress.estimate?.affectedRecords ?? 0) > 0) {
      const count = progress.estimate!.affectedRecords;
      session.activityDetail = `Updating ${count.toLocaleString()} linked ${count === 1 ? "note" : "notes"}`;
    } else session.activityDetail = progress.operation === "rename" ? "Moving note" : "Deleting note";
  } else if (progress.state === "cancelled") session.activityDetail = "Stopping safely";
  session.mutationCancellable = progress.cancellable;
  touch(session);
}

export function noteRowStatus(session: NoteSession): NoteRowStatus | undefined {
  if (session.deleted) return { label: "Deleting", tone: "busy", busy: true, disabled: true };
  if (session.remoteDocument) return { label: "Changed elsewhere", tone: "error", busy: false };
  if (session.activity) {
    const labels: Record<NoteActivity, string> = {
      saving: "Saving", properties: "Updating properties", renaming: "Renaming", moving: "Moving",
      deleting: "Deleting", validating: "Checking"
    };
    return { label: session.activityDetail ?? labels[session.activity], tone: "busy", busy: true };
  }
  if (session.saveState === "conflict") return { label: "Save failed", tone: "error", busy: false };
  if (session.error) return { label: "Needs attention", tone: "error", busy: false };
  if (session.saveState === "waiting") return { label: "Unsaved", tone: "quiet", busy: false };
  return undefined;
}
