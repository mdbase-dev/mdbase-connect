import {
  authorizationOperationLabel,
  groupApplicationAccess,
  type ApplicationAccessGroup
} from "@mdbase/connect-ui/access";
import React, { useEffect, useState } from "react";
import {
  api,
  ApiError,
  type DashboardData,
  type HostedCollection
} from "./api";
import { ApprovalForm, RequestIdentity } from "./authorization-view";
import {
  allOperations,
  authenticationLabel,
  editorUrl,
  host,
  identityLabel,
  initials,
  message,
  pluralLabel,
  registrationLabel,
  relativeTime,
  scopeDescription
} from "./portal-model";
import {
  AccountRow,
  Brand,
  Empty,
  Loading,
  SectionHeading,
  ThemeSelect
} from "./portal-ui";
import { SessionManager } from "./session-manager";

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");

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
  if (!data) return <Loading error={error} />;
  const activeGrants = data.grants.filter((grant) => !grant.revoked_at);
  const applicationAccess = groupApplicationAccess(activeGrants);

  return (
    <div className="account-shell">
      <header className="product-header account-header">
        <div className="product-header-inner">
          <Brand productLabel />
          <div className="product-header-meta">
            <a
              className="portal-editor-link"
              href={editorUrl()}
              target="_blank"
              rel="noreferrer"
              aria-label="Open mdbase editor in a new tab"
            >
              <span className="portal-editor-link-label">Editor</span>
              <span aria-hidden="true">↗</span>
            </a>
            <ThemeSelect />
            <div className="product-header-meta-copy"><strong>{data.user.name}</strong><small>{identityLabel(data.user)}</small></div>
            <span className="product-avatar" aria-hidden="true">{initials(data.user.name)}</span>
          </div>
        </div>
      </header>
      <main className="account-main">
        <header><p className="eyebrow">Your account</p><h1>Your connections.</h1><p>Approve application requests and manage the computers connected to your account.</p></header>
        {error && <div className="message error">{error}</div>}
        <section id="requests" aria-label="Access requests" className={data.pending_authorizations.length ? "attention-section" : "requests-clear"}>
          {data.pending_authorizations.length === 0 ? <div className="quiet-status" role="status"><span className="status-dot connected" aria-hidden="true" /><span>No access requests waiting</span></div> : <>
          <SectionHeading title="Access requests" note="A request expires automatically if you do nothing." count={data.pending_authorizations.length} />
            <div className="request-list">{data.pending_authorizations.map((request) => (
              <article className="request-row" key={request.id}>
                <RequestIdentity request={request} />
                <ApprovalForm
                  request={request}
                  canCreateHosted={data.hosted_collections_available !== false}
                  collections={[
                    ...(request.available_collections ?? []),
                    ...data.hosted_collections
                      .filter((collection) => collection.authority_state === "active")
                      .map((collection) => ({
                      ...collection,
                      kind: "hosted" as const,
                      connector_name: "Hosted by mdbase"
                    }))
                  ]}
                  unavailableConnectors={request.unavailable_connectors}
                  onDecision={refresh}
                  onCollectionCreated={() => void refresh()}
                />
              </article>
            ))}</div></>}
        </section>
        <section id="hosted">
          <HostedCollections
            collections={data.hosted_collections}
            canCreate={data.hosted_collections_available !== false}
            onChanged={refresh}
            onError={setError}
          />
        </section>
        <section id="permissions">
          <SectionHeading title="Application access" note="Applications are grouped here; expand one to review its collection access." count={applicationAccess.length} />
          {applicationAccess.length === 0 ? (
            <Empty title="No applications connected" text="Approved website and downloaded application connections will appear here." />
          ) : (
            <div className="portal-application-list">{applicationAccess.map((group) => (
              <PortalApplicationAccess
                key={group.applicationId}
                group={group}
                collections={data.collections}
                onChanged={refresh}
                onError={setError}
              />
            ))}</div>
          )}
        </section>
        <section id="computers">
          <SectionHeading title="Connected computers" note="Revoking a computer immediately invalidates all of its application access." count={data.connectors.length} />
          {data.connectors.length === 0 ? <Empty title="No computers connected" text="Open mdbase connect on a computer and choose Connect this computer." /> : (
            <div className="computer-list">{data.connectors.map((connector) => {
              const collections = data.collections.filter((collection) => collection.connector_id === connector.id);
              const online = connector.last_seen_at !== null
                && Date.now() - new Date(connector.last_seen_at).getTime() < 45_000;
              return <ComputerRow key={connector.id} connector={connector} collectionCount={collections.length} availableCount={online ? collections.filter((collection) => collection.enabled).length : 0} onChanged={refresh} onError={setError} />;
            })}</div>
          )}
        </section>
        <section id="account">
          <SectionHeading title="Account" note="Authentication and service details." />
          <div className="account-rows"><AccountRow label="Authentication" value={authenticationLabel(data.authentication.provider)} detail={data.authentication.provider === "tailscale" ? "Controlled by your tailnet" : undefined} /><AccountRow label="Registration" value={registrationLabel(data.authentication.registration)} detail={data.authentication.registration === "open" ? "New identities may create an account" : data.authentication.registration === "invite" ? "New accounts require an invitation" : "New account creation is paused"} /></div>
          {data.authentication.provider !== "tailscale" && <>
            <SessionManager onError={setError} />
            <button className="button secondary" onClick={() => void api("/v1/logout", { method: "POST" }).then(() => { location.href = "/login"; })}>Sign out</button>
          </>}
        </section>
      </main>
    </div>
  );
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
