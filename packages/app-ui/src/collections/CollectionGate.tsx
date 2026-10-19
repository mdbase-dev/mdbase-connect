import type { MdbaseApplicationConnection } from "@mdbase-dev/sdk";
import { useId, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from "react";

import { describeError } from "@mdbase-dev/sdk/describe";
import { OpeningScreen } from "../screens.js";
import { CollectionMdbaseContext } from "./CollectionSaveWarning.js";
import { SwitcherContent } from "./CollectionSwitcher.js";
import { RowDialogs, SignOutDialog } from "./dialogs.js";
import { problemControl, actionNotice, type CollectionView } from "./model.js";
import { ActionButton, CollectionMark, GateFooter, ItemCopy, ItemMore, NoticeBlock, RowCopy, RowMore, type RowDialog } from "./parts.js";
import { SetupReview } from "./SetupReview.js";
import { useAutoStart, useCollectionUi, type CollectionSection, type CollectionSectionItem, type CollectionUi, type CollectionUiOptions } from "./use-collection-ui.js";

/**
 * The app's own actions on the gate's screens ("Try sample tasks"). A function
 * gets the screen's view, to vary them by `view.kind` or return null.
 */
export type CollectionExtraActions = ReactNode | ((view: CollectionView) => ReactNode);

/** What `renderAppCollection` gets besides the open item. */
export interface AppCollectionContext {
  readonly section: CollectionSection;
  /** Close the item and return to the gate's list (with `onBeforeLeave("choose_another")`). */
  readonly chooseAnother: () => void;
}

export interface CollectionGateOwnProps {
  /** The app's actions: beside Sign in when signed out, in the footer on every other screen. */
  readonly extraActions?: CollectionExtraActions;
  /** "page" takes the viewport; "panel" sits inside the app's shell or a dialog. */
  readonly layout?: "page" | "panel";
  /** Call `mdbase.start()` when it hasn't started. Default true; safe with several gates. */
  readonly autoStart?: boolean;
}

export interface CollectionGateProps extends CollectionUiOptions, CollectionGateOwnProps {
  /** The app, rendered only once a collection is open and usable. */
  readonly children: (connection: MdbaseApplicationConnection) => ReactNode;
  /**
   * The app, while one of its section items is open (`current`). Without it
   * the gate keeps showing its screens. It takes precedence over the SDK's phase.
   */
  readonly renderAppCollection?: ((item: CollectionSectionItem, context: AppCollectionContext) => ReactNode) | undefined;
}

/**
 * Everything before a collection is open: sign-in, choosing, approval, setup
 * review and problems. In phase `ready` it renders the app, with a banner
 * above it for a live problem (migrating, update required, access removed).
 */
export function CollectionGate({ children, renderAppCollection, extraActions, layout = "page", autoStart = true, ...options }: CollectionGateProps): JSX.Element {
  const ui = useCollectionUi(options);
  useAutoStart(options.mdbase, autoStart);
  if (ui.appOpen && renderAppCollection) {
    return <CollectionMdbaseContext value={options.mdbase}>
      {renderAppCollection(ui.appOpen.item, { section: ui.appOpen.section, chooseAnother: ui.actions.chooseAnother })}
      <SignOutDialog ui={ui} />
    </CollectionMdbaseContext>;
  }
  if (ui.view.kind === "ready") {
    return <>
      {ui.view.notice && <div className="mdbase-collections"><NoticeBlock notice={ui.view.notice} ui={ui} variant="banner" /></div>}
      <CollectionMdbaseContext value={options.mdbase}>{children(ui.view.phase.connection)}</CollectionMdbaseContext>
      <SignOutDialog ui={ui} />
    </>;
  }
  return <GateScreen ui={ui} layout={layout} extraActions={extraActions} />;
}

export interface CollectionPanelProps extends CollectionUiOptions, Omit<CollectionGateOwnProps, "layout"> {}

/**
 * For write-first apps and settings dialogs: the gate's screens in a panel and,
 * once a collection is open, the switcher's list inline.
 */
export function CollectionPanel({ extraActions, autoStart = true, ...options }: CollectionPanelProps): JSX.Element {
  const ui = useCollectionUi(options);
  useAutoStart(options.mdbase, autoStart);
  const [dialog, setDialog] = useState<RowDialog>(null);
  if (ui.view.kind !== "ready") return <GateScreen ui={ui} layout="panel" extraActions={extraActions} />;
  return <div className="mdbase-collections mdbase-collections-panel">
    {ui.view.notice && <NoticeBlock notice={ui.view.notice} ui={ui} variant="inline" />}
    <SwitcherContent ui={ui} onDone={() => {}} onDialog={setDialog} />
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

function GateScreen({ ui, layout, extraActions }: { ui: CollectionUi; layout: "page" | "panel"; extraActions?: CollectionExtraActions | undefined }): JSX.Element {
  const { view, options } = ui;
  const extra = typeof extraActions === "function" ? extraActions(view) : extraActions;
  // An empty SDK list is not "no collections" when the app lists its own.
  const appListed = view.kind === "choosing" && view.collections.length === 0 && (options.sections ?? []).some((section) => section.items.length > 0);
  const headingText = appListed ? ui.say("chooseHeading") : view.heading;
  const lead = appListed ? null : view.lead;
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
  const opening = view.kind === "starting" || view.kind === "opening";
  const announce = view.kind === "authorizing" ? view.heading : "";
  return <div ref={root} className="mdbase-collections mdbase-collections-gate" data-layout={layout} data-phase={view.kind} aria-busy={ui.busy !== null || undefined}>
    <div className="mdbase-collections-gate-body">
      {!opening && <p className="mdbase-collections-brand">
        {options.app.mark && <span className="mdbase-collections-brand-mark" aria-hidden="true">{options.app.mark}</span>}
        <span>{options.app.name}</span>
      </p>}
      <Heading ref={heading} tabIndex={-1} className={opening ? "mdbase-collections-visually-hidden" : "mdbase-collections-heading"}>{headingText}</Heading>
      {opening
        ? <OpeningScreen app={options.app} layout={layout} title={headingText} detail={lead ?? undefined} />
        : lead && <p className="mdbase-collections-lead">{lead}</p>}
      <GateBody ui={ui} extraActions={view.kind === "signed_out" ? extra : undefined} onDialog={setDialog} />
      {ui.error && <NoticeBlock notice={ui.error} ui={ui} variant="inline" />}
      <GateFooter ui={ui} chooseAnother={showsChooseAnother(view)} extra={view.kind === "signed_out" ? undefined : extra} />
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

function GateBody({ ui, extraActions, onDialog }: {
  ui: CollectionUi;
  extraActions?: ReactNode;
  onDialog: (dialog: NonNullable<RowDialog>) => void;
}): JSX.Element | null {
  const { view, copy, busy, actions } = ui;
  const inert = busy !== null;
  switch (view.kind) {
    case "starting":
    case "opening":
      return null;
    case "signed_out":
      return <>
        {view.notice && <NoticeBlock notice={view.notice} ui={ui} variant="inline" />}
        <div className="mdbase-collections-actions">
          <ActionButton tone="primary" inert={inert} progress={busy === "sign_in" ? copy.addingCollection : null} onClick={actions.signIn}>{copy.signIn}</ActionButton>
          {extraActions}
        </div>
        <AppSections ui={ui} onDialog={onDialog} />
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
        {view.collections.length > 0 && <CollectionList ui={ui} onDialog={onDialog} />}
        <AppSections ui={ui} onDialog={onDialog} />
        <div className="mdbase-collections-actions">
          <ActionButton tone={view.collections.length > 0 ? "secondary" : "primary"} inert={inert} progress={busy === "add" ? copy.addingCollection : null}
            onClick={actions.addCollection}>{copy.addCollection}</ActionButton>
          {ui.options.allowPrivate !== false && <ActionButton tone="secondary" inert={inert} progress={busy === "add_private" ? copy.addingCollection : null}
            onClick={actions.addPrivateCollection}>{copy.addPrivateCollection}</ActionButton>}
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
function CollectionList({ ui, onDialog }: { ui: CollectionUi; onDialog: (dialog: NonNullable<RowDialog>) => void }): JSX.Element {
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
          <RowMore row={row} ui={ui} onDialog={onDialog} />
        </li>;
      })}
    </ul>
  </section>;
}

/** The app's own sections ("Private collections"), after the SDK's list. */
function AppSections({ ui, onDialog }: { ui: CollectionUi; onDialog: (dialog: NonNullable<RowDialog>) => void }): JSX.Element | null {
  const sections = (ui.options.sections ?? []).filter((section) => section.items.length > 0 || section.empty);
  if (sections.length === 0) return null;
  return <>{sections.map((section) => <AppSection key={section.id} ui={ui} section={section} onDialog={onDialog} />)}</>;
}

function AppSection({ ui, section, onDialog }: { ui: CollectionUi; section: CollectionSection; onDialog: (dialog: NonNullable<RowDialog>) => void }): JSX.Element {
  const id = useId();
  const { busy, actions } = ui;
  return <section className="mdbase-collections-section" aria-labelledby={id} data-section={section.id}>
    <h2 id={id} className="mdbase-collections-section-title">{section.title}</h2>
    {section.items.length === 0
      ? <p className="mdbase-collections-empty">{section.empty}</p>
      : <ul className="mdbase-collections-list">
        {section.items.map((item) => <li key={item.id} className="mdbase-collections-item">
          <button
            type="button"
            className="mdbase-collections-row"
            aria-disabled={item.disabled || busy !== null || undefined}
            aria-current={item.current || undefined}
            onClick={() => { if (busy === null) actions.selectItem(section, item); }}
          >
            <CollectionMark row={item} />
            <ItemCopy item={item} ui={ui} />
          </button>
          <ItemMore item={item} ui={ui} onDialog={onDialog} />
        </li>)}
      </ul>}
  </section>;
}
