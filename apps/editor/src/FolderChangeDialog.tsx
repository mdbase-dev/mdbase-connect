import { displayLocale } from "./i18n/format";
import { Trans, Plural } from "@lingui/react/macro";
import { t, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "./Dialog";
import { Select } from "@mdbase-dev/ui/select";
import type { FolderChangePlan, FolderChangeProgress, FolderChangeResult } from "./folder-change";

export interface FolderChangeActions {
  onPlanFolderChange?: (from: string, to: string) => Promise<FolderChangePlan>;
  onChangeFolder?: (plan: FolderChangePlan, onProgress: (progress: FolderChangeProgress) => void) => Promise<FolderChangeResult>;
}

export function FolderChangeDialog({ from, parent, mode, folders, onPlanFolderChange, onChangeFolder, onClose }: FolderChangeActions & {
  from: string;
  parent?: string;
  mode: "rename" | "move";
  folders: string[];
  onClose: (focusPath: string) => void;
}) {
  useLingui();
  const id = useId();
  const [value, setValue] = useState(mode === "rename" ? from.split("/").at(-1)! : parent ?? "");
  const [plan, setPlan] = useState<FolderChangePlan>();
  const [progress, setProgress] = useState<FolderChangeProgress>();
  const [result, setResult] = useState<FolderChangeResult>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!plan && !result) return;
    const frame = requestAnimationFrame(() => cancel.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [plan, result]);
  const basename = from.split("/").at(-1)!;
  const to = mode === "rename" ? [...from.split("/").slice(0, -1), value.trim()].join("/") : [value, basename].filter(Boolean).join("/");
  const close = () => onClose(result && !result.failures.length ? to : from);

  async function review() {
    if (!onPlanFolderChange || busy) return;
    setBusy(true); setError(undefined);
    try {
      if (mode === "rename" && (!value.trim() || /[/\\]/.test(value))) throw new Error(t`Enter a folder name without slashes.`);
      setPlan(await onPlanFolderChange(from, to));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (!plan || !onChangeFolder || busy) return;
    setBusy(true); setError(undefined);
    try { setResult(await onChangeFolder(plan, setProgress)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  return <Dialog titleId={id} className="confirm-dialog folder-change-dialog" onClose={() => { if (!busy) close(); }}>
    <div className="confirm-dialog-copy">
      <h2 id={id}>{result ? result.failures.length || result.warnings?.length ? t`Folder change needs attention` : t`Folder change complete` : plan
        ? plan.referenceCount
          ? mode === "rename"
            ? <Trans>Rename ‘{basename}’ and move <Plural value={plan.moves.length} one="# note" other="# notes" /> and update <Plural value={plan.referenceCount} one="# link" other="# links" />?</Trans>
            : <Trans>Move <Plural value={plan.moves.length} one="# note" other="# notes" /> and update <Plural value={plan.referenceCount} one="# link" other="# links" />?</Trans>
          : mode === "rename"
            ? plural(plan.moves.length, { one: `Rename ‘${basename}’ and move # note?`, other: `Rename ‘${basename}’ and move # notes?` })
            : plural(plan.moves.length, { one: "Move # note?", other: "Move # notes?" })
        : mode === "rename" ? t`Rename ‘${basename}’` : t`Move ‘${basename}’` }</h2>
      {!plan && <form id={`${id}-form`} onSubmit={(event) => { event.preventDefault(); void review(); }}>
        <label htmlFor={`${id}-value`}>{mode === "rename" ? t`Folder name` : t`Destination folder`}</label>
        {mode === "rename" ? <input className="mdbase-field" id={`${id}-value`} value={value} onChange={(event) => setValue(event.target.value)} disabled={busy} data-autofocus />
          : <Select id={`${id}-value`} aria-label={t`Destination folder`} value={value} onChange={setValue} disabled={busy} data-autofocus options={[
            { value: "", label: "All notes (collection root)" },
            ...folders.filter((path) => path !== from && !path.startsWith(`${from}/`)).map((path) => ({ value: path, label: path }))
          ]} />}
        <p><Trans>Notes in subfolders move too. Links to these notes will be updated.</Trans></p>
      </form>}
      {plan && !result && <div><p><Trans>From <code>{plan.from}</code> to <code>{plan.to}</code>. This changes paths across the collection, including subfolders.</Trans></p>
        {plan.warnings.length > 0 && <p><Trans>{plan.warnings.length.toLocaleString(displayLocale())} link warnings need attention and will not be fixed automatically: {plan.warnings.join("; ")}</Trans></p>}
      </div>}
      {progress && busy && <p role="status"><Trans>Moved {progress.completed} of {progress.total} notes. {progress.path}</Trans>{progress.detail ? ` — ${progress.detail}` : ""}</p>}
      {result && <div role={result.failures.length ? "alert" : "status"}>
        <p>{plural(result.moved, { one: "# note moved.", other: "# notes moved." })}{result.failures.length ? plural(result.failures.length, { one: ` # note could not be confirmed as moved. Check the details below before retrying. Successful moves were not rolled back. Use Move to… on the remaining notes to finish.`, other: ` # notes could not be confirmed as moved. Check the details below before retrying. Successful moves were not rolled back. Use Move to… on the remaining notes to finish.` }) : t` Links were updated.`}</p>
        {result.failures.length > 0 && <ul>{result.failures.map((failure) => <li key={failure.path}><code>{failure.path}</code>: {failure.message}</li>)}</ul>}
      </div>}
      {result?.warnings && <div role="alert">{result.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>}
      {error && <p role="alert">{error}</p>}
    </div>
    <footer>
      <button className="mdbase-button is-tertiary" ref={cancel} disabled={busy} onClick={close}>{result ? t`Done` : t`Cancel`}</button>
      {!result && (plan ? <button className="mdbase-button is-primary confirm-primary" disabled={busy} onClick={() => void apply()}>{busy ? t`Moving…` : mode === "rename" ? t`Rename folder` : t`Move folder`}</button>
        : <button className="mdbase-button is-primary confirm-primary" form={`${id}-form`} type="submit" disabled={busy}>{busy ? t`Checking notes and links…` : t`Review changes`}</button>)}
    </footer>
  </Dialog>;
}
