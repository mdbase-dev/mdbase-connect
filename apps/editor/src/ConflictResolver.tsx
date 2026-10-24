import { i18n } from "@lingui/core";
import { Trans } from "@lingui/react/macro";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { WarningCircleIcon as CircleAlert } from "./icons";
import { useMemo } from "react";
import { compareLines } from "@mdbase-dev/ui/text-diff";

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
  useLingui();
  const bodyDiff = useMemo(() => compareLines(local.body, remote.body), [local.body, remote.body, i18n.locale]);
  const titleChanged = local.title !== remote.title;
  return <section className="conflict-resolver" role="alert" aria-label={t`Note changed elsewhere`}>
    <div className="conflict-summary">
      <CircleAlert aria-hidden="true" />
      <div><strong><Trans>This note changed elsewhere</Trans></strong><span><Trans>Compare your edits with the latest version before choosing which one to save.</Trans></span></div>
      <div className="conflict-actions">
        <button onClick={onUseRemote}><Trans>Use latest</Trans></button>
        <button className="primary-conflict-action mdbase-button is-primary" onClick={onKeepLocal}><Trans>Keep my edits</Trans></button>
      </div>
    </div>
    <details>
      <summary><Trans>Review differences</Trans></summary>
      <div className="conflict-diff">
        <div className="diff-legend"><span className="local"><Trans>Your edits</Trans></span><span className="remote"><Trans>Latest version</Trans></span></div>
        {titleChanged && <div className="title-diff" aria-label={t`Title differences`}>
          <p className="local"><small><Trans>Your title</Trans></small><span>{local.title || t`Untitled`}</span></p>
          <p className="remote"><small><Trans>Latest title</Trans></small><span>{remote.title || t`Untitled`}</span></p>
        </div>}
        {bodyDiff.length ? <div className="line-diff" role="table" aria-label={t`Body differences`}>
          {bodyDiff.map((line, index) => <div className={`diff-line ${line.kind}`} role="row" key={`${line.kind}:${line.localLine ?? ""}:${line.remoteLine ?? ""}:${index}`}>
            <span className="diff-marker" aria-hidden="true">{line.kind === "local" ? "−" : line.kind === "remote" ? "+" : line.kind === "omitted" ? "···" : " "}</span>
            <span className="diff-line-number" aria-hidden="true">{line.localLine ?? line.remoteLine ?? ""}</span>
            <code role="cell">{line.text || " "}</code>
          </div>)}
        </div> : !titleChanged && <p className="conflict-no-text-change"><Trans>The note metadata changed, but the title and body match your edits.</Trans></p>}
      </div>
    </details>
  </section>;
}
