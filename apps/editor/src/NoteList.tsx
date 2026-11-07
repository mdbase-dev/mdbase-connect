import { i18n } from "@lingui/core";
import { displayLocale } from "./i18n/format";
import { Trans } from "@lingui/react/macro";
import { t, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useOverlay } from "@mdbase-dev/ui/overlay";
import { Tooltip } from "@mdbase-dev/ui/tooltip";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import { FilePlusIcon as FilePlus2, SidebarSimpleIcon as PanelLeft } from "./icons";
import { ContextMenu, type ActionMenuItem } from "./ContextMenu";
import { NoteSearchField } from "./NoteSearchField";
import type { CollectionFile } from "./model";
import { folder, noteExcerpt, noteTimestamp, noteTitle } from "./note";
import { NOTE_PATHS_MIME, moveListIndex, selectNote, type NoteFilter, type NoteRowStatus, type SearchFacet, type NoteSelection, type ListNavigationKey } from "./note-list-view";
import { noteSortSummary, type NoteSort, type NoteSortPreference, type SortField } from "./note-sort";
import { NoteListViewOptions } from "./NoteListViewOptions";
import { searchTextRanges, type NoteSearchContext, type NoteSearchResult, type SearchTextRange } from "./note-search";
import { SearchMatchText } from "./SearchMatchText";
import { browserListItems, collectionFileFormat, collectionFileTitle, formatFileSize, type CollectionBrowserEntry } from "./collection-browser";

const listNavigationKeys: Record<string, true> = { ArrowDown: true, ArrowUp: true, Home: true, End: true, PageDown: true, PageUp: true };

import { matchesCommandShortcut } from "./editor-commands";

export function NoteList({ entries, selection, onSelection, selectionBar, pinnedPaths = [], noteCount, fileCount, types, selectedPath, selectedFilePath, pendingPath, pendingFilePath, statuses, arrivingPath, search, searchQuery, searchContexts, sort, sortFields, scopeLabel, collectionName, loading, structureLoading, structureError, filesLoading, fileError, contentIndexing, contentLoaded, contentError, total, contentTotal, leadingActions, trailingActions, onSearch, onSort, onClearScope, onQuickOpen, onRetryStructure, onRetryContent, onRetryFiles, onSelect, onSelectFile, filter, tags = [], filterTypes = [], onFilter, noteActions, onRename, onDelete, onPeek, peek, peekTitle, onClosePeek, onCreate, onCollections }: {
  entries: CollectionBrowserEntry[];
  selection?: NoteSelection;
  onSelection?: (selection: NoteSelection) => void;
  selectionBar?: ReactNode;
  pinnedPaths?: string[];
  noteCount: number;
  fileCount: number;
  types: CollectionTypeDescriptor[];
  selectedPath?: string;
  selectedFilePath?: string;
  pendingPath?: string;
  pendingFilePath?: string;
  statuses: Map<string, NoteRowStatus>;
  arrivingPath?: string;
  search: string;
  searchQuery: string;
  searchContexts: Map<string, NoteSearchResult>;
  sort: NoteSort;
  sortFields: SortField[];
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
  onSort: (sort: NoteSortPreference) => void;
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
  onPeek?: (path: string) => void;
  peek?: ReactNode;
  peekTitle?: string;
  onClosePeek?: () => void;
  onCreate?: () => void;
  onCollections: () => void;
}) {
  useLingui();
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (document.activeElement === document.body) scrollRef.current?.focus({ preventScroll: true });
  }, []);
  const { ref: peekRef, present: peekPresent } = useOverlay<HTMLElement>(Boolean(peek));
  const peekContent = useRef({ body: peek, title: peekTitle });
  if (peek) peekContent.current = { body: peek, title: peekTitle };
  const revealedEntry = useRef<string | undefined>(undefined);
  const searching = Boolean(searchQuery.trim());
  const pins = useMemo(() => new Set(!searching && !filter ? pinnedPaths : []), [filter, pinnedPaths, searching, i18n.locale]);
  const listItems = useMemo(() => browserListItems(entries, sort, types, undefined, searching, pins), [entries, searching, sort, types, pins, i18n.locale]);
  const currentSelection = selection ?? { paths: selectedPath ? [selectedPath] : [], anchor: selectedPath, focus: selectedPath };
  const selectedPaths = new Set(currentSelection.paths);
  const focusedPath = currentSelection.focus ?? selectedPath;
  const selectablePaths = entries.filter((entry) => entry.kind === "note" && !statuses.get(entry.path)?.disabled).map((entry) => entry.path);
  const chooseNote = (path: string, mode: "single" | "toggle" | "range", keyboard = false) => {
    const next = selectNote(currentSelection, path, selectablePaths, mode);
    onSelection?.(next);
    if (mode === "single" || !currentSelection.anchor || !selectablePaths.includes(currentSelection.anchor)) onSelect(next.anchor!, { keyboard });
    if (mode !== "single" || keyboard) scrollRef.current?.focus({ preventScroll: true });
  };
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
    scrollPaddingEnd: 1,
    // Rows keep one height whether or not an excerpt has loaded, so the list never reflows as bodies arrive.
    estimateSize: (index) => listItems[index].kind === "header" ? 34 : 76,
    overscan: 8,
    getItemKey: (index) => listItems[index].key
  });
  const selectedEntryIndex = useMemo(() => entries.findIndex((entry) => entry.kind === "note"
    ? entry.path === focusedPath && !selectedFilePath
    : entry.path === selectedFilePath), [entries, selectedFilePath, focusedPath, i18n.locale]);
  const selectedItemId = useMemo(() => {
    if (selectedEntryIndex < 0) return undefined;
    const itemIndex = listItems.findIndex((item) => item.entryIndex === selectedEntryIndex);
    return itemIndex >= 0 ? `note-entry-${itemIndex}` : undefined;
  }, [listItems, selectedEntryIndex, i18n.locale]);

  useLayoutEffect(() => {
    const card = peekRef.current;
    const list = scrollRef.current;
    if (!peekPresent || !card || !list) return;
    const position = () => {
      const anchor = list.querySelector(`#${selectedItemId}`)?.getBoundingClientRect() ?? list.getBoundingClientRect();
      const width = Math.min(480, window.innerWidth - 24);
      const left = anchor.right + 8 + width <= window.innerWidth ? anchor.right + 8 : Math.max(12, window.innerWidth - width - 12);
      card.style.left = `${left}px`;
      card.style.top = `${Math.max(12, Math.min(anchor.top, window.innerHeight - card.offsetHeight - 12))}px`;
    };
    card.showPopover();
    position();
    const close = (event: Event) => {
      if (event instanceof globalThis.KeyboardEvent && event.key !== "Escape") return;
      if ((event.type === "pointerdown" || event.type === "focusin") && event.target instanceof Node && (card.contains(event.target) || list.contains(event.target))) return;
      if (event.type === "keydown") { event.preventDefault(); event.stopPropagation(); }
      if (card.contains(document.activeElement)) list.focus();
      onClosePeek?.();
    };
    window.addEventListener("resize", position);
    list.addEventListener("scroll", position);
    document.addEventListener("pointerdown", close);
    document.addEventListener("focusin", close);
    document.addEventListener("keydown", close, true);
    return () => {
      window.removeEventListener("resize", position);
      list.removeEventListener("scroll", position);
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("focusin", close);
      document.removeEventListener("keydown", close, true);
    };
  }, [peekPresent, selectedItemId, onClosePeek]);

  const openEntry = useCallback((entry: CollectionBrowserEntry, options?: { keyboard?: boolean }) => {
    if (entry.kind === "note") onSelect(entry.note.path, options);
    else onSelectFile(entry.file);
  }, [onSelect, onSelectFile]);

  useEffect(() => {
    const identity = selectedFilePath ? `file:${selectedFilePath}` : focusedPath ? `note:${focusedPath}` : undefined;
    if (!identity) { revealedEntry.current = undefined; return; }
    if (selectedEntryIndex < 0 || revealedEntry.current === identity) return;
    const itemIndex = listItems.findIndex((item) => item.entryIndex === selectedEntryIndex);
    if (itemIndex >= 0) {
      virtualizer.scrollToIndex?.(itemIndex, { align: "auto" });
      revealedEntry.current = identity;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEntryIndex, selectedFilePath, focusedPath, searchQuery]);

  const handleListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable=true]")) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      const anchor = currentSelection.anchor && selectablePaths.includes(currentSelection.anchor) ? currentSelection.anchor : selectablePaths[0];
      onSelection?.({ paths: selectablePaths, anchor, focus: currentSelection.focus ?? anchor });
      if (anchor && anchor !== currentSelection.anchor) onSelect(anchor, { keyboard: true });
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onSelection?.({ ...currentSelection, paths: focusedPath ? [focusedPath] : [] }); return;
    }
    const selected = entries[selectedEntryIndex];
    if (selected?.kind === "note") {
      if (matchesCommandShortcut("rename", event)) { event.preventDefault(); onRename?.(selected.path); return; }
      if (matchesCommandShortcut("delete", event)) { event.preventDefault(); onDelete?.(selected.path); return; }
      if (matchesCommandShortcut("note-actions", event)) {
        event.preventDefault();
        scrollRef.current?.querySelector(`#${selectedItemId}`)?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
        return;
      }
    }
    if (matchesCommandShortcut("peek", event) && selected?.kind === "note") {
      event.preventDefault();
      if (!statuses.get(selected.path)?.disabled) onPeek?.(selected.path);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      if (selectedEntryIndex >= 0 && selectedEntryIndex < entries.length) {
        event.preventDefault();
        if (selected?.kind === "note") chooseNote(selected.path, "single");
        else openEntry(entries[selectedEntryIndex]);
      }
      return;
    }
    const key = matchesCommandShortcut("list-next", event) ? "ArrowDown" : matchesCommandShortcut("list-previous", event) ? "ArrowUp" : event.key;
    if (!(key in listNavigationKeys) || !entries.length) return;
    event.preventDefault();
    let next = moveListIndex(selectedEntryIndex, entries.length, key as ListNavigationKey);
    // Range selection and peek traversal only ever land on notes.
    if (event.shiftKey || peek) {
      const direction = next < selectedEntryIndex ? -1 : 1;
      while (next >= 0 && next < entries.length && (entries[next].kind !== "note" || statuses.get(entries[next].path)?.disabled)) next += direction;
    }
    if (next < 0 || next >= entries.length || next === selectedEntryIndex) return;
    const entry = entries[next];
    if (entry.kind === "note" && !statuses.get(entry.path)?.disabled) chooseNote(entry.path, event.shiftKey ? "range" : "single", true);
    else if (!event.shiftKey) { onSelection?.({ paths: [] }); openEntry(entry, { keyboard: true }); }
  };

  return <section className="note-list-pane" aria-label={t`Notes and files`}>
    <header className="list-header"><button className="mobile-collections icon-button" aria-label={t`Collections`} onClick={onCollections}><PanelLeft aria-hidden="true" /></button>{leadingActions}<div><h1>{collectionName}</h1><p aria-live="polite">{browserCountLabel(noteCount, fileCount, entries.length, loading, structureLoading, filesLoading, contentIndexing, contentLoaded, total, contentTotal, Boolean(search.trim()), sort, Boolean(structureError || (search.trim() && contentError)))}{structureError && <button className="list-retry" title={structureError} onClick={onRetryStructure}><Trans>Retry notes</Trans></button>}{contentError && <button className="list-retry" title={contentError} onClick={onRetryContent}><Trans>Retry search</Trans></button>}{fileError && <button className="list-retry" title={fileError} onClick={onRetryFiles}><Trans>Retry files</Trans></button>}</p></div>{trailingActions}{onCreate && <Tooltip label={t`New note`}><button className="icon-button new-note" aria-keyshortcuts="C Control+Shift+N Meta+Shift+N" onClick={onCreate}><FilePlus2 aria-hidden="true" /><span className="mobile-label"><Trans>New note</Trans></span></button></Tooltip>}</header>
    <div className="note-list-controls">
      <NoteSearchField search={search} filter={filter} tags={tags} types={filterTypes} onSearch={onSearch} onFilter={onFilter ?? onClearScope} onQuickOpen={onQuickOpen} onResults={(first) => {
        if (first && entries[0]) {
          const entry = entries[0];
          if (entry.kind === "note") chooseNote(entry.path, "single", true);
          else openEntry(entry, { keyboard: true });
        } else if (!first) {
          if (searching) revealedEntry.current = undefined;
          const entryIndex = entries.findIndex((entry) => selectedFilePath ? entry.kind === "file" && entry.path === selectedFilePath : entry.kind === "note" && entry.path === selectedPath);
          if (entryIndex >= 0) {
            if (!selectedFilePath && selectedPath) onSelection?.({ paths: [selectedPath], anchor: selectedPath, focus: selectedPath });
            const itemIndex = listItems.findIndex((item) => item.entryIndex === entryIndex);
            virtualizer.scrollToIndex(itemIndex, { align: "auto" });
          }
        }
        scrollRef.current?.focus({ preventScroll: true });
      }} />
      <NoteListViewOptions sort={sort} fields={sortFields} scopeLabel={filter ? undefined : scopeLabel} onSort={onSort} onClearScope={onClearScope} />
    </div>
    <div className="note-selection-slot">{selectionBar}</div>
    <div className="note-scroll" ref={scrollRef} role="listbox" aria-multiselectable="true" aria-label={t`Collection notes and files`} aria-busy={structureLoading || filesLoading} tabIndex={entries.length ? 0 : undefined} aria-activedescendant={selectedItemId} onKeyDown={handleListKeyDown}>
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
          return <button key={`file:${file.fileId}`} id={`note-entry-${virtualRow.index}`} tabIndex={-1} role="option" aria-label={t`${title}, ${collectionFileFormat(file)} file`} aria-selected={selected} aria-busy={pending || undefined} className={`note-row file-row${selected ? " selected list-focused" : ""}${pending ? " busy" : ""}`} onClick={() => { onSelection?.({ paths: [] }); onSelectFile(file); }} style={{ transform: `translateY(${virtualRow.start}px)`, height: virtualRow.size }}><span className="note-title-line"><span className={`file-kind-icon ${file.mediaClass}`} aria-hidden="true" /><span className="note-title"><SearchMatchText text={title} ranges={searchQuery ? searchTextRanges(title, searchQuery) : []} /></span><span className="file-format">{collectionFileFormat(file)}</span></span>{pending ? <span className="note-transition"><Trans>Opening</Trans></span> : <span className="note-detail"><time>{fileTimestamp(file)}</time><span>{formatFileSize(file.size)}</span><span className="file-folder">{fileFolder(file)}</span></span>}</button>;
        }
        const note = entry.note;
        const status: NoteRowStatus | undefined = pendingPath === note.path ? { label: t`Opening`, tone: "busy", busy: true } : statuses.get(note.path);
        const secondLine = rowSecondLine(entry);
        const title = noteTitle(note, types);
        const noteFolder = folder(note.path);
        return <ContextMenu key={note.path} className="note-row-context" showTrigger={false} label={t`${title} note actions`} items={noteActions?.(note.path) ?? []} style={{ transform: `translateY(${virtualRow.start}px)`, height: virtualRow.size }}><button id={`note-entry-${virtualRow.index}`} tabIndex={-1} role="option" aria-selected={selectedPaths.has(note.path)} aria-busy={status?.busy || undefined} aria-disabled={status?.disabled || undefined} aria-describedby={secondLine?.kind === "excerpt" ? `note-excerpt-${virtualRow.index}` : undefined} className={`note-row${note.path === arrivingPath ? " note-row-arrival" : ""}${selectedPaths.has(note.path) ? " selected" : ""}${note.path === focusedPath ? " list-focused" : ""}${status ? ` ${status.tone}` : ""}`} draggable={!status?.disabled} onDragStart={(event) => { event.dataTransfer.setData(NOTE_PATHS_MIME, JSON.stringify(selectedPaths.has(note.path) ? currentSelection.paths : [note.path])); event.dataTransfer.effectAllowed = "move"; }} onClick={(event) => { if (!status?.disabled) chooseNote(note.path, event.shiftKey ? "range" : event.metaKey || event.ctrlKey ? "toggle" : "single"); }}>
          <span className="note-title-line"><span className="note-title"><SearchMatchText text={title} ranges={searchQuery ? searchTextRanges(title, searchQuery) : []} /></span>{note.types.length > 0 && <span className="note-type-badge" title={t`Type: ${note.types.join(", ")}`}>{note.types.join(" · ")}</span>}</span>
          {secondLine && <span id={secondLine.kind === "excerpt" ? `note-excerpt-${virtualRow.index}` : undefined} aria-hidden={secondLine.kind === "excerpt" || undefined} className={`note-excerpt${secondLine.kind === "excerpt" ? "" : ` note-search-context ${secondLine.kind}`}`}><SearchMatchText text={secondLine.text} ranges={secondLine.ranges} /></span>}
          {status?.label ? <span className="note-transition">{status.label}</span> : <span className="note-detail"><time>{noteTimestamp(note)}</time>{noteFolder && <span className="note-folder">{noteFolder}</span>}</span>}
        </button></ContextMenu>;
      })}</div> : structureLoading || filesLoading ? <div className="list-loading" role="status"><Trans>Reading notes and files…</Trans></div> : <div className="list-empty"><p>{structureError ? t`Notes could not finish loading.` : search && contentError ? t`Search is incomplete.` : search ? t`No notes or files found.` : t`This collection is empty.`}</p>{!search && !structureError && onCreate && <button onClick={onCreate}><Trans>Create the first note</Trans></button>}</div>}
    </div>
    {peekPresent && <aside ref={peekRef} popover="manual" className="note-peek" data-open={Boolean(peek)} role="region" aria-label={peekContent.current.title}>{peekContent.current.body}</aside>}
  </section>;
}


function browserCountLabel(noteCount: number, fileCount: number, resultCount: number, loading: boolean, structureLoading: boolean, filesLoading: boolean, contentIndexing: boolean, contentLoaded: number, total: number | undefined, contentTotal: number | undefined, searching: boolean, sort: NoteSort, incomplete: boolean): string {
  if (incomplete) return searching ? t`${resultCount.toLocaleString(displayLocale())} found so far · incomplete` : t`${noteCount.toLocaleString(displayLocale())} notes loaded · incomplete`;
  if (searching && contentIndexing) return t`${resultCount.toLocaleString(displayLocale())} found so far · searching ${contentLoaded.toLocaleString(displayLocale())} of ${contentTotal?.toLocaleString(displayLocale()) ?? "…"}`;
  if ((loading || filesLoading) && searching) return resultCount ? t`${resultCount.toLocaleString(displayLocale())} found so far` : t`Searching`;
  if ((structureLoading || filesLoading) && noteCount === 0 && fileCount === 0) return t`Reading notes and files`;
  if (structureLoading) {
    const notes = t`${noteCount.toLocaleString(displayLocale())} of ${total?.toLocaleString(displayLocale()) ?? "…"} notes`;
    const files = plural(fileCount, { one: "# file", other: "# files" });
    return fileCount ? t`${notes} · ${files}` : notes;
  }
  if (searching) return t`${resultCount.toLocaleString(displayLocale())} found · relevance`;
  const notes = plural(noteCount, { one: "# note", other: "# notes" });
  const files = plural(fileCount, { one: "# file", other: "# files" });
  const order = noteSortSummary(sort);
  return order ? t`${notes} · ${files} · ${order}` : t`${notes} · ${files}`;
}

function fileTimestamp(file: CollectionFile): string {
  const date = new Date(file.modifiedAt);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return new Intl.DateTimeFormat(displayLocale(), { hour: "numeric", minute: "2-digit" }).format(date);
  if (date.getFullYear() === now.getFullYear()) return new Intl.DateTimeFormat(displayLocale(), { month: "short", day: "numeric" }).format(date);
  return new Intl.DateTimeFormat(displayLocale(), { year: "numeric", month: "short", day: "numeric" }).format(date);
}

function fileFolder(file: CollectionFile): string {
  return file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : t`Collection root`;
}
