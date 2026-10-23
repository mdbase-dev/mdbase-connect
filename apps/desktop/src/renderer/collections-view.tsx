import React, { useState } from "react";
import { Dialog } from "@mdbase-dev/ui/dialog";
import { presentCollection } from "./daemon-view.mjs";
import { Empty, SectionHeading, StatusDot } from "./ui-components";
import { message, plural, relativeTime, syncEnableMessage } from "./view-model";
import type { TakeoverHold } from "./takeover-state.mjs";

type Act = (action: () => Promise<unknown>) => Promise<void>;

export function CollectionsView({ collections, busy, onAdd, onCreate, onAct, onNotice }: {
  collections: DaemonCollection[];
  busy: boolean;
  onAdd(): void;
  onCreate(): void;
  onAct: Act;
  onNotice(value: string): void;
}) {
  const [syncTarget, setSyncTarget] = useState<DaemonCollection | null>(null);
  const [syncFailure, setSyncFailure] = useState<string | null>(null);
  const openSync = (collection: DaemonCollection | null) => { setSyncFailure(null); setSyncTarget(collection); };
  const sorted = [...collections].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="workspace-stack">
      <section>
        <SectionHeading title="On this computer" note="Each folder stays where it is. Sync is optional.">
          <button className="button secondary" disabled={busy} onClick={onAdd}>Add existing</button>
          <button className="button primary" disabled={busy} onClick={onCreate}>Create</button>
        </SectionHeading>
        {sorted.length === 0
          ? <Empty title="No collections yet" text="Add a folder of Markdown notes or create a new collection." />
          : <div className="collection-list">{sorted.map((collection) => (
            <CollectionCard key={collection.id} collection={collection} busy={busy} onAct={onAct} onNotice={onNotice} onTurnOnSync={() => openSync(collection)} />
          ))}</div>}
      </section>
      {syncTarget && <TurnOnSyncDialog collection={syncTarget} busy={busy} error={syncFailure} onAct={onAct} onClose={() => openSync(null)} onConfirm={(mode, acceptTakeoverHolds) => onAct(async () => {
        setSyncFailure(null);
        try {
          await window.mdbaseConnect.enableSync(syncTarget.id, mode, acceptTakeoverHolds);
        } catch (error) {
          // Shown in the dialog the user is looking at, not behind it.
          setSyncFailure(syncEnableMessage(error));
          return;
        }
        openSync(null);
        onNotice(mode === "private" ? `${syncTarget.name} now syncs privately.` : `${syncTarget.name} now syncs.`);
      })} />}
    </div>
  );
}

function CollectionCard({ collection, busy, onAct, onNotice, onTurnOnSync }: {
  collection: DaemonCollection;
  busy: boolean;
  onAct: Act;
  onNotice(value: string): void;
  onTurnOnSync(): void;
}) {
  const view = presentCollection(collection);
  const [holdsOpen, setHoldsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  return (
    <article className="collection-card">
      <div className="collection-card-main">
        <StatusDot state={view.dot} />
        <div>
          <h3>{collection.name}</h3>
          {collection.description && <small className="collection-description">{collection.description}</small>}
          <code>{collection.root}</code>
          <small>{view.mode} · {view.status}{view.detail ? ` · ${view.detail}` : ""}</small>
          {collection.notices.map((notice) => <small key={notice.code} className="collection-notice">{notice.message}</small>)}
        </div>
      </div>
      <div className="collection-config-actions">
        <button className="quiet-action" disabled={busy} onClick={() => void onAct(() => window.mdbaseConnect.openCollectionFolder(collection.id))}>Open folder</button>
        <button className="quiet-action" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((open) => !open)}>Details</button>
        {view.holds > 0 && <button className="quiet-action" onClick={() => setHoldsOpen((open) => !open)}>{holdsOpen ? "Hide" : "Review"} {view.holds} {plural(view.holds, "file", "files")}</button>}
        {view.canEnableSync && <button className="quiet-action" disabled={busy} onClick={onTurnOnSync}>Turn on sync</button>}
        {view.canDisableSync && <button className="quiet-action" disabled={busy} onClick={() => {
          if (!window.confirm(`Stop syncing ${collection.name}? It stays on this computer; your other devices and web apps stop receiving its changes.`)) return;
          void onAct(async () => {
            await window.mdbaseConnect.disableSync(collection.id);
            onNotice(`${collection.name} is on this computer only now.`);
          });
        }}>Turn off sync</button>}
        <button className="quiet-action" disabled={busy || collection.state === "opening"} onClick={() => void onAct(() => window.mdbaseConnect.setCollectionEnabled(collection.id, view.paused))}>{view.paused ? "Resume" : "Pause"}</button>
        <button className="quiet-action danger" disabled={busy} onClick={() => {
          if (!window.confirm(`Remove ${collection.name} from mdbase? Apps stop using it. The folder and its files stay where they are.`)) return;
          void onAct(async () => {
            await window.mdbaseConnect.removeCollection(collection.id);
            onNotice(`${collection.name} was removed. Its files were not touched.`);
          });
        }}>Remove</button>
      </div>
      {detailsOpen && <Details collection={collection} onDone={(saved) => { setDetailsOpen(false); if (saved) onNotice(`${saved.name} was saved.`); }} />}
      {holdsOpen && <Holds collection={collection} busy={busy} onAct={onAct} />}
    </article>
  );
}

/** Name and description. The draft survives a failed save; nothing is editable while saving. */
function Details({ collection, onDone }: { collection: DaemonCollection; onDone(saved: DaemonCollection | null): void }) {
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
      {failure && <p className="message error-message" role="alert">{failure}</p>}
      <label><span>Name</span><input value={name} maxLength={100} disabled={saving} onChange={(event) => setName(event.target.value)} /></label>
      <label><span>Description</span><textarea value={description} maxLength={500} disabled={saving} onChange={(event) => setDescription(event.target.value)} placeholder="What this collection is for" /></label>
      <small>The folder is not renamed. The description stays on this computer.</small>
      <div className="row-actions">
        <button className="button secondary" disabled={saving} onClick={() => onDone(null)}>Cancel</button>
        <button className="button primary" disabled={saving || !name.trim()} onClick={() => void save()}>{saving ? "Saving…" : "Save details"}</button>
      </div>
    </div>
  );
}

const HOLD_REASONS: Record<string, string> = {
  conflict: "Changed here and elsewhere",
  unknown_provenance: "Changed by a program mdbase does not recognise",
  deleted_elsewhere: "Deleted on another device",
  read_only: "Changed while read-only",
  editor_busy: "Open in an editor",
  suspect_write: "Looked like an accidental overwrite",
  taken_over: "Differed when mdbase took over from the old app; this computer's version is in the folder",
  unsent_edit: "Edited here before the move but never uploaded, and changed elsewhere since; the current version is in the folder"
};

function Holds({ collection, busy, onAct, onLoaded }: {
  collection: DaemonCollection;
  busy: boolean;
  onAct: Act;
  onLoaded?(holds: HoldSummary[]): void;
}) {
  const [holds, setHolds] = useState<HoldSummary[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const load = () => window.mdbaseConnect.listHolds(collection.id)
    .then((list) => { setHolds(list); onLoaded?.(list); })
    .catch((reason) => setFailure(message(reason)));
  React.useEffect(() => { void load(); }, [collection.id, collection.sync?.holds]);
  const resolve = (hold: HoldSummary, how: "keep_mine" | "take_theirs" | "keep_both") =>
    void onAct(async () => { await window.mdbaseConnect.resolveHold(collection.id, hold.id, how); await load(); });
  return (
    <div className="collection-holds">
      <p>mdbase kept these files instead of overwriting them. Choose which version to keep.</p>
      {failure && <p className="message error-message" role="alert">{failure}</p>}
      {holds === null ? <small>Loading…</small> : holds.length === 0 ? <small>Nothing is waiting.</small> : (
        <ul>{holds.map((hold) => (
          <li key={hold.id}>
            <div><code>{hold.path}</code><small>{HOLD_REASONS[hold.reason] ?? hold.reason} · since {relativeTime(new Date(hold.since).toISOString())}</small></div>
            {hold.binary && hold.reason === "taken_over"
              ? <div className="row-actions">
                <button className="quiet-action" disabled={busy} onClick={() => resolve(hold, "keep_mine")}>Keep this computer's</button>
                <small>This file is not a note: restore the other version by hand if you need it.</small>
              </div>
              : hold.binary
              ? <small>Resolve this file in the app that uses it.</small>
              : hold.reason === "unsent_edit"
              ? <div className="row-actions">
                <button className="quiet-action" disabled={busy} onClick={() => resolve(hold, "keep_mine")}>Keep current</button>
                <button className="quiet-action" disabled={busy} onClick={() => resolve(hold, "take_theirs")}>Use my unsent edit</button>
                <button className="quiet-action" disabled={busy} onClick={() => resolve(hold, "keep_both")}>Keep both</button>
              </div>
              : <div className="row-actions">
                <button className="quiet-action" disabled={busy} onClick={() => resolve(hold, "keep_mine")}>Keep this computer's</button>
                {hold.has_theirs && <button className="quiet-action" disabled={busy} onClick={() => resolve(hold, "take_theirs")}>Take the other version</button>}
                <button className="quiet-action" disabled={busy} onClick={() => resolve(hold, "keep_both")}>Keep both</button>
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
function TurnOnSyncDialog({ collection, busy, error, onAct, onClose, onConfirm }: {
  collection: DaemonCollection;
  busy: boolean;
  /** Why the last attempt to turn on sync failed, in plain words. */
  error: string | null;
  onAct: Act;
  onClose(): void;
  onConfirm(mode: "private" | "cloud-copy", acceptTakeoverHolds: boolean): Promise<void>;
}) {
  const [mode, setMode] = useState<"private" | "cloud-copy">("private");
  const [takeover, setTakeover] = useState<{ takenOver: boolean; held: TakeoverHold[] } | null>(null);
  const [holds, setHolds] = useState<HoldSummary[] | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
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
    <Dialog open onClose={() => !busy && onClose()} title={`Turn on sync for ${collection.name}`} className="modal" closeDisabled={busy}>
      <p className="eyebrow">Sync</p>
      <p>Your other devices get a copy and stay up to date. The folder stays where it is{takeover?.takenOver ? ", and the files already in it become the first synced version" : ""}.</p>
      {failure && <p className="message error-message" role="alert">{failure}</p>}
      {error && <p className="message error-message" role="alert">{error}</p>}
      {holds !== null && holds.length > 0 && <p>Choose a version for each of these files before turning on sync.</p>}
      <div hidden={holds !== null && holds.length === 0}>
        <Holds collection={collection} busy={busy} onAct={onAct} onLoaded={holdsLoaded} />
      </div>
      {unlisted.length > 0 && (
        <div className="collection-holds">
          <p>When this folder moved to the new sync engine, mdbase kept another version of {unlisted.length} {plural(unlisted.length, "file", "files")}. The folder has this computer's version; check it before sync starts from it.</p>
          <ul>{unlisted.map((hold) => <li key={hold.path}><code>{hold.path}</code></li>)}</ul>
          <label className="takeover-option">
            <input type="checkbox" checked={reviewed} disabled={busy} onChange={(event) => setReviewed(event.target.checked)} />
            I have checked these files
          </label>
        </div>
      )}
      <fieldset className="authority-choice">
        <legend>How should it sync?</legend>
        <label className={mode === "private" ? "selected" : ""}>
          <input type="radio" name="sync-mode" checked={mode === "private"} disabled={busy} onChange={() => setMode("private")} />
          <span><strong>Private</strong><small>End-to-end encrypted: mdbase cannot read it. Web apps work only while one of your devices is online.</small></span>
        </label>
        <label className={mode === "cloud-copy" ? "selected" : ""}>
          <input type="radio" name="sync-mode" checked={mode === "cloud-copy"} disabled={busy} onChange={() => setMode("cloud-copy")} />
          <span><strong>Cloud copy</strong><small>mdbase keeps a copy, so web apps and agents can use it while your devices are off.</small></span>
        </label>
      </fieldset>
      <div className="modal-actions">
        <button className="button secondary" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="button primary" disabled={busy || !ready} onClick={() => void onConfirm(mode, unlisted.length > 0 && reviewed)}>{busy ? "Turning on…" : "Turn on sync"}</button>
      </div>
    </Dialog>
  );
}
