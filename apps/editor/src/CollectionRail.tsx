import { i18n } from "@lingui/core";
import { Trans } from "@lingui/react/macro";
import { t, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import {
  CaretDownIcon as ChevronDown,
  CaretRightIcon as ChevronRight,
  CopyIcon as Copy,
  FilePlusIcon as FilePlus2,
  FolderIcon as Folder,
  FolderPlusIcon as FolderPlus,
} from "./icons";
import { ContextMenu } from "./ContextMenu";
import { FolderChangeDialog, type FolderChangeActions } from "./FolderChangeDialog";
import { FOLDER_PATH_MIME } from "./folder-change";
import { RailDropTarget } from "./RailDropTarget";
import { EditorRail } from "./EditorRail";
import { connectServerUrl } from "./connect-endpoint";
import type { CollectionFile, ConnectionSummary, NoteSummary } from "./model";
import type { ConnectionState, EditorSyncState } from "./app-state-types";
import { folderTree, type FolderTreeNode } from "./note";
import type { NoteFilter } from "./note-list-view";


export function CollectionRail({ collectionId, name, count, types, activeFilter, notes, files, foldersLoading, surface, connectionState, connectionIssue, directAccess, directAccessBusy, onFilter, onCreateFolder, onCreateNoteInFolder, onCreateSubfolder, onMoveNotes, onCopyFacet, onTypes, onSettings, onReconnect, onRequestDirectAccess, switcher, onCollapse, onPlanFolderChange, onChangeFolder }: {
  collectionId: string;
  name: string;
  count: number;
  types: CollectionTypeDescriptor[];
  activeFilter?: NoteFilter;
  notes: NoteSummary[];
  files: CollectionFile[];
  foldersLoading: boolean;
  surface: "notes" | "types" | "settings";
  connectionState: ShownConnectionState;
  connectionIssue?: string;
  directAccess?: ConnectionSummary["directAccess"];
  directAccessBusy: boolean;
  onFilter: (filter?: NoteFilter) => void;
  onCreateFolder?: () => void;
  onCreateNoteInFolder?: (folder: string) => void;
  onCreateSubfolder?: (parent: string) => void;
  onMoveNotes?: (paths: string[], folder: string) => void;
  onCopyFacet: (value: string, label: string) => void;
  onTypes: () => void;
  onSettings: () => void;
  onReconnect: () => void;
  onRequestDirectAccess: () => void;
  switcher?: ReactNode;
  onCollapse: () => void;
} & FolderChangeActions) {
  useLingui();
  const [folderChange, setFolderChange] = useState<{ from: string; parent?: string; mode: "rename" | "move" }>();
  const moveFolder = onPlanFolderChange && onChangeFolder ? (from: string, parent: string) => setFolderChange({ from, parent, mode: "move" }) : undefined;
  const collectionFolders = useMemo(() => folderTree(notes, files.map((file) => file.path)), [files, notes, i18n.locale]);
  return <><EditorRail
    collectionName={name}
    noteCount={count}
    typeCount={types.length}
    surface={surface}
    notes={{ onClick: () => onFilter(undefined) }}
    types={{ onClick: onTypes }}
    settings={{ onClick: onSettings }}
    switcher={switcher}
    onCollapse={onCollapse}
    onMoveNotes={onMoveNotes}
    onMoveFolder={moveFolder}
    notesSelected={surface === "notes" && !activeFilter}
    footer={<>
      {directAccess === "permission_required" && connectionState === "connected"
        ? <button className="local-access-action" disabled={directAccessBusy} onClick={onRequestDirectAccess}>{directAccessBusy ? t`Checking…` : t`Use this computer`}</button>
        : <ConnectionStatus state={connectionState} issue={connectionIssue} onReconnect={onReconnect} />}
    </>}
  >
      <FolderFilterSection
        collectionId={collectionId}
        items={collectionFolders}
        activeFilter={surface === "notes" ? activeFilter : undefined}
        loading={foldersLoading}
        onFilter={onFilter}
        onCreate={onCreateFolder}
        onCreateNote={onCreateNoteInFolder}
        onCreateSubfolder={onCreateSubfolder}
        onCopy={(path) => onCopyFacet(path, t`folder path`)}
        onRename={onPlanFolderChange && onChangeFolder ? (from) => setFolderChange({ from, mode: "rename" }) : undefined}
        onMove={moveFolder ? (from) => setFolderChange({ from, mode: "move" }) : undefined}
        onMoveFolder={moveFolder}
        onMoveNotes={onMoveNotes}
      />
  </EditorRail>{folderChange && <FolderChangeDialog
    key={`${collectionId}:${folderChange.from}:${folderChange.mode}`}
    {...folderChange}
    folders={allFolderPaths(collectionFolders)}
    onPlanFolderChange={onPlanFolderChange}
    onChangeFolder={onChangeFolder}
    onClose={(focusPath) => {
      setFolderChange(undefined);
      // A successful path change removes the old trigger. Restore to its new
      // row (or its visible ancestor) after the dialog's normal focus cleanup.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const rows = [...document.querySelectorAll<HTMLButtonElement>(".collection-rail [data-folder-path]")];
        let path = focusPath;
        while (path) {
          const target = rows.find((row) => row.dataset.folderPath === path);
          if (target) { target.focus(); return; }
          path = path.split("/").slice(0, -1).join("/");
        }
        document.querySelector<HTMLButtonElement>('.collection-rail button[aria-label^="All notes,"]')?.focus();
      }));
    }}
  />}</>;
}

function FolderFilterSection({ collectionId, items, activeFilter, loading, onFilter, onCreate, onCreateNote, onCreateSubfolder, onCopy, ...folderActions }: {
  collectionId: string;
  items: FolderTreeNode[];
  activeFilter?: NoteFilter;
  loading: boolean;
  onFilter: (filter: NoteFilter) => void;
  onCreate?: () => void;
  onCreateNote?: (folder: string) => void;
  onCreateSubfolder?: (parent: string) => void;
  onCopy: (path: string) => void;
} & FolderActions) {
  useLingui();
  const [expanded, setExpanded] = useState<Set<string>>(() => loadExpandedFolders(collectionId));

  useEffect(() => {
    setExpanded(loadExpandedFolders(collectionId));
  }, [collectionId]);
  useEffect(() => {
    localStorage.setItem(expandedFoldersKey(collectionId), JSON.stringify([...expanded]));
  }, [collectionId, expanded]);
  useEffect(() => {
    if (activeFilter?.kind !== "folder") return;
    setExpanded((current) => {
      const next = new Set(current);
      const parts = activeFilter.value.split("/");
      for (let index = 1; index <= parts.length; index += 1) {
        next.add(parts.slice(0, index).join("/"));
      }
      return setsEqual(current, next) ? current : next;
    });
  }, [activeFilter]);

  const toggle = (path: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });
  const setDescendants = (node: FolderTreeNode, shouldExpand: boolean) => setExpanded((current) => {
    const next = new Set(current);
    for (const path of expandableFolderPaths(node)) {
      if (shouldExpand) next.add(path);
      else next.delete(path);
    }
    return next;
  });

  return <div className="rail-filter-section" role="group" aria-label={t`Folders`} aria-busy={loading}>
    {loading && <span className="folder-loading" role="status"><Trans>Loading folders…</Trans></span>}
    <div className="rail-filter-items folder-tree">
      {items.length > 0 && <ul>
        {items.map((node) => <FolderTreeRow
          key={node.path}
          node={node}
          expanded={expanded}
          activeFilter={activeFilter}
          loading={loading}
          onFilter={onFilter}
          onToggle={toggle}
          onSetDescendants={setDescendants}
          onCreateNote={onCreateNote}
          onCreateSubfolder={onCreateSubfolder}
          onCopy={onCopy}
          {...folderActions}
        />)}
      </ul>}
      {!items.length && <p className="folder-placeholder">{loading ? t`Finding folders…` : t`No folders`}</p>}
    </div>
    {onCreate && <button className="rail-new-folder" onClick={onCreate}><span><FolderPlus aria-hidden="true" /><Trans>New folder</Trans></span></button>}
  </div>;
}

interface FolderActions {
  onRename?: (path: string) => void;
  onMove?: (path: string) => void;
  onMoveFolder?: (from: string, parent: string) => void;
  onMoveNotes?: (paths: string[], folder: string) => void;
}

function FolderTreeRow({ node, expanded, activeFilter, loading, onFilter, onToggle, onSetDescendants, onCreateNote, onCreateSubfolder, onCopy, ...folderActions }: {
  node: FolderTreeNode;
  expanded: Set<string>;
  activeFilter?: NoteFilter;
  loading: boolean;
  onFilter: (filter: NoteFilter) => void;
  onToggle: (path: string) => void;
  onSetDescendants: (node: FolderTreeNode, expanded: boolean) => void;
  onCreateNote?: (folder: string) => void;
  onCreateSubfolder?: (parent: string) => void;
  onCopy: (path: string) => void;
} & FolderActions) {
  useLingui();
  const hasChildren = node.children.length > 0;
  const isExpanded = expanded.has(node.path);
  const descendantPaths = expandableFolderPaths(node);
  const descendantsExpanded = descendantPaths.length > 0 && descendantPaths.every((path) => expanded.has(path));
  return <li>
    <RailDropTarget folder={node.path} onMoveNotes={folderActions.onMoveNotes} onMoveFolder={folderActions.onMoveFolder} onRename={folderActions.onRename ? () => folderActions.onRename?.(node.path) : undefined} onExpand={hasChildren && !isExpanded ? () => onToggle(node.path) : undefined}><ContextMenu
      className="rail-tree-row"
      label={t`${node.path} folder actions`}
      items={[
        { label: t`New note here`, disabled: !onCreateNote, icon: <FilePlus2 aria-hidden="true" />, onSelect: () => onCreateNote?.(node.path) },
        { label: t`New subfolder`, disabled: !onCreateSubfolder, icon: <FolderPlus aria-hidden="true" />, onSelect: () => onCreateSubfolder?.(node.path) },
        { label: t`Rename folder…`, disabled: !folderActions.onRename, icon: <Folder aria-hidden="true" />, onSelect: () => folderActions.onRename?.(node.path) },
        { label: t`Move to…`, disabled: !folderActions.onMove, icon: <Folder aria-hidden="true" />, onSelect: () => folderActions.onMove?.(node.path) },
        { label: t`Copy path`, icon: <Copy aria-hidden="true" />, onSelect: () => onCopy(node.path) },
        ...(hasChildren ? [{
          label: descendantsExpanded ? t`Collapse descendants` : t`Expand descendants`,
          icon: descendantsExpanded ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />,
          onSelect: () => onSetDescendants(node, !descendantsExpanded)
        }] : [])
      ]}
    >
      {hasChildren
        ? <button
          className="folder-disclosure"
          aria-label={isExpanded ? t`Collapse ${node.path}` : t`Expand ${node.path}`}
          aria-expanded={isExpanded}
          onClick={() => onToggle(node.path)}
        >{isExpanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}</button>
        : <span className="folder-disclosure-spacer" aria-hidden="true" />}
      <button
        className={`rail-row-action${activeFilter?.kind === "folder" && activeFilter.value === node.path ? " selected" : ""}`}
        aria-current={activeFilter?.kind === "folder" && activeFilter.value === node.path ? "page" : undefined}
        aria-label={facetCountLabel("folder", { name: node.path, count: node.count }, loading)}
        data-folder-path={node.path}
        draggable={Boolean(folderActions.onMoveFolder)}
        onDragStart={(event) => { event.dataTransfer.setData(FOLDER_PATH_MIME, node.path); event.dataTransfer.effectAllowed = "move"; }}
        onClick={() => onFilter({ kind: "folder", value: node.path })}
      >
        <span><Folder aria-hidden="true" /><span className="rail-row-label">{node.name}</span></span>
        <small aria-label={facetCountLabel("folder", { name: node.path, count: node.count }, loading)}>{node.count}{loading && "+"}</small>
      </button>
    </ContextMenu></RailDropTarget>
    {hasChildren && isExpanded && <ul>
      {node.children.map((child) => <FolderTreeRow
        key={child.path}
        node={child}
        expanded={expanded}
        activeFilter={activeFilter}
        loading={loading}
        onFilter={onFilter}
        onToggle={onToggle}
        onSetDescendants={onSetDescendants}
        onCreateNote={onCreateNote}
        onCreateSubfolder={onCreateSubfolder}
        onCopy={onCopy}
        {...folderActions}
      />)}
    </ul>}
  </li>;
}

function allFolderPaths(nodes: FolderTreeNode[]): string[] {
  return nodes.flatMap((node) => [node.path, ...allFolderPaths(node.children)]);
}

function expandedFoldersKey(collectionId: string): string {
  return `mdbase-editor:expanded-folders:${collectionId}`;
}

function loadExpandedFolders(collectionId: string): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(expandedFoldersKey(collectionId)) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function expandableFolderPaths(node: FolderTreeNode): string[] {
  return [
    ...(node.children.length > 0 ? [node.path] : []),
    ...node.children.flatMap(expandableFolderPaths)
  ];
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function facetCountLabel(kind: NoteFilter["kind"], item: { name: string; count: number }, loading: boolean): string {
  const count = item.count;
  const name = item.name;
  if (loading) {
    if (kind === "folder") return t`${count} or more notes in ${name}`;
    if (kind === "tag") return t`${count} or more notes tagged ${name}`;
    return t`${count} or more notes with type ${name}`;
  }
  if (kind === "folder") return plural(count, { one: `# note in ${name}`, other: `# notes in ${name}` });
  if (kind === "tag") return plural(count, { one: `# note tagged ${name}`, other: `# notes tagged ${name}` });
  return plural(count, { one: `# note with type ${name}`, other: `# notes with type ${name}` });
}


export function connectWorkspaceUrl(collectionId: string): string {
  const url = new URL("/", connectServerUrl());
  url.searchParams.set("collection", collectionId);
  return url.href;
}

/** The collection link state and its retry; the rail shows it always, the mobile note bar only when not connected. */
export function ConnectionStatus({ state, issue, onReconnect }: { state: ShownConnectionState; issue?: string | undefined; onReconnect: () => void }) {
  useLingui();
  const label = connectionLabels[state];
  const ariaLabel = {
    connected: t`Collection connected`,
    reconnecting: t`Collection reconnecting`,
    stopped: t`Collection stopped`,
    offline: t`Collection offline`,
    saved_on_device: t`Collection changes saved on this device; waiting for sync`
  }[state];
  return <>
    <p role="status" aria-label={ariaLabel} title={issue ?? label}><span className={`status-dot ${state === "connected" ? state : state === "stopped" ? "stopped" : "reconnecting"}`} aria-hidden="true" /><span>{label}</span></p>
    {(state === "reconnecting" || state === "stopped") && <button className="reconnect-action" aria-label={t`Retry connection`} onClick={onReconnect}><Trans>Retry</Trans></button>}
  </>;
}

/** The link state, or what the SDK says about syncing while the link is up. */
export type ShownConnectionState = ConnectionState | Exclude<EditorSyncState, "synced">;
const connectionLabels: Record<ShownConnectionState, string> = {
  get connected() { return t`Connected`; },
  get reconnecting() { return t`Reconnecting`; },
  get stopped() { return t`Sync stopped`; },
  get offline() { return t`Offline`; },
  get saved_on_device() { return t`Saved on this device; waiting for sync`; }
};
