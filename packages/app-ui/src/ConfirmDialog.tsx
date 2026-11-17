import { t } from "@lingui/core/macro";
import { useId, useState, type JSX, type ReactNode, type RefObject } from "react";

import { Dialog } from "./Dialog.js";
import { useLocaleRevision } from "./i18n.js";

/**
 * Asks before an action that is hard to take back. Cancel has the initial focus unless
 * `initialFocus` says otherwise; while the action runs the dialog stays open and cannot be
 * dismissed, and the confirm button says what is happening.
 */
export function ConfirmDialog({
  open,
  title,
  consequence,
  confirmLabel,
  pendingLabel,
  busy = false,
  disabled = false,
  onConfirm,
  onClose,
  returnFocusRef,
  children,
  cancelLabel = t({ message: "Cancel" }),
  tone = "danger",
  initialFocus = "cancel",
  role = "dialog",
}: {
  readonly open: boolean;
  readonly title: string;
  readonly consequence?: string;
  readonly confirmLabel: string;
  readonly pendingLabel: string;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly onConfirm: () => void | Promise<unknown>;
  readonly onClose: () => void;
  readonly returnFocusRef?: RefObject<HTMLElement | null> | undefined;
  readonly children?: ReactNode;
  readonly cancelLabel?: string | undefined;
  readonly tone?: "default" | "danger" | undefined;
  readonly initialFocus?: "confirm" | "cancel" | undefined;
  readonly role?: "dialog" | "alertdialog";
}): JSX.Element | null {
  useLocaleRevision();
  const [pending, setPending] = useState(false);
  const descriptionId = useId();
  const working = busy || pending;
  return (
    <Dialog
      open={open}
      role={role}
      title={title}
      descriptionId={consequence ? descriptionId : undefined}
      onClose={onClose}
      closeDisabled={working}
      returnFocusRef={returnFocusRef}
      className="mdbase-confirm-dialog"
    >
      {consequence && <p id={descriptionId}>{consequence}</p>}
      {children}
      <footer className="mdbase-dialog-actions">
        <button
          type="button"
          className="mdbase-button is-tertiary"
          data-autofocus={initialFocus === "cancel" || undefined}
          disabled={working}
          onClick={onClose}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          className={`mdbase-button ${tone === "danger" ? "is-danger" : "is-primary"}`}
          data-autofocus={initialFocus === "confirm" || undefined}
          aria-busy={working || undefined}
          disabled={working || disabled}
          onClick={async (event) => {
            // The button is about to be disabled; the dialog keeps the focus meanwhile.
            event.currentTarget.closest("dialog")?.focus({ preventScroll: true });
            setPending(true);
            try {
              await onConfirm();
            } finally {
              setPending(false);
            }
          }}
        >
          {/* The label not showing still sets the width (data-other), so nothing shifts. */}
          <span className="mdbase-button-label" data-other={working ? confirmLabel : pendingLabel}>
            {working ? pendingLabel : confirmLabel}
          </span>
        </button>
      </footer>
    </Dialog>
  );
}
