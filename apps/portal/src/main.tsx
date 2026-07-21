import "@fontsource/atkinson-hyperlegible/latin-400.css";
import "@fontsource/atkinson-hyperlegible/latin-700.css";
import "@fontsource/azeret-mono/latin-400.css";
import "@fontsource/azeret-mono/latin-500.css";
import "@fontsource/azeret-mono/latin-600.css";
import "@mdbase/connect-ui/styles.css";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  api,
  ApiError,
  type AvailableCollection,
  type ContractRequirement,
  type DashboardData,
  type HostedCollection,
  type PendingAuthorization
} from "./api";
import "./styles.css";

const allOperations = ["describe", "changes", "read", "query", "validate", "create", "update", "delete", "rename"];

function Portal() {
  const pairingId = location.pathname.match(/^\/pair\/([0-9a-f-]+)$/i)?.[1];
  const authorizationId = location.pathname.match(/^\/authorize\/([0-9a-f-]+)$/i)?.[1];
  if (location.pathname === "/login") return <Login />;
  if (pairingId) return <Pairing pairingId={pairingId} />;
  if (authorizationId) return <Authorization requestId={authorizationId} />;
  return <Dashboard />;
}

function Login() {
  const [name, setName] = useState("Callum");
  const [email, setEmail] = useState("callum@example.com");
  const [provider, setProvider] = useState<"github" | "tailscale" | "development" | "session" | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    async function identify() {
      try {
        await api("/v1/me");
        location.replace(returnTarget());
      } catch (identifyError) {
        if (!(identifyError instanceof ApiError) || identifyError.status !== 401) {
          setError(message(identifyError));
        }
        try {
          const config = await api<{ provider: "github" | "tailscale" | "development" | "session" }>("/v1/auth/config");
          setProvider(config.provider);
        } catch (configError) {
          setError(message(configError));
        }
      }
    }
    void identify();
  }, []);

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    try {
      await api("/v1/dev/session", { method: "POST", body: JSON.stringify({ name, email }) });
      location.href = returnTarget();
    } catch (signInError) {
      setError(message(signInError));
    }
  }

  if (!provider) return <Loading error={error} />;
  if (provider === "tailscale") return (
    <main className="center-page">
      <div className="page-brand"><Brand /><span>connect</span></div>
      <section className="auth-panel">
        <p className="eyebrow">Tailnet identity</p>
        <h1>Open this through Tailscale.</h1>
        <p>mdbase connect signs you in from your tailnet identity. Make sure this device is connected to your tailnet, then reload this page.</p>
        {error && <div className="message error">{error}</div>}
        <button className="button primary" onClick={() => location.reload()}>Try again</button>
      </section>
    </main>
  );
  if (provider === "github") return (
    <main className="center-page">
      <div className="page-brand"><Brand /><span>connect</span></div>
      <section className="auth-panel">
        <p className="eyebrow">Private preview</p>
        <h1>Sign in to mdbase connect</h1>
        <p>Access is currently limited to invited GitHub accounts.</p>
        {error && <div className="message error">{error}</div>}
        <a className="button primary link-button" href={`/auth/github?return_to=${encodeURIComponent(returnTarget())}`}>
          Continue with GitHub
        </a>
      </section>
    </main>
  );

  return (
    <main className="center-page">
      <div className="page-brand"><Brand /><span>connect</span></div>
      <form className="auth-panel" onSubmit={(event) => void signIn(event)}>
        <p className="eyebrow">Development session</p>
        <h1>Open your account</h1>
        <p>This temporary sign-in is available only when development authentication is enabled.</p>
        {error && <div className="message error">{error}</div>}
        <label><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label><span>Email</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <button className="button primary" type="submit">Continue</button>
      </form>
    </main>
  );
}

function Dashboard() {
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

  return (
    <div className="account-shell">
      <header className="product-header account-header">
        <div className="product-header-inner">
          <Brand productLabel />
          <div className="product-header-meta">
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
                  collections={compatibleCollections(
                  request,
                  [
                    ...data.collections.filter((collection) => collection.enabled)
                      .map((collection) => ({ ...collection, kind: "local" as const })),
                    ...data.hosted_collections.map((collection) => ({
                      ...collection,
                      kind: "hosted" as const,
                      connector_name: "Hosted by mdbase"
                    }))
                  ]
                  )}
                  onDecision={refresh}
                />
              </article>
            ))}</div></>}
        </section>
        <section id="hosted">
          <HostedCollections collections={data.hosted_collections} onChanged={refresh} onError={setError} />
        </section>
        <section id="permissions">
          <SectionHeading title="Application access" note="Review exact permissions, narrow them, or revoke access immediately." count={data.grants.filter((grant) => !grant.revoked_at).length} />
          {data.grants.every((grant) => grant.revoked_at) ? (
            <Empty title="No applications connected" text="Approved website connections will appear here." />
          ) : (
            <div className="portal-grant-list">{data.grants.filter((grant) => !grant.revoked_at).map((grant) => {
              const collection = data.collections.find((candidate) => candidate.id === grant.collection_id);
              return <PortalGrant key={grant.id} grant={grant} connectorName={grant.collection_kind === "hosted" ? "Hosted by mdbase" : collection?.connector_name ?? "Unknown computer"} onChanged={refresh} onError={setError} />;
            })}</div>
          )}
        </section>
        <section id="computers">
          <SectionHeading title="Connected computers" note="Revoking a computer immediately invalidates all of its application access." count={data.connectors.length} />
          {data.connectors.length === 0 ? <Empty title="No computers connected" text="Open mdbase connect on a computer and choose Connect this computer." /> : (
            <div className="computer-list">{data.connectors.map((connector) => {
              const collections = data.collections.filter((collection) => collection.connector_id === connector.id);
              return <ComputerRow key={connector.id} connector={connector} collectionCount={collections.length} availableCount={collections.filter((collection) => collection.enabled).length} onChanged={refresh} onError={setError} />;
            })}</div>
          )}
        </section>
        <section id="account">
          <SectionHeading title="Account" note="Authentication and service details." />
          <div className="account-rows"><AccountRow label="Authentication" value={authenticationLabel(data.authentication.provider)} detail={data.authentication.provider === "tailscale" ? "Controlled by your tailnet" : undefined} /><AccountRow label="Plan" value="Private preview" detail="Registration is not available" /></div>
          {data.authentication.provider !== "tailscale" && <button className="button secondary" onClick={() => void api("/v1/logout", { method: "POST" }).then(() => { location.href = "/login"; })}>Sign out</button>}
        </section>
      </main>
    </div>
  );
}

interface ReplicaSecret {
  replicaId: string;
  token: string;
  syncUrl: string;
  mode: "read_only" | "read_write";
}

function HostedCollections({ collections, onChanged, onError }: {
  collections: HostedCollection[];
  onChanged(): Promise<void>;
  onError(value: string): void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("My tasks");
  const [busy, setBusy] = useState(false);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api("/v1/hosted/collections", {
        method: "POST",
        body: JSON.stringify({ display_name: name.trim(), template: "tasknotes" })
      });
      setCreating(false);
      setName("My tasks");
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
      note="Keep the authoritative Markdown on mdbase, with optional local mirrors."
      count={collections.length}
    />
    {collections.length === 0 && !creating
      ? <Empty title="No hosted collections" text="Create a TaskNotes collection whose source of truth stays available without a connected computer." />
      : <div className="hosted-list">{collections.map((collection) => (
          <HostedCollectionRow key={collection.id} collection={collection} onChanged={onChanged} onError={onError} />
        ))}</div>}
    {creating ? <form className="inline-create" onSubmit={(event) => void create(event)}>
      <label><span>Collection name</span><input autoFocus maxLength={200} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <p>Starts with the TaskNotes schema. You can receive an exact Markdown mirror on any computer afterward.</p>
      <div><button type="button" className="quiet-action" disabled={busy} onClick={() => setCreating(false)}>Cancel</button><button className="button primary" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create collection"}</button></div>
    </form> : <button className="button secondary" onClick={() => setCreating(true)}>Create hosted collection</button>}
  </>;
}

function HostedCollectionRow({ collection, onChanged, onError }: {
  collection: HostedCollection;
  onChanged(): Promise<void>;
  onError(value: string): void;
}) {
  const [panel, setPanel] = useState<"mirror" | "rename" | null>(null);
  const [name, setName] = useState(collection.display_name);
  const [mirrorName, setMirrorName] = useState("Local mirror");
  const [mirrorMode, setMirrorMode] = useState<"read_only" | "read_write">("read_only");
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<ReplicaSecret | null>(null);
  const activeReplicas = collection.replicas.filter((replica) => !replica.revoked_at);
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

  async function addMirror(event: React.FormEvent) {
    event.preventDefault();
    if (!mirrorName.trim()) return;
    setBusy(true);
    try {
      const enrollment = await api<{
        replica: { id: string };
        token: string;
        sync_url: string;
      }>(`/v1/hosted/collections/${collection.id}/replicas`, {
        method: "POST",
        body: JSON.stringify({ name: mirrorName.trim(), mode: mirrorMode, allowed_types: ["task"] })
      });
      setSecret({ replicaId: enrollment.replica.id, token: enrollment.token, syncUrl: enrollment.sync_url, mode: mirrorMode });
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
      if (secret?.replicaId === replicaId) setSecret(null);
      await onChanged();
    } catch (reason) { onError(message(reason)); }
    finally { setBusy(false); }
  }

  async function rotate(replicaId: string) {
    setBusy(true);
    try {
      const value = await api<{ token: string; sync_url: string }>(`/v1/hosted/replicas/${replicaId}/token`, { method: "POST" });
      const replica = activeReplicas.find((candidate) => candidate.id === replicaId);
      if (!replica) throw new Error("Mirror is no longer available.");
      setSecret({ replicaId, token: value.token, syncUrl: value.sync_url, mode: replica.mode });
    } catch (reason) { onError(message(reason)); }
    finally { setBusy(false); }
  }

  return <article className="hosted-row">
    <div className="hosted-summary">
      <div><strong>{collection.display_name}</strong><small>TaskNotes · authoritative on mdbase · created {relativeTime(collection.created_at)}</small></div>
      <span className="availability online"><i />Hosted</span>
      <span className="replica-count">{activeReplicas.length} {activeReplicas.length === 1 ? "mirror" : "mirrors"}</span>
      <div className="computer-actions"><button className="quiet-action" disabled={busy} onClick={() => { setSecret(null); setPanel(panel === "mirror" ? null : "mirror"); }}>Add mirror</button><button className="quiet-action" disabled={busy} onClick={() => setPanel(panel === "rename" ? null : "rename")}>Rename</button><button className="quiet-danger" disabled={busy} onClick={() => void remove()}>Delete</button></div>
    </div>
    {panel === "rename" && <form className="hosted-detail hosted-rename" onSubmit={(event) => void rename(event)}>
      <label><span>Collection name</span><input autoFocus maxLength={200} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <div><button type="button" className="quiet-action" disabled={busy} onClick={() => setPanel(null)}>Cancel</button><button className="button primary" disabled={busy || !name.trim() || name.trim() === collection.display_name}>Save</button></div>
    </form>}
    {panel === "mirror" && <div className="hosted-detail">
      {!secret ? <form className="mirror-form" onSubmit={(event) => void addMirror(event)}>
        <label><span>Mirror name</span><input autoFocus maxLength={200} value={mirrorName} onChange={(event) => setMirrorName(event.target.value)} /></label>
        <label><span>Local edits</span><select value={mirrorMode} onChange={(event) => setMirrorMode(event.target.value as "read_only" | "read_write")}><option value="read_only">Receive only</option><option value="read_write">Sync to hosted</option></select></label>
        <p>{mirrorMode === "read_only" ? "Local edits never overwrite the hosted source of truth." : "Local edits sync conditionally. Concurrent edits stop for an explicit choice—never last-write-wins."}</p>
        <button className="button primary" disabled={busy || !mirrorName.trim()}>{busy ? "Preparing…" : "Prepare mirror"}</button>
      </form> : <MirrorSetup collectionId={collection.id} secret={secret} />}
    </div>}
    {activeReplicas.length > 0 && <details className="replica-detail">
      <summary>Manage mirrors</summary>
      <div>{activeReplicas.map((replica) => <div className="replica-row" key={replica.id}>
        <div><strong>{replica.name}</strong><small>{replica.mode === "read_only" ? "Receive-only" : "Two-way"} · added {relativeTime(replica.created_at)}</small></div>
        <div><button className="quiet-action" disabled={busy} onClick={() => void rotate(replica.id)}>Replace token</button><button className="quiet-danger" disabled={busy} onClick={() => void revoke(replica.id, replica.name)}>Revoke</button></div>
      </div>)}</div>
      {secret && panel !== "mirror" && <MirrorSetup collectionId={collection.id} secret={secret} />}
    </details>}
  </article>;
}

function MirrorSetup({ collectionId, secret }: { collectionId: string; secret: ReplicaSecret }) {
  const command = `mdbase-mirror init ./tasks --server ${secret.syncUrl} --collection ${collectionId} --replica ${secret.replicaId}${secret.mode === "read_write" ? " --writable" : ""}`;
  const [copied, setCopied] = useState<"token" | "command" | null>(null);
  async function copy(value: string, kind: "token" | "command") {
    await navigator.clipboard.writeText(value);
    setCopied(kind);
  }
  return <div className="mirror-setup" aria-live="polite">
    <p><strong>Save this token now.</strong> It is shown once. The CLI asks for it without echoing it.</p>
    <div className="copy-row"><code>{secret.token}</code><button className="quiet-action" type="button" onClick={() => void copy(secret.token, "token")}>{copied === "token" ? "Copied" : "Copy token"}</button></div>
    <p>Install <code>@mdbase/connect-sync</code>, then run:</p>
    <div className="copy-row"><code>{command}</code><button className="quiet-action" type="button" onClick={() => void copy(command, "command")}>{copied === "command" ? "Copied" : "Copy command"}</button></div>
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

function PortalGrant({ grant, connectorName, onChanged, onError }: {
  grant: DashboardData["grants"][number];
  connectorName: string;
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
      <div><strong>{grant.application_name}</strong><small>{host(grant.homepage)}</small></div>
      <div><strong>{grant.collection_name}</strong><small>{connectorName}</small></div>
      <span>{grant.operations.length} {grant.operations.length === 1 ? "permission" : "permissions"}</span>
      <b>Review</b>
    </summary>
    <div className="portal-grant-detail">
      <div><p className="detail-label">Allowed actions</p><div className="permission-options grant-permissions">{orderedOperations.map((operation) => <label key={operation}><input type="checkbox" checked={operations.has(operation)} disabled={busy} onChange={() => toggle(operation)} /><span>{operationLabel(operation)}</span></label>)}</div></div>
      <div className="grant-context"><p><span>Scope</span><strong>{grant.scope.contracts.length ? scopeDescription(grant.scope.contracts) : "All record types in this collection."}</strong></p><p><span>Connected</span><strong>{relativeTime(grant.created_at)}</strong></p></div>
      <div className="grant-actions"><button className="button secondary" disabled={busy || !changed || operations.size === 0} onClick={() => void save()}>Save narrower access</button><button className="quiet-danger" disabled={busy} onClick={() => void revoke()}>Revoke access</button></div>
    </div>
  </details>;
}

function Pairing({ pairingId }: { pairingId: string }) {
  const [pairing, setPairing] = useState<{ connector_name: string; approved_at: string | null } | null>(null);
  const [deepLink, setDeepLink] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ pairing: { connector_name: string; approved_at: string | null } }>(`/v1/pairing-requests/${pairingId}`)
      .then((value) => setPairing(value.pairing))
      .catch((reason) => {
        if (reason instanceof ApiError && reason.status === 401) location.href = `/login?return_to=${encodeURIComponent(location.href)}`;
        else setError(message(reason));
      });
  }, [pairingId]);

  async function approve() {
    try {
      const result = await api<{ deep_link: string }>(`/v1/pairing-requests/${pairingId}/approve`, { method: "POST" });
      setDeepLink(result.deep_link);
    } catch (approveError) { setError(message(approveError)); }
  }

  if (!pairing) return <Loading error={error} />;
  return (
    <main className="center-page">
      <div className="page-brand"><Brand /><span>Computer pairing</span></div>
      <section className="decision-panel">
        {deepLink ? <><p className="eyebrow">Computer approved</p><h1>Return to mdbase connect.</h1><p>The desktop app will finish securely. No connector token was displayed or copied.</p><a className="button primary link-button" href={deepLink}>Open mdbase connect</a></> : <><p className="eyebrow">New computer</p><h1>{pairing.connector_name}</h1><p>Allow this computer to connect to your account. It will publish collection names and route application requests, but not local folder paths.</p>{error && <div className="message error">{error}</div>}<div className="decision-actions"><a className="button secondary link-button" href="/">Cancel</a><button className="button primary" onClick={() => void approve()}>Approve computer</button></div></>}
      </section>
    </main>
  );
}

function Authorization({ requestId }: { requestId: string }) {
  const [request, setRequest] = useState<{
    authorization: PendingAuthorization;
    collections: AvailableCollection[];
  } | null>(null);
  const [status, setStatus] = useState<"pending" | "approved" | "denied">("pending");
  const [error, setError] = useState("");
  const returning = useRef(false);
  const deepLink = useMemo(() => `mdbase-connect://authorize?server=${encodeURIComponent(location.origin)}&request=${requestId}`, [requestId]);

  useEffect(() => {
    api<{ authorization: PendingAuthorization; collections: AvailableCollection[] }>(`/v1/authorization-requests/${requestId}`)
      .then(setRequest)
      .catch((reason) => {
        if (reason instanceof ApiError && reason.status === 401) location.href = `/login?return_to=${encodeURIComponent(location.href)}`;
        else setError(message(reason));
      });
  }, [requestId]);

  useEffect(() => {
    async function checkStatus() {
      try {
        const value = await api<{
          status: "pending" | "approved" | "denied";
          redirect_uri?: string;
        }>(`/v1/authorization-requests/${requestId}/status`);
        if (returning.current) return;
        setStatus(value.status);
        if (value.redirect_uri) {
          returning.current = true;
          location.replace(value.redirect_uri);
        }
      } catch {
        // A transient polling failure should not discard the pending decision.
      }
    }
    void checkStatus();
    const timer = window.setInterval(() => void checkStatus(), 1_000);
    return () => window.clearInterval(timer);
  }, [requestId]);

  if (!request) return <Loading error={error} />;
  const authorization = request.authorization;
  return (
    <main className="center-page">
      <div className="page-brand"><Brand /><span>Application request</span></div>
      <section className="decision-panel authorization-panel">
        <RequestIdentity request={authorization} large />
        {status === "pending" ? <>
          <p>Choose the collection and exact permissions this application may use. The computer holding your files remains the final gate.</p>
          {error && <div className="message error">{error}</div>}
          <ApprovalForm
            request={authorization}
            collections={compatibleCollections(authorization, request.collections)}
            onDecision={(decision) => setStatus(decision)}
          />
          <div className="desktop-alternative"><span>Want to review this on the computer instead?</span><a href={deepLink}>Open mdbase connect</a></div>
        </> : status === "approved" ? <><p className="eyebrow outcome-label">Access approved</p><h2>Returning to the application…</h2><p>Your approved collection and permissions will follow you back.</p></> : <><p className="eyebrow outcome-label">Access denied</p><h2>Returning to the application…</h2><p>The application will show that access was not granted.</p></>}
      </section>
    </main>
  );
}

function RequestIdentity({ request, large = false }: { request: PendingAuthorization; large?: boolean }) {
  return (
    <div className={`request-identity ${large ? "large" : ""}`}>
      <span aria-hidden="true">{initials(request.application_name)}</span>
      <div>
        {large && <p className="eyebrow">Application access</p>}
        {large ? <h1>{request.application_name}</h1> : <strong>{request.application_name}</strong>}
        <small>{host(request.homepage)} · expires {relativeTime(request.expires_at)}</small>
        {request.requirements.contracts.length > 0 && (
          <small>{scopeDescription(request.requirements.contracts)}</small>
        )}
      </div>
    </div>
  );
}

function ApprovalForm({
  request,
  collections,
  onDecision
}: {
  request: PendingAuthorization;
  collections: AvailableCollection[];
  onDecision(decision: "approved" | "denied"): void | Promise<void>;
}) {
  const [collectionId, setCollectionId] = useState(collections[0]?.id ?? "");
  const [operations, setOperations] = useState(() => new Set(request.requested_operations));
  const [submitting, setSubmitting] = useState<"approved" | "denied" | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!collections.some((collection) => collection.id === collectionId)) {
      setCollectionId(collections[0]?.id ?? "");
    }
  }, [collectionId, collections]);

  function toggleOperation(operation: string) {
    setOperations((current) => {
      const next = new Set(current);
      if (next.has(operation)) next.delete(operation);
      else next.add(operation);
      return next;
    });
  }

  async function decide(decision: "approved" | "denied") {
    setSubmitting(decision);
    setError("");
    try {
      await api(`/v1/authorization-requests/${request.id}/${decision === "approved" ? "approve" : "deny"}`, {
        method: "POST",
        ...(decision === "approved" ? {
          body: JSON.stringify({ collection_id: collectionId, operations: [...operations] })
        } : {})
      });
      await onDecision(decision);
    } catch (decisionError) {
      setError(message(decisionError));
      setSubmitting(null);
    }
  }

  return (
    <div className="approval-form" aria-busy={submitting !== null}>
      <label className="collection-field" htmlFor={`collection-${request.id}`}>
        <span>Collection</span>
        <select id={`collection-${request.id}`} value={collectionId} onChange={(event) => setCollectionId(event.target.value)} disabled={submitting !== null || collections.length === 0}>
          {collections.map((collection) => <option value={collection.id} key={collection.id}>{collection.display_name} — {collection.connector_name}</option>)}
        </select>
      </label>
      {collections.length === 0 && <p className="field-note error-copy">
        No enabled collection provides the contracts required by this application.
      </p>}
      <fieldset className="permission-field">
        <legend>Permissions</legend>
        <div className="permission-options">{request.requested_operations.map((operation) => (
          <label key={operation}>
            <input type="checkbox" checked={operations.has(operation)} onChange={() => toggleOperation(operation)} disabled={submitting !== null} />
            <span>{operationLabel(operation)}</span>
          </label>
        ))}</div>
      </fieldset>
      {error && <div className="message error compact">{error}</div>}
      <div className="approval-actions">
        <button className="button secondary deny-button" type="button" disabled={submitting !== null} onClick={() => void decide("denied")}>{submitting === "denied" ? "Denying…" : "Deny"}</button>
        <button className="button primary" type="button" disabled={submitting !== null || !collectionId || operations.size === 0} onClick={() => void decide("approved")}>{submitting === "approved" ? "Approving…" : "Allow access"}</button>
      </div>
    </div>
  );
}

function AccountRow({ label, value, detail, mono = false }: { label: string; value: string; detail?: string; mono?: boolean }) { return <div className="account-row"><span>{label}</span><div><strong className={mono ? "mono" : ""}>{value}</strong>{detail && <small>{detail}</small>}</div></div>; }
function Brand({ productLabel = false }: { productLabel?: boolean }) { return <div className="product-brand"><span className="product-brand-dot" aria-hidden="true" /><strong>mdbase</strong>{productLabel && <span className="product-brand-label">connect</span>}</div>; }
function SectionHeading({ title, note, count }: { title: string; note: string; count?: number }) { return <div className="section-heading"><div><h2>{title}</h2><p>{note}</p></div>{count !== undefined && <span>{count}</span>}</div>; }
function Empty({ title, text }: { title: string; text: string }) { return <div className="empty"><span className="empty-folder" /><strong>{title}</strong><p>{text}</p></div>; }
function Loading({ error = "" }: { error?: string }) { return <main className="loading"><Brand /><p>{error || "Opening mdbase connect…"}</p></main>; }
function initials(value: string) { return value.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(); }
function message(value: unknown) { return value instanceof Error ? value.message : String(value); }
function host(value: string) { try { return new URL(value).host; } catch { return value; } }
function operationLabel(operation: string) { return operation === "query" ? "Search and query" : `${operation[0]?.toUpperCase() ?? ""}${operation.slice(1)}`; }
function compatibleCollections<T extends { contracts: ContractRequirement[] }>(
  request: PendingAuthorization,
  collections: T[]
): T[] {
  const required = request.requirements.contracts;
  if (required.length === 0) return collections;
  return collections.filter((collection) => required.every((requirement) =>
    collection.contracts.some((contract) =>
      contract.id === requirement.id && contract.version === requirement.version
    )
  ));
}
function scopeDescription(contracts: ContractRequirement[]) {
  const names = contracts.map((contract) => `${contract.id} v${contract.version}`);
  return `Access is limited to records matching ${names.join(" and ")}.`;
}
function returnTarget() {
  const requested = new URLSearchParams(location.search).get("return_to");
  if (!requested) return "/";
  const target = new URL(requested, location.origin);
  return target.origin === location.origin ? target.href : "/";
}
function identityLabel(user: { email: string | null; login: string | null }) {
  return user.login ? `@${user.login}` : user.email ?? "Identity unavailable";
}
function authenticationLabel(provider: DashboardData["authentication"]["provider"]) {
  if (provider === "github") return "GitHub";
  if (provider === "tailscale") return "Tailscale identity";
  return "Development session";
}
function relativeTime(value: string) {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1_000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return format.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, "hour");
  return format.format(Math.round(hours / 24), "day");
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><Portal /></React.StrictMode>);
