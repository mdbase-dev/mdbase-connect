import {
  authorizationOperationLabel,
  groupApplicationAccess,
  type ApplicationAccessGroup
} from "@mdbase/connect-ui/access";
import React, { useEffect, useState } from "react";
import { AccountView } from "./account-view";
import {
  api,
  ApiError,
  type DashboardData,
  type HostedCollection
} from "./api";
import { ApprovalForm, RequestIdentity } from "./authorization-view";
import {
  allOperations,
  editorUrl,
  host,
  identityLabel,
  message,
  pluralLabel,
  relativeTime,
  scopeDescription
} from "./portal-model";
import {
  Empty,
  Loading,
  MobileProductBar,
  ProductSidebar,
  SectionHeading
} from "./portal-ui";

export type PortalView = "overview" | "requests" | "hosted" | "permissions" | "computers" | "account";

const routeCopy: Record<Exclude<PortalView, "account">, { eyebrow: string; title: string; lede: string }> = {
  overview: {
    eyebrow: "Your account",
    title: "Your connections.",
    lede: "Hosted data, application access, and connected computers in one place."
  },
  requests: {
    eyebrow: "Application requests",
    title: "Review access requests.",
    lede: "Approve the collection and exact actions an application can use."
  },
  hosted: {
    eyebrow: "Hosted authority",
    title: "Collections hosted by mdbase.",
    lede: "Manage always-available Markdown collections and their local mirrors."
  },
  permissions: {
    eyebrow: "Application access",
    title: "Decide what apps can do.",
    lede: "Review, narrow, or revoke access without changing the underlying collection."
  },
  computers: {
    eyebrow: "Remote connection",
    title: "Your connected computers.",
    lede: "See which computers are available and revoke connections you no longer use."
  }
};

export function Dashboard({ view = "overview", onNavigate }: {
  view?: PortalView;
  onNavigate(path: string): void;
}) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");
  const [navigationOpen, setNavigationOpen] = useState(false);

  async function refresh() {
    try {
      setData(await api<DashboardData>("/v1/me"));
      setError("");
    } catch (refreshError) {
      if (refreshError instanceof ApiError && refreshError.status === 401) {
        location.href = `/login?return_to=${encodeURIComponent(location.href)}`;
      } else setError(message(refreshError));
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!navigationOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNavigationOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [navigationOpen]);

  useEffect(() => {
    const label = view === "account" ? "Account" : routeCopy[view].title.replace(/\.$/, "");
    document.title = `${label} · mdbase connect`;
  }, [view]);

  if (!data) return <Loading error={error} />;
  const activeGrants = data.grants.filter((grant) => !grant.revoked_at);
  const applicationAccess = groupApplicationAccess(activeGrants);
  const sidebarItems = [
    { id: "overview", label: "Overview", href: "/" },
    { id: "requests", label: "Requests", href: "/requests", count: data.pending_authorizations.length, attention: data.pending_authorizations.length > 0 },
    { id: "hosted", label: "Hosted collections", href: "/hosted-collections", count: data.hosted_collections.length },
    { id: "permissions", label: "App access", href: "/app-access", count: applicationAccess.length },
    { id: "computers", label: "Computers", href: "/computers", count: data.connectors.length }
  ];
  const navigate = (_id: string, href: string) => {
    setNavigationOpen(false);
    onNavigate(href);
  };
  const copy = view === "account" ? null : routeCopy[view];

  return (
    <div className={`account-shell product-shell ${navigationOpen ? "navigation-open" : ""}`}>
      <ProductSidebar
        items={sidebarItems}
        active={view}
        account={data.user.name}
        identity={identityLabel(data.user)}
        editorHref={editorUrl()}
        onNavigate={navigate}
      />
      <button className="product-sidebar-backdrop" aria-label="Close navigation" onClick={() => setNavigationOpen(false)} />
      <div className="product-canvas portal-canvas">
        <MobileProductBar open={navigationOpen} onOpen={() => setNavigationOpen(true)} />
        {view === "account" ? <AccountView dashboard={data} /> : <main className="account-main portal-route-main">
          <header><p className="eyebrow">{copy!.eyebrow}</p><h1>{copy!.title}</h1><p>{copy!.lede}</p></header>
          {error && <div className="message error" role="alert">{error}</div>}
          {view === "overview" && <OverviewPage data={data} applicationCount={applicationAccess.length} onNavigate={onNavigate} />}
          {view === "requests" && <RequestsPage data={data} onChanged={refresh} />}
          {view === "hosted" && <section><HostedCollections collections={data.hosted_collections} canCreate={data.hosted_collections_available !== false} onChanged={refresh} onError={setError} /></section>}
          {view === "permissions" && <ApplicationAccessPage data={data} groups={applicationAccess} onChanged={refresh} onError={setError} />}
          {view === "computers" && <ComputersPage data={data} onChanged={refresh} onError={setError} />}
        </main>}
      </div>
    </div>
  );
}

function OverviewPage({ data, applicationCount, onNavigate }: {
  data: DashboardData;
  applicationCount: number;
  onNavigate(path: string): void;
}) {
  const onlineComputers = data.connectors.filter((connector) => connector.last_seen_at !== null
    && Date.now() - new Date(connector.last_seen_at).getTime() < 45_000).length;
  return <section>
    <SectionHeading title="At a glance" note="Open a page to manage its details." />
    <div className="portal-overview-list">
      <OverviewRow href="/requests" label="Requests" value={String(data.pending_authorizations.length)} detail={data.pending_authorizations.length ? pluralLabel(data.pending_authorizations.length, "request waiting", "requests waiting") : "No requests waiting"} attention={data.pending_authorizations.length > 0} onNavigate={onNavigate} />
      <OverviewRow href="/hosted-collections" label="Hosted collections" value={String(data.hosted_collections.length)} detail={data.hosted_collections.length ? "Authoritative on mdbase" : "No hosted collections"} onNavigate={onNavigate} />
      <OverviewRow href="/app-access" label="App access" value={String(applicationCount)} detail={pluralLabel(applicationCount, "connected application", "connected applications")} onNavigate={onNavigate} />
      <OverviewRow href="/computers" label="Computers" value={String(data.connectors.length)} detail={`${onlineComputers} online`} onNavigate={onNavigate} />
    </div>
  </section>;
}

function OverviewRow({ href, label, value, detail, attention = false, onNavigate }: {
  href: string;
  label: string;
  value: string;
  detail: string;
  attention?: boolean;
  onNavigate(path: string): void;
}) {
  return <a className="portal-overview-row" href={href} onClick={(event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onNavigate(href);
  }}><div><strong>{label}</strong><small>{detail}</small></div><span className={attention ? "attention" : ""}>{value}</span><b>Open</b></a>;
}

function RequestsPage({ data, onChanged }: { data: DashboardData; onChanged(): Promise<void> }) {
  return <section aria-label="Access requests" className={data.pending_authorizations.length ? "attention-section" : ""}>
    <SectionHeading title="Waiting for approval" note="Requests expire automatically if you do nothing." count={data.pending_authorizations.length} />
    {data.pending_authorizations.length === 0 ? <Empty title="No access requests" text="New application requests will appear here for an explicit decision." /> : <div className="request-list">{data.pending_authorizations.map((request) => (
      <article className="request-row" key={request.id}>
        <RequestIdentity request={request} />
        <ApprovalForm
          request={request}
          canCreateHosted={data.hosted_collections_available !== false}
          collections={[
            ...(request.available_collections ?? []),
            ...data.hosted_collections
              .filter((collection) => collection.authority_state === "active")
              .map((collection) => ({ ...collection, kind: "hosted" as const, connector_name: "Hosted by mdbase" }))
          ]}
          unavailableConnectors={request.unavailable_connectors}
          onDecision={onChanged}
          onCollectionCreated={() => void onChanged()}
        />
      </article>
    ))}</div>}
  </section>;
}

function ApplicationAccessPage({ data, groups, onChanged, onError }: {
  data: DashboardData;
  groups: ApplicationAccessGroup<DashboardData["grants"][number]>[];
  onChanged(): Promise<void>;
  onError(value: string): void;
}) {
  return <section>
    <SectionHeading title="Connected applications" note="Expand an application to review its collection access." count={groups.length} />
    {groups.length === 0 ? <Empty title="No applications connected" text="Approved website and downloaded application connections will appear here." /> : <div className="portal-application-list">{groups.map((group) => (
      <PortalApplicationAccess key={group.applicationId} group={group} collections={data.collections} onChanged={onChanged} onError={onError} />
    ))}</div>}
  </section>;
}

function ComputersPage({ data, onChanged, onError }: {
  data: DashboardData;
  onChanged(): Promise<void>;
  onError(value: string): void;
}) {
  return <section>
    <SectionHeading title="Computers" note="Revoking a computer immediately invalidates all of its application access." count={data.connectors.length} />
    {data.connectors.length === 0 ? <Empty title="No computers connected" text="Open mdbase connect on a computer and choose Connect this computer." /> : <div className="computer-list">{data.connectors.map((connector) => {
      const collections = data.collections.filter((collection) => collection.connector_id === connector.id);
      const online = connector.last_seen_at !== null && Date.now() - new Date(connector.last_seen_at).getTime() < 45_000;
      return <ComputerRow key={connector.id} connector={connector} collectionCount={collections.length} availableCount={online ? collections.filter((collection) => collection.enabled).length : 0} onChanged={onChanged} onError={onError} />;
    })}</div>}
  </section>;
}

function HostedCollections({ collections, canCreate, onChanged, onError }: {
  collections: HostedCollection[];
  canCreate: boolean;
  onChanged(): Promise<void>;
  onError(value: string): void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("My collection");
  const [busy, setBusy] = useState(false);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api("/v1/hosted/collections", {
        method: "POST",
        body: JSON.stringify({ display_name: name.trim(), template: "mdbase" })
      });
      setCreating(false);
      setName("My collection");
      await onChanged();
    } catch (reason) {
      onError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  return <>
    <SectionHeading
      title="Hosted collections"
      note="Keep the main copy on mdbase, with optional synced folders."
      count={collections.length}
    />
    {collections.length === 0 && !creating
      ? <Empty
          title="No hosted collections"
          text={canCreate
            ? "Create an mdbase collection that stays available without a connected computer."
            : "Hosted collections are not enabled for this Connect service."}
        />
      : <div className="hosted-list">{collections.map((collection) => (
          <HostedCollectionRow key={collection.id} collection={collection} onChanged={onChanged} onError={onError} />
        ))}</div>}
    {canCreate && (creating ? <form className="inline-create" onSubmit={(event) => void create(event)}>
      <label><span>Collection name</span><input autoFocus maxLength={200} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <p>Starts as a clean mdbase collection. Add Markdown through compatible apps and optionally keep a folder in sync.</p>
      <div><button type="button" className="quiet-action" disabled={busy} onClick={() => setCreating(false)}>Cancel</button><button className="button primary" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create collection"}</button></div>
    </form> : <button className="button secondary" onClick={() => setCreating(true)}>Create hosted collection</button>)}
  </>;
}

function HostedCollectionRow({ collection, onChanged, onError }: {
  collection: HostedCollection;
  onChanged(): Promise<void>;
  onError(value: string): void;
}) {
  const [panel, setPanel] = useState<"mirror" | "rename" | null>(null);
  const [name, setName] = useState(collection.display_name);
  const [busy, setBusy] = useState(false);
  const isActive = collection.authority_state === "active";
  const activeReplicas = collection.replicas.filter((replica) => !replica.revoked_at);
  const editorCollectionId = isActive
    ? collection.id
    : collection.authority_state === "transferred"
      ? collection.transferred_collection_id
      : null;
  useEffect(() => { if (panel !== "rename") setName(collection.display_name); }, [collection.display_name, panel]);

  async function rename(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api(`/v1/hosted/collections/${collection.id}`, {
        method: "PATCH",
        body: JSON.stringify({ display_name: name.trim() })
      });
      setPanel(null);
      await onChanged();
    } catch (reason) { onError(message(reason)); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!window.confirm(`Delete ${collection.display_name} and all of its hosted Markdown? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await api(`/v1/hosted/collections/${collection.id}`, { method: "DELETE" });
      await onChanged();
    } catch (reason) { onError(message(reason)); setBusy(false); }
  }

  async function revoke(replicaId: string, replicaName: string) {
    if (!window.confirm(`Revoke ${replicaName}? Its local files remain, but it will no longer receive changes.`)) return;
    setBusy(true);
    try {
      await api(`/v1/hosted/replicas/${replicaId}`, { method: "DELETE" });
      await onChanged();
    } catch (reason) { onError(message(reason)); }
    finally { setBusy(false); }
  }

  return <article className="hosted-row">
    <div className="hosted-summary">
      <div><strong>{collection.display_name}</strong><small>
        {collection.authority_state === "transferred"
          ? "Main copy moved to a computer"
          : collection.authority_state === "transferring"
            ? "Main copy is moving to a computer"
            : `Main copy hosted by mdbase · created ${relativeTime(collection.created_at)}`}
      </small></div>
      <span className={`availability ${isActive ? "online" : "idle"}`}><i />
        {collection.authority_state === "transferred"
          ? "Moved"
          : collection.authority_state === "transferring"
            ? "Moving"
            : "Hosted"}
      </span>
      <span className="replica-count">{activeReplicas.length} synced {activeReplicas.length === 1 ? "folder" : "folders"}</span>
      <div className="computer-actions">
        {editorCollectionId && <a
          className="quiet-action"
          href={editorUrl(editorCollectionId)}
          target="_blank"
          rel="noreferrer"
        >
          Open in editor <span aria-hidden="true">↗</span>
        </a>}
        {isActive && <button className="quiet-action" disabled={busy} onClick={() => setPanel(panel === "mirror" ? null : "mirror")}>Sync a folder</button>}
        {isActive && <button className="quiet-action" disabled={busy} onClick={() => setPanel(panel === "rename" ? null : "rename")}>Rename</button>}
        <button className="quiet-danger" disabled={busy} onClick={() => void remove()}>Delete</button>
      </div>
    </div>
    {panel === "rename" && <form className="hosted-detail hosted-rename" onSubmit={(event) => void rename(event)}>
      <label><span>Collection name</span><input autoFocus maxLength={200} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <div><button type="button" className="quiet-action" disabled={busy} onClick={() => setPanel(null)}>Cancel</button><button className="button primary" disabled={busy || !name.trim() || name.trim() === collection.display_name}>Save</button></div>
    </form>}
    {panel === "mirror" && <div className="hosted-detail">
      <MirrorSetup collectionId={collection.id} />
    </div>}
    {activeReplicas.length > 0 && <details className="replica-detail">
      <summary>Manage synced folders</summary>
      <div>{activeReplicas.map((replica) => <div className="replica-row" key={replica.id}>
        <div><strong>{replica.name}</strong><small>{mirrorStatus(replica)}</small></div>
        <div><button className="quiet-danger" disabled={busy} onClick={() => void revoke(replica.id, replica.name)}>Revoke</button></div>
      </div>)}</div>
    </details>}
  </article>;
}

function mirrorStatus(replica: HostedCollection["replicas"][number]): string {
  const mode = replica.mode === "read_only" ? "Downloads updates only" : "Edits sync both ways";
  if (!replica.sync_status) return `${mode} · status unavailable`;
  if (!replica.sync_status.last_seen_at) return `${mode} · waiting for first sync`;
  const lag = Math.max(
    0,
    replica.sync_status.head - replica.sync_status.acknowledged_sequence
  );
  const state = lag === 0 ? "up to date" : `${lag} ${lag === 1 ? "change" : "changes"} behind`;
  return `${mode} · ${state} · seen ${relativeTime(replica.sync_status.last_seen_at)}`;
}

function MirrorSetup({ collectionId }: { collectionId: string }) {
  const desktopUrl = `mdbase-connect://mirror?collection=${encodeURIComponent(collectionId)}`;
  return <div className="mirror-setup" aria-live="polite">
    <p><strong>Choose the folder in mdbase connect.</strong> The desktop app keeps the folder location and connection details on your computer.</p>
    <div className="mirror-setup-actions"><a className="button primary" href={desktopUrl}>Open mdbase connect</a></div>
    <p>Existing Markdown is checked before upload. If files overlap, mdbase connect asks you which version to keep. The main copy remains hosted.</p>
  </div>;
}

function ComputerRow({ connector, collectionCount, availableCount, onChanged, onError }: {
  connector: DashboardData["connectors"][number];
  collectionCount: number;
  availableCount: number;
  onChanged(): Promise<void>;
  onError(value: string): void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(connector.name);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!editing) setName(connector.name); }, [connector.name, editing]);
  const online = connector.last_seen_at !== null
    && Date.now() - new Date(connector.last_seen_at).getTime() < 45_000;

  async function rename(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || name.trim() === connector.name) return;
    setBusy(true);
    try {
      await api(`/v1/connectors/${connector.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: name.trim() })
      });
      setEditing(false);
      await onChanged();
    } catch (reason) {
      onError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!window.confirm(`Revoke ${connector.name}? Applications connected through it will stop working.`)) return;
    setBusy(true);
    try {
      await api(`/v1/connectors/${connector.id}`, { method: "DELETE" });
      await onChanged();
    } catch (reason) {
      onError(message(reason));
      setBusy(false);
    }
  }

  return <div className={`computer-row ${editing ? "editing" : ""}`}>
    {editing ? <form className="computer-name-form" onSubmit={(event) => void rename(event)}>
      <label><span>Computer name</span><input autoFocus value={name} maxLength={100} onChange={(event) => setName(event.target.value)} /></label>
      <div><button type="button" className="quiet-action" disabled={busy} onClick={() => setEditing(false)}>Cancel</button><button className="button primary" disabled={busy || !name.trim() || name.trim() === connector.name}>Save</button></div>
    </form> : <div><strong>{connector.name}</strong><small>{collectionCount} {collectionCount === 1 ? "collection" : "collections"}, {availableCount} available · {connector.last_seen_at ? `Seen ${relativeTime(connector.last_seen_at)}` : "Not connected yet"}</small></div>}
    {!editing && <><span className={`availability ${online ? "online" : "idle"}`}><i />{online ? "Online" : connector.last_seen_at ? "Offline" : "Pending"}</span><div className="computer-actions"><button className="quiet-action" disabled={busy} onClick={() => setEditing(true)}>Rename</button><button className="quiet-danger" disabled={busy} onClick={() => void revoke()}>Revoke</button></div></>}
  </div>;
}

type PortalGrantRecord = DashboardData["grants"][number];

function PortalApplicationAccess({ group, collections, onChanged, onError }: {
  group: ApplicationAccessGroup<PortalGrantRecord>;
  collections: DashboardData["collections"];
  onChanged(): Promise<void>;
  onError(value: string): void;
}) {
  const [busy, setBusy] = useState(false);
  const identity = group.grants[0];

  async function revokeApplication() {
    const collectionLabel = pluralLabel(group.collectionCount, "collection", "collections");
    if (!window.confirm(`Revoke all ${group.applicationName} access across ${collectionLabel}?`)) return;
    setBusy(true);
    try {
      for (const grant of group.grants) {
        await api(`/v1/grants/${grant.id}`, { method: "DELETE" });
      }
      await onChanged();
    } catch (reason) {
      await onChanged().catch(() => undefined);
      onError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  return <details className="portal-application-access">
    <summary>
      <div className="application-access-identity"><strong>{group.applicationName}</strong><small>{identity.distribution === "portable" ? `Downloaded file${identity.project_url ? ` · ${host(identity.project_url)}` : ""}` : host(identity.homepage)}</small></div>
      <span>{pluralLabel(group.collectionCount, "collection", "collections")}</span>
      <span>{pluralLabel(group.grants.length, "access record", "access records")}</span>
      <b>Review</b>
    </summary>
    <div className="portal-application-body">
      <div className="portal-grant-list">{group.grants.map((grant) => {
        const collection = collections.find((candidate) => candidate.id === grant.collection_id);
        const connectorName = grant.collection_kind === "hosted"
          ? "Hosted by mdbase"
          : collection?.connector_name ?? "Unknown computer";
        return <PortalGrant key={grant.id} grant={grant} connectorName={connectorName} disabled={busy} onChanged={onChanged} onError={onError} />;
      })}</div>
      <div className="application-access-actions">
        <span>Revokes every active access record for this application.</span>
        <button className="quiet-danger" disabled={busy} onClick={() => void revokeApplication()}>Revoke application</button>
      </div>
    </div>
  </details>;
}

function PortalGrant({ grant, connectorName, disabled, onChanged, onError }: {
  grant: DashboardData["grants"][number];
  connectorName: string;
  disabled?: boolean;
  onChanged(): Promise<void>;
  onError(value: string): void;
}) {
  const [operations, setOperations] = useState(new Set(grant.operations));
  const [busy, setBusy] = useState(false);
  useEffect(() => setOperations(new Set(grant.operations)), [grant.operations]);
  const orderedOperations = [
    ...allOperations.filter((operation) => grant.operations.includes(operation)),
    ...grant.operations.filter((operation) => !allOperations.includes(operation))
  ];
  const changed = orderedOperations.some((operation) => operations.has(operation) !== grant.operations.includes(operation));
  const inactive = busy || disabled;

  function toggle(operation: string) {
    setOperations((current) => {
      const next = new Set(current);
      if (next.has(operation)) next.delete(operation); else next.add(operation);
      return next;
    });
  }

  async function save() {
    setBusy(true);
    try {
      await api(`/v1/grants/${grant.id}`, {
        method: "PATCH",
        body: JSON.stringify({ operations: orderedOperations.filter((operation) => operations.has(operation)) })
      });
      await onChanged();
    } catch (reason) {
      onError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!window.confirm(`Revoke ${grant.application_name} access to ${grant.collection_name}?`)) return;
    setBusy(true);
    try {
      await api(`/v1/grants/${grant.id}`, { method: "DELETE" });
      await onChanged();
    } catch (reason) {
      onError(message(reason));
      setBusy(false);
    }
  }

  return <details className="portal-grant">
    <summary>
      <div><strong>{grant.collection_name}</strong><small>{connectorName}</small></div>
      <span>{grant.operations.length} {grant.operations.length === 1 ? "permission" : "permissions"}</span>
      <span>{relativeTime(grant.created_at)}</span>
      <b>Review</b>
    </summary>
    <div className="portal-grant-detail">
      <div><p className="detail-label">Allowed actions</p><div className="permission-options grant-permissions">{orderedOperations.map((operation) => <label key={operation}><input type="checkbox" checked={operations.has(operation)} disabled={inactive} onChange={() => toggle(operation)} /><span>{authorizationOperationLabel(operation)}</span></label>)}</div></div>
      <div className="grant-context"><p><span>Scope</span><strong>{grant.scope.contracts.length ? scopeDescription(grant.scope.contracts) : "All record types in this collection."}</strong></p><p><span>Application origin</span><strong className="mono-detail">{grant.application_origin}</strong></p><p><span>Connected</span><strong>{relativeTime(grant.created_at)}</strong></p></div>
      <div className="grant-actions"><button className="button secondary" disabled={inactive || !changed || operations.size === 0} onClick={() => void save()}>Save narrower access</button><button className="quiet-danger" disabled={inactive} onClick={() => void revoke()}>Revoke access</button></div>
    </div>
  </details>;
}
