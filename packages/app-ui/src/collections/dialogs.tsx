import { describeError } from "@mdbase-dev/sdk/describe";
import { useEffect, useId, useState, type JSX, type RefObject } from "react";

import { ConfirmDialog } from "../ConfirmDialog.js";
import type { CollectionRow } from "./model.js";
import { type RowDialog } from "./parts.js";
import type { CollectionUi, DeleteCollectionOutcome } from "./use-collection-ui.js";

type Target = Pick<CollectionRow, "id" | "name">;

/** Hide a collection on this device. Nothing is deleted and access stays. */
export function ForgetCollectionDialog({ open = true, ui, collection, onClose, returnFocusRef }: {
  readonly open?: boolean;
  readonly returnFocusRef?: RefObject<HTMLElement | null> | undefined;
  readonly ui: CollectionUi;
  readonly collection: Target;
  readonly onClose: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setBusy(false); setError(null); } }, [open]);
  const forget = (): void => {
    setBusy(true);
    setError(null);
    ui.options.mdbase.forget(collection.id).then(onClose, (cause: unknown) => {
      setBusy(false);
      setError(describeError(cause)?.message ?? null);
    });
  };
  return <ConfirmDialog open={open} returnFocusRef={returnFocusRef} title={ui.say("forgetTitle", { collection: collection.name })} consequence={ui.say("forgetBody")}
    confirmLabel={ui.copy.forgetConfirm} pendingLabel={`${ui.copy.forgetConfirm}…`} busy={busy} onClose={onClose} onConfirm={forget}>
    {error && <p className="mdbase-collections-dialog-error" role="alert">{error}</p>}
  </ConfirmDialog>;
}

/** Owner only: type the name to delete a collection for everyone. The SDK and server check both again. */
export function DeleteCollectionDialog({ open = true, ui, collection, onClose, returnFocusRef }: {
  readonly open?: boolean;
  readonly returnFocusRef?: RefObject<HTMLElement | null> | undefined;
  readonly ui: CollectionUi;
  readonly collection: Target;
  readonly onClose: (outcome: DeleteCollectionOutcome) => void;
}): JSX.Element {
  const id = useId();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { if (open) { setTyped(""); setBusy(false); setError(null); setFailed(false); } }, [open]);
  const matches = typed.trim() === collection.name.trim();
  const dismiss = (): void => onClose(failed ? "failed" : "cancelled");
  const remove = (): void => {
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    ui.options.mdbase.deleteCollection(collection.id, { confirmName: typed }).then(() => onClose("deleted"), (cause: unknown) => {
      setBusy(false);
      setFailed(true);
      setError(describeError(cause)?.message ?? null);
    });
  };
  return <ConfirmDialog open={open} returnFocusRef={returnFocusRef} title={ui.say("deleteTitle", { collection: collection.name })} consequence={ui.copy.deleteBody}
    confirmLabel={ui.copy.deleteConfirm} pendingLabel={ui.copy.deleting} busy={busy} disabled={!matches} onClose={dismiss} onConfirm={remove}>
    <label className="mdbase-collections-field-label" htmlFor={id}>{ui.say("deleteTypeName", { collection: collection.name })}</label>
    <input id={id} className="mdbase-collections-field" value={typed} autoComplete="off" spellCheck={false} disabled={busy}
      onChange={(event) => setTyped(event.target.value)} />
    {error && <p className="mdbase-collections-dialog-error" role="alert">{error}</p>}
  </ConfirmDialog>;
}

/** Sign-out found changes that haven't reached mdbase: wait, or sign out and lose them here. */
export function SignOutDialog({ ui }: { readonly ui: CollectionUi }): JSX.Element | null {
  const [last, setLast] = useState(ui.signOutPrompt);
  useEffect(() => { if (ui.signOutPrompt) setLast(ui.signOutPrompt); }, [ui.signOutPrompt]);
  const problem = ui.signOutPrompt ?? last;
  if (!problem) return null;
  return <ConfirmDialog open={Boolean(ui.signOutPrompt)} title={problem.title} consequence={problem.message}
    confirmLabel={ui.copy.signOutAnyway} pendingLabel={ui.copy.signingOut} onClose={ui.actions.dismissSignOut} onConfirm={ui.actions.confirmSignOut} />;
}

export function RowDialogs({ ui, dialog, onClose, returnFocusRef }: { readonly ui: CollectionUi; readonly dialog: RowDialog; readonly onClose: () => void; readonly returnFocusRef?: RefObject<HTMLElement | null> }): JSX.Element | null {
  const [last, setLast] = useState(dialog);
  useEffect(() => { if (dialog) setLast(dialog); }, [dialog]);
  const target = dialog ?? last;
  if (!target) return null;
  return target.kind === "forget"
    ? <ForgetCollectionDialog key={target.row.id} open={Boolean(dialog)} returnFocusRef={returnFocusRef} ui={ui} collection={target.row} onClose={onClose} />
    : <DeleteCollectionDialog key={target.row.id} open={Boolean(dialog)} returnFocusRef={returnFocusRef} ui={ui} collection={target.row} onClose={(outcome) => { onClose(); target.onClose?.(outcome); }} />;
}
