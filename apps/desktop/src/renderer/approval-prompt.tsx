import { Trans } from "@lingui/react/macro";
import { useLocaleRevision } from "@mdbase-dev/ui/i18n";
import React from "react";

/**
 * One request waiting for the user: an app asking for a collection, or a new
 * computer asking to open a Private collection. Both say who is asking, what
 * they will be able to do, and what to check before approving.
 */
export function ApprovalPrompt({ title, can, check, note, approveLabel, approveDisabled, busy, onApprove, onDecline }: {
  title: string;
  /** "If you approve, ..." */
  can: string;
  /** What to compare before approving: a key fingerprint or a code entry. */
  check: React.ReactNode;
  note?: string;
  approveLabel: string;
  approveDisabled?: boolean;
  busy: boolean;
  onApprove(): void;
  onDecline(): void;
}) {
  useLocaleRevision();
  return (
    <article className="grant-review approval-prompt">
      <div className="grant-identity">
        <h3>{title}</h3>
        <small>{can}</small>
        {check && <div className="approval-check">{check}</div>}
        {note && <small>{note}</small>}
      </div>
      <div className="decision-actions">
        <button className="button secondary" disabled={busy} onClick={onDecline}><Trans>Decline</Trans></button>
        <button className="button primary" disabled={busy || approveDisabled} onClick={onApprove}>{approveLabel}</button>
      </div>
    </article>
  );
}
