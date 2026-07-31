import React from "react";
import { AccessControl, PairingPanel, StatusDot } from "./ui-components";
import { plural, type Route } from "./view-model";

export function ConnectionProgress() {
  return <div className="connection-progress" role="status" aria-live="polite">
    <StatusDot state="connecting" />
    <div><strong>Checking this computer</strong><small>Starting the local connector and checking its secure connection.</small></div>
  </div>;
}

export function Overview({ status, cloud, access, collectionCount, busy, onNavigate, onAdd, onCreate, onPause }: {
  status: AgentStatus | null;
  cloud: CloudSetting;
  access: AccessSnapshot;
  collectionCount: number;
  busy: boolean;
  onNavigate(route: Route): void;
  onAdd(): void;
  onCreate(): void;
  onPause(paused: boolean): void;
}) {
  if (!cloud.configured) return <PairingPanel />;
  return (
    <div className="workspace-stack">
      {access.pending_authorizations.length > 0 && (
        <button className="pending-banner" onClick={() => onNavigate("access")}>
          <span>{access.pending_authorizations.length}</span>
          <div><strong>{plural(access.pending_authorizations.length, "application is", "applications are")} waiting for a decision</strong><small>Review the requested collection and operations.</small></div>
          <b>Review requests</b>
        </button>
      )}
      {collectionCount === 0 && (
        <section className="first-collection">
          <div>
            <p className="eyebrow">First step</p>
            <h2>Add a collection for your apps.</h2>
            <p>Choose an existing mdbase folder or create a new collection. Adding a folder does not move or upload its files.</p>
          </div>
          <div>
            <button className="button primary" disabled={busy} onClick={onAdd}>Add existing folder</button>
            <button className="button secondary" disabled={busy} onClick={onCreate}>Create collection</button>
          </div>
        </section>
      )}
      <section className="readiness-panel">
        <div className="readiness-copy">
          <p className="eyebrow">Connection state</p>
          <h2>{status?.paused ? "Access is paused." : access.online ? "This computer is ready." : "Working from the local cache."}</h2>
          <p>{status?.paused ? "Connected apps remain listed, but this computer is denying their requests." : access.online ? "Approved apps can use the collections you made available while mdbase connect is running." : "Apps on this computer can keep using saved access. Access from elsewhere resumes when the connection returns."}</p>
        </div>
        <AccessControl
          paused={status?.paused ?? false}
          disabled={busy || status === null}
          onChange={onPause}
        />
      </section>
      <section className="overview-list" aria-label="Connector summary">
        <OverviewRow label="Collections" value={`${collectionCount} managed`} detail="Each collection shows where its main copy lives" action="Manage" onClick={() => onNavigate("collections")} />
        <OverviewRow label="App access" value={`${access.grants.length} active`} detail="Start in an mdbase-enabled app; its request will appear here" action="Review" onClick={() => onNavigate("access")} />
        <OverviewRow label="Account" value={access.account?.user_email ?? cloud.serverUrl ?? "Configured"} detail={access.account?.connector_name ?? "Account details unavailable while offline"} action="Settings" onClick={() => onNavigate("settings")} />
      </section>
    </div>
  );
}

function OverviewRow({ label, value, detail, action, onClick }: { label: string; value: string; detail: string; action: string; onClick(): void }) {
  return <div className="overview-row"><span>{label}</span><div><strong>{value}</strong><small>{detail}</small></div><button className="quiet-action" onClick={onClick}>{action}</button></div>;
}
