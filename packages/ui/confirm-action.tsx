import { t } from "@lingui/core/macro";
import { i18n, useLocaleRevision } from "@mdbase-dev/ui/i18n";
import { ConfirmDialog } from "@mdbase-dev/ui/confirm-dialog";
import { useState, type JSX } from "react";

export function ConfirmAction({ label, question, consequence, confirmLabel, pendingLabel, error, busy = false, onConfirm, confirmName, className = "mdbase-button is-tertiary" }: {
  label: string;
  question: string;
  consequence?: string;
  confirmLabel: string;
  pendingLabel?: string;
  error?: string;
  busy?: boolean;
  onConfirm(): void | Promise<unknown>;
  confirmName?: string;
  className?: string;
}): JSX.Element {
  useLocaleRevision();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [failed, setFailed] = useState(false);
  return <>
    <button className={className} disabled={busy} onClick={() => { setTyped(""); setFailed(false); setOpen(true); }}>{label}</button>
    <ConfirmDialog open={open} title={question} consequence={consequence} confirmLabel={confirmLabel}
      pendingLabel={pendingLabel ?? `${confirmLabel}…`} busy={busy} disabled={confirmName !== undefined && typed !== confirmName}
      onClose={() => setOpen(false)} onConfirm={async () => { setFailed(false); if (await onConfirm() !== false) setOpen(false); else setFailed(true); }}>
      {failed && error && <p role="alert">{error}</p>}
      {confirmName !== undefined && <label><span>{t(i18n)`Type ${confirmName} to confirm`}</span>
        <input className="mdbase-field" data-autofocus value={typed} autoComplete="off" spellCheck={false} onChange={(event) => setTyped(event.target.value)} />
      </label>}
    </ConfirmDialog>
  </>;
}
