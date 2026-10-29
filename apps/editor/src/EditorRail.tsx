import { displayLocale } from "./i18n/format";
import { Trans } from "@lingui/react/macro";
import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import type { ReactNode } from "react";
import {
  ArrowLeftIcon as ArrowLeft,
  BracketsCurlyIcon as Braces,
  GearSixIcon as Settings,
  NotebookIcon as Notebook,
  SidebarSimpleIcon as PanelLeftClose
} from "./icons";
import { Wordmark } from "@mdbase-dev/ui/brand";
import { FeedbackBug, useFeedback } from "@mdbase-dev/ui/feedback";
import "@mdbase-dev/ui/feedback.css";
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
  useLingui();
  return <aside className="collection-rail" aria-label={t`Collection navigation`}>
    <div className="rail-header"><div className="rail-collection-heading"><Wordmark app="editor" />{switcher ?? <span className="rail-current-collection"><span>{collectionName}</span></span>}</div>{onCollapse && <RailCollapseButton onClick={onCollapse} />}</div>
    <nav>
      {mobileReturn && <a className="mobile-editor-return" href={mobileReturn.href} onClick={mobileReturn.onClick}><span><ArrowLeft aria-hidden="true" />{mobileReturn.label}</span></a>}
      <div className="rail-scroll">
        <RailDropTarget folder="" onMoveNotes={onMoveNotes} onMoveFolder={onMoveFolder}><RailLink destination={notes} selected={notesSelected ?? surface === "notes"} label={t`All notes`} ariaLabel={noteCount === undefined ? t`All notes` : t`All notes, ${noteCount.toLocaleString(displayLocale())} total`} icon={<Notebook aria-hidden="true" />} count={noteCount} /></RailDropTarget>
        {children}
      </div>
      <div className="rail-bottom-group" role="group" aria-label={t`Collection tools`}>
        <RailLink destination={types} selected={surface === "types"} label={t`Types`} ariaLabel={typeCount === undefined ? t`Types` : t`Types (${typeCount})`} icon={<Braces aria-hidden="true" />} count={typeCount} />
        <RailLink destination={settings} selected={surface === "settings"} label={t`Settings`} icon={<Settings aria-hidden="true" />} />
        <RailFeedback />
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
  useLingui();
  const content = <><span>{icon}<span className="rail-row-label">{label}</span></span>{count !== undefined && <> <small>{count.toLocaleString(displayLocale())}</small></>}</>;
  if (destination.href) {
    return <a className={`editor-rail-link${selected ? " selected" : ""}`} href={destination.href} aria-label={ariaLabel} aria-current={selected ? "page" : undefined}>{content}</a>;
  }
  return <button className={selected ? "selected" : ""} aria-label={ariaLabel} aria-current={selected ? "page" : undefined} onClick={destination.onClick}>{content}</button>;
}

/** The workspace's feedback entry, last in the fixed tools group so it stays reachable
 * however long the folder tree grows. The feedback dialog returns focus here on close. */
function RailFeedback() {
  useLingui();
  const feedback = useFeedback();
  if (!feedback.enabled) return null;
  return <button type="button" className="mdbase-feedback-trigger rail-feedback" onClick={() => feedback.open()}>
    <span><FeedbackBug wiggle={feedback.wiggle} /><span className="rail-row-label"><Trans>Send feedback</Trans></span></span>
  </button>;
}

function RailCollapseButton({ onClick }: { onClick: () => void }) {
  useLingui();
  return <button className="icon-button desktop-pane-control" aria-label={t`Hide collections sidebar`} title={t`Hide collections sidebar`} onClick={onClick}><PanelLeftClose aria-hidden="true" /></button>;
}
