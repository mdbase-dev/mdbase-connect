import React from "react";
import type { CollectionCompletionReceipt as Receipt } from "./onboarding-state.mjs";

export function CollectionCompletionReceipt({ receipt, hasPendingAuthorization, onOpenFolder, onUseInApplication, onOpenEditor, onViewDetails, onAddSyncedFolder, onDismiss }: {
  receipt: Receipt;
  hasPendingAuthorization: boolean;
  onOpenFolder(): void;
  onUseInApplication(): void;
  onOpenEditor(): void;
  onViewDetails(): void;
  onAddSyncedFolder(): void;
  onDismiss(): void;
}) {
  const local = receipt.authority === "local";
  return <section className="completion-receipt" aria-labelledby="completion-receipt-title">
    <div className="completion-receipt-heading">
      <div>
        <p className="eyebrow">Collection ready</p>
        <h2 id="completion-receipt-title">{receipt.collectionName} is connected.</h2>
      </div>
      <button className="quiet-action" onClick={onDismiss}>Done</button>
    </div>
    <dl className="completion-receipt-facts">
      <div><dt>Main copy</dt><dd>{local ? "On this computer" : "Hosted by mdbase"}</dd></div>
      {local && receipt.path && <div><dt>Folder</dt><dd><code title={receipt.path}>{receipt.path}</code></dd></div>}
      <div><dt>Privacy</dt><dd>{local ? "The folder path stays private." : "Add a synced folder if you want a copy on this computer."}</dd></div>
    </dl>
    <div className="completion-receipt-actions" aria-label="Next actions">
      {local
        ? <button className="button primary" onClick={onOpenFolder}>Open folder</button>
        : <button className="button primary" onClick={onAddSyncedFolder}>Add a synced folder</button>}
      {hasPendingAuthorization && <button className="button secondary" onClick={onUseInApplication}>Use in application</button>}
      <button className="quiet-action" onClick={onOpenEditor}>Open in mdbase Editor <span aria-hidden="true">↗</span></button>
      <button className="quiet-action" onClick={onViewDetails}>View collection details</button>
    </div>
  </section>;
}
