import type { MdbaseApplicationConnection } from "@mdbase-dev/sdk";
import { useId, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from "react";

import { describeError } from "@mdbase-dev/sdk/describe";
import { SwitcherContent } from "./CollectionSwitcher.js";
import { RowDialogs, SignOutDialog, type RowDialog } from "./dialogs.js";
import { problemControl, actionNotice, type CollectionRow, type CollectionView } from "./model.js";
import { ActionButton, CollectionMark, GateFooter, NoticeBlock, RowCopy, RowMore } from "./parts.js";
import { SetupReview } from "./SetupReview.js";
import { useCollectionUi, type CollectionUi, type CollectionUiOptions } from "./use-collection-ui.js";

export interface CollectionGateProps extends CollectionUiOptions {
  /** The app, rendered only once a collection is open and usable. */
  readonly children: (connection: MdbaseApplicationConnection) => ReactNode;
  /** App content beside Sign in on the signed-out screen ("Try sample tasks"). */
  readonly extraActions?: ReactNode;
  /** "page" takes the viewport; "panel" sits inside the app's shell or a dialog. */
  readonly layout?: "page" | "panel";
}

/**
 * Everything before a collection is open: sign-in, choosing, approval, setup
 * review and problems. In phase `ready` it renders the app, with a banner
 * above it for a live problem (migrating, update required, access removed).
 */
export function CollectionGate({ children, extraActions, layout = "page", ...options }: CollectionGateProps): JSX.Element {
  const ui = useCollectionUi(options);
  if (ui.view.kind === "ready") {
    return <>
      {ui.view.notice && <div className="mdbase-collections"><NoticeBlock notice={ui.view.notice} ui={ui} variant="banner" /></div>}
      {children(ui.view.phase.connection)}
      <SignOutDialog ui={ui} />
    </>;
  }
  return <GateScreen ui={ui} layout={layout} extraActions={extraActions} />;
}

/**
 * For write-first apps and settings dialogs: the gate's screens in a panel and,
 * once a collection is open, the switcher's list inline.
 */
export function CollectionPanel(options: CollectionUiOptions): JSX.Element {
  const ui = useCollectionUi(options);
  const [dialog, setDialog] = useState<RowDialog>(null);
  if (ui.view.kind !== "ready") return <GateScreen ui={ui} layout="panel" />;
  return <div className="mdbase-collections mdbase-collections-panel">
    {ui.view.notice && <NoticeBlock notice={ui.view.notice} ui={ui} variant="inline" />}
    <SwitcherContent ui={ui} onDone={() => {}} onForget={(row) => setDialog({ kind: "forget", row })} onDelete={(row) => setDialog({ kind: "delete", row })} />
    <RowDialogs ui={ui} dialog={dialog} onClose={() => setDialog(null)} />
    <SignOutDialog ui={ui} />
  </div>;
}

export interface CollectionProblemProps extends CollectionUiOptions {
  /** An error from the app's own call (a write that was refused). Default: the current phase's problem. */
  readonly problem?: unknown;
  readonly variant?: "block" | "banner";
}

/** One problem with its fix, for banners and toasts inside the app. Renders nothing when there is none. */
export function CollectionProblem({ problem, variant = "banner", ...options }: CollectionProblemProps): JSX.Element | null {
  const ui = useCollectionUi(options);
  const { view } = ui;
  let notice = view.kind === "ready" || view.kind === "problem" || view.kind === "unavailable" ? view.notice : null;
  if (problem !== undefined) {
    const described = describeError(problem);
    const quiet = actionNotice(described);
    notice = described && quiet
      ? { ...quiet, control: problemControl(described, { collectionId: view.current?.id ?? null, signedIn: view.signedIn, open: view.kind === "ready" }) }
      : null;
  }
  if (!notice) return null;
  return <div className="mdbase-collections"><NoticeBlock notice={notice} ui={ui} variant={variant} /></div>;
}

function GateScreen({ ui, layout, extraActions }: { ui: CollectionUi; layout: "page" | "panel"; extraActions?: ReactNode }): JSX.Element {
  const { view, options } = ui;
  const heading = useRef<HTMLHeadingElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [dialog, setDialog] = useState<RowDialog>(null);
  const previousKind = useRef<CollectionView["kind"] | null>(null);
  // Move focus to the new heading when the phase changes, unless the person is busy elsewhere on the page.
  useLayoutEffect(() => {
    const before = previousKind.current;
    previousKind.current = view.kind;
    if (before === null || before === view.kind) return;
    const active = document.activeElement;
    if (!active || active === document.body || root.current?.contains(active)) heading.current?.focus({ preventScroll: true });
  }, [view.kind]);
  const Heading = layout === "page" ? "h1" : "h2";
  const announce = view.kind === "starting" || view.kind === "opening" || view.kind === "authorizing" ? view.heading : "";
  return <div ref={root} className="mdbase-collections mdbase-collections-gate" data-layout={layout} data-phase={view.kind} aria-busy={ui.busy !== null || undefined}>
    <div className="mdbase-collections-gate-body">
      <p className="mdbase-collections-brand">
        {options.app.mark && <span className="mdbase-collections-brand-mark" aria-hidden="true">{options.app.mark}</span>}
        <span>{options.app.name}</span>
      </p>
      <Heading ref={heading} tabIndex={-1} className="mdbase-collections-heading">{view.heading}</Heading>
      {view.lead && <p className="mdbase-collections-lead">{view.lead}</p>}
      <GateBody ui={ui} extraActions={extraActions} onForget={(row) => setDialog({ kind: "forget", row })} onDelete={(row) => setDialog({ kind: "delete", row })} />
      {ui.error && <NoticeBlock notice={ui.error} ui={ui} variant="inline" />}
      <GateFooter ui={ui} chooseAnother={showsChooseAnother(view)} />
    </div>
    <p className="mdbase-collections-visually-hidden" role="status">{announce}</p>
    <RowDialogs ui={ui} dialog={dialog} onClose={() => setDialog(null)} />
    <SignOutDialog ui={ui} />
  </div>;
}

function showsChooseAnother(view: CollectionView): boolean {
  if (!view.canChooseAnother) return false;
  switch (view.kind) {
    case "opening": return view.slow;
    case "needs_approval":
    case "needs_setup": return true;
    case "problem": return view.notice.control?.kind !== "choose_another";
    default: return false;
  }
}

function GateBody({ ui, extraActions, onForget, onDelete }: {
  ui: CollectionUi;
  extraActions?: ReactNode;
  onForget: (row: CollectionRow) => void;
  onDelete: (row: CollectionRow) => void;
}): JSX.Element | null {
  const { view, copy, busy, actions } = ui;
  const inert = busy !== null;
  switch (view.kind) {
    case "starting":
    case "opening":
      return <p className="mdbase-collections-progress"><span className="mdbase-collections-spinner" aria-hidden="true" /></p>;
    case "signed_out":
      return <>
        {view.notice && <NoticeBlock notice={view.notice} ui={ui} variant="inline" />}
        <div className="mdbase-collections-actions">
          <ActionButton tone="primary" inert={inert} progress={busy === "sign_in" ? copy.addingCollection : null} onClick={actions.signIn}>{copy.signIn}</ActionButton>
          {extraActions}
        </div>
      </>;
    case "authorizing":
      return <div className="mdbase-collections-actions">
        <ActionButton tone="secondary" onClick={actions.reopen}>{copy.openWindowAgain}</ActionButton>
        {busy === "sign_in" || busy === "add" || busy === "approve"
          ? <ActionButton tone="quiet" onClick={actions.cancel}>{copy.cancel}</ActionButton> : null}
      </div>;
    case "choosing":
      return <>
        {view.notice && <NoticeBlock notice={view.notice} ui={ui} variant="inline" />}
        {view.collections.length > 0 && <CollectionList ui={ui} onForget={onForget} onDelete={onDelete} />}
        <div className="mdbase-collections-actions">
          <ActionButton tone={view.collections.length > 0 ? "secondary" : "primary"} inert={inert} progress={busy === "add" ? copy.addingCollection : null}
            onClick={actions.addCollection}>{copy.addCollection}</ActionButton>
        </div>
      </>;
    case "needs_approval":
      return <div className="mdbase-collections-actions">
        <ActionButton tone="primary" inert={inert} progress={busy === "approve" ? copy.addingCollection : null}
          onClick={() => actions.approve(view.collectionId)}>{copy.reviewAccess}</ActionButton>
      </div>;
    case "needs_setup":
      return <SetupReview key={view.collectionId} ui={ui} />;
    case "problem":
      return <NoticeBlock notice={view.notice} ui={ui} />;
    case "unavailable":
    case "closed":
      return <>
        {view.kind === "unavailable" && <NoticeBlock notice={view.notice} ui={ui} />}
        <div className="mdbase-collections-actions">
          <ActionButton tone="primary" onClick={() => globalThis.location?.reload()}>{copy.reload}</ActionButton>
        </div>
      </>;
    case "ready":
      return null;
  }
}

/** The approved collections as a labelled list: one row per collection, never mixed with actions. */
function CollectionList({ ui, onForget, onDelete }: { ui: CollectionUi; onForget: (row: CollectionRow) => void; onDelete: (row: CollectionRow) => void }): JSX.Element {
  const id = useId();
  const { view, copy, busy, actions } = ui;
  return <section className="mdbase-collections-section" aria-labelledby={id}>
    <h2 id={id} className="mdbase-collections-section-title">{copy.yourCollections}</h2>
    <ul className="mdbase-collections-list">
      {view.collections.map((row) => {
        const detailId = row.statusDetail ? `${id}-${row.id}` : undefined;
        return <li key={row.id} className="mdbase-collections-item">
          <button
            type="button"
            className="mdbase-collections-row"
            aria-disabled={!row.available || busy !== null || undefined}
            aria-describedby={detailId}
            onClick={() => { if (row.available && busy === null) actions.select(row.id); }}
          >
            <CollectionMark row={row} />
            <RowCopy row={row} ui={ui} {...(detailId ? { detailId } : {})} />
          </button>
          <RowMore row={row} ui={ui} onForget={onForget} onDelete={onDelete} />
        </li>;
      })}
    </ul>
  </section>;
}
