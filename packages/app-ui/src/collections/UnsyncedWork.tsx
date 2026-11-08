import { useContext, useState, useSyncExternalStore, type JSX } from "react";
import type { Mdbase } from "@mdbase-dev/sdk";

import { ConfirmDialog } from "../ConfirmDialog.js";
import { useLocaleRevision } from "../i18n.js";
import { CollectionMdbaseContext } from "./CollectionSaveWarning.js";
import { defaultCollectionCopy } from "./copy.js";
import { ActionButton } from "./parts.js";
import { unsyncedPhase } from "./unsynced.js";
import type { CollectionUi } from "./use-collection-ui.js";

const savedLabel = (ui: CollectionUi): string => {
  const options = ui.options.unsynced;
  return typeof options === "object" && options.storage === "device" ? ui.copy.unsyncedSavedDevice : ui.copy.unsyncedSavedBrowser;
};

/**
 * The one quiet, persistent line while the app works in its unsynced
 * collection and something has been saved there: where it is kept, and the
 * way to connect it.
 */
export function UnsyncedLine({ ui }: { readonly ui: CollectionUi }): JSX.Element | null {
  if (ui.view.kind !== "unsynced" || !ui.view.unsyncedWork) return null;
  return <div className="mdbase-collections mdbase-collections-unsynced">
    <p className="mdbase-collections-unsynced-status">{savedLabel(ui)}</p>
    <ActionButton tone="quiet" inert={ui.busy !== null} progress={ui.busy === "sign_in" || ui.busy === "add" ? ui.copy.addingCollection : null}
      onClick={ui.actions.connect}>{ui.copy.unsyncedConnect}</ActionButton>
  </div>;
}

/**
 * With a collection open and work saved before connecting: offer to bring it
 * in (asking first when names or types change), or to discard it. Afterwards,
 * how it went.
 */
export function BringInBanner({ ui, variant = "banner" }: { readonly ui: CollectionUi; readonly variant?: "banner" | "inline" }): JSX.Element | null {
  const [discarding, setDiscarding] = useState(false);
  const { view, copy, busy, actions } = ui;
  if (view.kind !== "ready") return null;
  const name = view.current?.name ?? view.heading;
  const notice = ui.unsyncedNotice;
  const review = ui.unsyncedReview;
  if (!notice && !view.unsyncedWork) return null;
  const consequence = review ? [
    review.counts.renamed > 0 ? copy.unsyncedReviewRenamed : null,
    review.addTypes?.length ? ui.say("unsyncedReviewTypes", { types: review.addTypes.join(", ") }) : null,
    review.missingTypes.length > 0 ? copy.unsyncedReviewMissing : null,
  ].filter(Boolean).join(" ") : undefined;
  return <div className="mdbase-collections">
    {notice
      ? <div className={`mdbase-collections-notice is-${variant}`} data-tone={notice.tone} role={notice.tone === "info" ? "status" : "alert"}>
        <div className="mdbase-collections-notice-copy"><p className="mdbase-collections-notice-message">{notice.message}</p></div>
        <div className="mdbase-collections-notice-actions">
          {notice.key === "unsynced_bring_in_failed" && view.unsyncedWork
            && <ActionButton tone="primary" inert={busy !== null} progress={busy === "bring_in" ? copy.unsyncedBringingIn : null} onClick={actions.bringIn}>{copy.unsyncedBringIn}</ActionButton>}
          <ActionButton tone="quiet" onClick={actions.dismissUnsyncedNotice}>{copy.close}</ActionButton>
        </div>
      </div>
      : <div className={`mdbase-collections-notice is-${variant}`} data-tone="info" role="status">
        <div className="mdbase-collections-notice-copy"><p className="mdbase-collections-notice-message">{ui.say("unsyncedBringInLead", { collection: name })}</p></div>
        <div className="mdbase-collections-notice-actions">
          <ActionButton tone="primary" inert={busy !== null} progress={busy === "bring_in" ? copy.unsyncedBringingIn : null} onClick={actions.bringIn}>{copy.unsyncedBringIn}</ActionButton>
          <ActionButton tone="quiet" inert={busy !== null} onClick={() => setDiscarding(true)}>{copy.unsyncedDiscard}</ActionButton>
        </div>
      </div>}
    <ConfirmDialog open={review !== null} tone="default" initialFocus="confirm" title={ui.say("unsyncedReviewTitle", { collection: name })}
      {...(consequence ? { consequence } : {})} confirmLabel={copy.unsyncedBringIn} pendingLabel={copy.unsyncedBringingIn}
      onClose={actions.dismissBringIn} onConfirm={actions.confirmBringIn} />
    <ConfirmDialog open={discarding} title={copy.unsyncedDiscardTitle} consequence={ui.say("unsyncedDiscardBody")}
      confirmLabel={copy.unsyncedDiscardConfirm} pendingLabel={copy.unsyncedDiscarding} busy={busy === "discard_unsynced"}
      onClose={() => setDiscarding(false)} onConfirm={() => { setDiscarding(false); actions.discardUnsynced(); }} />
  </div>;
}

const emptySubscribe = () => () => {};
const emptySnapshot = () => null;

/**
 * The save label for the app's own save notice while it works in its unsynced
 * collection ("Saved only in this browser" instead of "Saved"), or null
 * otherwise. Inside the gate it finds the entry by itself.
 */
export function useUnsyncedSavedLabel(supplied?: Mdbase, storage: "browser" | "device" = "browser"): string | null {
  useLocaleRevision();
  const inherited = useContext(CollectionMdbaseContext);
  const mdbase = supplied ?? inherited;
  const phase = useSyncExternalStore(mdbase?.subscribe ?? emptySubscribe, () => mdbase?.getSnapshot().phase ?? null, emptySnapshot);
  if (!phase || !unsyncedPhase(phase)) return null;
  return storage === "device" ? defaultCollectionCopy.unsyncedSavedDevice : defaultCollectionCopy.unsyncedSavedBrowser;
}
