import React, { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiError,
  type AccountData,
  type DashboardData
} from "./api";
import { GoogleIdentityButton } from "./auth-view";
import {
  authenticationLabel,
  message,
  pluralLabel,
  registrationLabel,
  tokenFromFragment
} from "./portal-model";
import { Empty, PageBrand, SectionHeading } from "./portal-ui";
import { SessionManager } from "./session-manager";

export function AccountView({ dashboard }: { dashboard: DashboardData }) {
  const [account, setAccount] = useState<AccountData | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [deletionOpen, setDeletionOpen] = useState(false);
  const [deletionConfirmation, setDeletionConfirmation] = useState("");
  const [deletionPassword, setDeletionPassword] = useState("");
  const [reauthToken] = useState(() => tokenFromFragment("delete_token"));
  const [googleAction, setGoogleAction] = useState<"link" | "delete" | null>(null);

  const refresh = useCallback(async () => {
    try {
      setAccount(await api<AccountData>("/v1/account"));
      setError("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        location.href = `/login?return_to=${encodeURIComponent(location.href)}`;
      } else setError(message(reason));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const linked = new URLSearchParams(location.search).get("linked");
    if (linked === "github" || linked === "google") {
      setNotice(`${providerLabel(linked)} is now connected.`);
      history.replaceState(history.state, "", location.pathname);
    }
  }, []);

  const googleCompleted = useCallback((redirectTo: string) => {
    location.href = redirectTo;
  }, []);
  const googleFailed = useCallback((reason: string) => {
    setError(reason);
    setGoogleAction(null);
  }, []);

  async function disconnect(provider: "github" | "google") {
    setBusy(`disconnect-${provider}`);
    setError("");
    setNotice("");
    try {
      await api(`/v1/account/identities/${provider}`, { method: "DELETE" });
      setNotice(`${providerLabel(provider)} disconnected.`);
      await refresh();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy("");
    }
  }

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    if (newPassword !== passwordConfirmation) {
      setError("New passwords do not match.");
      return;
    }
    setBusy("password");
    setError("");
    setNotice("");
    try {
      await api("/v1/account/password", {
        method: "PATCH",
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword
        })
      });
      setCurrentPassword("");
      setNewPassword("");
      setPasswordConfirmation("");
      setPasswordOpen(false);
      setNotice("Password changed. Other browser sessions were signed out.");
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy("");
    }
  }

  async function deleteAccount(event: React.FormEvent) {
    event.preventDefault();
    setBusy("delete");
    setError("");
    try {
      await api("/v1/account", {
        method: "DELETE",
        body: JSON.stringify({
          confirmation: deletionConfirmation,
          ...(deletionPassword ? { current_password: deletionPassword } : {}),
          ...(reauthToken ? { reauth_token: reauthToken } : {})
        })
      });
      location.href = "/account-deleted";
    } catch (reason) {
      setError(message(reason));
      setBusy("");
    }
  }

  if (!account) {
    return <main className="account-main account-management-main">
      <header><p className="eyebrow">Account</p><h1>Account and storage.</h1></header>
      <p className="account-loading" role="status">{error || "Loading account details…"}</p>
    </main>;
  }

  const linkedByProvider = new Map(
    account.authentication.identities.map((identity) => [identity.provider, identity])
  );
  const providers = (["github", "google"] as const).filter((provider) =>
    account.authentication.available_providers[provider] || linkedByProvider.has(provider)
  );
  const canPasswordDelete = account.authentication.password.configured;
  const canExternalDelete = account.authentication.identities.length > 0;
  const deletionAuthorized = account.deletion.development_confirmation
    || Boolean(reauthToken)
    || Boolean(deletionPassword);

  return <main className="account-main account-management-main">
    <header><p className="eyebrow">Account</p><h1>Account and storage.</h1><p>Manage hosted data, sign-in methods, and browser sessions.</p></header>
    {error && <div className="message error" role="alert">{error}</div>}
    {notice && <div className="message success" role="status">{notice}</div>}

    <section id="storage">
      <SectionHeading title="Hosted storage" note="Local collection files stay on your computers and are not measured here." />
      <div className="account-setting-list">
        <div className="account-setting-row storage-total-row">
          <div><strong>Used by hosted collections</strong><small>{storageDetail(account)}</small></div>
          <span className="account-setting-value">{account.storage.total_content_bytes === null ? "Unavailable" : formatBytes(account.storage.total_content_bytes)}</span>
        </div>
        {account.storage.collections.map((collection) => <StorageRow key={collection.id} collection={collection} />)}
      </div>
    </section>

    <section id="sign-in-methods">
      <SectionHeading title="Sign-in methods" note="Connect more than one method so you always have a way back into your account." />
      {!account.authentication.managed ? (
        <Empty title="Managed by your tailnet" text="Sign-in methods for this account are controlled by Tailscale." />
      ) : <div className="account-setting-list">
        {providers.map((provider) => {
          const identity = linkedByProvider.get(provider);
          return <div className="account-setting-row" key={provider}>
            <div><strong>{providerLabel(provider)}</strong><small>{identity ? identityDescription(identity) : "Not connected"}{identity?.current ? " · current session" : ""}</small></div>
            <div className="account-setting-actions">
              {!identity && provider === "github" && <a className="button secondary compact" href="/v1/account/identities/github/link?return_to=%2Faccount">Connect</a>}
              {!identity && provider === "google" && googleAction !== "link" && <button className="button secondary compact" onClick={() => setGoogleAction("link")}>Connect</button>}
              {!identity && provider === "google" && googleAction === "link" && <GoogleIdentityButton startUrl="/v1/account/identities/google/link?return_to=%2Faccount" onComplete={googleCompleted} onError={googleFailed} />}
              {identity && <button className="button quiet compact" disabled={!identity.removable || busy === `disconnect-${provider}`} title={!identity.removable ? identity.current ? "This method is used by the current session." : "This is your only sign-in method." : undefined} onClick={() => void disconnect(provider)}>{busy === `disconnect-${provider}` ? "Disconnecting…" : "Disconnect"}</button>}
            </div>
          </div>;
        })}
        {(account.authentication.available_providers.password || account.authentication.password.configured) && <div className="account-setting-row account-setting-row-stack">
          <div className="account-setting-row-main"><div><strong>Email and password</strong><small>{account.authentication.password.configured ? account.authentication.password.email ?? "Configured" : "Not configured"}{account.authentication.password.current ? " · current session" : ""}</small></div>
            {account.authentication.password.change_available && <button className="button secondary compact" onClick={() => setPasswordOpen((open) => !open)}>{passwordOpen ? "Cancel" : "Change password"}</button>}
          </div>
          {passwordOpen && <form className="inline-account-form" onSubmit={(event) => void changePassword(event)}>
            <label><span>Current password</span><input type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
            <label><span>New password</span><input type="password" autoComplete="new-password" minLength={15} required aria-describedby="account-password-guidance" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
            <p className="field-note" id="account-password-guidance">Use at least 15 characters. Spaces are welcome.</p>
            <label><span>Confirm new password</span><input type="password" autoComplete="new-password" minLength={15} required value={passwordConfirmation} onChange={(event) => setPasswordConfirmation(event.target.value)} /></label>
            <button className="button primary" disabled={busy === "password"}>{busy === "password" ? "Changing password…" : "Change password"}</button>
          </form>}
        </div>}
      </div>}
    </section>

    {account.authentication.managed && <section id="sessions"><SessionManager onError={setError} /></section>}

    <section id="account-details">
      <SectionHeading title="Account details" note="Identity and service configuration." />
      <div className="account-setting-list">
        <div className="account-setting-row"><div><strong>Authentication</strong><small>Current browser</small></div><span className="account-setting-value">{authenticationLabel(dashboard.authentication.provider)}</span></div>
        <div className="account-setting-row"><div><strong>Registration</strong><small>Service policy</small></div><span className="account-setting-value">{registrationLabel(dashboard.authentication.registration)}</span></div>
      </div>
      {account.authentication.managed && <button className="button secondary account-sign-out" onClick={() => void api("/v1/logout", { method: "POST" }).then(() => { location.href = "/login"; })}>Sign out</button>}
    </section>

    <section id="delete-account" className="danger-section">
      <SectionHeading title="Delete account" note="Permanent for hosted data. Local files are never removed from your computers." />
      {!account.deletion.available ? <p>This account is managed by your tailnet and cannot be deleted here.</p> : !deletionOpen ? (
        <button className="button danger" onClick={() => setDeletionOpen(true)}>Delete account…</button>
      ) : <form className="account-deletion-form" onSubmit={(event) => void deleteAccount(event)}>
        <div className="deletion-effects">
          <p><strong>This permanently deletes:</strong></p>
          <ul>
            <li>{pluralLabel(account.deletion.hosted_collections, "hosted collection", "hosted collections")} and their stored data</li>
            <li>Application access and {pluralLabel(account.deletion.computers, "connected computer", "connected computers")}</li>
            <li>Every browser session and sign-in method</li>
          </ul>
          <p><strong>Local collection and mirror files remain on your computers.</strong></p>
        </div>
        {!account.deletion.development_confirmation && !reauthToken && <div className="account-reauthentication">
          <strong>Confirm your identity</strong>
          {canPasswordDelete && <label><span>Current password</span><input type="password" autoComplete="current-password" value={deletionPassword} onChange={(event) => setDeletionPassword(event.target.value)} /></label>}
          {canExternalDelete && <div className="account-setting-actions">
            {account.authentication.identities.some(({ provider }) => provider === "github") && <a className="button secondary compact" href="/v1/account/reauth/github?return_to=%2Faccount">Verify with GitHub</a>}
            {account.authentication.identities.some(({ provider }) => provider === "google") && googleAction !== "delete" && <button type="button" className="button secondary compact" onClick={() => setGoogleAction("delete")}>Verify with Google</button>}
          </div>}
          {googleAction === "delete" && <GoogleIdentityButton startUrl="/v1/account/reauth/google?return_to=%2Faccount" onComplete={googleCompleted} onError={googleFailed} />}
          {!canPasswordDelete && !canExternalDelete && <p className="field-note">No supported reauthentication method is connected.</p>}
        </div>}
        {reauthToken && <p className="quiet-status" role="status"><span className="status-dot connected" aria-hidden="true" /><span>Identity confirmed for this deletion.</span></p>}
        <label><span>Type DELETE to confirm</span><input autoComplete="off" spellCheck={false} value={deletionConfirmation} onChange={(event) => setDeletionConfirmation(event.target.value)} /></label>
        <div className="inline-actions"><button type="button" className="button secondary" disabled={busy === "delete"} onClick={() => { setDeletionOpen(false); setDeletionConfirmation(""); setDeletionPassword(""); }}>Cancel</button><button className="button danger" disabled={busy === "delete" || deletionConfirmation !== "DELETE" || !deletionAuthorized}>{busy === "delete" ? "Deleting account…" : "Delete account permanently"}</button></div>
      </form>}
    </section>
  </main>;
}

export function DeletedAccount() {
  return <main className="center-page"><PageBrand label="connect" /><section className="auth-panel"><p className="eyebrow">Account deleted</p><h1>Your account has been deleted.</h1><p>Hosted data and access credentials were removed. Any local collection and mirror files remain on your computers.</p><a className="button secondary auth-complete-action" href="/login">Return to sign in</a></section></main>;
}

function StorageRow({ collection }: { collection: AccountData["storage"]["collections"][number] }) {
  const usage = collection.usage;
  const percentage = usage && usage.max_content_bytes > 0
    ? Math.min(100, usage.content_bytes / usage.max_content_bytes * 100)
    : 0;
  return <div className="account-setting-row storage-collection-row">
    <div><strong>{collection.display_name}</strong><small>{usage ? `${pluralLabel(usage.record_count, "record", "records")} · ${formatBytes(usage.content_bytes)} of ${formatBytes(usage.max_content_bytes)}` : "Usage temporarily unavailable"}</small></div>
    {usage && <div className="storage-progress" role="progressbar" aria-label={`${collection.display_name} storage`} aria-valuemin={0} aria-valuemax={usage.max_content_bytes} aria-valuenow={usage.content_bytes}><span style={{ width: `${percentage}%` }} /></div>}
  </div>;
}

function storageDetail(account: AccountData): string {
  const collections = pluralLabel(account.storage.collections.length, "hosted collection", "hosted collections");
  if (account.storage.status === "unavailable") return `${collections} · usage temporarily unavailable`;
  const records = pluralLabel(account.storage.total_records ?? 0, "record", "records");
  return `${collections} · ${records}${account.storage.status === "partial" ? " · partial usage" : ""}`;
}

function providerLabel(provider: "github" | "google") {
  return provider === "github" ? "GitHub" : "Google";
}

function identityDescription(identity: AccountData["authentication"]["identities"][number]) {
  if (identity.provider === "github" && identity.login) return `@${identity.login}`;
  return identity.email ?? "Connected";
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} ${value === 1 ? "byte" : "bytes"}`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value;
  let index = -1;
  do {
    amount /= 1_024;
    index += 1;
  } while (amount >= 1_024 && index < units.length - 1);
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: amount < 10 ? 1 : 0 }).format(amount)} ${units[index]}`;
}
