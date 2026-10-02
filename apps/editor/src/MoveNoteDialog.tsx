import { useState } from "react";
import { Dialog } from "./Dialog";
import { Select } from "@mdbase-dev/ui/select";

export function MoveNoteDialog({ paths, folders, onMove, onClose }: {
  paths: string[];
  folders: string[];
  onMove: (paths: string[], folder: string) => Promise<void>;
  onClose: () => void;
}) {
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  return <Dialog titleId="move-note-title" onClose={() => { if (!busy) onClose(); }} className="confirm-dialog move-note-dialog">
    <h2 id="move-note-title">Move note</h2>
    <p>Choose a folder. Incoming links will be updated too.</p>
    <label htmlFor="move-note-folder">Destination folder</label>
    <Select id="move-note-folder" aria-label="Destination folder" value={folder} onChange={setFolder} disabled={busy} options={[{ value: "", label: "Collection root" }, ...folders.map((path) => ({ value: path, label: path }))]} />
    <div className="dialog-actions"><button disabled={busy} onClick={onClose}>Cancel</button><button className="primary-confirm-action" disabled={busy} onClick={() => { setBusy(true); void onMove(paths, folder).finally(onClose); }}>{busy ? "Moving…" : "Move"}</button></div>
  </Dialog>;
}
