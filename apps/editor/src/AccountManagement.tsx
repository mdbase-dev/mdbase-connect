import {
  ManagementApiError,
  type AccountData,
  type AccountSession,
  type ConnectManagementClient,
  type ManagementOverview
} from "@mdbase/connect-management";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  ConnectEmpty as Empty,
  ConnectPage as Page,
  ConnectSectionTitle as SectionTitle
} from "./ConnectPrimitives";
import { GoogleIdentityButton } from "./GoogleIdentityButton";

export function AccountManagement({ client, overview, sessions, onOverviewRefresh, onDeleted }: {
  client: ConnectManagementClient;
  overview: ManagementOverview;
  sessions?: AccountSession[];
  onOverviewRefresh(): Promise<void>;
  onDeleted(): void;
}) {
  const [account, setAccount] = useState<AccountData>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const busyRef = useRef(new Set<string>());
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [deletionOpen, setDeletionOpen] = useState(false);
  const [deletionConfirmation, setDeletionConfirmation] = useState("");
  const [deletionPassword, setDeletionPassword] = useState("");
  const [reauthenticationToken] = useState(tokenFromFragment);
  const [googleAction, setGoogleAction] = useState<"link" | "delete" | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      setAccount(await client.account({ signal }));
      setError("");
    } catch (reason) {
      if (signal?.aborted) return;
      if (reason instanceof ManagementApiError && reason.status === 401) {
        location.href = loginUrl(client);
        return;
      }
      setError(errorMessage(reason));
    }
  }, [client]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    const linked = new URLSearchParams(location.search).get("linked");
    if (linked !== "github" && linked !== "google") return;
    setNotice(`${providerLabel(linked)} is now connected.`);
    const url = new URL(location.href);
    url.searchParams.delete("linked");
    history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  async function run(id: string, action: () => Promise<void>, success?: string): Promise<boolean> {
    if (!beginOperation(id)) return false;
    setError("");
    setNotice("");
    try {
      await action();
      if (success) setNotice(success);
      await Promise.all([refresh(), onOverviewRefresh()]);
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    } finally {
      finishOperation(id);
    }
  }

  function beginOperation(id: string): boolean {
    if (busyRef.current.has(id)) return false;
    busyRef.current.add(id);
    setBusy(new Set(busyRef.current));
    return true;
  }

  function finishOperation(id: string): void {
    busyRef.current.delete(id);
    setBusy(new Set(busyRef.current));
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== passwordConfirmation) {
      setError("New passwords do not match.");
      return;
    }
    const changed = await run("password", () => client.changePassword(currentPassword, newPassword));
    if (changed) {
      setCurrentPassword("");
      setNewPassword("");
      setPasswordConfirmation("");
      setPasswordOpen(false);
      setNotice("Password changed. Other browser sessions were signed out.");
    }
  }

  async function deleteAccount(event: FormEvent) {
    event.preventDefault();
    if (!beginOperation("delete")) return;
    setError("");
    try {
      await client.deleteAccount({
        confirmation: deletionConfirmation,
        currentPassword: deletionPassword || undefined,
        reauthenticationToken: reauthenticationToken || undefined
      });
      const url = new URL(location.href);
      url.pathname = "/connect/account-deleted";
      url.searchParams.delete("collection");
      url.searchParams.delete("linked");
      url.hash = "";
      history.replaceState(null, "", `${url.pathname}${url.search}`);
      onDeleted();
    } catch (reason) {
      setError(errorMessage(reason));
      finishOperation("delete");
    }
  }

  const googleCompleted = useCallback(() => undefined, []);
  const googleFailed = useCallback((reason: unknown) => {
    setError(errorMessage(reason));
    setGoogleAction(null);
  }, []);

  if (!account) {
    return <Page title="Account" intro="Manage hosted storage, sign-in methods, and browser sessions.">
      <p className="connect-muted" role="status">{error || "Loading account details…"}</p>
    </Page>;
  }

  const linkedByProvider = new Map(account.authentication.identities.map((identity) => [identity.provider, identity]));
  const providers = (["github", "google"] as const).filter((provider) =>
    account.authentication.available_providers[provider] || linkedByProvider.has(provider));
  const otherSessions = sessions?.filter((session) => !session.current) ?? [];
  const canPasswordDelete = account.authentication.password.configured;
  const canExternalDelete = account.authentication.identities.length > 0;
  const deletionAuthorized = account.deletion.development_confirmation
    || Boolean(reauthenticationToken)
    || Boolean(deletionPassword);
  return <Page title="Account" intro="Manage hosted storage, sign-in methods, and browser sessions.">
    {error && <div className="connect-account-message error" role="alert">{error}</div>}
    {notice && <div className="connect-account-message success" role="status">{notice}</div>}

    <section>
      <SectionTitle title="Hosted storage" note="Local collection files stay on your computers and are not measured here." />
      {overview.subscription && <SubscriptionStorage subscription={overview.subscription} fallbackStorage={account.storage} />}
      <div className="connect-account-list">
        <div className="connect-account-row">
          <div><strong>Used by hosted collections</strong><small>{storageDetail(account)}</small></div>
          <span>{account.storage.total_storage_bytes === null ? "Unavailable" : formatBytes(account.storage.total_storage_bytes)}</span>
        </div>
        {account.storage.collections.map((collection) => <StorageRow key={collection.id} collection={collection} />)}
      </div>
    </section>

    <section>
      <SectionTitle title="Sign-in methods" note="Connect more than one method so you always have a way back into your account." />
      {!account.authentication.managed ? <Empty title="Managed by your tailnet" body="Sign-in methods for this account are controlled by Tailscale." /> : <div className="connect-account-list">
        {providers.map((provider) => {
          const identity = linkedByProvider.get(provider);
          return <div className="connect-account-row" key={provider}>
            <div><strong>{providerLabel(provider)}</strong><small>{identity ? identityDescription(identity) : "Not connected"}{identity?.current ? " · current session" : ""}</small></div>
            <div className="connect-account-actions">
              {!identity && provider === "github" && <a className="connect-account-action" href={client.githubAccountFlowUrl("link")}>Connect</a>}
              {!identity && provider === "google" && googleAction !== "link" && <button className="connect-account-action" onClick={() => setGoogleAction("link")}>Connect</button>}
              {!identity && provider === "google" && googleAction === "link" && <GoogleIdentityButton client={client} purpose="link" onComplete={googleCompleted} onError={googleFailed} />}
              {identity && <button className="connect-account-action" disabled={!identity.removable || busy.has(`disconnect-${provider}`)} title={!identity.removable ? identity.current ? "This method is used by the current session." : "This is your only sign-in method." : undefined} onClick={() => void run(`disconnect-${provider}`, () => client.disconnectIdentity(provider), `${providerLabel(provider)} disconnected.`)}>{busy.has(`disconnect-${provider}`) ? "Disconnecting…" : "Disconnect"}</button>}
            </div>
          </div>;
        })}
        {(account.authentication.available_providers.password || account.authentication.password.configured) && <div className="connect-account-row connect-account-row-stack">
          <div className="connect-account-row-main"><div><strong>Email and password</strong><small>{account.authentication.password.configured ? account.authentication.password.email ?? "Configured" : "Not configured"}{account.authentication.password.current ? " · current session" : ""}</small></div>
            {account.authentication.password.change_available && <button className="connect-account-action" onClick={() => setPasswordOpen((open) => !open)}>{passwordOpen ? "Cancel" : "Change password"}</button>}
          </div>
          {passwordOpen && <form className="connect-account-form" onSubmit={(event) => void changePassword(event)}>
            <label><span>Current password</span><input type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
            <label><span>New password</span><input type="password" autoComplete="new-password" minLength={15} required aria-describedby="account-password-guidance" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
            <p className="connect-muted" id="account-password-guidance">Use at least 15 characters. Spaces are welcome.</p>
            <label><span>Confirm new password</span><input type="password" autoComplete="new-password" minLength={15} required value={passwordConfirmation} onChange={(event) => setPasswordConfirmation(event.target.value)} /></label>
            <button className="connect-primary-action" disabled={busy.has("password")}>{busy.has("password") ? "Changing password…" : "Change password"}</button>
          </form>}
        </div>}
      </div>}
    </section>

    {account.authentication.managed && <section>
      <SectionTitle title="Browser sessions" count={sessions?.length} action={otherSessions.length > 0 && <button className="danger" disabled={busy.has("sessions-others")} onClick={() => void run("sessions-others", () => client.revokeOtherSessions())}>Sign out other sessions</button>} />
      {!sessions && <p className="connect-muted">Checking active sessions…</p>}
      {sessions?.map((session) => <div className="connect-row" key={session.id}>
        <div><strong>{session.client_name}</strong><small>{session.current ? "This browser, active now" : `Last used ${relativeTime(session.last_seen_at)}`}</small></div>
        <span>{providerLabel(session.provider)}</span>
        {session.current ? <span className="connect-current">Current</span> : <button className="danger" disabled={busy.has(`session-${session.id}`)} onClick={() => void run(`session-${session.id}`, () => client.revokeSession(session.id))}>Sign out</button>}
      </div>)}
      <button className="connect-sign-out" onClick={() => void client.logout().then(() => { location.href = loginUrl(client); })}>Sign out of this browser</button>
    </section>}

    <section>
      <SectionTitle title="Account details" note="Identity and service configuration." />
      <dl className="connect-account-details"><div><dt>Name</dt><dd>{overview.user.name}</dd></div><div><dt>Identity</dt><dd>{identityLabel(overview.user)}</dd></div><div><dt>Authentication</dt><dd>{providerLabel(overview.authentication.provider)}</dd></div><div><dt>Registration</dt><dd>{registrationLabel(overview.authentication.registration)}</dd></div></dl>
    </section>

    <section className="connect-danger-section">
      <SectionTitle title="Delete account" note="Permanent for hosted data. Local files are never removed from your computers." />
      {!account.deletion.available ? <p>This account is managed by your tailnet and cannot be deleted here.</p> : !deletionOpen ? <button className="connect-account-danger" onClick={() => setDeletionOpen(true)}>Delete account…</button> : <form className="connect-account-form" onSubmit={(event) => void deleteAccount(event)}>
        <div className="connect-deletion-effects">
          <p><strong>This permanently deletes:</strong></p>
          <ul><li>{pluralLabel(account.deletion.hosted_collections, "hosted collection", "hosted collections")} and their stored data</li><li>Application access and {pluralLabel(account.deletion.computers, "connected computer", "connected computers")}</li><li>Every browser session and sign-in method</li></ul>
          <p><strong>Local collection and mirror files remain on your computers.</strong></p>
        </div>
        {!account.deletion.development_confirmation && !reauthenticationToken && <div className="connect-account-reauthentication">
          <strong>Confirm your identity</strong>
          {canPasswordDelete && <label><span>Current password</span><input type="password" autoComplete="current-password" value={deletionPassword} onChange={(event) => setDeletionPassword(event.target.value)} /></label>}
          {canExternalDelete && <div className="connect-account-actions">
            {account.authentication.identities.some(({ provider }) => provider === "github") && <a className="connect-account-action" href={client.githubAccountFlowUrl("reauth_delete")}>Verify with GitHub</a>}
            {account.authentication.identities.some(({ provider }) => provider === "google") && googleAction !== "delete" && <button type="button" className="connect-account-action" onClick={() => setGoogleAction("delete")}>Verify with Google</button>}
          </div>}
          {googleAction === "delete" && <GoogleIdentityButton client={client} purpose="reauth_delete" onComplete={googleCompleted} onError={googleFailed} />}
          {!canPasswordDelete && !canExternalDelete && <p className="connect-muted">No supported reauthentication method is connected.</p>}
        </div>}
        {reauthenticationToken && <p className="connect-current" role="status">Identity confirmed for this deletion.</p>}
        <label><span>Type DELETE to confirm</span><input autoComplete="off" spellCheck={false} value={deletionConfirmation} onChange={(event) => setDeletionConfirmation(event.target.value)} /></label>
        <div className="connect-account-actions"><button type="button" className="connect-account-action" disabled={busy.has("delete")} onClick={() => { setDeletionOpen(false); setDeletionConfirmation(""); setDeletionPassword(""); }}>Cancel</button><button className="connect-account-danger" disabled={busy.has("delete") || deletionConfirmation !== "DELETE" || !deletionAuthorized}>{busy.has("delete") ? "Deleting account…" : "Delete account permanently"}</button></div>
      </form>}
    </section>
  </Page>;
}

export function DeletedAccount({ client }: { client: ConnectManagementClient }) {
  return <main className="connect-deleted-account"><div><h1>Your account has been deleted.</h1><span>Hosted data and access credentials were removed. Any local collection and mirror files remain on your computers.</span><a className="connect-account-action" href={new URL("/login", client.baseUrl).href}>Return to sign in</a></div></main>;
}

function StorageRow({ collection }: { collection: AccountData["storage"]["collections"][number] }) {
  const usage = collection.usage;
  const liveBytes = usage ? usage.content_bytes + usage.file_bytes : null;
  return <div className="connect-account-row">
    <div>
      <strong>{collection.display_name}</strong>
      <small>{usage
        ? `${pluralLabel(usage.record_count, "record", "records")} · ${pluralLabel(usage.file_count, "file", "files")} · ${formatBytes(usage.content_bytes)} Markdown · ${formatBytes(usage.file_bytes)} files`
        : "Usage temporarily unavailable"}</small>
    </div>
    <span>{liveBytes === null ? "Unavailable" : formatBytes(liveBytes)}</span>
  </div>;
}

function SubscriptionStorage({ subscription, fallbackStorage }: {
  subscription: NonNullable<ManagementOverview["subscription"]>;
  fallbackStorage: AccountData["storage"];
}) {
  const liveStorageBytes = subscription.usage?.live_storage_bytes ?? fallbackStorage.total_storage_bytes;
  const liveContentBytes = subscription.usage?.live_content_bytes ?? fallbackStorage.total_content_bytes;
  const liveFileBytes = subscription.usage?.live_file_bytes ?? fallbackStorage.total_file_bytes;
  const limit = subscription.limits.hosted_storage_bytes;
  const percentage = liveStorageBytes !== null && limit > 0
    ? Math.min(100, liveStorageBytes / limit * 100)
    : 0;
  const tier = subscription.kind === "beta" ? "Beta" : "Included storage";
  const permanence = subscription.permanent ? "Permanent allowance" : "Current allowance";
  return <div className="connect-subscription-storage">
    <div className="connect-subscription-heading">
      <div><strong>{tier}</strong><small>{permanence}</small></div>
      <span>{liveStorageBytes === null ? "Usage unavailable" : `${formatBytes(liveStorageBytes)} of ${formatBytes(limit)}`}</span>
    </div>
    {liveStorageBytes !== null && <div className="connect-storage-progress" role="progressbar" aria-label={`${tier} hosted storage`} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={liveStorageBytes} aria-valuetext={`${formatBytes(liveStorageBytes)} of ${formatBytes(limit)} used`}><span style={{ width: `${percentage}%` }} /></div>}
    <p>{liveContentBytes === null || liveFileBytes === null
      ? "Markdown and file usage is temporarily unavailable."
      : `${formatBytes(liveContentBytes)} Markdown · ${formatBytes(liveFileBytes)} files`}</p>
    {subscription.limits.retained_file_bytes > 0 && <p>{subscription.usage
      ? `${formatBytes(subscription.usage.retained_file_bytes)} of ${formatBytes(subscription.limits.retained_file_bytes)} retained file storage`
      : `${formatBytes(subscription.limits.retained_file_bytes)} retained file storage included`}</p>}
    <p>Documents up to {formatBytes(subscription.limits.max_document_bytes)} · files up to {formatBytes(subscription.limits.max_single_file_bytes)} · {pluralLabel(subscription.limits.max_mirror_replicas_per_collection, "synced folder", "synced folders")} · {pluralLabel(subscription.limits.max_application_replicas_per_collection, "application installation", "application installations")} per collection</p>
  </div>;
}

function tokenFromFragment(): string | null {
  const value = new URLSearchParams(location.hash.slice(1)).get("delete_token");
  return value && /^act_[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

function storageDetail(account: AccountData): string {
  const collections = pluralLabel(account.storage.collections.length, "hosted collection", "hosted collections");
  if (account.storage.status === "unavailable") return `${collections} · usage temporarily unavailable`;
  const records = pluralLabel(account.storage.total_records ?? 0, "record", "records");
  const files = account.storage.collections.reduce((total, collection) => total + (collection.usage?.file_count ?? 0), 0);
  return `${collections} · ${records} · ${pluralLabel(files, "file", "files")}${account.storage.status === "partial" ? " · partial usage" : ""}`;
}

function providerLabel(provider: string): string {
  if (provider === "github") return "GitHub";
  if (provider === "google") return "Google";
  if (provider === "password") return "Email and password";
  if (provider === "tailscale") return "Tailscale identity";
  return "Browser session";
}

function identityDescription(identity: AccountData["authentication"]["identities"][number]): string {
  if (identity.provider === "github" && identity.login) return `@${identity.login}`;
  return identity.email ?? "Connected";
}

function identityLabel(user: ManagementOverview["user"]): string {
  return user.login ? `@${user.login}` : user.email ?? "Identity unavailable";
}

function registrationLabel(value: ManagementOverview["authentication"]["registration"]): string {
  if (value === "open") return "Open registration";
  if (value === "invite") return "Invitation required";
  return "Closed registration";
}

function pluralLabel(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} ${value === 1 ? "byte" : "bytes"}`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value;
  let index = -1;
  do { amount /= 1_024; index += 1; } while (amount >= 1_024 && index < units.length - 1);
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: amount < 10 ? 1 : 0 }).format(amount)} ${units[index]}`;
}

function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1_000));
  if (seconds < 60) return "just now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function loginUrl(client: ConnectManagementClient): string {
  const url = new URL("/login", client.baseUrl);
  url.searchParams.set("return_to", "/account");
  return url.href;
}

function errorMessage(value: unknown): string {
  const detail = value instanceof Error ? value.message : String(value);
  return /failed to fetch|networkerror|network request failed/i.test(detail)
    ? "mdbase connect could not be reached. Check your connection and try again."
    : detail;
}
