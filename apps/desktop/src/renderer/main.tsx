import "@fontsource/atkinson-hyperlegible/latin-400.css";
import "@fontsource/atkinson-hyperlegible/latin-700.css";
import "@fontsource/azeret-mono/latin-400.css";
import "@fontsource/azeret-mono/latin-500.css";
import "@fontsource/azeret-mono/latin-600.css";
import "@mdbase/connect-ui/styles.css";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type Route = "overview" | "collections" | "access" | "activity" | "settings";

const allOperations = ["read", "query", "create", "update", "rename", "delete", "validate", "read_type", "create_type", "update_type"];
const routeCopy: Record<Route, { eyebrow: string; title: string; lede: string }> = {
  overview: {
    eyebrow: "This computer",
    title: "Your local connection.",
    lede: "Collections, application access, and relay status in one place."
  },
  collections: {
    eyebrow: "Local collections",
    title: "Your files stay here.",
    lede: "Choose which mdbase folders this computer can make available."
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
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [startup, setStartup] = useState<StartupSetting>({ enabled: false, available: false });
  const [cloud, setCloud] = useState<CloudSetting>({ configured: false, serverUrl: null });
  const [access, setAccess] = useState<AccessSnapshot>({ configured: false, online: false, grants: [], pending_authorizations: [] });
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPath, setNewPath] = useState("");

  const refresh = useCallback(async (quiet = false) => {
    try {
      const [nextStatus, nextCollections, nextStartup, nextCloud, nextAccess, nextActivity] = await Promise.all([
        window.mdbaseConnect.status(),
        window.mdbaseConnect.listCollections(),
        window.mdbaseConnect.getLaunchAtLogin(),
        window.mdbaseConnect.getCloudConfig(),
        window.mdbaseConnect.accessSnapshot(),
        window.mdbaseConnect.listActivity(100)
      ]);
      setStatus(nextStatus);
      setCollections(nextCollections);
      setStartup(nextStartup);
      setCloud(nextCloud);
      setAccess(nextAccess);
      setActivity(nextActivity);
      setError(null);
    } catch (refreshError) {
      if (!quiet) setError(message(refreshError));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 5_000);
    const removeNavigation = window.mdbaseConnect.onNavigate((next) => {
      if (["overview", "collections", "access", "activity", "settings"].includes(next)) {
        setRoute(next as Route);
      }
    });
    return () => {
      window.clearInterval(timer);
      removeNavigation();
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
      const added = await window.mdbaseConnect.addCollection();
      if (added) setNotice(`${added.display_name} is now available to mdbase connect.`);
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
      const created = await window.mdbaseConnect.createCollection({ path: newPath, name: newName });
      setCreateOpen(false);
      setNewName("");
      setNewPath("");
      setNotice(`${created.display_name} was created and registered.`);
    });
  }

  const copy = routeCopy[route];
  const connectionLabel = status?.paused
    ? "Remote access paused"
    : status?.state === "connected"
      ? "Connected securely"
      : cloud.configured
        ? "Connector offline"
        : "Local only";

  return (
    <div className="shell">
      <header className="product-header desktop-header">
        <div className="product-header-inner">
          <div className="product-brand"><span className="product-brand-dot" aria-hidden="true" /><strong>mdbase</strong><span className="product-brand-label">connect</span></div>
          <div className="product-header-meta">
            <StatusDot state={status?.paused ? "paused" : status?.state === "connected" ? "connected" : "idle"} />
            <div className="product-header-meta-copy"><strong>{connectionLabel}</strong><small>{access.account?.connector_name ?? "This computer"} · {status?.registered_collections ?? 0} registered</small></div>
          </div>
        </div>
      </header>

      <nav className="view-tabs" aria-label="mdbase connect views">
        <div className="view-tabs-inner">
          <NavButton route="overview" current={route} label="Overview" onSelect={setRoute} />
          <NavButton route="collections" current={route} label="Collections" count={collections.length} onSelect={setRoute} />
          <NavButton route="access" current={route} label="App access" attention={access.pending_authorizations.length} onSelect={setRoute} />
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

        {route === "overview" && (
          <Overview
            status={status}
            cloud={cloud}
            access={access}
            collections={collections}
            busy={busy}
            onNavigate={setRoute}
            onPairingComplete={() => void refresh()}
            onPause={(paused) => void act(async () => {
              await window.mdbaseConnect.setAccessPaused(paused);
              setNotice(paused ? "Remote access is paused on this computer." : "Remote access is available again.");
            })}
          />
        )}
        {route === "collections" && (
          <Collections
            collections={collections}
            busy={busy}
            onAdd={() => void addExisting()}
            onCreate={() => setCreateOpen(true)}
            onAct={act}
            onNotice={setNotice}
          />
        )}
        {route === "access" && (
          <Access
            cloud={cloud}
            access={access}
            collections={collections}
            busy={busy}
            onAct={act}
            onNotice={setNotice}
            onPairingComplete={() => void refresh()}
          />
        )}
        {route === "activity" && <Activity entries={activity} />}
        {route === "settings" && (
          <Settings
            startup={startup}
            cloud={cloud}
            access={access}
            status={status}
            busy={busy}
            onAct={act}
            onNotice={setNotice}
            onPairingComplete={() => void refresh()}
          />
        )}
      </main>

      {createOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => !busy && setCreateOpen(false)}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="create-title" onMouseDown={(event) => event.stopPropagation()}>
            <p className="eyebrow">New local collection</p>
            <h2 id="create-title">Create an mdbase collection</h2>
            <p>mdbase connect will add a canonical <code>mdbase.yaml</code> and type folder. Existing files are left alone.</p>
            <label><span>Collection name</span><input autoFocus value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Workouts" /></label>
            <label><span>Folder</span><button className="folder-picker" onClick={() => void chooseCreateFolder()}>{newPath || "Choose a folder…"}</button></label>
            <div className="modal-actions">
              <button className="button secondary" disabled={busy} onClick={() => setCreateOpen(false)}>Cancel</button>
              <button className="button primary" disabled={busy || !newName.trim() || !newPath} onClick={() => void createCollection()}>Create collection</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function Overview({ status, cloud, access, collections, busy, onNavigate, onPairingComplete, onPause }: {
  status: AgentStatus | null;
  cloud: CloudSetting;
  access: AccessSnapshot;
  collections: CollectionSummary[];
  busy: boolean;
  onNavigate(route: Route): void;
  onPairingComplete(): void;
  onPause(paused: boolean): void;
}) {
  if (!cloud.configured) {
    return <PairingPanel onComplete={onPairingComplete} />;
  }
  return (
    <div className="workspace-stack">
      {access.pending_authorizations.length > 0 && (
        <button className="pending-banner" onClick={() => onNavigate("access")}>
          <span>{access.pending_authorizations.length}</span>
          <div><strong>{plural(access.pending_authorizations.length, "application is", "applications are")} waiting for a decision</strong><small>Review the requested collection operations on this computer.</small></div>
          <b>Review requests</b>
        </button>
      )}
      <section className="readiness-panel">
        <div className="readiness-copy">
          <p className="eyebrow">Connection state</p>
          <h2>{status?.paused ? "Access is paused." : access.online ? "This computer is ready." : "Working from the local cache."}</h2>
          <p>{status?.paused ? "Apps remain connected, but every remote operation is being denied locally." : access.online ? "Approved applications can reach available collections while this connector is running." : "Existing local settings remain visible. Cloud changes will resume when the relay reconnects."}</p>
        </div>
        <SettingSwitch
          className="pause-control"
          label="Remote access"
          description="Pause without disconnecting applications"
          checked={status ? !status.paused : false}
          disabled={busy || status === null}
          stateLabel={status ? status.paused ? "Paused" : "Available" : "Checking"}
          onChange={(checked) => onPause(!checked)}
        />
      </section>
      <section className="overview-list" aria-label="Connector summary">
        <OverviewRow label="Collections" value={`${collections.length} registered`} detail="Only enabled local folders can be reached" action="Manage" onClick={() => onNavigate("collections")} />
        <OverviewRow label="Application access" value={`${access.grants.length} active`} detail="Each grant is limited to one collection" action="Manage" onClick={() => onNavigate("access")} />
        <OverviewRow label="Portal" value={access.account?.user_email ?? cloud.serverUrl ?? "Configured"} detail={access.account?.connector_name ?? "Cloud identity unavailable while offline"} action="Settings" onClick={() => onNavigate("settings")} />
      </section>
    </div>
  );
}

function OverviewRow({ label, value, detail, action, onClick }: { label: string; value: string; detail: string; action: string; onClick(): void }) {
  return <div className="overview-row"><span>{label}</span><div><strong>{value}</strong><small>{detail}</small></div><button className="quiet-action" onClick={onClick}>{action}</button></div>;
}

function Collections({ collections, busy, onAdd, onCreate, onAct, onNotice }: {
  collections: CollectionSummary[];
  busy: boolean;
  onAdd(): void;
  onCreate(): void;
  onAct(action: () => Promise<void>): Promise<void>;
  onNotice(value: string): void;
}) {
  return (
    <section className="collection-section">
      <SectionHeading title="Collections" note="Removing a collection never deletes its files.">
        <button className="button secondary" disabled={busy} onClick={onAdd}>Add existing</button>
        <button className="button primary" disabled={busy} onClick={onCreate}>Create collection</button>
      </SectionHeading>
      {collections.length === 0 ? (
        <Empty title="No collections registered" text="Add a folder with an existing mdbase.yaml, or create a new collection." action="Create the first collection" onAction={onCreate} />
      ) : (
        <div className="collection-list">
          {collections.map((collection) => <CollectionRow key={collection.id} collection={collection} busy={busy} onAct={onAct} onNotice={onNotice} />)}
        </div>
      )}
    </section>
  );
}

function CollectionRow({ collection, busy, onAct, onNotice }: {
  collection: CollectionSummary;
  busy: boolean;
  onAct(action: () => Promise<void>): Promise<void>;
  onNotice(value: string): void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(collection.display_name);
  const [description, setDescription] = useState(collection.description ?? "");
  useEffect(() => {
    if (!editing) {
      setName(collection.display_name);
      setDescription(collection.description ?? "");
    }
  }, [collection.description, collection.display_name, editing]);

  const changed = name.trim() !== collection.display_name
    || description.trim() !== (collection.description ?? "");
  return (
    <article className={`collection-card ${editing ? "editing" : ""}`}>
      <div className="collection-summary">
        <div className="collection-copy">
          <div className="collection-title-row"><h3>{collection.display_name}</h3><span className="version">v{collection.spec_version}</span></div>
          {collection.description && <p>{collection.description}</p>}
          <button className="path" title={collection.path} onClick={() => void window.mdbaseConnect.openPath(collection.path)}>{collection.path}</button>
        </div>
        <div className="collection-status"><StatusDot state={collection.enabled ? "connected" : "idle"} />{collection.enabled ? "Available" : "Disabled"}</div>
        <div className="row-actions">
          <button className="quiet-action" disabled={busy} aria-expanded={editing} onClick={() => setEditing((value) => !value)}>{editing ? "Close" : "Details"}</button>
          <button className="quiet-action" disabled={busy} onClick={() => void onAct(async () => { await window.mdbaseConnect.setCollectionEnabled(collection.id, !collection.enabled); onNotice(collection.enabled ? `${collection.display_name} is no longer available to remote applications.` : `${collection.display_name} is available again.`); })}>{collection.enabled ? "Disable" : "Enable"}</button>
        </div>
      </div>
      {editing && <div className="collection-editor">
        <form onSubmit={(event) => { event.preventDefault(); void onAct(async () => { const updated = await window.mdbaseConnect.updateCollectionMetadata({ collectionId: collection.id, name, description }); setEditing(false); onNotice(`${updated.display_name} details were saved to mdbase.yaml.`); }); }}>
          <label><span>Name</span><input value={name} maxLength={100} required onChange={(event) => setName(event.target.value)} /></label>
          <label><span>Description</span><textarea value={description} maxLength={500} rows={2} placeholder="Optional" onChange={(event) => setDescription(event.target.value)} /></label>
          <div className="editor-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => void window.mdbaseConnect.openCollectionConfig(collection.id)}>Open mdbase.yaml</button><button className="button primary" disabled={busy || !changed || !name.trim()}>Save details</button></div>
        </form>
        <div className="collection-maintenance">
          <button className="quiet-action" disabled={busy} onClick={() => void onAct(async () => { await window.mdbaseConnect.validateCollection(collection.id); onNotice(`${collection.display_name} passed collection validation.`); })}>Validate collection</button>
          <button className="quiet-action danger" disabled={busy} onClick={() => { if (window.confirm(`Remove ${collection.display_name} from mdbase connect? Its files will not be deleted.`)) void onAct(async () => { await window.mdbaseConnect.removeCollection(collection.id); onNotice(`${collection.display_name} was removed.`); }); }}>Remove from mdbase connect</button>
        </div>
      </div>}
    </article>
  );
}

function Access({ cloud, access, collections, busy, onAct, onNotice, onPairingComplete }: {
  cloud: CloudSetting;
  access: AccessSnapshot;
  collections: CollectionSummary[];
  busy: boolean;
  onAct(action: () => Promise<void>): Promise<void>;
  onNotice(value: string): void;
  onPairingComplete(): void;
}) {
  if (!cloud.configured) return <PairingPanel onComplete={onPairingComplete} />;
  return (
    <div className="workspace-stack">
      <section>
        <SectionHeading title="Pending requests" note="A website cannot continue until you decide here." count={access.pending_authorizations.length} />
        {access.pending_authorizations.length === 0 ? (
          <Empty title="No applications are waiting" text="New connection requests from websites will appear here while this computer is online." />
        ) : (
          <div className="request-list">
            {access.pending_authorizations.map((request) => <AuthorizationRequest key={request.id} request={request} collections={collections} busy={busy} onAct={onAct} onNotice={onNotice} />)}
          </div>
        )}
      </section>

      <section>
        <SectionHeading title="Connected applications" note="Change allowed operations or revoke access immediately." count={access.grants.length} />
        {access.grants.length === 0 ? (
          <Empty title="No applications connected" text="Connect from an mdbase-enabled website, or inspect a published application manifest below." />
        ) : (
          <div className="grant-list">{access.grants.map((grant) => <GrantEditor key={grant.id} grant={grant} busy={busy} onAct={onAct} onNotice={onNotice} />)}</div>
        )}
      </section>

      <ManualApplication collections={collections} busy={busy} onAct={onAct} onNotice={onNotice} />
    </div>
  );
}

function AuthorizationRequest({ request, collections, busy, onAct, onNotice }: {
  request: PendingAuthorization;
  collections: CollectionSummary[];
  busy: boolean;
  onAct(action: () => Promise<void>): Promise<void>;
  onNotice(value: string): void;
}) {
  const compatible = useMemo(
    () => collections.filter((collection) => request.compatible_collection_ids.includes(collection.id)),
    [collections, request.compatible_collection_ids]
  );
  const [collectionId, setCollectionId] = useState(compatible[0]?.id ?? "");
  const [operations, setOperations] = useState(request.requested_operations);
  useEffect(() => {
    if (!compatible.some((collection) => collection.id === collectionId)) {
      setCollectionId(compatible[0]?.id ?? "");
    }
  }, [collectionId, compatible]);
  return (
    <article className="request-panel">
      <div className="identity-mark">{initials(request.application_name)}</div>
      <div className="request-identity"><p className="eyebrow">Access request</p><h3>{request.application_name}</h3><code>{host(request.application_homepage)}</code><small>Expires {relativeTime(request.expires_at)}</small>{request.requirements.contracts.length > 0 && <small>{scopeDescription(request.requirements.contracts)}</small>}</div>
      <div className="request-fields">
        <label><span>Collection</span><select value={collectionId} disabled={compatible.length === 0} onChange={(event) => setCollectionId(event.target.value)}>{compatible.map((collection) => <option key={collection.id} value={collection.id}>{collection.display_name}</option>)}</select></label>
        {compatible.length === 0 && <small>No registered collection provides the required contracts.</small>}
        <fieldset><legend>Requested operations</legend><OperationChoices allowed={request.requested_operations} selected={operations} onChange={setOperations} /></fieldset>
      </div>
      <div className="decision-actions">
        <button className="button secondary danger-text" disabled={busy} onClick={() => void onAct(async () => { await window.mdbaseConnect.denyAuthorization(request.id); onNotice(`${request.application_name} was denied.`); })}>Deny</button>
        <button className="button primary" disabled={busy || !collectionId || operations.length === 0} onClick={() => void onAct(async () => { await window.mdbaseConnect.approveAuthorization({ requestId: request.id, collectionId, operations }); onNotice(`${request.application_name} can now use the selected operations.`); })}>Allow access</button>
      </div>
    </article>
  );
}

function GrantEditor({ grant, busy, onAct, onNotice }: { grant: GrantSummary; busy: boolean; onAct(action: () => Promise<void>): Promise<void>; onNotice(value: string): void }) {
  const [operations, setOperations] = useState(grant.operations);
  const allowedOperations = grant.scope.contracts.length > 0
    ? allOperations.filter((operation) => operation !== "validate")
    : allOperations;
  const changed = useMemo(() => [...operations].sort().join(",") !== [...grant.operations].sort().join(","), [operations, grant.operations]);
  useEffect(() => setOperations(grant.operations), [grant.operations]);
  return (
    <article className="grant-row">
      <div className="identity-mark">{initials(grant.application_name)}</div>
      <div className="grant-identity"><strong>{grant.application_name}</strong><code>{host(grant.application_homepage)}</code><small>{grant.collection_name}</small>{grant.scope.contracts.length > 0 && <small>{scopeDescription(grant.scope.contracts)}</small>}</div>
      <OperationChoices allowed={allowedOperations} selected={operations} onChange={setOperations} compact />
      <div className="row-actions">
        <button className="quiet-action" disabled={busy || !changed || operations.length === 0} onClick={() => void onAct(async () => { await window.mdbaseConnect.updateGrant({ grantId: grant.id, operations }); onNotice(`${grant.application_name} permissions were updated.`); })}>Save</button>
        <button className="quiet-action danger" disabled={busy} onClick={() => { if (window.confirm(`Revoke ${grant.application_name} access to ${grant.collection_name}?`)) void onAct(async () => { await window.mdbaseConnect.revokeGrant(grant.id); onNotice(`${grant.application_name} access was revoked.`); }); }}>Revoke</button>
      </div>
    </article>
  );
}

function ManualApplication({ collections, busy, onAct, onNotice }: { collections: CollectionSummary[]; busy: boolean; onAct(action: () => Promise<void>): Promise<void>; onNotice(value: string): void }) {
  const [expanded, setExpanded] = useState(false);
  const [manifestUrl, setManifestUrl] = useState("");
  const [application, setApplication] = useState<ApplicationSummary | null>(null);
  const [collectionId, setCollectionId] = useState(collections[0]?.id ?? "");
  const [operations, setOperations] = useState(["read", "query"]);
  const compatible = useMemo(
    () => application ? compatibleCollections(application.requirements, collections) : collections,
    [application, collections]
  );
  useEffect(() => {
    if (!compatible.some((collection) => collection.id === collectionId)) {
      setCollectionId(compatible[0]?.id ?? "");
    }
  }, [collectionId, compatible]);
  return (
    <section className="manual-app">
      <button className="manual-app-toggle" onClick={() => setExpanded(!expanded)}><span><strong>Add from an application manifest</strong><small>For apps that have not initiated their own connection request.</small></span><b>{expanded ? "Hide" : "Inspect app"}</b></button>
      {expanded && (
        <div className="manual-app-body">
          {!application ? (
            <form onSubmit={(event) => { event.preventDefault(); void onAct(async () => { const found = await window.mdbaseConnect.discoverApplication(manifestUrl); setApplication(found.application); }); }}>
              <label><span>Manifest URL</span><input type="url" required value={manifestUrl} onChange={(event) => setManifestUrl(event.target.value)} placeholder="https://app.example/.well-known/mdbase-app.json" /></label>
              <button className="button secondary" disabled={busy}>Inspect</button>
            </form>
          ) : (
            <div className="manual-grant">
              <div><p className="eyebrow">Application found</p><h3>{application.name}</h3><code>{host(application.homepage)}</code>{application.requirements.contracts.length > 0 && <small>{scopeDescription(application.requirements.contracts)}</small>}</div>
              <label><span>Collection</span><select value={collectionId} disabled={compatible.length === 0} onChange={(event) => setCollectionId(event.target.value)}>{compatible.map((collection) => <option key={collection.id} value={collection.id}>{collection.display_name}</option>)}</select></label>
              {compatible.length === 0 && <small>No registered collection provides the required contracts.</small>}
              <fieldset><legend>Allow</legend><OperationChoices allowed={allOperations} selected={operations} onChange={setOperations} compact /></fieldset>
              <button className="button primary" disabled={busy || !collectionId || operations.length === 0} onClick={() => void onAct(async () => { await window.mdbaseConnect.createGrant({ applicationId: application.id, collectionId, operations }); onNotice(`${application.name} is connected.`); setApplication(null); setManifestUrl(""); setExpanded(false); })}>Connect app</button>
            </div>
          )}
        </div>
      )}
    </section>
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

function Settings({ startup, cloud, access, status, busy, onAct, onNotice, onPairingComplete }: {
  startup: StartupSetting;
  cloud: CloudSetting;
  access: AccessSnapshot;
  status: AgentStatus | null;
  busy: boolean;
  onAct(action: () => Promise<void>): Promise<void>;
  onNotice(value: string): void;
  onPairingComplete(): void;
}) {
  return (
    <div className="workspace-stack settings-stack">
      {!cloud.configured ? <PairingPanel onComplete={onPairingComplete} /> : (
        <section>
          <SectionHeading title="Portal connection" note="Account and routing metadata for this computer." />
          <div className="settings-rows">
            <ComputerNameSetting account={access.account} online={access.online} busy={busy} onAct={onAct} onNotice={onNotice} />
            <SettingRow label="Server" value={cloud.serverUrl ?? "Configured"} detail={access.online ? "Control service reachable" : "Using cached local policy"} mono />
            <SettingRow label="Connection" value={status?.state === "connected" ? "Connected" : "Offline"} detail="The relay connection is always outbound from this computer" />
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
            label="Remote access"
            description="Pause all applications while keeping the relay connected"
            checked={status ? !status.paused : false}
            disabled={busy || status === null}
            stateLabel={status ? status.paused ? "Paused" : "Available" : "Checking"}
            onChange={(checked) => void onAct(async () => {
              await window.mdbaseConnect.setAccessPaused(!checked);
              onNotice(checked ? "Remote access is available." : "Remote access is paused.");
            })}
          />
        </div>
      </section>
      <section className="privacy-block"><span className="privacy-lock">⌁</span><div><strong>Local paths are never synchronized.</strong><p>The portal receives collection names, versions, stable identifiers, and grant metadata. Record payloads pass through the relay only while an operation is active.</p></div></section>
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

function PairingPanel({ onComplete }: { onComplete(): void }) {
  const [serverUrl, setServerUrl] = useState("https://connect.mdbase.dev");
  const [connectorName, setConnectorName] = useState("This computer");
  const [pairing, setPairing] = useState<{ pairingId: string; verificationUri: string } | null>(null);
  const [pairError, setPairError] = useState("");
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!pairing) return;
    const timer = window.setInterval(async () => {
      try {
        const result = await window.mdbaseConnect.pairingStatus(pairing.pairingId);
        if (result.status === "paired") {
          window.clearInterval(timer);
          onComplete();
        }
      } catch (error) {
        setPairError(message(error));
        window.clearInterval(timer);
      }
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [pairing, onComplete]);

  async function begin(event: React.FormEvent) {
    event.preventDefault();
    setStarting(true);
    setPairError("");
    try {
      const result = await window.mdbaseConnect.beginPairing({ serverUrl, connectorName });
      setPairing(result);
    } catch (error) {
      setPairError(message(error));
    } finally {
      setStarting(false);
    }
  }

  return (
    <section className="pairing-panel">
      <div className="pairing-intro"><p className="eyebrow">Portal connection</p><h2>{pairing ? "Finish in your browser." : "Connect this computer."}</h2><p>{pairing ? "Sign in and approve the computer. This window will update automatically, and no token needs to be copied." : "A portal supplies identity and routing so authorized websites can find this connector. Collection paths remain local."}</p></div>
      {pairError && <div className="message error-message">{pairError}</div>}
      {pairing ? (
        <div className="pairing-wait"><StatusDot state="paused" /><div><strong>Waiting for browser approval</strong><code>{pairing.verificationUri}</code></div><button className="quiet-action" onClick={() => setPairing(null)}>Start again</button></div>
      ) : (
        <form className="pairing-form" onSubmit={(event) => void begin(event)}>
          <label><span>Server</span><input type="url" value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} /></label>
          <label><span>Computer name</span><input value={connectorName} onChange={(event) => setConnectorName(event.target.value)} /></label>
          <button className="button primary" disabled={starting || !serverUrl.trim() || !connectorName.trim()}>{starting ? "Opening browser…" : "Continue in browser"}</button>
        </form>
      )}
    </section>
  );
}

function OperationChoices({ allowed, selected, onChange, compact = false }: { allowed: string[]; selected: string[]; onChange(value: string[]): void; compact?: boolean }) {
  return <div className={`operation-choices ${compact ? "compact" : ""}`}>{allowed.map((operation) => <label key={operation}><input type="checkbox" checked={selected.includes(operation)} onChange={(event) => onChange(event.target.checked ? [...selected, operation] : selected.filter((value) => value !== operation))} /><span>{operation}</span>{!compact && <small>{operationDescription(operation)}</small>}</label>)}</div>;
}

function NavButton({ route, current, label, count, attention, onSelect }: { route: Route; current: Route; label: string; count?: number; attention?: number; onSelect(route: Route): void }) {
  return <button className={`view-tab ${current === route ? "active" : ""}`} aria-current={current === route ? "page" : undefined} onClick={() => onSelect(route)}><span>{label}</span>{attention ? <b className="view-tab-count attention">{attention}</b> : count !== undefined ? <b className="view-tab-count">{count}</b> : null}</button>;
}

function SectionHeading({ title, note, count, children }: { title: string; note: string; count?: number; children?: React.ReactNode }) {
  return <div className="section-heading"><div><h2>{title}</h2><p>{note}</p></div><div className="heading-actions">{count !== undefined && <span className="count">{count}</span>}{children}</div></div>;
}

function Empty({ title, text, action, onAction }: { title: string; text: string; action?: string; onAction?(): void }) {
  return <div className="empty-state"><div className="empty-folder" aria-hidden="true"><span /></div><h3>{title}</h3><p>{text}</p>{action && onAction && <button className="text-action" onClick={onAction}>{action}</button>}</div>;
}

function StatusDot({ state }: { state: "connected" | "paused" | "danger" | "idle" }) {
  return <span className={`status-dot ${state}`} aria-hidden="true" />;
}

function SettingSwitch({ className, label, description, checked, disabled, stateLabel, onChange }: {
  className: "pause-control" | "setting-toggle";
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  stateLabel: string;
  onChange(checked: boolean): void;
}) {
  return (
    <label className={`${className} ${disabled ? "disabled" : ""}`}>
      <span className="toggle-copy"><strong>{label}</strong><small>{description}</small></span>
      <span className="toggle-action">
        <span className="toggle-state" aria-hidden="true">{stateLabel}</span>
        <input
          type="checkbox"
          role="switch"
          aria-label={label}
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
      </span>
    </label>
  );
}

function operationDescription(operation: string) {
  return ({ read: "Open individual records", query: "Find and filter records", create: "Add records", update: "Change records", rename: "Move or rename records", delete: "Delete records", validate: "Check collection validity", read_type: "Inspect type definitions", create_type: "Add definitions that shape records", update_type: "Change definitions and compatibility" } as Record<string, string>)[operation] ?? operation;
}

function compatibleCollections(
  requirements: ApplicationRequirements,
  collections: CollectionSummary[]
): CollectionSummary[] {
  if (requirements.contracts.length === 0) return collections;
  return collections.filter((collection) => requirements.contracts.every((requirement) =>
    collection.contracts.some((contract) =>
      contract.id === requirement.id && contract.version === requirement.version
    )
  ));
}

function scopeDescription(contracts: ContractRequirement[]): string {
  const names = contracts.map((contract) => `${contract.id} v${contract.version}`);
  return `Records matching ${names.join(" and ")} only`;
}

function host(value: string) { try { return new URL(value).host; } catch { return value; } }
function initials(value: string) { return value.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function plural(count: number, singular: string, pluralValue: string) { return count === 1 ? singular : pluralValue; }
function relativeTime(value: string) {
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  const seconds = Math.round((date.getTime() - Date.now()) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
