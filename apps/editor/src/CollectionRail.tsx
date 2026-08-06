import { useEffect, useMemo, useState } from "react";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import {
  BracketsCurlyIcon as Braces,
  CaretDownIcon as ChevronDown,
  CaretRightIcon as ChevronRight,
  CopyIcon as Copy,
  FilePlusIcon as FilePlus2,
  FolderIcon as Folder,
  FolderPlusIcon as FolderPlus,
  KeyboardIcon as Keyboard,
  NotebookIcon as NotebookPen,
  TagIcon as Tag
} from "./icons";
import { ContextMenu } from "./ContextMenu";
import { EditorRail } from "./EditorRail";
import type { CollectionFile, ConnectionSummary, NoteSummary } from "./model";
import { folderTree, tags as collectionTags, types as collectionTypes, type FolderTreeNode } from "./note";
import type { NoteFilter } from "./NoteList";
import { collectionTypeIcon, isPhosphorIconName, PhosphorIcon } from "./PhosphorIcon";


export function CollectionRail({ collectionId, name, count, types, activeFilter, notes, files, foldersLoading, surface, connectionState, connectionIssue, directAccess, directAccessBusy, onFilter, onCreateFolder, onCreateNoteInFolder, onCreateSubfolder, onCreateNoteWithTag, onCreateNoteWithType, onOpenType, onCopyFacet, onTypes, onSettings, onShortcuts, onReconnect, onRequestDirectAccess, onSwitch, onCollapse }: {
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
  onCreateFolder: () => void;
  onCreateNoteInFolder: (folder: string) => void;
  onCreateSubfolder: (parent: string) => void;
  onCreateNoteWithTag: (tag: string) => void;
  onCreateNoteWithType: (type: string) => void;
  onOpenType: (type: string) => void;
  onCopyFacet: (value: string, label: string) => void;
  onTypes: () => void;
  onSettings: () => void;
  onShortcuts: () => void;
  onReconnect: () => void;
  onRequestDirectAccess: () => void;
  onSwitch: () => void;
  onCollapse: () => void;
}) {
  const typeKey = types.map((type) => `${type.name}:${collectionTypeIcon(type) ?? ""}`).join("\u0000");
  const collectionFolders = useMemo(() => folderTree(notes, files.map((file) => file.path)), [files, notes]);
  const tagFacets = useMemo(() => collectionTags(notes), [notes]);
  const typeFacets = useMemo(() => {
    const icons = new Map(types.map((type) => [type.name, collectionTypeIcon(type)]));
    return collectionTypes(notes, types.map((type) => type.name))
      .map((item) => ({ ...item, icon: icons.get(item.name) }));
  }, [notes, typeKey]);
  return <EditorRail
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
    footer={<>
      {directAccess === "permission_required" && connectionState === "connected"
        ? <button className="local-access-action" disabled={directAccessBusy} onClick={onRequestDirectAccess}>{directAccessBusy ? "Checking…" : "Use this computer"}</button>
        : <p role="status" aria-label={`Collection ${connectionState}`} title={connectionIssue}><span className={`status-dot ${connectionState}`} aria-hidden="true" /><span>{connectionState === "connected" ? "Connected" : "Reconnecting"}</span></p>}
      {connectionState === "reconnecting" && <button className="reconnect-action" aria-label="Retry connection" onClick={onReconnect}>Retry</button>}
      <button className="shortcut-action" aria-label="Keyboard shortcuts" title="Keyboard shortcuts" onClick={onShortcuts}><Keyboard aria-hidden="true" /><span>Shortcuts</span></button>
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
      />
      <RailFilterSection
        label="Tags"
        kind="tag"
        items={tagFacets}
        activeFilter={surface === "notes" ? activeFilter : undefined}
        loading={foldersLoading}
        onFilter={onFilter}
        onCreateNote={onCreateNoteWithTag}
        onCopy={(tag) => onCopyFacet(tag, "tag")}
      />
      <RailFilterSection
        label="Types"
        kind="type"
        items={typeFacets}
        activeFilter={surface === "notes" ? activeFilter : undefined}
        loading={foldersLoading}
        onFilter={onFilter}
        onCreateNote={onCreateNoteWithType}
        onOpenType={onOpenType}
        onCopy={(type) => onCopyFacet(type, "type name")}
      />
  </EditorRail>;
}

function FolderFilterSection({ collectionId, items, activeFilter, loading, onFilter, onCreate, onCreateNote, onCreateSubfolder, onCopy }: {
  collectionId: string;
  items: FolderTreeNode[];
  activeFilter?: NoteFilter;
  loading: boolean;
  onFilter: (filter: NoteFilter) => void;
  onCreate: () => void;
  onCreateNote: (folder: string) => void;
  onCreateSubfolder: (parent: string) => void;
  onCopy: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(() => loadExpandedFolders(collectionId));
  const listId = "rail-folder-filters";

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
    <RailSectionHeader
      label="Folders"
      open={open}
      listId={listId}
      loading={loading}
      onToggle={() => setOpen((value) => !value)}
      onCreate={onCreate}
    />
    {open && <div id={listId} className="rail-filter-items folder-tree">
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
        />)}
      </ul>}
      {!items.length && <p className="folder-placeholder">{loading ? "Finding folders…" : "No folders"}</p>}
    </div>}
  </div>;
}

function FolderTreeRow({ node, expanded, activeFilter, loading, onFilter, onToggle, onSetDescendants, onCreateNote, onCreateSubfolder, onCopy }: {
  node: FolderTreeNode;
  expanded: Set<string>;
  activeFilter?: NoteFilter;
  loading: boolean;
  onFilter: (filter: NoteFilter) => void;
  onToggle: (path: string) => void;
  onSetDescendants: (node: FolderTreeNode, expanded: boolean) => void;
  onCreateNote: (folder: string) => void;
  onCreateSubfolder: (parent: string) => void;
  onCopy: (path: string) => void;
}) {
  const hasChildren = node.children.length > 0;
  const isExpanded = expanded.has(node.path);
  const descendantPaths = expandableFolderPaths(node);
  const descendantsExpanded = descendantPaths.length > 0 && descendantPaths.every((path) => expanded.has(path));
  return <li>
    <ContextMenu
      className="rail-tree-row"
      label={`${node.path} folder actions`}
      items={[
        { label: "New note here", icon: <FilePlus2 aria-hidden="true" />, onSelect: () => onCreateNote(node.path) },
        { label: "New subfolder", icon: <FolderPlus aria-hidden="true" />, onSelect: () => onCreateSubfolder(node.path) },
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
        aria-label={`Show notes in ${node.path}, ${node.count}${loading ? " or more" : ""} ${node.count === 1 && !loading ? "note" : "notes"}`}
        onClick={() => onFilter({ kind: "folder", value: node.path })}
      >
        <span><Folder aria-hidden="true" />{node.name}</span>
        <small aria-label={facetCountLabel("folder", { name: node.path, count: node.count }, loading)}>{node.count}{loading && "+"}</small>
      </button>
    </ContextMenu>
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
      />)}
    </ul>}
  </li>;
}

function RailFilterSection({ label, kind, items, activeFilter, loading, onFilter, onCreateNote, onOpenType, onCopy }: {
  label: string;
  kind: "tag" | "type";
  items: Array<{ name: string; count: number; icon?: string }>;
  activeFilter?: NoteFilter;
  loading: boolean;
  onFilter: (filter: NoteFilter) => void;
  onCreateNote: (value: string) => void;
  onOpenType?: (type: string) => void;
  onCopy: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const Icon = kind === "tag" ? Tag : Braces;
  const listId = `rail-${kind}-filters`;
  return <div className="rail-filter-section" role="group" aria-label={label} aria-busy={loading}>
    <RailSectionHeader label={label} open={open} listId={listId} loading={loading} onToggle={() => setOpen((value) => !value)} />
    {open && <div id={listId} className="rail-filter-items">
      {items.map((item) => <ContextMenu
        key={item.name}
        className="rail-facet-row"
        label={`${kind === "tag" ? `#${item.name}` : item.name} ${kind} actions`}
        items={[
          { label: "Show notes", icon: <NotebookPen aria-hidden="true" />, onSelect: () => onFilter({ kind, value: item.name }) },
          ...(kind === "type" && onOpenType ? [{
            label: "Open definition",
            icon: <Braces aria-hidden="true" />,
            onSelect: () => onOpenType(item.name)
          }] : []),
          {
            label: kind === "tag" ? "New note with tag" : "New note of type",
            icon: <FilePlus2 aria-hidden="true" />,
            onSelect: () => onCreateNote(item.name)
          },
          {
            label: kind === "tag" ? "Copy tag" : "Copy type name",
            icon: <Copy aria-hidden="true" />,
            onSelect: () => onCopy(item.name)
          }
        ]}
      >
        <button
          className={`rail-row-action${activeFilter?.kind === kind && activeFilter.value === item.name ? " selected" : ""}`}
          aria-label={`${kind === "tag" ? `Show notes tagged #${item.name}` : `Show notes with type ${item.name}`}, ${item.count}${loading ? " or more" : ""} ${item.count === 1 && !loading ? "note" : "notes"}`}
          onClick={() => onFilter({ kind, value: item.name })}
        >
          <span>{kind === "type" && isPhosphorIconName(item.icon)
            ? <PhosphorIcon name={item.icon} aria-hidden="true" />
            : <Icon aria-hidden="true" />}{kind === "tag" ? `#${item.name}` : item.name}</span>
          <small aria-label={facetCountLabel(kind, item, loading)}>{item.count}{loading && "+"}</small>
        </button>
      </ContextMenu>)}
      {!items.length && <p className="folder-placeholder">{loading ? `Finding ${label.toLocaleLowerCase()}…` : `No ${label.toLocaleLowerCase()}`}</p>}
    </div>}
  </div>;
}

function RailSectionHeader({ label, open, listId, loading, onToggle, onCreate }: {
  label: string;
  open: boolean;
  listId: string;
  loading: boolean;
  onToggle: () => void;
  onCreate?: () => void;
}) {
  return <div className="rail-section-header">
    <button className="rail-section-toggle" aria-expanded={open} aria-controls={listId} onClick={onToggle}>
      <span>{open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}{label}</span>
      {loading && <span className="folder-loading" role="status"><i aria-hidden="true" />Loading</span>}
    </button>
    {onCreate && <button className="rail-section-create" aria-label="New folder" title="New folder" onClick={onCreate}><FolderPlus aria-hidden="true" /></button>}
  </div>;
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


function connectWorkspaceUrl(collectionId: string): string {
  const url = new URL("/connect", location.origin);
  const source = new URLSearchParams(location.search);
  const server = source.get("server");
  if (server) url.searchParams.set("server", server);
  url.searchParams.set("collection", collectionId);
  return `${url.pathname}${url.search}`;
}
