import { t, plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useLocaleRevision, i18n } from "@mdbase-dev/ui/i18n";
import React, { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "@mdbase-dev/ui/dialog";
import { Menu } from "@mdbase-dev/ui/menu";
import { ConfirmDialog } from "@mdbase-dev/ui/confirm-dialog";
import { CollectionModeControl, type CollectionModeStatus } from "@mdbase-dev/ui/collection-mode";
import { groupedApprovalCode, presentCollection } from "./daemon-view.mjs";
import { ConfirmAction } from "@mdbase/connect-ui/confirm-action";
import { Empty, ListFilter, SectionHeading } from "./ui-components";
import { message, relativeTime, syncEnableMessage } from "./view-model";

type Act = (action: () => Promise<unknown>) => Promise<void>;

const MODE_CHECK_COOLDOWN_MS = 15_000;

function readModeStatus(value: unknown): CollectionModeStatus | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.execution_available !== true || (v.current_mode !== "private" && v.current_mode !== "cloud_copy")) return null;
  if (v.change !== null) {
    if (!v.change || typeof v.change !== "object") return null;
    const c = v.change as Record<string, unknown>;
    if ((c.target_mode !== "private" && c.target_mode !== "cloud_copy") || typeof c.phase !== "string") return null;
  }
  return v as CollectionModeStatus;
}

export function CollectionsView({ collections, devices, computerName, busy, onAdd, onCreate, onAct, onNotice, onRefresh }: {
  collections: DaemonCollection[];
  devices: PendingDevice[];
  computerName: string;
  busy: boolean;
  onAdd(): void;
  onCreate(): void;
  onAct: Act;
  onNotice(value: string): void;
  onRefresh(): Promise<void> | void;
}) {
  useLocaleRevision();
  const [query, setQuery] = useState("");
  const [syncTarget, setSyncTarget] = useState<DaemonCollection | null>(null);
  const [lastSyncTarget, setLastSyncTarget] = useState<DaemonCollection | null>(null);
  const [syncFailure, setSyncFailure] = useState<string | null>(null);
  const openSync = (collection: DaemonCollection | null) => { setSyncFailure(null); setSyncTarget(collection); if (collection) setLastSyncTarget(collection); };
  const syncCollection = lastSyncTarget && (collections.find(collection => collection.id === lastSyncTarget.id) ?? lastSyncTarget);
  const sorted = collections.filter(collection => `${collection.name} ${collection.root}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).sort((a, b) => a.name.localeCompare(b.name));
  const deviceNames = Object.fromEntries(devices.filter((device) => device.name).map((device) => [device.device, device.name!]));
  return (
    <div className="workspace-stack">
      <section>
        <SectionHeading title={t(i18n)({ message: "On this computer", context: "Local collection management" })} note={t(i18n)({ message: "Each folder stays where it is. Sync is optional." })}>
          <button className="mdbase-button" disabled={busy} onClick={onAdd}><Trans>Add existing</Trans></button>
          <button className="mdbase-button is-primary" disabled={busy} onClick={onCreate}><Trans>Create</Trans></button>
        </SectionHeading>
        {(collections.length >= 10 || query) && <ListFilter label={t(i18n)`Filter collections`} value={query} onChange={setQuery} />}
        {collections.length === 0
          ? <Empty title={t(i18n)({ message: "No collections yet", context: "Local collection management" })} text={t(i18n)({ message: "Add a folder of Markdown notes or create a new collection." })} />
          : <div className="collection-list">{sorted.map((collection) => (
            <CollectionCard key={collection.id} collection={collection} deviceNames={deviceNames} computerName={computerName} busy={busy} onAct={onAct} onNotice={onNotice} onRefresh={onRefresh} onTurnOnSync={() => openSync(collection)} />
          ))}</div>}
      </section>
      {syncCollection && <TurnOnSyncDialog key={syncCollection.id} open={syncTarget !== null} collection={syncCollection} busy={busy} error={syncFailure} onAct={onAct} onClose={() => openSync(null)} onConfirm={(mode) => onAct(async () => {
        setSyncFailure(null);
        try {
          await window.mdbaseConnect.enableSync(syncCollection.id, mode);
        } catch (error) {
          // Shown in the dialog the user is looking at, not behind it.
          setSyncFailure(syncEnableMessage(error));
          return;
        }
        openSync(null);
        onNotice(mode === "private" ? t(i18n)`${syncCollection.name} now syncs privately.` : t(i18n)`${syncCollection.name} now syncs.`);
      })} />}
    </div>
  );
}

function CollectionCard({ collection, deviceNames, computerName, busy, onAct, onNotice, onRefresh, onTurnOnSync }: {
  collection: DaemonCollection;
  deviceNames: Readonly<Record<string, string>>;
  computerName: string;
  busy: boolean;
  onAct: Act;
  onNotice(value: string): void;
  onRefresh(): Promise<void> | void;
  onTurnOnSync(): void;
}) {
  useLocaleRevision();
  const view = presentCollection(collection);
  const isSynced = ["synced", "synced_e2e"].includes(collection.mode);
  // A refused upload names the file; the quota belongs to the collection owner's plan.
  const storageFull = collection.notices.some((notice) => notice.code === "quota_exceeded" && notice.path);
  const previousSyncNotices = collection.notices.filter((notice) => notice.code === "resource_ingest_deferred" || notice.code === "resource_ingest_paths_omitted");
  const [holdsOpen, setHoldsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [modeStatus, setModeStatus] = useState<CollectionModeStatus | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const menuId = useId();
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const lastModeCheck = useRef(0);
  const modeOpenRef = useRef(modeOpen);
  modeOpenRef.current = modeOpen;
  const closeMenu = (refocus: boolean) => { setMenuOpen(false); if (refocus) menuTrigger.current?.focus(); };

  useEffect(() => {
    if (!isSynced || typeof window.mdbaseConnect.collectionModeStatus !== "function") {
      setModeStatus(null);
      setModeOpen(false);
      return;
    }
    let active = true;
    const check = () => {
      lastModeCheck.current = Date.now();
      void window.mdbaseConnect.collectionModeStatus(collection.id)
        .then((value) => { if (active) setModeStatus(readModeStatus(value)); })
        .catch(() => { /* Older servers or non-owners expose no mode controls. */ });
    };
    check();
    const onVisible = () => {
      if (document.visibilityState === "visible" && !modeOpenRef.current && Date.now() - lastModeCheck.current >= MODE_CHECK_COOLDOWN_MS) {
        check();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => { active = false; document.removeEventListener("visibilitychange", onVisible); };
  }, [collection.id, collection.mode, isSynced]);

  const pendingMode = modeStatus?.change ?? null;
  const modeNeedsDevice = pendingMode?.phase === "waiting_for_device" || pendingMode?.phase === "waiting_for_devices";
  const modeAbandoned = pendingMode?.phase === "abandoned";
  return (
    <article className="collection-card" data-list-item data-command={`collection:${collection.id}`} tabIndex={-1} onKeyDown={event => {
      if (event.key === "Enter" && event.target === event.currentTarget && !busy) {
        event.preventDefault();
        menuTrigger.current!.focus();
        setMenuOpen(true);
      }
    }}>
      <div className="collection-card-main">
        <svg viewBox="0 0 256 256" fill="none" stroke="currentColor" strokeWidth="16" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label={computerName}><rect x="32" y="48" width="192" height="144" rx="16" /><path d="M32 152h192M96 224h64M128 192v32" /></svg>
        <div>
          <h3>{collection.name}</h3>
          <code title={collection.root}>{collection.root}</code>
        </div>
      </div>
      <div className="collection-card-status"><span>{view.status}</span><small title={view.mode}>{view.mode}</small></div>
      <button ref={menuTrigger} className="mdbase-button is-tertiary collection-menu-trigger" aria-label={t(i18n)`Actions for ${collection.name}`} aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuId} disabled={busy} onClick={() => setMenuOpen((open) => !open)}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1" /><circle cx="8" cy="8" r="1" /><circle cx="13" cy="8" r="1" /></svg>
      </button>
      {view.detail && <p className="collection-status-detail">{view.detail}</p>}
      {view.canResume && <button className="mdbase-button collection-resume" disabled={busy} onClick={() => void onAct(() => window.mdbaseConnect.setCollectionEnabled(collection.id, true))}>{t(i18n)({ message: "Resume", context: "Local collection management" })}</button>}
      {isSynced && !modeOpen && pendingMode && <div className="collection-mode-pending">
        <p className="collection-status-detail" role="status">
          {modeNeedsDevice
            ? t(i18n)({ message: "A storage mode switch is waiting for confirmation on this computer.", context: "Local collection management" })
            : modeAbandoned
              ? t(i18n)({ message: "The switch to Private was stopped and needs attention.", context: "Local collection management" })
              : t(i18n)({ message: "Switching storage mode…", context: "Local collection management" })}
        </p>
        <button type="button" className="mdbase-button collection-mode-action" disabled={busy} onClick={() => setModeOpen(true)}>
          {modeNeedsDevice || modeAbandoned
            ? t(i18n)({ message: "Review switch", context: "Local collection management" })
            : t(i18n)({ message: "View progress", context: "Local collection management" })}
        </button>
      </div>}
      {storageFull && <p className="collection-status-detail">{t(i18n)({ message: "Storage for this collection is full, so some files haven't synced. Free up space to sync them. If it's your collection and you're on the Free plan, you can upgrade to Plus for more storage.", context: "Local collection management" })}</p>}
      {storageFull && <button className="mdbase-button collection-account" onClick={() => void onAct(() => window.mdbaseConnect.openAccount())}><Trans>Manage in mdbase</Trans></button>}
      {collection.approval_code ? <div className="approval-check" aria-live="polite">
        <span><Trans>Check this code matches on your other computer:</Trans></span>
        <strong className="approval-code">{groupedApprovalCode(collection.approval_code)}</strong>
      </div> : collection.mode === "synced_e2e" && collection.state === "opening" && collection.sync?.last_error === "waiting_for_key" && <p role="status">{t(i18n)`Preparing comparison code…`}</p>}
      {collection.notices.filter((notice) => !["file_held", "collection_deleted", "sync_revoked", "resource_ingest_deferred", "resource_ingest_paths_omitted"].includes(notice.code)).map((notice, index) => <small key={`${notice.code}:${notice.path ?? index}`} className="collection-notice">{notice.path && <><code>{notice.path}</code>{": "}</>}{notice.message}</small>)}
      {previousSyncNotices.length > 0 && <details className="mdbase-disclosure collection-history">
        <summary><Trans>Technical details</Trans></summary>
        <p><Trans>From the last sync attempt, not a current file check.</Trans></p>
        <ul>{previousSyncNotices.map((notice, index) => <li key={`${notice.code}:${notice.path ?? index}`}>{notice.path && <><code>{notice.path}</code>{": "}</>}{notice.message}</li>)}</ul>
      </details>}
      <Menu open={menuOpen} triggerRef={menuTrigger} onClose={closeMenu} id={menuId} label={collection.name}>
        <button role="menuitem" className="mdbase-menu-item" disabled={busy} onClick={() => { closeMenu(true); void onAct(() => window.mdbaseConnect.openCollectionFolder(collection.id)); }}><Trans>Open folder</Trans></button>
        <button role="menuitem" className="mdbase-menu-item" onClick={() => { closeMenu(true); setDetailsOpen((open) => !open); }}><Trans>Details</Trans></button>
        <button role="menuitem" className="mdbase-menu-item" onClick={() => { closeMenu(true); setSettingsOpen((open) => !open); }}><Trans>Collection settings</Trans></button>
        {isSynced && <button role="menuitem" className="mdbase-menu-item" onClick={() => { closeMenu(true); setFilesOpen((open) => !open); }}><Trans>Synced files</Trans></button>}
        {isSynced && modeStatus?.execution_available === true && <button role="menuitem" className="mdbase-menu-item" onClick={() => { closeMenu(true); setModeOpen((open) => !open); }}>{t(i18n)({ message: "Storage mode", context: "Local collection management" })}</button>}
        {view.holds > 0 && <button role="menuitem" className="mdbase-menu-item" onClick={() => { closeMenu(true); setHoldsOpen((open) => !open); }}>{holdsOpen ? t(i18n)`Hide ${plural(view.holds, { one: "# file", other: "# files" })}` : t(i18n)`Review ${plural(view.holds, { one: "# file", other: "# files" })}`}</button>}
        {view.canEnableSync && <button role="menuitem" className="mdbase-menu-item" disabled={busy} onClick={() => { closeMenu(true); onTurnOnSync(); }}><Trans>Turn on sync</Trans></button>}
        {!view.paused && <button role="menuitem" className="mdbase-menu-item" disabled={busy || collection.state === "opening"} onClick={() => { closeMenu(true); void onAct(() => window.mdbaseConnect.setCollectionEnabled(collection.id, false)); }}>{t(i18n)({ message: "Pause", context: "Local collection management" })}</button>}
        <button role="menuitem" className="mdbase-menu-item collection-remove" disabled={busy} onClick={() => { closeMenu(false); setRemoveOpen(true); }}><Trans context="Remove a local collection connection">Remove</Trans></button>
      </Menu>
      <ConfirmDialog open={removeOpen} returnFocusRef={menuTrigger} busy={busy} title={t(i18n)`Remove ${collection.name} from mdbase? Apps stop using it. The folder and its files stay where they are.`} confirmLabel={t(i18n)({ message: "Remove", context: "Remove a local collection connection" })} pendingLabel={t(i18n)`Removing…`} onClose={() => setRemoveOpen(false)} onConfirm={async () => {
        await onAct(async () => {
          await window.mdbaseConnect.removeCollection(collection.id);
          onNotice(t(i18n)`${collection.name} was removed. Its files were not touched.`);
        });
        setRemoveOpen(false);
      }} />
      {detailsOpen && <Details collection={collection} onDone={(saved) => { setDetailsOpen(false); if (saved) onNotice(t(i18n)`${saved.name} was saved.`); }} />}
      {settingsOpen && <CollectionSettings collectionId={collection.id} onClose={() => setSettingsOpen(false)} />}
      {modeOpen && isSynced && (
        <div className="collection-mode-panel">
          <CollectionModeControl
            collectionId={collection.id}
            native
            initialStatus={modeStatus}
            deviceNames={deviceNames}
            load={() => window.mdbaseConnect.collectionModeStatus(collection.id)}
            change={(target) => window.mdbaseConnect.changeCollectionMode(collection.id, target)}
            cancel={(target) => window.mdbaseConnect.changeCollectionMode(collection.id, target, { cancel: true })}
            onStatusChange={setModeStatus}
            onModeChange={() => void onRefresh()}
          />
          <div className="row-actions">
            <button type="button" className="mdbase-button is-tertiary" onClick={() => setModeOpen(false)}><Trans>Close</Trans></button>
          </div>
        </div>
      )}
      {filesOpen && <SyncedFiles collection={collection} onDone={(saved) => { setFilesOpen(false); if (saved) onNotice(t(i18n)`File sync settings for ${collection.name} were saved.`); }} />}
      {holdsOpen && <Holds collection={collection} busy={busy} onAct={onAct} />}
    </article>
  );
}

/** Name and description. The draft survives a failed save; nothing is editable while saving. */
function Details({ collection, onDone }: { collection: DaemonCollection; onDone(saved: DaemonCollection | null): void }) {
  useLocaleRevision();
  const [name, setName] = useState(collection.name);
  const [description, setDescription] = useState(collection.description ?? "");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  async function save() {
    setSaving(true);
    setFailure(null);
    try {
      onDone(await window.mdbaseConnect.updateCollection(collection.id, { name: name.trim(), description: description.trim() }));
    } catch (reason) {
      setFailure(message(reason));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="collection-details">
      {failure && <p className="mdbase-message is-error" role="alert">{failure}</p>}
      <label><span><Trans>Name</Trans></span><input className="mdbase-field" value={name} maxLength={100} disabled={saving} onChange={(event) => setName(event.target.value)} /></label>
      <label><span><Trans>Description</Trans></span><textarea className="mdbase-field" value={description} maxLength={500} disabled={saving} onChange={(event) => setDescription(event.target.value)} placeholder={t(i18n)({ message: "What this collection is for" })} /></label>
      <small><Trans>The folder is not renamed. The description stays on this computer.</Trans></small>
      <div className="row-actions">
        <button className="mdbase-button" disabled={saving} onClick={() => onDone(null)}><Trans>Cancel</Trans></button>
        <button className="mdbase-button is-primary" disabled={saving || !name.trim()} onClick={() => void save()}>{saving ? t(i18n)({ message: "Saving…", context: "Local collection management" }) : t(i18n)({ message: "Save details", context: "Local collection management" })}</button>
      </div>
    </div>
  );
}

function CollectionSettings({ collectionId, onClose }: { collectionId: string; onClose(): void }) {
  useLocaleRevision();
  const zonesId = useId();
  const explanationId = useId();
  const [settings, setSettings] = useState<Awaited<ReturnType<Window["mdbaseConnect"]["collectionTimezone"]>> | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    window.mdbaseConnect.collectionTimezone(collectionId).then((value) => {
      if (!current) return;
      setSettings(value);
      setDraft(value.timezone ?? "");
    }, (reason) => {
      if (current) setFailure(message(reason));
    });
    return () => { current = false; };
  }, [collectionId]);

  async function save(timezone: string) {
    setSaving(true);
    setFailure(null);
    try {
      const value = await window.mdbaseConnect.collectionTimezone(collectionId, timezone);
      setSettings(value);
      setDraft(value.timezone ?? "");
    } catch (reason) {
      setFailure(message(reason));
    } finally {
      setSaving(false);
    }
  }

  return <div className="collection-details">
    {failure && <p className="mdbase-message is-error" role="alert">{failure}</p>}
    {!settings && !failure && <p role="status"><Trans>Loading collection settings…</Trans></p>}
    {settings && <>
      <p>{settings.timezone ? <Trans>Current time zone is {settings.timezone}.</Trans> : <Trans>No time zone is set for this collection.</Trans>}</p>
      <label>
        <span><Trans>Time zone</Trans></span>
        <input className="mdbase-field" list={zonesId} value={draft} maxLength={100} disabled={saving}
          aria-describedby={explanationId} onChange={(event) => setDraft(event.target.value)} />
      </label>
      <datalist id={zonesId}>
        {[...new Set(["UTC", ...(settings.detected_timezone ? [settings.detected_timezone] : []), ...Intl.supportedValuesOf("timeZone")])]
          .map((zone) => <option key={zone} value={zone} />)}
      </datalist>
      <small id={explanationId}><Trans>Times without an offset will be read in the new time zone.</Trans></small>
    </>}
    <div className="row-actions">
      <button type="button" className="mdbase-button" disabled={saving} onClick={onClose}><Trans>Close</Trans></button>
      {settings && !settings.timezone && settings.detected_timezone && <button type="button" className="mdbase-button" disabled={saving}
        onClick={() => void save(settings.detected_timezone!)}><Trans>Use {settings.detected_timezone}</Trans></button>}
      {settings && <button type="button" className="mdbase-button is-primary" disabled={saving || !draft.trim() || draft.trim() === settings.timezone}
        onClick={() => void save(draft.trim())}>{saving ? t(i18n)({ message: "Saving…", context: "Local collection management" }) : <Trans>Save time zone</Trans>}</button>}
    </div>
  </div>;
}

const FILE_CLASSES: Array<{ id: SyncFiles["include"][number]; label(): string }> = [
  { id: "image", label: () => t(i18n)({ message: "Images", context: "File types that sync" }) },
  { id: "audio", label: () => t(i18n)({ message: "Audio", context: "File types that sync" }) },
  { id: "video", label: () => t(i18n)({ message: "Video", context: "File types that sync" }) },
  { id: "pdf", label: () => t(i18n)({ message: "PDFs", context: "File types that sync" }) },
  { id: "other", label: () => t(i18n)({ message: "Other files", context: "File types that sync" }) }
];
const MB = 1_000_000;

/** Which files the collection syncs on every device. The draft survives a failed save. */
function SyncedFiles({ collection, onDone }: { collection: DaemonCollection; onDone(saved: boolean): void }) {
  useLocaleRevision();
  const [loaded, setLoaded] = useState(false);
  const [include, setInclude] = useState<SyncFiles["include"]>([]);
  const [folders, setFolders] = useState("");
  const [capped, setCapped] = useState(false);
  const [limit, setLimit] = useState("");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    window.mdbaseConnect.syncFiles(collection.id).then((files) => {
      setInclude(files.include);
      setFolders(files.exclude.join("\n"));
      setCapped(files.max_size !== undefined);
      setLimit(files.max_size === undefined ? "" : String(files.max_size / MB));
      setLoaded(true);
    }).catch((reason) => setFailure(message(reason)));
  }, [collection.id]);
  const megabytes = Number(limit);
  const limitValid = !capped || (limit.trim() !== "" && Number.isFinite(megabytes) && megabytes > 0);
  async function save() {
    setSaving(true);
    setFailure(null);
    try {
      await window.mdbaseConnect.setSyncFiles(collection.id, {
        include: FILE_CLASSES.map((c) => c.id).filter((id) => include.includes(id)),
        exclude: folders.split("\n").map((folder) => folder.trim()).filter(Boolean),
        ...(capped ? { max_size: Math.round(megabytes * MB) } : {})
      });
      onDone(true);
    } catch (reason) {
      setFailure(message(reason));
    } finally {
      setSaving(false);
    }
  }
  const disabled = saving || !loaded;
  return (
    <div className="sync-files">
      <p><Trans>Choose which files this collection syncs, on every device. Notes always sync, and files that already synced stay where they are.</Trans></p>
      {failure && <p className="mdbase-message is-error" role="alert">{failure}</p>}
      {!loaded && !failure && <small><Trans>Loading…</Trans></small>}
      <fieldset disabled={disabled}>
        <legend><Trans>File types</Trans></legend>
        <div>{FILE_CLASSES.map((c) => (
          <label key={c.id} className="sync-option">
            <input className="mdbase-checkbox" type="checkbox" checked={include.includes(c.id)} onChange={(event) => setInclude((current) => event.target.checked ? [...current, c.id] : current.filter((id) => id !== c.id))} />
            {c.label()}
          </label>
        ))}</div>
      </fieldset>
      <label className="sync-files-field"><span><Trans>Folders to leave out</Trans></span>
        <textarea className="mdbase-field" value={folders} disabled={disabled} onChange={(event) => setFolders(event.target.value)} placeholder={t(i18n)({ message: "Archive/Recordings" })} />
        <small><Trans>One folder per line, relative to the collection.</Trans></small>
      </label>
      <div className="sync-files-size">
        <label className="sync-option">
          <input className="mdbase-checkbox" type="checkbox" checked={capped} disabled={disabled} onChange={(event) => setCapped(event.target.checked)} />
          <Trans>Leave out files larger than</Trans>
        </label>
        <input className="mdbase-field" type="number" min="0.001" step="any" inputMode="decimal" value={limit} disabled={disabled || !capped} aria-label={t(i18n)`Size limit in megabytes`} onChange={(event) => setLimit(event.target.value)} />
        <span><Trans>MB</Trans></span>
      </div>
      <div className="row-actions">
        <button className="mdbase-button" disabled={saving} onClick={() => onDone(false)}><Trans>Cancel</Trans></button>
        <button className="mdbase-button is-primary" disabled={disabled || !limitValid} onClick={() => void save()}>{saving ? t(i18n)({ message: "Saving…", context: "Local collection management" }) : t(i18n)({ message: "Save", context: "File sync settings" })}</button>
      </div>
    </div>
  );
}

const HOLD_REASONS: Record<string, string> = {
  get conflict() { return t(i18n)({ message: "Changed here and elsewhere" }); },
  get unknown_provenance() { return t(i18n)({ message: "mdbase could not tell which version this file was based on" }); },
  get deleted_elsewhere() { return t(i18n)({ message: "Deleted on another device" }); },
  get read_only() { return t(i18n)({ message: "Changed while read-only", context: "Local collection management" }); },
  get editor_busy() { return t(i18n)({ message: "Open in an editor", context: "Local collection management" }); },
  get suspect_write() { return t(i18n)({ message: "Looked like an accidental overwrite" }); },
  get taken_over() { return t(i18n)({ message: "Differed when mdbase took over from the old app; this computer's version is in the folder" }); },
  get unsent_edit() { return t(i18n)({ message: "Edited here before the move but never uploaded, and changed elsewhere since; the current version is in the folder" }); }
};

function Holds({ collection, busy, onAct, onCountChange }: {
  collection: DaemonCollection;
  busy: boolean;
  onAct: Act;
  onCountChange?(count: number | null): void;
}) {
  useLocaleRevision();
  const [holds, setHolds] = useState<HoldSummary[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const load = () => window.mdbaseConnect.listHolds(collection.id)
    .then((list) => {
      setHolds(list);
      setFailure(null);
      onCountChange?.(list.length);
    })
    .catch((reason) => {
      setFailure(message(reason));
      onCountChange?.(null);
    });
  React.useEffect(() => { void load(); }, [collection.id, collection.sync?.holds]);
  const resolve = (hold: HoldSummary, how: "keep_mine" | "take_theirs" | "keep_both") => {
    void onAct(async () => { await window.mdbaseConnect.resolveHold(collection.id, hold.id, how); await load(); });
  };
  return (
    <div className="collection-holds">
      <p><Trans>mdbase kept these files instead of overwriting them. Choose which version to keep.</Trans></p>
      {failure && <p className="mdbase-message is-error" role="alert">{failure}</p>}
      {holds === null ? <small><Trans>Loading…</Trans></small> : holds.length === 0 ? <small><Trans>Nothing is waiting.</Trans></small> : (
        <ul>{holds.map((hold) => (
          <li key={hold.id}>
            <div>
              <code>{hold.path}</code>
              <small><Trans>{HOLD_REASONS[hold.reason] ?? hold.reason} · since {relativeTime(new Date(hold.since).toISOString())}</Trans></small>
              {hold.reason === "unknown_provenance" && !hold.binary && <small><Trans>This hold exists only on this computer. If another computer edited the file, it won’t show this hold. Choose Keep both here to preserve both versions. Once the computers agree, move the preserved edit to the intended folder if it is still in the old folder.</Trans></small>}
            </div>
            {hold.binary && hold.reason === "taken_over"
              ? <div className="row-actions">
                <button className="mdbase-button is-tertiary" disabled={busy} onClick={() => resolve(hold, "keep_mine")}><Trans>Keep this computer's</Trans></button>
                <small><Trans>This file is not a note: restore the other version by hand if you need it.</Trans></small>
              </div>
              : hold.binary
              ? <small><Trans>Resolve this file in the app that uses it.</Trans></small>
              : hold.reason === "unsent_edit"
              ? <div className="row-actions">
                <button className="mdbase-button is-tertiary" disabled={busy} onClick={() => resolve(hold, "keep_mine")}><Trans>Keep current</Trans></button>
                <button className="mdbase-button is-tertiary" disabled={busy} onClick={() => resolve(hold, "take_theirs")}><Trans>Use my unsent edit</Trans></button>
                <button className="mdbase-button is-tertiary" disabled={busy} onClick={() => resolve(hold, "keep_both")}><Trans>Keep both</Trans></button>
              </div>
              : hold.reason === "read_only"
              ? <div className="row-actions">
                <button className="mdbase-button is-tertiary" disabled={busy} onClick={() => resolve(hold, "keep_mine")}><Trans>Keep this computer's</Trans></button>
                <ConfirmAction className="mdbase-button is-tertiary" busy={busy} label={t(i18n)({ message: "Discard local changes" })} confirmLabel={t(i18n)({ message: "Discard" })} question={t(i18n)`Discard local changes to ${hold.path}? They haven't been synced. Copy the file first if you want to keep them.`} onConfirm={() => resolve(hold, "take_theirs")} />
                <button className="mdbase-button is-tertiary" disabled={busy} onClick={() => resolve(hold, "keep_both")}><Trans>Keep both</Trans></button>
              </div>
              : <div className="row-actions">
                <button className="mdbase-button is-tertiary" disabled={busy} onClick={() => resolve(hold, "keep_mine")}><Trans>Keep this computer's</Trans></button>
                {hold.has_theirs && <button className="mdbase-button is-tertiary" disabled={busy} onClick={() => resolve(hold, "take_theirs")}><Trans>Take the other version</Trans></button>}
                <button className="mdbase-button is-tertiary" disabled={busy} onClick={() => resolve(hold, "keep_both")}><Trans>Keep both</Trans></button>
              </div>}
          </li>
        ))}</ul>
      )}
    </div>
  );
}

/** Sync starts from the files already in the folder after the current holds are resolved. */
function TurnOnSyncDialog({ open, collection, busy, error, onAct, onClose, onConfirm }: {
  open: boolean;
  collection: DaemonCollection;
  busy: boolean;
  /** Why the last attempt to turn on sync failed, in plain words. */
  error: string | null;
  onAct: Act;
  onClose(): void;
  onConfirm(mode: "private" | "cloud-copy"): Promise<void>;
}) {
  useLocaleRevision();
  const [encrypted, setEncrypted] = useState(false);
  const [holdCount, setHoldCount] = useState<number | null>(null);
  useEffect(() => { if (open) { setEncrypted(false); setHoldCount(null); } }, [open]);
  const paused = collection.state === "paused";
  return (
    <Dialog open={open} onClose={() => !busy && onClose()} title={t(i18n)`Turn on sync for ${collection.name}`} className="modal" closeDisabled={busy}>
      {error && <p className="mdbase-message is-error" role="alert">{error}</p>}
      {paused ? <>
        {!error && <p><Trans>Resume this collection to check its files before turning on sync.</Trans></p>}
        <div className="modal-actions"><button className="mdbase-button is-primary" disabled={busy} onClick={onClose}><Trans>Back to collection</Trans></button></div>
      </> : <>
      <p><Trans>Your other devices get a copy and stay up to date. The folder stays where it is.</Trans></p>
      {holdCount !== null && holdCount > 0 && <p><Trans>Choose a version for each of these files before turning on sync.</Trans></p>}
      <div hidden={holdCount === 0}>
        <Holds collection={collection} busy={busy} onAct={onAct} onCountChange={setHoldCount} />
      </div>
      <p>{encrypted
        ? <Trans>mdbase stores only encrypted changes. Web apps and agents can use this collection only while one of your devices with the desktop app is online.</Trans>
        : <Trans>mdbase keeps a cloud copy, so web apps and agents can use this collection while your devices are off.</Trans>}</p>
      <details className="mdbase-disclosure">
        <summary><Trans>Advanced</Trans></summary>
        <label className="sync-option"><Trans>
          <input className="mdbase-checkbox" type="checkbox" checked={encrypted} disabled={busy} onChange={(event) => setEncrypted(event.target.checked)} />
          Encrypt end to end so mdbase cannot read it
        </Trans></label>
      </details>
      <div className="modal-actions">
        <button className="mdbase-button" disabled={busy} onClick={onClose}><Trans>Cancel</Trans></button>
        <button className="mdbase-button is-primary" disabled={busy || holdCount !== 0} onClick={() => void onConfirm(encrypted ? "private" : "cloud-copy")}>{busy ? t(i18n)({ message: "Turning on…", context: "Local collection management" }) : t(i18n)({ message: "Turn on sync", context: "Local collection management" })}</button>
      </div>
      </>}
    </Dialog>
  );
}
