import "@fontsource/atkinson-hyperlegible/latin-400.css";
import "@fontsource/atkinson-hyperlegible/latin-700.css";
import "@fontsource/azeret-mono/latin-400.css";
import "@fontsource/azeret-mono/latin-500.css";
import "@fontsource/azeret-mono/latin-600.css";
import {
  authorizationOperationLabel,
  groupApplicationAccess,
  groupAuthorizationOperations,
  type ApplicationAccessGroup
} from "@mdbase/connect-ui/access";
import { applyThemePreference, loadThemePreference, saveThemePreference, type ThemePreference } from "@mdbase/connect-ui/theme";
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
  type PendingAuthorization,
  type TypeProvision
} from "./api";
import { collectionCompatibility } from "./compatibility";
import "./styles.css";

const allOperations = ["describe", "changes", "read", "query", "list_views", "execute_view", "read_view_source", "validate", "create", "update", "delete", "rename", "create_view_source", "update_view_source", "delete_view_source", "read_type", "create_type", "update_type", "list_timers", "put_timer", "cancel_timer", "reconcile_timers"];

function Portal() {
  const pairingId = location.pathname.match(/^\/pair\/([0-9a-f-]+)$/i)?.[1];
  const mirrorPairingId = location.pathname.match(/^\/mirror\/([0-9a-f-]+)$/i)?.[1];
  const authorizationId = location.pathname.match(/^\/authorize\/([0-9a-f-]+)$/i)?.[1];
  if (location.pathname === "/login") return <Login />;
  if (pairingId) return <Pairing pairingId={pairingId} />;
  if (mirrorPairingId) return <MirrorPairing pairingId={mirrorPairingId} />;
  if (authorizationId) return <Authorization requestId={authorizationId} />;
  return <Dashboard />;
}

function Login() {
  const [name, setName] = useState("Callum");
  const [email, setEmail] = useState("callum@example.com");
  const [config, setConfig] = useState<AuthConfig | null>(null);
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
          setConfig(await api<AuthConfig>("/v1/auth/config"));
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

  if (!config) return <Loading error={error} />;
  if (config.provider === "tailscale") return (
    <main className="center-page">
      <PageBrand label="connect" />
      <section className="auth-panel">
        <p className="eyebrow">Tailnet identity</p>
        <h1>Open this through Tailscale.</h1>
        <p>mdbase connect signs you in from your tailnet identity. Make sure this device is connected to your tailnet, then reload this page.</p>
        {error && <div className="message error">{error}</div>}
        <button className="button primary" onClick={() => location.reload()}>Try again</button>
      </section>
    </main>
  );
  const providers = config.providers.length > 0
    ? config.providers
    : config.provider === "github"
      ? [{ id: "github" as const, label: "Continue with GitHub", login_url: "/auth/github" }]
      : [];
  if (providers.length > 0) return (
    <main className="center-page">
      <PageBrand label="connect" />
      <section className="auth-panel">
        <p className="eyebrow">{config.registration === "open" ? "Account access" : "Private preview"}</p>
        <h1>Sign in to mdbase connect</h1>
        <p>{config.registration === "open"
          ? "Choose an identity provider to create or open your account."
          : "Access is currently limited to invited accounts."}</p>
        {error && <div className="message error" role="alert">{error}</div>}
        <div className="auth-providers">
          {providers.map((provider, index) => <React.Fragment key={provider.id}>
            {index > 0 && <div className="provider-divider"><span>or</span></div>}
            {provider.id === "google"
              ? <GoogleSignIn returnTo={returnTarget()} onError={setError} />
              : <a className="button primary link-button provider-button" href={`${provider.login_url}?return_to=${encodeURIComponent(returnTarget())}`}>
                  {provider.label}
                </a>}
          </React.Fragment>)}
        </div>
      </section>
    </main>
  );

  return (
    <main className="center-page">
      <PageBrand label="connect" />
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

interface AuthProviderOption {
  id: "google" | "github";
  label: string;
  login_url: string;
}

interface AuthConfig {
  provider: "google" | "github" | "tailscale" | "development" | "session";
  providers: AuthProviderOption[];
  registration: "closed" | "open";
  development_login: boolean;
}

interface GoogleAccountsApi {
  accounts: {
    id: {
      initialize(config: {
        client_id: string;
        nonce: string;
        auto_select: boolean;
        use_fedcm_for_button: boolean;
        callback(response: { credential: string }): void;
      }): void;
      renderButton(element: HTMLElement, config: {
        type: "standard";
        theme: "outline";
        size: "large";
        text: "continue_with";
        shape: "rectangular";
        logo_alignment: "left";
        width: number;
      }): void;
    };
  };
}

let googleLibrary: Promise<GoogleAccountsApi> | null = null;

function GoogleSignIn({ returnTo, onError }: { returnTo: string; onError(value: string): void }) {
  const button = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    async function prepare() {
      try {
        setReady(false);
        const start = await api<{ client_id: string; nonce: string }>(
          `/auth/google?return_to=${encodeURIComponent(returnTo)}`
        );
        const google = await loadGoogleIdentityServices();
        if (!active || !button.current) return;
        button.current.replaceChildren();
        google.accounts.id.initialize({
          client_id: start.client_id,
          nonce: start.nonce,
          auto_select: false,
          use_fedcm_for_button: true,
          callback: (response) => {
            if (!active) return;
            setBusy(true);
            void api<{ redirect_to: string }>("/auth/google/callback", {
              method: "POST",
              headers: { "x-mdbase-auth": "google" },
              body: JSON.stringify({ credential: response.credential })
            }).then((result) => {
              location.href = result.redirect_to;
            }).catch((reason) => {
              onError(message(reason));
              setBusy(false);
              setAttempt((value) => value + 1);
            });
          }
        });
        const width = Math.min(400, Math.max(240, Math.floor(button.current.clientWidth)));
        google.accounts.id.renderButton(button.current, {
          type: "standard",
          theme: "outline",
          size: "large",
          text: "continue_with",
          shape: "rectangular",
          logo_alignment: "left",
          width
        });
        setReady(true);
      } catch (reason) {
        if (active) onError(message(reason));
      }
    }
    void prepare();
    return () => { active = false; };
  }, [attempt, onError, returnTo]);

  return <div className={`google-provider ${busy ? "busy" : ""}`} aria-busy={busy}>
    <div ref={button} className="google-button" />
    {!ready && <span className="provider-loading">Preparing Google sign-in…</span>}
  </div>;
}

function loadGoogleIdentityServices(): Promise<GoogleAccountsApi> {
  const current = (window as unknown as { google?: GoogleAccountsApi }).google;
  if (current?.accounts?.id) return Promise.resolve(current);
  if (googleLibrary) return googleLibrary;
  googleLibrary = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => {
      const loaded = (window as unknown as { google?: GoogleAccountsApi }).google;
      if (loaded?.accounts?.id) resolve(loaded);
      else reject(new Error("Google sign-in did not load correctly."));
    };
    script.onerror = () => reject(new Error("Google sign-in could not be loaded."));
    document.head.append(script);
  });
  return googleLibrary;
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
  const activeGrants = data.grants.filter((grant) => !grant.revoked_at);
  const applicationAccess = groupApplicationAccess(activeGrants);

  return (
    <div className="account-shell">
      <header className="product-header account-header">
        <div className="product-header-inner">
          <Brand productLabel />
          <div className="product-header-meta">
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
                  collections={[
                    ...data.collections.filter((collection) => collection.enabled)
                      .map((collection) => ({ ...collection, kind: "local" as const })),
                    ...data.hosted_collections.map((collection) => ({
                      ...collection,
                      kind: "hosted" as const,
                      connector_name: "Hosted by mdbase"
                    }))
                  ]}
                  onDecision={refresh}
                  onCollectionCreated={() => void refresh()}
                />
              </article>
            ))}</div></>}
        </section>
        <section id="hosted">
          <HostedCollections collections={data.hosted_collections} onChanged={refresh} onError={setError} />
        </section>
        <section id="permissions">
          <SectionHeading title="Application access" note="Applications are grouped here; expand one to review its collection access." count={applicationAccess.length} />
          {applicationAccess.length === 0 ? (
            <Empty title="No applications connected" text="Approved website connections will appear here." />
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
              return <ComputerRow key={connector.id} connector={connector} collectionCount={collections.length} availableCount={collections.filter((collection) => collection.enabled).length} onChanged={refresh} onError={setError} />;
            })}</div>
          )}
        </section>
        <section id="account">
          <SectionHeading title="Account" note="Authentication and service details." />
          <div className="account-rows"><AccountRow label="Authentication" value={authenticationLabel(data.authentication.provider)} detail={data.authentication.provider === "tailscale" ? "Controlled by your tailnet" : undefined} /><AccountRow label="Registration" value={data.authentication.registration === "open" ? "Open" : "Invitation only"} detail={data.authentication.registration === "open" ? "New identities may create an account" : "New accounts require service access"} /></div>
          {data.authentication.provider !== "tailscale" && <button className="button secondary" onClick={() => void api("/v1/logout", { method: "POST" }).then(() => { location.href = "/login"; })}>Sign out</button>}
        </section>
      </main>
    </div>
  );
}

function HostedCollections({ collections, onChanged, onError }: {
  collections: HostedCollection[];
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
      note="Keep the authoritative Markdown on mdbase, with optional local mirrors."
      count={collections.length}
    />
    {collections.length === 0 && !creating
      ? <Empty title="No hosted collections" text="Create an mdbase collection whose source of truth stays available without a connected computer." />
      : <div className="hosted-list">{collections.map((collection) => (
          <HostedCollectionRow key={collection.id} collection={collection} onChanged={onChanged} onError={onError} />
        ))}</div>}
    {creating ? <form className="inline-create" onSubmit={(event) => void create(event)}>
      <label><span>Collection name</span><input autoFocus maxLength={200} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <p>Starts as a clean mdbase 0.3 collection. Add Markdown through compatible apps, with an optional exact local mirror.</p>
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
  const [busy, setBusy] = useState(false);
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
      <div><strong>{collection.display_name}</strong><small>mdbase · authoritative on mdbase · created {relativeTime(collection.created_at)}</small></div>
      <span className="availability online"><i />Hosted</span>
      <span className="replica-count">{activeReplicas.length} {activeReplicas.length === 1 ? "mirror" : "mirrors"}</span>
      <div className="computer-actions"><button className="quiet-action" disabled={busy} onClick={() => setPanel(panel === "mirror" ? null : "mirror")}>Sync folder</button><button className="quiet-action" disabled={busy} onClick={() => setPanel(panel === "rename" ? null : "rename")}>Rename</button><button className="quiet-danger" disabled={busy} onClick={() => void remove()}>Delete</button></div>
    </div>
    {panel === "rename" && <form className="hosted-detail hosted-rename" onSubmit={(event) => void rename(event)}>
      <label><span>Collection name</span><input autoFocus maxLength={200} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <div><button type="button" className="quiet-action" disabled={busy} onClick={() => setPanel(null)}>Cancel</button><button className="button primary" disabled={busy || !name.trim() || name.trim() === collection.display_name}>Save</button></div>
    </form>}
    {panel === "mirror" && <div className="hosted-detail">
      <MirrorSetup collectionId={collection.id} />
    </div>}
    {activeReplicas.length > 0 && <details className="replica-detail">
      <summary>Manage mirrors</summary>
      <div>{activeReplicas.map((replica) => <div className="replica-row" key={replica.id}>
        <div><strong>{replica.name}</strong><small>{mirrorStatus(replica)}</small></div>
        <div><button className="quiet-danger" disabled={busy} onClick={() => void revoke(replica.id, replica.name)}>Revoke</button></div>
      </div>)}</div>
    </details>}
  </article>;
}

function mirrorStatus(replica: HostedCollection["replicas"][number]): string {
  const mode = replica.mode === "read_only" ? "Receive-only" : "Two-way";
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
  const command = `mdbase-mirror connect ./collection --server ${location.origin} --collection ${collectionId}`;
  const [copied, setCopied] = useState(false);
  async function copy(value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(true);
  }
  return <div className="mirror-setup" aria-live="polite">
    <p><strong>Run this on the computer that owns the folder.</strong> Your browser will ask you to approve this collection. No credential is displayed or saved inside the folder.</p>
    <div className="copy-row"><code>{command}</code><button className="quiet-action" type="button" onClick={() => void copy(command)}>{copied ? "Copied" : "Copy command"}</button></div>
    <p>Existing Markdown is reviewed against the hosted collection before upload. Path collisions stop for an explicit decision.</p>
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
      <div className="application-access-identity"><strong>{group.applicationName}</strong><small>{host(identity.homepage)}</small></div>
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
      <PageBrand label="Computer pairing" />
      <section className="decision-panel">
        {deepLink ? <><p className="eyebrow">Computer approved</p><h1>Return to mdbase connect.</h1><p>The desktop app will finish securely. No connector token was displayed or copied.</p><a className="button primary link-button" href={deepLink}>Open mdbase connect</a></> : <><p className="eyebrow">New computer</p><h1>{pairing.connector_name}</h1><p>Allow this computer to connect to your account. It will publish collection names and route application requests, but not local folder paths.</p>{error && <div className="message error">{error}</div>}<div className="decision-actions"><a className="button secondary link-button" href="/">Cancel</a><button className="button primary" onClick={() => void approve()}>Approve computer</button></div></>}
      </section>
    </main>
  );
}

function MirrorPairing({ pairingId }: { pairingId: string }) {
  const [request, setRequest] = useState<{
    pairing: {
      mirror_name: string;
      mode: "read_only" | "read_write";
      collection_id: string | null;
      collection_hint?: string | null;
      approved_at: string | null;
      consumed_at: string | null;
    };
    collections: Array<{ id: string; display_name: string }>;
  } | null>(null);
  const [collectionId, setCollectionId] = useState("");
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<NonNullable<typeof request>>(`/v1/mirror-pairing-requests/${pairingId}`)
      .then((value) => {
        setRequest(value);
        setApproved(Boolean(value.pairing.approved_at));
        const preferred = value.collections.some(
          (collection) => collection.id === value.pairing.collection_hint
        )
          ? value.pairing.collection_hint!
          : value.collections[0]?.id ?? "";
        setCollectionId(value.pairing.collection_id ?? preferred);
      })
      .catch((reason) => {
        if (reason instanceof ApiError && reason.status === 401) {
          location.href = `/login?return_to=${encodeURIComponent(location.href)}`;
        } else {
          setError(message(reason));
        }
      });
  }, [pairingId]);

  async function approve() {
    if (!collectionId) return;
    setBusy(true);
    try {
      await api(`/v1/mirror-pairing-requests/${pairingId}/approve`, {
        method: "POST",
        body: JSON.stringify({ collection_id: collectionId })
      });
      setApproved(true);
      setError("");
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  if (!request) return <Loading error={error} />;
  const selected = request.collections.find((collection) => collection.id === collectionId);
  return (
    <main className="center-page">
      <PageBrand label="Folder sync" />
      <section className="decision-panel">
        {approved ? <>
          <p className="eyebrow outcome-label">Folder approved</p>
          <h1>Return to your computer.</h1>
          <p>
            {selected?.display_name ?? "The collection"} will begin syncing automatically.
            You can close this page.
          </p>
        </> : <>
          <p className="eyebrow">New synced folder</p>
          <h1>{request.pairing.mirror_name}</h1>
          <p>
            {request.pairing.mode === "read_write"
              ? "Markdown edits will sync in both directions. Concurrent edits remain separate until you choose a version."
              : "This folder will receive Markdown from mdbase and will not upload local edits."}
          </p>
          {error && <div className="message error" role="alert">{error}</div>}
          {request.collections.length ? <>
            <label>
              <span>Hosted collection</span>
              <select value={collectionId} onChange={(event) => setCollectionId(event.target.value)}>
                {request.collections.map((collection) => (
                  <option key={collection.id} value={collection.id}>{collection.display_name}</option>
                ))}
              </select>
            </label>
            <p className="field-note">
              Existing Markdown is checked before upload. Collection paths and device credentials stay off the control plane.
            </p>
            <div className="decision-actions">
              <a className="button secondary link-button" href="/">Cancel</a>
              <button className="button primary" disabled={busy || !collectionId} onClick={() => void approve()}>
                {busy ? "Approving…" : "Sync this collection"}
              </button>
            </div>
          </> : <>
            <div className="message">Create a hosted collection before approving this folder.</div>
            <div className="decision-actions">
              <a className="button primary link-button" href="/">Open your collections</a>
            </div>
          </>}
        </>}
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
  useSystemTheme();

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
      <PageBrand label="Application request" themePicker={false} />
      <section className="decision-panel authorization-panel">
        <RequestIdentity request={authorization} large />
        {status === "pending" ? <>
          <p>{authorization.application_name} is asking to use one collection. Choose where it can work and review what it can do.</p>
          {error && <div className="message error">{error}</div>}
          <ApprovalForm
            request={authorization}
            collections={request.collections}
            onDecision={(decision) => setStatus(decision)}
            onCollectionCreated={(collection) => setRequest((current) => current ? {
              ...current,
              collections: [...current.collections, collection]
            } : current)}
          />
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
        {request.requirements.access === "full_collection" ? (
          <small>Requests access to all record types in the selected collection.</small>
        ) : request.requirements.contracts.length > 0 && (
          <small>{scopeDescription(request.requirements.contracts)}</small>
        )}
        {request.requirements.collection_kind === "hosted" && (
          <small>Requires an mdbase cloud collection</small>
        )}
      </div>
    </div>
  );
}

function ApprovalForm({
  request,
  collections,
  onDecision,
  onCollectionCreated
}: {
  request: PendingAuthorization;
  collections: AvailableCollection[];
  onDecision(decision: "approved" | "denied"): void | Promise<void>;
  onCollectionCreated(collection: AvailableCollection): void;
}) {
  const choices = useMemo(() => collections.map((collection) => ({
    collection,
    compatibility: collectionCompatibility(request, collection)
  })), [collections, request]);
  const compatible = useMemo(
    () => choices.filter((choice) => choice.compatibility.compatible),
    [choices]
  );
  const unavailable = useMemo(
    () => choices.filter((choice) => !choice.compatibility.compatible),
    [choices]
  );
  const [collectionId, setCollectionId] = useState(compatible[0]?.collection.id ?? "");
  const [operations, setOperations] = useState(() => new Set(request.requested_operations));
  const [submitting, setSubmitting] = useState<"approved" | "denied" | "creating" | null>(null);
  const [error, setError] = useState("");
  const selected = compatible.find((choice) => choice.collection.id === collectionId)?.collection;
  const setup = selected ? neededProvisions(request, selected) : [];
  const permissionGroups = useMemo(
    () => groupAuthorizationOperations(request.requested_operations),
    [request.requested_operations]
  );

  useEffect(() => {
    if (!compatible.some((choice) => choice.collection.id === collectionId)) {
      setCollectionId(compatible[0]?.collection.id ?? "");
    }
  }, [collectionId, compatible]);

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

  async function createCloudCollection() {
    setSubmitting("creating");
    setError("");
    try {
      const tasknotes = request.requirements.contracts.some((contract) => contract.id === "tasknotes.task");
      const created = await api<{ collection: HostedCollection }>("/v1/hosted/collections", {
        method: "POST",
        body: JSON.stringify({
          display_name: tasknotes ? "My tasks" : "My collection",
          template: tasknotes ? "tasknotes" : "mdbase"
        })
      });
      const collection: AvailableCollection = {
        id: created.collection.id,
        display_name: created.collection.display_name,
        connector_name: "mdbase cloud",
        spec_version: created.collection.spec_version ?? "0.3.0",
        contracts: tasknotes ? [{ id: "tasknotes.task", version: 1 }] : [],
        kind: "hosted"
      };
      onCollectionCreated(collection);
      setCollectionId(collection.id);
    } catch (creationError) {
      setError(message(creationError));
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div className="approval-form" aria-busy={submitting !== null}>
      <section className="approval-section">
        <div className="approval-section-intro">
          <strong>Collection</strong>
          <small>Choose where {request.application_name} can work.</small>
        </div>
        <div className="approval-section-content">
          <label className="collection-field" htmlFor={`collection-${request.id}`}>
            <span>Collection and location</span>
            <select id={`collection-${request.id}`} value={collectionId} onChange={(event) => setCollectionId(event.target.value)} disabled={submitting !== null || compatible.length === 0}>
              {compatible.length === 0 && <option value="">No compatible collection</option>}
              {choices.map(({ collection, compatibility }) => <option value={collection.id} key={collection.id} disabled={!compatibility.compatible}>{collection.display_name} · {collection.connector_name}{compatibility.compatible ? (neededProvisions(request, collection).length ? " · setup required" : "") : ` · ${compatibility.label}`}</option>)}
            </select>
          </label>
          {unavailable.length > 0 && <details className="collection-compatibility">
            <summary>{compatible.length > 0
              ? `${unavailable.length} other ${unavailable.length === 1 ? "collection is" : "collections are"} unavailable`
              : `${unavailable.length} ${unavailable.length === 1 ? "collection is" : "collections are"} unavailable`}</summary>
            <ul>{unavailable.map(({ collection, compatibility }) => <li key={collection.id}><span>{collection.display_name}</span><small>{compatibility.compatible ? "" : compatibility.detail}</small></li>)}</ul>
          </details>}
          {compatible.length === 0 && <div className="authorization-empty-collection">
            <p className="field-note">No compatible collection is ready.</p>
            <button
              className="button secondary"
              type="button"
              disabled={submitting !== null}
              onClick={() => void createCloudCollection()}
            >{submitting === "creating" ? "Creating…" : "Create an mdbase cloud collection"}</button>
          </div>}
          {setup.length > 0 && <p className="field-note">Setup needed: allowing access will add {provisionNames(setup)} to this hosted collection.</p>}
        </div>
      </section>
      <section className="approval-section">
        <div className="approval-section-intro">
          <strong>Permissions</strong>
          <small>{request.requested_operations.length} specific actions across {permissionGroups.length} {permissionGroups.length === 1 ? "category" : "categories"}.</small>
        </div>
        <PermissionChoices
          groups={permissionGroups}
          selected={operations}
          disabled={submitting !== null}
          onToggle={toggleOperation}
        />
      </section>
      <NotificationAccess notifications={request.notifications} />
      {error && <div className="message error compact">{error}</div>}
      <footer className="approval-footer">
        <p>{selected
          ? `${request.application_name} will use ${selected.display_name} through ${selected.connector_name}. Access lasts until you revoke it.`
          : `Choose a compatible collection before allowing ${request.application_name}.`}</p>
        <div className="approval-actions">
          <button className="button secondary deny-button" type="button" disabled={submitting !== null} onClick={() => void decide("denied")}>{submitting === "denied" ? "Denying…" : "Deny"}</button>
          <button className="button primary" type="button" disabled={submitting !== null || !collectionId || operations.size === 0} onClick={() => void decide("approved")}>{submitting === "approved" ? "Approving…" : `Allow ${request.application_name}`}</button>
        </div>
      </footer>
    </div>
  );
}

function PermissionChoices({
  groups,
  selected,
  disabled,
  onToggle
}: {
  groups: ReturnType<typeof groupAuthorizationOperations>;
  selected: ReadonlySet<string>;
  disabled: boolean;
  onToggle(operation: string): void;
}) {
  const total = groups.reduce((count, group) => count + group.operations.length, 0);
  return (
    <details className="permission-review">
      <summary>
        <span><strong>{selected.size} of {total} selected</strong><small>Review or narrow individual actions</small></span>
        <b>Review</b>
      </summary>
      <div className="permission-groups">{groups.map((group) => (
        <fieldset className="permission-group" key={group.id}>
          <legend>{group.label}</legend>
          <p>{group.description}</p>
          <div>{group.operations.map((operation) => (
            <label key={operation.id}>
              <input type="checkbox" checked={selected.has(operation.id)} onChange={() => onToggle(operation.id)} disabled={disabled} />
              <span>{operation.label}</span>
            </label>
          ))}</div>
        </fieldset>
      ))}</div>
    </details>
  );
}

function NotificationAccess({ notifications }: {
  notifications: PendingAuthorization["notifications"];
}) {
  if (notifications.criteria.length === 0) return null;
  return (
    <details className="notification-access">
      <summary>
        <span><strong>Change notifications</strong><small>{notifications.criteria.length} optional {notifications.criteria.length === 1 ? "rule" : "rules"}; pushes contain no record content.</small></span>
        <b>Details</b>
      </summary>
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

function AccountRow({ label, value, detail, mono = false }: { label: string; value: string; detail?: string; mono?: boolean }) { return <div className="account-row"><span>{label}</span><div><strong className={mono ? "mono" : ""}>{value}</strong>{detail && <small>{detail}</small>}</div></div>; }
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
function useSystemTheme() {
  useEffect(() => {
    applyThemePreference("system");
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyThemePreference("system");
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
}
function PageBrand({ label, themePicker = true }: { label: string; themePicker?: boolean }) { return <div className="page-brand-row"><div className="page-brand"><Brand /><span>{label}</span></div>{themePicker && <ThemeSelect />}</div>; }
function Brand({ productLabel = false }: { productLabel?: boolean }) { return <div className="product-brand"><span className="product-brand-dot" aria-hidden="true" /><strong>mdbase</strong>{productLabel && <span className="product-brand-label">connect</span>}</div>; }
function SectionHeading({ title, note, count }: { title: string; note: string; count?: number }) { return <div className="section-heading"><div><h2>{title}</h2><p>{note}</p></div>{count !== undefined && <span>{count}</span>}</div>; }
function Empty({ title, text }: { title: string; text: string }) { return <div className="empty"><span className="empty-folder" /><strong>{title}</strong><p>{text}</p></div>; }
function Loading({ error = "" }: { error?: string }) { return <main className="loading"><Brand /><p>{error || "Opening mdbase connect…"}</p></main>; }
function initials(value: string) { return value.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(); }
function message(value: unknown) { return value instanceof Error ? value.message : String(value); }
function host(value: string) { try { return new URL(value).host; } catch { return value; } }
function pluralLabel(count: number, singular: string, pluralValue: string) { return `${count} ${count === 1 ? singular : pluralValue}`; }
function neededProvisions(
  request: Pick<PendingAuthorization, "requirements" | "provisions">,
  collection: Pick<AvailableCollection, "contracts">
): TypeProvision[] {
  const missing = request.requirements.contracts.filter((requirement) => !hasContract(collection.contracts, requirement));
  return request.provisions.types.filter((provision) =>
    provision.provides.some((provided) => missing.some((requirement) => sameContract(provided, requirement)))
  );
}

function hasContract(contracts: ContractRequirement[], required: ContractRequirement) { return contracts.some((contract) => sameContract(contract, required)); }
function sameContract(left: ContractRequirement, right: ContractRequirement) { return left.id === right.id && left.version === right.version; }
function provisionNames(provisions: TypeProvision[]) { return provisions.map((provision) => provision.name).join(" and "); }
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
  if (provider === "google") return "Google";
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
