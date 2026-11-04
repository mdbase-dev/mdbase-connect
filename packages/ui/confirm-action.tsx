import { t } from "@lingui/core/macro";
import { i18n, useLocaleRevision } from "@mdbase-dev/ui/i18n";
import { ConfirmDialog } from "@mdbase-dev/ui/confirm-dialog";
import { useState, type JSX } from "react";

export function ConfirmAction({ label, question, confirmLabel, busy = false, onConfirm, confirmName, className = "mdbase-button is-tertiary" }: {
  label: string;
  question: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm(): void | Promise<unknown>;
  confirmName?: string;
  className?: string;
}): JSX.Element {
  useLocaleRevision();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  return <>
    <button className={className} disabled={busy} onClick={() => { setTyped(""); setOpen(true); }}>{label}</button>
    <ConfirmDialog open={open} title={label} consequence={question} confirmLabel={confirmLabel}
      pendingLabel={`${confirmLabel}…`} busy={busy} disabled={confirmName !== undefined && typed !== confirmName}
      onClose={() => setOpen(false)} onConfirm={async () => { await onConfirm(); setOpen(false); }}>
      {confirmName !== undefined && <label><span>{t(i18n)`Type ${confirmName} to confirm`}</span>
        <input className="mdbase-field" value={typed} autoComplete="off" spellCheck={false} onChange={(event) => setTyped(event.target.value)} />
      </label>}
    </ConfirmDialog>
  </>;
}
