import { Trans } from "@lingui/react/macro";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { useState } from "react";
import { Dialog } from "./Dialog";
import { Select } from "@mdbase-dev/ui/select";

export function MoveNoteDialog({ paths, folders, onMove, onClose }: {
  paths: string[];
  folders: string[];
  onMove: (paths: string[], folder: string) => Promise<void>;
  onClose: () => void;
}) {
  useLingui();
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  return <Dialog titleId="move-note-title" onClose={() => { if (!busy) onClose(); }} className="confirm-dialog move-note-dialog">
    <h2 id="move-note-title">{paths.length > 1 ? t`Move ${paths.length} notes` : t`Move note`}</h2>
    <p><Trans>Choose a folder. Incoming links will be updated too.</Trans></p>
    <label htmlFor="move-note-folder"><Trans>Destination folder</Trans></label>
    <Select id="move-note-folder" aria-label={t`Destination folder`} value={folder} onChange={setFolder} disabled={busy} options={[{ value: "", label: "Collection root" }, ...folders.map((path) => ({ value: path, label: path }))]} />
    <div className="dialog-actions"><button className="mdbase-button is-secondary" disabled={busy} onClick={onClose}><Trans>Cancel</Trans></button><button className="primary-confirm-action mdbase-button is-primary" disabled={busy} onClick={() => { setBusy(true); void onMove(paths, folder).finally(onClose); }}>{busy ? t`Moving…` : t`Move`}</button></div>
  </Dialog>;
}
