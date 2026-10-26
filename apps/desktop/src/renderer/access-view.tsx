import { t, plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useLocaleRevision, i18n } from "@mdbase-dev/ui/i18n";
import React from "react";
import { ApprovalPrompt } from "./approval-prompt";
import { capabilityLabel, capabilityPhrase, groupedFingerprint, type AccessGroups } from "./daemon-view.mjs";
import { Empty, SectionHeading } from "./ui-components";
import { relativeTime } from "./view-model";

type Act = (action: () => Promise<unknown>) => Promise<void>;

function scope(entry: AccessEntry, names: Record<string, string>): string {
  const collection = names[entry.collection] ?? t(i18n)({ message: "a collection that is no longer on this computer" });
  const folders = entry.folders?.length ? ` (${entry.folders.join(", ")})` : "";
  return `${collection}${folders}`;
}

function capabilities(entry: AccessEntry): string {
  return entry.capabilities.map(capabilityLabel).join(", ") || t(i18n)({ message: "No actions", context: "Connect interface" });
}

function AppRequest({ entry, names, busy, onAct, onNotice }: {
  entry: AccessEntry;
  names: Record<string, string>;
  busy: boolean;
  onAct: Act;
  onNotice(value: string): void;
}) {
  useLocaleRevision();
  const where = scope(entry, names);
  const unknown = entry.terms_unavailable === true;
  return <ApprovalPrompt
    title={t(i18n)`${entry.app_name} wants to use ${where}`}
    can={unknown
      ? t(i18n)({ message: "mdbase could not fetch what this app is asking for, or which folders. Approval is possible once it can." })
      : t(i18n)`If you approve, ${entry.app_name} will be able to ${capabilityPhrase(entry.capabilities)} in ${where}, through this computer. You can revoke this at any time.`}
    check={unknown ? null : entry.fingerprint
      ? <><span><Trans>App key</Trans></span> <code>{groupedFingerprint(entry.fingerprint)}</code> <span>{t(i18n)`Check that ${entry.app_name} shows the same key.`}</span></>
      : <span>{t(i18n)`mdbase shows the app's key when you approve. Check that ${entry.app_name} shows the same key.`}</span>}
    note={t(i18n)`Asked ${relativeTime(new Date(entry.first_seen_ms).toISOString())}`}
    approveLabel={t(i18n)({ message: "Approve…", context: "Connect interface" })}
    approveDisabled={unknown}
    busy={busy}
    onDecline={() => void onAct(async () => {
      await window.mdbaseConnect.denyAccess(entry.grant);
      onNotice(t(i18n)`${entry.app_name} was declined.`);
    })}
    onApprove={() => void onAct(async () => {
      await window.mdbaseConnect.approveAccess(entry.grant);
      onNotice(t(i18n)`${entry.app_name} can now use ${where}.`);
    })}
  />;
}

export function AccessView({ groups, names, busy, requireApproval, movedWaiting = 0, onAct, onNotice }: {
  groups: AccessGroups<AccessEntry>;
  names: Record<string, string>;
  busy: boolean;
  /** Collections moved here from mdbase Connect whose Private sync is not on yet. */
  movedWaiting?: number;
  requireApproval: boolean | null;
  onAct: Act;
  onNotice(value: string): void;
}) {
  useLocaleRevision();
  return (
    <div className="workspace-stack">
      {(requireApproval || groups.pending.length > 0) && <section>
        <SectionHeading title={t(i18n)({ message: "Waiting for your approval" })} note={t(i18n)({ message: "mdbase asks you to confirm on this computer's screen, with the app's key." })} count={groups.pending.length} />
        {groups.pending.length === 0
          ? <Empty title={t(i18n)({ message: "Nothing is waiting", context: "Connect interface" })} text={t(i18n)({ message: "Apps you approve in mdbase appear here before they can connect." })} />
          : <div className="request-list">{groups.pending.map((entry) => (
            <AppRequest key={entry.grant} entry={entry} names={names} busy={busy} onAct={onAct} onNotice={onNotice} />
          ))}</div>}
      </section>}

      <section>
        <SectionHeading title={t(i18n)({ message: "Connected apps", context: "Connect interface" })} note={t(i18n)({ message: "Apps that can use your collections through this computer." })} count={groups.apps.length} />
        {groups.apps.length === 0
          ? movedWaiting > 0
            ? <Empty title={t(i18n)({ message: "Your apps reconnect soon", context: "Connect interface" })} text={t(i18n)`Apps you used with mdbase Connect appear here once Private sync is on for the ${plural(movedWaiting, { one: "collection", other: "collections" })} that moved to this computer. mdbase turns it on by itself; you don't need to approve those apps again.`} />
            : <Empty title={t(i18n)({ message: "No apps connected", context: "Connect interface" })} text={t(i18n)({ message: "Open the app you want to use and connect it to mdbase. You approve it in your browser, and it appears here." })} />
          : <div className="application-access-list">{groups.apps.map((app) => (
            <details key={app.appId} className="application-grant-group" open={app.unacknowledged > 0}>
              <summary>
                <div><strong>{app.appName}</strong>{app.unacknowledged > 0 && <b className="new-access">{t(i18n)({ message: "New", context: "Connect interface" })}</b>}</div>
                <span>{t(i18n)`${plural(app.grants.length, { one: "# collection", other: "# collections" })}`}</span>
                <b>{t(i18n)({ message: "Review", context: "Connect interface" })}</b>
              </summary>
              <div className="application-grant-body">
                <div className="grant-list">{app.grants.map((entry) => (
                  <article key={entry.grant} className="grant-review">
                    <div className="grant-identity">
                      <h3>{scope(entry, names)}</h3>
                      <small>{capabilities(entry)}</small>
                      <small><Trans>Connected {relativeTime(new Date(entry.first_seen_ms).toISOString())}{entry.legacy_only ? t(i18n)({ message: " · older app version", context: "Connect interface" }) : ""}</Trans></small>
                    </div>
                    <div className="decision-actions">
                      {!entry.acknowledged && <button className="button secondary" disabled={busy} onClick={() => void onAct(() => window.mdbaseConnect.acknowledgeAccess(entry.grant))}><Trans>Mark as seen</Trans></button>}
                      <button className="button secondary danger-text" disabled={busy} onClick={() => {
                        if (!window.confirm(t(i18n)`Stop ${entry.app_name} from using ${scope(entry, names)} through this computer?`)) return;
                        void onAct(async () => {
                          await window.mdbaseConnect.revokeAccess(entry.grant);
                          onNotice(t(i18n)`${entry.app_name} can no longer use ${scope(entry, names)} through this computer.`);
                        });
                      }}><Trans>Revoke</Trans></button>
                    </div>
                  </article>
                ))}</div>
              </div>
            </details>
          ))}</div>}
      </section>

      {groups.refused.length > 0 && <section>
        <SectionHeading title={t(i18n)({ message: "Declined or revoked here", context: "Connect interface" })} note={t(i18n)({ message: "These stay refused on this computer, even if mdbase still lists them." })} count={groups.refused.length} />
        <div className="grant-list">{groups.refused.map((entry) => (
          <div key={entry.grant} className="setting-row"><span>{entry.app_name}</span><div><strong>{scope(entry, names)}</strong><small><Trans>{entry.state === "denied" ? t(i18n)({ message: "Declined", context: "Connect interface" }) : t(i18n)({ message: "Revoked", context: "Connect interface" })} on this computer</Trans></small></div></div>
        ))}</div>
      </section>}
    </div>
  );
}
