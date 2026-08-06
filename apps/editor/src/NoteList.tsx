import { useMemo, useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import { FilePlusIcon as FilePlus2, MagnifyingGlassIcon as Search, SidebarSimpleIcon as PanelLeft, XIcon as X } from "./icons";
import type { CollectionFile } from "./model";
import { notePreview, noteTimestamp, noteTitle } from "./note";
import { noteSortSummary, type NoteSort } from "./note-list-view";
import { NoteListViewOptions } from "./NoteListViewOptions";
import { notePreviewPopoverId, type NotePreviewAnchor, type NotePreviewSource } from "./NotePreview";
import { isPhosphorIconName, PhosphorIcon, collectionTypeIcon } from "./PhosphorIcon";
import { searchTextRanges, type NoteSearchContext } from "./note-search";
import { SearchMatchText } from "./SearchMatchText";
import { collectionFileFormat, collectionFileTitle, formatFileSize, type CollectionBrowserEntry } from "./collection-browser";

export type NoteFilter = { kind: "folder" | "tag" | "type"; value: string };

export interface NoteRowStatus {
  label: string;
  tone: "quiet" | "busy" | "error";
  busy: boolean;
  disabled?: boolean;
}

export function NoteList({ entries, noteCount, fileCount, types, selectedPath, selectedFilePath, pendingPath, pendingFilePath, statuses, search, searchQuery, searchContexts, sort, scopeLabel, collectionName, loading, structureLoading, filesLoading, fileError, contentIndexing, contentLoaded, contentError, total, contentTotal, leadingActions, trailingActions, onSearch, onSort, onClearScope, onQuickOpen, onRetryContent, onRetryFiles, onSelect, onSelectFile, previewPath, onPreview, onDismissPreview, onCreate, onCollections }: {
  entries: CollectionBrowserEntry[];
  noteCount: number;
  fileCount: number;
  types: CollectionTypeDescriptor[];
  selectedPath?: string;
  selectedFilePath?: string;
  pendingPath?: string;
  pendingFilePath?: string;
  statuses: Map<string, NoteRowStatus>;
  search: string;
  searchQuery: string;
  searchContexts: Map<string, NoteSearchContext>;
  sort: NoteSort;
  scopeLabel?: string;
  collectionName: string;
  loading: boolean;
  structureLoading: boolean;
  filesLoading: boolean;
  fileError?: string;
  contentIndexing: boolean;
  contentLoaded: number;
  contentError?: string;
  total?: number;
  contentTotal?: number;
  leadingActions?: ReactNode;
  trailingActions?: ReactNode;
  onSearch: (value: string) => void;
  onSort: (sort: NoteSort) => void;
  onClearScope: () => void;
  onQuickOpen: () => void;
  onRetryContent: () => void;
  onRetryFiles: () => void;
  onSelect: (path: string) => void;
  onSelectFile: (file: CollectionFile) => void;
  previewPath?: string;
  onPreview: (path: string, anchor: NotePreviewAnchor, source: NotePreviewSource) => void;
  onDismissPreview: () => void;
  onCreate: () => void;
  onCollections: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({ count: entries.length, getScrollElement: () => scrollRef.current, estimateSize: () => 76, overscan: 8 });
  const typeIcons = useMemo(() => new Map(types.map((type) => [type.name, collectionTypeIcon(type)])), [types]);
  return <section className="note-list-pane" aria-label="Notes and files">
    <header className="list-header"><button className="mobile-collections icon-button" aria-label="Collections" onClick={onCollections}><PanelLeft aria-hidden="true" /></button>{leadingActions}<div><h1>{collectionName}</h1><p aria-live="polite">{browserCountLabel(noteCount, fileCount, entries.length, loading, structureLoading, filesLoading, contentIndexing, contentLoaded, total, contentTotal, Boolean(search.trim()), sort)}{contentError && <button className="list-retry" title={contentError} onClick={onRetryContent}>Retry search</button>}{fileError && <button className="list-retry" title={fileError} onClick={onRetryFiles}>Retry files</button>}</p></div>{trailingActions}<button className="icon-button new-note" aria-label="New note" onClick={onCreate}><FilePlus2 aria-hidden="true" /></button></header>
    <div className="note-list-controls">
      <div className="search-field"><Search aria-hidden="true" /><label className="sr-only" htmlFor="note-search">Search notes and files</label><input id="note-search" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search" />{search ? <button aria-label="Clear search" onClick={() => onSearch("")}><X aria-hidden="true" /></button> : <button className="quick-open-trigger" aria-label="Quick open" title="Quick open" onClick={onQuickOpen}><kbd>{navigator.platform.includes("Mac") ? "⌘" : "Ctrl"} P</kbd></button>}</div>
      <NoteListViewOptions sort={sort} scopeLabel={scopeLabel} onSort={onSort} onClearScope={onClearScope} />
    </div>
    <div className="note-scroll" ref={scrollRef} role="listbox" aria-label="Collection notes and files" aria-busy={structureLoading || filesLoading}>
      {entries.length ? <div className="virtual-list" style={{ height: virtualizer.getTotalSize() }}>{virtualizer.getVirtualItems().map((virtualRow) => {
        const entry = entries[virtualRow.index];
        if (entry.kind === "file") {
          const file = entry.file;
          const selected = file.path === selectedFilePath;
          const pending = file.path === pendingFilePath;
          const title = collectionFileTitle(file);
          return <button key={`file:${file.fileId}`} role="option" aria-label={`${title}, ${collectionFileFormat(file)} file`} aria-selected={selected} aria-busy={pending || undefined} className={`note-row file-row${selected ? " selected" : ""}${pending ? " busy" : ""}`} onClick={() => onSelectFile(file)} style={{ transform: `translateY(${virtualRow.start}px)`, height: virtualRow.size }}><span className="note-title-line"><span className={`file-kind-icon ${file.mediaClass}`} aria-hidden="true" /><span className="note-title"><SearchMatchText text={title} ranges={searchQuery ? searchTextRanges(title, searchQuery) : []} /></span><span className="file-format">{collectionFileFormat(file)}</span></span>{pending ? <span className="note-transition">Opening</span> : <span className="note-detail"><time>{fileTimestamp(file)}</time><span>{formatFileSize(file.size)}</span><span className="file-folder">{fileFolder(file)}</span></span>}</button>;
        }
        const note = entry.note;
        const status: NoteRowStatus | undefined = pendingPath === note.path ? { label: "Opening", tone: "busy", busy: true } : statuses.get(note.path);
        const searchContext = searchQuery.trim() ? searchContexts.get(note.path) : undefined;
        const title = noteTitle(note, types);
        const typeIcon = note.types.map((type) => typeIcons.get(type)).find(isPhosphorIconName);
        const requestPreview = (target: HTMLButtonElement) => {
          const { left, right, top, bottom } = target.getBoundingClientRect();
          onPreview(note.path, { left, right, top, bottom }, "sidebar");
        };
        return <button key={note.path} role="option" aria-selected={note.path === selectedPath} aria-busy={status?.busy || undefined} aria-disabled={status?.disabled || undefined} aria-describedby={previewPath === note.path ? notePreviewPopoverId() : undefined} className={`note-row${note.path === selectedPath ? " selected" : ""}${status ? ` ${status.tone}` : ""}`} onMouseEnter={(event) => requestPreview(event.currentTarget)} onMouseLeave={onDismissPreview} onFocus={(event) => requestPreview(event.currentTarget)} onBlur={onDismissPreview} onClick={() => { onDismissPreview(); if (!status?.disabled) onSelect(note.path); }} style={{ transform: `translateY(${virtualRow.start}px)`, height: virtualRow.size }}><span className="note-title-line">{typeIcon && <PhosphorIcon name={typeIcon} aria-hidden="true" />}<span className="note-title"><SearchMatchText text={title} ranges={searchQuery ? searchTextRanges(title, searchQuery) : []} /></span></span>{status ? <span className="note-transition">{status.label}</span> : searchContext ? <span className={`note-detail note-search-context ${searchContext.kind}`}><SearchMatchText text={searchContext.text} ranges={searchContext.ranges} /></span> : <span className="note-detail"><time>{noteTimestamp(note)}</time>{notePreview(note, types)}</span>}</button>;
      })}</div> : structureLoading || filesLoading ? <NoteListSkeleton /> : <div className="list-empty"><p>{search ? "No notes or files found." : "This collection is empty."}</p>{!search && <button onClick={onCreate}>Create the first note</button>}</div>}
    </div>
  </section>;
}

function NoteListSkeleton() {
  return <div className="note-list-skeleton" aria-hidden="true">{Array.from({ length: 8 }, (_, index) => <div key={index}><span /><small /></div>)}</div>;
}

function browserCountLabel(noteCount: number, fileCount: number, resultCount: number, loading: boolean, structureLoading: boolean, filesLoading: boolean, contentIndexing: boolean, contentLoaded: number, total: number | undefined, contentTotal: number | undefined, searching: boolean, sort: NoteSort): string {
  if (searching && contentIndexing) return `${resultCount.toLocaleString()} found so far · searching ${contentLoaded.toLocaleString()} of ${contentTotal?.toLocaleString() ?? "…"}`;
  if ((loading || filesLoading) && searching) return resultCount ? `${resultCount.toLocaleString()} found so far` : "Searching";
  if ((structureLoading || filesLoading) && noteCount === 0 && fileCount === 0) return "Reading notes and files";
  if (structureLoading) return `${noteCount.toLocaleString()} of ${total?.toLocaleString() ?? "…"} notes${fileCount ? ` · ${fileCount.toLocaleString()} ${fileCount === 1 ? "file" : "files"}` : ""}`;
  if (searching) return `${resultCount.toLocaleString()} found · relevance`;
  return `${noteCount.toLocaleString()} ${noteCount === 1 ? "note" : "notes"} · ${fileCount.toLocaleString()} ${fileCount === 1 ? "file" : "files"} · ${noteSortSummary(sort)}`;
}

function fileTimestamp(file: CollectionFile): string {
  const date = new Date(file.modifiedAt);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  if (date.getFullYear() === now.getFullYear()) return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(date);
}

function fileFolder(file: CollectionFile): string {
  return file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "Collection root";
}

export function filterLabel(filter: NoteFilter | undefined, fallback: string): string {
  if (!filter) return fallback;
  return filter.kind === "tag" ? `#${filter.value}` : filter.value;
}

export function filterScopeLabel(filter: NoteFilter | undefined): string | undefined {
  if (!filter) return undefined;
  if (filter.kind === "folder") return `Folder · ${filter.value}`;
  if (filter.kind === "tag") return `Tag · #${filter.value}`;
  return `Type · ${filter.value}`;
}
