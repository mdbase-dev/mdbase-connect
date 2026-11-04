import { t } from "@lingui/core/macro";
import { i18n, useLocaleRevision } from "@mdbase-dev/ui/i18n";
import { useState, type JSX } from "react";

/** An inline two-step confirmation: consequential actions name what they will do, in place. */
export function ConfirmAction({ label, question, confirmLabel, busy = false, onConfirm, className = "mdbase-button is-tertiary" }: {
  label: string;
  question: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm(): void;
  className?: string;
}): JSX.Element {
  useLocaleRevision();
  const [open, setOpen] = useState(false);
  if (!open) return <button className={className} disabled={busy} onClick={() => setOpen(true)}>{label}</button>;
  return <span className="confirm-action" role="group" aria-label={question}>
    <span>{question}</span>
    <button className="mdbase-button is-tertiary" disabled={busy} onClick={() => setOpen(false)}>{t(i18n)({ message: "Cancel" })}</button>
    <button className="mdbase-button is-tertiary is-danger" disabled={busy} onClick={() => { onConfirm(); setOpen(false); }}>{busy ? `${confirmLabel}…` : confirmLabel}</button>
  </span>;
}
