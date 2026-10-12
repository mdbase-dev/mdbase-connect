import type { ReactNode } from "react";
import {
  ArrowLeftIcon as ArrowLeft,
  BracketsCurlyIcon as Braces,
  GearSixIcon as Settings,
  NotebookIcon as Notebook,
  SidebarSimpleIcon as PanelLeftClose
} from "./icons";
import { Wordmark } from "@mdbase-dev/ui/brand";
import { RailDropTarget, type RailDropActions } from "./RailDropTarget";

export type EditorRailSurface = "notes" | "types" | "settings";

interface RailDestination {
  href?: string;
  onClick?: () => void;
}

export function EditorRail({
  collectionName,
  noteCount,
  typeCount,
  surface,
  notes,
  types,
  settings,
  mobileReturn,
  switcher,
  onCollapse,
  onMoveNotes,
  onMoveFolder,
  notesSelected,
  children,
  footer
}: {
  collectionName: string;
  noteCount?: number;
  typeCount?: number;
  surface: EditorRailSurface;
  notes: RailDestination;
  types: RailDestination;
  settings: RailDestination;
  mobileReturn?: RailDestination & { label: string };
  /** The shared collection switcher; without one the header just names the collection. */
  switcher?: ReactNode;
  onCollapse?: () => void;
  children?: ReactNode;
  footer: ReactNode;
  notesSelected?: boolean;
} & RailDropActions) {
  return <aside className="collection-rail" aria-label="Collection navigation">
    <div className="rail-header"><div className="rail-collection-heading"><Wordmark app="editor" />{switcher ?? <span className="rail-current-collection"><span>{collectionName}</span></span>}</div>{onCollapse && <RailCollapseButton onClick={onCollapse} />}</div>
    <nav>
      {mobileReturn && <a className="mobile-editor-return" href={mobileReturn.href} onClick={mobileReturn.onClick}><span><ArrowLeft aria-hidden="true" />{mobileReturn.label}</span></a>}
      <div className="rail-scroll">
        <RailDropTarget folder="" onMoveNotes={onMoveNotes} onMoveFolder={onMoveFolder}><RailLink destination={notes} selected={notesSelected ?? surface === "notes"} label="All notes" ariaLabel={noteCount === undefined ? "All notes" : `All notes, ${noteCount.toLocaleString()} total`} icon={<Notebook aria-hidden="true" />} count={noteCount} /></RailDropTarget>
        {children}
      </div>
      <div className="rail-bottom-group" role="group" aria-label="Collection tools">
        <RailLink destination={types} selected={surface === "types"} label="Types" ariaLabel={typeCount === undefined ? "Types" : `Types (${typeCount})`} icon={<Braces aria-hidden="true" />} count={typeCount} />
        <RailLink destination={settings} selected={surface === "settings"} label="Settings" icon={<Settings aria-hidden="true" />} />
      </div>
    </nav>
    <footer className="connection-footer">{footer}</footer>
  </aside>;
}

function RailLink({ destination, selected, label, ariaLabel, icon, count }: {
  destination: RailDestination;
  selected: boolean;
  label: string;
  ariaLabel?: string;
  icon: ReactNode;
  count?: number;
}) {
  const content = <><span>{icon}<span className="rail-row-label">{label}</span></span>{count !== undefined && <small>{count.toLocaleString()}</small>}</>;
  if (destination.href) {
    return <a className={`editor-rail-link${selected ? " selected" : ""}`} href={destination.href} aria-label={ariaLabel} aria-current={selected ? "page" : undefined}>{content}</a>;
  }
  return <button className={selected ? "selected" : ""} aria-label={ariaLabel} aria-current={selected ? "page" : undefined} onClick={destination.onClick}>{content}</button>;
}

function RailCollapseButton({ onClick }: { onClick: () => void }) {
  return <button className="icon-button desktop-pane-control" aria-label="Hide collections sidebar" title="Hide collections sidebar" onClick={onClick}><PanelLeftClose aria-hidden="true" /></button>;
}
