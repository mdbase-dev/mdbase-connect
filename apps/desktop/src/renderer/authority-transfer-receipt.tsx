import React from "react";
import type { AuthorityTransferReceipt as Receipt } from "./onboarding-state.mjs";

export function AuthorityTransferReceipt({ receipt, onOpen, onReconnect, onViewDetails, onDismiss }: {
  receipt: Receipt;
  onOpen(): void;
  onReconnect(): void;
  onViewDetails(): void;
  onDismiss(): void;
}) {
  const local = receipt.direction === "hosted_to_local";
  return <section className="completion-receipt transfer-receipt" aria-labelledby="transfer-receipt-title">
    <div className="completion-receipt-heading">
      <div>
        <p className="eyebrow">Main copy moved</p>
        <h2 id="transfer-receipt-title">{receipt.collectionName} has a new main copy.</h2>
      </div>
      <button className="quiet-action" onClick={onDismiss}>Done</button>
    </div>
    <dl className="completion-receipt-facts">
      <div><dt>New main copy</dt><dd>{receipt.newMainCopy}</dd></div>
      <div><dt>Previous authority</dt><dd>{receipt.oldAuthority}</dd></div>
      <div><dt>Completed</dt><dd>{new Date(receipt.completedAt).toLocaleString()}</dd></div>
    </dl>
    <div className="transfer-impact-summary">
      <p><strong>{receipt.applications.length}</strong> {receipt.applications.length === 1 ? "application needs" : "applications need"} fresh access{receipt.applications.length ? `: ${receipt.applications.join(", ")}` : "."}</p>
      <p><strong>{receipt.replicas.length}</strong> {receipt.replicas.length === 1 ? "synced folder was" : "synced folders were"} retired{receipt.replicas.length ? `: ${receipt.replicas.join(", ")}` : "."}</p>
    </div>
    <div className="completion-receipt-actions" aria-label="Next actions">
      <button className="button primary" onClick={onOpen}>{local ? "Open folder" : "Open collection"}</button>
      {receipt.applications.length > 0 && <button className="button secondary" onClick={onReconnect}>Reconnect applications</button>}
      <button className="quiet-action" onClick={onViewDetails}>View history and recovery</button>
    </div>
  </section>;
}
