import React from "react";
import { capabilityLabel, type AccessGroups } from "./daemon-view.mjs";
import { Empty, SectionHeading } from "./ui-components";
import { plural, relativeTime } from "./view-model";

type Act = (action: () => Promise<unknown>) => Promise<void>;

function scope(entry: AccessEntry, names: Record<string, string>): string {
  const collection = names[entry.collection] ?? "a collection that is no longer on this computer";
  const folders = entry.folders?.length ? ` (${entry.folders.join(", ")})` : "";
  return `${collection}${folders}`;
}

function capabilities(entry: AccessEntry): string {
  return entry.capabilities.map(capabilityLabel).join(", ") || "No actions";
}

export function AccessView({ groups, names, busy, requireApproval, onAct, onNotice }: {
  groups: AccessGroups<AccessEntry>;
  names: Record<string, string>;
  busy: boolean;
  requireApproval: boolean | null;
  onAct: Act;
  onNotice(value: string): void;
}) {
  return (
    <div className="workspace-stack">
      {(requireApproval || groups.pending.length > 0) && <section>
        <SectionHeading title="Waiting for your approval" note="mdbase asks you to confirm on this computer's screen, with the app's key." count={groups.pending.length} />
        {groups.pending.length === 0
          ? <Empty title="Nothing is waiting" text="Apps you approve in mdbase appear here before they can connect." />
          : <div className="request-list">{groups.pending.map((entry) => (
            <article key={entry.grant} className="grant-review">
              <div className="grant-identity">
                <h3>{entry.app_name}</h3>
                <small>Wants {capabilities(entry)} on {scope(entry, names)}</small>
                <small>Asked {relativeTime(new Date(entry.first_seen_ms).toISOString())}</small>
              </div>
              <div className="decision-actions">
                <button className="button secondary" disabled={busy} onClick={() => void onAct(async () => {
                  await window.mdbaseConnect.denyAccess(entry.grant);
                  onNotice(`${entry.app_name} was declined.`);
                })}>Decline</button>
                <button className="button primary" disabled={busy} onClick={() => void onAct(async () => {
                  await window.mdbaseConnect.approveAccess(entry.grant);
                  onNotice(`${entry.app_name} can now use ${scope(entry, names)}.`);
                })}>Approve…</button>
              </div>
            </article>
          ))}</div>}
      </section>}

      <section>
        <SectionHeading title="Connected apps" note="Apps that can use your local collections through this computer." count={groups.apps.length} />
        {groups.apps.length === 0
          ? <Empty title="No apps connected" text="Open the app you want to use and connect it to mdbase. You approve it in your browser, and it appears here." />
          : <div className="application-access-list">{groups.apps.map((app) => (
            <details key={app.appId} className="application-grant-group" open={app.unacknowledged > 0}>
              <summary>
                <div><strong>{app.appName}</strong>{app.unacknowledged > 0 && <b className="new-access">New</b>}</div>
                <span>{app.grants.length} {plural(app.grants.length, "collection", "collections")}</span>
                <b>Review</b>
              </summary>
              <div className="application-grant-body">
                <div className="grant-list">{app.grants.map((entry) => (
                  <article key={entry.grant} className="grant-review">
                    <div className="grant-identity">
                      <h3>{scope(entry, names)}</h3>
                      <small>{capabilities(entry)}</small>
                      <small>Connected {relativeTime(new Date(entry.first_seen_ms).toISOString())}{entry.legacy_only ? " · older app version" : ""}</small>
                    </div>
                    <div className="decision-actions">
                      {!entry.acknowledged && <button className="button secondary" disabled={busy} onClick={() => void onAct(() => window.mdbaseConnect.acknowledgeAccess(entry.grant))}>Mark as seen</button>}
                      <button className="button secondary danger-text" disabled={busy} onClick={() => {
                        if (!window.confirm(`Stop ${entry.app_name} from using ${scope(entry, names)} through this computer?`)) return;
                        void onAct(async () => {
                          await window.mdbaseConnect.revokeAccess(entry.grant);
                          onNotice(`${entry.app_name} can no longer use ${scope(entry, names)} through this computer.`);
                        });
                      }}>Revoke</button>
                    </div>
                  </article>
                ))}</div>
              </div>
            </details>
          ))}</div>}
      </section>

      {groups.refused.length > 0 && <section>
        <SectionHeading title="Declined or revoked here" note="These stay refused on this computer, even if mdbase still lists them." count={groups.refused.length} />
        <div className="grant-list">{groups.refused.map((entry) => (
          <div key={entry.grant} className="setting-row"><span>{entry.app_name}</span><div><strong>{scope(entry, names)}</strong><small>{entry.state === "denied" ? "Declined" : "Revoked"} on this computer</small></div></div>
        ))}</div>
      </section>}
    </div>
  );
}
