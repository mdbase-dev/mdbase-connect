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
import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { AccountManagement, DeletedAccount } from "./AccountManagement";
import { MdbaseMark } from "./Brand";
import {
  ConfirmAction,
  ConnectEmpty as Empty,
  ConnectPage as Page,
  ConnectSectionTitle as SectionTitle,
  InlineRename
} from "./ConnectPrimitives";
import { EditorRail } from "./EditorRail";
import {
  BracketsCurlyIcon as Braces,
  GearSixIcon as Settings,
  InfoIcon as Info,
  NotebookIcon as Notebook,
  PackageIcon as Package,
  PlusIcon as Plus,
  WarningCircleIcon as Warning
} from "./icons";
import "./connect.css";

type ConnectView = "overview" | "storage" | "access" | "collections" | "applications" | "computers" | "account";
type Grant = ManagementOverview["grants"][number];
type BusyOperations = ReadonlySet<string>;
type PerformOperation = (id: string, action: () => Promise<void>) => Promise<boolean>;

const serverUrl = new URLSearchParams(location.search).get("server")
  ?? import.meta.env.VITE_MDBASE_CONNECT_URL
  ?? "https://connect.mdbase.dev";
const management = new ConnectManagementClient(serverUrl);
const desktopReleaseUrl = "https://github.com/mdbase-dev/mdbase-connect/releases/latest";
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
  const [refreshError, setRefreshError] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const busyRef = useRef(new Set<string>());
  const refreshPromiseRef = useRef<Promise<void> | null>(null);

  const refresh = useCallback((signal?: AbortSignal): Promise<void> => {
    if (accountDeleted) return Promise.resolve();
    if (refreshPromiseRef.current) return refreshPromiseRef.current;
    const request = (async () => {
      try {
        const next = await management.overview(signal);
        setData(next);
        setRefreshError("");
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
        setRefreshError(errorMessage(reason));
      }
    })();
    refreshPromiseRef.current = request;
    void request.finally(() => {
      if (refreshPromiseRef.current === request) refreshPromiseRef.current = null;
    });
    return request;
  }, [accountDeleted]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 15_000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      controller.abort();
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    const update = () => setView(viewFromPath());
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);

  async function perform(id: string, action: () => Promise<void>): Promise<boolean> {
    if (busyRef.current.has(id)) return false;
    busyRef.current.add(id);
    setBusy(new Set(busyRef.current));
    setMutationError("");
    try {
      await action();
      await refresh();
      return true;
    } catch (reason) {
      setMutationError(errorMessage(reason));
      return false;
    } finally {
      busyRef.current.delete(id);
      setBusy(new Set(busyRef.current));
    }
  }

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
    setNavigationOpen(false);
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
  if (!data) return <ConnectLoading error={refreshError} />;

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
      mobileReturn={{ href: editorLinks.notes, label: "Back to editor" }}
      onSwitch={() => navigate("collections", selectedCollection?.id)}
      footer={<>
        {selectedCollection && <p role="status"><span className={`status-dot ${selectedCollection.available ? "connected" : "reconnecting"}`} aria-hidden="true" /><span>{selectedCollection.status}</span></p>}
        <RouteLink className="connect-rail-account" view="account" collectionId={selectedCollection?.id} navigate={navigate} ariaLabel="Open account and sessions"><span className="connect-avatar" aria-hidden="true">{initials(data.user.name)}</span><span><strong>{data.user.name}</strong><small>{identityLabel(data.user)}</small></span></RouteLink>
      </>}
    />
    <aside className="connect-nav" aria-label="mdbase connect navigation">
      <header><strong>mdbase connect</strong><button className="connect-mobile-nav-toggle" aria-expanded={navigationOpen} aria-controls="connect-section-navigation" onClick={() => setNavigationOpen((open) => !open)}><span>{viewLabel(activeView)}</span><small>{navigationOpen ? "Close menu" : "Open menu"}</small></button></header>
      <nav id="connect-section-navigation" className={navigationOpen ? "open" : ""}>
        {selectedCollection && <section className="connect-nav-group" aria-labelledby="current-collection-navigation">
          <p id="current-collection-navigation">{selectedCollection.name}</p>
          <NavLink label="Overview" icon={<Info />} selected={activeView === "overview"} view="overview" collectionId={selectedCollection.id} navigate={navigate} />
          <NavLink label="Storage & sync" icon={<Notebook />} selected={activeView === "storage"} view="storage" collectionId={selectedCollection.id} navigate={navigate} />
          <NavLink label="App access" icon={<Package />} selected={activeView === "access"} view="access" collectionId={selectedCollection.id} navigate={navigate} />
        </section>}
        <section className="connect-nav-group" aria-labelledby="account-navigation">
          <p id="account-navigation">Account</p>
          <NavLink label="All collections" icon={<Notebook />} selected={activeView === "collections"} view="collections" collectionId={selectedCollection?.id} navigate={navigate} />
          <NavLink label="Applications" icon={<Package />} selected={activeView === "applications"} view="applications" collectionId={selectedCollection?.id} navigate={navigate} />
          <NavLink label="Computers" icon={<Braces />} selected={activeView === "computers"} view="computers" collectionId={selectedCollection?.id} navigate={navigate} />
          <NavLink label="Account & sessions" icon={<Settings />} selected={activeView === "account"} view="account" collectionId={selectedCollection?.id} navigate={navigate} />
        </section>
      </nav>
    </aside>
    <main className="connect-main">
      {(mutationError || refreshError) && <div className="connect-notice error" role="alert"><Warning aria-hidden="true" />{mutationError || refreshError}<button onClick={() => mutationError ? setMutationError("") : setRefreshError("")}>Dismiss</button></div>}
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
  return <Page title={collection.name} intro="Manage where this collection lives and which applications can use it.">
    <section>
      <SectionTitle title="Storage" action={<RouteLink view="storage" collectionId={collection.id} navigate={navigate}>Manage</RouteLink>} />
      <div className="connect-row connect-storage-summary"><div><strong>Main copy</strong><small>{collection.kind === "hosted" ? "Stored by mdbase" : `Stored on ${collection.detail}`}</small></div><span className={`connect-status ${collection.available ? "online" : "idle"}`}><i />{collection.status}</span></div>
    </section>
    <section>
      <SectionTitle title="Application access" count={applications.length} action={<RouteLink view="access" collectionId={collection.id} navigate={navigate}>Review all</RouteLink>} />
      {applications.map((application) => <div className="connect-row" key={application.applicationId}><div><strong>{application.applicationName}</strong><small>{host(application.grants[0].homepage)}</small></div><span>{permissionSummary(application.grants)}</span><RouteLink view="access" collectionId={collection.id} navigate={navigate}>Review</RouteLink></div>)}
      {applications.length === 0 && <Empty title="No connected applications" body="Applications appear after you approve access to this collection." />}
    </section>
    <section>
      <SectionTitle title="Connection" />
      <div className="connect-row"><div><strong>{collection.status}</strong><small>{connectionDescription(collection)}</small></div><span className={`connect-status ${collection.available ? "online" : "idle"}`}><i />{collection.status}</span></div>
    </section>
  </Page>;
}

function Storage({ collection, busy, perform }: {
  collection: CollectionRow;
  busy: BusyOperations;
  perform: PerformOperation;
}) {
  if (collection.kind === "hosted") {
    const replicas = collection.source.replicas.filter((replica) => replica.revocation_status !== "revoked");
    return <Page title="Storage & sync" intro={`Manage the main copy of ${collection.name} and its synced Markdown folders.`}>
      <section>
        <SectionTitle title="Main copy" />
        <HostedCollectionRow collection={collection.source} busy={busy} perform={perform} showReplicas={false} />
      </section>
      <section>
        <SectionTitle title="Synced folders" count={replicas.length} action={<a href={`mdbase-connect://mirror?collection=${encodeURIComponent(collection.source.id)}`}><Plus aria-hidden="true" />Sync a folder</a>} />
        {replicas.map((replica) => <div className="connect-row" key={replica.id}><div><strong>{replica.name}</strong><small>{replica.mode === "read_only" ? "Downloads only" : "Edits sync both ways"}</small></div><span>{replica.revocation_status === "revoking" ? "Disconnecting…" : replica.sync_status ? `Seen ${relativeTime(replica.sync_status.last_seen_at ?? collection.source.created_at)}` : "Waiting to sync"}</span><ConfirmAction className="danger" label={replica.revocation_status === "revoking" ? "Disconnecting…" : "Disconnect"} question={`Disconnect ${replica.name}?`} confirmLabel="Disconnect" busy={replica.revocation_status === "revoking" || busy.has(`replica-${replica.id}`)} onConfirm={() => void perform(`replica-${replica.id}`, () => management.revokeReplica(replica.id))} /></div>)}
        {replicas.length === 0 && <Empty title="No synced folders" body="Use the desktop app to keep an ordinary Markdown folder on a computer." />}
        <DesktopRecoveryHelp action="sync a folder" />
      </section>
    </Page>;
  }
  return <Page title="Storage & sync" intro={`${collection.name} keeps its main copy in a folder on a connected computer.`}>
    <section>
      <SectionTitle title="Main copy" />
      <div className="connect-row"><div><strong>{collection.detail}</strong><small>The folder remains the authority for this collection.</small></div><span className={`connect-status ${collection.available ? "online" : "idle"}`}><i />{collection.status}</span><a href="mdbase-connect://open">Open desktop app</a></div>
      <DesktopRecoveryHelp action="open this collection" />
    </section>
  </Page>;
}

function CollectionAccess({ collection, groups, busy, perform }: {
  collection: CollectionRow;
  groups: ApplicationAccessGroup<Grant>[];
  busy: BusyOperations;
  perform: PerformOperation;
}) {
  return <Page title="Application access" intro={`Review the exact actions each application can perform in ${collection.name}.`}>
    <section>
      <SectionTitle title="Connected applications" count={groups.length} />
      {groups.map((group) => <details className="connect-application" key={group.applicationId}>
        <summary><span><strong>{group.applicationName}</strong><small>{host(group.grants[0].homepage)}</small></span><b>Review</b></summary>
        <div className="connect-application-body">
          {group.grants.map((grant) => <GrantEditor key={grant.id} grant={grant} busy={busy} perform={perform} />)}
          <ConfirmAction className="danger connect-revoke-application" label="Revoke access" question={`Revoke ${group.applicationName} access to ${collection.name}?`} confirmLabel="Revoke access" busy={busy.has(`application-${group.applicationId}`)} onConfirm={() => {
            void perform(`application-${group.applicationId}`, async () => {
              for (const grant of group.grants) await management.revokeGrant(grant.id);
            });
          }} />
        </div>
      </details>)}
      {groups.length === 0 && <Empty title="No connected applications" body="Applications appear here after you approve access to this collection." />}
    </section>
  </Page>;
}

function Collections({ data, busy, perform, navigate }: {
  data: ManagementOverview;
  busy: BusyOperations;
  perform: PerformOperation;
  navigate(view: ConnectView, collectionId?: string): void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("My collection");
  const rows = collectionRows(data);
  async function create(event: FormEvent) {
    event.preventDefault();
    const displayName = name.trim();
    if (!displayName) return;
    const created = await perform("create-collection", () => management.createHostedCollection(displayName));
    if (created) {
      setCreating(false);
      setName("My collection");
    }
  }
  return <Page title="Collections" intro="Open a collection in the editor or manage where its main copy lives.">
    <section>
      <SectionTitle title="All collections" count={rows.length} action={data.hosted_collections_available !== false && <button onClick={() => setCreating(true)}><Plus aria-hidden="true" />New hosted collection</button>} />
      {creating && <form className="connect-inline-form" onSubmit={(event) => void create(event)}>
        <label><span>Collection name</span><input autoFocus maxLength={200} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <div><button type="button" onClick={() => setCreating(false)}>Cancel</button><button className="connect-primary-action" disabled={busy.has("create-collection") || !name.trim()}>{busy.has("create-collection") ? "Creating…" : "Create"}</button></div>
      </form>}
      {rows.map((collection) => collection.kind === "hosted"
        ? <HostedCollectionRow key={collection.id} collection={collection.source} busy={busy} perform={perform} manage={{ collectionId: collection.id, navigate }} />
        : <CollectionSummary key={collection.id} collection={collection} navigate={navigate} />)}
      {rows.length === 0 && <Empty title="No collections" body="Connect a computer or create a hosted collection to get started." />}
      {rows.some((collection) => collection.kind === "hosted" && collection.source.authority_state === "active") && <DesktopRecoveryHelp action="sync a folder" />}
    </section>
  </Page>;
}

function HostedCollectionRow({ collection, busy, perform, manage, showReplicas = true }: {
  collection: HostedCollection;
  busy: BusyOperations;
  perform: PerformOperation;
  manage?: { collectionId: string; navigate(view: ConnectView, collectionId?: string): void };
  showReplicas?: boolean;
}) {
  const active = collection.authority_state === "active";
  const editorId = active ? collection.id : collection.transferred_collection_id;
  const replicas = collection.replicas.filter((replica) => replica.revocation_status !== "revoked");
  return <div className="connect-row connect-collection-row">
    <div><strong>{collection.display_name}</strong><small>{active ? `Hosted by mdbase · ${replicas.length} synced ${replicas.length === 1 ? "folder" : "folders"}` : collection.authority_state === "transferring" ? "Moving to a computer" : "Main copy moved to a computer"}</small></div>
    <span className={`connect-status ${active ? "online" : "idle"}`}><i />{active ? "Hosted" : "Moved"}</span>
    <div className="connect-row-actions">
      {manage && <RouteLink view="overview" collectionId={manage.collectionId} navigate={manage.navigate}>Manage</RouteLink>}
      {editorId && <a href={editorCollectionUrl(editorId)}>Open</a>}
      {active && <a href={`mdbase-connect://mirror?collection=${encodeURIComponent(collection.id)}`}>Sync folder</a>}
      {active && <InlineRename value={collection.display_name} inputLabel={`Rename ${collection.display_name}`} busy={busy.has(`collection-${collection.id}`)} onSubmit={(name) => perform(`collection-${collection.id}`, () => management.renameHostedCollection(collection.id, name))} />}
      <ConfirmAction className="danger" label="Delete" question={`Delete ${collection.display_name} and all of its hosted data? This cannot be undone.`} confirmLabel="Delete permanently" busy={busy.has(`collection-${collection.id}`)} onConfirm={() => void perform(`collection-${collection.id}`, () => management.deleteHostedCollection(collection.id))} />
    </div>
    {showReplicas && replicas.length > 0 && <details className="connect-row-detail"><summary>Synced folders</summary>{replicas.map((replica) => <div key={replica.id}>
      <span><strong>{replica.name}</strong><small>{replica.mode === "read_only" ? "Downloads only" : "Two-way sync"}</small></span>
      <ConfirmAction className="danger" label={replica.revocation_status === "revoking" ? "Revoking…" : "Revoke"} question={`Revoke ${replica.name}?`} confirmLabel="Revoke" busy={replica.revocation_status === "revoking" || busy.has(`replica-${replica.id}`)} onConfirm={() => void perform(`replica-${replica.id}`, () => management.revokeReplica(replica.id))} />
    </div>)}</details>}
  </div>;
}

function Applications({ groups, busy, perform }: {
  groups: ApplicationAccessGroup<Grant>[];
  busy: BusyOperations;
  perform: PerformOperation;
}) {
  return <Page title="Applications" intro="Each application receives a separate grant for each collection. Your account session is never shared with it.">
    <section>
      <SectionTitle title="Application access" count={groups.length} />
      {groups.map((group) => <details className="connect-application" key={group.applicationId}>
        <summary><span><strong>{group.applicationName}</strong><small>{group.collectionCount} {group.collectionCount === 1 ? "collection" : "collections"}</small></span><b>Review</b></summary>
        <div className="connect-application-body">
          {group.grants.map((grant) => <GrantEditor key={grant.id} grant={grant} busy={busy} perform={perform} />)}
          <ConfirmAction className="danger connect-revoke-application" label="Revoke application" question={`Revoke all ${group.applicationName} access?`} confirmLabel="Revoke application" busy={busy.has(`application-${group.applicationId}`)} onConfirm={() => {
            void perform(`application-${group.applicationId}`, async () => {
              for (const grant of group.grants) await management.revokeGrant(grant.id);
            });
          }} />
        </div>
      </details>)}
      {groups.length === 0 && <Empty title="No connected applications" body="Applications appear here after you approve their first collection request." />}
    </section>
  </Page>;
}

function GrantEditor({ grant, busy, perform }: {
  grant: Grant;
  busy: BusyOperations;
  perform: PerformOperation;
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
      <div className="connect-row-actions"><button className="connect-primary-action" disabled={!changed || operations.size === 0 || busy.has(`grant-${grant.id}`)} onClick={() => void perform(`grant-${grant.id}`, () => management.updateGrant(grant.id, ordered.filter((operation) => operations.has(operation))))}>Save narrower access</button><ConfirmAction className="danger" label="Revoke" question={`Revoke access to ${grant.collection_name}?`} confirmLabel="Revoke" busy={busy.has(`grant-${grant.id}`)} onConfirm={() => void perform(`grant-${grant.id}`, () => management.revokeGrant(grant.id))} /></div>
    </div>
  </details>;
}

function Computers({ data, busy, perform }: {
  data: ManagementOverview;
  busy: BusyOperations;
  perform: PerformOperation;
}) {
  return <Page title="Computers" intro="Computers make local collections available. Revoking one also invalidates grants routed through it.">
    <section>
      <SectionTitle title="Connected computers" count={data.connectors.length} />
      {data.connectors.map((connector) => {
        const online = isConnectorOnline(connector.last_seen_at);
        const collections = data.collections.filter((collection) => collection.connector_id === connector.id);
        return <div className="connect-row" key={connector.id}>
          <div><strong>{connector.name}</strong><small>{collections.length} {collections.length === 1 ? "collection" : "collections"} · {connector.last_seen_at ? `Seen ${relativeTime(connector.last_seen_at)}` : "Not connected yet"}</small></div>
          <span className={`connect-status ${online ? "online" : "idle"}`}><i />{online ? "Online" : "Offline"}</span>
          <div className="connect-row-actions"><InlineRename value={connector.name} inputLabel={`Rename ${connector.name}`} busy={busy.has(`computer-${connector.id}`)} onSubmit={(name) => perform(`computer-${connector.id}`, () => management.renameConnector(connector.id, name))} /><ConfirmAction className="danger" label="Revoke" question={`Revoke ${connector.name} and the application grants routed through it?`} confirmLabel="Revoke computer" busy={busy.has(`computer-${connector.id}`)} onConfirm={() => void perform(`computer-${connector.id}`, () => management.revokeConnector(connector.id))} /></div>
        </div>;
      })}
      {data.connectors.length === 0 && <Empty title="No computers connected" body="Open the mdbase connect desktop app and choose Connect this computer." action={<span className="connect-empty-actions"><a href="mdbase-connect://open">Open mdbase connect</a><a href={desktopReleaseUrl} target="_blank" rel="noreferrer">Install the latest release</a></span>} />}
    </section>
  </Page>;
}

interface CollectionRowBase {
  id: string;
  name: string;
  detail: string;
  status: string;
  available: boolean;
}

type CollectionRow =
  | CollectionRowBase & { kind: "local" }
  | CollectionRowBase & { kind: "hosted"; source: HostedCollection };

function collectionRows(data: ManagementOverview): CollectionRow[] {
  const connectors = new Map(data.connectors.map((connector) => [connector.id, connector]));
  const local = data.collections.map((collection) => {
    const online = isConnectorOnline(connectors.get(collection.connector_id)?.last_seen_at ?? null);
    return {
      id: collection.id,
      name: collection.display_name,
      detail: collection.connector_name,
      status: !collection.enabled ? "Paused" : online ? "Connected" : "Offline",
      available: collection.enabled && online,
      kind: "local" as const
    };
  });
  const hosted = data.hosted_collections.map((collection) => ({
    id: collection.authority_state === "transferred" && collection.transferred_collection_id ? collection.transferred_collection_id : collection.id,
    name: collection.display_name,
    detail: collection.authority_state === "active" ? "Hosted by mdbase" : "Main copy moved to a computer",
    status: collection.authority_state === "active" ? "Hosted" : "Moved",
    available: collection.authority_state === "active",
    kind: "hosted" as const,
    source: collection
  }));
  return [...hosted, ...local].sort((left, right) => left.name.localeCompare(right.name));
}

function CollectionSummary({ collection, navigate }: { collection: CollectionRow; navigate(view: ConnectView, collectionId?: string): void }) {
  return <div className="connect-row"><div><strong>{collection.name}</strong><small>{collection.detail}</small></div><span className={`connect-status ${collection.available ? "online" : "idle"}`}><i />{collection.status}</span><div className="connect-row-actions"><RouteLink view="overview" collectionId={collection.id} navigate={navigate}>Manage</RouteLink><a href={editorCollectionUrl(collection.id)}>Open in editor</a></div></div>;
}

function connectionDescription(collection: CollectionRow): string {
  if (collection.kind === "hosted") {
    return collection.available
      ? "The hosted collection is available to the editor."
      : "The main copy has moved away from hosted storage.";
  }
  if (collection.status === "Paused") return "Access to this collection is paused on its computer.";
  return collection.available
    ? `The editor can reach this collection through ${collection.detail}.`
    : `Open mdbase connect on ${collection.detail} to make this collection available.`;
}

function isConnectorOnline(lastSeenAt: string | null): boolean {
  return lastSeenAt !== null && Date.now() - new Date(lastSeenAt).getTime() < 45_000;
}

function NavLink({ label, icon, selected, view, collectionId, navigate }: {
  label: string;
  icon: ReactNode;
  selected: boolean;
  view: ConnectView;
  collectionId?: string;
  navigate(view: ConnectView, collectionId?: string): void;
}) {
  return <RouteLink className={selected ? "selected" : ""} ariaCurrent={selected ? "page" : undefined} view={view} collectionId={collectionId} navigate={navigate}><span aria-hidden="true">{icon}</span><strong>{label}</strong></RouteLink>;
}

function RouteLink({ view, collectionId, navigate, children, className = "", ariaLabel, ariaCurrent }: {
  view: ConnectView;
  collectionId?: string;
  navigate(view: ConnectView, collectionId?: string): void;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
  ariaCurrent?: "page";
}) {
  function activate(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(view, collectionId);
  }
  return <a className={className} href={connectViewUrl(view, collectionId)} aria-label={ariaLabel} aria-current={ariaCurrent} onClick={activate}>{children}</a>;
}

function ConnectLoading({ error }: { error: string }) {
  return <div className="connect-loading"><MdbaseMark /><strong>{error ? "mdbase connect is unavailable" : "Opening mdbase connect"}</strong><p>{error || "Loading your account and collections…"}</p></div>;
}

function DesktopRecoveryHelp({ action }: { action: string }) {
  return <p className="connect-desktop-help">If the desktop app does not open when you {action}, <a href={desktopReleaseUrl} target="_blank" rel="noreferrer">install the latest release</a> and try again.</p>;
}

function viewFromPath(): ConnectView {
  const segment = location.pathname.split("/")[2];
  return segment === "storage" || segment === "access" || segment === "collections" || segment === "applications" || segment === "computers" || segment === "account" ? segment : "overview";
}

function isCollectionView(view: ConnectView): boolean {
  return view === "overview" || view === "storage" || view === "access";
}

function viewLabel(view: ConnectView): string {
  if (view === "overview") return "Overview";
  if (view === "storage") return "Storage & sync";
  if (view === "access") return "App access";
  if (view === "collections") return "All collections";
  if (view === "applications") return "Applications";
  if (view === "computers") return "Computers";
  return "Account & sessions";
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
    ? "mdbase connect could not be reached. Check your connection and try again."
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
