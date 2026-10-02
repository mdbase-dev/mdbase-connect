import { useCallback, useEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import { FilePlusIcon as FilePlus2, SidebarSimpleIcon as PanelLeft } from "./icons";
import { ContextMenu } from "./ContextMenu";
import type { ActionMenuItem } from "./ActionMenu";
import { NOTE_PATHS_MIME } from "./note-drag";
import { NoteSearchField, type SearchFacet } from "./NoteSearchField";
import type { CollectionFile } from "./model";
import { folder, noteExcerpt, noteTimestamp, noteTitle } from "./note";
import { noteSortSummary, moveListIndex, type NoteSort, type ListNavigationKey } from "./note-list-view";
import { NoteListViewOptions } from "./NoteListViewOptions";
import { searchTextRanges, type NoteSearchContext, type NoteSearchResult, type SearchTextRange } from "./note-search";
import { SearchMatchText } from "./SearchMatchText";
import { browserListItems, collectionFileFormat, collectionFileTitle, formatFileSize, type CollectionBrowserEntry } from "./collection-browser";

export type NoteFilter = { kind: "folder" | "tag" | "type"; value: string };

const listNavigationKeys: Record<string, true> = { ArrowDown: true, ArrowUp: true, Home: true, End: true, PageDown: true, PageUp: true };

export interface NoteRowStatus {
  label?: string;
  tone: "quiet" | "busy" | "error";
  busy: boolean;
  disabled?: boolean;
}

export function NoteList({ entries, noteCount, fileCount, types, selectedPath, selectedFilePath, pendingPath, pendingFilePath, statuses, search, searchQuery, searchContexts, sort, scopeLabel, collectionName, loading, structureLoading, structureError, filesLoading, fileError, contentIndexing, contentLoaded, contentError, total, contentTotal, leadingActions, trailingActions, onSearch, onSort, onClearScope, onQuickOpen, onRetryStructure, onRetryContent, onRetryFiles, onSelect, onSelectFile, filter, tags = [], filterTypes = [], onFilter, noteActions, onRename, onDelete, onCreate, onCollections }: {
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
  searchContexts: Map<string, NoteSearchResult>;
  sort: NoteSort;
  scopeLabel?: string;
  collectionName: string;
  loading: boolean;
  structureLoading: boolean;
  structureError?: string;
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
  onRetryStructure: () => void;
  onRetryContent: () => void;
  onRetryFiles: () => void;
  onSelect: (path: string, options?: { keyboard?: boolean }) => void;
  onSelectFile: (file: CollectionFile) => void;
  filter?: NoteFilter;
  tags?: SearchFacet[];
  filterTypes?: SearchFacet[];
  onFilter?: (filter?: NoteFilter) => void;
  noteActions?: (path: string) => ActionMenuItem[];
  onRename?: (path: string) => void;
  onDelete?: (path: string) => void;
  onCreate?: () => void;
  onCollections: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const revealedEntry = useRef<string | undefined>(undefined);
  const searching = Boolean(searchQuery.trim());
  const listItems = useMemo(() => browserListItems(entries, sort, types, undefined, searching), [entries, searching, sort, types]);
  const rowSecondLine = useCallback((entry: CollectionBrowserEntry): { kind: "excerpt" | NoteSearchContext["kind"]; text: string; ranges: SearchTextRange[] } | undefined => {
    if (entry.kind !== "note") return undefined;
    const context = searching ? searchContexts.get(entry.note.path)?.context : undefined;
    if (context && context.kind !== "title" && context.text) return context;
    const text = noteExcerpt(entry.note, types);
    return text ? { kind: "excerpt", text, ranges: searching ? searchTextRanges(text, searchQuery) : [] } : undefined;
  }, [searchContexts, searchQuery, searching, types]);
  const virtualizer = useVirtualizer({
    count: listItems.length,
    getScrollElement: () => scrollRef.current,
    // Rows keep one height whether or not an excerpt has loaded, so the list never reflows as bodies arrive.
    estimateSize: (index) => listItems[index].kind === "header" ? 34 : 76,
    overscan: 8,
    getItemKey: (index) => listItems[index].key
  });
  const selectedEntryIndex = useMemo(() => entries.findIndex((entry) => entry.kind === "note"
    ? entry.path === selectedPath && !selectedFilePath
    : entry.path === selectedFilePath), [entries, selectedFilePath, selectedPath]);
  const selectedItemId = useMemo(() => {
    if (selectedEntryIndex < 0) return undefined;
    const itemIndex = listItems.findIndex((item) => item.entryIndex === selectedEntryIndex);
    return itemIndex >= 0 ? `note-entry-${itemIndex}` : undefined;
  }, [listItems, selectedEntryIndex]);

  const openEntry = useCallback((entry: CollectionBrowserEntry, options?: { keyboard?: boolean }) => {
    if (entry.kind === "note") onSelect(entry.note.path, options);
    else onSelectFile(entry.file);
  }, [onSelect, onSelectFile]);

  useEffect(() => {
    const identity = selectedFilePath ? `file:${selectedFilePath}` : selectedPath ? `note:${selectedPath}` : undefined;
    if (!identity) { revealedEntry.current = undefined; return; }
    if (selectedEntryIndex < 0 || revealedEntry.current === identity) return;
    const itemIndex = listItems.findIndex((item) => item.entryIndex === selectedEntryIndex);
    if (itemIndex >= 0) {
      virtualizer.scrollToIndex?.(itemIndex, { align: "auto" });
      revealedEntry.current = identity;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEntryIndex, selectedFilePath, selectedPath]);

  const handleListKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    const selected = entries[selectedEntryIndex];
    if (selected?.kind === "note") {
      if (event.key === "F2") { event.preventDefault(); onRename?.(selected.path); return; }
      if ((event.metaKey || event.ctrlKey) && event.key === "Backspace") { event.preventDefault(); onDelete?.(selected.path); return; }
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        scrollRef.current?.querySelector(`#${selectedItemId}`)?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
        return;
      }
    }
    if (event.key === "Enter" || event.key === " ") {
      if (selectedEntryIndex >= 0 && selectedEntryIndex < entries.length) {
        event.preventDefault();
        openEntry(entries[selectedEntryIndex]);
      }
      return;
    }
    if (!(event.key in listNavigationKeys) || !entries.length) return;
    event.preventDefault();
    const next = moveListIndex(selectedEntryIndex, entries.length, event.key as ListNavigationKey);
    if (next < 0 || next === selectedEntryIndex) return;
    openEntry(entries[next], { keyboard: true });
  }, [entries, onDelete, onRename, openEntry, selectedEntryIndex, selectedItemId]);

  return <section className="note-list-pane" aria-label="Notes and files">
    <header className="list-header"><button className="mobile-collections icon-button" aria-label="Collections" onClick={onCollections}><PanelLeft aria-hidden="true" /></button>{leadingActions}<div><h1>{collectionName}</h1><p aria-live="polite">{browserCountLabel(noteCount, fileCount, entries.length, loading, structureLoading, filesLoading, contentIndexing, contentLoaded, total, contentTotal, Boolean(search.trim()), sort, Boolean(structureError || (search.trim() && contentError)))}{structureError && <button className="list-retry" title={structureError} onClick={onRetryStructure}>Retry notes</button>}{contentError && <button className="list-retry" title={contentError} onClick={onRetryContent}>Retry search</button>}{fileError && <button className="list-retry" title={fileError} onClick={onRetryFiles}>Retry files</button>}</p></div>{trailingActions}{onCreate && <button className="icon-button new-note" aria-label="New note" onClick={onCreate}><FilePlus2 aria-hidden="true" /><span className="mobile-label">New note</span></button>}</header>
    <div className="note-list-controls">
      <NoteSearchField search={search} filter={filter} tags={tags} types={filterTypes} onSearch={onSearch} onFilter={onFilter ?? onClearScope} onQuickOpen={onQuickOpen} />
      <NoteListViewOptions sort={sort} scopeLabel={filter ? undefined : scopeLabel} onSort={onSort} onClearScope={onClearScope} />
    </div>
    <div className="note-scroll" ref={scrollRef} role="listbox" aria-label="Collection notes and files" aria-busy={structureLoading || filesLoading} tabIndex={entries.length ? 0 : undefined} aria-activedescendant={selectedItemId} onKeyDown={handleListKeyDown}>
      {entries.length ? <div className="virtual-list" style={{ height: virtualizer.getTotalSize() }}>{virtualizer.getVirtualItems().map((virtualRow) => {
        const item = listItems[virtualRow.index];
        if (item.kind === "header") {
          return <div key={item.key} id={`note-entry-${virtualRow.index}`} className="note-group-header" style={{ transform: `translateY(${virtualRow.start}px)`, height: virtualRow.size }} aria-hidden="true"><span>{item.label}</span></div>;
        }
        const entry = item.entry!;
        if (entry.kind === "file") {
          const file = entry.file;
          const selected = file.path === selectedFilePath;
          const pending = file.path === pendingFilePath;
          const title = collectionFileTitle(file);
          return <button key={`file:${file.fileId}`} id={`note-entry-${virtualRow.index}`} tabIndex={-1} role="option" aria-label={`${title}, ${collectionFileFormat(file)} file`} aria-selected={selected} aria-busy={pending || undefined} className={`note-row file-row${selected ? " selected" : ""}${pending ? " busy" : ""}`} onClick={() => onSelectFile(file)} style={{ transform: `translateY(${virtualRow.start}px)`, height: virtualRow.size }}><span className="note-title-line"><span className={`file-kind-icon ${file.mediaClass}`} aria-hidden="true" /><span className="note-title"><SearchMatchText text={title} ranges={searchQuery ? searchTextRanges(title, searchQuery) : []} /></span><span className="file-format">{collectionFileFormat(file)}</span></span>{pending ? <span className="note-transition">Opening</span> : <span className="note-detail"><time>{fileTimestamp(file)}</time><span>{formatFileSize(file.size)}</span><span className="file-folder">{fileFolder(file)}</span></span>}</button>;
        }
        const note = entry.note;
        const status: NoteRowStatus | undefined = pendingPath === note.path ? { label: "Opening", tone: "busy", busy: true } : statuses.get(note.path);
        const secondLine = rowSecondLine(entry);
        const title = noteTitle(note, types);
        const noteFolder = folder(note.path);
        return <ContextMenu key={note.path} className="note-row-context" showTrigger={false} label={`${title} note actions`} items={noteActions?.(note.path) ?? []} style={{ transform: `translateY(${virtualRow.start}px)`, height: virtualRow.size }}><button id={`note-entry-${virtualRow.index}`} tabIndex={-1} role="option" aria-selected={note.path === selectedPath} aria-busy={status?.busy || undefined} aria-disabled={status?.disabled || undefined} aria-describedby={secondLine?.kind === "excerpt" ? `note-excerpt-${virtualRow.index}` : undefined} className={`note-row${note.path === selectedPath ? " selected" : ""}${status ? ` ${status.tone}` : ""}`} draggable={!status?.disabled} onDragStart={(event) => { event.dataTransfer.setData(NOTE_PATHS_MIME, JSON.stringify([note.path])); event.dataTransfer.effectAllowed = "move"; }} onClick={() => { if (!status?.disabled) onSelect(note.path); }}>
          <span className="note-title-line"><span className="note-title"><SearchMatchText text={title} ranges={searchQuery ? searchTextRanges(title, searchQuery) : []} /></span>{note.types.length > 0 && <span className="note-type-badge" title={`Type: ${note.types.join(", ")}`}>{note.types.join(" · ")}</span>}</span>
          {secondLine && <span id={secondLine.kind === "excerpt" ? `note-excerpt-${virtualRow.index}` : undefined} aria-hidden={secondLine.kind === "excerpt" || undefined} className={`note-excerpt${secondLine.kind === "excerpt" ? "" : ` note-search-context ${secondLine.kind}`}`}><SearchMatchText text={secondLine.text} ranges={secondLine.ranges} /></span>}
          {status?.label ? <span className="note-transition">{status.label}</span> : <span className="note-detail"><time>{noteTimestamp(note)}</time>{noteFolder && <span className="note-folder">{noteFolder}</span>}</span>}
        </button></ContextMenu>;
      })}</div> : structureLoading || filesLoading ? <div className="list-loading" role="status">Reading notes and files…</div> : <div className="list-empty"><p>{structureError ? "Notes could not finish loading." : search && contentError ? "Search is incomplete." : search ? "No notes or files found." : "This collection is empty."}</p>{!search && !structureError && onCreate && <button onClick={onCreate}>Create the first note</button>}</div>}
    </div>
  </section>;
}


function browserCountLabel(noteCount: number, fileCount: number, resultCount: number, loading: boolean, structureLoading: boolean, filesLoading: boolean, contentIndexing: boolean, contentLoaded: number, total: number | undefined, contentTotal: number | undefined, searching: boolean, sort: NoteSort, incomplete: boolean): string {
  if (incomplete) return searching ? `${resultCount.toLocaleString()} found so far · incomplete` : `${noteCount.toLocaleString()} notes loaded · incomplete`;
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
  if (!filter) return fallback || "All notes";
  return filter.kind === "tag" ? `#${filter.value}` : filter.value;
}

export function filterScopeLabel(filter: NoteFilter | undefined): string | undefined {
  if (!filter) return undefined;
  if (filter.kind === "folder") return `Folder · ${filter.value}`;
  if (filter.kind === "tag") return `Tag · #${filter.value}`;
  return `Type · ${filter.value}`;
}
