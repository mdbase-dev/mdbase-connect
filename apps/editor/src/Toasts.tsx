import { t } from "@lingui/core/macro";
import type { ToastItem } from "@mdbase-dev/ui/toast";

type ToastTone = NonNullable<ToastItem["tone"]>;
/** Matches TaskNotes: an Undo stays available for 30 seconds. */
export const undoWindowMs = 30_000;

export function buildToastItems({
  notice,
  recoveryId,
  recoveryMessage,
  recoveryPending = false,
  recoveryBusy,
  onUndo,
  hasPendingRename,
  onResumeRename
}: {
  notice?: { message: string; tone: ToastTone };
  recoveryId: string;
  recoveryMessage?: string;
  /** The change is still being confirmed; Undo is offered once it settles. */
  recoveryPending?: boolean;
  recoveryBusy: boolean;
  onUndo: () => void;
  hasPendingRename: boolean;
  onResumeRename: () => void;
}): ToastItem[] {
  const items: ToastItem[] = notice ? [{ id: "notice", message: notice.message, tone: notice.tone }] : [];
  if (recoveryMessage) items.push(recoveryPending ? {
    id: recoveryId,
    message: recoveryMessage,
    tone: "info",
    sticky: true,
    dismissible: false
  } : {
    id: recoveryId,
    message: recoveryMessage,
    tone: "success",
    durationMs: undoWindowMs,
    action: { label: recoveryBusy ? t`Undoing` : t`Undo`, onAction: onUndo, busy: recoveryBusy }
  });
  if (hasPendingRename) items.push({
    id: "rename-recovery",
    message: t`This rename was interrupted after it started. Resume it to recover the collection’s authoritative result.`,
    tone: "error",
    sticky: true,
    dismissible: false,
    action: { label: t`Resume rename`, onAction: onResumeRename }
  });
  return items;
}
