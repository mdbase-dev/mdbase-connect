import { t } from "@lingui/core/macro";
import { useState, type ReactNode, type RefObject } from "react";
import { Dialog } from "./Dialog.js";
import { useLocaleRevision } from "./i18n.js";

export function ConfirmDialog({ open, title, consequence, confirmLabel, pendingLabel, busy = false, disabled = false, onConfirm, onClose, returnFocusRef, children }: {
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
}) {
  useLocaleRevision();
  const [pending, setPending] = useState(false);
  const working = busy || pending;
  return <Dialog open={open} title={title} onClose={onClose} closeDisabled={working} returnFocusRef={returnFocusRef} className="mdbase-confirm-dialog">
    {consequence && <p>{consequence}</p>}
    {children}
    <footer className="mdbase-dialog-actions">
      <button type="button" className="mdbase-button is-tertiary" data-autofocus disabled={working} onClick={onClose}>{t({ message: "Cancel" })}</button>
      <button type="button" className="mdbase-button is-danger" aria-busy={working || undefined} disabled={working || disabled} onClick={async () => {
        setPending(true);
        try { await onConfirm(); } finally { setPending(false); }
      }}>{working ? pendingLabel : confirmLabel}</button>
    </footer>
  </Dialog>;
}
