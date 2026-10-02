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
  onClose: () => void;
}) {
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

  async function review() {
    if (!onPlanFolderChange || busy) return;
    setBusy(true); setError(undefined);
    try {
      if (mode === "rename" && (!value.trim() || /[/\\]/.test(value))) throw new Error("Enter a folder name without slashes.");
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

  return <Dialog titleId={id} className="confirm-dialog folder-change-dialog" onClose={() => { if (!busy) onClose(); }}>
    <div className="confirm-dialog-copy">
      <h2 id={id}>{result ? "Folder change complete" : plan
        ? `${mode === "rename" ? `Rename ‘${basename}’ and move` : "Move"} ${plan.moves.length.toLocaleString()} ${plan.moves.length === 1 ? "note" : "notes"}${plan.referenceCount ? ` and update ${plan.referenceCount.toLocaleString()} ${plan.referenceCount === 1 ? "link" : "links"}` : ""}?`
        : `${mode === "rename" ? "Rename" : "Move"} ‘${basename}’`}</h2>
      {!plan && <form id={`${id}-form`} onSubmit={(event) => { event.preventDefault(); void review(); }}>
        <label htmlFor={`${id}-value`}>{mode === "rename" ? "Folder name" : "Destination folder"}</label>
        {mode === "rename" ? <input id={`${id}-value`} value={value} onChange={(event) => setValue(event.target.value)} disabled={busy} data-autofocus />
          : <Select id={`${id}-value`} aria-label="Destination folder" value={value} onChange={setValue} disabled={busy} data-autofocus options={[
            { value: "", label: "All notes (collection root)" },
            ...folders.filter((path) => path !== from && !path.startsWith(`${from}/`)).map((path) => ({ value: path, label: path }))
          ]} />}
        <p>Notes in subfolders move too. Links to these notes will be updated.</p>
      </form>}
      {plan && !result && <div><p>From <code>{plan.from}</code> to <code>{plan.to}</code>. This changes paths across the collection, including subfolders.</p>
        {plan.warnings.length > 0 && <p>{plan.warnings.length.toLocaleString()} link warnings need attention and will not be fixed automatically: {plan.warnings.join("; ")}</p>}
      </div>}
      {progress && busy && <p role="status">Moved {progress.completed} of {progress.total} notes. {progress.path}{progress.detail ? ` — ${progress.detail}` : ""}</p>}
      {result && <div role={result.failures.length ? "alert" : "status"}>
        <p>{result.moved.toLocaleString()} {result.moved === 1 ? "note moved" : "notes moved"}.{result.failures.length ? ` ${result.failures.length.toLocaleString()} ${result.failures.length === 1 ? "note could" : "notes could"} not be confirmed as moved. Check the details below before retrying. Successful moves were not rolled back.` : " Links were updated."}</p>
        {result.failures.length > 0 && <ul>{result.failures.map((failure) => <li key={failure.path}><code>{failure.path}</code>: {failure.message}</li>)}</ul>}
      </div>}
      {result?.warnings && <div role="alert">{result.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>}
      {error && <p role="alert">{error}</p>}
    </div>
    <footer>
      <button ref={cancel} disabled={busy} onClick={onClose}>{result ? "Done" : "Cancel"}</button>
      {!result && (plan ? <button className="confirm-primary" disabled={busy} onClick={() => void apply()}>{busy ? "Moving…" : mode === "rename" ? "Rename folder" : "Move folder"}</button>
        : <button className="confirm-primary" form={`${id}-form`} type="submit" disabled={busy}>{busy ? "Checking notes and links…" : "Review changes"}</button>)}
    </footer>
  </Dialog>;
}
