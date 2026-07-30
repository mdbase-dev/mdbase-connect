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
import { applyThemePreference, loadThemePreference, saveThemePreference, type ThemePreference } from "@mdbase/connect-ui/theme";
import "@mdbase/connect-ui/styles.css";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Collections } from "./collections-view";
import { presentConnection } from "./connection-state.mjs";
import {
  Brand,
  Empty,
  NavButton,
  PairingPanel,
  SectionHeading,
  SettingSwitch,
  StatusDot
} from "./ui-components";
import {
  allOperations,
  hasContract,
  host,
  hostedCollectionCompatible,
  message,
  neededProvisions,
  plural,
  provisionNames,
  relativeTime,
  scopeDescription,
  type AuthorizationCollection,
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
    eyebrow: "Collection authority",
    title: "Your collections, in one place.",
    lede: "Manage folders owned by this computer and collections hosted by mdbase."
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
    eyebrow: "Connector settings",
    title: "Connection and startup.",
    lede: "Manage this computer, its portal, and background behavior."
  }
};

function App() {
  const [route, setRoute] = useState<Route>("overview");
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
        const result = await window.mdbaseConnect.createHostedCollection(newName);
        setNotice(`${result.collection.display_name} is now hosted by mdbase.`);
      } else {
        const created = await window.mdbaseConnect.createCollection({ path: newPath, name: newName });
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

  return (
    <div className="shell">
      <header className="product-header desktop-header">
        <div className="product-header-inner">
          <Brand />
          <div className="product-header-meta" role="status" aria-live="polite">
            <StatusDot state={connection.dot} />
            <div className="product-header-meta-copy"><strong>{connection.label}</strong><small>{access.account?.connector_name ?? "This computer"} · {collectionCount} {plural(collectionCount, "collection", "collections")}</small></div>
          </div>
        </div>
      </header>

      <nav className="view-tabs" aria-label="mdbase connect views">
        <div className="view-tabs-inner">
          <NavButton route="overview" current={route} label="Overview" onSelect={setRoute} />
          <NavButton route="collections" current={route} label="Collections" count={collectionCount} onSelect={setRoute} />
          <NavButton route="access" current={route} label="App access" attention={combinedAccess.pending_authorizations.length} onSelect={setRoute} />
          <NavButton route="activity" current={route} label="Activity" onSelect={setRoute} />
          <NavButton route="settings" current={route} label="Settings" onSelect={setRoute} />
        </div>
      </nav>

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
            collections={collections}
            hostedCollections={hosted.hosted_collections}
            canCreateHosted={hosted.hosted_collections_available !== false}
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
            <p>Choose the authority deliberately. You can mirror a hosted collection onto this computer after creating it.</p>
            <fieldset className="authority-choice">
              <legend>Collection authority</legend>
              <label className={newAuthority === "local" ? "selected" : ""}>
                <input type="radio" name="authority" value="local" checked={newAuthority === "local"} onChange={() => setNewAuthority("local")} />
                <span><strong>On this computer</strong><small>A folder here is the final authority.</small></span>
              </label>
              <label className={`${newAuthority === "hosted" ? "selected" : ""} ${cloud?.configured && hosted.hosted_collections_available !== false ? "" : "disabled"}`}>
                <input type="radio" name="authority" value="hosted" checked={newAuthority === "hosted"} disabled={!cloud?.configured || hosted.hosted_collections_available === false} onChange={() => setNewAuthority("hosted")} />
                <span><strong>Hosted by mdbase</strong><small>{!cloud?.configured ? "Connect this computer to your account first." : hosted.hosted_collections_available !== false ? "Available while this computer is offline; optional local mirror." : "Hosted collections are not enabled for this Connect service."}</small></span>
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
  );
}

function ConnectionProgress() {
  return <div className="connection-progress" role="status" aria-live="polite">
    <StatusDot state="connecting" />
    <div><strong>Checking this computer</strong><small>Starting the local connector and checking its secure connection.</small></div>
  </div>;
}

function Overview({ status, cloud, access, collectionCount, busy, onNavigate, onPause }: {
  status: AgentStatus | null;
  cloud: CloudSetting;
  access: AccessSnapshot;
  collectionCount: number;
  busy: boolean;
  onNavigate(route: Route): void;
  onPause(paused: boolean): void;
}) {
  if (!cloud.configured) {
    return <PairingPanel />;
  }
  return (
    <div className="workspace-stack">
      {access.pending_authorizations.length > 0 && (
        <button className="pending-banner" onClick={() => onNavigate("access")}>
          <span>{access.pending_authorizations.length}</span>
          <div><strong>{plural(access.pending_authorizations.length, "application is", "applications are")} waiting for a decision</strong><small>Review the requested collection and operations.</small></div>
          <b>Review requests</b>
        </button>
      )}
      <section className="readiness-panel">
        <div className="readiness-copy">
          <p className="eyebrow">Connection state</p>
          <h2>{status?.paused ? "Access is paused." : access.online ? "This computer is ready." : "Working from the local cache."}</h2>
          <p>{status?.paused ? "Apps remain connected, but every collection operation is being denied locally." : access.online ? "Approved applications can reach available collections directly or through mdbase while this connector is running." : "Direct access keeps working from cached local policy. Cloud changes resume when the portal reconnects."}</p>
        </div>
        <SettingSwitch
          className="pause-control"
          label="Application access"
          description="Pause direct and relayed operations without disconnecting apps"
          checked={status ? !status.paused : false}
          disabled={busy || status === null}
          stateLabel={status ? status.paused ? "Paused" : "Available" : "Checking"}
          onChange={(checked) => onPause(!checked)}
        />
      </section>
      <section className="overview-list" aria-label="Connector summary">
        <OverviewRow label="Collections" value={`${collectionCount} managed`} detail="Computer-owned and hosted authorities stay explicit" action="Manage" onClick={() => onNavigate("collections")} />
        <OverviewRow label="Application access" value={`${access.grants.length} active`} detail="Each grant is limited to one collection" action="Manage" onClick={() => onNavigate("access")} />
        <OverviewRow label="Portal" value={access.account?.user_email ?? cloud.serverUrl ?? "Configured"} detail={access.account?.connector_name ?? "Cloud identity unavailable while offline"} action="Settings" onClick={() => onNavigate("settings")} />
      </section>
    </div>
  );
}

function OverviewRow({ label, value, detail, action, onClick }: { label: string; value: string; detail: string; action: string; onClick(): void }) {
  return <div className="overview-row"><span>{label}</span><div><strong>{value}</strong><small>{detail}</small></div><button className="quiet-action" onClick={onClick}>{action}</button></div>;
}

function Access({ cloud, access, collections, hostedCollections, canCreateHosted, busy, onAct, onNotice }: {
  cloud: CloudSetting;
  access: AccessSnapshot;
  collections: CollectionSummary[];
  hostedCollections: HostedCollectionSummary[];
  canCreateHosted: boolean;
  busy: boolean;
  onAct(action: () => Promise<void>): Promise<void>;
  onNotice(value: string): void;
}) {
  const applicationAccess = useMemo(() => groupApplicationAccess(access.grants), [access.grants]);
  if (!cloud.configured) return <PairingPanel />;
  return (
    <div className="workspace-stack">
      <section>
        <SectionHeading title="Pending requests" note="An application cannot continue until you decide here." count={access.pending_authorizations.length} />
        {access.pending_authorizations.length === 0 ? (
          <Empty title="No applications are waiting" text="New connection requests from websites and downloaded files will appear here." />
        ) : (
          <div className="request-list">
            {access.pending_authorizations.map((request) => <AuthorizationRequest key={request.id} request={request} collections={collections} hostedCollections={hostedCollections} canCreateHosted={canCreateHosted} busy={busy} onAct={onAct} onNotice={onNotice} />)}
          </div>
        )}
      </section>

      <section>
        <SectionHeading title="Connected applications" note="Applications are grouped here; expand one to review its collection access." count={applicationAccess.length} />
        {applicationAccess.length === 0 ? (
          <Empty title="No applications connected" text="Connect from an mdbase-enabled application to manage its access here." />
        ) : (
          <div className="application-access-list">{applicationAccess.map((group) => (
            <ApplicationGrantGroup key={group.applicationId} group={group} busy={busy} onAct={onAct} onNotice={onNotice} />
          ))}</div>
        )}
      </section>

    </div>
  );
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
              for (const grant of group.grants) {
                if (grant.collection_kind === "hosted") {
                  await window.mdbaseConnect.revokeHostedGrant(grant.id);
                } else {
                  await window.mdbaseConnect.revokeGrant(grant.id);
                }
              }
              onNotice(`${group.applicationName} collection access was revoked.`);
            });
          }}>Revoke all access</button>
        </div>
      </div>
    </details>
  );
}

function AuthorizationRequest({ request, collections, hostedCollections, canCreateHosted, busy, onAct, onNotice }: {
  request: PendingAuthorization;
  collections: CollectionSummary[];
  hostedCollections: HostedCollectionSummary[];
  canCreateHosted: boolean;
  busy: boolean;
  onAct(action: () => Promise<void>): Promise<void>;
  onNotice(value: string): void;
}) {
  const [creatingHosted, setCreatingHosted] = useState(false);
  const [hostedName, setHostedName] = useState("");
  const [createdHostedCollection, setCreatedHostedCollection] = useState<HostedCollectionSummary | null>(null);
  const authorizationHostedCollections = useMemo(() => {
    const combined = new Map(hostedCollections.map((collection) => [collection.id, collection]));
    if (createdHostedCollection && !combined.has(createdHostedCollection.id)) {
      combined.set(createdHostedCollection.id, createdHostedCollection);
    }
    return [...combined.values()];
  }, [createdHostedCollection, hostedCollections]);
  const available = useMemo<AuthorizationCollection[]>(() => [
    ...collections
      .filter((collection) =>
        request.requirements.collection_kind !== "hosted"
        && (
          request.compatible_collection_ids.includes(collection.id)
          || request.provisionable_collection_ids.includes(collection.id)
        )
      )
      .map((collection) => ({
        ...collection,
        kind: "local" as const,
        provisionable: request.provisionable_collection_ids.includes(collection.id)
      })),
    ...authorizationHostedCollections
      .filter((collection) =>
        collection.authority_state === "active"
        && hostedCollectionCompatible(request, collection)
      )
      .map((collection) => ({
        id: collection.id,
        display_name: collection.display_name,
        spec_version: collection.spec_version,
        contracts: collection.contracts,
        kind: "hosted" as const,
        provisionable: request.requirements.contracts.some(
          (requirement) => !hasContract(collection.contracts, requirement)
        )
      }))
  ], [
    collections,
    authorizationHostedCollections,
    request.compatible_collection_ids,
    request.provisionable_collection_ids,
    request.requirements,
    request.provisions,
    request.requested_operations
  ]);
  const selectable = useMemo(
    () => request.collection_id
      ? available.filter((collection) => collection.id === request.collection_id)
      : available,
    [available, request.collection_id]
  );
  const [collectionId, setCollectionId] = useState(selectable[0]?.id ?? "");
  const [operations, setOperations] = useState(request.requested_operations);
  const selected = selectable.find((collection) => collection.id === collectionId);
  const setup = selected?.provisionable
    ? neededProvisions(request.requirements, request.provisions, selected)
    : [];
  const permissionGroups = useMemo(
    () => groupAuthorizationOperations(request.requested_operations),
    [request.requested_operations]
  );
  const permissionCount = permissionGroups.reduce(
    (count, group) => count + group.operations.length,
    0
  );
  const selectedPermissionCount = permissionGroups.reduce(
    (count, group) =>
      count + group.operations.filter((operation) => operations.includes(operation.id)).length,
    0
  );
  useEffect(() => {
    if (!selectable.some((collection) => collection.id === collectionId)) {
      setCollectionId(selectable[0]?.id ?? "");
    }
  }, [collectionId, selectable]);
  async function createHostedCollection(event: React.FormEvent) {
    event.preventDefault();
    const displayName = hostedName.trim();
    if (!displayName) return;
    let created: HostedCollectionSummary | undefined;
    await onAct(async () => {
      const result = await window.mdbaseConnect.createHostedCollection(displayName);
      created = result.collection;
    });
    if (!created) return;
    setCreatedHostedCollection(created);
    setCollectionId(created.id);
    setCreatingHosted(false);
    setHostedName("");
    onNotice(`${created.display_name} was created and selected. Application access is not allowed yet.`);
  }
  return (
    <article className="request-panel">
      <div className="request-identity"><p className="eyebrow">Access request</p><h3>{request.application_name}</h3><code>{request.application_distribution === "portable" ? `Downloaded HTML file${request.application_project_url ? ` · ${host(request.application_project_url)}` : ""}` : host(request.application_homepage)}</code>{request.application_distribution === "portable" ? <small className="portable-request-warning">Unverified file origin. Only allow it if you intentionally opened the file{request.user_code ? ` and it shows ${request.user_code}` : ""}.</small> : <small>Only continue if you recognize this exact site. An approved application can use the selected data until you revoke it.</small>}<small>Expires {relativeTime(request.expires_at)}</small>{request.requirements.contracts.length > 0 && <small>{scopeDescription(request.requirements.contracts)}</small>}</div>
      <div className="request-decision">
        <section className="request-section">
          <div><strong>Collection</strong><small>{request.collection_id ? `${request.application_name} requested this specific collection.` : `Choose where ${request.application_name} can work.`}</small></div>
          <div className="request-section-content">
            <label><span>Collection</span><select value={collectionId} disabled={selectable.length === 0 || busy} onChange={(event) => setCollectionId(event.target.value)}>{selectable.length === 0 && <option value="">No compatible collection</option>}{selectable.map((collection) => <option key={collection.id} value={collection.id}>{collection.display_name} · {collection.kind === "hosted" ? "Hosted by mdbase" : "on this computer"}{collection.provisionable ? " · setup required" : ""}</option>)}</select></label>
            {selectable.length === 0 && <small>{request.collection_id ? "The collection requested by this application is not available." : "No available local or hosted collection supports all requested operations and contracts."}</small>}
            {canCreateHosted && !request.collection_id && (creatingHosted ? (
              <form
                className="request-collection-create"
                id={`create-hosted-${request.id}`}
                onSubmit={(event) => void createHostedCollection(event)}
              >
                <label>
                  <span>New collection name</span>
                  <input
                    autoFocus
                    maxLength={200}
                    value={hostedName}
                    disabled={busy}
                    placeholder="Workouts"
                    onChange={(event) => setHostedName(event.target.value)}
                  />
                </label>
                <p>Creates a plain mdbase collection hosted by mdbase. Application access is still approved separately below.</p>
                <div>
                  <button className="quiet-action" type="button" disabled={busy} onClick={() => {
                    setCreatingHosted(false);
                    setHostedName("");
                  }}>Cancel</button>
                  <button className="button secondary" disabled={busy || !hostedName.trim()}>{busy ? "Creating…" : "Create collection"}</button>
                </div>
              </form>
            ) : (
              <div className="request-collection-action">
                <button
                  className="button secondary"
                  type="button"
                  aria-controls={`create-hosted-${request.id}`}
                  disabled={busy}
                  onClick={() => setCreatingHosted(true)}
                >Create hosted collection</button>
              </div>
            ))}
            {setup.length > 0 && <small>Setup needed: allowing access will add {provisionNames(setup)} to this collection.</small>}
          </div>
        </section>
        <section className="request-section">
          <div><strong>Permissions</strong><small>{permissionCount} specific actions across {permissionGroups.length} {permissionGroups.length === 1 ? "category" : "categories"}.</small></div>
          <RequestPermissionChoices groups={permissionGroups} selected={operations} onChange={setOperations} />
        </section>
        <NotificationAccess notifications={request.notifications} />
        <footer className="request-footer">
          <p>{selected
            ? `${request.application_name} will use ${selected.display_name}, ${selected.kind === "hosted" ? "hosted by mdbase" : "on this computer"}, until you revoke access.`
            : `Choose a compatible collection before allowing ${request.application_name}.`}</p>
          <div className="decision-actions">
            <button className="button secondary danger-text" disabled={busy} onClick={() => void onAct(async () => { await window.mdbaseConnect.denyAuthorization(request.id); onNotice(`${request.application_name} was denied.`); })}>Deny</button>
            <button className="button primary" disabled={busy || !selected || selectedPermissionCount === 0} onClick={() => void onAct(async () => {
              if (selected?.kind === "hosted") {
                await window.mdbaseConnect.approveHostedAuthorization({ requestId: request.id, collectionId, operations });
              } else {
                await window.mdbaseConnect.approveAuthorization({ requestId: request.id, collectionId, operations });
              }
              onNotice(`${request.application_name} can now use the selected operations.`);
            })}>Allow {request.application_name}</button>
          </div>
        </footer>
      </div>
    </article>
  );
}

function RequestPermissionChoices({
  groups,
  selected,
  onChange
}: {
  groups: ReturnType<typeof groupAuthorizationOperations>;
  selected: string[];
  onChange(value: string[]): void;
}) {
  const selectedSet = new Set(selected);
  const total = groups.reduce((count, group) => count + group.operations.length, 0);
  const selectedTotal = groups.reduce(
    (count, group) =>
      count + group.operations.filter((operation) => selectedSet.has(operation.id)).length,
    0
  );
  function toggle(operation: string, checked: boolean) {
    onChange(checked
      ? [...selected, operation]
      : selected.filter((value) => value !== operation));
  }
  return (
    <details className="request-permission-review">
      <summary><span><strong>{selectedTotal} of {total} selected</strong><small>Review or narrow individual actions</small></span><b>Review</b></summary>
      <div className="request-permission-groups">{groups.map((group) => (
        <fieldset key={group.id}>
          <legend>{group.label}</legend>
          <p>{group.description}</p>
          <div>{group.operations.map((operation) => (
            <label key={operation.id}>
              <input type="checkbox" checked={selectedSet.has(operation.id)} onChange={(event) => toggle(operation.id, event.target.checked)} />
              <span>{operation.label}</span>
            </label>
          ))}</div>
        </fieldset>
      ))}</div>
    </details>
  );
}

function NotificationAccess({ notifications }: { notifications: ApplicationNotifications }) {
  if (notifications.criteria.length === 0) return null;
  return (
    <details className="notification-request">
      <summary><span><strong>Change notifications</strong><small>{notifications.criteria.length} optional {plural(notifications.criteria.length, "rule", "rules")}; pushes contain no record content.</small></span><b>Details</b></summary>
      <ul>{notifications.criteria.map((criterion) => (
        <li key={criterion.id}>
          <span>{criterion.presentation.title}</span>
          <code>{criterion.event.id} v{criterion.event.version}</code>
        </li>
      ))}</ul>
      <p>If you enable these in the application, the rules run inside the collection.</p>
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
              if (grant.collection_kind === "hosted") await window.mdbaseConnect.revokeHostedGrant(grant.id);
              else await window.mdbaseConnect.revokeGrant(grant.id);
              onNotice(`${grant.application_name} access was revoked.`);
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
          <SectionHeading title="Portal connection" note="Account and routing metadata for this computer." />
          <div className="settings-rows">
            <ComputerNameSetting account={access.account} online={access.online} busy={busy} onAct={onAct} onNotice={onNotice} />
            <SettingRow label="Server" value={cloud.serverUrl ?? "Configured"} detail={access.online ? "Control service reachable" : "Using cached local policy"} mono />
            <SettingRow label="Connection" value={connection.settingsLabel} detail="The relay connection is always outbound from this computer" />
            <SettingRow label="Direct access" value={status?.direct_access_available ? "Available" : "Unavailable"} detail="Approved apps on this computer can bypass the relay" />
          </div>
          <button className="button secondary danger-text disconnect-button" disabled={busy} onClick={() => { if (window.confirm("Disconnect this computer from its portal? Existing local collection files are unaffected.")) void onAct(async () => { await window.mdbaseConnect.clearCloudConfig(); }); }}>Disconnect computer</button>
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
          <SettingSwitch
            className="setting-toggle"
            label="Application access"
            description="Pause direct and relayed operations while keeping grants connected"
            checked={status ? !status.paused : false}
            disabled={busy || status === null}
            stateLabel={status ? status.paused ? "Paused" : "Available" : "Checking"}
            onChange={(checked) => void onAct(async () => {
              await window.mdbaseConnect.setAccessPaused(!checked);
              onNotice(checked ? "Application access is available." : "Application access is paused.");
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
            <ThemeSelect />
          </div>
        </div>
      </section>
      <section className="privacy-block"><span className="privacy-lock">⌁</span><div><strong>Folder locations are never synchronized.</strong><p>Computer-owned collection content stays on this computer. Hosted Markdown is stored by the encrypted hosted provider and optional mirrors synchronize directly with it; the account portal receives only collection and access metadata.</p></div></section>
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

function ThemeSelect() {
  const [preference, setPreference] = useState<ThemePreference>(loadThemePreference);
  useEffect(() => {
    applyThemePreference(preference);
    if (preference !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyThemePreference("system");
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [preference]);
  return <select className="theme-select" aria-label="Color theme" value={preference} onChange={(event) => {
    const next = event.target.value as ThemePreference;
    setPreference(next);
    saveThemePreference(next);
  }}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
