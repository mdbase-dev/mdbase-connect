import type { ReactNode } from "react";
import {
  BracketsCurlyIcon as Braces,
  CaretDownIcon as ChevronDown,
  GearSixIcon as Settings,
  LinkIcon as Link,
  NotebookIcon as Notebook,
  SidebarSimpleIcon as PanelLeftClose
} from "./icons";
import { Wordmark } from "./Brand";

export type EditorRailSurface = "notes" | "types" | "settings" | "connect";

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
  connectHref,
  connectCount,
  onSwitch,
  onCollapse,
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
  connectHref: string;
  connectCount?: number;
  onSwitch: () => void;
  onCollapse?: () => void;
  children?: ReactNode;
  footer: ReactNode;
}) {
  return <aside className="collection-rail" aria-label="Collection navigation">
    <div className="rail-header"><Wordmark />{onCollapse && <RailCollapseButton onClick={onCollapse} />}</div>
    <nav>
      <button className="collection-name" aria-label={`Switch collection, current collection ${collectionName}`} onClick={onSwitch}><span>{collectionName}</span><ChevronDown aria-hidden="true" /></button>
      <RailLink destination={notes} selected={surface === "notes"} label="Notes" ariaLabel={noteCount === undefined ? "Notes" : `Notes, ${noteCount} total`} icon={<Notebook aria-hidden="true" />} count={noteCount} />
      <RailLink destination={types} selected={surface === "types"} label="Types" ariaLabel={typeCount === undefined ? "Types" : `Types (${typeCount})`} icon={<Braces aria-hidden="true" />} count={typeCount} />
      <RailLink destination={settings} selected={surface === "settings"} label="Settings" icon={<Settings aria-hidden="true" />} />
      {children}
      <p className="rail-manage-label">Manage</p>
      <a className={`editor-rail-link${surface === "connect" ? " selected" : ""}`} href={connectHref} aria-current={surface === "connect" ? "page" : undefined}>
        <span><Link aria-hidden="true" />Connect</span>{connectCount !== undefined && <small>{connectCount}</small>}
      </a>
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
  const content = <><span>{icon}{label}</span>{count !== undefined && <small>{count}</small>}</>;
  if (destination.href) {
    return <a className={`editor-rail-link${selected ? " selected" : ""}`} href={destination.href} aria-label={ariaLabel} aria-current={selected ? "page" : undefined}>{content}</a>;
  }
  return <button className={selected ? "selected" : ""} aria-label={ariaLabel} onClick={destination.onClick}>{content}</button>;
}

function RailCollapseButton({ onClick }: { onClick: () => void }) {
  return <button className="icon-button desktop-pane-control" aria-label="Hide collections sidebar" title="Hide collections sidebar" onClick={onClick}><PanelLeftClose aria-hidden="true" /></button>;
}
