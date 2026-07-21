import {
  ArrowLeft,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FilePlus2,
  Folder,
  Info,
  Link2,
  LogOut,
  MoreHorizontal,
  NotebookPen,
  PanelLeft,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings2,
  Tag,
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
import { backlinksFor, linkSuggestions } from "./links";
import {
  COLLECTION_WIDTH,
  LIST_WIDTH,
  loadLayoutPreferences,
  saveLayoutPreferences,
  type LayoutPreferences
} from "./layout-preferences";
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
  noteTags,
  notePreview,
  noteTimestamp,
  noteTitle,
  propertyPatch,
  safeRenamePath,
  tags as collectionTags,
  types as collectionTypes
} from "./note";
import { NewNoteComposer } from "./NewNoteComposer";
import { KeyedOperationQueue } from "./operation-queue";
import { loadPreferences, savePreferences, type EditorPreferences } from "./preferences";
import { PropertiesPanel } from "./PropertiesPanel";
import { SettingsView } from "./SettingsView";
import { TypeInspector, TypeList } from "./TypeBrowser";

type AppPhase = "starting" | "disconnected" | "loading" | "ready";
type SaveState = "saved" | "waiting" | "saving" | "conflict";
type MobilePane = "collections" | "notes" | "editor";
type Surface = "notes" | "types" | "settings";
type NoteActivity = "saving" | "properties" | "renaming" | "deleting" | "validating";
type NoteFilter = { kind: "folder" | "tag" | "type"; value: string };

interface Draft {
  title: string;
  body: string;
  source: TitleSource;
}

interface NoteSession {
  document: NoteDocument;
  draft: Draft;
  persistedDraft: Draft;
  remoteDocument?: NoteDocument;
  saveState: SaveState;
  activity?: NoteActivity;
  error?: string;
  deleted?: boolean;
  saveAgain?: boolean;
  savePromise?: Promise<void>;
}

interface NoteRowStatus {
  label: string;
  tone: "quiet" | "busy" | "error";
  busy: boolean;
  disabled?: boolean;
}

export function App({ gateway }: { gateway: CollectionGateway }) {
  const [phase, setPhase] = useState<AppPhase>("starting");
  const [description, setDescription] = useState<CollectionDescription>();
  const [allNotes, setAllNotes] = useState<NoteSummary[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [collectionTotal, setCollectionTotal] = useState<number>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [document, setDocument] = useState<NoteDocument>();
  const [draft, setDraft] = useState<Draft>();
  const [noteLoading, setNoteLoading] = useState(false);
  const [pendingNotePath, setPendingNotePath] = useState<string>();
  const [creatingNote, setCreatingNote] = useState(false);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [noteFilter, setNoteFilter] = useState<NoteFilter>();
  const [surface, setSurface] = useState<Surface>("notes");
  const [selectedTypeName, setSelectedTypeName] = useState<string>();
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [notice, setNotice] = useState<string>();
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [backlinksOpen, setBacklinksOpen] = useState(false);
  const [propertiesError, setPropertiesError] = useState<string>();
  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState<MobilePane>("notes");
  const [preferences, setPreferences] = useState<EditorPreferences>(loadPreferences);
  const [layout, setLayout] = useState<LayoutPreferences>(loadLayoutPreferences);
  const [resizingPane, setResizingPane] = useState<"collection" | "list">();
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [, setSessionTick] = useState(0);
  const indexGeneration = useRef(0);
  const documentGeneration = useRef(0);
  const navigationGeneration = useRef(0);
  const currentSession = useRef<NoteSession | undefined>(undefined);
  const sessions = useRef(new Map<string, NoteSession>());
  const operationQueue = useRef(new KeyedOperationQueue<NoteSession>());

  useEffect(() => { savePreferences(preferences); }, [preferences]);
  useEffect(() => { saveLayoutPreferences(layout); }, [layout]);
  useEffect(() => {
    const updateViewportWidth = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", updateViewportWidth);
    return () => window.removeEventListener("resize", updateViewportWidth);
  }, []);

  const loadIndex = useCallback(async () => {
    const generation = ++indexGeneration.current;
    setListLoading(true);
    setFoldersLoading(true);
    const publish = (progress: NoteListProgress) => {
      if (generation !== indexGeneration.current) return;
      setAllNotes(progress.notes);
      setCollectionTotal(progress.total ?? (progress.structureComplete ? progress.notes.length : undefined));
      setListLoading(!progress.complete);
      setFoldersLoading(!progress.structureComplete);
    };
    try {
      const notes = await gateway.list(publish);
      publish({ notes, structureComplete: true, complete: true, total: notes.length });
    } catch (error) {
      if (generation === indexGeneration.current) {
        setListLoading(false);
        setFoldersLoading(false);
      }
      throw error;
    }
  }, [gateway]);

  const refreshDescription = useCallback(async () => {
    const next = await gateway.describe();
    setDescription(next);
    setSelectedTypeName((current) => next.types.some((type) => type.name === current) ? current : next.types[0]?.name);
    return next;
  }, [gateway]);

  const updateNoteSummary = useCallback((next: NoteDocument, previousPath = next.path) => {
    const summary = summaryFromDocument(next);
    setAllNotes((notes) => {
      const previous = notes.find((note) => note.path === previousPath || note.path === summary.path);
      const merged = previous?.file ? { ...summary, file: { ...previous.file, ...summary.file } } : summary;
      return [merged, ...notes.filter((note) => note.path !== previousPath && note.path !== summary.path)];
    });
  }, []);

  const touchSession = useCallback((session: NoteSession) => {
    if (currentSession.current === session) setSaveState(session.activity === "saving" ? "saving" : session.saveState);
    setSessionTick((value) => value + 1);
  }, []);

  const activateSession = useCallback((session: NoteSession) => {
    currentSession.current = session;
    setSelectedPath(session.document.path);
    setDocument(session.document);
    setDraft(session.draft);
    setPathDraft(session.document.path);
    setSaveState(session.activity === "saving" ? "saving" : session.saveState);
    setNoteLoading(false);
    setPendingNotePath(undefined);
    setCreatingNote(false);
    setEditingPath(false);
    setNotice(session.error);
    localStorage.setItem("mdbase-editor:last-note", session.document.path);
  }, []);

  const adoptDocument = useCallback((next: NoteDocument) => {
    const nextDraft = editableNote(next);
    const session: NoteSession = {
      document: next,
      draft: nextDraft,
      persistedDraft: structuredClone(nextDraft),
      saveState: "saved"
    };
    sessions.current.set(next.path, session);
    activateSession(session);
  }, [activateSession]);

  const applyRemoteDocument = useCallback((session: NoteSession, next: NoteDocument) => {
    const nextDraft = editableNote(next);
    session.document = next;
    session.draft = nextDraft;
    session.persistedDraft = structuredClone(nextDraft);
    session.remoteDocument = undefined;
    session.saveState = "saved";
    session.error = undefined;
    updateNoteSummary(next);
    if (currentSession.current === session) {
      setDocument(next);
      setDraft(nextDraft);
      setPathDraft(next.path);
    }
    touchSession(session);
  }, [touchSession, updateNoteSummary]);

  const refreshCachedNote = useCallback(async (path: string) => {
    const initial = sessions.current.get(path);
    if (!initial || initial.deleted) return;

    await operationQueue.current.wait(initial);
    const session = sessions.current.get(path);
    if (session !== initial || session.deleted) return;

    const next = await gateway.read(path);
    if (sessions.current.get(path) !== session || session.deleted || next.revision === session.document.revision) return;

    if (sessionDirty(session)) {
      session.remoteDocument = next;
      session.saveState = "conflict";
      session.error = `“${session.draft.title || session.document.path}” changed elsewhere. Your edits are still here.`;
      touchSession(session);
      if (currentSession.current === session) setNotice(session.error);
      return;
    }

    applyRemoteDocument(session, next);
  }, [applyRemoteDocument, gateway, touchSession]);

  const openNote = useCallback(async (path: string): Promise<boolean> => {
    const generation = ++documentGeneration.current;
    const cached = sessions.current.get(path);
    if (cached?.deleted) return false;
    setCreatingNote(false);
    setNotice(undefined);
    setPropertiesError(undefined);
    setPropertiesOpen(false);
    setBacklinksOpen(false);
    setDeleteOpen(false);
    setMobilePane("editor");
    if (cached && !cached.deleted) {
      activateSession(cached);
      return true;
    }
    setSelectedPath(path);
    setDocument(undefined);
    setDraft(undefined);
    setNoteLoading(true);
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
  }, [activateSession, adoptDocument, gateway]);

  const start = useCallback(async () => {
    setPhase("loading");
    setNotice(undefined);
    setListLoading(true);
    setFoldersLoading(true);
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
      setCollectionTotal(progress.total ?? (progress.structureComplete ? progress.notes.length : undefined));
      setListLoading(!progress.complete);
      setFoldersLoading(!progress.structureComplete);
      if (!firstPageResolved && (progress.notes.length > 0 || progress.structureComplete)) {
        firstPageResolved = true;
        resolveFirstPage(progress.notes);
      }
    };
    const indexOutcome = gateway.list(publish).then(
      (notes) => {
        publish({ notes, structureComplete: true, complete: true, total: notes.length });
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
      setFoldersLoading(false);
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
    const changedPaths = new Set<string>();
    let typesChanged = false;
    void gateway.watch((change) => {
      if (change?.type === "mdbase.record.modified" && typeof change.payload.path === "string") {
        changedPaths.add(change.payload.path);
      }
      if (change?.type === "mdbase.type.changed") typesChanged = true;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        const paths = [...changedPaths];
        changedPaths.clear();
        const shouldRefreshTypes = typesChanged;
        typesChanged = false;
        void loadIndex();
        for (const path of paths) void refreshCachedNote(path).catch((error) => {
          if (!controller.signal.aborted) setNotice(gatewayError(error));
        });
        if (shouldRefreshTypes) void refreshDescription();
      }, 180);
    }, controller.signal).catch((error) => {
      if (!controller.signal.aborted) setNotice(gatewayError(error));
    });
    return () => {
      controller.abort();
      window.clearTimeout(refreshTimer);
    };
  }, [gateway, loadIndex, phase, refreshCachedNote, refreshDescription]);

  const requestSave = useCallback((session: NoteSession): Promise<void> => {
    if (session.deleted) return Promise.resolve();
    if (session.remoteDocument) {
      session.saveState = "conflict";
      touchSession(session);
      return Promise.resolve();
    }
    if (session.savePromise) {
      if (sessionDirty(session)) session.saveAgain = true;
      return session.savePromise;
    }
    if (!sessionDirty(session)) {
      session.saveState = "saved";
      touchSession(session);
      return Promise.resolve();
    }

    const promise = operationQueue.current.run(session, async () => {
      do {
        session.saveAgain = false;
        if (!sessionDirty(session) || session.deleted) break;
        const snapshot = structuredClone(session.draft);
        const input: SaveNoteInput = {
          path: session.document.path,
          revision: session.document.revision,
          ...snapshot
        };
        session.activity = "saving";
        session.saveState = "saving";
        touchSession(session);
        try {
          const updated = await gateway.update(input);
          session.document = updated;
          session.persistedDraft = snapshot;
          session.error = undefined;
          session.saveState = sessionDirty(session) ? "waiting" : "saved";
          updateNoteSummary(updated);
          if (currentSession.current === session) setDocument(updated);
          touchSession(session);
        } catch (error) {
          const message = gatewayError(error);
          session.error = message;
          session.saveState = "conflict";
          session.activity = undefined;
          touchSession(session);
          setNotice(currentSession.current === session
            ? message
            : `Couldn’t save “${session.draft.title || session.document.path}”. ${message}`);
          throw error;
        }
      } while (session.saveAgain && sessionDirty(session));
      session.activity = undefined;
      session.saveState = sessionDirty(session) ? "waiting" : "saved";
      touchSession(session);
    });
    session.savePromise = promise;
    const finish = () => {
      if (session.savePromise === promise) session.savePromise = undefined;
      touchSession(session);
    };
    void promise.then(finish, finish);
    return promise;
  }, [gateway, touchSession, updateNoteSummary]);

  const flushSession = useCallback(async (session: NoteSession) => {
    if (session.remoteDocument) throw new Error("Resolve the version changed elsewhere before continuing.");
    while (!session.deleted && !session.remoteDocument && (sessionDirty(session) || session.savePromise)) await requestSave(session);
    await operationQueue.current.wait(session);
  }, [requestSave]);

  const saveCurrentInBackground = useCallback(() => {
    const session = currentSession.current;
    if (!session || (!sessionDirty(session) && !session.savePromise)) return;
    void requestSave(session).catch(() => undefined);
  }, [requestSave]);

  useEffect(() => {
    const session = currentSession.current;
    if (!document || !draft || !session || session.remoteDocument || session.document.path !== document.path || !sessionDirty(session)) return;
    if (session.saveState !== "saving") {
      session.saveState = "waiting";
      setSaveState("waiting");
    }
    const timer = window.setTimeout(() => void requestSave(session).catch(() => undefined), 650);
    return () => window.clearTimeout(timer);
  }, [document, draft, requestSave]);

  function changeActiveDraft(change: (current: Draft) => Draft) {
    const session = currentSession.current;
    if (!session || session.deleted) return;
    const next = change(session.draft);
    session.draft = next;
    if (!session.remoteDocument) {
      session.error = undefined;
      if (session.saveState !== "saving") session.saveState = "waiting";
    }
    setDraft(next);
    setSaveState(session.saveState);
    touchSession(session);
  }

  function useRemoteVersion() {
    const session = currentSession.current;
    if (!session?.remoteDocument) return;
    applyRemoteDocument(session, session.remoteDocument);
    setNotice("Loaded the latest version.");
  }

  function keepLocalVersion() {
    const session = currentSession.current;
    const remote = session?.remoteDocument;
    if (!session || !remote) return;

    const localDraft = session.draft;
    session.document = remote;
    session.persistedDraft = editableNote(remote);
    session.remoteDocument = undefined;
    session.draft = localDraft;
    session.error = undefined;
    session.saveState = "waiting";
    updateNoteSummary(remote);
    setDocument(remote);
    setDraft(localDraft);
    setSaveState("waiting");
    setNotice(undefined);
    touchSession(session);
    void requestSave(session).catch(() => undefined);
  }

  function navigateToNote(path: string) {
    const generation = ++navigationGeneration.current;
    if (path === currentSession.current?.document.path && !noteLoading) {
      setPendingNotePath(undefined);
      setMobilePane("editor");
      return;
    }
    saveCurrentInBackground();
    setPendingNotePath(path);
    setNotice(undefined);
    void openNote(path).then((opened) => {
      if (generation === navigationGeneration.current && !opened) setPendingNotePath(undefined);
    });
  }

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (operationQueue.current.pendingCount > 0
          || [...sessions.current.values()].some((session) => !session.deleted && sessionDirty(session))) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);

  const searchIndex = useMemo(() => allNotes.map((note) => ({
    note,
    text: noteSearchText(note)
  })), [allNotes]);
  const searchedNotes = useMemo(() => {
    const needle = deferredSearch.trim().toLocaleLowerCase();
    return needle ? searchIndex.filter((entry) => entry.text.includes(needle)).map((entry) => entry.note) : allNotes;
  }, [allNotes, deferredSearch, searchIndex]);
  const visibleNotes = useMemo(() => {
    if (!noteFilter) return searchedNotes;
    if (noteFilter.kind === "folder") {
      return searchedNotes.filter((note) => note.path === noteFilter.value || note.path.startsWith(`${noteFilter.value}/`));
    }
    if (noteFilter.kind === "tag") return searchedNotes.filter((note) => noteTags(note).includes(noteFilter.value));
    return searchedNotes.filter((note) => note.types.includes(noteFilter.value));
  }, [noteFilter, searchedNotes]);
  const linkTypeNames = useMemo(() => description?.types.map((type) => type.name) ?? [], [description]);
  const linkOptions = useMemo(() => linkSuggestions(allNotes, linkTypeNames), [allNotes, linkTypeNames]);
  const backlinkNotes = useMemo(() => document ? backlinksFor(document.path, allNotes) : [], [allNotes, document]);

  const runNoteOperation = useCallback(async <Result,>(
    session: NoteSession,
    activity: NoteActivity,
    operation: () => Promise<Result>
  ): Promise<Result> => operationQueue.current.run(session, async () => {
    session.activity = activity;
    touchSession(session);
    try {
      return await operation();
    } finally {
      if (session.activity === activity) session.activity = undefined;
      touchSession(session);
    }
  }), [touchSession]);

  async function connectCollection() {
    setNotice(undefined);
    try { await gateway.authorize(); } catch (error) { setNotice(gatewayError(error)); }
  }

  function beginCreate() {
    navigationGeneration.current += 1;
    setPendingNotePath(undefined);
    setNotice(undefined);
    saveCurrentInBackground();
    setSurface("notes");
    setPropertiesOpen(false);
    setBacklinksOpen(false);
    setCreatingNote(true);
    setMobilePane("editor");
  }

  async function createNote(input: CreateNoteInput) {
    const created = await gateway.create(input);
    const summary = summaryFromDocument(created);
    setAllNotes((notes) => [summary, ...notes.filter((note) => note.path !== created.path)]);
    setCollectionTotal((total) => total === undefined ? undefined : total + 1);
    setSearch("");
    setNoteFilter(undefined);
    documentGeneration.current += 1;
    setNotice(undefined);
    setPropertiesError(undefined);
    setPropertiesOpen(false);
    setBacklinksOpen(false);
    setDeleteOpen(false);
    setMobilePane("editor");
    adoptDocument(created);
  }

  async function renameNote() {
    const session = currentSession.current;
    if (!session) return;
    const nextPath = safeRenamePath(pathDraft);
    if (!nextPath || !nextPath.toLocaleLowerCase().endsWith(".md")) {
      setNotice("Use a collection-relative path ending in .md.");
      return;
    }
    if (nextPath === session.document.path) {
      setEditingPath(false);
      return;
    }
    setEditingPath(false);
    try {
      await flushSession(session);
      const previousPath = session.document.path;
      const renamed = await runNoteOperation(session, "renaming", () => gateway.rename(
        session.document.path,
        nextPath,
        session.document.revision
      ));
      session.document = renamed;
      session.error = undefined;
      sessions.current.delete(previousPath);
      sessions.current.set(renamed.path, session);
      updateNoteSummary(renamed, previousPath);
      if (currentSession.current === session) {
        setDocument(renamed);
        setSelectedPath(renamed.path);
        setPathDraft(renamed.path);
        localStorage.setItem("mdbase-editor:last-note", renamed.path);
      }
      touchSession(session);
    } catch (error) {
      const message = gatewayError(error);
      session.error = message;
      if (currentSession.current === session) setPathDraft(session.document.path);
      setNotice(currentSession.current === session
        ? message
        : `Couldn’t rename “${session.draft.title || session.document.path}”. ${message}`);
      touchSession(session);
    }
  }

  async function saveProperties(next: Record<string, unknown>) {
    const session = currentSession.current;
    if (!session) return;
    setPropertiesError(undefined);
    setPropertiesOpen(false);
    setBacklinksOpen(false);
    try {
      await flushSession(session);
      const draftBefore = session.draft;
      const updated = await runNoteOperation(session, "properties", () => gateway.updateProperties(
        session.document.path,
        propertyPatch(session.document.raw_frontmatter ?? {}, next),
        session.document.revision
      ));
      const persistedDraft = editableNote(updated);
      session.document = updated;
      session.persistedDraft = persistedDraft;
      if (draftFingerprint(session.draft) === draftFingerprint(draftBefore)) session.draft = persistedDraft;
      session.saveState = sessionDirty(session) ? "waiting" : "saved";
      session.error = undefined;
      updateNoteSummary(updated);
      if (currentSession.current === session) {
        setDocument(updated);
        setDraft(session.draft);
        setSaveState(session.saveState);
      }
      touchSession(session);
    } catch (error) {
      const message = gatewayError(error);
      session.error = message;
      setPropertiesError(message);
      setNotice(currentSession.current === session
        ? message
        : `Couldn’t update properties for “${session.draft.title || session.document.path}”. ${message}`);
      touchSession(session);
    }
  }

  async function validateNote() {
    const session = currentSession.current;
    if (!session) return;
    setNotice(undefined);
    try {
      await flushSession(session);
      const diagnostics = await runNoteOperation(
        session,
        "validating",
        () => gateway.validate(session.document.path)
      );
      if (currentSession.current === session) {
        setNotice(diagnostics.length ? diagnostics.map((item) => item.message).join(" ") : "No validation issues.");
      }
    } catch (error) {
      const message = gatewayError(error);
      setNotice(currentSession.current === session
        ? message
        : `Couldn’t check “${session.draft.title || session.document.path}”. ${message}`);
    }
  }

  function deleteNote() {
    const session = currentSession.current;
    if (!session) return;
    const path = session.document.path;
    const next = allNotes.find((note) => note.path !== path);
    session.deleted = true;
    setDeleteOpen(false);
    if (currentSession.current === session) {
      currentSession.current = undefined;
      setDocument(undefined);
      setDraft(undefined);
      setSelectedPath(undefined);
      if (next) void openNote(next.path);
    }
    void (async () => {
      try {
        await runNoteOperation(session, "deleting", () => gateway.delete(
          session.document.path,
          session.document.revision
        ));
        sessions.current.delete(path);
        setAllNotes((notes) => notes.filter((note) => note.path !== path));
        setCollectionTotal((total) => total === undefined ? undefined : Math.max(0, total - 1));
      } catch (error) {
        session.deleted = false;
        session.error = gatewayError(error);
        setNotice(`Couldn’t delete “${session.draft.title || path}”. ${session.error}`);
        touchSession(session);
      }
    })();
  }

  function selectSurface(next: Surface) {
    navigationGeneration.current += 1;
    setPendingNotePath(undefined);
    saveCurrentInBackground();
    setSurface(next);
    setCreatingNote(false);
    setPropertiesOpen(false);
    setBacklinksOpen(false);
    setMobilePane(next === "settings" ? "editor" : "notes");
  }

  async function disconnect() {
    navigationGeneration.current += 1;
    setPendingNotePath(undefined);
    try {
      await Promise.all([...sessions.current.values()]
        .filter((session) => !session.deleted)
        .map((session) => flushSession(session)));
      await operationQueue.current.waitForIdle();
      gateway.disconnect();
      currentSession.current = undefined;
      sessions.current.clear();
      setPhase("disconnected");
      setAllNotes([]);
      setFoldersLoading(false);
      setDocument(undefined);
      setDraft(undefined);
    } catch (error) {
      setNotice(gatewayError(error));
    }
  }

  if (phase === "starting") return <OpeningScreen />;
  if (phase === "disconnected") return <ConnectScreen notice={notice} onConnect={() => void connectCollection()} />;
  if (phase === "loading" || !description) return <OpeningScreen />;

  const selectedType = description.types.find((type) => type.name === selectedTypeName);
  const hasListPane = surface !== "settings";
  const mobileLayout = viewportWidth <= 760;
  const collectionTrack = layout.collectionCollapsed ? 0 : layout.collectionWidth;
  const listTrack = hasListPane && !layout.listCollapsed ? layout.listWidth : 0;
  const editorMinimum = viewportWidth <= 1120 ? 320 : 380;
  const inspectorVisible = propertiesOpen || backlinksOpen;
  const inspectorWidth = inspectorVisible && viewportWidth > 1120 ? 340 : 0;
  const collectionResizeMax = Math.max(COLLECTION_WIDTH.min, Math.min(
    COLLECTION_WIDTH.max,
    viewportWidth - listTrack - editorMinimum - inspectorWidth
  ));
  const listResizeMax = Math.max(LIST_WIDTH.min, Math.min(
    LIST_WIDTH.max,
    viewportWidth - collectionTrack - editorMinimum - inspectorWidth
  ));
  const listName = surface === "types" ? "types" : "notes";
  const activeRemoteDocument = currentSession.current?.remoteDocument;
  const editorNotice = activeRemoteDocument ? currentSession.current?.error : notice;
  const editorLeadingActions = layout.listCollapsed ? <>
    {layout.collectionCollapsed && <PaneControl label="Show collections sidebar" action="show" onClick={() => setLayout((current) => ({ ...current, collectionCollapsed: false }))} />}
    <PaneControl label={`Show ${listName} sidebar`} action="show" onClick={() => setLayout((current) => ({ ...current, listCollapsed: false }))} />
  </> : undefined;
  const noteStatuses = new Map<string, NoteRowStatus>();
  for (const session of sessions.current.values()) {
    const status = noteRowStatus(session);
    if (status) noteStatuses.set(session.document.path, status);
  }
  return <div
    className={`app-shell surface-${surface} pane-${mobilePane}${inspectorVisible ? " inspector-visible" : ""}${layout.collectionCollapsed ? " collection-pane-collapsed" : ""}${hasListPane && layout.listCollapsed ? " list-pane-collapsed" : ""}${hasListPane ? "" : " no-list-pane"}${resizingPane ? " resizing-pane" : ""}`}
    style={{ "--collection-track": `${collectionTrack}px`, "--list-track": `${listTrack}px` } as CSSProperties}
  >
    {(!layout.collectionCollapsed || mobileLayout) && <CollectionRail
      name={description.display_name}
      count={collectionTotal ?? allNotes.length}
      typeCount={description.types.length}
      typeNames={description.types.map((type) => type.name)}
      activeFilter={noteFilter}
      notes={allNotes}
      foldersLoading={foldersLoading}
      surface={surface}
      onFilter={(filter) => { setNoteFilter(filter); selectSurface("notes"); }}
      onTypes={() => selectSurface("types")}
      onSettings={() => selectSurface("settings")}
      onDisconnect={() => void disconnect()}
      onCollapse={() => setLayout((current) => ({ ...current, collectionCollapsed: true }))}
    />}

    {surface === "notes" && <>
      {(!layout.listCollapsed || mobileLayout) && <NoteList
        notes={visibleNotes}
        loading={listLoading}
        structureLoading={foldersLoading}
        total={noteFilter ? undefined : collectionTotal}
        selectedPath={selectedPath}
        pendingPath={pendingNotePath}
        statuses={noteStatuses}
        search={search}
        collectionName={filterLabel(noteFilter, description.display_name)}
        onSearch={setSearch}
        onSelect={navigateToNote}
        onCreate={beginCreate}
        onCollections={() => setMobilePane("collections")}
        leadingActions={layout.collectionCollapsed && <PaneControl label="Show collections sidebar" action="show" onClick={() => setLayout((current) => ({ ...current, collectionCollapsed: false }))} />}
        trailingActions={<PaneControl label="Hide notes sidebar" action="hide" onClick={() => setLayout((current) => ({ ...current, listCollapsed: true }))} />}
      />}
      {creatingNote ? <NewNoteComposer
        types={description.types}
        defaultFolder={noteFilter?.kind === "folder" ? noteFilter.value : undefined}
        leadingActions={editorLeadingActions}
        onCreate={createNote}
        onCancel={() => { setCreatingNote(false); setMobilePane("notes"); }}
      /> : <main className="editor-pane" aria-label="Note editor">
        {noteLoading ? <NoteSkeleton leadingActions={editorLeadingActions} /> : document && draft ? <>
          <header className="editor-bar">
            <button className="mobile-back icon-button" aria-label="Back to notes" onClick={() => setMobilePane("notes")}><ArrowLeft aria-hidden="true" /></button>
            {editorLeadingActions}
            <div className="path-wrap">
              {editingPath ? <form onSubmit={(event) => { event.preventDefault(); void renameNote(); }}>
                <label className="sr-only" htmlFor="note-path">Markdown path</label>
                <input id="note-path" className="path-input" value={pathDraft} onChange={(event) => setPathDraft(event.target.value)} onBlur={() => void renameNote()} autoFocus />
              </form> : <button className="path-button" onClick={() => setEditingPath(true)} title="Rename Markdown file">{document.path}</button>}
            </div>
            {preferences.vim && <span className="vim-label">Vim</span>}
            <SaveIndicator state={saveState} />
            <button className={`icon-button backlink-button${backlinksOpen ? " active" : ""}`} aria-label="Backlinks" aria-pressed={backlinksOpen} onClick={() => {
              setBacklinksOpen((value) => {
                if (!value) setPropertiesOpen(false);
                return !value;
              });
            }}><Link2 aria-hidden="true" />{backlinkNotes.length > 0 && <span>{backlinkNotes.length}</span>}</button>
            <button className={`icon-button${propertiesOpen ? " active" : ""}`} aria-label="Note properties" aria-pressed={propertiesOpen} onClick={() => {
              setPropertiesOpen((value) => {
                if (!value) setBacklinksOpen(false);
                return !value;
              });
            }}><Info aria-hidden="true" /></button>
            <details className="note-actions">
              <summary className="icon-button" aria-label="More note actions"><MoreHorizontal aria-hidden="true" /></summary>
              <div className="action-menu">
                <button onClick={(event) => { closeActionMenu(event.currentTarget); void validateNote(); }}><Check aria-hidden="true" /> Check note</button>
                <button className="danger-action" onClick={(event) => { closeActionMenu(event.currentTarget); setDeleteOpen(true); }}><Trash2 aria-hidden="true" /> Delete note</button>
              </div>
            </details>
          </header>
          {editorNotice && <div className={`notice${activeRemoteDocument ? " remote-change-notice" : ""}`} role={activeRemoteDocument ? "alert" : "status"}>
            <CircleAlert aria-hidden="true" />
            <span>{editorNotice}</span>
            {activeRemoteDocument ? <div className="notice-actions">
              <button onClick={useRemoteVersion}>Use remote</button>
              <button className="primary-notice-action" onClick={keepLocalVersion}>Keep my edits</button>
            </div> : <button aria-label="Dismiss message" onClick={() => setNotice(undefined)}><X aria-hidden="true" /></button>}
          </div>}
          {deleteOpen && <div className="delete-confirm" role="alert"><span>Delete this note from the collection?</span><button onClick={() => setDeleteOpen(false)}>Keep note</button><button className="danger-action" onClick={() => void deleteNote()}>Delete</button></div>}
          <article className="writing-surface" style={{ "--editor-font-size": `${preferences.fontSize}px` } as CSSProperties}>
            <label className="sr-only" htmlFor="note-title">Note title</label>
            <input id="note-title" className="title-input" value={draft.title} onChange={(event) => changeActiveDraft((current) => ({ ...current, title: event.target.value }))} placeholder="Untitled" spellCheck="true" />
            <CodeEditor
              key={document.path}
              value={draft.body}
              onChange={(body) => changeActiveDraft((current) => ({ ...current, body }))}
              label="Note body"
              language="markdown"
              placeholder="Start writing"
              vimEnabled={preferences.vim}
              lineWrapping={preferences.lineWrapping}
              autoFocus
              className="body-editor"
              linkSuggestions={linkOptions}
              linkTypes={linkTypeNames}
            />
          </article>
        </> : <EmptyEditor leadingActions={editorLeadingActions} onCreate={beginCreate} />}
      </main>}
      {propertiesOpen && document && <PropertiesPanel key={document.path} note={document} types={description.types} error={propertiesError} onClose={() => setPropertiesOpen(false)} onSave={(value) => void saveProperties(value)} />}
      {backlinksOpen && document && <BacklinksPanel notes={backlinkNotes} loading={foldersLoading} onClose={() => setBacklinksOpen(false)} onOpen={navigateToNote} />}
    </>}

    {surface === "types" && <>
      {(!layout.listCollapsed || mobileLayout) && <TypeList
        types={description.types}
        selectedName={selectedTypeName}
        leadingActions={layout.collectionCollapsed && <PaneControl label="Show collections sidebar" action="show" onClick={() => setLayout((current) => ({ ...current, collectionCollapsed: false }))} />}
        trailingActions={<PaneControl label="Hide types sidebar" action="hide" onClick={() => setLayout((current) => ({ ...current, listCollapsed: true }))} />}
        onSelect={(name) => { setSelectedTypeName(name); setMobilePane("editor"); }}
        onCollections={() => setMobilePane("collections")}
      />}
      <TypeInspector type={selectedType} leadingActions={editorLeadingActions} onBack={() => setMobilePane("notes")} />
    </>}

    {surface === "settings" && <SettingsView
      description={description}
      noteCount={allNotes.length}
      preferences={preferences}
      leadingActions={layout.collectionCollapsed && <PaneControl label="Show collections sidebar" action="show" onClick={() => setLayout((current) => ({ ...current, collectionCollapsed: false }))} />}
      onChange={setPreferences}
      onBack={() => setMobilePane("collections")}
    />}

    {(!layout.collectionCollapsed || (hasListPane && !layout.listCollapsed)) && <aside className="pane-resizers" aria-label="Sidebar layout controls">
      {!layout.collectionCollapsed && <PaneResizeHandle
        className="collection-resizer"
        label="Resize collections sidebar"
        value={layout.collectionWidth}
        min={COLLECTION_WIDTH.min}
        max={collectionResizeMax}
        onChange={(collectionWidth) => setLayout((current) => ({ ...current, collectionWidth }))}
        onReset={() => setLayout((current) => ({ ...current, collectionWidth: COLLECTION_WIDTH.default }))}
        onDragChange={(dragging) => setResizingPane(dragging ? "collection" : undefined)}
      />}
      {hasListPane && !layout.listCollapsed && <PaneResizeHandle
        className="list-resizer"
        label={`Resize ${listName} sidebar`}
        value={layout.listWidth}
        min={LIST_WIDTH.min}
        max={listResizeMax}
        onChange={(listWidth) => setLayout((current) => ({ ...current, listWidth }))}
        onReset={() => setLayout((current) => ({ ...current, listWidth: LIST_WIDTH.default }))}
        onDragChange={(dragging) => setResizingPane(dragging ? "list" : undefined)}
      />}
    </aside>}
  </div>;
}

function ConnectScreen({ notice, onConnect }: { notice?: string; onConnect: () => void }) {
  return <main className="connect-screen"><section><Wordmark /><h1>Your notes,<br />as files.</h1><p className="connect-copy">Open a local or hosted mdbase collection and write.</p><button className="connect-button" onClick={onConnect}>Choose a collection <ChevronRight aria-hidden="true" /></button><p className="access-copy">Choose the collection in mdbase connect, then approve view, create, edit, move, validate, and delete access. Hosted collections stay available without your computer; local collections remain under its connector.</p>{notice && <p className="connect-error" role="alert">{notice}</p>}</section></main>;
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

function CollectionRail({ name, count, typeCount, typeNames, activeFilter, notes, foldersLoading, surface, onFilter, onTypes, onSettings, onDisconnect, onCollapse }: {
  name: string;
  count: number;
  typeCount: number;
  typeNames: string[];
  activeFilter?: NoteFilter;
  notes: NoteSummary[];
  foldersLoading: boolean;
  surface: Surface;
  onFilter: (filter?: NoteFilter) => void;
  onTypes: () => void;
  onSettings: () => void;
  onDisconnect: () => void;
  onCollapse: () => void;
}) {
  const collectionFolders = folders(notes);
  const tagFacets = collectionTags(notes);
  const typeFacets = collectionTypes(notes, typeNames);
  return <aside className="collection-rail" aria-label="Collection navigation">
    <div className="rail-header"><Wordmark /><PaneControl label="Hide collections sidebar" action="hide" onClick={onCollapse} /></div>
    <nav>
      <p className="collection-name">{name}</p>
      <button className={surface === "notes" && !activeFilter ? "selected" : ""} onClick={() => onFilter(undefined)}><span><NotebookPen aria-hidden="true" />Notes</span><small>{count}</small></button>
      <button className={surface === "types" ? "selected" : ""} onClick={onTypes}><span><Braces aria-hidden="true" />Schemas</span><small>{typeCount}</small></button>
      <button className={surface === "settings" ? "selected" : ""} onClick={onSettings}><span><Settings2 aria-hidden="true" />Settings</span></button>
      <RailFilterSection label="Folders" kind="folder" items={collectionFolders} activeFilter={surface === "notes" ? activeFilter : undefined} loading={foldersLoading} defaultOpen onFilter={onFilter} />
      <RailFilterSection label="Tags" kind="tag" items={tagFacets} activeFilter={surface === "notes" ? activeFilter : undefined} loading={foldersLoading} onFilter={onFilter} />
      <RailFilterSection label="Types" kind="type" items={typeFacets} activeFilter={surface === "notes" ? activeFilter : undefined} loading={foldersLoading} onFilter={onFilter} />
    </nav>
    <footer className="connection-footer">
      <p role="status" aria-label="Collection connected"><span className="status-dot" aria-hidden="true" /><span>Connected</span></p>
      <button className="disconnect-action" aria-label="Disconnect collection" title="Disconnect collection" onClick={onDisconnect}>
        <LogOut aria-hidden="true" /><span>Disconnect</span>
      </button>
    </footer>
  </aside>;
}

function RailFilterSection({ label, kind, items, activeFilter, loading, defaultOpen = false, onFilter }: {
  label: string;
  kind: NoteFilter["kind"];
  items: Array<{ name: string; count: number }>;
  activeFilter?: NoteFilter;
  loading: boolean;
  defaultOpen?: boolean;
  onFilter: (filter: NoteFilter) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const Icon = kind === "folder" ? Folder : kind === "tag" ? Tag : Braces;
  const listId = `rail-${kind}-filters`;
  return <div className="rail-filter-section" role="group" aria-label={label} aria-busy={loading}>
    <button className="rail-section-toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((value) => !value)}>
      <span>{open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}{label}</span>
      {loading && <span className="folder-loading" role="status"><i aria-hidden="true" />Loading</span>}
    </button>
    {open && <div id={listId} className="rail-filter-items">
      {items.map((item) => <button key={item.name} className={activeFilter?.kind === kind && activeFilter.value === item.name ? "selected" : ""} onClick={() => onFilter({ kind, value: item.name })}>
        <span><Icon aria-hidden="true" />{kind === "tag" ? `#${item.name}` : item.name}</span>
        <small aria-label={facetCountLabel(kind, item, loading)}>{item.count}{loading && "+"}</small>
      </button>)}
      {!items.length && <p className="folder-placeholder">{loading ? `Finding ${label.toLocaleLowerCase()}…` : `No ${label.toLocaleLowerCase()}`}</p>}
    </div>}
  </div>;
}

function facetCountLabel(kind: NoteFilter["kind"], item: { name: string; count: number }, loading: boolean): string {
  const subject = kind === "folder" ? `in ${item.name}` : kind === "tag" ? `tagged ${item.name}` : `with type ${item.name}`;
  return `${item.count}${loading ? " or more" : ""} ${item.count === 1 && !loading ? "note" : "notes"} ${subject}`;
}

function NoteList({ notes, selectedPath, pendingPath, statuses, search, collectionName, loading, structureLoading, total, leadingActions, trailingActions, onSearch, onSelect, onCreate, onCollections }: {
  notes: NoteSummary[];
  selectedPath?: string;
  pendingPath?: string;
  statuses: Map<string, NoteRowStatus>;
  search: string;
  collectionName: string;
  loading: boolean;
  structureLoading: boolean;
  total?: number;
  leadingActions?: React.ReactNode;
  trailingActions?: React.ReactNode;
  onSearch: (value: string) => void;
  onSelect: (path: string) => void;
  onCreate: () => void;
  onCollections: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({ count: notes.length, getScrollElement: () => scrollRef.current, estimateSize: () => 76, overscan: 8 });
  return <section className="note-list-pane" aria-label="Notes">
    <header className="list-header"><button className="mobile-collections icon-button" aria-label="Collections" onClick={onCollections}><PanelLeft aria-hidden="true" /></button>{leadingActions}<div><h1>{collectionName}</h1><p aria-live="polite">{noteCountLabel(notes.length, loading, structureLoading, total, Boolean(search))}</p></div>{trailingActions}<button className="icon-button new-note" aria-label="New note" onClick={onCreate}><FilePlus2 aria-hidden="true" /></button></header>
    <label className="search-field"><Search aria-hidden="true" /><span className="sr-only">Search every note</span><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search" />{search && <button aria-label="Clear search" onClick={() => onSearch("")}><X aria-hidden="true" /></button>}</label>
    <div className="note-scroll" ref={scrollRef} role="listbox" aria-label="Collection notes" aria-busy={structureLoading}>
      {notes.length ? <div className="virtual-list" style={{ height: virtualizer.getTotalSize() }}>{virtualizer.getVirtualItems().map((virtualRow) => {
        const note = notes[virtualRow.index];
        const status: NoteRowStatus | undefined = pendingPath === note.path
          ? { label: "Opening", tone: "busy", busy: true }
          : statuses.get(note.path);
        return <button key={note.path} role="option" aria-selected={note.path === selectedPath} aria-busy={status?.busy || undefined} aria-disabled={status?.disabled || undefined} className={`note-row${note.path === selectedPath ? " selected" : ""}${status ? ` ${status.tone}` : ""}`} onClick={() => { if (!status?.disabled) onSelect(note.path); }} style={{ transform: `translateY(${virtualRow.start}px)`, height: virtualRow.size }}><span className="note-title">{noteTitle(note)}</span>{status ? <span className="note-transition">{status.label}</span> : <span className="note-detail"><time>{noteTimestamp(note)}</time>{notePreview(note)}</span>}</button>;
      })}</div> : structureLoading ? <NoteListSkeleton /> : <div className="list-empty"><p>{search ? "No notes found." : "This collection is empty."}</p>{!search && <button onClick={onCreate}>Create the first note</button>}</div>}
    </div>
  </section>;
}

function NoteListSkeleton() {
  return <div className="note-list-skeleton" aria-hidden="true">{Array.from({ length: 8 }, (_, index) => <div key={index}><span /><small /></div>)}</div>;
}

function noteCountLabel(count: number, loading: boolean, structureLoading: boolean, total: number | undefined, searching: boolean): string {
  if (loading && searching) return count ? `${count.toLocaleString()} found so far` : "Searching";
  if (structureLoading && count === 0) return "Reading notes";
  if (structureLoading) return `${count.toLocaleString()} of ${total?.toLocaleString() ?? "…"} notes`;
  if (loading) return `${count.toLocaleString()} notes · indexing search`;
  return `${count.toLocaleString()} ${count === 1 ? "note" : "notes"}`;
}

function filterLabel(filter: NoteFilter | undefined, fallback: string): string {
  if (!filter) return fallback;
  return filter.kind === "tag" ? `#${filter.value}` : filter.value;
}

function SaveIndicator({ state }: { state: SaveState }) {
  const label = state === "saving" ? "Saving" : state === "waiting" ? "Unsaved" : state === "conflict" ? "Needs attention" : "Saved";
  return <span className={`save-state ${state}`} aria-live="polite">{state === "saved" && <Check aria-hidden="true" />}{label}</span>;
}

function BacklinksPanel({ notes, loading, onClose, onOpen }: {
  notes: NoteSummary[];
  loading: boolean;
  onClose: () => void;
  onOpen: (path: string) => void;
}) {
  return <aside className="backlinks-panel" aria-label="Backlinks" aria-busy={loading}>
    <header className="panel-header">
      <div><h2>Backlinks</h2><p>{loading ? "Finding references" : `${notes.length} ${notes.length === 1 ? "note" : "notes"} link here`}</p></div>
      <button className="icon-button" aria-label="Close backlinks" onClick={onClose}><X aria-hidden="true" /></button>
    </header>
    <div className="backlink-list">
      {notes.map((note) => <button key={note.path} onClick={() => onOpen(note.path)}>
        <Link2 aria-hidden="true" />
        <span><strong>{noteTitle(note)}</strong><small>{note.path}</small></span>
      </button>)}
      {!notes.length && <p className="quiet-empty">{loading ? "Reading collection links…" : "No notes link here yet."}</p>}
    </div>
  </aside>;
}

function NoteSkeleton({ leadingActions }: { leadingActions?: React.ReactNode }) {
  return <div className="note-skeleton" aria-label="Loading note" aria-busy="true"><div className="skeleton-bar">{leadingActions}<span /></div><div className="skeleton-document"><span className="skeleton-title" /><span /><span /><span className="short" /></div></div>;
}

function EmptyEditor({ leadingActions, onCreate }: { leadingActions?: React.ReactNode; onCreate: () => void }) {
  return <div className="empty-editor">{leadingActions && <div className="empty-pane-actions">{leadingActions}</div>}<p>Select a note, or start a new one.</p><button onClick={onCreate}>New note</button></div>;
}

function PaneControl({ label, action, onClick }: { label: string; action: "show" | "hide"; onClick: () => void }) {
  const Icon = action === "show" ? PanelLeftOpen : PanelLeftClose;
  return <button className="icon-button desktop-pane-control" aria-label={label} title={label} onClick={onClick}><Icon aria-hidden="true" /></button>;
}

function closeActionMenu(action: HTMLButtonElement) {
  action.closest("details")?.removeAttribute("open");
}

function PaneResizeHandle({ className, label, value, min, max, onChange, onReset, onDragChange }: {
  className: string;
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  onReset: () => void;
  onDragChange: (dragging: boolean) => void;
}) {
  const drag = useRef<{ pointerId: number; startX: number; startValue: number } | undefined>(undefined);
  const boundedMax = Math.max(min, max);
  const setBoundedValue = (next: number) => onChange(Math.round(Math.min(boundedMax, Math.max(min, next))));

  function finishDrag(element: HTMLDivElement, pointerId: number) {
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    drag.current = undefined;
    onDragChange(false);
  }

  return <div
    className={`pane-resizer ${className}`}
    role="separator"
    aria-label={label}
    aria-orientation="vertical"
    aria-valuemin={min}
    aria-valuemax={boundedMax}
    aria-valuenow={Math.min(boundedMax, Math.max(min, value))}
    aria-valuetext={`${Math.round(value)} pixels`}
    title="Drag to resize · Double-click to reset"
    tabIndex={0}
    onDoubleClick={onReset}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      drag.current = { pointerId: event.pointerId, startX: event.clientX, startValue: value };
      event.currentTarget.setPointerCapture(event.pointerId);
      onDragChange(true);
    }}
    onPointerMove={(event) => {
      if (!drag.current || drag.current.pointerId !== event.pointerId) return;
      setBoundedValue(drag.current.startValue + event.clientX - drag.current.startX);
    }}
    onPointerUp={(event) => {
      if (drag.current?.pointerId === event.pointerId) finishDrag(event.currentTarget, event.pointerId);
    }}
    onPointerCancel={(event) => {
      if (drag.current?.pointerId === event.pointerId) finishDrag(event.currentTarget, event.pointerId);
    }}
    onKeyDown={(event) => {
      const step = event.shiftKey ? 24 : 8;
      let next: number | undefined;
      if (event.key === "ArrowLeft") next = value - step;
      if (event.key === "ArrowRight") next = value + step;
      if (event.key === "Home") next = min;
      if (event.key === "End") next = boundedMax;
      if (next === undefined) return;
      event.preventDefault();
      setBoundedValue(next);
    }}
  />;
}

function draftFingerprint(draft: Draft): string {
  return JSON.stringify([draft.title, draft.body, draft.source]);
}

function sessionDirty(session: NoteSession): boolean {
  return draftFingerprint(session.draft) !== draftFingerprint(session.persistedDraft);
}

function noteRowStatus(session: NoteSession): NoteRowStatus | undefined {
  if (session.deleted) return { label: "Deleting", tone: "busy", busy: true, disabled: true };
  if (session.remoteDocument) return { label: "Changed elsewhere", tone: "error", busy: false };
  if (session.activity) {
    const labels: Record<NoteActivity, string> = {
      saving: "Saving",
      properties: "Updating properties",
      renaming: "Renaming",
      deleting: "Deleting",
      validating: "Checking"
    };
    return { label: labels[session.activity], tone: "busy", busy: true };
  }
  if (session.saveState === "conflict") return { label: "Save failed", tone: "error", busy: false };
  if (session.error) return { label: "Needs attention", tone: "error", busy: false };
  if (session.saveState === "waiting") return { label: "Unsaved", tone: "quiet", busy: false };
  return undefined;
}

function summaryFromDocument(document: NoteDocument): NoteSummary {
  const { revision: _revision, raw_frontmatter: _rawFrontmatter, ...summary } = document;
  return summary;
}

function noteSearchText(note: NoteSummary): string {
  const values: string[] = [note.path, note.body ?? "", ...note.types];
  collectSearchValues(note.frontmatter, values);
  return values.join("\n").toLocaleLowerCase();
}

function collectSearchValues(value: unknown, values: string[]) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    values.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSearchValues(item, values);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectSearchValues(item, values);
  }
}
