import {
  ArrowLeft,
  Braces,
  Check,
  ChevronRight,
  CircleAlert,
  FilePlus2,
  Folder,
  Info,
  MoreHorizontal,
  NotebookPen,
  PanelLeft,
  Search,
  Settings2,
  Trash2,
  X
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { CollectionDescription } from "@mdbase/connect";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from "react";
import { CodeEditor } from "./CodeEditor";
import { gatewayError } from "./gateway";
import type {
  CollectionGateway,
  CreateNoteInput,
  NoteDocument,
  NoteListProgress,
  NoteSummary,
  SaveNoteInput,
  TitleSource
} from "./model";
import {
  editableNote,
  folders,
  notePreview,
  noteTimestamp,
  noteTitle,
  propertyPatch,
  safeRenamePath
} from "./note";
import { NewNoteComposer } from "./NewNoteComposer";
import { loadPreferences, savePreferences, type EditorPreferences } from "./preferences";
import { PropertiesPanel } from "./PropertiesPanel";
import { SettingsView } from "./SettingsView";
import { TypeInspector, TypeList } from "./TypeBrowser";

type AppPhase = "starting" | "disconnected" | "loading" | "ready";
type SaveState = "saved" | "waiting" | "saving" | "conflict";
type MobilePane = "collections" | "notes" | "editor";
type Surface = "notes" | "types" | "settings";

interface Draft {
  title: string;
  body: string;
  source: TitleSource;
}

export function App({ gateway }: { gateway: CollectionGateway }) {
  const [phase, setPhase] = useState<AppPhase>("starting");
  const [description, setDescription] = useState<CollectionDescription>();
  const [allNotes, setAllNotes] = useState<NoteSummary[]>([]);
  const [listedNotes, setListedNotes] = useState<NoteSummary[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [collectionTotal, setCollectionTotal] = useState<number>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [document, setDocument] = useState<NoteDocument>();
  const [draft, setDraft] = useState<Draft>();
  const [noteLoading, setNoteLoading] = useState(false);
  const [creatingNote, setCreatingNote] = useState(false);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [folderFilter, setFolderFilter] = useState<string>();
  const [surface, setSurface] = useState<Surface>("notes");
  const [selectedTypeName, setSelectedTypeName] = useState<string>();
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [notice, setNotice] = useState<string>();
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [propertiesError, setPropertiesError] = useState<string>();
  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState<MobilePane>("notes");
  const [preferences, setPreferences] = useState<EditorPreferences>(loadPreferences);
  const indexGeneration = useRef(0);
  const skipInitialIndexLoad = useRef(false);
  const documentGeneration = useRef(0);
  const baseline = useRef("");
  const documentRef = useRef<NoteDocument | undefined>(undefined);
  const draftRef = useRef<Draft | undefined>(undefined);
  const saving = useRef(false);
  const queuedSave = useRef(false);
  const [saveTick, setSaveTick] = useState(0);

  useEffect(() => { documentRef.current = document; }, [document]);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  useEffect(() => { savePreferences(preferences); }, [preferences]);

  const loadIndex = useCallback(async (query = "") => {
    const generation = ++indexGeneration.current;
    const normalizedQuery = query.trim();
    setListLoading(true);
    const publish = (progress: NoteListProgress) => {
      if (generation !== indexGeneration.current) return;
      setListedNotes(progress.notes);
      setListLoading(!progress.complete);
      if (!normalizedQuery) {
        setAllNotes(progress.notes);
        setCollectionTotal(progress.total ?? (progress.complete ? progress.notes.length : undefined));
      }
    };
    try {
      const notes = await gateway.list(query, publish);
      publish({ notes, complete: true, total: notes.length });
    } catch (error) {
      if (generation === indexGeneration.current) setListLoading(false);
      throw error;
    }
  }, [gateway]);

  const refreshDescription = useCallback(async () => {
    const next = await gateway.describe();
    setDescription(next);
    setSelectedTypeName((current) => next.types.some((type) => type.name === current) ? current : next.types[0]?.name);
    return next;
  }, [gateway]);

  const adoptDocument = useCallback((next: NoteDocument) => {
    const nextDraft = editableNote(next);
    documentRef.current = next;
    draftRef.current = nextDraft;
    baseline.current = fingerprint(next.path, nextDraft);
    setSelectedPath(next.path);
    setDocument(next);
    setDraft(nextDraft);
    setPathDraft(next.path);
    setSaveState("saved");
    setNoteLoading(false);
    setCreatingNote(false);
    localStorage.setItem("mdbase-editor:last-note", next.path);
  }, []);

  const openNote = useCallback(async (path: string): Promise<boolean> => {
    const generation = ++documentGeneration.current;
    setSelectedPath(path);
    setDocument(undefined);
    setDraft(undefined);
    setNoteLoading(true);
    setCreatingNote(false);
    setNotice(undefined);
    setPropertiesError(undefined);
    setPropertiesOpen(false);
    setDeleteOpen(false);
    setMobilePane("editor");
    try {
      const next = await gateway.read(path);
      if (generation !== documentGeneration.current) return false;
      adoptDocument(next);
      return true;
    } catch (error) {
      if (generation === documentGeneration.current) setNotice(gatewayError(error));
      return false;
    } finally {
      if (generation === documentGeneration.current) setNoteLoading(false);
    }
  }, [adoptDocument, gateway]);

  const start = useCallback(async () => {
    setPhase("loading");
    setNotice(undefined);
    setListLoading(true);
    setCollectionTotal(undefined);
    setNoteLoading(true);
    const generation = ++indexGeneration.current;
    let descriptionLoaded = false;
    let firstPageResolved = false;
    let resolveFirstPage!: (notes: NoteSummary[]) => void;
    const firstPage = new Promise<NoteSummary[]>((resolve) => { resolveFirstPage = resolve; });
    const publish = (progress: NoteListProgress) => {
      if (generation !== indexGeneration.current) return;
      setAllNotes(progress.notes);
      setListedNotes(progress.notes);
      setCollectionTotal(progress.total ?? (progress.complete ? progress.notes.length : undefined));
      setListLoading(!progress.complete);
      if (!firstPageResolved && (progress.notes.length > 0 || progress.complete)) {
        firstPageResolved = true;
        resolveFirstPage(progress.notes);
      }
    };
    const indexOutcome = gateway.list("", publish).then(
      (notes) => {
        publish({ notes, complete: true, total: notes.length });
        if (!firstPageResolved) {
          firstPageResolved = true;
          resolveFirstPage(notes);
        }
        return { notes } as const;
      },
      (error: unknown) => {
        if (!firstPageResolved) {
          firstPageResolved = true;
          resolveFirstPage([]);
        }
        return { error } as const;
      }
    );
    try {
      const nextDescription = await refreshDescription();
      descriptionLoaded = true;
      skipInitialIndexLoad.current = true;
      setPhase("ready");
      const remembered = localStorage.getItem("mdbase-editor:last-note");
      let opened = remembered ? await openNote(remembered) : false;
      if (!opened) {
        setNoteLoading(true);
        const initial = (await firstPage)[0]?.path;
        if (initial) opened = await openNote(initial);
      }
      if (!opened) setNoteLoading(false);
      const outcome = await indexOutcome;
      if ("error" in outcome) throw outcome.error;
      if (!nextDescription.types.length) setSelectedTypeName(undefined);
    } catch (error) {
      setListLoading(false);
      setNoteLoading(false);
      setNotice(gatewayError(error));
      setPhase(descriptionLoaded && gateway.connection() ? "ready" : "disconnected");
    }
  }, [gateway, openNote, refreshDescription]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const callback = new URL(location.href);
        if (callback.searchParams.has("code")) {
          await gateway.completeAuthorization();
          history.replaceState({}, "", new URL(import.meta.env.BASE_URL, location.href));
        }
        if (!alive) return;
        if (gateway.connection()) await start();
        else setPhase("disconnected");
      } catch (error) {
        if (!alive) return;
        setNotice(gatewayError(error));
        setPhase("disconnected");
      }
    })();
    return () => { alive = false; };
  }, [gateway, start]);

  useEffect(() => {
    if (phase !== "ready") return;
    const controller = new AbortController();
    let refreshTimer: number | undefined;
    void gateway.watch((change) => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        void loadIndex(deferredSearch);
        if (change?.type === "mdbase.type.changed") void refreshDescription();
      }, 180);
    }, controller.signal).catch((error) => {
      if (!controller.signal.aborted) setNotice(gatewayError(error));
    });
    return () => {
      controller.abort();
      window.clearTimeout(refreshTimer);
    };
  }, [deferredSearch, gateway, loadIndex, phase, refreshDescription]);

  useEffect(() => {
    if (phase !== "ready") return;
    if (!deferredSearch && skipInitialIndexLoad.current) {
      skipInitialIndexLoad.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      void loadIndex(deferredSearch).catch((error) => setNotice(gatewayError(error)));
    }, deferredSearch ? 180 : 0);
    return () => window.clearTimeout(timer);
  }, [deferredSearch, loadIndex, phase]);

  const runSave = useCallback(async () => {
    const currentDocument = documentRef.current;
    const currentDraft = draftRef.current;
    if (!currentDocument || !currentDraft) return;
    const currentFingerprint = fingerprint(currentDocument.path, currentDraft);
    if (currentFingerprint === baseline.current) {
      setSaveState("saved");
      return;
    }
    if (saving.current) {
      queuedSave.current = true;
      return;
    }
    saving.current = true;
    setSaveState("saving");
    const input: SaveNoteInput = { path: currentDocument.path, revision: currentDocument.revision, ...currentDraft };
    try {
      const updated = await gateway.update(input);
      if (documentRef.current?.path === input.path) {
        documentRef.current = updated;
        setDocument(updated);
        baseline.current = currentFingerprint;
        setSaveState(fingerprint(updated.path, draftRef.current!) === currentFingerprint ? "saved" : "waiting");
        void loadIndex(deferredSearch);
      }
    } catch (error) {
      setSaveState("conflict");
      setNotice(gatewayError(error));
      throw error;
    } finally {
      saving.current = false;
      if (queuedSave.current) {
        queuedSave.current = false;
        setSaveTick((value) => value + 1);
      }
    }
  }, [deferredSearch, gateway, loadIndex]);

  useEffect(() => {
    if (!document || !draft || fingerprint(document.path, draft) === baseline.current) return;
    setSaveState("waiting");
    const timer = window.setTimeout(() => void runSave().catch(() => undefined), 650);
    return () => window.clearTimeout(timer);
  }, [document, draft, runSave, saveTick]);

  const flushSave = useCallback(async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      while (saving.current) await delay(16);
      const currentDocument = documentRef.current;
      const currentDraft = draftRef.current;
      if (!currentDocument || !currentDraft || fingerprint(currentDocument.path, currentDraft) === baseline.current) return;
      await runSave();
    }
    throw new Error("The latest edits are still being saved. Try again in a moment.");
  }, [runSave]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const currentDocument = documentRef.current;
      const currentDraft = draftRef.current;
      if (currentDocument && currentDraft && fingerprint(currentDocument.path, currentDraft) !== baseline.current) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);

  const visibleNotes = useMemo(() => folderFilter
    ? listedNotes.filter((note) => note.path === folderFilter || note.path.startsWith(`${folderFilter}/`))
    : listedNotes, [folderFilter, listedNotes]);

  async function connectCollection() {
    setNotice(undefined);
    try { await gateway.authorize(); } catch (error) { setNotice(gatewayError(error)); }
  }

  async function beginCreate() {
    setNotice(undefined);
    try {
      await flushSave();
      setSurface("notes");
      setPropertiesOpen(false);
      setCreatingNote(true);
      setMobilePane("editor");
    } catch (error) {
      setNotice(gatewayError(error));
    }
  }

  async function createNote(input: CreateNoteInput) {
    await flushSave();
    const created = await gateway.create(input);
    const summary = summaryFromDocument(created);
    setAllNotes((notes) => [summary, ...notes.filter((note) => note.path !== created.path)]);
    setListedNotes((notes) => [summary, ...notes.filter((note) => note.path !== created.path)]);
    setCollectionTotal((total) => total === undefined ? undefined : total + 1);
    setSearch("");
    setFolderFilter(undefined);
    documentGeneration.current += 1;
    setNotice(undefined);
    setPropertiesError(undefined);
    setPropertiesOpen(false);
    setDeleteOpen(false);
    setMobilePane("editor");
    adoptDocument(created);
  }

  async function renameNote() {
    const current = documentRef.current;
    if (!current) return;
    const nextPath = safeRenamePath(pathDraft);
    if (!nextPath || !nextPath.toLocaleLowerCase().endsWith(".md")) {
      setNotice("Use a collection-relative path ending in .md.");
      return;
    }
    if (nextPath === current.path) {
      setEditingPath(false);
      return;
    }
    try {
      await flushSave();
      const latest = documentRef.current!;
      const renamed = await gateway.rename(latest.path, nextPath, latest.revision);
      const currentDraft = draftRef.current!;
      baseline.current = fingerprint(renamed.path, currentDraft);
      documentRef.current = renamed;
      setDocument(renamed);
      setSelectedPath(renamed.path);
      setPathDraft(renamed.path);
      setEditingPath(false);
      await loadIndex(deferredSearch);
    } catch (error) {
      setNotice(gatewayError(error));
    }
  }

  async function saveProperties(next: Record<string, unknown>) {
    const current = documentRef.current;
    if (!current) return;
    setPropertiesError(undefined);
    try {
      await flushSave();
      const latest = documentRef.current!;
      const updated = await gateway.updateProperties(
        latest.path,
        propertyPatch(latest.raw_frontmatter ?? {}, next),
        latest.revision
      );
      documentRef.current = updated;
      setDocument(updated);
      const nextDraft = editableNote(updated);
      draftRef.current = nextDraft;
      setDraft(nextDraft);
      baseline.current = fingerprint(updated.path, nextDraft);
      setSaveState("saved");
      await loadIndex(deferredSearch);
    } catch (error) {
      setPropertiesError(gatewayError(error));
    }
  }

  async function validateNote() {
    if (!document) return;
    setNotice(undefined);
    try {
      await flushSave();
      const diagnostics = await gateway.validate(document.path);
      setNotice(diagnostics.length ? diagnostics.map((item) => item.message).join(" ") : "No validation issues.");
    } catch (error) {
      setNotice(gatewayError(error));
    }
  }

  async function deleteNote() {
    const current = documentRef.current;
    if (!current) return;
    try {
      await gateway.delete(current.path, current.revision);
      setDeleteOpen(false);
      setDocument(undefined);
      setDraft(undefined);
      setSelectedPath(undefined);
      const notes = await gateway.list(deferredSearch);
      setListedNotes(notes);
      if (!deferredSearch) setAllNotes(notes);
      if (notes[0]) await openNote(notes[0].path);
    } catch (error) {
      setNotice(gatewayError(error));
    }
  }

  async function selectSurface(next: Surface) {
    try {
      await flushSave();
      setSurface(next);
      setCreatingNote(false);
      setPropertiesOpen(false);
      setMobilePane(next === "settings" ? "editor" : "notes");
    } catch (error) {
      setNotice(gatewayError(error));
    }
  }

  function disconnect() {
    gateway.disconnect();
    setPhase("disconnected");
    setAllNotes([]);
    setListedNotes([]);
    setDocument(undefined);
    setDraft(undefined);
  }

  if (phase === "starting") return <OpeningScreen />;
  if (phase === "disconnected") return <ConnectScreen notice={notice} onConnect={() => void connectCollection()} />;
  if (phase === "loading" || !description) return <OpeningScreen />;

  const selectedType = description.types.find((type) => type.name === selectedTypeName);
  return <div className={`app-shell surface-${surface} pane-${mobilePane}${propertiesOpen ? " inspector-visible" : ""}`}>
    <CollectionRail
      name={description.display_name}
      count={collectionTotal ?? allNotes.length}
      typeCount={description.types.length}
      activeFolder={folderFilter}
      notes={allNotes}
      surface={surface}
      onNotes={(folder) => { setFolderFilter(folder); void selectSurface("notes"); }}
      onTypes={() => void selectSurface("types")}
      onSettings={() => void selectSurface("settings")}
      onDisconnect={disconnect}
    />

    {surface === "notes" && <>
      <NoteList
        notes={visibleNotes}
        loading={listLoading}
        total={folderFilter ? undefined : collectionTotal}
        selectedPath={selectedPath}
        search={search}
        collectionName={folderFilter ?? description.display_name}
        onSearch={setSearch}
        onSelect={(path) => void (async () => {
          try { await flushSave(); await openNote(path); } catch (error) { setNotice(gatewayError(error)); }
        })()}
        onCreate={() => void beginCreate()}
        onCollections={() => setMobilePane("collections")}
      />
      {creatingNote ? <NewNoteComposer
        types={description.types}
        defaultFolder={folderFilter}
        onCreate={createNote}
        onCancel={() => { setCreatingNote(false); setMobilePane("notes"); }}
      /> : <main className="editor-pane" aria-label="Note editor">
        {noteLoading ? <NoteSkeleton /> : document && draft ? <>
          <header className="editor-bar">
            <button className="mobile-back icon-button" aria-label="Back to notes" onClick={() => setMobilePane("notes")}><ArrowLeft aria-hidden="true" /></button>
            <div className="path-wrap">
              {editingPath ? <form onSubmit={(event) => { event.preventDefault(); void renameNote(); }}>
                <label className="sr-only" htmlFor="note-path">Markdown path</label>
                <input id="note-path" className="path-input" value={pathDraft} onChange={(event) => setPathDraft(event.target.value)} onBlur={() => void renameNote()} autoFocus />
              </form> : <button className="path-button" onClick={() => setEditingPath(true)} title="Rename Markdown file">{document.path}</button>}
            </div>
            {preferences.vim && <span className="vim-label">Vim</span>}
            <SaveIndicator state={saveState} />
            <button className={`icon-button${propertiesOpen ? " active" : ""}`} aria-label="Note properties" aria-pressed={propertiesOpen} onClick={() => setPropertiesOpen((value) => !value)}><Info aria-hidden="true" /></button>
            <details className="note-actions">
              <summary className="icon-button" aria-label="More note actions"><MoreHorizontal aria-hidden="true" /></summary>
              <div className="action-menu">
                <button onClick={() => void validateNote()}><Check aria-hidden="true" /> Check note</button>
                <button className="danger-action" onClick={() => setDeleteOpen(true)}><Trash2 aria-hidden="true" /> Delete note</button>
              </div>
            </details>
          </header>
          {notice && <div className="notice" role="status"><CircleAlert aria-hidden="true" /><span>{notice}</span><button aria-label="Dismiss message" onClick={() => setNotice(undefined)}><X aria-hidden="true" /></button></div>}
          {deleteOpen && <div className="delete-confirm" role="alert"><span>Delete this note from the collection?</span><button onClick={() => setDeleteOpen(false)}>Keep note</button><button className="danger-action" onClick={() => void deleteNote()}>Delete</button></div>}
          <article className="writing-surface" style={{ "--editor-font-size": `${preferences.fontSize}px` } as CSSProperties}>
            <label className="sr-only" htmlFor="note-title">Note title</label>
            <input id="note-title" className="title-input" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="Untitled" spellCheck="true" />
            <CodeEditor
              key={document.path}
              value={draft.body}
              onChange={(body) => setDraft((current) => current ? { ...current, body } : current)}
              label="Note body"
              language="markdown"
              placeholder="Start writing"
              vimEnabled={preferences.vim}
              lineWrapping={preferences.lineWrapping}
              autoFocus
              className="body-editor"
            />
          </article>
        </> : <EmptyEditor onCreate={() => void beginCreate()} />}
      </main>}
      {propertiesOpen && document && <PropertiesPanel key={document.path} note={document} types={description.types} error={propertiesError} onClose={() => setPropertiesOpen(false)} onSave={(value) => void saveProperties(value)} />}
    </>}

    {surface === "types" && <>
      <TypeList types={description.types} selectedName={selectedTypeName} onSelect={(name) => { setSelectedTypeName(name); setMobilePane("editor"); }} onCollections={() => setMobilePane("collections")} />
      <TypeInspector type={selectedType} onBack={() => setMobilePane("notes")} />
    </>}

    {surface === "settings" && <SettingsView description={description} noteCount={allNotes.length} preferences={preferences} onChange={setPreferences} onBack={() => setMobilePane("collections")} />}
  </div>;
}

function ConnectScreen({ notice, onConnect }: { notice?: string; onConnect: () => void }) {
  return <main className="connect-screen"><section><Wordmark /><h1>Your notes,<br />as files.</h1><p className="connect-copy">Open an mdbase collection and write. Its Markdown stays on your computer.</p><button className="connect-button" onClick={onConnect}>Connect a collection <ChevronRight aria-hidden="true" /></button><p className="access-copy">This editor asks to view, create, edit, move, validate, and delete records and inspect type definitions in one collection. You approve access on the computer that holds it.</p>{notice && <p className="connect-error" role="alert">{notice}</p>}</section></main>;
}

function OpeningScreen() {
  return <main className="opening-shell" aria-label="Opening collection" aria-busy="true">
    <aside className="opening-rail"><Wordmark /><div className="opening-rail-lines"><span /><span /><span /></div></aside>
    <section className="opening-list" aria-hidden="true"><div className="opening-list-heading"><span /><small /></div><div className="opening-search" />{Array.from({ length: 7 }, (_, index) => <div className="opening-row" key={index}><span /><small /></div>)}</section>
    <section className="opening-document">
      <div className="opening-document-bar" aria-hidden="true"><span /></div>
      <div className="opening-message"><span className="opening-pulse" aria-hidden="true" /><div><p>Opening collection</p><small>Reading its notes and types</small></div></div>
      <div className="opening-document-lines" aria-hidden="true"><strong /><span /><span /><span /></div>
    </section>
  </main>;
}

function Wordmark() {
  return <div className="wordmark"><span aria-hidden="true" />mdbase <strong>editor</strong></div>;
}

function CollectionRail({ name, count, typeCount, activeFolder, notes, surface, onNotes, onTypes, onSettings, onDisconnect }: {
  name: string;
  count: number;
  typeCount: number;
  activeFolder?: string;
  notes: NoteSummary[];
  surface: Surface;
  onNotes: (folder?: string) => void;
  onTypes: () => void;
  onSettings: () => void;
  onDisconnect: () => void;
}) {
  const collectionFolders = folders(notes);
  return <aside className="collection-rail" aria-label="Collection navigation">
    <Wordmark />
    <nav>
      <p className="collection-name">{name}</p>
      <button className={surface === "notes" && !activeFolder ? "selected" : ""} onClick={() => onNotes(undefined)}><span><NotebookPen aria-hidden="true" />Notes</span><small>{count}</small></button>
      <button className={surface === "types" ? "selected" : ""} onClick={onTypes}><span><Braces aria-hidden="true" />Types</span><small>{typeCount}</small></button>
      <button className={surface === "settings" ? "selected" : ""} onClick={onSettings}><span><Settings2 aria-hidden="true" />Settings</span></button>
      {collectionFolders.length > 0 && <><p className="rail-label">Folders</p>{collectionFolders.map((folder) => <button key={folder.name} className={surface === "notes" && activeFolder === folder.name ? "selected" : ""} onClick={() => onNotes(folder.name)}><span><Folder aria-hidden="true" />{folder.name}</span><small>{folder.count}</small></button>)}</>}
    </nav>
    <footer><p><span className="status-dot" />Connected</p><button onClick={onDisconnect}>Disconnect</button></footer>
  </aside>;
}

function NoteList({ notes, selectedPath, search, collectionName, loading, total, onSearch, onSelect, onCreate, onCollections }: {
  notes: NoteSummary[];
  selectedPath?: string;
  search: string;
  collectionName: string;
  loading: boolean;
  total?: number;
  onSearch: (value: string) => void;
  onSelect: (path: string) => void;
  onCreate: () => void;
  onCollections: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({ count: notes.length, getScrollElement: () => scrollRef.current, estimateSize: () => 76, overscan: 8 });
  return <section className="note-list-pane" aria-label="Notes">
    <header className="list-header"><button className="mobile-collections icon-button" aria-label="Collections" onClick={onCollections}><PanelLeft aria-hidden="true" /></button><div><h1>{collectionName}</h1><p aria-live="polite">{noteCountLabel(notes.length, loading, total, Boolean(search))}</p></div><button className="icon-button new-note" aria-label="New note" onClick={onCreate}><FilePlus2 aria-hidden="true" /></button></header>
    <label className={`search-field${loading && !search ? " disabled" : ""}`}><Search aria-hidden="true" /><span className="sr-only">Search every note</span><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder={loading && !search ? "Reading collection" : "Search"} disabled={loading && !search} />{search && <button aria-label="Clear search" onClick={() => onSearch("")}><X aria-hidden="true" /></button>}</label>
    <div className="note-scroll" ref={scrollRef} role="listbox" aria-label="Collection notes" aria-busy={loading}>
      {notes.length ? <div className="virtual-list" style={{ height: virtualizer.getTotalSize() }}>{virtualizer.getVirtualItems().map((virtualRow) => {
        const note = notes[virtualRow.index];
        return <button key={note.path} role="option" aria-selected={note.path === selectedPath} className={`note-row${note.path === selectedPath ? " selected" : ""}`} onClick={() => onSelect(note.path)} style={{ transform: `translateY(${virtualRow.start}px)`, height: virtualRow.size }}><span className="note-title">{noteTitle(note)}</span><span className="note-detail"><time>{noteTimestamp(note)}</time>{notePreview(note)}</span></button>;
      })}</div> : loading ? <NoteListSkeleton /> : <div className="list-empty"><p>{search ? "No notes found." : "This collection is empty."}</p>{!search && <button onClick={onCreate}>Create the first note</button>}</div>}
    </div>
  </section>;
}

function NoteListSkeleton() {
  return <div className="note-list-skeleton" aria-hidden="true">{Array.from({ length: 8 }, (_, index) => <div key={index}><span /><small /></div>)}</div>;
}

function noteCountLabel(count: number, loading: boolean, total: number | undefined, searching: boolean): string {
  if (loading && searching) return count ? `${count.toLocaleString()} found so far` : "Searching";
  if (loading && count === 0) return "Reading notes";
  if (loading) return `${count.toLocaleString()} of ${total?.toLocaleString() ?? "…"} notes`;
  return `${count.toLocaleString()} ${count === 1 ? "note" : "notes"}`;
}

function SaveIndicator({ state }: { state: SaveState }) {
  const label = state === "saving" ? "Saving" : state === "waiting" ? "Unsaved" : state === "conflict" ? "Needs attention" : "Saved";
  return <span className={`save-state ${state}`} aria-live="polite">{state === "saved" && <Check aria-hidden="true" />}{label}</span>;
}

function NoteSkeleton() {
  return <div className="note-skeleton" aria-label="Loading note" aria-busy="true"><div className="skeleton-bar"><span /></div><div className="skeleton-document"><span className="skeleton-title" /><span /><span /><span className="short" /></div></div>;
}

function EmptyEditor({ onCreate }: { onCreate: () => void }) {
  return <div className="empty-editor"><p>Select a note, or start a new one.</p><button onClick={onCreate}>New note</button></div>;
}

function fingerprint(path: string, draft: Draft): string {
  return JSON.stringify([path, draft.title, draft.body, draft.source]);
}

function summaryFromDocument(document: NoteDocument): NoteSummary {
  const { revision: _revision, raw_frontmatter: _rawFrontmatter, ...summary } = document;
  return summary;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
