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
import {
  MDBASE_MARK_VIEW_BOX,
  mdbaseMarkAccentRect,
  mdbaseMarkInkRects
} from "@mdbase/connect-ui/brand";
import { applyThemePreference, loadThemePreference, saveThemePreference, type ThemePreference } from "@mdbase/connect-ui/theme";
import "@mdbase/connect-ui/styles.css";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { presentConnection, type ConnectionDotState } from "./connection-state.mjs";
import "./styles.css";

type Route = "overview" | "collections" | "access" | "activity" | "settings";
interface AuthorizationCollection {
  id: string;
  display_name: string;
  spec_version: string;
  contracts: ContractRequirement[];
  kind: "local" | "hosted";
  provisionable: boolean;
}

const allOperations = ["describe", "changes", "read", "query", "list_views", "execute_view", "read_view_source", "create", "update", "rename", "delete", "create_view_source", "update_view_source", "delete_view_source", "validate", "read_type", "create_type", "update_type", "list_timers", "put_timer", "cancel_timer", "reconcile_timers"];
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

function Collections({
  collections,
  hosted,
  cloudConfigured,
  mirrors,
  mirrorTarget,
  authorityConflicts,
  busy,
  copiedCollectionPath,
  onAdd,
  onCancelCopy,
  onCreate,
  onRegisterCopy,
  onMirrorTargetHandled,
  onAct,
  onNotice
}: {
  collections: CollectionSummary[];
  hosted: HostedControlSnapshot;
  cloudConfigured: boolean;
  mirrors: DesktopMirrorSummary[];
  mirrorTarget: string | null;
  authorityConflicts: AuthorityConflict[];
  busy: boolean;
  copiedCollectionPath: string | null;
  onAdd(): void;
  onCancelCopy(): void;
  onCreate(): void;
  onRegisterCopy(): void;
  onMirrorTargetHandled(): void;
  onAct(action: () => Promise<void>): Promise<void>;
  onNotice(value: string): void;
}) {
  return (
    <section className="collection-section">
      <SectionHeading title="Collections" note="Authority and local copies are shown separately.">
        <button className="button secondary" disabled={busy} onClick={onAdd}>Add existing</button>
        <button className="button primary" disabled={busy} onClick={onCreate}>Create collection</button>
      </SectionHeading>
      {copiedCollectionPath && (
        <section className="copy-registration" aria-labelledby="copy-title">
          <div>
            <p className="eyebrow">Copied collection</p>
            <h2 id="copy-title">Register this copy independently?</h2>
            <p>This folder has the same Connect identity as a registered collection. Continuing writes a new identity only to the selected copy’s <code>mdbase.yaml</code>. The original is not changed.</p>
            <code>{copiedCollectionPath}</code>
            <small>Apps will treat the copy as a separate collection with its own links and access approvals.</small>
          </div>
          <div className="copy-registration-actions">
            <button className="button secondary" disabled={busy} onClick={onCancelCopy}>Cancel</button>
            <button className="button primary" disabled={busy} onClick={onRegisterCopy}>Register copy</button>
          </div>
        </section>
      )}
      {authorityConflicts.map((conflict) => {
        const selectedFolder = collections.find(
          (collection) => collection.id === conflict.collection_id
        )?.path ?? conflict.display_name;
        return <section className="copy-registration" aria-labelledby={`authority-${conflict.collection_id}`} key={conflict.collection_id}>
          <div>
            <p className="eyebrow">Collection identity conflict</p>
            <h2 id={`authority-${conflict.collection_id}`}>Choose which copy of {conflict.display_name} to use.</h2>
            <p>The selected folder and an existing connected copy share the same collection ID.</p>
            <dl className="identity-conflict-details">
              <div><dt>Selected folder</dt><dd><code title={selectedFolder}>{selectedFolder}</code></dd></div>
              <div><dt>Currently active through</dt><dd>{conflict.active_connector_name}</dd></div>
            </dl>
            <small>Using the selected folder moves authority here and revokes application access through {conflict.active_connector_name}. Keeping both writes a new ID only to the selected folder’s <code>mdbase.yaml</code>.</small>
          </div>
          <div className="copy-registration-actions">
            <button className="button secondary" disabled={busy} onClick={() => void onAct(async () => {
              const independent = await window.mdbaseConnect.makeCollectionIndependent(conflict.collection_id);
              onNotice(`${independent.display_name} now has an independent collection identity.`);
            })}>Keep both copies</button>
            <button className="button primary" disabled={busy} onClick={() => void onAct(async () => {
              if (!window.confirm(`Use ${selectedFolder} as the authority for ${conflict.display_name}? Existing application access through ${conflict.active_connector_name} will be revoked.`)) return;
              await window.mdbaseConnect.takeCollectionAuthority(conflict.collection_id);
              onNotice(`${conflict.display_name} now uses ${selectedFolder} as its authoritative folder.`);
            })}>Use selected folder</button>
          </div>
        </section>;
      })}
      <div className="collection-authority-group">
        <SectionHeading title="On this computer" note="These folders are authoritative here." count={collections.length} />
        {collections.length === 0 ? (
          <Empty title="No computer-owned collections" text="Add a folder with an existing mdbase.yaml, or create one here." />
        ) : (
          <div className="collection-list">
            {collections.map((collection) => (
              <CollectionRow
                key={collection.id}
                collection={collection}
                cloudConfigured={cloudConfigured}
                busy={busy}
                onAct={onAct}
                onNotice={onNotice}
              />
            ))}
          </div>
        )}
      </div>
      <div className="collection-authority-group">
        <SectionHeading
          title="Hosted by mdbase"
          note={!cloudConfigured
            ? "Connect this computer to manage hosted collections."
            : hosted.online
              ? "Available to approved apps without this computer."
              : "Hosted controls are offline; last known state is shown."}
          count={hosted.hosted_collections.length}
        />
        {hosted.hosted_collections.length === 0 ? (
          <Empty title="No hosted collections" text="Create one to keep its authority online, with an optional folder mirror here." />
        ) : (
          <div className="collection-list">
            {hosted.hosted_collections.map((collection) => (
              <HostedCollectionRow
                key={collection.id}
                collection={collection}
                mirrors={mirrors}
                openMirror={mirrorTarget === collection.id}
                busy={busy}
                onTargetHandled={onMirrorTargetHandled}
                onAct={onAct}
                onNotice={onNotice}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function CollectionRow({ collection, cloudConfigured, busy, onAct, onNotice }: {
  collection: CollectionSummary;
  cloudConfigured: boolean;
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
          <button
            className="quiet-action"
            disabled={busy}
            onClick={() => void window.mdbaseConnect.openEditor(collection.id)}
          >
            Open in editor <span aria-hidden="true">↗</span>
          </button>
          <button className="quiet-action" disabled={busy} aria-expanded={editing} onClick={() => setEditing((value) => !value)}>{editing ? "Close" : "Details"}</button>
          <button className="quiet-action" disabled={busy} onClick={() => void onAct(async () => { await window.mdbaseConnect.setCollectionEnabled(collection.id, !collection.enabled); onNotice(collection.enabled ? `${collection.display_name} is no longer available to remote applications.` : `${collection.display_name} is available again.`); })}>{collection.enabled ? "Disable" : "Enable"}</button>
        </div>
      </div>
      {editing && <div className="collection-editor">
        <form className="collection-editor-form" onSubmit={(event) => { event.preventDefault(); void onAct(async () => { const updated = await window.mdbaseConnect.updateCollectionMetadata({ collectionId: collection.id, name, description }); setEditing(false); onNotice(`${updated.display_name} details were saved to mdbase.yaml.`); }); }}>
          <section className="collection-editor-section">
            <div><strong>Details</strong><small>Name and description are stored in mdbase.yaml.</small></div>
            <div className="collection-fields">
              <label><span>Name</span><input value={name} maxLength={100} required onChange={(event) => setName(event.target.value)} /></label>
              <label><span>Description</span><textarea value={description} maxLength={500} rows={2} placeholder="Optional" onChange={(event) => setDescription(event.target.value)} /></label>
            </div>
          </section>
          <section className="collection-editor-section">
            <div><strong>Configuration</strong><small>Inspect the source file or check the collection structure.</small></div>
            <div className="collection-config-actions">
              <button type="button" className="quiet-action" disabled={busy} onClick={() => void window.mdbaseConnect.openCollectionConfig(collection.id)}>Open mdbase.yaml</button>
              <button type="button" className="quiet-action" disabled={busy} onClick={() => void onAct(async () => { await window.mdbaseConnect.validateCollection(collection.id); onNotice(`${collection.display_name} passed collection validation.`); })}>Validate collection</button>
            </div>
          </section>
          <footer className="request-footer collection-editor-footer">
            <p>Saving changes updates collection metadata without moving or rewriting records.</p>
            <button className="button primary" disabled={busy || !changed || !name.trim()}>Save details</button>
          </footer>
        </form>
        <section className="collection-editor-section">
          <div>
            <strong>Authority</strong>
            <small>Move the source of truth online while keeping this folder as a two-way mirror.</small>
          </div>
          <div className="collection-config-actions">
            <button
              type="button"
              className="button secondary"
              disabled={busy || !cloudConfigured || !collection.enabled}
              onClick={() => {
                if (!window.confirm(
                  `Move ${collection.display_name} authority online? `
                  + "The collection will be uploaded directly to the provider, existing local app grants will be revoked, "
                  + "and this folder will become a two-way mirror."
                )) return;
                void onAct(async () => {
                  const result = await window.mdbaseConnect.transferCollectionAuthority(collection.id);
                  setEditing(false);
                  onNotice(
                    `${collection.display_name} is now online at authority epoch `
                    + `${result.transfer.authority_epoch}; this folder is its two-way mirror.`
                  );
                });
              }}
            >
              Move authority online
            </button>
            {!cloudConfigured && <small>Connect this computer to an account first.</small>}
          </div>
        </section>
        <div className="collection-danger-row">
          <small>Removing this collection from mdbase connect never deletes its files.</small>
          <button className="quiet-action danger" disabled={busy} onClick={() => { if (window.confirm(`Remove ${collection.display_name} from mdbase connect? Its files will not be deleted.`)) void onAct(async () => { await window.mdbaseConnect.removeCollection(collection.id); onNotice(`${collection.display_name} was removed.`); }); }}>Remove from mdbase connect</button>
        </div>
      </div>}
    </article>
  );
}

function HostedCollectionRow({
  collection,
  mirrors,
  openMirror,
  busy,
  onTargetHandled,
  onAct,
  onNotice
}: {
  collection: HostedCollectionSummary;
  mirrors: DesktopMirrorSummary[];
  openMirror: boolean;
  busy: boolean;
  onTargetHandled(): void;
  onAct(action: () => Promise<void>): Promise<void>;
  onNotice(value: string): void;
}) {
  const [editing, setEditing] = useState(openMirror);
  const [name, setName] = useState(collection.display_name);
  const [path, setPath] = useState("");
  const [mode, setMode] = useState<"read_only" | "read_write">("read_write");
  const [promotionStarting, setPromotionStarting] = useState(false);
  const mirror = mirrors.find((candidate) => candidate.collection_id === collection.id);
  const activeReplicas = collection.replicas.filter((replica) => replica.revoked_at === null);
  const editorCollectionId = collection.authority_state === "active"
    ? collection.id
    : collection.authority_state === "transferred"
      ? collection.transferred_collection_id
      : null;

  useEffect(() => {
    if (openMirror) {
      setEditing(true);
      onTargetHandled();
    }
  }, [onTargetHandled, openMirror]);
  useEffect(() => {
    if (!editing) setName(collection.display_name);
  }, [collection.display_name, editing]);

  async function chooseMirrorFolder() {
    const selected = await window.mdbaseConnect.chooseMirrorFolder();
    if (selected) setPath(selected);
  }

  const state = mirrorState(mirror);
  const promotion = authorityPromotionState(collection, mirror, promotionStarting);
  return (
    <article className={`collection-card hosted-collection ${editing ? "editing" : ""}`}>
      <div className="collection-summary">
        <div className="collection-copy">
          <div className="collection-title-row">
            <h3>{collection.display_name}</h3>
            <span className="version">v{collection.spec_version}</span>
          </div>
          <span className="authority-label">
            {collection.authority_state === "transferred"
              ? "Retired hosted copy · authority moved"
              : collection.authority_state === "transferring"
                ? "Authority transfer in progress"
                : `Hosted authority · ${activeReplicas.length} ${plural(activeReplicas.length, "mirror", "mirrors")}`}
          </span>
        </div>
        <div className="collection-status">
          <StatusDot state={collection.authority_state === "active" ? "connected" : "idle"} />
          {collection.authority_state === "active"
            ? "Available"
            : collection.authority_state === "transferred"
              ? "Moved"
              : "Moving"}
        </div>
        <div className="row-actions">
          {editorCollectionId && <button
            className="quiet-action"
            disabled={busy}
            onClick={() => void window.mdbaseConnect.openEditor(editorCollectionId)}
          >
            Open in editor <span aria-hidden="true">↗</span>
          </button>}
          <button className="quiet-action" disabled={busy} aria-expanded={editing} onClick={() => setEditing((value) => !value)}>{editing ? "Close" : mirror ? "Mirror" : "Details"}</button>
        </div>
      </div>
      {editing && <div className="collection-editor hosted-editor">
        <form className="collection-editor-form" onSubmit={(event) => {
          event.preventDefault();
          void onAct(async () => {
            await window.mdbaseConnect.renameHostedCollection({ collectionId: collection.id, name });
            onNotice(`${name.trim()} was renamed.`);
          });
        }}>
          <section className="collection-editor-section">
            <div><strong>Details</strong><small>The name is stored with the hosted authority.</small></div>
            <div className="collection-fields">
              <label><span>Name</span><input value={name} maxLength={200} required onChange={(event) => setName(event.target.value)} /></label>
              <button className="button secondary" disabled={busy || !name.trim() || name.trim() === collection.display_name}>Save name</button>
            </div>
          </section>
        </form>
        {collection.authority_state !== "transferred" && <section className="collection-editor-section mirror-section">
          <div>
            <strong>Mirror on this computer</strong>
            <small>A mirror is a local copy. The hosted collection remains authoritative.</small>
          </div>
          {mirror ? (
            <div className="mirror-control">
              <div className="mirror-state-row">
                <StatusDot state={state.dot} />
                <div><strong>{state.label}</strong><button className="path" title={mirror.path} onClick={() => void window.mdbaseConnect.openMirror(mirror.replica_id)}>{mirror.path}</button></div>
                <code>{mirror.mode === "read_write" ? "two-way" : "receive-only"}</code>
              </div>
              {mirror.progress && <small>{mirror.progress.phase === "uploading" ? "Uploading" : "Applying"} {mirror.progress.completed}{mirror.progress.total === null ? "" : ` of ${mirror.progress.total}`} changes…</small>}
              {mirror.error && <div className="message error-message compact-message">{mirror.error}</div>}
              {mirror.conflicts.length > 0 && (
                <div className="mirror-conflicts">
                  {mirror.conflicts.map((conflict) => <div key={conflict.record_id}>
                    <div><strong>{conflict.path ?? conflict.record_id}</strong><small>{conflict.message}</small></div>
                    <div className="row-actions">
                      <button className="quiet-action" disabled={busy} onClick={() => void onAct(async () => {
                        await window.mdbaseConnect.resolveMirrorConflict({ replicaId: mirror.replica_id, recordId: conflict.record_id, resolution: "local" });
                        onNotice("The local version was kept and synchronized.");
                      })}>Keep local</button>
                      <button className="quiet-action" disabled={busy} onClick={() => void onAct(async () => {
                        await window.mdbaseConnect.resolveMirrorConflict({ replicaId: mirror.replica_id, recordId: conflict.record_id, resolution: "remote" });
                        onNotice("The hosted version was applied.");
                      })}>Use hosted</button>
                    </div>
                  </div>)}
                </div>
              )}
              {mirror.local_issues.length > 0 && (
                <div className="mirror-conflicts">
                  {mirror.local_issues.map((issue) => <div key={issue.path}>
                    <div>
                      <strong>{issue.path}</strong>
                      <small>{issue.message} Other valid Markdown continues to synchronize.</small>
                    </div>
                  </div>)}
                </div>
              )}
              <div className="mirror-actions">
                <button className="quiet-action" disabled={busy || mirror.syncing} onClick={() => void onAct(async () => {
                  await window.mdbaseConnect.syncMirror(mirror.replica_id);
                  onNotice(`${collection.display_name} is synchronized.`);
                })}>{mirror.syncing ? "Synchronizing…" : "Sync now"}</button>
                <button className="quiet-action" disabled={busy} onClick={() => void window.mdbaseConnect.openMirror(mirror.replica_id)}>Open folder</button>
                <button className="quiet-action danger" disabled={busy} onClick={() => {
                  if (!window.confirm(`Stop mirroring ${collection.display_name} on this computer? The folder and its files will remain.`)) return;
                  void onAct(async () => {
                    await window.mdbaseConnect.disconnectMirror(mirror.replica_id);
                    onNotice(`The mirror was disconnected. Files remain at ${mirror.path}.`);
                  });
                }}>Stop mirror</button>
              </div>
            </div>
          ) : (
            <div className="mirror-setup">
              <label><span>Folder</span><button type="button" className="folder-picker" onClick={() => void chooseMirrorFolder()}>{path || "Choose a folder…"}</button></label>
              <label><span>Synchronization</span><select value={mode} onChange={(event) => setMode(event.target.value as "read_only" | "read_write")}><option value="read_write">Two-way</option><option value="read_only">Receive-only</option></select></label>
              <small>Two-way mirrors upload local edits. Receive-only mirrors replace their local view with hosted changes.</small>
              <button className="button primary" disabled={busy || !path} onClick={() => void onAct(async () => {
                await window.mdbaseConnect.connectMirror({ collectionId: collection.id, path, mode });
                setPath("");
                onNotice(`${collection.display_name} is now mirrored on this computer.`);
              })}>Start mirror</button>
            </div>
          )}
        </section>}
        {collection.authority_state === "transferred" ? (
          <section className="collection-editor-section">
            <div>
              <strong>Authority</strong>
              <small>This hosted copy is retained for recovery but no longer accepts changes.</small>
            </div>
            <div className="authority-transfer-control">
              <div>
                <strong>Source of truth moved to this computer</strong>
                <small>The collection now appears under On this computer. Applications need fresh access to the computer-owned collection.</small>
              </div>
            </div>
          </section>
        ) : mirror && (
          <section className="collection-editor-section">
            <div>
              <strong>Authority</strong>
              <small>Make this synchronized folder the source of truth.</small>
            </div>
            <div className="authority-transfer-control">
              <div>
                <strong>{promotion.title}</strong>
                <small>{promotion.detail}</small>
              </div>
              <button
                type="button"
                className="button secondary"
                disabled={busy || !promotion.enabled}
                onClick={() => {
                  if (
                    !mirror.promotion_pending
                    && !window.confirm(
                      `Move ${collection.display_name} authority to this computer? `
                      + `${mirror.path} will become the source of truth. Hosted writes will stop, `
                      + "and existing application access and other mirrors will be revoked. "
                      + "You will confirm this change in your browser."
                    )
                  ) return;
                  setPromotionStarting(true);
                  void onAct(async () => {
                    onNotice(
                      mirror.promotion_pending
                        ? "Resuming the authority transfer. Keep mdbase connect open."
                        : "Confirm the authority transfer in your browser, then return to mdbase connect."
                    );
                    try {
                      const result = await window.mdbaseConnect.promoteMirrorAuthority(
                        mirror.replica_id
                      );
                      setEditing(false);
                      onNotice(
                        `${collection.display_name} now uses this computer as its authority at epoch `
                        + `${result.authority_epoch}. Applications need fresh access.`
                      );
                    } finally {
                      setPromotionStarting(false);
                    }
                  });
                }}
              >
                {promotion.button}
              </button>
            </div>
          </section>
        )}
        {activeReplicas.some((replica) => replica.id !== mirror?.replica_id) && (
          <section className="collection-editor-section">
            <div><strong>Other mirrors</strong><small>Mirrors connected from another installation or through the command line.</small></div>
            <div className="replica-list">{activeReplicas.filter((replica) => replica.id !== mirror?.replica_id).map((replica) => (
              <div key={replica.id}><span>{replica.name}</span><code>{replica.mode === "read_write" ? "two-way" : "receive-only"}</code><small>{replica.sync_status?.last_seen_at ? `Seen ${relativeTime(replica.sync_status.last_seen_at)}` : "Not synchronized yet"}</small><button className="quiet-action danger" disabled={busy} onClick={() => {
                if (!window.confirm(`Revoke ${replica.name}? Its local files will remain, but it will no longer synchronize.`)) return;
                void onAct(async () => {
                  await window.mdbaseConnect.revokeHostedReplica(replica.id);
                  onNotice(`${replica.name} was revoked.`);
                });
              }}>Revoke</button></div>
            ))}</div>
          </section>
        )}
        <div className="collection-danger-row">
          <small>Deleting a hosted collection permanently removes its hosted records. Local mirror files remain.</small>
          <button className="quiet-action danger" disabled={busy} onClick={() => {
            if (!window.confirm(`Permanently delete the hosted collection ${collection.display_name}? This cannot be undone.`)) return;
            void onAct(async () => {
              if (mirror) await window.mdbaseConnect.disconnectMirror(mirror.replica_id);
              await window.mdbaseConnect.deleteHostedCollection(collection.id);
              onNotice(`${collection.display_name} was deleted. Any local mirror files remain.`);
            });
          }}>Delete hosted collection</button>
        </div>
      </div>}
    </article>
  );
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
  const [collectionId, setCollectionId] = useState(
    available.some((collection) => collection.id === request.collection_hint)
      ? request.collection_hint!
      : available[0]?.id ?? ""
  );
  const [operations, setOperations] = useState(request.requested_operations);
  const selected = available.find((collection) => collection.id === collectionId);
  const setup = selected?.provisionable
    ? neededProvisions(request.requirements, request.provisions, selected)
    : [];
  const permissionGroups = useMemo(
    () => groupAuthorizationOperations(request.requested_operations),
    [request.requested_operations]
  );
  useEffect(() => {
    if (!available.some((collection) => collection.id === collectionId)) {
      setCollectionId(available[0]?.id ?? "");
    }
  }, [collectionId, available]);
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
      <div className="request-identity"><p className="eyebrow">Access request</p><h3>{request.application_name}</h3><code>{request.application_distribution === "portable" ? `Downloaded HTML file${request.application_project_url ? ` · ${host(request.application_project_url)}` : ""}` : host(request.application_homepage)}</code>{request.application_distribution === "portable" && <small className="portable-request-warning">Unverified file origin. Only allow it if you intentionally opened the file{request.user_code ? ` and it shows ${request.user_code}` : ""}.</small>}<small>Expires {relativeTime(request.expires_at)}</small>{request.requirements.contracts.length > 0 && <small>{scopeDescription(request.requirements.contracts)}</small>}</div>
      <div className="request-decision">
        <section className="request-section">
          <div><strong>Collection</strong><small>Choose where {request.application_name} can work.</small></div>
          <div className="request-section-content">
            <label><span>Collection</span><select value={collectionId} disabled={available.length === 0 || busy} onChange={(event) => setCollectionId(event.target.value)}>{available.length === 0 && <option value="">No compatible collection</option>}{available.map((collection) => <option key={collection.id} value={collection.id}>{collection.display_name} · {collection.kind === "hosted" ? "Hosted by mdbase" : "on this computer"}{collection.provisionable ? " · setup required" : ""}</option>)}</select></label>
            {available.length === 0 && <small>No available local or hosted collection supports all requested operations and contracts.</small>}
            {canCreateHosted && (creatingHosted ? (
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
          <div><strong>Permissions</strong><small>{request.requested_operations.length} specific actions across {permissionGroups.length} {permissionGroups.length === 1 ? "category" : "categories"}.</small></div>
          <RequestPermissionChoices groups={permissionGroups} selected={operations} onChange={setOperations} />
        </section>
        <NotificationAccess notifications={request.notifications} />
        <footer className="request-footer">
          <p>{selected
            ? `${request.application_name} will use ${selected.display_name}, ${selected.kind === "hosted" ? "hosted by mdbase" : "on this computer"}, until you revoke access.`
            : `Choose a compatible collection before allowing ${request.application_name}.`}</p>
          <div className="decision-actions">
            <button className="button secondary danger-text" disabled={busy} onClick={() => void onAct(async () => { await window.mdbaseConnect.denyAuthorization(request.id); onNotice(`${request.application_name} was denied.`); })}>Deny</button>
            <button className="button primary" disabled={busy || !selected || operations.length === 0} onClick={() => void onAct(async () => {
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
  function toggle(operation: string, checked: boolean) {
    onChange(checked
      ? [...selected, operation]
      : selected.filter((value) => value !== operation));
  }
  return (
    <details className="request-permission-review">
      <summary><span><strong>{selected.length} of {total} selected</strong><small>Review or narrow individual actions</small></span><b>Review</b></summary>
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
            <button className="button primary" disabled={busy || !changed || operations.length === 0} onClick={() => void onAct(async () => {
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

function PairingPanel() {
  const [serverUrl, setServerUrl] = useState("https://connect.mdbase.dev");
  const [connectorName, setConnectorName] = useState("This computer");
  const [pairing, setPairing] = useState<{ pairingId: string; verificationUri: string } | null>(null);
  const [pairError, setPairError] = useState("");
  const [starting, setStarting] = useState(false);
  const [completing, setCompleting] = useState(false);

  useEffect(() => {
    if (!pairing) return;
    const timer = window.setInterval(async () => {
      try {
        const result = await window.mdbaseConnect.pairingStatus(pairing.pairingId);
        if (result.status === "paired") {
          window.clearInterval(timer);
          setCompleting(true);
        }
      } catch (error) {
        setPairError(message(error));
        window.clearInterval(timer);
      }
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [pairing]);

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
        <div className="pairing-wait" role="status" aria-live="polite">
          <StatusDot state="connecting" />
          <div>
            <strong>{completing ? "Computer approved. Connecting securely…" : "Waiting for browser approval"}</strong>
            {completing ? <small>mdbase connect is restarting with the new secure connection.</small> : <code>{pairing.verificationUri}</code>}
          </div>
          {!completing && <button className="quiet-action" onClick={() => setPairing(null)}>Start again</button>}
        </div>
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

function NavButton({ route, current, label, count, attention, onSelect }: { route: Route; current: Route; label: string; count?: number; attention?: number; onSelect(route: Route): void }) {
  return <button className={`view-tab ${current === route ? "active" : ""}`} aria-current={current === route ? "page" : undefined} onClick={() => onSelect(route)}><span>{label}</span>{attention ? <b className="view-tab-count attention">{attention}</b> : count !== undefined ? <b className="view-tab-count">{count}</b> : null}</button>;
}

function SectionHeading({ title, note, count, children }: { title: string; note: string; count?: number; children?: React.ReactNode }) {
  return <div className="section-heading"><div><h2>{title}</h2><p>{note}</p></div><div className="heading-actions">{count !== undefined && <span className="count">{count}</span>}{children}</div></div>;
}

function Empty({ title, text, action, onAction }: { title: string; text: string; action?: string; onAction?(): void }) {
  return <div className="empty-state"><div className="empty-folder" aria-hidden="true"><span /></div><h3>{title}</h3><p>{text}</p>{action && onAction && <button className="text-action" onClick={onAction}>{action}</button>}</div>;
}

function StatusDot({ state }: { state: ConnectionDotState }) {
  return <span className={`status-dot ${state}`} aria-hidden="true" />;
}

function Brand() {
  return <div className="product-brand"><MdbaseMark /><strong>mdbase</strong><span className="product-brand-label">connect</span></div>;
}

function MdbaseMark() {
  return <svg className="product-brand-mark" viewBox={MDBASE_MARK_VIEW_BOX} aria-hidden="true" focusable="false">
    <g className="product-brand-mark-ink">
      {mdbaseMarkInkRects.map((rect) => <rect key={`${rect.x}-${rect.y}`} {...rect} />)}
    </g>
    <rect className="product-brand-mark-accent" {...mdbaseMarkAccentRect} />
  </svg>;
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

function neededProvisions(
  requirements: ApplicationRequirements,
  provisions: ApplicationProvisions | undefined,
  collection: Pick<AuthorizationCollection, "contracts">
): TypePackProvision[] {
  const missing = requirements.contracts.filter((requirement) => !hasContract(collection.contracts, requirement));
  return (provisions?.type_packs ?? []).filter((provision) =>
    provision.provides.some((provided) => missing.some((requirement) => sameContract(provided, requirement)))
  );
}

const MDBASE_03_OPERATIONS = new Set([
  "query",
  "list_views",
  "execute_view",
  "read_type",
  "create_type",
  "update_type"
]);

function hostedCollectionCompatible(
  request: PendingAuthorization,
  collection: HostedCollectionSummary
): boolean {
  if (
    request.requested_operations.some((operation) => MDBASE_03_OPERATIONS.has(operation))
    && !/^0\.3(?:\.|$)/.test(collection.spec_version)
  ) {
    return false;
  }
  return request.requirements.contracts.every((required) =>
    hasContract(collection.contracts, required)
    || request.provisions.type_packs.some((provision) =>
      provision.provides.some((provided) => sameContract(provided, required))
    )
  );
}

function mirrorState(mirror: DesktopMirrorSummary | undefined): {
  dot: ConnectionDotState;
  label: string;
} {
  if (!mirror) return { dot: "idle", label: "Not mirrored" };
  if (mirror.promotion) {
    return {
      dot: "connecting",
      label: authorityPromotionPhaseLabel(mirror.promotion.phase)
    };
  }
  if (mirror.syncing) return { dot: "connecting", label: "Synchronizing" };
  if (mirror.error || mirror.state === "offline") return { dot: "danger", label: "Mirror needs attention" };
  if (mirror.conflicts.length > 0) return { dot: "paused", label: "Conflicts need a decision" };
  if (mirror.local_issues.length > 0 || mirror.state === "attention") return { dot: "paused", label: "Local files need attention" };
  if (mirror.state === "changes_waiting" || mirror.pending > 0) return { dot: "connecting", label: "Changes waiting" };
  if (mirror.state === "not_initialized") return { dot: "idle", label: "Not synchronized yet" };
  return { dot: "connected", label: "Up to date" };
}

function authorityPromotionState(
  collection: HostedCollectionSummary,
  mirror: DesktopMirrorSummary | undefined,
  starting: boolean
): { enabled: boolean; title: string; detail: string; button: string } {
  if (!mirror) {
    return {
      enabled: false,
      title: "A two-way mirror is required",
      detail: "Create and synchronize a two-way mirror on this computer first.",
      button: "Move authority to this computer"
    };
  }
  if (starting && !mirror.promotion) {
    return {
      enabled: false,
      title: "Preparing authority transfer",
      detail: "Checking the folder before opening browser confirmation.",
      button: "Preparing transfer…"
    };
  }
  if (mirror.promotion) {
    const label = authorityPromotionPhaseLabel(mirror.promotion.phase);
    return {
      enabled: false,
      title: label,
      detail: mirror.promotion.phase === "awaiting_approval"
        ? "Approve the move in your browser. Hosted writes continue until approval."
        : "Keep mdbase connect open while the handoff finishes.",
      button: `${label}…`
    };
  }
  if (mirror.promotion_pending) {
    return {
      enabled: true,
      title: "Authority transfer ready to resume",
      detail: "The folder was already verified. Finish activating it as the source of truth.",
      button: "Resume authority move"
    };
  }
  if (mirror.mode !== "read_write") {
    return {
      enabled: false,
      title: "A two-way mirror is required",
      detail: "Receive-only folders cannot become authoritative. Recreate this mirror as two-way.",
      button: "Move authority to this computer"
    };
  }
  if (collection.authority_state !== "active") {
    return {
      enabled: false,
      title: "Authority transfer already in progress",
      detail: "Return to the browser confirmation or wait for the current request to expire.",
      button: "Move authority to this computer"
    };
  }
  if (mirror.syncing) {
    return {
      enabled: false,
      title: "Mirror is synchronizing",
      detail: "Authority can move after the current synchronization finishes.",
      button: "Move authority to this computer"
    };
  }
  if (
    mirror.error
    || mirror.state === "offline"
    || mirror.conflicts.length > 0
    || mirror.local_issues.length > 0
    || mirror.state === "attention"
  ) {
    return {
      enabled: false,
      title: "Mirror needs attention",
      detail: "Resolve mirror errors and file conflicts before moving authority.",
      button: "Move authority to this computer"
    };
  }
  if (mirror.state !== "up_to_date" || mirror.pending > 0) {
    return {
      enabled: false,
      title: "Synchronize this mirror first",
      detail: "The folder must match the hosted collection before it can become authoritative.",
      button: "Move authority to this computer"
    };
  }
  return {
    enabled: true,
    title: "Move authority to this computer",
    detail: "Browser confirmation will pause hosted writes, verify this folder, and revoke existing application access.",
    button: "Move authority to this computer"
  };
}

function authorityPromotionPhaseLabel(
  phase: NonNullable<DesktopMirrorSummary["promotion"]>["phase"]
): string {
  if (phase === "synchronizing") return "Synchronizing mirror";
  if (phase === "awaiting_approval") return "Waiting for browser approval";
  if (phase === "verifying") return "Verifying exact folder contents";
  if (phase === "registering") return "Registering local authority";
  if (phase === "registered" || phase === "activating") return "Activating local authority";
  if (phase === "resuming") return "Resuming authority transfer";
  return "Finishing authority transfer";
}

function hasContract(contracts: ContractRequirement[], required: ContractRequirement) { return contracts.some((contract) => sameContract(contract, required)); }
function sameContract(left: ContractRequirement, right: ContractRequirement) { return left.id === right.id && left.version === right.version; }
function provisionNames(provisions: TypePackProvision[]) {
  return provisions
    .map((provision) => provision.manifest.name ?? provision.manifest.id)
    .join(" and ");
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
