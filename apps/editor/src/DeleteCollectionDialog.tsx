import { useId, useRef, useState } from "react";
import type { MdbaseApplication } from "@mdbase-dev/sdk";
import { describeError } from "@mdbase-dev/sdk/describe";
import { Dialog } from "./Dialog";

/** Owner-only, type-the-name confirmation. The SDK and control plane check
 * ownership and the name again; a refusal keeps the dialog open with SDK copy. */
export function DeleteCollectionDialog({ application, collection, signal, onClose }: {
  application: MdbaseApplication;
  collection: { readonly collectionId: string; readonly displayName: string };
  signal: AbortSignal;
  onClose: (deleted: boolean) => void;
}) {
  const id = useId();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const name = collection.displayName;
  const matches = typed.trim() === name;

  async function remove() {
    if (!matches || running.current || signal.aborted) return;
    running.current = true; setBusy(true); setError(undefined);
    try {
      await application.deleteCollection(collection.collectionId, { confirmName: typed, signal });
      if (!signal.aborted) onClose(true);
    } catch (cause) {
      if (!signal.aborted) setError(describeError(cause)?.message ?? "The collection couldn't be deleted. Try again.");
    } finally {
      running.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }

  return <Dialog titleId={id} className="confirm-dialog delete-collection-dialog" role="alertdialog" onClose={() => { if (!busy) onClose(false); }}>
    <div className="confirm-dialog-copy">
      <h2 id={id}>Delete {name}?</h2>
      <p>Everyone, including you, loses access to it on every device and app right away. This can't be undone.</p>
      <form id={`${id}-form`} onSubmit={(event) => { event.preventDefault(); void remove(); }}>
        <label htmlFor={`${id}-name`}>Type <strong>{name}</strong> to confirm</label>
        <input className="mdbase-field" id={`${id}-name`} value={typed} autoComplete="off" spellCheck={false}
          onChange={(event) => setTyped(event.target.value)} disabled={busy} data-autofocus />
      </form>
      {error && <p role="alert">{error}</p>}
    </div>
    <footer>
      <button type="button" className="mdbase-button is-tertiary" disabled={busy} onClick={() => onClose(false)}>Cancel</button>
      <button type="submit" form={`${id}-form`} className="mdbase-button is-danger confirm-danger" disabled={busy || !matches}>
        {busy ? "Deleting…" : "Delete collection"}</button>
    </footer>
  </Dialog>;
}
