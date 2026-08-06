import "@fontsource/atkinson-hyperlegible/latin-400.css";
import "@fontsource/atkinson-hyperlegible/latin-700.css";
import "@fontsource/azeret-mono/latin-400.css";
import "@fontsource/azeret-mono/latin-500.css";
import "@fontsource/azeret-mono/latin-600.css";
import {
  groupApplicationAccess,
  groupAuthorizationOperations,
  type ApplicationAccessGroup
} from "@mdbase/connect-ui/access";
import "@mdbase/connect-ui/styles.css";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Collections } from "./collections-view";
import { presentConnection } from "./connection-state.mjs";
import { RequestPermissionChoices } from "./authorization-components";
import { ConnectionProgress, Overview } from "./overview-view";
import {
  AccessControl,
  Empty,
  MobileProductBar,
  PairingPanel,
  ProductSidebar,
  SectionHeading,
  SettingSwitch,
  StatusDot,
  ThemeMenu
} from "./ui-components";
import {
  allOperations,
  host,
  message,
  plural,
  relativeTime,
  scopeDescription,
  type Route
} from "./view-model";
import "./styles.css";

const routeCopy: Record<Route, { eyebrow: string; title: string; lede: string }> = {
  overview: {
    eyebrow: "This computer",
    title: "Your local connection.",
    lede: "Collections, application access, and connection status in one place."
  },
  collections: {
    eyebrow: "Collection storage",
    title: "Your collections.",
    lede: "See where each main copy lives and which folders stay in sync."
  },
  access: {
    eyebrow: "Application access",
    title: "Decide what apps can do.",
    lede: "Approve new requests and narrow or revoke existing connections."
  },
  activity: {
    eyebrow: "Local activity",
    title: "What reached this computer.",
    lede: "Successful, failed, and denied remote operations are recorded locally."
  },
  settings: {
    eyebrow: "Settings",
    title: "Connection and startup.",
    lede: "Manage this computer, its account connection, and background behavior."
  }
};

const RESUME_AUTHORIZATION_KEY = "mdbase:resume-authorization";

function storedAuthorizationTarget(): string | null {
  return localStorage.getItem(RESUME_AUTHORIZATION_KEY);
}

function App() {
  const [route, setRoute] = useState<Route>(() => storedAuthorizationTarget() ? "access" : "overview");
  const [authorizationTarget, setAuthorizationTarget] = useState<string | null>(storedAuthorizationTarget);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [updateStatus, setUpdateStatus] = useState<DesktopUpdateStatus | null>(null);
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [startup, setStartup] = useState<StartupSetting>({ enabled: false, available: false });
  const [cloud, setCloud] = useState<CloudSetting | null>(null);
  const [access, setAccess] = useState<AccessSnapshot>({ configured: false, online: false, grants: [], pending_authorizations: [], authority_conflicts: [] });
  const [hosted, setHosted] = useState<HostedControlSnapshot>({ online: false, hosted_collections_available: false, hosted_collections: [], grants: [], pending_authorizations: [] });
  const [mirrors, setMirrors] = useState<DesktopMirrorSummary[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [copiedCollectionPath, setCopiedCollectionPath] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newPath, setNewPath] = useState("");
  const [newAuthority, setNewAuthority] = useState<"local" | "hosted">("local");
  const [mirrorTarget, setMirrorTarget] = useState<string | null>(null);
  const [navigationOpen, setNavigationOpen] = useState(false);

  const refresh = useCallback(async (quiet = false) => {
    try {
      const results = await Promise.allSettled([
        window.mdbaseConnect.status().then(setStatus),
        window.mdbaseConnect.updateStatus().then(setUpdateStatus),
        window.mdbaseConnect.listCollections().then(setCollections),
        window.mdbaseConnect.getLaunchAtLogin().then(setStartup),
        window.mdbaseConnect.getCloudConfig().then(setCloud),
        window.mdbaseConnect.accessSnapshot().then(setAccess),
        window.mdbaseConnect.listActivity(100).then(setActivity),
        window.mdbaseConnect.hostedSnapshot().then(setHosted).catch(() => {
          setHosted((current) => ({ ...current, online: false }));
        }),
        window.mdbaseConnect.listMirrors().then(setMirrors)
      ]);
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) throw failed.reason;
      setError(null);
    } catch (refreshError) {
      if (!quiet) setError(message(refreshError));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 5_000);
    const removeNavigation = window.mdbaseConnect.onNavigate((next) => {
      if (next === "access" || next.startsWith("access:")) {
        const requestId = next.startsWith("access:") ? next.slice("access:".length) : "pending";
        localStorage.setItem(RESUME_AUTHORIZATION_KEY, requestId);
        setAuthorizationTarget(requestId);
        setRoute("access");
        return;
      }
      if (next.startsWith("collections:mirror:")) {
        setMirrorTarget(next.slice("collections:mirror:".length));
        setRoute("collections");
        return;
      }
      if (["overview", "collections", "access", "activity", "settings"].includes(next)) {
        setRoute(next as Route);
      }
    });
    const removeUpdateStatus = window.mdbaseConnect.onUpdateStatus(setUpdateStatus);
    return () => {
      window.clearInterval(timer);
      removeNavigation();
      removeUpdateStatus();
    };
  }, [refresh]);

  useEffect(() => {
    if (cloud?.configured && route === "access" && authorizationTarget) {
      localStorage.removeItem(RESUME_AUTHORIZATION_KEY);
    }
  }, [authorizationTarget, cloud?.configured, route]);

  useEffect(() => {
    if (!navigationOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNavigationOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [navigationOpen]);

  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      await refresh(true);
    } catch (actionError) {
      setError(message(actionError));
    } finally {
      setBusy(false);
    }
  }

  async function addExisting() {
    await act(async () => {
      const result = await window.mdbaseConnect.addCollection();
      if (result?.status === "added") {
        setNotice(`${result.collection.display_name} is now available to mdbase connect.`);
      } else if (result?.status === "copy_requires_new_identity") {
        setCopiedCollectionPath(result.path);
      }
    });
  }

  async function registerCopiedCollection() {
    if (!copiedCollectionPath) return;
    await act(async () => {
      const added = await window.mdbaseConnect.addCopiedCollection(copiedCollectionPath);
      setCopiedCollectionPath(null);
      setNotice(`${added.display_name} was registered as an independent collection.`);
    });
  }

  async function chooseCreateFolder() {
    const path = await window.mdbaseConnect.chooseCreateFolder();
    if (path) {
      setNewPath(path);
      if (!newName) setNewName(path.split(/[\\/]/).filter(Boolean).at(-1) ?? "");
    }
  }

  async function createCollection() {
    await act(async () => {
      if (newAuthority === "hosted") {
        const result = await window.mdbaseConnect.createHostedCollection({
          name: newName,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
        });
        setNotice(`${result.collection.display_name} is now hosted by mdbase.`);
      } else {
        const created = await window.mdbaseConnect.createCollection({
          path: newPath,
          name: newName,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
        });
        setNotice(`${created.display_name} was created on this computer.`);
      }
      setCreateOpen(false);
      setNewName("");
      setNewPath("");
      setNewAuthority("local");
    });
  }

  const copy = routeCopy[route];
  const connection = presentConnection(status, cloud);
  const combinedAccess = useMemo<AccessSnapshot>(() => {
    const grants = new Map<string, GrantSummary>();
    for (const grant of access.grants) grants.set(grant.id, {
      ...grant,
      collection_kind: grant.collection_kind ?? "local"
    });
    for (const grant of hosted.grants) grants.set(grant.id, grant);
    const pending = new Map<string, PendingAuthorization>();
    for (const request of hosted.pending_authorizations) pending.set(request.id, request);
    for (const request of access.pending_authorizations) pending.set(request.id, request);
    return {
      ...access,
      online: access.online || hosted.online,
      grants: [...grants.values()],
      pending_authorizations: [...pending.values()]
    };
  }, [access, hosted]);
  const collectionCount = collections.length + hosted.hosted_collections.length;
  const selectRoute = (next: Route) => {
    setRoute(next);
    setNavigationOpen(false);
  };

  return (
    <div className={`shell product-shell ${navigationOpen ? "navigation-open" : ""}`}>
      <ProductSidebar
        route={route}
        collectionCount={collectionCount}
        pendingCount={combinedAccess.pending_authorizations.length}
        connection={connection}
        computerName={`${access.account?.connector_name ?? "This computer"} · ${collectionCount} ${plural(collectionCount, "collection", "collections")}`}
        onSelect={selectRoute}
      />
      <button className="product-sidebar-backdrop" aria-label="Close navigation" onClick={() => setNavigationOpen(false)} />
      <div className="product-canvas desktop-canvas">
        <MobileProductBar open={navigationOpen} onOpen={() => setNavigationOpen(true)} />
        <main className="content">
        <header className="topbar">
          <div><p className="eyebrow">{copy.eyebrow}</p><h1>{copy.title}</h1><p className="lede">{copy.lede}</p></div>
        </header>

        <div aria-live="polite">
          {error && <div className="message error-message">{error}</div>}
          {notice && <div className="message notice-message">{notice}</div>}
        </div>

        {cloud === null ? <ConnectionProgress /> : route === "overview" ? (
          <Overview
            status={status}
            cloud={cloud}
            access={combinedAccess}
            collectionCount={collectionCount}
            busy={busy}
            onNavigate={setRoute}
            onAdd={() => void addExisting()}
            onCreate={() => setCreateOpen(true)}
            onPause={(paused) => void act(async () => {
              await window.mdbaseConnect.setAccessPaused(paused);
              setNotice(paused ? "Remote access is paused on this computer." : "Remote access is available again.");
            })}
          />
        ) : route === "collections" ? (
          <Collections
            collections={collections}
            hosted={hosted}
            cloudConfigured={cloud.configured}
            mirrors={mirrors}
            mirrorTarget={mirrorTarget}
            authorityConflicts={access.authority_conflicts}
            busy={busy}
            copiedCollectionPath={copiedCollectionPath}
            onAdd={() => void addExisting()}
            onCancelCopy={() => setCopiedCollectionPath(null)}
            onCreate={() => setCreateOpen(true)}
            onRegisterCopy={() => void registerCopiedCollection()}
            onMirrorTargetHandled={() => setMirrorTarget(null)}
            onAct={act}
            onNotice={setNotice}
          />
        ) : route === "access" ? (
          <Access
            cloud={cloud}
            access={combinedAccess}
            focusedRequestId={authorizationTarget === "pending" ? null : authorizationTarget}
            resumeAuthorization={authorizationTarget !== null}
            busy={busy}
            onAct={act}
            onNotice={setNotice}
          />
        ) : route === "activity" ? <Activity entries={activity} /> : (
          <Settings
            startup={startup}
            cloud={cloud}
            access={access}
            status={status}
            updateStatus={updateStatus}
            busy={busy}
            onAct={act}
            onNotice={setNotice}
          />
        )}
        </main>

        {createOpen && (
          <div className="modal-backdrop" role="presentation" onMouseDown={() => !busy && setCreateOpen(false)}>
            <section className="modal" role="dialog" aria-modal="true" aria-labelledby="create-title" onMouseDown={(event) => event.stopPropagation()}>
            <p className="eyebrow">New collection</p>
            <h2 id="create-title">Create an mdbase collection</h2>
            <p>Choose where the main copy should live. A collection hosted by mdbase can also keep a synced folder on this computer.</p>
            <fieldset className="authority-choice">
              <legend>Where should the main copy live?</legend>
              <label className={newAuthority === "local" ? "selected" : ""}>
                <input type="radio" name="authority" value="local" checked={newAuthority === "local"} onChange={() => setNewAuthority("local")} />
                <span><strong>On this computer</strong><small>The folder you choose is the main copy.</small></span>
              </label>
              <label className={`${newAuthority === "hosted" ? "selected" : ""} ${cloud?.configured && hosted.hosted_collections_available !== false ? "" : "disabled"}`}>
                <input type="radio" name="authority" value="hosted" checked={newAuthority === "hosted"} disabled={!cloud?.configured || hosted.hosted_collections_available === false} onChange={() => setNewAuthority("hosted")} />
                <span><strong>Hosted by mdbase</strong><small>{!cloud?.configured ? "Connect this computer to your account first." : hosted.hosted_collections_available !== false ? "Available while this computer is off; add a synced folder if you want one." : "Hosted collections are not enabled for this Connect service."}</small></span>
              </label>
            </fieldset>
            <label><span>Collection name</span><input autoFocus value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Workouts" /></label>
            {newAuthority === "local" && <label><span>Folder</span><button className="folder-picker" onClick={() => void chooseCreateFolder()}>{newPath || "Choose a folder…"}</button></label>}
            <div className="modal-actions">
              <button className="button secondary" disabled={busy} onClick={() => setCreateOpen(false)}>Cancel</button>
              <button className="button primary" disabled={busy || !newName.trim() || (newAuthority === "local" && !newPath)} onClick={() => void createCollection()}>Create collection</button>
            </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function Access({ cloud, access, focusedRequestId, resumeAuthorization, busy, onAct, onNotice }: {
  cloud: CloudSetting;
  access: AccessSnapshot;
  focusedRequestId: string | null;
  resumeAuthorization: boolean;
  busy: boolean;
  onAct(action: () => Promise<void>): Promise<void>;
  onNotice(value: string): void;
}) {
  const applicationAccess = useMemo(() => groupApplicationAccess(access.grants), [access.grants]);
  const pendingAuthorizations = useMemo(() => [...access.pending_authorizations].sort((left, right) =>
    left.id === focusedRequestId ? -1 : right.id === focusedRequestId ? 1 : 0
  ), [access.pending_authorizations, focusedRequestId]);
  if (!cloud.configured) return <PairingPanel resumeAuthorization={resumeAuthorization} />;
  return (
    <div className="workspace-stack">
      <section>
        <SectionHeading title="Portal approvals" note="Collection choice and permissions stay in the portal; this computer never substitutes a local approval." count={access.pending_authorizations.length} />
        {access.pending_authorizations.length === 0 ? (
          <Empty title="No portal approvals are waiting" text="New connection requests are reviewed in the portal." />
        ) : (
          <div className="request-list">
            {pendingAuthorizations.map((request) => <PortalApprovalRequest
              key={request.id}
              request={request}
              focused={request.id === focusedRequestId}
              busy={busy}
              onAct={onAct}
            />)}
          </div>
        )}
      </section>

      <section>
        <SectionHeading title="Connected applications" note="Applications are grouped here; expand one to review its collection access." count={applicationAccess.length} />
        {applicationAccess.length === 0 ? (
          <Empty title="No applications connected" text="Open the app you want to use and choose its mdbase connection action. The request will appear here for your decision." />
        ) : (
          <div className="application-access-list">{applicationAccess.map((group) => (
            <ApplicationGrantGroup key={group.applicationId} group={group} busy={busy} onAct={onAct} onNotice={onNotice} />
          ))}</div>
        )}
      </section>

    </div>
  );
}

function PortalApprovalRequest({ request, focused, busy, onAct }: {
  request: PendingAuthorization;
  focused: boolean;
  busy: boolean;
  onAct(action: () => Promise<void>): Promise<void>;
}) {
  const identity = request.application_distribution === "portable"
    ? request.application_project_url
      ? `Downloaded file · ${host(request.application_project_url)}`
      : "Downloaded file"
    : host(request.application_homepage);
  return <article className={`portal-approval-row ${focused ? "focused-request" : ""}`}>
    <div>
      <h3>{request.application_name}</h3>
      <code>{identity}</code>
      <small>Expires {relativeTime(request.expires_at)}</small>
    </div>
    <p>Choose the collection and review the exact permissions in the portal. If this is a new application installation, local code comparison follows separately.</p>
    <button className="button primary" disabled={busy} onClick={() => void onAct(async () => {
      await window.mdbaseConnect.openAuthorization(request.id);
    })}>Review in portal</button>
  </article>;
}

function ApplicationGrantGroup({ group, busy, onAct, onNotice }: {
  group: ApplicationAccessGroup<GrantSummary>;
  busy: boolean;
  onAct(action: () => Promise<void>): Promise<void>;
  onNotice(value: string): void;
}) {
  const identity = group.grants[0];
  return (
    <details className="application-grant-group">
      <summary>
        <div><strong>{group.applicationName}</strong><code>{identity.application_distribution === "portable" ? `Downloaded file${identity.application_project_url ? ` · ${host(identity.application_project_url)}` : ""}` : host(identity.application_homepage)}</code></div>
        <span>{group.collectionCount} {plural(group.collectionCount, "collection", "collections")}</span>
        <span>{group.grants.length} {plural(group.grants.length, "connection", "connections")}</span>
        <b>Review</b>
      </summary>
      <div className="application-grant-body">
        <div className="grant-list">{group.grants.map((grant) => (
          <GrantEditor key={grant.id} grant={grant} busy={busy} onAct={onAct} onNotice={onNotice} />
        ))}</div>
        <div className="application-grant-actions">
          <small>Revokes this application from every collection listed above.</small>
          <button className="quiet-action danger" disabled={busy} onClick={() => {
            if (!window.confirm(`Revoke all ${group.applicationName} collection access?`)) return;
            void onAct(async () => {
              let providerConfirmationPending = false;
              for (const grant of group.grants) {
                if (grant.collection_kind === "hosted") {
                  const result = await window.mdbaseConnect.revokeHostedGrant(grant.id);
                  providerConfirmationPending ||= result.revocation_status === "revoking";
                } else {
                  await window.mdbaseConnect.revokeGrant(grant.id);
                }
              }
              onNotice(providerConfirmationPending
                ? `${group.applicationName} access is disabled here; hosted revocation confirmation is pending.`
                : `${group.applicationName} collection access was revoked.`);
            });
          }}>Revoke all access</button>
        </div>
      </div>
    </details>
  );
}

function GrantEditor({ grant, busy, onAct, onNotice }: { grant: GrantSummary; busy: boolean; onAct(action: () => Promise<void>): Promise<void>; onNotice(value: string): void }) {
  const [operations, setOperations] = useState(grant.operations);
  const contractScoped = grant.scope.contracts.length > 0;
  const allowedOperations = useMemo(
    () => contractScoped ? allOperations.filter((operation) => operation !== "validate") : allOperations,
    [contractScoped]
  );
  const permissionGroups = useMemo(
    () => groupAuthorizationOperations(allowedOperations),
    [allowedOperations]
  );
  const selectedPermissionCount = permissionGroups.reduce(
    (count, group) =>
      count + group.operations.filter((operation) => operations.includes(operation.id)).length,
    0
  );
  const changed = useMemo(() => [...operations].sort().join(",") !== [...grant.operations].sort().join(","), [operations, grant.operations]);
  useEffect(() => setOperations(grant.operations), [grant.operations]);
  const authority = grant.collection_kind === "hosted" ? "Hosted by mdbase" : "On this computer";
  if (grant.revocation_status === "revoking") {
    return <article className="grant-review"><div className="grant-identity"><p className="eyebrow">Hosted by mdbase</p><h3>{grant.collection_name}</h3><small>Access is disabled here. Waiting for the hosted authority to confirm revocation.</small></div><strong>Revoking…</strong></article>;
  }
  return (
    <article className="grant-review">
      <div className="grant-identity"><p className="eyebrow">{authority}</p><h3>{grant.collection_name}</h3><code>{grant.application_distribution === "portable" ? "Downloaded file · encrypted access" : host(grant.application_origin || grant.application_homepage)}</code><small>Connected {relativeTime(grant.created_at)}</small>{grant.scope.contracts.length > 0 && <small>{scopeDescription(grant.scope.contracts)}</small>}</div>
      <div className="request-decision">
        <section className="request-section">
          <div><strong>Permissions</strong><small>{allowedOperations.length} available actions across {permissionGroups.length} {plural(permissionGroups.length, "category", "categories")}.</small></div>
          <RequestPermissionChoices groups={permissionGroups} selected={operations} onChange={setOperations} />
        </section>
        <footer className="request-footer">
          <p>{grant.application_name} can use the selected actions on {grant.collection_name} until you revoke access.</p>
          <div className="decision-actions">
            <button className="button secondary danger-text" disabled={busy} onClick={() => { if (window.confirm(`Revoke ${grant.application_name} access to ${grant.collection_name}?`)) void onAct(async () => {
              if (grant.collection_kind === "hosted") {
                const result = await window.mdbaseConnect.revokeHostedGrant(grant.id);
                onNotice(result.revocation_status === "revoking"
                  ? `${grant.application_name} access is disabled here; hosted revocation confirmation is pending.`
                  : `${grant.application_name} access was revoked.`);
              } else {
                await window.mdbaseConnect.revokeGrant(grant.id);
                onNotice(`${grant.application_name} access was revoked.`);
              }
            }); }}>Revoke</button>
            <button className="button primary" disabled={busy || !changed || selectedPermissionCount === 0} onClick={() => void onAct(async () => {
              if (grant.collection_kind === "hosted") await window.mdbaseConnect.updateHostedGrant({ grantId: grant.id, operations });
              else await window.mdbaseConnect.updateGrant({ grantId: grant.id, operations });
              onNotice(`${grant.application_name} permissions were updated.`);
            })}>Save changes</button>
          </div>
        </footer>
      </div>
    </article>
  );
}

function Activity({ entries }: { entries: ActivityEntry[] }) {
  return (
    <section className="activity-section">
      <SectionHeading title="Recent operations" note="Stored in the connector registry on this computer." count={entries.length} />
      {entries.length === 0 ? <Empty title="No remote activity yet" text="Operations from approved applications will be recorded here, including requests denied by the local policy." /> : (
        <div className="activity-list">{entries.map((entry) => <div className="activity-row" key={entry.id}><StatusDot state={entry.outcome === "succeeded" ? "connected" : entry.outcome === "denied" ? "paused" : "danger"} /><div><strong>{entry.application_name}</strong><small>{entry.operation} on {entry.collection_name}{entry.detail ? `: ${entry.detail}` : ""}</small></div><code>{entry.outcome}</code><time>{relativeTime(entry.created_at)}</time></div>)}</div>
      )}
    </section>
  );
}

function Settings({ startup, cloud, access, status, updateStatus, busy, onAct, onNotice }: {
  startup: StartupSetting;
  cloud: CloudSetting;
  access: AccessSnapshot;
  status: AgentStatus | null;
  updateStatus: DesktopUpdateStatus | null;
  busy: boolean;
  onAct(action: () => Promise<void>): Promise<void>;
  onNotice(value: string): void;
}) {
  const connection = presentConnection(status, cloud);
  return (
    <div className="workspace-stack settings-stack">
      {!cloud.configured ? <PairingPanel /> : (
        <section>
          <SectionHeading title="Account connection" note="The account this computer uses for application requests." />
          <div className="settings-rows">
            <ComputerNameSetting account={access.account} online={access.online} busy={busy} onAct={onAct} onNotice={onNotice} />
            <SettingRow label="Connect service" value={cloud.serverUrl ?? "Configured"} detail={access.online ? "Account changes are up to date" : "Saved app access still works on this computer"} mono />
            <SettingRow label="Connection" value={connection.settingsLabel} detail="Keeps approved apps on other devices connected to this computer" />
            <SettingRow label="Apps on this computer" value={status?.direct_access_available ? "Available" : "Unavailable"} detail="Approved apps here can connect without sending records over the internet" />
          </div>
          <div className="portal-connection-actions">
            <button className="button secondary" disabled={busy} onClick={() => void onAct(() => window.mdbaseConnect.openAccount())}>Manage account in portal</button>
            <button className="button secondary danger-text disconnect-button" disabled={busy} onClick={() => { if (window.confirm("Forget this account on this computer? This removes the saved account credential from this computer. Connecting again will create a new computer entry. Existing local collection files are unaffected.")) void onAct(async () => { await window.mdbaseConnect.clearCloudConfig(); }); }}>Forget account on this computer…</button>
          </div>
        </section>
      )}
      <section>
        <SectionHeading title="Background behavior" note="Keep the local connector ready without opening a window." />
        <div className="settings-rows">
          <SettingSwitch
            className="setting-toggle"
            label="Start at login"
            description={startup.available ? "Launch in the tray when you sign in" : "Available in installed builds"}
            checked={startup.enabled}
            disabled={!startup.available || busy}
            stateLabel={startup.available ? startup.enabled ? "On" : "Off" : "Unavailable"}
            onChange={(checked) => void onAct(async () => {
              await window.mdbaseConnect.setLaunchAtLogin(checked);
              onNotice(checked ? "mdbase connect will start at login." : "Launch at login is off.");
            })}
          />
          <AccessControl
            paused={status?.paused ?? false}
            disabled={busy || status === null}
            onChange={(paused) => void onAct(async () => {
              await window.mdbaseConnect.setAccessPaused(paused);
              onNotice(paused ? "App access is paused." : "App access is available again.");
            })}
          />
        </div>
      </section>
      <section>
        <SectionHeading title="Updates" note="Releases are checked against signed provenance before installation." />
        <div className="settings-rows">
          <div className="setting-row">
            <span>Application</span>
            <div>
              <strong>Version {updateStatus?.current_version ?? "checking"}</strong>
              <small>
                {updateStatus
                  ? `${updateStatus.message}${updateStatus.progress !== undefined && updateStatus.phase === "downloading" ? ` ${Math.round(updateStatus.progress)}%` : ""}`
                  : "Reading update status…"}
              </small>
            </div>
            <button
              className="quiet-action"
              disabled={
                busy ||
                !updateStatus ||
                (!updateStatus.can_check && !updateStatus.can_install)
              }
              onClick={() =>
                void onAct(async () => {
                  if (updateStatus?.can_install) {
                    await window.mdbaseConnect.installUpdate();
                  } else {
                    const next = await window.mdbaseConnect.checkForUpdates();
                    onNotice(next.message);
                  }
                })
              }
            >
              {updateStatus?.can_install
                ? updateStatus.phase === "ready"
                  ? "Restart and update"
                  : "Open update"
                : updateStatus?.phase === "checking"
                  ? "Checking…"
                  : "Check now"}
            </button>
          </div>
        </div>
      </section>
      <section>
        <SectionHeading title="Appearance" note="Use the system setting or keep a theme on this computer." />
        <div className="settings-rows">
          <div className="setting-row">
            <span>Theme</span>
            <div><strong>Color theme</strong><small>System follows your operating system appearance</small></div>
            <ThemeMenu placement="up" />
          </div>
        </div>
      </section>
      <section className="privacy-block"><span className="privacy-lock">⌁</span><div><strong>Folder locations are never uploaded.</strong><p>Collections kept on this computer stay here. Hosted Markdown is stored by mdbase, and synced folders exchange changes directly with it. Your account only receives collection and app-access details.</p></div></section>
    </div>
  );
}

function ComputerNameSetting({ account, online, busy, onAct, onNotice }: {
  account?: ConnectorAccount;
  online: boolean;
  busy: boolean;
  onAct(action: () => Promise<void>): Promise<void>;
  onNotice(value: string): void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(account?.connector_name ?? "This computer");
  useEffect(() => {
    if (!editing) setName(account?.connector_name ?? "This computer");
  }, [account?.connector_name, editing]);
  if (!editing) return <div className="setting-row"><span>Computer</span><div><strong>{account?.connector_name ?? "This computer"}</strong><small>{account?.user_email ?? "Account details unavailable while offline"}</small></div><button className="quiet-action" disabled={busy || !online} onClick={() => setEditing(true)}>Rename</button></div>;
  return <form className="setting-row setting-editor" onSubmit={(event) => { event.preventDefault(); void onAct(async () => { const result = await window.mdbaseConnect.renameComputer(name); setEditing(false); onNotice(`This computer is now named ${result.connector.name}.`); }); }}>
    <span>Computer</span>
    <label><span>Computer name</span><input autoFocus value={name} maxLength={100} required onChange={(event) => setName(event.target.value)} /></label>
    <div className="row-actions"><button type="button" className="quiet-action" disabled={busy} onClick={() => setEditing(false)}>Cancel</button><button className="button primary" disabled={busy || !name.trim() || name.trim() === account?.connector_name}>Save</button></div>
  </form>;
}

function SettingRow({ label, value, detail, mono = false }: { label: string; value: string; detail: string; mono?: boolean }) {
  return <div className="setting-row"><span>{label}</span><div><strong className={mono ? "mono" : ""}>{value}</strong><small>{detail}</small></div></div>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
