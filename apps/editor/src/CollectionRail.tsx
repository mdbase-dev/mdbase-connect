import { useEffect, useMemo, useState } from "react";
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
import type { CollectionFile, ConnectionSummary, NoteSummary } from "./model";
import { folderTree, type FolderTreeNode } from "./note";
import type { NoteFilter } from "./NoteList";


export function CollectionRail({ collectionId, name, count, types, activeFilter, notes, files, foldersLoading, surface, connectionState, connectionIssue, directAccess, directAccessBusy, onFilter, onCreateFolder, onCreateNoteInFolder, onCreateSubfolder, onMoveNotes, onCopyFacet, onTypes, onSettings, onReconnect, onRequestDirectAccess, onSwitch, onCollapse, onPlanFolderChange, onChangeFolder }: {
  collectionId: string;
  name: string;
  count: number;
  types: CollectionTypeDescriptor[];
  activeFilter?: NoteFilter;
  notes: NoteSummary[];
  files: CollectionFile[];
  foldersLoading: boolean;
  surface: "notes" | "types" | "settings";
  connectionState: "connected" | "reconnecting";
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
  onSwitch: () => void;
  onCollapse: () => void;
} & FolderChangeActions) {
  const [folderChange, setFolderChange] = useState<{ from: string; parent?: string; mode: "rename" | "move" }>();
  const moveFolder = onPlanFolderChange && onChangeFolder ? (from: string, parent: string) => setFolderChange({ from, parent, mode: "move" }) : undefined;
  const collectionFolders = useMemo(() => folderTree(notes, files.map((file) => file.path)), [files, notes]);
  return <><EditorRail
    collectionName={name}
    noteCount={count}
    typeCount={types.length}
    surface={surface}
    notes={{ onClick: () => onFilter(undefined) }}
    types={{ onClick: onTypes }}
    settings={{ onClick: onSettings }}
    connectHref={connectWorkspaceUrl(collectionId)}
    onSwitch={onSwitch}
    onCollapse={onCollapse}
    onMoveNotes={onMoveNotes}
    onMoveFolder={moveFolder}
    notesSelected={surface === "notes" && !activeFilter}
    footer={<>
      {directAccess === "permission_required" && connectionState === "connected"
        ? <button className="local-access-action" disabled={directAccessBusy} onClick={onRequestDirectAccess}>{directAccessBusy ? "Checking…" : "Use this computer"}</button>
        : <p role="status" aria-label={`Collection ${connectionState}`} title={connectionIssue}><span className={`status-dot ${connectionState}`} aria-hidden="true" /><span>{connectionState === "connected" ? "Connected" : "Reconnecting"}</span></p>}
      {connectionState === "reconnecting" && <button className="reconnect-action" aria-label="Retry connection" onClick={onReconnect}>Retry</button>}
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
        onCopy={(path) => onCopyFacet(path, "folder path")}
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

  return <div className="rail-filter-section" role="group" aria-label="Folders" aria-busy={loading}>
    {loading && <span className="folder-loading" role="status">Loading folders…</span>}
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
      {!items.length && <p className="folder-placeholder">{loading ? "Finding folders…" : "No folders"}</p>}
    </div>
    {onCreate && <button className="rail-new-folder" onClick={onCreate}><span><FolderPlus aria-hidden="true" />New folder</span></button>}
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
  const hasChildren = node.children.length > 0;
  const isExpanded = expanded.has(node.path);
  const descendantPaths = expandableFolderPaths(node);
  const descendantsExpanded = descendantPaths.length > 0 && descendantPaths.every((path) => expanded.has(path));
  return <li>
    <RailDropTarget folder={node.path} onMoveNotes={folderActions.onMoveNotes} onMoveFolder={folderActions.onMoveFolder} onRename={folderActions.onRename ? () => folderActions.onRename?.(node.path) : undefined} onExpand={hasChildren && !isExpanded ? () => onToggle(node.path) : undefined}><ContextMenu
      className="rail-tree-row"
      label={`${node.path} folder actions`}
      items={[
        { label: "New note here", disabled: !onCreateNote, icon: <FilePlus2 aria-hidden="true" />, onSelect: () => onCreateNote?.(node.path) },
        { label: "New subfolder", disabled: !onCreateSubfolder, icon: <FolderPlus aria-hidden="true" />, onSelect: () => onCreateSubfolder?.(node.path) },
        { label: "Rename folder…", disabled: !folderActions.onRename, icon: <Folder aria-hidden="true" />, onSelect: () => folderActions.onRename?.(node.path) },
        { label: "Move to…", disabled: !folderActions.onMove, icon: <Folder aria-hidden="true" />, onSelect: () => folderActions.onMove?.(node.path) },
        { label: "Copy path", icon: <Copy aria-hidden="true" />, onSelect: () => onCopy(node.path) },
        ...(hasChildren ? [{
          label: descendantsExpanded ? "Collapse descendants" : "Expand descendants",
          icon: descendantsExpanded ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />,
          onSelect: () => onSetDescendants(node, !descendantsExpanded)
        }] : [])
      ]}
    >
      {hasChildren
        ? <button
          className="folder-disclosure"
          aria-label={`${isExpanded ? "Collapse" : "Expand"} ${node.path}`}
          aria-expanded={isExpanded}
          onClick={() => onToggle(node.path)}
        >{isExpanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}</button>
        : <span className="folder-disclosure-spacer" aria-hidden="true" />}
      <button
        className={`rail-row-action${activeFilter?.kind === "folder" && activeFilter.value === node.path ? " selected" : ""}`}
        aria-current={activeFilter?.kind === "folder" && activeFilter.value === node.path ? "page" : undefined}
        aria-label={`Show notes in ${node.path}, ${node.count}${loading ? " or more" : ""} ${node.count === 1 && !loading ? "note" : "notes"}`}
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
  const subject = kind === "folder" ? `in ${item.name}` : kind === "tag" ? `tagged ${item.name}` : `with type ${item.name}`;
  return `${item.count}${loading ? " or more" : ""} ${item.count === 1 && !loading ? "note" : "notes"} ${subject}`;
}


export function connectWorkspaceUrl(collectionId: string): string {
  const url = new URL("/connect", location.origin);
  const source = new URLSearchParams(location.search);
  const server = source.get("server");
  if (server) url.searchParams.set("server", server);
  url.searchParams.set("collection", collectionId);
  return `${url.pathname}${url.search}`;
}
