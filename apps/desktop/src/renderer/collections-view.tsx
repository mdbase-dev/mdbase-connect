import { t, plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useLocaleRevision, i18n } from "@mdbase-dev/ui/i18n";
import React, { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "@mdbase-dev/ui/dialog";
import { Menu } from "@mdbase-dev/ui/menu";
import { ConfirmDialog } from "@mdbase-dev/ui/confirm-dialog";
import { CollectionModeControl } from "@mdbase-dev/ui/collection-mode";
import { groupedApprovalCode, presentCollection } from "./daemon-view.mjs";
import { ConfirmAction } from "@mdbase/connect-ui/confirm-action";
import { Empty, ListFilter, SectionHeading } from "./ui-components";
import { message, relativeTime, syncEnableMessage } from "./view-model";
import type { TakeoverHold } from "./takeover-state.mjs";

type Act = (action: () => Promise<unknown>) => Promise<void>;

export function CollectionsView({ collections, computerName, busy, onAdd, onCreate, onAct, onNotice }: {
  collections: DaemonCollection[];
  computerName: string;
  busy: boolean;
  onAdd(): void;
  onCreate(): void;
  onAct: Act;
  onNotice(value: string): void;
}) {
  useLocaleRevision();
  const [query, setQuery] = useState("");
  const [syncTarget, setSyncTarget] = useState<DaemonCollection | null>(null);
  const [lastSyncTarget, setLastSyncTarget] = useState<DaemonCollection | null>(null);
  const [syncFailure, setSyncFailure] = useState<string | null>(null);
  const openSync = (collection: DaemonCollection | null) => { setSyncFailure(null); setSyncTarget(collection); if (collection) setLastSyncTarget(collection); };
  const sorted = collections.filter(collection => `${collection.name} ${collection.root}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).sort((a, b) => a.name.localeCompare(b.name));
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
            <CollectionCard key={collection.id} collection={collection} computerName={computerName} busy={busy} onAct={onAct} onNotice={onNotice} onTurnOnSync={() => openSync(collection)} />
          ))}</div>}
      </section>
      {lastSyncTarget && <TurnOnSyncDialog key={lastSyncTarget.id} open={syncTarget !== null} collection={lastSyncTarget} busy={busy} error={syncFailure} onAct={onAct} onClose={() => openSync(null)} onConfirm={(mode, acceptTakeoverHolds) => onAct(async () => {
        setSyncFailure(null);
        try {
          await window.mdbaseConnect.enableSync(lastSyncTarget.id, mode, acceptTakeoverHolds);
        } catch (error) {
          // Shown in the dialog the user is looking at, not behind it.
          setSyncFailure(syncEnableMessage(error));
          return;
        }
        openSync(null);
        onNotice(mode === "private" ? t(i18n)`${lastSyncTarget.name} now syncs privately.` : t(i18n)`${lastSyncTarget.name} now syncs.`);
      })} />}
    </div>
  );
}

function CollectionCard({ collection, computerName, busy, onAct, onNotice, onTurnOnSync }: {
  collection: DaemonCollection;
  computerName: string;
  busy: boolean;
  onAct: Act;
  onNotice(value: string): void;
  onTurnOnSync(): void;
}) {
  useLocaleRevision();
  const view = presentCollection(collection);
  const [holdsOpen, setHoldsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const menuId = useId();
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const closeMenu = (refocus: boolean) => { setMenuOpen(false); if (refocus) menuTrigger.current?.focus(); };
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
      {collection.approval_code && <div className="approval-check" aria-live="polite">
        <span><Trans>Check this code matches on your other computer:</Trans></span>
        <strong className="approval-code">{groupedApprovalCode(collection.approval_code)}</strong>
      </div>}
      {collection.notices.filter((notice) => notice.code !== "file_held" && notice.code !== "collection_deleted" && notice.code !== "sync_revoked").map((notice, index) => <small key={`${notice.code}:${notice.path ?? index}`} className="collection-notice">{notice.path && <><code>{notice.path}</code>{": "}</>}{notice.message}</small>)}
      <Menu open={menuOpen} triggerRef={menuTrigger} onClose={closeMenu} id={menuId} label={collection.name}>
        <button role="menuitem" className="mdbase-menu-item" disabled={busy} onClick={() => { closeMenu(true); void onAct(() => window.mdbaseConnect.openCollectionFolder(collection.id)); }}><Trans>Open folder</Trans></button>
        <button role="menuitem" className="mdbase-menu-item" onClick={() => { closeMenu(true); setDetailsOpen((open) => !open); }}><Trans>Details</Trans></button>
        {view.holds > 0 && <button role="menuitem" className="mdbase-menu-item" onClick={() => { closeMenu(true); setHoldsOpen((open) => !open); }}>{holdsOpen ? t(i18n)`Hide ${plural(view.holds, { one: "# file", other: "# files" })}` : t(i18n)`Review ${plural(view.holds, { one: "# file", other: "# files" })}`}</button>}
        {view.canEnableSync && <button role="menuitem" className="mdbase-menu-item" disabled={busy} onClick={() => { closeMenu(true); onTurnOnSync(); }}><Trans>Turn on sync</Trans></button>}
        <button role="menuitem" className="mdbase-menu-item" disabled={busy || collection.state === "opening"} onClick={() => { closeMenu(true); void onAct(() => window.mdbaseConnect.setCollectionEnabled(collection.id, view.paused)); }}>{view.paused ? t(i18n)({ message: "Resume", context: "Local collection management" }) : t(i18n)({ message: "Pause", context: "Local collection management" })}</button>
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
      {["synced", "synced_e2e"].includes(collection.mode) && <CollectionModeControl collectionId={collection.id} native load={() => window.mdbaseConnect.collectionModeStatus(collection.id)} change={(target) => window.mdbaseConnect.changeCollectionMode(collection.id, target, false)} cancel={(target) => window.mdbaseConnect.changeCollectionMode(collection.id, target, false, true)} />}
      <div className="row-actions">
        <button className="mdbase-button" disabled={saving} onClick={() => onDone(null)}><Trans>Cancel</Trans></button>
        <button className="mdbase-button is-primary" disabled={saving || !name.trim()} onClick={() => void save()}>{saving ? t(i18n)({ message: "Saving…", context: "Local collection management" }) : t(i18n)({ message: "Save details", context: "Local collection management" })}</button>
      </div>
    </div>
  );
}

const HOLD_REASONS: Record<string, string> = {
  get conflict() { return t(i18n)({ message: "Changed here and elsewhere" }); },
  get unknown_provenance() { return t(i18n)({ message: "Changed by a program mdbase does not recognise" }); },
  get deleted_elsewhere() { return t(i18n)({ message: "Deleted on another device" }); },
  get read_only() { return t(i18n)({ message: "Changed while read-only", context: "Local collection management" }); },
  get editor_busy() { return t(i18n)({ message: "Open in an editor", context: "Local collection management" }); },
  get suspect_write() { return t(i18n)({ message: "Looked like an accidental overwrite" }); },
  get taken_over() { return t(i18n)({ message: "Differed when mdbase took over from the old app; this computer's version is in the folder" }); },
  get unsent_edit() { return t(i18n)({ message: "Edited here before the move but never uploaded, and changed elsewhere since; the current version is in the folder" }); }
};

function Holds({ collection, busy, onAct, onLoaded }: {
  collection: DaemonCollection;
  busy: boolean;
  onAct: Act;
  onLoaded?(holds: HoldSummary[]): void;
}) {
  useLocaleRevision();
  const [holds, setHolds] = useState<HoldSummary[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const load = () => window.mdbaseConnect.listHolds(collection.id)
    .then((list) => { setHolds(list); onLoaded?.(list); })
    .catch((reason) => setFailure(message(reason)));
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
            <div><code>{hold.path}</code><small><Trans>{HOLD_REASONS[hold.reason] ?? hold.reason} · since {relativeTime(new Date(hold.since).toISOString())}</Trans></small></div>
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

/**
 * Sync starts from the files already in the folder (a taken-over folder included).
 * Files waiting for a decision come first and are resolved one by one, files held at
 * the takeover included. A daemon that does not list those files as holds yet (an
 * older build) still reports them through the takeover status: they are then listed
 * here and must be checked before sync is turned on with them as they are.
 */
function TurnOnSyncDialog({ open, collection, busy, error, onAct, onClose, onConfirm }: {
  open: boolean;
  collection: DaemonCollection;
  busy: boolean;
  /** Why the last attempt to turn on sync failed, in plain words. */
  error: string | null;
  onAct: Act;
  onClose(): void;
  onConfirm(mode: "private" | "cloud-copy", acceptTakeoverHolds: boolean): Promise<void>;
}) {
  useLocaleRevision();
  const [mode, setMode] = useState<"private" | "cloud-copy">("private");
  const [takeover, setTakeover] = useState<{ takenOver: boolean; held: TakeoverHold[] } | null>(null);
  const [holds, setHolds] = useState<HoldSummary[] | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => { if (open) { setMode("private"); setTakeover(null); setHolds(null); setReviewed(false); setFailure(null); } }, [open]);
  // Read with each hold list, so a file resolved through the hold path drops out of both.
  const holdsLoaded = (list: HoldSummary[]) => {
    window.mdbaseConnect.migrationStatus()
      .then((status) => {
        setTakeover({
          takenOver: Boolean(status.record?.collections[collection.id]),
          held: status.holds?.[collection.id] ?? []
        });
        setHolds(list);
      })
      .catch((reason) => setFailure(message(reason)));
  };
  const unlisted = takeover && holds ? takeover.held.filter((held) => !holds.some((hold) => hold.path === held.path)) : [];
  const ready = takeover !== null && holds !== null && holds.length === 0 && (unlisted.length === 0 || reviewed);
  return (
    <Dialog open={open} onClose={() => !busy && onClose()} title={t(i18n)`Turn on sync for ${collection.name}`} className="modal" closeDisabled={busy}>
      <p className="eyebrow"><Trans>Sync</Trans></p>
      <p><Trans>Your other devices get a copy and stay up to date. The folder stays where it is{takeover?.takenOver ? t(i18n)({ message: ", and the files already in it become the first synced version" }) : ""}.</Trans></p>
      {failure && <p className="mdbase-message is-error" role="alert">{failure}</p>}
      {error && <p className="mdbase-message is-error" role="alert">{error}</p>}
      {holds !== null && holds.length > 0 && <p><Trans>Choose a version for each of these files before turning on sync.</Trans></p>}
      <div hidden={holds !== null && holds.length === 0}>
        <Holds collection={collection} busy={busy} onAct={onAct} onLoaded={holdsLoaded} />
      </div>
      {unlisted.length > 0 && (
        <div className="collection-holds">
          <p>{t(i18n)`When this folder moved to the new sync engine, mdbase kept another version of ${plural(unlisted.length, { one: "# file", other: "# files" })}. The folder has this computer's version; check it before sync starts from it.`}</p>
          <ul>{unlisted.map((hold) => <li key={hold.path}><code>{hold.path}</code></li>)}</ul>
          <label className="takeover-option"><Trans>
            <input className="mdbase-checkbox" type="checkbox" checked={reviewed} disabled={busy} onChange={(event) => setReviewed(event.target.checked)} />
            I have checked these files
          </Trans></label>
        </div>
      )}
      <fieldset className="authority-choice">
        <legend><Trans>How should it sync?</Trans></legend>
        <label className={mode === "private" ? "selected" : ""}>
          <input type="radio" name="sync-mode" checked={mode === "private"} disabled={busy} onChange={() => setMode("private")} />
          <span><strong><Trans>Private</Trans></strong><small><Trans>End-to-end encrypted: mdbase cannot read it. Web apps work only while one of your devices is online.</Trans></small></span>
        </label>
        <label className={mode === "cloud-copy" ? "selected" : ""}>
          <input type="radio" name="sync-mode" checked={mode === "cloud-copy"} disabled={busy} onChange={() => setMode("cloud-copy")} />
          <span><strong><Trans>Cloud copy</Trans></strong><small><Trans>mdbase keeps a copy, so web apps and agents can use it while your devices are off.</Trans></small></span>
        </label>
      </fieldset>
      <div className="modal-actions">
        <button className="mdbase-button" disabled={busy} onClick={onClose}><Trans>Cancel</Trans></button>
        <button className="mdbase-button is-primary" disabled={busy || !ready} onClick={() => void onConfirm(mode, unlisted.length > 0 && reviewed)}>{busy ? t(i18n)({ message: "Turning on…", context: "Local collection management" }) : t(i18n)({ message: "Turn on sync", context: "Local collection management" })}</button>
      </div>
    </Dialog>
  );
}
