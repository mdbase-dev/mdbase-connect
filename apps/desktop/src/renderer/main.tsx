import { LocaleProvider } from "@mdbase-dev/i18n/react";
import { runtime } from "./i18n";
import { LanguageSetting } from "./language-setting";
import { t, plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useLocaleRevision, i18n } from "@mdbase-dev/ui/i18n";
import "@mdbase-dev/ui/fonts.css";
import "@mdbase/connect-ui/styles.css";
import "@mdbase-dev/ui/palette.css";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { CommandPalette, type Command } from "@mdbase-dev/ui/command-palette";
import { Dialog } from "@mdbase-dev/ui/dialog";
import { signalMdbaseMark } from "@mdbase-dev/ui/mark-activity";
import { ConfirmAction } from "@mdbase/connect-ui/confirm-action";
import { KeyboardShortcuts, navigationShortcuts, useConnectKeyboard } from "@mdbase/connect-ui/keyboard";
import { AccessView } from "./access-view";
import { ActivityView } from "./activity-view";
import { CollectionsView } from "./collections-view";
import { DeviceRequests } from "./device-requests";
import { groupAccess, presentConnection } from "./daemon-view.mjs";
import { consumePairingCompleted } from "./onboarding-state.mjs";
import { SignInPanel } from "./sign-in-panel";
import { TakeoverPanel } from "./takeover-panel";
import {
  Empty,
  MobileProductBar,
  ProductSidebar,
  SectionHeading,
  SettingSwitch,
  ThemeMenu
} from "./ui-components";
import { message, type Route } from "./view-model";
import "./styles.css";

const routeCopy: Record<Route, { title: string; lede: string }> = {
  overview: {
    get title() { return t(i18n)({ message: "Overview", context: "Connect interface" }); },
    get lede() { return t(i18n)({ message: "Collections, app access and sync status in one place." }); }
  },
  collections: {
    get title() { return t(i18n)({ message: "Collections", context: "Connect interface" }); },
    get lede() { return t(i18n)({ message: "Folders on this computer that your apps can use, and how each one syncs." }); }
  },
  access: {
    get title() { return t(i18n)({ message: "Apps", context: "Connect interface" }); },
    get lede() { return t(i18n)({ message: "Apps you approve in mdbase reach your local collections through this computer." }); }
  },
  activity: {
    get title() { return t(i18n)({ message: "Activity", context: "Connect interface" }); },
    get lede() { return t(i18n)({ message: "App access and collection changes on this computer." }); }
  },
  settings: {
    get title() { return t(i18n)({ message: "Settings", context: "Connect interface" }); },
    get lede() { return t(i18n)({ message: "This computer's account, app approval and background behavior." }); }
  }
};

const POLL_MS = 5_000;

function App() {
  useLocaleRevision();
  const [route, setRoute] = useState<Route>("overview");
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [checked, setChecked] = useState(false);
  const [cloud, setCloud] = useState<CloudSetting | null>(null);
  const [collections, setCollections] = useState<DaemonCollection[]>([]);
  const [access, setAccess] = useState<AccessEntry[]>([]);
  const [devices, setDevices] = useState<PendingDevice[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[] | null>([]);
  const [requireApproval, setRequireApproval] = useState<boolean | null>(null);
  const [startup, setStartup] = useState<StartupSetting>({ enabled: false, available: false });
  const [updateStatus, setUpdateStatus] = useState<DesktopUpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [signInReason, setSignInReason] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);

  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    const api = window.mdbaseConnect;
    const [nextStatus, nextCloud, nextCollections, nextAccess, nextSettings, nextStartup, nextActivity, nextDevices] = await Promise.allSettled([
      api.status(), api.getCloudConfig(), api.listCollections(), api.listAccess(), api.getSettings(), api.getLaunchAtLogin(), api.listActivity(),
      api.listPendingDevices()
    ]);
    if (mine !== generation.current) return;
    setChecked(true);
    // A live connection indicator is never last-known; lists keep their last value.
    setStatus(nextStatus.status === "fulfilled" ? nextStatus.value : null);
    if (nextCloud.status === "fulfilled") setCloud(nextCloud.value);
    if (nextCollections.status === "fulfilled") setCollections(nextCollections.value);
    if (nextAccess.status === "fulfilled") setAccess(nextAccess.value);
    if (nextDevices.status === "fulfilled") setDevices(nextDevices.value);
    if (nextSettings.status === "fulfilled") setRequireApproval(nextSettings.value.require_grant_approval);
    if (nextStartup.status === "fulfilled") setStartup(nextStartup.value);
    setActivity(nextActivity.status === "fulfilled" ? nextActivity.value : null);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    const removeNavigation = window.mdbaseConnect.onNavigate((next) => {
      const target = next.startsWith("access") ? "access" : next;
      if (["overview", "collections", "access", "activity", "settings"].includes(target)) setRoute(target as Route);
    });
    let updatePushed = false;
    const removeUpdateStatus = window.mdbaseConnect.onUpdateStatus((next) => {
      updatePushed = true;
      setUpdateStatus(next);
    });
    void window.mdbaseConnect.updateStatus().then((next) => {
      if (!updatePushed) setUpdateStatus(next);
    }).catch(() => undefined);
    return () => {
      window.clearInterval(timer);
      removeNavigation();
      removeUpdateStatus();
    };
  }, [refresh]);

  const onSignedIn = useCallback(() => {
    setSignInReason(null);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (cloud?.configured && consumePairingCompleted(localStorage)) setRoute("collections");
  }, [cloud?.configured]);

  const act = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      await refresh();
      signalMdbaseMark("saved");
    } catch (reason) {
      signalMdbaseMark("error");
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  /** Collections are registered to an account, so adding one needs sign-in first. */
  function requireSignIn(): boolean {
    if (cloud?.configured) return true;
    setSignInReason(t(i18n)({ message: "Sign in first, then add your collection." }));
    return false;
  }

  function openCreate() {
    if (!requireSignIn()) return;
    setCreateOpen(true);
  }

  function addExisting() {
    if (!requireSignIn()) return;
    void act(async () => {
      const added = await window.mdbaseConnect.addCollection();
      if (added) {
        setRoute("collections");
        setNotice(t(i18n)`${added.name} was added.`);
      }
    });
  }

  const names = useMemo(() => Object.fromEntries(collections.map((c) => [c.id, c.name])), [collections]);
  const groups = useMemo(() => groupAccess(access), [access]);
  const connection = presentConnection(status, checked);
  const copy = routeCopy[route];
  const selectRoute = (next: Route) => {
    // A confirmation belongs to the view it was shown in.
    if (next !== route) setNotice(null);
    setRoute(next);
    setNavigationOpen(false);
  };
  const reviewApproval = (next: Route, commandId: string) => {
    flushSync(() => selectRoute(next));
    const prompt = [...document.querySelectorAll<HTMLElement>(".content .approval-prompt")].find(element => element.dataset.command === commandId);
    if (prompt) keyboard.invoker.current = prompt;
    prompt?.focus();
    prompt?.scrollIntoView({ block: "nearest" });
  };

  const unnamedDevice = t(i18n)`Another device`;
  const paletteContext = useRef<string | null>(null);
  const commands: Command[] = [
    ...groups.pending.map(entry => ({ id: `approval:${entry.grant}`, label: t(i18n)`Review ${entry.app_name}`, detail: names[entry.collection] ?? entry.collection, group: "approvals", run: () => reviewApproval("access", `approval:${entry.grant}`) })),
    ...devices.map(device => ({ id: `device:${device.collection}/${device.device}`, label: t(i18n)`Review ${device.name ?? unnamedDevice}`, detail: names[device.collection] ?? device.collection_name ?? device.collection, group: "approvals", run: () => reviewApproval("collections", `device:${device.collection}/${device.device}`) })),
    ...([["overview", t(i18n)({ message: "Overview", context: "Connect interface" })], ["collections", t(i18n)({ message: "Collections", context: "Connect interface" })], ["access", t(i18n)({ message: "Apps", context: "Connect interface" })], ["activity", t(i18n)({ message: "Activity", context: "Connect interface" })], ["settings", t(i18n)({ message: "Settings", context: "Connect interface" })]] as const)
      .map(([id, label]) => ({ id, label: t(i18n)`Go to ${label}`, shortcut: id === "access" ? navigationShortcuts.applications : navigationShortcuts[id], group: "commands", run: () => selectRoute(id) })),
    { id: "add", label: t(i18n)({ message: "Add existing folder" }), group: "commands", run: addExisting },
    { id: "create", label: t(i18n)({ message: "Create collection" }), shortcut: "c", group: "commands", run: openCreate },
    { id: "shortcuts", label: t(i18n)`Keyboard shortcuts`, shortcut: "?", group: "commands", run: () => keyboard.showHelp() },
    ...collections.map((collection) => ({ id: `collection:${collection.id}`, label: collection.name, detail: collection.root, group: "collections", context: paletteContext.current === `collection:${collection.id}` ? collection.name : undefined, run: () => { void act(() => window.mdbaseConnect.openCollectionFolder(collection.id)); } }))
  ];
  const keyboard = useConnectKeyboard({ commands, enabled: true, root: ".content", filter: ".collection-filter input", listFocus: "summary", onShow: () => { paletteContext.current = document.activeElement?.closest("[data-command]")?.getAttribute("data-command") ?? null; } });

  return (
    <div className={`shell product-shell ${navigationOpen ? "navigation-open" : ""}`}>
      <ProductSidebar
        route={route}
        collectionCount={collections.length}
        pendingCount={groups.attention}
        deviceCount={devices.length}
        signingIn={cloud?.configured === false}
        connection={connection}
        computerName={t(i18n)`This computer · ${plural(collections.length, { one: "# collection", other: "# collections" })}`}
        onSelect={selectRoute}
        onSearch={keyboard.show}
      />
      <CommandPalette open={keyboard.open} commands={commands} onClose={keyboard.close} returnFocusRef={keyboard.invoker} showAll={["approvals", "commands"]} groupLabel={(group) => group === "collections" ? t(i18n)({ message: "Collections", context: "Connect interface" }) : group === "approvals" ? t(i18n)`Waiting for your approval` : t(i18n)({ message: "Commands", context: "Connect interface" })} label={t(i18n)({ message: "Commands", context: "Connect interface" })} placeholder={t(i18n)({ message: "Search", context: "Connect interface" })} />
      <KeyboardShortcuts keyboard={keyboard} commands={commands} />
      <button className="product-sidebar-backdrop" aria-label={t(i18n)({ message: "Close navigation", context: "Connect interface" })} onClick={() => setNavigationOpen(false)} />
      <div className="product-canvas desktop-canvas">
        <MobileProductBar open={navigationOpen} signingIn={cloud?.configured === false} onOpen={() => setNavigationOpen(true)} />
        <main className="content">
          <header className="topbar">
            <div><h1>{copy.title}</h1><p className="lede">{copy.lede}</p></div>
          </header>

          <div aria-live="polite">
            {error && <div className="mdbase-message is-error" role="alert"><span>{error}</span> <button className="mdbase-button is-tertiary" onClick={() => setError(null)}><Trans>Dismiss</Trans></button></div>}
            {checked && !status && <div className="mdbase-message is-error" role="status">{t(i18n)({ message: "mdbase is not running on this computer. It restarts automatically; if this stays, restart mdbase connect." })}</div>}
            {notice && <div className="mdbase-message is-success">{notice}</div>}
          </div>

          <TakeoverPanel names={names} />

          {cloud !== null && !cloud.configured && <div hidden={route === "activity"}>
            <SignInPanel cloud={cloud} reason={signInReason} onSignedIn={onSignedIn} />
          </div>}

          {(route === "overview" || route === "collections") &&
            <DeviceRequests devices={devices} names={names} busy={busy} onAct={act} onNotice={setNotice} />}

          {route === "overview" ? (
            <Overview
              cloud={cloud}
              connectionLabel={connection.label}
              collections={collections}
              attention={groups.attention}
              busy={busy}
              onNavigate={selectRoute}
              onAdd={addExisting}
              onCreate={openCreate}
            />
          ) : route === "collections" ? (
            <CollectionsView collections={collections} computerName={cloud?.computerName ?? t(i18n)`This computer`} busy={busy} onAdd={addExisting} onCreate={openCreate} onAct={act} onNotice={setNotice} />
          ) : route === "access" ? (
            <AccessView groups={groups} names={names} busy={busy} requireApproval={requireApproval} movedWaiting={collections.filter((c) => c.notices?.some((n) => n.code === "private_sync_pending")).length} onAct={act} onNotice={setNotice} />
          ) : route === "activity" ? (
            <ActivityView entries={activity} />
          ) : (
            <Settings
              cloud={cloud}
              connectionLabel={connection.settingsLabel}
              connectionDetail={connection.detail}
              requireApproval={requireApproval}
              startup={startup}
              updateStatus={updateStatus}
              busy={busy}
              onAct={act}
              onNotice={setNotice}
            />
          )}
        </main>

        <CreateCollectionDialog open={createOpen} busy={busy} onClose={() => setCreateOpen(false)} onCreate={async (input) => {
          // Failures stay in the dialog with the draft, not behind it.
          setBusy(true);
          try {
            const created = await window.mdbaseConnect.createCollection(input);
            setCreateOpen(false);
            setRoute("collections");
            setError(null);
            setNotice(t(i18n)`${created.name} was created.`);
            await refresh();
          } finally {
            setBusy(false);
          }
        }} />
      </div>
    </div>
  );
}

function Overview({ cloud, connectionLabel, collections, attention, busy, onNavigate, onAdd, onCreate }: {
  cloud: CloudSetting | null;
  connectionLabel: string;
  collections: DaemonCollection[];
  attention: number;
  busy: boolean;
  onNavigate(route: Route): void;
  onAdd(): void;
  onCreate(): void;
}) {
  useLocaleRevision();
  if (!cloud?.configured) return null;
  const synced = collections.filter((collection) => collection.mode !== "local" && collection.reason !== "collection_deleted").length;
  return (
    <div className="workspace-stack">
      {collections.length === 0 && <section>
        <Empty title={t(i18n)({ message: "Add your first collection" })} text={t(i18n)({ message: "Choose a folder of Markdown notes, or create a new one. It stays on this computer; your apps reach it through mdbase." })} />
        <div className="collection-config-actions">
          <button className="mdbase-button is-primary" disabled={busy} onClick={onAdd}><Trans>Add existing folder</Trans></button>
          <button className="mdbase-button" disabled={busy} onClick={onCreate}><Trans>Create collection</Trans></button>
        </div>
      </section>}
      <section>
        <div className="overview-list">
          <OverviewRow label={t(i18n)({ message: "Account", context: "Connect interface" })} value={connectionLabel} detail={cloud.serverUrl ?? ""} route="settings" onNavigate={onNavigate} />
          <OverviewRow label={t(i18n)({ message: "Collections", context: "Connect interface" })} value={t(i18n)`${plural(collections.length, { one: "# collection", other: "# collections" })}`} detail={synced > 0 ? t(i18n)`${synced} synced` : t(i18n)`All on this computer only`} route="collections" onNavigate={onNavigate} />
          <OverviewRow label={t(i18n)({ message: "Apps", context: "Connect interface" })} value={attention > 0 ? t(i18n)`${plural(attention, { one: "# item needs you", other: "# items need you" })}` : t(i18n)`Nothing waiting`} detail={t(i18n)`Apps you approve reach your collections through this computer`} route="access" onNavigate={onNavigate} />
        </div>
      </section>
    </div>
  );
}

function OverviewRow({ label, value, detail, route, onNavigate }: { label: string; value: string; detail: string; route: Route; onNavigate(route: Route): void }) {
  useLocaleRevision();
  return <a className="overview-row" href={`#${route}`} onClick={(event) => { event.preventDefault(); onNavigate(route); }}><span>{label}</span><div><strong>{value}</strong><small>{detail}</small></div></a>;
}

function CreateCollectionDialog({ open, busy, onClose, onCreate }: {
  open: boolean;
  busy: boolean;
  onClose(): void;
  onCreate(input: { parent: string; name: string }): Promise<void>;
}) {
  useLocaleRevision();
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => { if (open) { setName(""); setParent(""); setFailure(null); } }, [open]);
  return (
    <Dialog open={open} onClose={() => !busy && onClose()} title={t(i18n)({ message: "Create a collection", context: "Connect interface" })} className="modal" closeDisabled={busy}>
      <p className="eyebrow"><Trans>New collection</Trans></p>
      {failure && <div className="mdbase-message is-error" role="alert">{failure}</div>}
      <p><Trans>mdbase creates a new folder with this name and keeps it on this computer. You can turn on sync later.</Trans></p>
      <label><span><Trans>Collection name</Trans></span><input className="mdbase-field" autoFocus disabled={busy} value={name} maxLength={100} onChange={(event) => setName(event.target.value)} placeholder={t(i18n)`Workouts`} /></label>
      <label><span><Trans>Create the folder in</Trans></span><button className="mdbase-field folder-picker" disabled={busy} onClick={() => void window.mdbaseConnect.chooseCreateFolder().then((chosen) => { if (chosen) setParent(chosen); }).catch((reason) => setFailure(message(reason)))}>{parent || t(i18n)({ message: "Choose a location…", context: "Connect interface" })}</button></label>
      <div className="modal-actions">
        <button className="mdbase-button" disabled={busy} onClick={onClose}><Trans>Cancel</Trans></button>
        <button className="mdbase-button is-primary" disabled={busy || !name.trim() || !parent} onClick={() => { setFailure(null); void onCreate({ parent, name: name.trim() }).catch((reason) => setFailure(message(reason))); }}><Trans>Create collection</Trans></button>
      </div>
    </Dialog>
  );
}

function Settings({ cloud, connectionLabel, connectionDetail, requireApproval, startup, updateStatus, busy, onAct, onNotice }: {
  cloud: CloudSetting | null;
  connectionLabel: string;
  connectionDetail?: string;
  requireApproval: boolean | null;
  startup: StartupSetting;
  updateStatus: DesktopUpdateStatus | null;
  busy: boolean;
  onAct(action: () => Promise<unknown>): Promise<void>;
  onNotice(value: string): void;
}) {
  useLocaleRevision();
  return (
    <div className="workspace-stack settings-stack">
      {cloud?.configured && (
        <section>
          <SectionHeading title={t(i18n)({ message: "Account", context: "Connect interface" })} note={t(i18n)({ message: "The mdbase account this computer is signed in to." })} />
          <div className="settings-rows">
            <SettingRow label={t(i18n)({ message: "mdbase service", context: "Connect interface" })} value={cloud.serverUrl ?? t(i18n)`Signed in`} detail={cloud.online ? t(i18n)`Connected` : t(i18n)`Saved app access still works on this computer`} mono />
            <SettingRow label={t(i18n)({ message: "Connection", context: "Connect interface" })} value={connectionLabel} detail={connectionDetail ?? t(i18n)`Keeps apps on your other devices connected to this computer`} />
            <ComputerNameRow name={cloud.computerName ?? null} busy={busy} onAct={onAct} onNotice={onNotice} />
          </div>
          <div className="portal-connection-actions">
            <button className="mdbase-button" disabled={busy} onClick={() => void onAct(() => window.mdbaseConnect.openAccount())}><Trans>Manage in mdbase</Trans></button>
            <ConfirmAction className="mdbase-button is-tertiary is-danger disconnect-button" busy={busy} label={t(i18n)({ message: "Sign out on this computer…", context: "Connect interface" })} confirmLabel={t(i18n)({ message: "Sign out", context: "Connect interface" })} question={t(i18n)({ message: "Sign out on this computer? Apps can no longer reach your local collections through this computer. Your files are unaffected." })} onConfirm={() => onAct(() => window.mdbaseConnect.signOut())} />
          </div>
        </section>
      )}
      <section>
        <SectionHeading title={t(i18n)({ message: "App approval", context: "Connect interface" })} note={t(i18n)({ message: "How new apps get access to your local collections." })} />
        <div className="settings-rows">
          <SettingSwitch
            className="setting-toggle"
            label={t(i18n)({ message: "Ask before new apps connect" })}
            description={t(i18n)({ message: "When on, an app you approve in mdbase also waits for your approval on this computer" })}
            checked={requireApproval === true}
            disabled={busy || requireApproval === null}
            stateLabel={requireApproval === null ? t(i18n)`Unavailable` : requireApproval ? t(i18n)`On` : t(i18n)`Off`}
            onChange={(checked) => void onAct(async () => {
              // Turning it off is confirmed on this computer's screen by mdbase itself.
              await window.mdbaseConnect.setRequireApproval(checked);
              onNotice(checked ? t(i18n)({ message: "New apps now wait for your approval on this computer." }) : t(i18n)({ message: "New apps connect without asking; you are still notified." }));
            })}
          />
        </div>
      </section>
      <section>
        <SectionHeading title={t(i18n)({ message: "Background behavior", context: "Connect interface" })} note={t(i18n)({ message: "Keep mdbase connect in the tray without opening a window." })} />
        <div className="settings-rows">
          <SettingSwitch
            className="setting-toggle"
            label={t(i18n)({ message: "Start at login", context: "Connect interface" })}
            description={startup.available ? t(i18n)({ message: "Launch in the tray when you sign in" }) : t(i18n)({ message: "Available in installed builds" })}
            checked={startup.enabled}
            disabled={!startup.available || busy}
            stateLabel={startup.available ? startup.enabled ? t(i18n)`On` : t(i18n)`Off` : t(i18n)`Unavailable`}
            onChange={(checked) => void onAct(async () => {
              await window.mdbaseConnect.setLaunchAtLogin(checked);
              onNotice(checked ? t(i18n)({ message: "mdbase connect will start at login." }) : t(i18n)({ message: "Launch at login is off.", context: "Connect interface" }));
            })}
          />
        </div>
      </section>
      <section>
        <SectionHeading title={t(i18n)({ message: "Updates", context: "Connect interface" })} note={t(i18n)({ message: "Releases are checked against signed provenance before installation." })} />
        <div className="settings-rows">
          <UpdateRow status={updateStatus} busy={busy} onAct={onAct} />
          {updateStatus?.daemon_notice ? <SettingRow label={t(i18n)({ message: "mdbase daemon", context: "Connect interface" })} value={t(i18n)`Previous version restored`} detail={updateStatus.daemon_notice} /> : null}
        </div>
      </section>
      <section>
        <SectionHeading title={t(i18n)({ message: "Appearance", context: "Connect interface" })} note={t(i18n)({ message: "Use the system setting or keep a theme on this computer." })} />
        <div className="settings-rows">
          <div className="setting-row">
            <span><Trans>Theme</Trans></span>
            <div><strong><Trans>Color theme</Trans></strong><small><Trans>System follows your operating system appearance</Trans></small></div>
            <ThemeMenu />
          </div>
          <LanguageSetting />
        </div>
      </section>
      <section className="privacy-block"><span className="privacy-lock">⌁</span><div><strong><Trans>Folder locations are never uploaded.</Trans></strong><p><Trans>Collections stay on this computer. Synced collections send changes to mdbase; private sync encrypts them so mdbase cannot read them. Your account only receives collection names and app-access details.</Trans></p></div></section>
    </div>
  );
}

function ComputerNameRow({ name, busy, onAct, onNotice }: {
  name: string | null;
  busy: boolean;
  onAct(action: () => Promise<unknown>): Promise<void>;
  onNotice(value: string): void;
}) {
  useLocaleRevision();
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null) {
    return <div className="setting-row"><span><Trans>This computer</Trans></span><div><strong>{name ?? t(i18n)({ message: "Unnamed", context: "Connect interface" })}</strong><small><Trans>How this computer appears in your mdbase account</Trans></small></div><button className="mdbase-button is-tertiary" disabled={busy} onClick={() => setDraft(name ?? "")}><Trans>Rename</Trans></button></div>;
  }
  return (
    <div className="setting-row">
      <span><Trans>This computer</Trans></span>
      <div className="computer-name-form">
        <input className="mdbase-field" aria-label={t(i18n)({ message: "Computer name", context: "Connect interface" })} autoFocus value={draft} maxLength={100} disabled={busy} onChange={(event) => setDraft(event.target.value)} />
        <button className="mdbase-button" disabled={busy} onClick={() => setDraft(null)}><Trans>Cancel</Trans></button>
        <button className="mdbase-button is-primary" disabled={busy || !draft.trim()} onClick={() => void onAct(async () => {
          const renamed = await window.mdbaseConnect.renameComputer(draft.trim());
          setDraft(null);
          onNotice(t(i18n)`This computer is now called ${renamed.name}.`);
        })}><Trans>Save</Trans></button>
      </div>
    </div>
  );
}

function UpdateRow({ status, busy, onAct }: {
  status: DesktopUpdateStatus | null;
  busy: boolean;
  onAct(action: () => Promise<unknown>): Promise<void>;
}) {
  useLocaleRevision();
  const install = status?.can_install === true;
  const label = install
    ? status.phase === "ready" ? t(i18n)`Install ${status.target_version}` : status.target_version ? t(i18n)`Open ${status.target_version}` : t(i18n)`Open update`
    : t(i18n)({ message: "Check for updates", context: "Connect interface" });
  const enabled = install || status?.can_check === true;
  return (
    <div className="setting-row">
      <span><Trans>Application</Trans></span>
      <div><strong>{status?.current_version ? t(i18n)`Version ${status.current_version}` : t(i18n)`Checking version…`}</strong><small>{status?.message ?? t(i18n)({ message: "Reading update status…", context: "Connect interface" })}</small></div>
      {status && status.phase !== "unavailable" ? (
        <button className="mdbase-button is-tertiary" disabled={busy || !enabled} onClick={() => void onAct(() =>
          install ? window.mdbaseConnect.installUpdate() : window.mdbaseConnect.checkForUpdates())}>{label}</button>
      ) : null}
    </div>
  );
}

function SettingRow({ label, value, detail, mono = false }: { label: string; value: string; detail: string; mono?: boolean }) {
  useLocaleRevision();
  return <div className="setting-row"><span>{label}</span><div><strong className={mono ? "mono" : ""}>{value}</strong><small>{detail}</small></div></div>;
}

function LocalizedApp() {
  const revision = useLocaleRevision();
  const [languageError, setLanguageError] = useState(false);
  useEffect(() => setLanguageError(false), [revision]);
  const showLanguageError = useCallback(() => setLanguageError(true), []);
  return <LocaleProvider runtime={runtime} onError={showLanguageError}>
    {languageError && <p role="alert">{t(i18n)`The language could not be loaded. Choose it again in Settings.`}</p>}
    <App />
  </LocaleProvider>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><LocalizedApp /></React.StrictMode>);
