import { countLabel } from "./count-label";
import { formatters } from "@mdbase-dev/i18n";
import { t, plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useLocaleRevision, i18n } from "@mdbase-dev/ui/i18n";
import {
  ManagementApiError,
  type AccountData,
  type AccountSession,
  type ConnectManagementClient,
  type EmailPreferences,
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
  useLocaleRevision();
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
  const [sharingCode, setSharingCode] = useState<{
    code: string;
    expiresAt: string;
  }>();

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
    setNotice(t(i18n)`${providerLabel(linked)} is now connected.`);
    const url = new URL(location.href);
    url.searchParams.delete("linked");
    history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  async function run(id: string, action: () => Promise<void>, success?: string): Promise<boolean> {
    if (!beginOperation(id)) return false;
    setError("");
    setNotice("");
    let saved = false;
    try {
      await action();
      saved = true;
      if (success) setNotice(success);
      await refresh();
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    } finally {
      finishOperation(id);
      // Refresh failure must not reinterpret an acknowledged mutation as failure.
      if (saved) void onOverviewRefresh().catch(() => {
        setError(t(i18n)({ message: "Your change was saved, but account details could not refresh. Reload to check the latest details." }));
      });
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

  async function signOutCurrentBrowser() {
    if (!beginOperation("logout")) return;
    setError("");
    setNotice("");
    try {
      await client.logout();
      location.href = loginUrl(client);
    } catch (reason) {
      setError(errorMessage(reason));
      finishOperation("logout");
    }
  }

  async function createSharingCode() {
    if (!beginOperation("sharing-code")) return;
    setError("");
    try {
      const created = await client.createCollectionInvitationCode();
      setSharingCode({
        code: created.invitation_code,
        expiresAt: created.expires_at
      });
      setNotice(t(i18n)({ message: "A new one-use sharing code is ready." }));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      finishOperation("sharing-code");
    }
  }

  async function setEmailPreference(preference: keyof EmailPreferences, enabled: boolean) {
    const label = preference === "announcements" ? t(i18n)({ message: "Announcements", context: "Account management" }) : t(i18n)({ message: "Product updates", context: "Account management" });
    await run(
      `email-${preference}`,
      async () => { await client.updateEmailPreferences({ [preference]: enabled }); },
      enabled ? t(i18n)`${label} turned on.` : t(i18n)`${label} turned off.`
    );
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== passwordConfirmation) {
      setError(t(i18n)({ message: "New passwords do not match." }));
      return;
    }
    const changed = await run("password", () => client.changePassword(currentPassword, newPassword));
    if (changed) {
      setCurrentPassword("");
      setNewPassword("");
      setPasswordConfirmation("");
      setPasswordOpen(false);
      setNotice(t(i18n)({ message: "Password changed. Other browser sessions were signed out." }));
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
      url.pathname = "/account-deleted";
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
    return <Page title={t(i18n)({ message: "Account", context: "Account management" })} intro={t(i18n)({ message: "Manage collections, sign-in methods, and browser sessions." })}>
      <p className="connect-muted" role="status">{error || t(i18n)({ message: "Loading account details…", context: "Account management" })}</p>
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
  return <Page title={t(i18n)({ message: "Account", context: "Account management" })} intro={t(i18n)({ message: "Manage collections, sign-in methods, and browser sessions." })}>
    {error && <div className="connect-account-message error" role="alert">{error}</div>}
    {notice && <div className="connect-account-message success" role="status">{notice}</div>}

    {account.backend === "next" && <section>
      <SectionTitle title={t(i18n)({ message: "Collections", context: "Connect interface" })} count={account.deletion.owned_collections} note={t(i18n)({ message: "Collections you own. Local files remain on your devices." })} />
      {(overview.native_collections ?? []).filter(collection => collection.access.relationship === "owner").map(collection => <div className="connect-account-row" key={collection.id}>
        <strong>{collection.display_name ?? t(i18n)({ message: "Unnamed collection", context: "Connect interface" })}</strong>
        <span>{collection.sync === "cloud_copy" ? t(i18n)({ message: "Cloud copy", context: "Connect interface" }) : t(i18n)({ message: "Private collection", context: "Connect interface" })}</span>
      </div>)}
    </section>}
    {(account.backend === "legacy" || account.storage.collections.length > 0) && <section>
      <SectionTitle title={t(i18n)({ message: "Hosted storage", context: "Account management" })} note={t(i18n)({ message: "Local collection files stay on your computers and are not measured here." })} />
      {overview.subscription && <SubscriptionStorage subscription={overview.subscription} fallbackStorage={account.storage} />}
      <div className="connect-account-list">
        <div className="connect-account-row">
          <div><strong><Trans>Used by hosted collections</Trans></strong><small>{storageDetail(account)}</small></div>
          <span>{account.storage.total_storage_bytes === null ? t(i18n)({ message: "Unavailable", context: "Account management" }) : formatBytes(account.storage.total_storage_bytes)}</span>
        </div>
        {account.storage.collections.map((collection) => <StorageRow key={collection.id} collection={collection} />)}
      </div>
    </section>}

    <section>
      <SectionTitle title={t(i18n)({ message: "Sign-in methods", context: "Account management" })} note={t(i18n)({ message: "Connect more than one method so you always have a way back into your account." })} />
      {!account.authentication.managed ? <Empty title={t(i18n)({ message: "Managed by your tailnet", context: "Account management" })} body={t(i18n)({ message: "Sign-in methods for this account are controlled by Tailscale." })} /> : <div className="connect-account-list">
        {providers.map((provider) => {
          const identity = linkedByProvider.get(provider);
          return <div className="connect-account-row" key={provider}>
            <div><strong>{providerLabel(provider)}</strong><small>{identity ? identityDescription(identity) : t(i18n)({ message: "Not connected", context: "Account management" })}{identity?.current ? t(i18n)({ message: " · current session", context: "Account management" }) : ""}</small></div>
            <div className="connect-account-actions">
              {!identity && provider === "github" && <a className="connect-account-action" href={client.githubAccountFlowUrl("link")}>Connect</a>}
              {!identity && provider === "google" && googleAction !== "link" && <button className="connect-account-action" onClick={() => setGoogleAction("link")}>Connect</button>}
              {!identity && provider === "google" && googleAction === "link" && <GoogleIdentityButton client={client} purpose="link" onComplete={googleCompleted} onError={googleFailed} />}
              {identity && <button className="connect-account-action" disabled={!identity.removable || busy.has(`disconnect-${provider}`)} title={!identity.removable ? identity.current ? t(i18n)({ message: "This method is used by the current session." }) : t(i18n)({ message: "This is your only sign-in method." }) : undefined} onClick={() => void run(`disconnect-${provider}`, () => client.disconnectIdentity(provider), t(i18n)`${providerLabel(provider)} disconnected.`)}>{busy.has(`disconnect-${provider}`) ? t(i18n)({ message: "Disconnecting…", context: "Account management" }) : t(i18n)({ message: "Disconnect", context: "Account management" })}</button>}
            </div>
          </div>;
        })}
        {(account.authentication.available_providers.password || account.authentication.password.configured) && <div className="connect-account-row connect-account-row-stack">
          <div className="connect-account-row-main"><div><strong><Trans>Email and password</Trans></strong><small>{account.authentication.password.configured ? account.authentication.password.email ?? t(i18n)({ message: "Configured", context: "Account management" }) : t(i18n)({ message: "Not configured", context: "Account management" })}{account.authentication.password.current ? t(i18n)({ message: " · current session", context: "Account management" }) : ""}</small></div>
            {account.authentication.password.change_available && <button className="connect-account-action" onClick={() => setPasswordOpen((open) => !open)}>{passwordOpen ? t(i18n)({ message: "Cancel", context: "Account management" }) : t(i18n)({ message: "Change password", context: "Account management" })}</button>}
          </div>
          {passwordOpen && <form className="connect-account-form" onSubmit={(event) => void changePassword(event)}>
            <label><span><Trans>Current password</Trans></span><input type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
            <label><span><Trans>New password</Trans></span><input type="password" autoComplete="new-password" minLength={15} required aria-describedby="account-password-guidance" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
            <p className="connect-muted" id="account-password-guidance"><Trans>Use at least 15 characters. Spaces are welcome.</Trans></p>
            <label><span><Trans>Confirm new password</Trans></span><input type="password" autoComplete="new-password" minLength={15} required value={passwordConfirmation} onChange={(event) => setPasswordConfirmation(event.target.value)} /></label>
            <button className="connect-primary-action mdbase-button is-primary" disabled={busy.has("password")}>{busy.has("password") ? t(i18n)({ message: "Changing password…", context: "Account management" }) : t(i18n)({ message: "Change password", context: "Account management" })}</button>
          </form>}
        </div>}
      </div>}
    </section>

    {overview.collection_sharing_available && <section>
      <SectionTitle title={t(i18n)({ message: "Sharing code", context: "Account management" })} note={t(i18n)({ message: "Use this when someone cannot invite your verified email address." })} />
      <div className="connect-account-row">
        <div><strong>{sharingCode?.code ?? t(i18n)({ message: "No active code shown", context: "Account management" })}</strong><small>{sharingCode ? t(i18n)`One use · expires ${relativeTime(sharingCode.expiresAt)}` : t(i18n)({ message: "Generate a private code, then send it to the collection owner." })}</small></div>
        <button className="connect-account-action" disabled={busy.has("sharing-code")} onClick={() => void createSharingCode()}>{busy.has("sharing-code") ? t(i18n)({ message: "Generating…", context: "Account management" }) : sharingCode ? t(i18n)({ message: "Generate a new code", context: "Account management" }) : t(i18n)({ message: "Generate code", context: "Account management" })}</button>
      </div>
    </section>}

    {account.authentication.managed && <section>
      <SectionTitle title={t(i18n)({ message: "Browser sessions", context: "Account management" })} count={sessions?.length} action={otherSessions.length > 0 && <button className="danger" disabled={busy.has("sessions-others")} onClick={() => void run("sessions-others", () => client.revokeOtherSessions())}><Trans>Sign out other sessions</Trans></button>} />
      <div className="connect-row-actions connect-session-actions" role="group" aria-label={t(i18n)({ message: "Browser session actions", context: "Account management" })}>
        <button className="danger" disabled={busy.has("logout")} aria-busy={busy.has("logout") || undefined} onClick={() => void signOutCurrentBrowser()}>{busy.has("logout") ? t(i18n)({ message: "Signing out…", context: "Account management" }) : t(i18n)({ message: "Sign out of this browser", context: "Account management" })}</button>
      </div>
      {!sessions && <p className="connect-muted"><Trans>Checking active sessions…</Trans></p>}
      {sessions?.map((session) => <div className="connect-row" key={session.id}>
        <div><strong>{session.client_name}</strong><small>{session.current ? t(i18n)({ message: "This browser, active now", context: "Account management" }) : t(i18n)`Last used ${relativeTime(session.last_seen_at)}`}</small><small><Trans>Signed in <time dateTime={session.created_at}>{formatters(i18n.locale).date(new Date(session.created_at), { dateStyle: "medium", timeStyle: "short" })}</time> · ID {session.id.slice(-8)}</Trans></small></div>
        <span>{providerLabel(session.provider)}</span>
        {session.current ? <span className="connect-current"><Trans context="Browser session status">Current</Trans></span> : <button className="danger" disabled={busy.has(`session-${session.id}`)} onClick={() => void run(`session-${session.id}`, () => client.revokeSession(session.id))}><Trans>Sign out</Trans></button>}
      </div>)}
    </section>}

    <section>
      <SectionTitle title={t(i18n)({ message: "Email", context: "Account management" })} note={account.user.email ? t(i18n)`Sent to ${account.user.email}.` : undefined} />
      <div className="connect-account-list">
        <div className="connect-account-row">
          <div><strong><Trans>Account email</Trans></strong><small><Trans>Verification and messages about your account. These are always sent.</Trans></small></div>
          <span><Trans>Always on</Trans></span>
        </div>
        <EmailPreferenceRow
          title={t(i18n)({ message: "Announcements", context: "Account management" })}
          description={t(i18n)({ message: "Occasional news about significant changes to mdbase Connect and new mdbase applications." })}
          checked={account.email_preferences.announcements}
          busy={busy.has("email-announcements")}
          onChange={(enabled) => void setEmailPreference("announcements", enabled)}
        />
        <EmailPreferenceRow
          title={t(i18n)({ message: "Product updates", context: "Account management" })}
          description={t(i18n)({ message: "More regular updates about new features and improvements." })}
          checked={account.email_preferences.product_updates}
          busy={busy.has("email-product_updates")}
          onChange={(enabled) => void setEmailPreference("product_updates", enabled)}
        />
      </div>
    </section>

    <section>
      <SectionTitle title={t(i18n)({ message: "Account details", context: "Account management" })} note={t(i18n)({ message: "Identity and service configuration." })} />
      <dl className="connect-account-details"><div><dt><Trans>Name</Trans></dt><dd>{overview.user.name}</dd></div><div><dt><Trans>Identity</Trans></dt><dd>{identityLabel(overview.user)}</dd></div><div><dt><Trans>Authentication</Trans></dt><dd>{providerLabel(overview.authentication.provider)}</dd></div><div><dt><Trans>Registration</Trans></dt><dd>{registrationLabel(overview.authentication.registration)}</dd></div></dl>
    </section>

    <section className="connect-danger-section">
      <SectionTitle title={t(i18n)({ message: "Delete account", context: "Account management" })} note={t(i18n)({ message: "Permanent for hosted data. Local files are never removed from your computers." })} />
      {!account.deletion.available ? <p>{account.deletion.unavailable_reason === "temporarily_disabled"
        ? t(i18n)({ message: "Account deletion is temporarily unavailable while we complete a service correction." })
        : t(i18n)({ message: "This account is managed by your tailnet and cannot be deleted here." })}</p> : !deletionOpen ? <button className="connect-account-danger" onClick={() => setDeletionOpen(true)}><Trans>Delete account…</Trans></button> : <form className="connect-account-form" onSubmit={(event) => void deleteAccount(event)}>
        <div className="connect-deletion-effects">
          <p><strong><Trans>This permanently deletes:</Trans></strong></p>
          <ul><li><Trans>{countLabel(account.deletion.owned_collections, "collection")} and their stored data</Trans></li><li><Trans>Application access and {countLabel(account.deletion.computers, "computer")}</Trans></li><li><Trans>Every browser session and sign-in method</Trans></li></ul>
          <p><strong><Trans>Local collection and mirror files remain on your computers.</Trans></strong></p>
        </div>
        {!account.deletion.development_confirmation && !reauthenticationToken && <div className="connect-account-reauthentication">
          <strong><Trans>Confirm your identity</Trans></strong>
          {canPasswordDelete && <label><span><Trans>Current password</Trans></span><input type="password" autoComplete="current-password" value={deletionPassword} onChange={(event) => setDeletionPassword(event.target.value)} /></label>}
          {canExternalDelete && <div className="connect-account-actions">
            {account.authentication.identities.some(({ provider }) => provider === "github") && <a className="connect-account-action" href={client.githubAccountFlowUrl("reauth_delete")}><Trans>Verify with GitHub</Trans></a>}
            {account.authentication.identities.some(({ provider }) => provider === "google") && googleAction !== "delete" && <button type="button" className="connect-account-action" onClick={() => setGoogleAction("delete")}><Trans>Verify with Google</Trans></button>}
          </div>}
          {googleAction === "delete" && <GoogleIdentityButton client={client} purpose="reauth_delete" onComplete={googleCompleted} onError={googleFailed} />}
          {!canPasswordDelete && !canExternalDelete && <p className="connect-muted"><Trans>No supported reauthentication method is connected.</Trans></p>}
        </div>}
        {reauthenticationToken && <p className="connect-current" role="status"><Trans>Identity confirmed for this deletion.</Trans></p>}
        <label><span><Trans>Type DELETE to confirm</Trans></span><input autoComplete="off" spellCheck={false} value={deletionConfirmation} onChange={(event) => setDeletionConfirmation(event.target.value)} /></label>
        <div className="connect-account-actions"><button type="button" className="connect-account-action" disabled={busy.has("delete")} onClick={() => { setDeletionOpen(false); setDeletionConfirmation(""); setDeletionPassword(""); }}><Trans>Cancel</Trans></button><button className="connect-account-danger" disabled={busy.has("delete") || deletionConfirmation !== "DELETE" || !deletionAuthorized}>{busy.has("delete") ? t(i18n)({ message: "Deleting account…", context: "Account management" }) : t(i18n)({ message: "Delete account permanently" })}</button></div>
      </form>}
    </section>
  </Page>;
}

export function DeletedAccount({ client }: { client: ConnectManagementClient }) {
  useLocaleRevision();
  return <main className="connect-deleted-account"><div><h1><Trans>Your account has been deleted.</Trans></h1><span><Trans>Hosted access was removed immediately. Hosted data deletion continues automatically in the background. Any local collection and mirror files remain on your computers.</Trans></span><a className="connect-account-action" href={new URL("/login", client.baseUrl).href}><Trans>Return to sign in</Trans></a></div></main>;
}

function EmailPreferenceRow({ title, description, checked, busy, onChange }: {
  title: string;
  description: string;
  checked: boolean;
  busy: boolean;
  onChange(enabled: boolean): void;
}) {
  useLocaleRevision();
  return <label className="connect-account-row">
    <div><strong>{title}</strong><small>{description}</small></div>
    <input className="mdbase-checkbox" type="checkbox" checked={checked} disabled={busy} onChange={(event) => onChange(event.target.checked)} />
  </label>;
}

function StorageRow({ collection }: { collection: AccountData["storage"]["collections"][number] }) {
  useLocaleRevision();
  const usage = collection.usage;
  const liveBytes = usage ? usage.content_bytes + usage.file_bytes : null;
  return <div className="connect-account-row">
    <div>
      <strong>{collection.display_name}</strong>
      <small>{usage
        ? t(i18n)`${countLabel(usage.record_count, "record")} · ${countLabel(usage.file_count, "file")} · ${formatBytes(usage.content_bytes)} Markdown · ${formatBytes(usage.file_bytes)} files`
        : t(i18n)({ message: "Usage temporarily unavailable" })}</small>
    </div>
    <span>{liveBytes === null ? t(i18n)({ message: "Unavailable", context: "Account management" }) : formatBytes(liveBytes)}</span>
  </div>;
}

function SubscriptionStorage({ subscription, fallbackStorage }: {
  subscription: NonNullable<ManagementOverview["subscription"]>;
  fallbackStorage: AccountData["storage"];
}) {
  useLocaleRevision();
  const liveStorageBytes = subscription.usage?.live_storage_bytes ?? fallbackStorage.total_storage_bytes;
  const liveContentBytes = subscription.usage?.live_content_bytes ?? fallbackStorage.total_content_bytes;
  const liveFileBytes = subscription.usage?.live_file_bytes ?? fallbackStorage.total_file_bytes;
  const limit = subscription.limits.hosted_storage_bytes;
  const percentage = liveStorageBytes !== null && limit > 0
    ? Math.min(100, liveStorageBytes / limit * 100)
    : 0;
  const tier = subscription.kind === "beta" ? t(i18n)({ message: "Beta", context: "Account management" }) : t(i18n)({ message: "Included storage", context: "Account management" });
  const permanence = subscription.permanent ? t(i18n)({ message: "Permanent allowance", context: "Account management" }) : t(i18n)({ message: "Current allowance", context: "Account management" });
  return <div className="connect-subscription-storage">
    <div className="connect-subscription-heading">
      <div><strong>{tier}</strong><small>{permanence}</small></div>
      <span>{liveStorageBytes === null ? t(i18n)({ message: "Usage unavailable", context: "Account management" }) : t(i18n)`${formatBytes(liveStorageBytes)} of ${formatBytes(limit)}`}</span>
    </div>
    {liveStorageBytes !== null && <div className="connect-storage-progress" role="progressbar" aria-label={t(i18n)`${tier} hosted storage`} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={liveStorageBytes} aria-valuetext={t(i18n)`${formatBytes(liveStorageBytes)} of ${formatBytes(limit)} used`}><span style={{ width: `${percentage}%` }} /></div>}
    <p>{liveContentBytes === null || liveFileBytes === null
      ? t(i18n)({ message: "Markdown and file usage is temporarily unavailable." })
      : t(i18n)`${formatBytes(liveContentBytes)} Markdown · ${formatBytes(liveFileBytes)} files`}</p>
    {subscription.limits.retained_file_bytes > 0 && <p>{subscription.usage
      ? t(i18n)`${formatBytes(subscription.usage.retained_file_bytes)} of ${formatBytes(subscription.limits.retained_file_bytes)} retained file storage`
      : t(i18n)`${formatBytes(subscription.limits.retained_file_bytes)} retained file storage included`}</p>}
    <p><Trans>Documents up to {formatBytes(subscription.limits.max_document_bytes)} · files up to {formatBytes(subscription.limits.max_single_file_bytes)} · {countLabel(subscription.limits.max_mirror_replicas_per_collection, "folder")} · {countLabel(subscription.limits.max_application_replicas_per_collection, "application-installation")} per collection</Trans></p>
  </div>;
}

function tokenFromFragment(): string | null {
  const value = new URLSearchParams(location.hash.slice(1)).get("delete_token");
  return value && /^act_[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

function storageDetail(account: AccountData): string {
  const collections = countLabel(account.storage.collections.length, "hosted-collection");
  if (account.storage.status === "unavailable") return t(i18n)`${collections} · usage temporarily unavailable`;
  const records = countLabel(account.storage.total_records ?? 0, "record");
  const files = account.storage.collections.reduce((total, collection) => total + (collection.usage?.file_count ?? 0), 0);
  const fileCount = countLabel(files, "file");
  return account.storage.status === "partial" ? t(i18n)`${collections} · ${records} · ${fileCount} · partial usage` : t(i18n)`${collections} · ${records} · ${fileCount}`;
}

function providerLabel(provider: string): string {
  if (provider === "github") return "GitHub";
  if (provider === "google") return "Google";
  if (provider === "password") return t(i18n)({ message: "Email and password", context: "Account management" });
  if (provider === "tailscale") return t(i18n)({ message: "Tailscale identity", context: "Account management" });
  return t(i18n)({ message: "Browser session", context: "Account management" });
}

function identityDescription(identity: AccountData["authentication"]["identities"][number]): string {
  if (identity.provider === "github" && identity.login) return `@${identity.login}`;
  return identity.email ?? t(i18n)({ message: "Connected", context: "Account management" });
}

function identityLabel(user: ManagementOverview["user"]): string {
  return user.login ? `@${user.login}` : user.email ?? t(i18n)({ message: "Identity unavailable", context: "Account management" });
}

function registrationLabel(value: ManagementOverview["authentication"]["registration"]): string {
  if (value === "open") return t(i18n)({ message: "Open registration", context: "Account management" });
  if (value === "invite") return t(i18n)({ message: "Invitation required", context: "Account management" });
  return t(i18n)({ message: "Closed registration", context: "Account management" });
}

function formatBytes(value: number): string {
  if (value < 1_024) return t(i18n)`${plural(value, { one: "# byte", other: "# bytes" })}`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value;
  let index = -1;
  do { amount /= 1_024; index += 1; } while (amount >= 1_024 && index < units.length - 1);
  return `${formatters(i18n.locale).number(amount, { maximumFractionDigits: amount < 10 ? 1 : 0 })} ${units[index]}`;
}

function relativeTime(value: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1_000));
  if (seconds < 60) return t(i18n)({ message: "just now", context: "Account management" });
  if (seconds < 3_600) return t(i18n)`${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return t(i18n)`${Math.floor(seconds / 3_600)}h ago`;
  return t(i18n)`${Math.floor(seconds / 86_400)}d ago`;
}

function loginUrl(client: ConnectManagementClient): string {
  const url = new URL("/login", client.baseUrl);
  url.searchParams.set("return_to", "/account");
  return url.href;
}

function errorMessage(value: unknown): string {
  const detail = value instanceof Error ? value.message : String(value);
  return /failed to fetch|networkerror|network request failed/i.test(detail)
    ? t(i18n)({ message: "mdbase connect could not be reached. Check your connection and try again." })
    : detail;
}
