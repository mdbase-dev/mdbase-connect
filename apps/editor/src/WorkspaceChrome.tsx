import { useRef, type ReactNode } from "react";
import { MenuPopover, useMenuTrigger } from "./ActionMenu";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import {
  ArrowLeftIcon as ArrowLeft,
  ArrowLineLeftIcon as ArrowLineLeft,
  BracketsCurlyIcon as Braces,
  LinkIcon as Link2,
  ListBulletsIcon as ListBullets,
  SidebarSimpleIcon as Sidebar,
  WarningCircleIcon as CircleAlert,
  XIcon as X
} from "./icons";
import type { NoteSummary } from "./model";
import { noteTitle, type NoteHeading } from "./note";
import type { NoteActivity, SaveState } from "./note-session";
import { SaveNotice, type SaveTone } from "@mdbase-dev/ui/save-notice";
import { useDelayedBusy } from "./use-delayed-busy";

export function PathLabel({ path }: { path: string }) {
  const slash = path.lastIndexOf("/");
  return <span className="path-label" title={path}>
    {slash >= 0 && <span className="path-directory">{path.slice(0, slash + 1)}</span>}
    <span className="path-filename">{path.slice(slash + 1)}</span>
  </span>;
}

export function SaveIndicator({ state, activity, detail, identity, onCancel, onRetry }: { state: SaveState; activity?: NoteActivity; detail?: string; identity?: string; onCancel?: () => void; onRetry?: () => void }) {
  const attention = state === "conflict" || state === "error";
  const routineSave = !attention && state !== "recovery" && (activity === "saving" || activity === "properties" || (!activity && state === "saving"));
  const slow = useDelayedBusy(routineSave, identity);
  if (routineSave ? !slow : !activity && (state === "saved" || state === "waiting")) return null;
  const activityLabels: Record<NoteActivity, string> = {
    saving: "Saving…",
    properties: "Saving…",
    renaming: "Renaming links",
    moving: "Moving",
    deleting: "Deleting",
    validating: "Checking"
  };
  const label = attention ? "Needs attention" : state === "recovery" ? "Recovery pending"
    : detail ?? (activity ? activityLabels[activity] : "Saving…");
  const tone: SaveTone = attention ? "attention" : state === "recovery" ? "pending" : "saving";
  return <div className="save-indicator"><SaveNotice tone={tone} label={label} />{state === "error" && onRetry && <button className="cancel-operation mdbase-button is-secondary" onClick={onRetry}>Retry save</button>}{onCancel && <button className="cancel-operation mdbase-button is-secondary" onClick={onCancel}>Cancel</button>}</div>;
}
export function BacklinksPanel({ notes, types, loading, error, onRetry, onClose, onOpen }: {
  notes: NoteSummary[];
  types: CollectionTypeDescriptor[];
  loading: boolean;
  error?: string;
  onRetry?: () => void;
  onClose: () => void;
  onOpen: (path: string) => void;
}) {
  return <aside className="backlinks-panel" aria-label="Backlinks" aria-busy={loading}>
    <header className="panel-header">
      <div><h2>Backlinks</h2><p>{error ? "References are incomplete" : loading ? "Finding references" : `${notes.length} ${notes.length === 1 ? "note" : "notes"} link here`}</p></div>
      <button className="icon-button" aria-label="Close backlinks" onClick={onClose}><X aria-hidden="true" /></button>
    </header>
    {error && <p role="alert">{error} {onRetry && <button onClick={onRetry}>Retry backlinks</button>}</p>}
    <div className="backlink-list">
      {notes.map((note) => <button key={note.path} onClick={() => onOpen(note.path)}>
        <Link2 aria-hidden="true" />
        <span><strong>{noteTitle(note, types)}</strong><small>{note.path}</small></span>
      </button>)}
      {!notes.length && <p className="quiet-empty">{error ? "References could not finish loading." : loading ? "Reading collection links…" : "No notes link here yet."}</p>}
    </div>
  </aside>;
}

export function NoteSkeleton({ leadingActions }: { leadingActions?: ReactNode }) {
  return <div className="note-skeleton" aria-label="Loading note" aria-busy="true"><div className="skeleton-bar">{leadingActions}<span role="status">Opening note…</span></div><div className="skeleton-document"><p>Reading note content…</p></div></div>;
}

export function PaneSkeleton({ label, leadingActions, variant = "document" }: { label: string; leadingActions?: ReactNode; variant?: "document" | "canvas" }) {
  if (variant === "canvas") {
    return <main className="editor-pane file-workspace" aria-label={label} aria-busy="true"><div className="skeleton-bar">{leadingActions}<span role="status">{label}…</span></div><div className="file-workspace-content" /></main>;
  }
  return <main className="editor-pane" aria-label={label}><NoteSkeleton leadingActions={leadingActions} /></main>;
}

export function OutlineMenu({ headings, onReveal }: { headings: NoteHeading[]; onReveal: (line: number) => void }) {
  const { open, close, trigger, triggerProps } = useMenuTrigger();
  return <div className="note-actions outline-root">
    <button
      {...triggerProps}
      className="icon-button"
      aria-label="Document outline"
      title="Document outline"
      disabled={!headings.length}
    ><ListBullets aria-hidden="true" /></button>
    {open && <MenuPopover label="Document outline" className="outline-menu" triggerRef={trigger} onClose={close}>
      {headings.length ? headings.map((heading, index) => <button
        key={`${heading.line}:${index}`}
        role="menuitem"
        className={`outline-level-${heading.level}`}
        title={heading.text}
        onClick={() => {
          close(true);
          onReveal(heading.line);
        }}
      ><span className="outline-hash">{"#".repeat(heading.level)}</span><span className="outline-text">{heading.text}</span></button>) : <p className="outline-empty">No headings yet.</p>}
    </MenuPopover>}
  </div>;
}

export function InspectorPanelLoading({ label }: { label: "Note properties" | "Backlinks" }) {
  return <aside className="properties-panel properties-panel-loading" aria-label={label} aria-busy="true"><strong>{label}</strong><p role="status">Loading…</p></aside>;
}

export function TypeAccessPrompt({ leadingActions, onAuthorize, onBack }: {
  leadingActions?: ReactNode;
  onAuthorize: () => void;
  onBack: () => void;
}) {
  return <main className="empty-editor type-access-prompt" aria-label="Type access">
    <div className="empty-pane-actions"><button className="mobile-back icon-button" aria-label="Back to collections" onClick={onBack}><ArrowLeft aria-hidden="true" /></button>{leadingActions}</div>
    <div className="type-access-message">
      <Braces aria-hidden="true" />
      <h2>Type access needed</h2>
      <p>Notes are ready. Allow type-definition access only if you want to inspect or manage collection types.</p>
      <button onClick={onAuthorize}>Update access</button>
    </div>
  </main>;
}

export function EmptyEditor({ leadingActions, notice, onCreate, onRetry }: {
  leadingActions?: ReactNode;
  notice?: string;
  onCreate?: () => void;
  onRetry: () => void;
}) {
  return <div className="empty-editor">
    {leadingActions && <div className="empty-pane-actions">{leadingActions}</div>}
    {notice ? <div className="empty-error" role="alert">
      <CircleAlert aria-hidden="true" />
      <p>{notice}</p>
      <button onClick={onRetry}>Try again</button>
    </div> : <>
      <p>Select a note, or start a new one.</p>
      {onCreate && <button onClick={onCreate}>New note</button>}
    </>}
  </div>;
}

// The collections rail and the list pane get different glyphs so their controls are never confused when they sit side by side.
export function PaneControl({ pane, label, action, onClick }: { pane: "collections" | "list"; label: string; action: "show" | "hide"; onClick: () => void }) {
  const icon = pane === "collections" ? <Sidebar aria-hidden="true" /> : <ArrowLineLeft aria-hidden="true" mirrored={action === "show"} />;
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
    aria-valuetext={`${Math.round(value)} pixels`}
    title="Drag to resize · Double-click to reset"
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
