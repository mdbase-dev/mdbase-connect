import {
  ConnectManagementClient,
  ManagementApiError,
  type HostedCollection,
  type ManagementOverview
} from "@mdbase/connect-management";
import {
  authorizationOperationLabel,
  groupApplicationAccess,
  type ApplicationAccessGroup
} from "@mdbase/connect-ui/access";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { AccountManagement, DeletedAccount } from "./AccountManagement";
import { MdbaseMark } from "./Brand";
import { EditorRail } from "./EditorRail";
import {
  BracketsCurlyIcon as Braces,
  GearSixIcon as Settings,
  InfoIcon as Info,
  NotebookIcon as Notebook,
  PackageIcon as Package,
  PencilSimpleIcon as Pencil,
  PlusIcon as Plus,
  TrashIcon as Trash,
  WarningCircleIcon as Warning
} from "./icons";
import "./connect.css";

type ConnectView = "overview" | "storage" | "access" | "collections" | "applications" | "computers" | "account";
type Grant = ManagementOverview["grants"][number];

const serverUrl = new URLSearchParams(location.search).get("server")
  ?? import.meta.env.VITE_MDBASE_CONNECT_URL
  ?? "https://connect.mdbase.dev";
const management = new ConnectManagementClient(serverUrl);
const allOperations = [
  "describe", "changes", "read", "query", "list_views", "execute_view", "read_view_source", "validate",
  "create", "update", "delete", "rename", "create_view_source", "update_view_source", "delete_view_source",
  "read_type", "create_type", "update_type", "install_type_pack", "list_timers", "put_timer", "cancel_timer",
  "reconcile_timers"
];

export function ConnectApp() {
  const [accountDeleted, setAccountDeleted] = useState(location.pathname === "/connect/account-deleted");
  const [view, setView] = useState<ConnectView>(viewFromPath);
  const [data, setData] = useState<ManagementOverview>();
  const [sessions, setSessions] = useState<Awaited<ReturnType<typeof management.sessions>>["sessions"]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (accountDeleted) return;
    try {
      const next = await management.overview(signal);
      setData(next);
      setError("");
      if (next.authentication.provider !== "tailscale") {
        const sessionResult = await management.sessions(signal);
        setSessions(sessionResult.sessions);
      }
    } catch (reason) {
      if (signal?.aborted) return;
      if (reason instanceof ManagementApiError && reason.status === 401) {
        location.href = new URL("/login", management.baseUrl).href;
        return;
      }
      setError(errorMessage(reason));
    }
  }, [accountDeleted]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    const update = () => setView(viewFromPath());
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);

  function navigate(next: ConnectView, collectionId?: string) {
    const path = next === "overview" ? "/connect" : `/connect/${next}`;
    const url = new URL(location.href);
    url.pathname = path;
    if (collectionId) {
      url.searchParams.set("collection", collectionId);
      rememberCollection(collectionId);
    }
    history.pushState(null, "", `${url.pathname}${url.search}`);
    setView(next);
  }

  async function perform(id: string, action: () => Promise<void>) {
    setBusy(id);
    try {
      await action();
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy("");
    }
  }

  const collections = data ? collectionRows(data) : [];
  const requestedCollectionId = new URLSearchParams(location.search).get("collection");
  const rememberedCollectionId = readRememberedCollection();
  const selectedCollection = collections.find((collection) => collection.id === requestedCollectionId)
    ?? collections.find((collection) => collection.id === rememberedCollectionId)
    ?? (collections.length === 1 ? collections[0] : undefined);
  const selectedCollectionId = selectedCollection?.id;

  useEffect(() => {
    if (!data || accountDeleted) return;
    if (selectedCollectionId) {
      rememberCollection(selectedCollectionId);
      if (requestedCollectionId !== selectedCollectionId) {
        const url = new URL(location.href);
        url.searchParams.set("collection", selectedCollectionId);
        history.replaceState(null, "", `${url.pathname}${url.search}`);
      }
      return;
    }
    if (isCollectionView(view)) {
      const url = new URL(location.href);
      url.pathname = "/connect/collections";
      url.searchParams.delete("collection");
      history.replaceState(null, "", `${url.pathname}${url.search}`);
      setView("collections");
    }
  }, [accountDeleted, data, requestedCollectionId, selectedCollectionId, view]);

  if (accountDeleted) return <DeletedAccount client={management} />;
  if (!data) return <ConnectLoading error={error} />;

  const activeView = selectedCollection || !isCollectionView(view) ? view : "collections";
  const activeGrants = data.grants.filter((grant) => grant.revocation_status !== "revoked");
  const applications = groupApplicationAccess(activeGrants);
  const selectedGrants = selectedCollection
    ? activeGrants.filter((grant) => grant.collection_id === selectedCollection.id)
    : [];
  const selectedApplications = groupApplicationAccess(selectedGrants);
  const pendingRequest = data.pending_authorizations[0];
  const pendingCollection = pendingRequest?.collection_id
    ? collections.find((collection) => collection.id === pendingRequest.collection_id)
    : undefined;
  const editorLinks = editorSurfaceUrls(selectedCollection?.id);
  return <div className="connect-shell">
    <EditorRail
      collectionName={selectedCollection?.name ?? "Choose a collection"}
      surface="connect"
      notes={{ href: editorLinks.notes }}
      types={{ href: editorLinks.types }}
      settings={{ href: editorLinks.settings }}
      connectHref={connectViewUrl(activeView, selectedCollection?.id)}
      connectCount={data.pending_authorizations.length || undefined}
      onSwitch={() => navigate("collections", selectedCollection?.id)}
      footer={<>
        {selectedCollection && <p role="status"><span className={`status-dot ${selectedCollection.online ? "connected" : "reconnecting"}`} aria-hidden="true" /><span>{selectedCollection.online ? "Connected" : "Unavailable"}</span></p>}
        <button className="connect-rail-account" aria-label="Open account and sessions" onClick={() => navigate("account", selectedCollection?.id)}><span className="connect-avatar" aria-hidden="true">{initials(data.user.name)}</span><span><strong>{data.user.name}</strong><small>{identityLabel(data.user)}</small></span></button>
      </>}
    />
    <aside className="connect-nav" aria-label="Connect navigation">
      <header><strong>Connect</strong></header>
      <nav>
        {selectedCollection && <section className="connect-nav-group" aria-labelledby="current-collection-navigation">
          <p id="current-collection-navigation">This collection</p>
          <NavButton label="Overview" icon={<Info />} selected={activeView === "overview"} onClick={() => navigate("overview", selectedCollection.id)} />
          <NavButton label="Storage & sync" icon={<Notebook />} selected={activeView === "storage"} onClick={() => navigate("storage", selectedCollection.id)} />
          <NavButton label="App access" icon={<Package />} selected={activeView === "access"} onClick={() => navigate("access", selectedCollection.id)} />
        </section>}
        <section className="connect-nav-group" aria-labelledby="account-navigation">
          <p id="account-navigation">Account</p>
          <NavButton label="All collections" icon={<Notebook />} selected={activeView === "collections"} onClick={() => navigate("collections", selectedCollection?.id)} />
          <NavButton label="Applications" icon={<Package />} selected={activeView === "applications"} onClick={() => navigate("applications", selectedCollection?.id)} />
          <NavButton label="Computers" icon={<Braces />} selected={activeView === "computers"} onClick={() => navigate("computers", selectedCollection?.id)} />
          <NavButton label="Account & sessions" icon={<Settings />} selected={activeView === "account"} onClick={() => navigate("account", selectedCollection?.id)} />
        </section>
      </nav>
    </aside>
    <main className="connect-main">
      {error && <div className="connect-notice error" role="alert"><Warning aria-hidden="true" />{error}<button onClick={() => setError("")}>Dismiss</button></div>}
      {pendingRequest && <PendingRequestBanner request={pendingRequest} collectionName={pendingCollection?.name} count={data.pending_authorizations.length} />}
      {activeView === "overview" && (selectedCollection
        ? <CollectionOverview collection={selectedCollection} applications={selectedApplications} navigate={navigate} />
        : <Collections data={data} busy={busy} perform={perform} navigate={navigate} />)}
      {activeView === "storage" && selectedCollection && <Storage collection={selectedCollection} busy={busy} perform={perform} />}
      {activeView === "access" && selectedCollection && <CollectionAccess collection={selectedCollection} groups={selectedApplications} busy={busy} perform={perform} />}
      {activeView === "collections" && <Collections data={data} busy={busy} perform={perform} navigate={navigate} />}
      {activeView === "applications" && <Applications groups={applications} busy={busy} perform={perform} />}
      {activeView === "computers" && <Computers data={data} busy={busy} perform={perform} />}
      {activeView === "account" && <AccountManagement client={management} overview={data} sessions={sessions} onOverviewRefresh={refresh} onDeleted={() => setAccountDeleted(true)} />}
    </main>
  </div>;
}

function PendingRequestBanner({ request, collectionName, count }: {
  request: ManagementOverview["pending_authorizations"][number];
  collectionName?: string;
  count: number;
}) {
  const title = count === 1 ? `${request.application_name} is waiting` : `${count} access requests are waiting`;
  const detail = collectionName
    ? `Review ${request.application_name}’s request for ${collectionName}.`
    : `Review ${request.application_name}’s collection access request.`;
  return <a className="connect-pending-banner" href={new URL(`/authorize/${request.id}`, management.baseUrl).href}>
    <Warning aria-hidden="true" />
    <span><strong>{title}</strong><small>{detail}</small></span>
    <b>{count === 1 ? "Review request" : "Review next request"}</b>
  </a>;
}

function CollectionOverview({ collection, applications, navigate }: {
  collection: CollectionRow;
  applications: ApplicationAccessGroup<Grant>[];
  navigate(view: ConnectView, collectionId?: string): void;
}) {
  return <Page eyebrow="Current collection" title={collection.name} intro="Manage where this collection lives and which applications can use it.">
    <section>
      <SectionTitle title="Storage" action={<button onClick={() => navigate("storage", collection.id)}>Manage</button>} />
      <div className="connect-row connect-storage-summary"><div><strong>Main copy</strong><small>{collection.kind === "hosted" ? "Stored by mdbase" : `Stored on ${collection.detail}`}</small></div><span className={`connect-status ${collection.online ? "online" : "idle"}`}><i />{collection.status}</span></div>
    </section>
    <section>
      <SectionTitle title="Application access" count={applications.length} action={<button onClick={() => navigate("access", collection.id)}>Review all</button>} />
      {applications.map((application) => <div className="connect-row" key={application.applicationId}><div><strong>{application.applicationName}</strong><small>{host(application.grants[0].homepage)}</small></div><span>{permissionSummary(application.grants)}</span><button onClick={() => navigate("access", collection.id)}>Review</button></div>)}
      {applications.length === 0 && <Empty title="No connected applications" body="Applications appear after you approve access to this collection." />}
    </section>
    <section>
      <SectionTitle title="Connection" />
      <div className="connect-row"><div><strong>{collection.online ? "Connected" : "Unavailable"}</strong><small>{collection.online ? "The editor can reach this collection now." : "The editor cannot reach this collection."}</small></div><span className={`connect-status ${collection.online ? "online" : "idle"}`}><i />{collection.online ? "Connected" : "Unavailable"}</span></div>
    </section>
  </Page>;
}

function Storage({ collection, busy, perform }: {
  collection: CollectionRow;
  busy: string;
  perform(id: string, action: () => Promise<void>): Promise<void>;
}) {
  if (collection.kind === "hosted") {
    const replicas = collection.source.replicas.filter((replica) => replica.revocation_status !== "revoked");
    return <Page eyebrow={collection.name} title="Storage & sync" intro="Manage the main copy and its synced Markdown folders.">
      <section>
        <SectionTitle title="Main copy" />
        <HostedCollectionRow collection={collection.source} busy={busy} perform={perform} showReplicas={false} />
      </section>
      <section>
        <SectionTitle title="Synced folders" count={replicas.length} action={<a href={`mdbase-connect://mirror?collection=${encodeURIComponent(collection.source.id)}`}><Plus aria-hidden="true" />Sync a folder</a>} />
        {replicas.map((replica) => <div className="connect-row" key={replica.id}><div><strong>{replica.name}</strong><small>{replica.mode === "read_only" ? "Downloads only" : "Edits sync both ways"}</small></div><span>{replica.revocation_status === "revoking" ? "Disconnecting…" : replica.sync_status ? `Seen ${relativeTime(replica.sync_status.last_seen_at ?? collection.source.created_at)}` : "Waiting to sync"}</span><button className="danger" disabled={replica.revocation_status === "revoking" || busy === `replica-${replica.id}`} onClick={() => window.confirm(`Revoke ${replica.name}?`) && void perform(`replica-${replica.id}`, () => management.revokeReplica(replica.id))}>{replica.revocation_status === "revoking" ? "Disconnecting…" : "Disconnect"}</button></div>)}
        {replicas.length === 0 && <Empty title="No synced folders" body="Use the desktop app to keep an ordinary Markdown folder on a computer." />}
      </section>
    </Page>;
  }
  return <Page eyebrow={collection.name} title="Storage & sync" intro="This collection’s main copy stays in a folder on a connected computer.">
    <section>
      <SectionTitle title="Main copy" />
      <div className="connect-row"><div><strong>{collection.detail}</strong><small>The folder remains the authority for this collection.</small></div><span className={`connect-status ${collection.online ? "online" : "idle"}`}><i />{collection.status}</span><a href="mdbase-connect://open">Open desktop app</a></div>
    </section>
  </Page>;
}

function CollectionAccess({ collection, groups, busy, perform }: {
  collection: CollectionRow;
  groups: ApplicationAccessGroup<Grant>[];
  busy: string;
  perform(id: string, action: () => Promise<void>): Promise<void>;
}) {
  return <Page eyebrow={collection.name} title="Application access" intro="Review the exact actions each application can perform in this collection.">
    <section>
      <SectionTitle title="Connected applications" count={groups.length} />
      {groups.map((group) => <details className="connect-application" key={group.applicationId}>
        <summary><span><strong>{group.applicationName}</strong><small>{host(group.grants[0].homepage)}</small></span><b>Review</b></summary>
        <div className="connect-application-body">
          {group.grants.map((grant) => <GrantEditor key={grant.id} grant={grant} busy={busy} perform={perform} />)}
          <button className="danger connect-revoke-application" disabled={busy === `application-${group.applicationId}`} onClick={() => {
            if (!window.confirm(`Revoke ${group.applicationName} access to ${collection.name}?`)) return;
            void perform(`application-${group.applicationId}`, async () => {
              for (const grant of group.grants) await management.revokeGrant(grant.id);
            });
          }}>Revoke access</button>
        </div>
      </details>)}
      {groups.length === 0 && <Empty title="No connected applications" body="Applications appear here after you approve access to this collection." />}
    </section>
  </Page>;
}

function Collections({ data, busy, perform, navigate }: {
  data: ManagementOverview;
  busy: string;
  perform(id: string, action: () => Promise<void>): Promise<void>;
  navigate(view: ConnectView, collectionId?: string): void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("My collection");
  const rows = collectionRows(data);
  async function create(event: FormEvent) {
    event.preventDefault();
    const displayName = name.trim();
    if (!displayName) return;
    await perform("create-collection", () => management.createHostedCollection(displayName));
    setCreating(false);
    setName("My collection");
  }
  return <Page title="Collections" intro="Open a collection in the editor or manage where its main copy lives.">
    <section>
      <SectionTitle title="All collections" count={rows.length} action={data.hosted_collections_available !== false && <button onClick={() => setCreating(true)}><Plus aria-hidden="true" />New hosted collection</button>} />
      {creating && <form className="connect-inline-form" onSubmit={(event) => void create(event)}>
        <label><span>Collection name</span><input autoFocus maxLength={200} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <div><button type="button" onClick={() => setCreating(false)}>Cancel</button><button className="connect-primary-action" disabled={busy === "create-collection" || !name.trim()}>{busy === "create-collection" ? "Creating…" : "Create"}</button></div>
      </form>}
      {rows.map((collection) => collection.kind === "hosted"
        ? <HostedCollectionRow key={collection.id} collection={collection.source} busy={busy} perform={perform} onManage={() => navigate("overview", collection.id)} />
        : <CollectionSummary key={collection.id} collection={collection} onManage={() => navigate("overview", collection.id)} />)}
      {rows.length === 0 && <Empty title="No collections" body="Connect a computer or create a hosted collection to get started." />}
    </section>
  </Page>;
}

function HostedCollectionRow({ collection, busy, perform, onManage, showReplicas = true }: {
  collection: HostedCollection;
  busy: string;
  perform(id: string, action: () => Promise<void>): Promise<void>;
  onManage?: () => void;
  showReplicas?: boolean;
}) {
  const active = collection.authority_state === "active";
  const editorId = active ? collection.id : collection.transferred_collection_id;
  async function rename() {
    const name = window.prompt("Collection name", collection.display_name)?.trim();
    if (name && name !== collection.display_name) await perform(`collection-${collection.id}`, () => management.renameHostedCollection(collection.id, name));
  }
  async function remove() {
    if (window.confirm(`Delete ${collection.display_name} and all hosted Markdown? This cannot be undone.`)) {
      await perform(`collection-${collection.id}`, () => management.deleteHostedCollection(collection.id));
    }
  }
  const replicas = collection.replicas.filter((replica) => replica.revocation_status !== "revoked");
  return <div className="connect-row connect-collection-row">
    <div><strong>{collection.display_name}</strong><small>{active ? `Hosted by mdbase · ${replicas.length} synced ${replicas.length === 1 ? "folder" : "folders"}` : collection.authority_state === "transferring" ? "Moving to a computer" : "Main copy moved to a computer"}</small></div>
    <span className={`connect-status ${active ? "online" : "idle"}`}><i />{active ? "Hosted" : "Moved"}</span>
    <div className="connect-row-actions">
      {onManage && <button onClick={onManage}>Manage</button>}
      {editorId && <a href={editorCollectionUrl(editorId)}>Open</a>}
      {active && <a href={`mdbase-connect://mirror?collection=${encodeURIComponent(collection.id)}`}>Sync folder</a>}
      {active && <button disabled={busy === `collection-${collection.id}`} onClick={() => void rename()}><Pencil aria-hidden="true" />Rename</button>}
      <button className="danger" disabled={busy === `collection-${collection.id}`} onClick={() => void remove()}><Trash aria-hidden="true" />Delete</button>
    </div>
    {showReplicas && replicas.length > 0 && <details className="connect-row-detail"><summary>Synced folders</summary>{replicas.map((replica) => <div key={replica.id}>
      <span><strong>{replica.name}</strong><small>{replica.mode === "read_only" ? "Downloads only" : "Two-way sync"}</small></span>
      <button className="danger" disabled={replica.revocation_status === "revoking" || busy === `replica-${replica.id}`} onClick={() => window.confirm(`Revoke ${replica.name}?`) && void perform(`replica-${replica.id}`, () => management.revokeReplica(replica.id))}>{replica.revocation_status === "revoking" ? "Revoking…" : "Revoke"}</button>
    </div>)}</details>}
  </div>;
}

function Applications({ groups, busy, perform }: {
  groups: ApplicationAccessGroup<Grant>[];
  busy: string;
  perform(id: string, action: () => Promise<void>): Promise<void>;
}) {
  return <Page title="Applications" intro="Each application receives a separate grant for each collection. Your account session is never shared with it.">
    <section>
      <SectionTitle title="Application access" count={groups.length} />
      {groups.map((group) => <details className="connect-application" key={group.applicationId}>
        <summary><span><strong>{group.applicationName}</strong><small>{group.collectionCount} {group.collectionCount === 1 ? "collection" : "collections"}</small></span><b>Review</b></summary>
        <div className="connect-application-body">
          {group.grants.map((grant) => <GrantEditor key={grant.id} grant={grant} busy={busy} perform={perform} />)}
          <button className="danger connect-revoke-application" disabled={busy === `application-${group.applicationId}`} onClick={() => {
            if (!window.confirm(`Revoke all ${group.applicationName} access?`)) return;
            void perform(`application-${group.applicationId}`, async () => {
              for (const grant of group.grants) await management.revokeGrant(grant.id);
            });
          }}>Revoke application</button>
        </div>
      </details>)}
      {groups.length === 0 && <Empty title="No connected applications" body="Applications appear here after you approve their first collection request." />}
    </section>
  </Page>;
}

function GrantEditor({ grant, busy, perform }: {
  grant: Grant;
  busy: string;
  perform(id: string, action: () => Promise<void>): Promise<void>;
}) {
  if (grant.revocation_status === "revoking") {
    return <div className="connect-grant connect-row"><span><strong>{grant.collection_name}</strong><small>Local access is disabled. Waiting for the hosted authority to confirm revocation.</small></span><b>Revoking…</b></div>;
  }
  const ordered = [...allOperations.filter((operation) => grant.operations.includes(operation)), ...grant.operations.filter((operation) => !allOperations.includes(operation))];
  const [operations, setOperations] = useState(() => new Set(grant.operations));
  useEffect(() => setOperations(new Set(grant.operations)), [grant.operations]);
  const changed = ordered.some((operation) => operations.has(operation) !== grant.operations.includes(operation));
  return <details className="connect-grant">
    <summary><span><strong>{grant.collection_name}</strong><small>{grant.operations.length} permissions · {host(grant.homepage)}</small></span><b>Permissions</b></summary>
    <div className="connect-grant-body">
      <div className="connect-permissions">{ordered.map((operation) => <label key={operation}><input type="checkbox" checked={operations.has(operation)} onChange={() => setOperations((current) => {
        const next = new Set(current);
        if (next.has(operation)) next.delete(operation); else next.add(operation);
        return next;
      })} /><span>{authorizationOperationLabel(operation)}</span></label>)}</div>
      <div className="connect-grant-meta"><span>Scope</span><strong>{grant.scope.access === "full_collection" ? "Full collection" : `${grant.scope.contracts.length} contract types`}</strong><span>Origin</span><strong>{grant.application_origin}</strong></div>
      <div className="connect-row-actions"><button className="connect-primary-action" disabled={!changed || operations.size === 0 || busy === `grant-${grant.id}`} onClick={() => void perform(`grant-${grant.id}`, () => management.updateGrant(grant.id, ordered.filter((operation) => operations.has(operation))))}>Save narrower access</button><button className="danger" disabled={busy === `grant-${grant.id}`} onClick={() => window.confirm(`Revoke access to ${grant.collection_name}?`) && void perform(`grant-${grant.id}`, () => management.revokeGrant(grant.id))}>Revoke</button></div>
    </div>
  </details>;
}

function Computers({ data, busy, perform }: {
  data: ManagementOverview;
  busy: string;
  perform(id: string, action: () => Promise<void>): Promise<void>;
}) {
  return <Page title="Computers" intro="Computers make local collections available. Revoking one also invalidates grants routed through it.">
    <section>
      <SectionTitle title="Connected computers" count={data.connectors.length} />
      {data.connectors.map((connector) => {
        const online = connector.last_seen_at !== null && Date.now() - new Date(connector.last_seen_at).getTime() < 45_000;
        const collections = data.collections.filter((collection) => collection.connector_id === connector.id);
        return <div className="connect-row" key={connector.id}>
          <div><strong>{connector.name}</strong><small>{collections.length} {collections.length === 1 ? "collection" : "collections"} · {connector.last_seen_at ? `Seen ${relativeTime(connector.last_seen_at)}` : "Not connected yet"}</small></div>
          <span className={`connect-status ${online ? "online" : "idle"}`}><i />{online ? "Online" : "Offline"}</span>
          <div className="connect-row-actions"><button disabled={busy === `computer-${connector.id}`} onClick={() => {
            const name = window.prompt("Computer name", connector.name)?.trim();
            if (name && name !== connector.name) void perform(`computer-${connector.id}`, () => management.renameConnector(connector.id, name));
          }}><Pencil aria-hidden="true" />Rename</button><button className="danger" disabled={busy === `computer-${connector.id}`} onClick={() => window.confirm(`Revoke ${connector.name}?`) && void perform(`computer-${connector.id}`, () => management.revokeConnector(connector.id))}><Trash aria-hidden="true" />Revoke</button></div>
        </div>;
      })}
      {data.connectors.length === 0 && <Empty title="No computers connected" body="Open the mdbase Connect desktop app and choose Connect this computer." />}
    </section>
  </Page>;
}

interface CollectionRowBase {
  id: string;
  name: string;
  detail: string;
  status: string;
  online: boolean;
}

type CollectionRow =
  | CollectionRowBase & { kind: "local" }
  | CollectionRowBase & { kind: "hosted"; source: HostedCollection };

function collectionRows(data: ManagementOverview): CollectionRow[] {
  const local = data.collections.map((collection) => ({
    id: collection.id,
    name: collection.display_name,
    detail: collection.connector_name,
    status: collection.enabled ? "Available" : "Paused",
    online: collection.enabled,
    kind: "local" as const
  }));
  const hosted = data.hosted_collections.map((collection) => ({
    id: collection.authority_state === "transferred" && collection.transferred_collection_id ? collection.transferred_collection_id : collection.id,
    name: collection.display_name,
    detail: collection.authority_state === "active" ? "Hosted by mdbase" : "Main copy moved to a computer",
    status: collection.authority_state === "active" ? "Hosted" : "Moved",
    online: collection.authority_state === "active",
    kind: "hosted" as const,
    source: collection
  }));
  return [...hosted, ...local].sort((left, right) => left.name.localeCompare(right.name));
}

function CollectionSummary({ collection, onManage }: { collection: CollectionRow; onManage?: () => void }) {
  return <div className="connect-row"><div><strong>{collection.name}</strong><small>{collection.detail}</small></div><span className={`connect-status ${collection.online ? "online" : "idle"}`}><i />{collection.status}</span><div className="connect-row-actions">{onManage && <button onClick={onManage}>Manage</button>}<a href={editorCollectionUrl(collection.id)}>Open in editor</a></div></div>;
}

function Page({ eyebrow = "mdbase Connect", title, intro, children }: { eyebrow?: string; title: string; intro: string; children: ReactNode }) {
  return <div className="connect-page"><header><p>{eyebrow}</p><h1>{title}</h1><span>{intro}</span></header>{children}</div>;
}

function SectionTitle({ title, count, action }: { title: string; count?: number; action?: ReactNode }) {
  return <header className="connect-section-title"><div><h2>{title}</h2>{count !== undefined && <span>{count}</span>}</div>{action}</header>;
}

function NavButton({ label, icon, selected, onClick }: { label: string; icon: ReactNode; selected: boolean; onClick(): void }) {
  return <button className={selected ? "selected" : ""} aria-current={selected ? "page" : undefined} onClick={onClick}><span aria-hidden="true">{icon}</span><strong>{label}</strong></button>;
}

function Empty({ title, body }: { title: string; body: string }) {
  return <div className="connect-empty"><Info aria-hidden="true" /><div><strong>{title}</strong><p>{body}</p></div></div>;
}

function ConnectLoading({ error }: { error: string }) {
  return <div className="connect-loading"><MdbaseMark /><strong>{error ? "Connect is unavailable" : "Opening Connect"}</strong><p>{error || "Loading your account and collections…"}</p></div>;
}

function viewFromPath(): ConnectView {
  const segment = location.pathname.split("/")[2];
  return segment === "storage" || segment === "access" || segment === "collections" || segment === "applications" || segment === "computers" || segment === "account" ? segment : "overview";
}

function isCollectionView(view: ConnectView): boolean {
  return view === "overview" || view === "storage" || view === "access";
}

function collectionPreferenceKey(): string {
  const configuredServer = new URLSearchParams(location.search).get("server");
  let origin = new URL(management.baseUrl).origin;
  try {
    if (configuredServer) origin = new URL(configuredServer).origin;
  } catch {
    // The management client reports malformed server URLs elsewhere.
  }
  return `mdbase-connect:last-collection:${origin}`;
}

function readRememberedCollection(): string | null {
  try { return localStorage.getItem(collectionPreferenceKey()); } catch { return null; }
}

function rememberCollection(collectionId: string): void {
  try { localStorage.setItem(collectionPreferenceKey(), collectionId); } catch { /* Storage is optional. */ }
}

function permissionSummary(grants: ApplicationAccessGroup<Grant>["grants"]): string {
  const operations = new Set(grants.flatMap((grant) => grant.operations));
  const verbs = [
    operations.has("read") || operations.has("query") || operations.has("changes") ? "read" : "",
    operations.has("create") ? "create" : "",
    operations.has("update") || operations.has("rename") ? "update" : "",
    operations.has("delete") ? "delete" : ""
  ].filter(Boolean);
  const capabilities: string[] = [];
  if (verbs.length > 0) capabilities.push(`${joinWords(verbs)} records`);
  if (["create_type", "update_type", "install_type_pack", "create_view_source", "update_view_source", "delete_view_source"].some((operation) => operations.has(operation))) capabilities.push("manage types");
  if (["put_timer", "cancel_timer", "reconcile_timers"].some((operation) => operations.has(operation))) capabilities.push("manage timers");
  if (capabilities.length === 0) return `${operations.size} ${operations.size === 1 ? "permission" : "permissions"}`;
  const summary = capabilities.join("; ");
  return summary[0].toUpperCase() + summary.slice(1);
}

function joinWords(words: string[]): string {
  if (words.length < 2) return words[0] ?? "";
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(", ")}, and ${words.at(-1)}`;
}

function connectViewUrl(view: ConnectView, collectionId?: string): string {
  const url = new URL(view === "overview" ? "/connect" : `/connect/${view}`, location.origin);
  url.searchParams.set("server", new URL(management.baseUrl).origin);
  if (collectionId) url.searchParams.set("collection", collectionId);
  return `${url.pathname}${url.search}`;
}

function editorSurfaceUrls(collectionId?: string): { notes: string; types: string; settings: string } {
  const surface = (name?: "types" | "settings") => {
    const url = new URL("/", location.origin);
    url.searchParams.set("server", new URL(management.baseUrl).origin);
    if (collectionId) url.searchParams.set("collection", collectionId);
    if (name) url.searchParams.set("surface", name);
    return url.href;
  };
  return { notes: surface(), types: surface("types"), settings: surface("settings") };
}

function editorCollectionUrl(collectionId: string): string {
  const url = new URL("/", location.origin);
  url.searchParams.set("collection", collectionId);
  url.searchParams.set("server", new URL(management.baseUrl).origin);
  return url.href;
}

function errorMessage(value: unknown): string {
  const detail = value instanceof Error ? value.message : String(value);
  return /failed to fetch|networkerror|network request failed/i.test(detail)
    ? "Connect could not be reached. Check your connection and try again."
    : detail;
}

function initials(value: string): string {
  return value.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

function identityLabel(user: ManagementOverview["user"]): string {
  return user.login ? `@${user.login}` : user.email ?? "Identity unavailable";
}

function host(value: string): string {
  try { return new URL(value).host; } catch { return value; }
}

function relativeTime(value: string): string {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1_000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return format.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, "hour");
  return format.format(Math.round(hours / 24), "day");
}
