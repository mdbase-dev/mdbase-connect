import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import {
  ArrowLeftIcon as ArrowLeft,
  BracketsCurlyIcon as Braces,
  CheckIcon as Check,
  LinkIcon as Link2,
  ListBulletsIcon as ListBullets,
  SidebarSimpleIcon as PanelLeftClose,
  SidebarSimpleIcon as PanelLeftOpen,
  WarningCircleIcon as CircleAlert,
  XIcon as X
} from "./icons";
import type { NoteSummary } from "./model";
import { noteTitle, type NoteHeading } from "./note";
import type { NoteActivity, SaveState } from "./note-session";

export function SaveIndicator({ state, activity, detail, onCancel }: { state: SaveState; activity?: NoteActivity; detail?: string; onCancel?: () => void }) {
  const activityLabels: Record<NoteActivity, string> = {
    saving: "Saving",
    properties: "Updating",
    renaming: "Renaming links",
    moving: "Moving",
    deleting: "Deleting",
    validating: "Checking"
  };
  const label = detail ?? (activity
    ? activityLabels[activity]
    : state === "saving" ? "Saving" : state === "waiting" ? "Unsaved" : state === "conflict" ? "Needs attention" : "Saved");
  const tone = activity ? "saving" : state;
  return <div className="save-indicator"><span className={`save-state ${tone}`} aria-live="polite">{!activity && state === "saved" && <Check aria-hidden="true" />}{label}</span>{onCancel && <button className="cancel-operation" onClick={onCancel}>Cancel</button>}</div>;
}
export function BacklinksPanel({ notes, types, loading, onClose, onOpen }: {
  notes: NoteSummary[];
  types: CollectionTypeDescriptor[];
  loading: boolean;
  onClose: () => void;
  onOpen: (path: string) => void;
}) {
  return <aside className="backlinks-panel" aria-label="Backlinks" aria-busy={loading}>
    <header className="panel-header">
      <div><h2>Backlinks</h2><p>{loading ? "Finding references" : `${notes.length} ${notes.length === 1 ? "note" : "notes"} link here`}</p></div>
      <button className="icon-button" aria-label="Close backlinks" onClick={onClose}><X aria-hidden="true" /></button>
    </header>
    <div className="backlink-list">
      {notes.map((note) => <button key={note.path} onClick={() => onOpen(note.path)}>
        <Link2 aria-hidden="true" />
        <span><strong>{noteTitle(note, types)}</strong><small>{note.path}</small></span>
      </button>)}
      {!notes.length && <p className="quiet-empty">{loading ? "Reading collection links…" : "No notes link here yet."}</p>}
    </div>
  </aside>;
}

export function NoteSkeleton({ leadingActions }: { leadingActions?: ReactNode }) {
  return <div className="note-skeleton" aria-label="Loading note" aria-busy="true"><div className="skeleton-bar">{leadingActions}<span /></div><div className="skeleton-document"><span className="skeleton-title" /><span /><span /><span className="short" /></div></div>;
}

export function PaneSkeleton({ label, leadingActions, variant = "document" }: { label: string; leadingActions?: ReactNode; variant?: "document" | "canvas" }) {
  if (variant === "canvas") {
    return <main className="editor-pane file-workspace" aria-label={label} aria-busy="true"><div className="skeleton-bar">{leadingActions}<span /></div><div className="file-workspace-content"><span className="skeleton-canvas-pill" aria-hidden="true" /></div></main>;
  }
  return <main className="editor-pane" aria-label={label}><NoteSkeleton leadingActions={leadingActions} /></main>;
}

export function OutlineMenu({ headings, onReveal }: { headings: NoteHeading[]; onReveal: (line: number) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    const menu = root.current?.querySelector<HTMLButtonElement>(".outline-menu button");
    menu?.focus();
    const closeForOutsidePress = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const items = [...(root.current?.querySelectorAll<HTMLButtonElement>(".outline-menu button") ?? [])];
      if (!items.length) return;
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const direction = event.key === "ArrowDown" ? 1 : -1;
      event.preventDefault();
      items[(current + direction + items.length) % items.length]?.focus();
    };
    document.addEventListener("pointerdown", closeForOutsidePress);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", closeForOutsidePress);
      document.removeEventListener("keydown", onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return <div className="note-actions outline-root" ref={root}>
    <button
      ref={trigger}
      className="icon-button"
      aria-label="Document outline"
      aria-haspopup="menu"
      aria-expanded={open}
      title="Document outline"
      disabled={!headings.length}
      onClick={() => setOpen((value) => !value)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown") return;
        event.preventDefault();
        setOpen(true);
      }}
    ><ListBullets aria-hidden="true" /></button>
    {open && <div className="action-menu outline-menu" role="menu" aria-label="Document outline">
      {headings.length ? headings.map((heading, index) => <button
        key={`${heading.line}:${index}`}
        role="menuitem"
        className={`outline-level-${heading.level}`}
        title={heading.text}
        onClick={() => {
          close();
          onReveal(heading.line);
        }}
      ><span className="outline-hash">{"#".repeat(heading.level)}</span><span className="outline-text">{heading.text}</span></button>) : <p className="outline-empty">No headings yet.</p>}
    </div>}
  </div>;
}

export function InspectorPanelLoading({ label }: { label: "Note properties" | "Backlinks" }) {
  return <aside className="properties-panel properties-panel-loading" aria-label={label} aria-busy="true"><div /><span /><span /><span /></aside>;
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
  onCreate: () => void;
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
      <button onClick={onCreate}>New note</button>
    </>}
  </div>;
}

export function PaneControl({ label, action, onClick }: { label: string; action: "show" | "hide"; onClick: () => void }) {
  const Icon = action === "show" ? PanelLeftOpen : PanelLeftClose;
  return <button className="icon-button desktop-pane-control" aria-label={label} title={label} onClick={onClick}><Icon aria-hidden="true" /></button>;
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
