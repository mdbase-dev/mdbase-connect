import React, { useState } from "react";
import { Dialog } from "@mdbase-dev/ui/dialog";
import { presentCollection } from "./daemon-view.mjs";
import { Empty, SectionHeading, StatusDot } from "./ui-components";
import { message, plural, relativeTime } from "./view-model";

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
  const sorted = [...collections].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="workspace-stack">
      <section>
        <SectionHeading title="Collections" note="Folders on this computer that your apps can use." count={collections.length}>
          <button className="button secondary" disabled={busy} onClick={onAdd}>Add existing</button>
          <button className="button primary" disabled={busy} onClick={onCreate}>Create</button>
        </SectionHeading>
        {sorted.length === 0
          ? <Empty title="No collections yet" text="Add a folder of Markdown notes or create a new collection." />
          : <div className="collection-list">{sorted.map((collection) => (
            <CollectionCard key={collection.id} collection={collection} busy={busy} onAct={onAct} onNotice={onNotice} onTurnOnSync={() => setSyncTarget(collection)} />
          ))}</div>}
      </section>
      {syncTarget && <TurnOnSyncDialog collection={syncTarget} busy={busy} onClose={() => setSyncTarget(null)} onConfirm={(mode) => onAct(async () => {
        await window.mdbaseConnect.enableSync(syncTarget.id, mode);
        setSyncTarget(null);
        onNotice(mode === "e2e" ? `${syncTarget.name} now syncs privately.` : `${syncTarget.name} now syncs.`);
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
  return (
    <article className="collection-card">
      <div className="collection-card-main">
        <StatusDot state={view.dot} />
        <div>
          <h3>{collection.name}</h3>
          <code>{collection.root}</code>
          <small>{view.mode} · {view.status}{view.detail ? ` · ${view.detail}` : ""}</small>
          {collection.notices.map((notice) => <small key={notice.code} className="collection-notice">{notice.message}</small>)}
        </div>
      </div>
      <div className="collection-config-actions">
        <button className="quiet-action" disabled={busy} onClick={() => void onAct(() => window.mdbaseConnect.openCollectionFolder(collection.id))}>Open folder</button>
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
      {holdsOpen && <Holds collection={collection} busy={busy} onAct={onAct} />}
    </article>
  );
}

const HOLD_REASONS: Record<string, string> = {
  conflict: "Changed here and elsewhere",
  unknown_provenance: "Changed by a program mdbase does not recognise",
  deleted_elsewhere: "Deleted on another device",
  read_only: "Changed while read-only",
  editor_busy: "Open in an editor",
  suspect_write: "Looked like an accidental overwrite"
};

function Holds({ collection, busy, onAct }: { collection: DaemonCollection; busy: boolean; onAct: Act }) {
  const [holds, setHolds] = useState<HoldSummary[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const load = () => window.mdbaseConnect.listHolds(collection.id).then(setHolds).catch((reason) => setFailure(message(reason)));
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
            {hold.binary
              ? <small>Resolve this file in the app that uses it.</small>
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

function TurnOnSyncDialog({ collection, busy, onClose, onConfirm }: {
  collection: DaemonCollection;
  busy: boolean;
  onClose(): void;
  onConfirm(mode: "e2e" | "synced"): Promise<void>;
}) {
  const [mode, setMode] = useState<"e2e" | "synced">("e2e");
  return (
    <Dialog open onClose={() => !busy && onClose()} title={`Turn on sync for ${collection.name}`} className="modal" closeDisabled={busy}>
      <p className="eyebrow">Sync</p>
      <p>Your other devices get a copy and stay up to date. The folder stays where it is.</p>
      <fieldset className="authority-choice">
        <legend>How should it sync?</legend>
        <label className={mode === "e2e" ? "selected" : ""}>
          <input type="radio" name="sync-mode" checked={mode === "e2e"} disabled={busy} onChange={() => setMode("e2e")} />
          <span><strong>Private</strong><small>End-to-end encrypted: mdbase cannot read it. Web apps work only while one of your devices is online.</small></span>
        </label>
        <label className={mode === "synced" ? "selected" : ""}>
          <input type="radio" name="sync-mode" checked={mode === "synced"} disabled={busy} onChange={() => setMode("synced")} />
          <span><strong>Synced</strong><small>mdbase keeps a copy, so web apps and agents can use it while your devices are off.</small></span>
        </label>
      </fieldset>
      <div className="modal-actions">
        <button className="button secondary" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="button primary" disabled={busy} onClick={() => void onConfirm(mode)}>{busy ? "Turning on…" : "Turn on sync"}</button>
      </div>
    </Dialog>
  );
}
