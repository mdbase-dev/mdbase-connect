import { useMemo, useState } from "react";
import { compareLines } from "@mdbase-dev/ui/text-diff";
import { message } from "./view-model";
import "./mirror-conflict-review.css";

type Conflict = DesktopMirrorSummary["conflicts"][number];

export function MirrorConflictDecision({ replicaId, conflict, disabled, onResolved }: {
  replicaId: string;
  conflict: Conflict;
  disabled: boolean;
  onResolved(): Promise<void>;
}) {
  const [review, setReview] = useState<MirrorConflictReview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lines = useMemo(() => review && conflict.entity === "record"
    ? compareLines(review.local.document ?? "", review.remote.document ?? "") : [], [review, conflict.entity]);

  async function load() {
    setBusy(true);
    setError("");
    setReview(undefined);
    try {
      const next = await window.mdbaseConnect.reviewMirrorConflict({ replicaId, objectId: conflict.object_id, decisionId: conflict.decision_id });
      if (next.review_version !== 1 || next.decision_id !== conflict.decision_id) throw new Error("This conflict needs a new review. Synchronize again before choosing a version.");
      setReview(next);
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }

  async function resolve(resolution: "local" | "remote") {
    if (!review) return;
    setBusy(true);
    setError("");
    try {
      await window.mdbaseConnect.resolveMirrorConflict({ replicaId, objectId: conflict.object_id, decisionId: review.decision_id, resolution });
      setReview(undefined);
      await onResolved();
    } catch (reason) {
      setReview(undefined);
      setError(message(reason));
    } finally { setBusy(false); }
  }

  return <div className="mirror-conflict-decision">
    <strong>{conflict.path ?? conflict.object_id}</strong>
    <p>{conflict.message}</p>
    {error && <p role="alert">{error}</p>}
    {!review ? <button className="quiet-action" disabled={disabled || busy} onClick={() => void load()}>{busy ? "Loading versions…" : "Review versions"}</button> : <>
      <div className="mirror-version-pair">
        <Version label="On this computer" version={review.local} />
        <Version label="Hosted by mdbase" version={review.remote} />
      </div>
      {conflict.entity === "record" && <details open><summary>Markdown differences, including metadata</summary>
        {lines.length ? <div className="mirror-document-diff">{lines.map((line, index) => <div key={index} className={line.kind}>
          <span>{line.kind === "local" ? "Computer −" : line.kind === "remote" ? "Hosted +" : line.kind === "omitted" ? "…" : " "}</span><code>{line.text || " "}</code>
        </div>)}</div> : <p>Text matches; review the paths and deletion state above.</p>}
      </details>}
      <p>Keeping this computer’s version replaces the hosted version{review.local.path === null ? " with a deletion" : ""}. Using the hosted version replaces this computer’s version{review.remote.path === null ? " with a deletion" : ""}.</p>
      <div className="row-actions">
        <button className="quiet-action" disabled={disabled || busy} onClick={() => void resolve("local")}>Keep computer version</button>
        <button className="quiet-action" disabled={disabled || busy} onClick={() => void resolve("remote")}>Use hosted version</button>
      </div>
    </>}
  </div>;
}

function Version({ label, version }: { label: string; version: MirrorConflictVersion }) {
  return <div><strong>{label}</strong>{version.path === null ? <p>Deleted / absent</p> : <>
    <code>{version.path}</code>
    <small>{version.size === null ? "Size unavailable" : `${version.size.toLocaleString()} bytes`}</small>
    <code className="mirror-version-digest">{version.revision}</code>
  </>}</div>;
}
