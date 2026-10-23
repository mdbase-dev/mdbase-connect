import { t, plural } from "@lingui/core/macro";
import type { MutationProgress } from "@mdbase-dev/connect";
import type { NoteRowStatus } from "./note-list-view";
import type { NoteActivity, NoteSession } from "./note-session";

export function updateMutationActivity(
  session: NoteSession,
  progress: MutationProgress,
  touch: (target: NoteSession) => void
): void {
  if (progress.state === "preflighting") session.activityDetail = t`Checking impact`;
  else if (progress.state === "applying") {
    if (progress.resumed) session.activityDetail = progress.operation === "rename" ? t`Recovering rename` : t`Recovering deletion`;
    else if (progress.operation === "rename" && (progress.estimate?.affectedRecords ?? 0) > 0) {
      const count = progress.estimate!.affectedRecords;
      session.activityDetail = plural(count, { one: `Updating # linked note`, other: `Updating # linked notes` });
    } else session.activityDetail = progress.operation === "rename" ? t`Moving note` : t`Deleting note`;
  } else if (progress.state === "cancelled") session.activityDetail = t`Stopping safely`;
  session.mutationCancellable = progress.cancellable;
  touch(session);
}

export function noteRowStatus(session: NoteSession): NoteRowStatus | undefined {
  if (session.deleted) return { label: t`Deleting`, tone: "busy", busy: true, disabled: true };
  if (session.pendingRequestId) return { label: t`Not confirmed yet`, tone: "error", busy: false };
  if (session.remoteDocument) return { label: t`Changed elsewhere`, tone: "error", busy: false };
  if (session.saveState === "error") return { label: t`Save failed`, tone: "error", busy: false };
  if (session.activity === "saving" || session.activity === "properties" || session.saveState === "saving" && !session.activity) return { tone: "busy", busy: true };
  if (session.activity) {
    const labels: Record<NoteActivity, string> = {
      saving: t`Saving`, properties: t`Updating properties`, renaming: t`Renaming`, moving: t`Moving`,
      deleting: t`Deleting`, validating: t`Checking`
    };
    return { label: session.activityDetail ?? labels[session.activity], tone: "busy", busy: true };
  }
  if (session.error) return { label: t`Needs attention`, tone: "error", busy: false };
  return undefined;
}
