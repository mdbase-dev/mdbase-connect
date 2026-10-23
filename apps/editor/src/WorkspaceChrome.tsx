import { Trans } from "@lingui/react/macro";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Dialog } from "./Dialog";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import {
  ArrowLeftIcon as ArrowLeft,
  ArrowLineLeftIcon as ArrowLineLeft,
  BracketsCurlyIcon as Braces,
  CaretRightIcon as ChevronRight,
  LinkIcon as Link2,
  SidebarSimpleIcon as Sidebar,
  WarningCircleIcon as CircleAlert,
  XIcon as X
} from "./icons";
import type { NoteSummary } from "./model";
import { noteTitle, type NoteHeading } from "./note";
import type { NoteActivity, SaveState } from "./note-session";
import { SaveNotice, type SaveTone } from "@mdbase-dev/ui/save-notice";
import type { UnlinkedMention } from "./unlinked-mentions";
import { useDelayedBusy } from "./use-delayed-busy";
import { SearchMatchText } from "./SearchMatchText";

export function PathLabel({ path }: { path: string }) {
  useLingui();
  const slash = path.lastIndexOf("/");
  return <span className="path-label" title={path}>
    {slash >= 0 && <span className="path-directory">{path.slice(0, slash + 1)}</span>}
    <span className="path-filename">{path.slice(slash + 1)}</span>
  </span>;
}

export function SaveIndicator({ state, activity, detail, identity, savedOnDevice, onCancel, onRetry }: { state: SaveState; activity?: NoteActivity; detail?: string; identity?: string; savedOnDevice?: boolean; onCancel?: () => void; onRetry?: () => void }) {
  useLingui();
  const attention = state === "conflict" || state === "error";
  const routineSave = !attention && state !== "recovery" && (activity === "saving" || activity === "properties" || (!activity && state === "saving"));
  const slow = useDelayedBusy(routineSave, identity);
  const idle = routineSave ? !slow : !activity && (state === "saved" || state === "waiting");
  // The SDK keeps saved changes on this device while the collection can't be reached.
  if (idle && savedOnDevice) return <div className="save-indicator"><SaveNotice tone="pending" label={t`Saved on this device; waiting for sync`} /></div>;
  if (idle) return null;
  const activityLabels: Record<NoteActivity, string> = {
    saving: t`Saving…`,
    properties: t`Saving…`,
    renaming: t`Renaming links`,
    moving: t`Moving`,
    deleting: t`Deleting`,
    validating: t`Checking`
  };
  const label = attention ? t`Needs attention` : state === "recovery" ? t`Not confirmed yet`
    : detail ?? (activity ? activityLabels[activity] : t`Saving…`);
  const tone: SaveTone = attention ? "attention" : state === "recovery" ? "pending" : "saving";
  return <div className="save-indicator"><SaveNotice tone={tone} label={label} />{state === "error" && onRetry && <button className="cancel-operation mdbase-button is-secondary" onClick={onRetry}><Trans>Retry save</Trans></button>}{onCancel && <button className="cancel-operation mdbase-button is-secondary" onClick={onCancel}><Trans>Cancel</Trans></button>}</div>;
}
export function BacklinksPanel({ notes, types, loading, error, onFind, onRetry, onOpen, mentions = [], onLinkMention, linking }: {
  notes: NoteSummary[];
  types: CollectionTypeDescriptor[];
  loading: boolean;
  error?: string;
  onRetry?: () => void;
  onFind?: () => void;
  onOpen: (path: string) => void;
  mentions?: UnlinkedMention[];
  onLinkMention?: (mention: UnlinkedMention) => void;
  linking?: boolean;
}) {
  useLingui();
  const [expanded, setExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const visibleMentions = showAll ? mentions : mentions.slice(0, 5);
  return <section id="linked-from" tabIndex={-1} className="linked-from" aria-label={t`Linked from`} aria-busy={loading}>
    <h2><Trans>Linked from</Trans></h2>
    {onFind && <button onClick={onFind}><Trans>Find linked notes</Trans></button>}
    {error && <p role="alert">{error} {onRetry && <button onClick={onRetry}><Trans>Retry backlinks</Trans></button>}</p>}
    <div className="backlink-list">
      {notes.map((note) => <button key={note.path} onClick={() => onOpen(note.path)}>
        <Link2 aria-hidden="true" />
        <span><strong>{noteTitle(note, types)}</strong><small>{note.path}</small></span>
      </button>)}
      {!notes.length && !onFind && <p className="quiet-empty">{error ? t`References could not finish loading.` : loading ? t`Reading collection links…` : t`No notes link here yet.`}</p>}
    </div>
    <details className="unlinked-mentions settings-details" onToggle={(event) => {
      const open = event.currentTarget.open;
      setExpanded(open);
      if (open) onFind?.();
      else setShowAll(false);
    }}>
      <summary><span><Trans>Unlinked mentions ({mentions.length})</Trans></span><ChevronRight aria-hidden="true" /></summary>
      {expanded && <>
        {visibleMentions.map((mention) => <div className="unlinked-mention" key={mention.note.path}>
          <button onClick={() => onOpen(mention.note.path)}><strong>{noteTitle(mention.note, types)}</strong><small><SearchMatchText text={mention.snippet} ranges={mention.snippetRanges} /></small></button>
          {onLinkMention && <button className="mdbase-button is-tertiary" aria-label={t`Link mention in ${noteTitle(mention.note, types)}`} disabled={linking} onClick={() => onLinkMention(mention)}><Trans>Link</Trans></button>}
        </div>)}
        {mentions.length > 5 && <button className="mdbase-button is-tertiary" onClick={() => setShowAll((current) => !current)}>{showAll ? t`Show fewer` : t`Show all ${mentions.length}`}</button>}
        {!mentions.length && <p className="quiet-empty">{loading ? t`Reading collection text…` : onFind ? t`Open to find mentions.` : t`No unlinked mentions.`}</p>}
      </>}
    </details>
  </section>;
}

export function NoteSkeleton({ leadingActions }: { leadingActions?: ReactNode }) {
  useLingui();
  return <div className="note-skeleton" aria-label={t`Loading note`} aria-busy="true"><div className="skeleton-bar">{leadingActions}<span role="status"><Trans>Opening note…</Trans></span></div><div className="skeleton-document"><p><Trans>Reading note content…</Trans></p></div></div>;
}

export function PaneSkeleton({ label, leadingActions, variant = "document" }: { label: string; leadingActions?: ReactNode; variant?: "document" | "canvas" }) {
  useLingui();
  if (variant === "canvas") {
    return <main className="editor-pane file-workspace" aria-label={label} aria-busy="true"><div className="skeleton-bar">{leadingActions}<span role="status">{label}…</span></div><div className="file-workspace-content" /></main>;
  }
  return <main className="editor-pane" aria-label={label}><NoteSkeleton leadingActions={leadingActions} /></main>;
}

export function OutlinePanel({ headings, onReveal, onClose }: { headings: NoteHeading[]; onReveal: (line: number) => void; onClose: () => void }) {
  useLingui();
  return <Dialog titleId="outline-title" className="confirm-dialog outline-panel" onClose={onClose}>
    <header className="panel-header"><h2 id="outline-title"><Trans>Document outline</Trans></h2><button className="icon-button" aria-label={t`Close outline`} onClick={onClose}><X aria-hidden="true" /></button></header>
    <nav aria-label={t`Document outline`}>
      {headings.length ? headings.map((heading, index) => <button key={`${heading.line}:${index}`} className={`outline-level-${heading.level}`} onClick={() => { onClose(); onReveal(heading.line); }}><span className="outline-hash">{"#".repeat(heading.level)}</span><span className="outline-text">{heading.text}</span></button>) : <p className="outline-empty"><Trans>No headings yet.</Trans></p>}
    </nav>
  </Dialog>;
}

export function InspectorFrame({ overlay, label, width, onClose, children }: {
  overlay: boolean;
  label: string;
  width: number;
  onClose: () => void;
  children: ReactNode;
}) {
  useLingui();
  const titleId = useId();
  const content = useRef<HTMLDivElement>(null);
  if (!overlay) return <div className="inspector-dock">{children}</div>;
  return <Dialog titleId={titleId} className="inspector-overlay" scrimClassName="inspector-scrim" onClose={() => {
    // Source editing may need to finish a save before closing. Use the same
    // close action for Escape/the scrim as for the panel's own close button.
    const close = content.current?.querySelector<HTMLButtonElement>("[data-inspector-close]");
    if (close) close.click();
    else onClose();
  }}>
    <h2 id={titleId} className="sr-only">{label}</h2>
    <div ref={content} className="inspector-content" style={{ "--inspector-width": `${width}px` } as CSSProperties}>{children}</div>
  </Dialog>;
}

export function InspectorPanelLoading({ label }: { label: string }) {
  useLingui();
  return <aside className="properties-panel properties-panel-loading" aria-label={label} aria-busy="true"><strong>{label}</strong><p role="status"><Trans>Loading…</Trans></p></aside>;
}

export function TypeAccessPrompt({ leadingActions, onAuthorize, onBack }: {
  leadingActions?: ReactNode;
  onAuthorize: () => void;
  onBack: () => void;
}) {
  useLingui();
  return <main className="empty-editor type-access-prompt" aria-label={t`Type access`}>
    <div className="empty-pane-actions"><button className="mobile-back icon-button" aria-label={t`Back to collections`} onClick={onBack}><ArrowLeft aria-hidden="true" /></button>{leadingActions}</div>
    <div className="type-access-message">
      <Braces aria-hidden="true" />
      <h2><Trans>Type access needed</Trans></h2>
      <p><Trans>Notes are ready. Allow type-definition access only if you want to inspect or manage collection types.</Trans></p>
      <button onClick={onAuthorize}><Trans>Update access</Trans></button>
    </div>
  </main>;
}

export function EmptyEditor({ leadingActions, notice, onCreate, onRetry }: {
  leadingActions?: ReactNode;
  notice?: string;
  onCreate?: () => void;
  onRetry: () => void;
}) {
  useLingui();
  return <div className="empty-editor">
    {leadingActions && <div className="empty-pane-actions">{leadingActions}</div>}
    {notice ? <div className="empty-error" role="alert">
      <CircleAlert aria-hidden="true" />
      <p>{notice}</p>
      <button onClick={onRetry}><Trans>Try again</Trans></button>
    </div> : <>
      <p><Trans>Select a note, or start a new one.</Trans></p>
      {onCreate && <button onClick={onCreate}><Trans>New note</Trans></button>}
    </>}
  </div>;
}

// The collections rail and the list pane get different glyphs so their controls are never confused when they sit side by side.
export function PaneControl({ pane, label, visibility, onClick }: { pane: "collections" | "list"; label: string; visibility: "show" | "hide"; onClick: () => void }) {
  useLingui();
  const icon = pane === "collections" ? <Sidebar aria-hidden="true" /> : <ArrowLineLeft aria-hidden="true" mirrored={visibility === "show"} />;
  return <button className="icon-button desktop-pane-control" aria-label={label} title={label} onClick={onClick}>{icon}</button>;
}

export function PaneResizeHandle({ className, label, value, min, max, direction = "forward", onChange, onReset, onDragChange }: {
  className: string;
  label: string;
  value: number;
  min: number;
  max: number;
  direction?: "forward" | "reverse";
  onChange: (value: number) => void;
  onReset: () => void;
  onDragChange: (dragging: boolean) => void;
}) {
  useLingui();
  const drag = useRef<{ pointerId: number; startX: number; startValue: number } | undefined>(undefined);
  const boundedMax = Math.max(min, max);
  const directionFactor = direction === "reverse" ? -1 : 1;
  const setBoundedValue = (next: number) => onChange(Math.round(Math.min(boundedMax, Math.max(min, next))));

  function finishDrag(element: HTMLDivElement, pointerId: number) {
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    drag.current = undefined;
    onDragChange(false);
  }

  return <div
    className={`pane-resizer ${className}`}
    role="separator"
    aria-label={label}
    aria-orientation="vertical"
    aria-valuemin={min}
    aria-valuemax={boundedMax}
    aria-valuenow={Math.min(boundedMax, Math.max(min, value))}
    aria-valuetext={t`${Math.round(value)} pixels`}
    title={t`Drag to resize · Double-click to reset`}
    tabIndex={0}
    onDoubleClick={onReset}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      drag.current = { pointerId: event.pointerId, startX: event.clientX, startValue: value };
      event.currentTarget.setPointerCapture(event.pointerId);
      onDragChange(true);
    }}
    onPointerMove={(event) => {
      if (!drag.current || drag.current.pointerId !== event.pointerId) return;
      setBoundedValue(drag.current.startValue + directionFactor * (event.clientX - drag.current.startX));
    }}
    onPointerUp={(event) => {
      if (drag.current?.pointerId === event.pointerId) finishDrag(event.currentTarget, event.pointerId);
    }}
    onPointerCancel={(event) => {
      if (drag.current?.pointerId === event.pointerId) finishDrag(event.currentTarget, event.pointerId);
    }}
    onKeyDown={(event) => {
      const step = event.shiftKey ? 24 : 8;
      let next: number | undefined;
      if (event.key === "ArrowLeft") next = value - directionFactor * step;
      if (event.key === "ArrowRight") next = value + directionFactor * step;
      if (event.key === "Home") next = min;
      if (event.key === "End") next = boundedMax;
      if (next === undefined) return;
      event.preventDefault();
      setBoundedValue(next);
    }}
  />;
}
