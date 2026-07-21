import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleAlert,
  FilePlus2,
  Folder,
  Info,
  MoreHorizontal,
  PanelLeft,
  Search,
  Trash2,
  X
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { gatewayError } from "./gateway";
import type {
  CollectionGateway,
  NoteDocument,
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

type AppPhase = "starting" | "disconnected" | "loading" | "ready";
type SaveState = "saved" | "waiting" | "saving" | "conflict";
type MobilePane = "collections" | "notes" | "editor";

interface Draft {
  title: string;
  body: string;
  source: TitleSource;
}

export function App({ gateway }: { gateway: CollectionGateway }) {
  const [phase, setPhase] = useState<AppPhase>("starting");
  const [collectionName, setCollectionName] = useState("Collection");
  const [allNotes, setAllNotes] = useState<NoteSummary[]>([]);
  const [listedNotes, setListedNotes] = useState<NoteSummary[]>([]);
  const [selectedPath, setSelectedPath] = useState<string>();
  const [document, setDocument] = useState<NoteDocument>();
  const [draft, setDraft] = useState<Draft>();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [folderFilter, setFolderFilter] = useState<string>();
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [notice, setNotice] = useState<string>();
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [propertiesText, setPropertiesText] = useState("{}");
  const [propertiesError, setPropertiesError] = useState<string>();
  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState<MobilePane>("notes");
  const indexGeneration = useRef(0);
  const documentGeneration = useRef(0);
  const baseline = useRef("");
  const documentRef = useRef<NoteDocument | undefined>(undefined);
  const draftRef = useRef<Draft | undefined>(undefined);
  const saving = useRef(false);
  const queuedSave = useRef(false);
  const [saveTick, setSaveTick] = useState(0);

  useEffect(() => { documentRef.current = document; }, [document]);
  useEffect(() => { draftRef.current = draft; }, [draft]);

  const loadIndex = useCallback(async (query = "") => {
    const generation = ++indexGeneration.current;
    const notes = await gateway.list(query);
    if (generation !== indexGeneration.current) return;
    setListedNotes(notes);
    if (!query.trim()) setAllNotes(notes);
  }, [gateway]);

  const openNote = useCallback(async (path: string) => {
    const generation = ++documentGeneration.current;
    setSelectedPath(path);
    setDocument(undefined);
    setDraft(undefined);
    setNotice(undefined);
    setPropertiesError(undefined);
    setDeleteOpen(false);
    setMobilePane("editor");
    try {
      const next = await gateway.read(path);
      if (generation !== documentGeneration.current) return;
      const nextDraft = editableNote(next);
      documentRef.current = next;
      draftRef.current = nextDraft;
      baseline.current = fingerprint(next.path, nextDraft);
      setDocument(next);
      setDraft(nextDraft);
      setPathDraft(next.path);
      setPropertiesText(JSON.stringify(next.raw_frontmatter ?? {}, null, 2));
      setSaveState("saved");
      localStorage.setItem("mdbase-editor:last-note", next.path);
    } catch (error) {
      if (generation === documentGeneration.current) setNotice(gatewayError(error));
    }
  }, [gateway]);

  const start = useCallback(async () => {
    setPhase("loading");
    setNotice(undefined);
    try {
      const description = await gateway.describe();
      setCollectionName(description.display_name);
      const notes = await gateway.list();
      setAllNotes(notes);
      setListedNotes(notes);
      setPhase("ready");
      const remembered = localStorage.getItem("mdbase-editor:last-note");
      const initial = notes.find((note) => note.path === remembered)?.path ?? notes[0]?.path;
      if (initial) await openNote(initial);
    } catch (error) {
      setNotice(gatewayError(error));
      setPhase(gateway.connection() ? "ready" : "disconnected");
    }
  }, [gateway, openNote]);

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
    void gateway.watch(() => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void loadIndex(deferredSearch), 180);
    }, controller.signal).catch((error) => {
      if (!controller.signal.aborted) setNotice(gatewayError(error));
    });
    return () => {
      controller.abort();
      window.clearTimeout(refreshTimer);
    };
  }, [deferredSearch, gateway, loadIndex, phase]);

  useEffect(() => {
    if (phase !== "ready") return;
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
    const input: SaveNoteInput = {
      path: currentDocument.path,
      revision: currentDocument.revision,
      ...currentDraft
    };
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
    if (!document || !draft) return;
    if (fingerprint(document.path, draft) === baseline.current) return;
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
      if (currentDocument && currentDraft && fingerprint(currentDocument.path, currentDraft) !== baseline.current) {
        event.preventDefault();
      }
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

  async function createNote() {
    setNotice(undefined);
    try {
      await flushSave();
      const created = await gateway.create();
      await loadIndex("");
      await openNote(created.path);
    } catch (error) {
      setNotice(gatewayError(error));
    }
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

  async function saveProperties() {
    const current = documentRef.current;
    if (!current) return;
    setPropertiesError(undefined);
    try {
      const parsed = JSON.parse(propertiesText) as unknown;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        throw new Error("Properties must be a JSON object.");
      }
      await flushSave();
      const latest = documentRef.current!;
      const updated = await gateway.updateProperties(
        latest.path,
        propertyPatch(latest.raw_frontmatter ?? {}, parsed as Record<string, unknown>),
        latest.revision
      );
      documentRef.current = updated;
      setDocument(updated);
      setPropertiesText(JSON.stringify(updated.raw_frontmatter ?? {}, null, 2));
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

  function disconnect() {
    gateway.disconnect();
    setPhase("disconnected");
    setAllNotes([]);
    setListedNotes([]);
    setDocument(undefined);
    setDraft(undefined);
  }

  if (phase === "starting") return <LoadingScreen />;
  if (phase === "disconnected") {
    return <ConnectScreen notice={notice} onConnect={() => void connectCollection()} />;
  }
  if (phase === "loading") return <LoadingScreen />;

  return <div className={`app-shell pane-${mobilePane}${propertiesOpen ? " inspector-visible" : ""}`}>
    <CollectionRail
      name={collectionName}
      count={allNotes.length}
      activeFolder={folderFilter}
      notes={allNotes}
      onFolder={(folder) => { setFolderFilter(folder); setMobilePane("notes"); }}
      onDisconnect={disconnect}
    />
    <NoteList
      notes={visibleNotes}
      selectedPath={selectedPath}
      search={search}
      collectionName={folderFilter ?? collectionName}
      onSearch={setSearch}
      onSelect={(path) => void (async () => {
        try {
          await flushSave();
          await openNote(path);
        } catch (error) {
          setNotice(gatewayError(error));
        }
      })()}
      onCreate={() => void createNote()}
      onCollections={() => setMobilePane("collections")}
    />
    <main className="editor-pane" aria-label="Note editor">
      {document && draft ? <>
        <header className="editor-bar">
          <button className="mobile-back icon-button" aria-label="Back to notes" onClick={() => setMobilePane("notes")}>
            <ArrowLeft aria-hidden="true" />
          </button>
          <div className="path-wrap">
            {editingPath ? <form onSubmit={(event) => { event.preventDefault(); void renameNote(); }}>
              <label className="sr-only" htmlFor="note-path">Markdown path</label>
              <input
                id="note-path"
                className="path-input"
                value={pathDraft}
                onChange={(event) => setPathDraft(event.target.value)}
                onBlur={() => void renameNote()}
                autoFocus
              />
            </form> : <button className="path-button" onClick={() => setEditingPath(true)} title="Rename Markdown file">
              {document.path}
            </button>}
          </div>
          <SaveIndicator state={saveState} />
          <button
            className={`icon-button${propertiesOpen ? " active" : ""}`}
            aria-label="Note properties"
            aria-pressed={propertiesOpen}
            onClick={() => setPropertiesOpen((value) => !value)}
          ><Info aria-hidden="true" /></button>
          <details className="note-actions">
            <summary className="icon-button" aria-label="More note actions"><MoreHorizontal aria-hidden="true" /></summary>
            <div className="action-menu">
              <button onClick={() => void validateNote()}><Check aria-hidden="true" /> Check note</button>
              <button className="danger-action" onClick={() => setDeleteOpen(true)}><Trash2 aria-hidden="true" /> Delete note</button>
            </div>
          </details>
        </header>
        {notice && <div className="notice" role="status">
          <CircleAlert aria-hidden="true" />
          <span>{notice}</span>
          <button aria-label="Dismiss message" onClick={() => setNotice(undefined)}><X aria-hidden="true" /></button>
        </div>}
        {deleteOpen && <div className="delete-confirm" role="alert">
          <span>Delete this note from the collection?</span>
          <button onClick={() => setDeleteOpen(false)}>Keep note</button>
          <button className="danger-action" onClick={() => void deleteNote()}>Delete</button>
        </div>}
        <article className="writing-surface">
          <label className="sr-only" htmlFor="note-title">Note title</label>
          <input
            id="note-title"
            className="title-input"
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            placeholder="Untitled"
            spellCheck="true"
          />
          <label className="sr-only" htmlFor="note-body">Note body</label>
          <textarea
            id="note-body"
            className="body-input"
            value={draft.body}
            onChange={(event) => setDraft({ ...draft, body: event.target.value })}
            placeholder="Start writing"
            spellCheck="true"
          />
        </article>
      </> : <EmptyEditor onCreate={() => void createNote()} />}
    </main>
    {propertiesOpen && document && <PropertiesPanel
      note={document}
      text={propertiesText}
      error={propertiesError}
      onChange={setPropertiesText}
      onClose={() => setPropertiesOpen(false)}
      onSave={() => void saveProperties()}
    />}
  </div>;
}

function ConnectScreen({ notice, onConnect }: { notice?: string; onConnect: () => void }) {
  return <main className="connect-screen">
    <section>
      <Wordmark />
      <h1>Your notes,<br />as files.</h1>
      <p className="connect-copy">Open an mdbase collection and write. Its Markdown stays on your computer.</p>
      <button className="connect-button" onClick={onConnect}>Connect a collection <ChevronRight aria-hidden="true" /></button>
      <p className="access-copy">This editor asks to view, create, edit, move, validate, and delete records in one collection. You approve access on the computer that holds it.</p>
      {notice && <p className="connect-error" role="alert">{notice}</p>}
    </section>
  </main>;
}

function LoadingScreen() {
  return <main className="loading-screen"><Wordmark /><p>Opening collection</p></main>;
}

function Wordmark() {
  return <div className="wordmark"><span aria-hidden="true" />mdbase <strong>editor</strong></div>;
}

function CollectionRail(props: {
  name: string;
  count: number;
  activeFolder?: string;
  notes: NoteSummary[];
  onFolder: (folder?: string) => void;
  onDisconnect: () => void;
}) {
  const collectionFolders = folders(props.notes);
  return <aside className="collection-rail" aria-label="Collection navigation">
    <Wordmark />
    <nav>
      <button className={!props.activeFolder ? "selected" : ""} onClick={() => props.onFolder(undefined)}>
        <span>{props.name}</span><small>{props.count}</small>
      </button>
      <p className="rail-label">Folders</p>
      {collectionFolders.map((folder) => <button
        key={folder.name}
        className={props.activeFolder === folder.name ? "selected" : ""}
        onClick={() => props.onFolder(folder.name)}
      >
        <span><Folder aria-hidden="true" />{folder.name}</span><small>{folder.count}</small>
      </button>)}
    </nav>
    <footer>
      <p><span className="status-dot" />Connected</p>
      <button onClick={props.onDisconnect}>Disconnect</button>
    </footer>
  </aside>;
}

function NoteList(props: {
  notes: NoteSummary[];
  selectedPath?: string;
  search: string;
  collectionName: string;
  onSearch: (value: string) => void;
  onSelect: (path: string) => void;
  onCreate: () => void;
  onCollections: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: props.notes.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 76,
    overscan: 8
  });

  return <section className="note-list-pane" aria-label="Notes">
    <header className="list-header">
      <button className="mobile-collections icon-button" aria-label="Collections" onClick={props.onCollections}>
        <PanelLeft aria-hidden="true" />
      </button>
      <div><h1>{props.collectionName}</h1><p>{props.notes.length} {props.notes.length === 1 ? "note" : "notes"}</p></div>
      <button className="icon-button new-note" aria-label="New note" onClick={props.onCreate}><FilePlus2 aria-hidden="true" /></button>
    </header>
    <label className="search-field">
      <Search aria-hidden="true" />
      <span className="sr-only">Search every note</span>
      <input value={props.search} onChange={(event) => props.onSearch(event.target.value)} placeholder="Search" />
      {props.search && <button aria-label="Clear search" onClick={() => props.onSearch("")}><X aria-hidden="true" /></button>}
    </label>
    <div className="note-scroll" ref={scrollRef} role="listbox" aria-label="Collection notes">
      {props.notes.length ? <div className="virtual-list" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const note = props.notes[virtualRow.index];
          return <button
            key={note.path}
            role="option"
            aria-selected={note.path === props.selectedPath}
            className={`note-row${note.path === props.selectedPath ? " selected" : ""}`}
            onClick={() => props.onSelect(note.path)}
            style={{ transform: `translateY(${virtualRow.start}px)`, height: virtualRow.size }}
          >
            <span className="note-title">{noteTitle(note)}</span>
            <span className="note-detail"><time>{noteTimestamp(note)}</time>{notePreview(note)}</span>
          </button>;
        })}
      </div> : <div className="list-empty"><p>{props.search ? "No notes found." : "This collection is empty."}</p>{!props.search && <button onClick={props.onCreate}>Create the first note</button>}</div>}
    </div>
  </section>;
}

function SaveIndicator({ state }: { state: SaveState }) {
  const label = state === "saving" ? "Saving" : state === "waiting" ? "Unsaved" : state === "conflict" ? "Needs attention" : "Saved";
  return <span className={`save-state ${state}`} aria-live="polite">{state === "saved" && <Check aria-hidden="true" />}{label}</span>;
}

function PropertiesPanel(props: {
  note: NoteDocument;
  text: string;
  error?: string;
  onChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return <aside className="properties-panel" aria-label="Note properties">
    <header><div><h2>Properties</h2><p>{props.note.types.length ? props.note.types.join(", ") : "Untyped record"}</p></div><button className="icon-button" aria-label="Close properties" onClick={props.onClose}><X aria-hidden="true" /></button></header>
    <dl>
      <div><dt>Path</dt><dd>{props.note.path}</dd></div>
      <div><dt>Size</dt><dd>{formatBytes(props.note.file?.size)}</dd></div>
      <div><dt>Modified</dt><dd>{formatDate(props.note.file?.mtime)}</dd></div>
    </dl>
    <label htmlFor="frontmatter">Frontmatter</label>
    <textarea id="frontmatter" value={props.text} onChange={(event) => props.onChange(event.target.value)} spellCheck="false" />
    {props.error && <p className="property-error" role="alert">{props.error}</p>}
    <button className="property-save" onClick={props.onSave}>Save properties</button>
  </aside>;
}

function EmptyEditor({ onCreate }: { onCreate: () => void }) {
  return <div className="empty-editor"><p>Select a note, or start a new one.</p><button onClick={onCreate}>New note</button></div>;
}

function fingerprint(path: string, draft: Draft): string {
  return JSON.stringify([path, draft.title, draft.body, draft.source]);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function formatBytes(value?: number): string {
  if (value === undefined) return "Unknown";
  if (value < 1_000) return `${value} B`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)} KB`;
  return `${(value / 1_000_000).toFixed(1)} MB`;
}

function formatDate(value?: string): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
