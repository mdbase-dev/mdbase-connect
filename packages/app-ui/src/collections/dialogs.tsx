import { describeError } from "@mdbase-dev/sdk/describe";
import { useId, useState, type JSX } from "react";

import type { CollectionRow } from "./model.js";
import { ActionButton, CollectionDialog } from "./parts.js";
import type { CollectionUi } from "./use-collection-ui.js";

type Target = Pick<CollectionRow, "id" | "name">;

/** Hide a collection on this device. Nothing is deleted and access stays. */
export function ForgetCollectionDialog({ ui, collection, onClose }: {
  readonly ui: CollectionUi;
  readonly collection: Target;
  readonly onClose: () => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const forget = (): void => {
    setBusy(true);
    setError(null);
    ui.options.mdbase.forget(collection.id).then(onClose, (cause: unknown) => {
      setBusy(false);
      setError(describeError(cause)?.message ?? null);
    });
  };
  return <CollectionDialog title={ui.say("forgetTitle", { collection: collection.name })} busy={busy} onClose={onClose} footer={<>
    <ActionButton tone="quiet" inert={busy} onClick={onClose}>{ui.copy.cancel}</ActionButton>
    <ActionButton tone="primary" progress={busy ? ui.copy.forgetConfirm : null} onClick={forget}>{ui.copy.forgetConfirm}</ActionButton>
  </>}>
    <p>{ui.say("forgetBody")}</p>
    {error && <p className="mdbase-collections-dialog-error" role="alert">{error}</p>}
  </CollectionDialog>;
}

/** Owner only: type the name to delete a collection for everyone. The SDK and server check both again. */
export function DeleteCollectionDialog({ ui, collection, onClose }: {
  readonly ui: CollectionUi;
  readonly collection: Target;
  readonly onClose: () => void;
}): JSX.Element {
  const id = useId();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim() === collection.name.trim();
  const remove = (): void => {
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    ui.options.mdbase.deleteCollection(collection.id, { confirmName: typed }).then(onClose, (cause: unknown) => {
      setBusy(false);
      setError(describeError(cause)?.message ?? null);
    });
  };
  return <CollectionDialog alert title={ui.say("deleteTitle", { collection: collection.name })} busy={busy} onClose={onClose} footer={<>
    <ActionButton tone="quiet" inert={busy} onClick={onClose}>{ui.copy.cancel}</ActionButton>
    <ActionButton tone="danger" inert={!matches} progress={busy ? ui.copy.deleting : null} onClick={remove}>{ui.copy.deleteConfirm}</ActionButton>
  </>}>
    <p>{ui.copy.deleteBody}</p>
    <form onSubmit={(event) => { event.preventDefault(); remove(); }}>
      <label className="mdbase-collections-field-label" htmlFor={id}>{ui.say("deleteTypeName", { collection: collection.name })}</label>
      <input id={id} className="mdbase-collections-field" value={typed} autoComplete="off" spellCheck={false} disabled={busy}
        onChange={(event) => setTyped(event.target.value)} data-autofocus />
    </form>
    {error && <p className="mdbase-collections-dialog-error" role="alert">{error}</p>}
  </CollectionDialog>;
}

/** Sign-out found changes that haven't reached mdbase: wait, or sign out and lose them here. */
export function SignOutDialog({ ui }: { readonly ui: CollectionUi }): JSX.Element | null {
  const problem = ui.signOutPrompt;
  if (!problem) return null;
  return <CollectionDialog alert title={problem.title} onClose={ui.actions.dismissSignOut} footer={<>
    <ActionButton tone="primary" onClick={ui.actions.dismissSignOut}>{problem.actionLabel ?? ui.copy.cancel}</ActionButton>
    <ActionButton tone="danger" onClick={ui.actions.confirmSignOut}>{ui.copy.signOutAnyway}</ActionButton>
  </>}>
    <p>{problem.message}</p>
  </CollectionDialog>;
}

/** Which row dialog is open, shared by the gate and the switcher. */
export type RowDialog = { readonly kind: "forget" | "delete"; readonly row: Target } | null;

export function RowDialogs({ ui, dialog, onClose }: { readonly ui: CollectionUi; readonly dialog: RowDialog; readonly onClose: () => void }): JSX.Element | null {
  if (!dialog) return null;
  return dialog.kind === "forget"
    ? <ForgetCollectionDialog ui={ui} collection={dialog.row} onClose={onClose} />
    : <DeleteCollectionDialog ui={ui} collection={dialog.row} onClose={onClose} />;
}
