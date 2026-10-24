import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useLocaleRevision, i18n } from "@mdbase-dev/ui/i18n";
import React, { useCallback, useEffect, useState } from "react";
import { presentTakeover, type TakeoverStatus } from "./takeover-state.mjs";
import { message } from "./view-model";

const IDLE_POLL_MS = 10_000;
const RUNNING_POLL_MS = 2_000;

const stateLabels: Record<string, string> = {
  get pending() { return t(i18n)({ message: "Waiting", context: "Collection move recovery" }); },
  get postponed() { return t(i18n)({ message: "Postponed", context: "Collection move recovery" }); },
  get complete() { return t(i18n)({ message: "Moved", context: "Collection move recovery" }); },
  get held() { return t(i18n)({ message: "Moved, files kept for review" }); },
  get rolled_back() { return t(i18n)({ message: "Returned to the old engine" }); }
};

/** The move from the old Connect engine to mdbase: status, reasons and the explicit move. */
export function TakeoverPanel({ names }: { names: Record<string, string> }) {
  useLocaleRevision();
  const [status, setStatus] = useState<(TakeoverStatus & { running: boolean }) | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopMirrors, setStopMirrors] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await window.mdbaseConnect.migrationStatus());
    } catch {
      // Not ready yet, or an older daemon: the connection banner covers it.
      setStatus(null);
    }
  }, []);

  const running = starting || status?.running === true;
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), running ? RUNNING_POLL_MS : IDLE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [load, running]);

  const view = presentTakeover(status, names, running);
  // A refused move must stay on screen even when the daemon's status alone
  // would hide the panel (for example, the server said the account isn't ready).
  if (!view.visible && !failure) return null;

  const start = async () => {
    setFailure(null);
    setStarting(true);
    try {
      await window.mdbaseConnect.startMigration(view.offerStopMirrors && stopMirrors);
    } catch (error) {
      setFailure(message(error));
    } finally {
      setStarting(false);
      void load();
    }
  };

  return (
    <section className={`takeover-panel ${view.tone}`} role="status" aria-live="polite" aria-label={t(i18n)({ message: "Move to the new sync engine" })}>
      {view.title && <strong>{view.title}</strong>}
      {view.detail && <p>{view.detail}</p>}
      {view.advice && <p className="takeover-advice"><span><Trans>What to do: </Trans></span>{view.advice}</p>}
      {view.incidents.map((incident) => <p key={incident} className="takeover-incident">{incident}</p>)}
      {failure && <p className="takeover-incident">{failure}</p>}
      {view.notices.map((notice) => <p key={notice}>{notice}</p>)}
      {view.rows.length > 0 && <ul className="takeover-rows">
        {view.rows.map((row) => (
          <li key={row.id}>
            <span>{row.label}</span>
            <small>{stateLabels[row.state] ?? row.state}{row.reason ? ` — ${row.reason}` : ""}</small>
            {row.holds.length > 0 && <ul className="takeover-holds">
              {row.holds.map((hold) => <li key={hold.path}><code>{hold.path}</code></li>)}
            </ul>}
          </li>
        ))}
      </ul>}
      {view.canStart && <div className="collection-config-actions">
        {view.offerStopMirrors && <label className="takeover-option"><Trans>
          <input type="checkbox" checked={stopMirrors} onChange={(event) => setStopMirrors(event.target.checked)} />
          Allow hosted mirrors to stop until I join them again
        </Trans></label>}
        <button className="button primary" disabled={running} onClick={() => void start()}><Trans>Move to the new sync engine</Trans></button>
      </div>}
    </section>
  );
}
