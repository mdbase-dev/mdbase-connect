import { useEffect, useRef } from "react";
import { CheckCircleIcon as CheckCircle, WarningCircleIcon as CircleAlert, XIcon as X } from "./icons";

export type ToastTone = "info" | "success" | "error";

export interface ToastAction {
  label: string;
  onAction: () => void;
  busy?: boolean;
}

export interface ToastItem {
  id: string;
  message: string;
  tone: ToastTone;
  action?: ToastAction;
  sticky?: boolean;
  dismissible?: boolean;
}

const autoDismissMs = 6_000;

export function buildToastItems({
  notice,
  recoveryMessage,
  recoveryBusy,
  onUndo,
  hasPendingRename,
  onResumeRename
}: {
  notice?: { message: string; tone: ToastTone };
  recoveryMessage?: string;
  recoveryBusy: boolean;
  onUndo: () => void;
  hasPendingRename: boolean;
  onResumeRename: () => void;
}): ToastItem[] {
  const items: ToastItem[] = notice ? [{ id: "notice", message: notice.message, tone: notice.tone }] : [];
  if (recoveryMessage) items.push({
    id: "recovery",
    message: recoveryMessage,
    tone: "success",
    sticky: true,
    action: { label: recoveryBusy ? "Undoing" : "Undo", onAction: onUndo, busy: recoveryBusy }
  });
  if (hasPendingRename) items.push({
    id: "rename-recovery",
    message: "This rename was interrupted after it started. Resume it to recover the collection’s authoritative result.",
    tone: "error",
    sticky: true,
    dismissible: false,
    action: { label: "Resume rename", onAction: onResumeRename }
  });
  return items;
}

export function ToastStack({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: string) => void }) {
  if (!toasts.length) return null;
  return <div className="toast-stack" aria-label="Notifications">
    {toasts.map((toast) => <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />)}
  </div>;
}

function Toast({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: string) => void }) {
  const dismiss = () => onDismiss(toast.id);
  useAutoDismiss(toast, dismiss);
  return <div className={`toast toast-${toast.tone}`} role="status" data-toast={toast.id}>
    {toast.tone === "error" ? <CircleAlert aria-hidden="true" /> : toast.tone === "success" ? <CheckCircle aria-hidden="true" /> : null}
    <span>{toast.message}</span>
    {toast.action && <button disabled={toast.action.busy} onClick={toast.action.onAction}>{toast.action.label}</button>}
    {toast.dismissible === false ? null : <button className="icon-button" aria-label="Dismiss notification" disabled={toast.action?.busy} onClick={dismiss}><X aria-hidden="true" /></button>}
  </div>;
}

function useAutoDismiss(toast: ToastItem, dismiss: () => void) {
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;
  useEffect(() => {
    if (toast.sticky || toast.action) return;
    const timer = window.setTimeout(() => dismissRef.current(), autoDismissMs);
    return () => window.clearTimeout(timer);
  }, [toast.message, toast.sticky, toast.action]);
}
