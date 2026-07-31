import { useEffect, useState } from "react";
import { Empty, SectionHeading, StatusDot } from "./ui-components";
import {
  authorityPromotionState,
  mirrorState,
  plural,
  relativeTime
} from "./view-model";

export function Collections({
  collections,
  hosted,
  cloudConfigured,
  mirrors,
  mirrorTarget,
  authorityConflicts,
  busy,
  copiedCollectionPath,
  onAdd,
  onCancelCopy,
  onCreate,
  onRegisterCopy,
  onMirrorTargetHandled,
  onAct,
  onNotice
}: {
  collections: CollectionSummary[];
  hosted: HostedControlSnapshot;
  cloudConfigured: boolean;
  mirrors: DesktopMirrorSummary[];
  mirrorTarget: string | null;
  authorityConflicts: AuthorityConflict[];
  busy: boolean;
  copiedCollectionPath: string | null;
  onAdd(): void;
  onCancelCopy(): void;
  onCreate(): void;
  onRegisterCopy(): void;
  onMirrorTargetHandled(): void;
  onAct(action: () => Promise<void>): Promise<void>;
  onNotice(value: string): void;
}) {
  return (
    <section className="collection-section">
      <SectionHeading title="Collections" note="Main copies and synced folders are shown separately.">
        <button className="button secondary" disabled={busy} onClick={onAdd}>Add existing</button>
        <button className="button primary" disabled={busy} onClick={onCreate}>Create collection</button>
      </SectionHeading>
      {copiedCollectionPath && (
        <section className="copy-registration" aria-labelledby="copy-title">
          <div>
            <p className="eyebrow">Copied collection</p>
            <h2 id="copy-title">Register this copy independently?</h2>
            <p>This folder has the same Connect identity as a registered collection. Continuing writes a new identity only to the selected copy’s <code>mdbase.yaml</code>. The original is not changed.</p>
            <code>{copiedCollectionPath}</code>
            <small>Apps will treat the copy as a separate collection with its own links and access approvals.</small>
          </div>
          <div className="copy-registration-actions">
            <button className="button secondary" disabled={busy} onClick={onCancelCopy}>Cancel</button>
            <button className="button primary" disabled={busy} onClick={onRegisterCopy}>Register copy</button>
          </div>
        </section>
      )}
      {authorityConflicts.map((conflict) => {
        const selectedFolder = collections.find(
          (collection) => collection.id === conflict.collection_id
        )?.path ?? conflict.display_name;
        return <section className="copy-registration" aria-labelledby={`authority-${conflict.collection_id}`} key={conflict.collection_id}>
          <div>
            <p className="eyebrow">Same collection in two places</p>
            <h2 id={`authority-${conflict.collection_id}`}>Choose which copy of {conflict.display_name} to use.</h2>
            <p>The selected folder and an existing connected copy share the same collection ID.</p>
            <dl className="identity-conflict-details">
              <div><dt>Selected folder</dt><dd><code title={selectedFolder}>{selectedFolder}</code></dd></div>
              <div><dt>Currently active through</dt><dd>{conflict.active_connector_name}</dd></div>
            </dl>
            <small>Using the selected folder makes it the main copy and revokes application access through {conflict.active_connector_name}. Keeping both writes a new ID only to the selected folder’s <code>mdbase.yaml</code>.</small>
          </div>
          <div className="copy-registration-actions">
            <button className="button secondary" disabled={busy} onClick={() => void onAct(async () => {
              const independent = await window.mdbaseConnect.makeCollectionIndependent(conflict.collection_id);
              onNotice(`${independent.display_name} now has an independent collection identity.`);
            })}>Keep both copies</button>
            <button className="button primary" disabled={busy} onClick={() => void onAct(async () => {
              if (!window.confirm(`Use ${selectedFolder} as the main copy of ${conflict.display_name}? Existing application access through ${conflict.active_connector_name} will be revoked.`)) return;
              await window.mdbaseConnect.takeCollectionAuthority(conflict.collection_id);
              onNotice(`${conflict.display_name} now uses ${selectedFolder} as its main folder.`);
            })}>Use selected folder</button>
          </div>
        </section>;
      })}
      <div className="collection-authority-group">
        <SectionHeading title="On this computer" note="Each folder below is the main copy of its collection." count={collections.length} />
        {collections.length === 0 ? (
          <Empty title="No computer-owned collections" text="Add a folder with an existing mdbase.yaml, or create one here." />
        ) : (
          <div className="collection-list">
            {collections.map((collection) => (
              <CollectionRow
                key={collection.id}
                collection={collection}
                cloudConfigured={cloudConfigured}
                busy={busy}
                onAct={onAct}
                onNotice={onNotice}
              />
            ))}
          </div>
        )}
      </div>
      <div className="collection-authority-group">
        <SectionHeading
          title="Hosted by mdbase"
          note={!cloudConfigured
            ? "Connect this computer to manage hosted collections."
            : hosted.online
              ? "Available to approved apps without this computer."
              : "Hosted controls are offline; last known state is shown."}
          count={hosted.hosted_collections.length}
        />
        {hosted.hosted_collections.length === 0 ? (
          <Empty title="No hosted collections" text="Create one to keep its main copy available without this computer, with an optional synced folder here." />
        ) : (
          <div className="collection-list">
            {hosted.hosted_collections.map((collection) => (
              <HostedCollectionRow
                key={collection.id}
                collection={collection}
                mirrors={mirrors}
                openMirror={mirrorTarget === collection.id}
                busy={busy}
                onTargetHandled={onMirrorTargetHandled}
                onAct={onAct}
                onNotice={onNotice}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function CollectionRow({ collection, cloudConfigured, busy, onAct, onNotice }: {
  collection: CollectionSummary;
  cloudConfigured: boolean;
  busy: boolean;
  onAct(action: () => Promise<void>): Promise<void>;
  onNotice(value: string): void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(collection.display_name);
  const [description, setDescription] = useState(collection.description ?? "");
  useEffect(() => {
    if (!editing) {
      setName(collection.display_name);
      setDescription(collection.description ?? "");
    }
  }, [collection.description, collection.display_name, editing]);

  const changed = name.trim() !== collection.display_name
    || description.trim() !== (collection.description ?? "");
  return (
    <article className={`collection-card ${editing ? "editing" : ""}`}>
      <div className="collection-summary">
        <div className="collection-copy">
          <div className="collection-title-row"><h3>{collection.display_name}</h3><span className="version">v{collection.spec_version}</span></div>
          {collection.description && <p>{collection.description}</p>}
          <button className="path" title={collection.path} onClick={() => void window.mdbaseConnect.openPath(collection.path)}>{collection.path}</button>
        </div>
        <div className="collection-status"><StatusDot state={collection.enabled ? "connected" : "idle"} />{collection.enabled ? "Available" : "Disabled"}</div>
        <div className="row-actions">
          <button
            className="quiet-action"
            disabled={busy}
            onClick={() => void window.mdbaseConnect.openEditor(collection.id)}
          >
            Open in editor <span aria-hidden="true">↗</span>
          </button>
          <button className="quiet-action" disabled={busy} aria-expanded={editing} onClick={() => setEditing((value) => !value)}>{editing ? "Close" : "Details"}</button>
          <button className="quiet-action" disabled={busy} onClick={() => void onAct(async () => { await window.mdbaseConnect.setCollectionEnabled(collection.id, !collection.enabled); onNotice(collection.enabled ? `${collection.display_name} is no longer available to remote applications.` : `${collection.display_name} is available again.`); })}>{collection.enabled ? "Disable" : "Enable"}</button>
        </div>
      </div>
      {editing && <div className="collection-editor">
        <form className="collection-editor-form" onSubmit={(event) => { event.preventDefault(); void onAct(async () => { const updated = await window.mdbaseConnect.updateCollectionMetadata({ collectionId: collection.id, name, description }); setEditing(false); onNotice(`${updated.display_name} details were saved to mdbase.yaml.`); }); }}>
          <section className="collection-editor-section">
            <div><strong>Details</strong><small>Name and description are stored in mdbase.yaml.</small></div>
            <div className="collection-fields">
              <label><span>Name</span><input value={name} maxLength={100} required onChange={(event) => setName(event.target.value)} /></label>
              <label><span>Description</span><textarea value={description} maxLength={500} rows={2} placeholder="Optional" onChange={(event) => setDescription(event.target.value)} /></label>
            </div>
          </section>
          <section className="collection-editor-section">
            <div><strong>Configuration</strong><small>Inspect the source file or check the collection structure.</small></div>
            <div className="collection-config-actions">
              <button type="button" className="quiet-action" disabled={busy} onClick={() => void window.mdbaseConnect.openCollectionConfig(collection.id)}>Open mdbase.yaml</button>
              <button type="button" className="quiet-action" disabled={busy} onClick={() => void onAct(async () => { await window.mdbaseConnect.validateCollection(collection.id); onNotice(`${collection.display_name} passed collection validation.`); })}>Validate collection</button>
            </div>
          </section>
          <footer className="request-footer collection-editor-footer">
            <p>Saving changes updates collection metadata without moving or rewriting records.</p>
            <button className="button primary" disabled={busy || !changed || !name.trim()}>Save details</button>
          </footer>
        </form>
        <section className="collection-editor-section">
          <div>
            <strong>Main copy</strong>
            <small>Keep this collection available without this computer while this folder continues to sync edits both ways.</small>
          </div>
          <div className="collection-config-actions">
            <button
              type="button"
              className="button secondary"
              disabled={busy || !cloudConfigured || !collection.enabled}
              onClick={() => {
                if (!window.confirm(
                  `Make ${collection.display_name} available without this computer? `
                  + "The main copy will move to mdbase, existing app access for this folder will be revoked, "
                  + "and this folder will continue to sync edits both ways."
                )) return;
                void onAct(async () => {
                  await window.mdbaseConnect.transferCollectionAuthority(collection.id);
                  setEditing(false);
                  onNotice(`${collection.display_name} is now available without this computer. This folder will stay in sync.`);
                });
              }}
            >
              Make available without this computer
            </button>
            {!cloudConfigured && <small>Connect this computer to an account first.</small>}
          </div>
        </section>
        <div className="collection-danger-row">
          <small>Removing this collection from mdbase connect never deletes its files.</small>
          <button className="quiet-action danger" disabled={busy} onClick={() => { if (window.confirm(`Remove ${collection.display_name} from mdbase connect? Its files will not be deleted.`)) void onAct(async () => { await window.mdbaseConnect.removeCollection(collection.id); onNotice(`${collection.display_name} was removed.`); }); }}>Remove from mdbase connect</button>
        </div>
      </div>}
    </article>
  );
}

function HostedCollectionRow({
  collection,
  mirrors,
  openMirror,
  busy,
  onTargetHandled,
  onAct,
  onNotice
}: {
  collection: HostedCollectionSummary;
  mirrors: DesktopMirrorSummary[];
  openMirror: boolean;
  busy: boolean;
  onTargetHandled(): void;
  onAct(action: () => Promise<void>): Promise<void>;
  onNotice(value: string): void;
}) {
  const [editing, setEditing] = useState(openMirror);
  const [name, setName] = useState(collection.display_name);
  const [path, setPath] = useState("");
  const [mode, setMode] = useState<"read_only" | "read_write">("read_write");
  const [promotionStarting, setPromotionStarting] = useState(false);
  const mirror = mirrors.find((candidate) => candidate.collection_id === collection.id);
  const activeReplicas = collection.replicas.filter((replica) => replica.revoked_at === null);
  const editorCollectionId = collection.authority_state === "active"
    ? collection.id
    : collection.authority_state === "transferred"
      ? collection.transferred_collection_id
      : null;

  useEffect(() => {
    if (openMirror) {
      setEditing(true);
      onTargetHandled();
    }
  }, [onTargetHandled, openMirror]);
  useEffect(() => {
    if (!editing) setName(collection.display_name);
  }, [collection.display_name, editing]);

  async function chooseMirrorFolder() {
    const selected = await window.mdbaseConnect.chooseMirrorFolder();
    if (selected) setPath(selected);
  }

  const state = mirrorState(mirror);
  const promotion = authorityPromotionState(collection, mirror, promotionStarting);
  return (
    <article className={`collection-card hosted-collection ${editing ? "editing" : ""}`}>
      <div className="collection-summary">
        <div className="collection-copy">
          <div className="collection-title-row">
            <h3>{collection.display_name}</h3>
            <span className="version">v{collection.spec_version}</span>
          </div>
          <span className="authority-label">
            {collection.authority_state === "transferred"
              ? "Hosted copy retired · main copy moved"
              : collection.authority_state === "transferring"
                ? "Main copy is moving"
                : `Main copy hosted by mdbase · ${activeReplicas.length} synced ${plural(activeReplicas.length, "folder", "folders")}`}
          </span>
        </div>
        <div className="collection-status">
          <StatusDot state={collection.authority_state === "active" ? "connected" : "idle"} />
          {collection.authority_state === "active"
            ? "Available"
            : collection.authority_state === "transferred"
              ? "Moved"
              : "Moving"}
        </div>
        <div className="row-actions">
          {editorCollectionId && <button
            className="quiet-action"
            disabled={busy}
            onClick={() => void window.mdbaseConnect.openEditor(editorCollectionId)}
          >
            Open in editor <span aria-hidden="true">↗</span>
          </button>}
          <button className="quiet-action" disabled={busy} aria-expanded={editing} onClick={() => setEditing((value) => !value)}>{editing ? "Close" : mirror ? "Sync" : "Details"}</button>
        </div>
      </div>
      {editing && <div className="collection-editor hosted-editor">
        <form className="collection-editor-form" onSubmit={(event) => {
          event.preventDefault();
          void onAct(async () => {
            await window.mdbaseConnect.renameHostedCollection({ collectionId: collection.id, name });
            onNotice(`${name.trim()} was renamed.`);
          });
        }}>
          <section className="collection-editor-section">
            <div><strong>Details</strong><small>The name is stored with the hosted main copy.</small></div>
            <div className="collection-fields">
              <label><span>Name</span><input value={name} maxLength={200} required onChange={(event) => setName(event.target.value)} /></label>
              <button className="button secondary" disabled={busy || !name.trim() || name.trim() === collection.display_name}>Save name</button>
            </div>
          </section>
        </form>
        {collection.authority_state !== "transferred" && <section className="collection-editor-section mirror-section">
          <div>
            <strong>Synced folder on this computer</strong>
            <small>Keep ordinary Markdown here while the main copy remains hosted by mdbase.</small>
          </div>
          {mirror ? (
            <div className="mirror-control">
              <div className="mirror-state-row">
                <StatusDot state={state.dot} />
                <div><strong>{state.label}</strong><button className="path" title={mirror.path} onClick={() => void window.mdbaseConnect.openMirror(mirror.replica_id)}>{mirror.path}</button></div>
                <code>{mirror.mode === "read_write" ? "edits sync both ways" : "downloads updates only"}</code>
              </div>
              {mirror.progress && <small>{mirror.progress.phase === "uploading" ? "Uploading" : "Applying"} {mirror.progress.completed}{mirror.progress.total === null ? "" : ` of ${mirror.progress.total}`} changes…</small>}
              {mirror.error && <div className="message error-message compact-message">{mirror.error}</div>}
              {mirror.conflicts.length > 0 && (
                <div className="mirror-conflicts">
                  {mirror.conflicts.map((conflict) => <div key={conflict.record_id}>
                    <div><strong>{conflict.path ?? conflict.record_id}</strong><small>{conflict.message}</small></div>
                    <div className="row-actions">
                      <button className="quiet-action" disabled={busy} onClick={() => void onAct(async () => {
                        await window.mdbaseConnect.resolveMirrorConflict({ replicaId: mirror.replica_id, recordId: conflict.record_id, resolution: "local" });
                        onNotice("The local version was kept and synchronized.");
                      })}>Keep local</button>
                      <button className="quiet-action" disabled={busy} onClick={() => void onAct(async () => {
                        await window.mdbaseConnect.resolveMirrorConflict({ replicaId: mirror.replica_id, recordId: conflict.record_id, resolution: "remote" });
                        onNotice("The hosted version was applied.");
                      })}>Use hosted</button>
                    </div>
                  </div>)}
                </div>
              )}
              {mirror.local_issues.length > 0 && (
                <div className="mirror-conflicts">
                  {mirror.local_issues.map((issue) => <div key={issue.path}>
                    <div>
                      <strong>{issue.path}</strong>
                      <small>{issue.message} Other valid Markdown continues to synchronize.</small>
                    </div>
                  </div>)}
                </div>
              )}
              <div className="mirror-actions">
                <button className="quiet-action" disabled={busy || mirror.syncing} onClick={() => void onAct(async () => {
                  await window.mdbaseConnect.syncMirror(mirror.replica_id);
                  onNotice(`${collection.display_name} is synchronized.`);
                })}>{mirror.syncing ? "Synchronizing…" : "Sync now"}</button>
                <button className="quiet-action" disabled={busy} onClick={() => void window.mdbaseConnect.openMirror(mirror.replica_id)}>Open folder</button>
                <button className="quiet-action danger" disabled={busy} onClick={() => {
                  if (!window.confirm(`Stop syncing ${collection.display_name} on this computer? The folder and its files will remain.`)) return;
                  void onAct(async () => {
                    await window.mdbaseConnect.disconnectMirror(mirror.replica_id);
                    onNotice(`The synced folder was disconnected. Files remain at ${mirror.path}.`);
                  });
                }}>Stop syncing</button>
              </div>
            </div>
          ) : (
            <div className="mirror-setup">
              <label><span>Folder</span><button type="button" className="folder-picker" onClick={() => void chooseMirrorFolder()}>{path || "Choose a folder…"}</button></label>
              <label><span>How should it sync?</span><select value={mode} onChange={(event) => setMode(event.target.value as "read_only" | "read_write")}><option value="read_write">Sync edits both ways</option><option value="read_only">Download updates only</option></select></label>
              <small>Syncing both ways sends local edits to mdbase. Download-only folders replace their local view with hosted changes.</small>
              <button className="button primary" disabled={busy || !path} onClick={() => void onAct(async () => {
                await window.mdbaseConnect.connectMirror({ collectionId: collection.id, path, mode });
                setPath("");
                onNotice(`${collection.display_name} now has a synced folder on this computer.`);
              })}>Start syncing</button>
            </div>
          )}
        </section>}
        {collection.authority_state === "transferred" ? (
          <section className="collection-editor-section">
            <div>
              <strong>Main copy</strong>
              <small>This hosted copy is retained for recovery but no longer accepts changes.</small>
            </div>
            <div className="authority-transfer-control">
              <div>
                <strong>Main copy moved to this computer</strong>
                <small>The collection now appears under On this computer. Applications need fresh access to the computer-owned collection.</small>
              </div>
            </div>
          </section>
        ) : mirror && (
          <section className="collection-editor-section">
            <div>
              <strong>Main copy</strong>
              <small>Make this synced folder the main copy.</small>
            </div>
            <div className="authority-transfer-control">
              <div>
                <strong>{promotion.title}</strong>
                <small>{promotion.detail}</small>
              </div>
              <button
                type="button"
                className="button secondary"
                disabled={busy || !promotion.enabled}
                onClick={() => {
                  if (
                    !mirror.promotion_pending
                    && !window.confirm(
                      `Use this folder as the main copy of ${collection.display_name}? `
                      + `${mirror.path} will become the main copy. Hosted changes will stop, `
                      + "and existing application access and other synced folders will be revoked. "
                      + "You will confirm this change in your browser."
                    )
                  ) return;
                  setPromotionStarting(true);
                  void onAct(async () => {
                    onNotice(
                      mirror.promotion_pending
                        ? "Resuming the main-copy change. Keep mdbase connect open."
                        : "Confirm the main-copy change in your browser, then return to mdbase connect."
                    );
                    try {
                      await window.mdbaseConnect.promoteMirrorAuthority(
                        mirror.replica_id
                      );
                      setEditing(false);
                      onNotice(`${collection.display_name} now uses this folder as its main copy. Applications need fresh access.`);
                    } finally {
                      setPromotionStarting(false);
                    }
                  });
                }}
              >
                {promotion.button}
              </button>
            </div>
          </section>
        )}
        {activeReplicas.some((replica) => replica.id !== mirror?.replica_id) && (
          <section className="collection-editor-section">
            <div><strong>Other synced folders</strong><small>Folders connected from another installation or through the command line.</small></div>
            <div className="replica-list">{activeReplicas.filter((replica) => replica.id !== mirror?.replica_id).map((replica) => (
              <div key={replica.id}><span>{replica.name}</span><code>{replica.mode === "read_write" ? "edits sync both ways" : "downloads updates only"}</code><small>{replica.sync_status?.last_seen_at ? `Seen ${relativeTime(replica.sync_status.last_seen_at)}` : "Not synchronized yet"}</small><button className="quiet-action danger" disabled={busy} onClick={() => {
                if (!window.confirm(`Revoke ${replica.name}? Its local files will remain, but it will no longer synchronize.`)) return;
                void onAct(async () => {
                  await window.mdbaseConnect.revokeHostedReplica(replica.id);
                  onNotice(`${replica.name} was revoked.`);
                });
              }}>Revoke</button></div>
            ))}</div>
          </section>
        )}
        <div className="collection-danger-row">
          <small>Deleting a hosted collection permanently removes its hosted records. Synced folder files remain.</small>
          <button className="quiet-action danger" disabled={busy} onClick={() => {
            if (!window.confirm(`Permanently delete the hosted collection ${collection.display_name}? This cannot be undone.`)) return;
            void onAct(async () => {
              if (mirror) await window.mdbaseConnect.disconnectMirror(mirror.replica_id);
              await window.mdbaseConnect.deleteHostedCollection(collection.id);
              onNotice(`${collection.display_name} was deleted. Any synced folder files remain.`);
            });
          }}>Delete hosted collection</button>
        </div>
      </div>}
    </article>
  );
}
