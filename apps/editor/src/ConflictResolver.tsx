import { WarningCircleIcon as CircleAlert } from "./icons";
import { useMemo } from "react";
import { compareLines } from "./text-diff";

interface ConflictVersion {
  title: string;
  body: string;
}

export function ConflictResolver({ local, remote, onUseRemote, onKeepLocal }: {
  local: ConflictVersion;
  remote: ConflictVersion;
  onUseRemote: () => void;
  onKeepLocal: () => void;
}) {
  const bodyDiff = useMemo(() => compareLines(local.body, remote.body), [local.body, remote.body]);
  const titleChanged = local.title !== remote.title;
  return <section className="conflict-resolver" role="alert" aria-label="Note changed elsewhere">
    <div className="conflict-summary">
      <CircleAlert aria-hidden="true" />
      <div><strong>This note changed elsewhere</strong><span>Compare your edits with the latest version before choosing which one to save.</span></div>
      <div className="conflict-actions">
        <button onClick={onUseRemote}>Use latest</button>
        <button className="primary-conflict-action" onClick={onKeepLocal}>Keep my edits</button>
      </div>
    </div>
    <details>
      <summary>Review differences</summary>
      <div className="conflict-diff">
        <div className="diff-legend"><span className="local">Your edits</span><span className="remote">Latest version</span></div>
        {titleChanged && <div className="title-diff" aria-label="Title differences">
          <p className="local"><small>Your title</small><span>{local.title || "Untitled"}</span></p>
          <p className="remote"><small>Latest title</small><span>{remote.title || "Untitled"}</span></p>
        </div>}
        {bodyDiff.length ? <div className="line-diff" role="table" aria-label="Body differences">
          {bodyDiff.map((line, index) => <div className={`diff-line ${line.kind}`} role="row" key={`${line.kind}:${line.localLine ?? ""}:${line.remoteLine ?? ""}:${index}`}>
            <span className="diff-marker" aria-hidden="true">{line.kind === "local" ? "−" : line.kind === "remote" ? "+" : line.kind === "omitted" ? "···" : " "}</span>
            <span className="diff-line-number" aria-hidden="true">{line.localLine ?? line.remoteLine ?? ""}</span>
            <code role="cell">{line.text || " "}</code>
          </div>)}
        </div> : !titleChanged && <p className="conflict-no-text-change">The note metadata changed, but the title and body match your edits.</p>}
      </div>
    </details>
  </section>;
}
