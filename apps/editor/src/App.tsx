import {
  ArrowCounterClockwiseIcon as Undo2,
  ArrowLeftIcon as ArrowLeft,
  ArrowRightIcon as ArrowRight,
  BracketsCurlyIcon as Braces,
  CaretDownIcon as ChevronDown,
  CaretRightIcon as ChevronRight,
  CheckIcon as Check,
  CopyIcon as Copy,
  FilePlusIcon as FilePlus2,
  FolderIcon as Folder,
  FolderPlusIcon as FolderPlus,
  GearSixIcon as Settings2,
  InfoIcon as Info,
  KeyboardIcon as Keyboard,
  LinkIcon as Link2,
  MagnifyingGlassIcon as Search,
  NotebookIcon as NotebookPen,
  PencilSimpleIcon as Pencil,
  SidebarSimpleIcon as PanelLeft,
  SidebarSimpleIcon as PanelLeftClose,
  SidebarSimpleIcon as PanelLeftOpen,
  TagIcon as Tag,
  TrashIcon as Trash2,
  WarningCircleIcon as CircleAlert,
  XIcon as X
} from "./icons";
import { useVirtualizer } from "@tanstack/react-virtual";
import { MdbaseConnectError, type CollectionChange, type CollectionDescription, type CollectionTypeDescriptor, type MutationProgress } from "@mdbase/connect";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  lazy,
  useMemo,
  useRef,
  useState,
  Suspense,
  type CSSProperties,
  type ReactNode
} from "react";
import { ActionMenu } from "./ActionMenu";
import { ContextMenu } from "./ContextMenu";
import { ConflictResolver } from "./ConflictResolver";
import { ConfirmDialog, Dialog } from "./Dialog";
import {
  loadContractCatalog,
  loadTypePackProvision,
  type ContractCatalog,
  type ContractCatalogPack
} from "./contract-catalog";
import { gatewayError, missingCoreOperations, missingTypeOperations } from "./gateway";
import { backlinksFor, linkSuggestions, unresolvedNoteTarget } from "./links";
import {
  COLLECTION_WIDTH,
  INSPECTOR_WIDTH,
  LIST_WIDTH,
  loadLayoutPreferences,
  saveLayoutPreferences,
  type LayoutPreferences
} from "./layout-preferences";
import type {
  CollectionGateway,
  CollectionSessionSnapshot,
  ConnectionSummary,
  CreateNoteInput,
  NoteDocument,
  NoteListProgress,
  NoteSummary,
  SaveNoteInput,
  TypeDocument,
  TitleSource
} from "./model";
import {
  editableNote,
  folderTree,
  noteTags,
  notePreview,
  noteTimestamp,
  noteTitle,
  safeRenamePath,
  tags as collectionTags,
  types as collectionTypes
} from "./note";
import type { FolderTreeNode } from "./note";
import { loadNoteSort, noteSortSummary, saveNoteSort, sortNotes, type NoteSort } from "./note-list-view";
import { NewNoteComposer } from "./NewNoteComposer";
import {
  NotePreviewCard,
  notePreviewPopoverId,
  useNotePreview,
  type NotePreviewAnchor,
  type NotePreviewSource
} from "./NotePreview";
import { NoteListViewOptions } from "./NoteListViewOptions";
import {
  buildNoteSearchIndex,
  searchNoteResults,
  searchTextRanges,
  type NoteSearchContext
} from "./note-search";
import { KeyedOperationQueue } from "./operation-queue";
import { loadPreferences, savePreferences, type EditorPreferences } from "./preferences";
import { collectionTypeIcon, isPhosphorIconName, PhosphorIcon } from "./PhosphorIcon";
import { composeRecordSource, replaceDocumentFrontmatter } from "./record-source";
import { QuickOpen, ShortcutHelp } from "./QuickOpen";
import { SearchMatchText } from "./SearchMatchText";
import { SettingsView } from "./SettingsView";
import { NEW_TYPE_SOURCE } from "./type-constants";

const TypeList = lazy(() => import("./TypeBrowser").then((module) => ({ default: module.TypeList })));
const TypeInspector = lazy(() => import("./TypeBrowser").then((module) => ({ default: module.TypeInspector })));
const TypePackBrowser = lazy(() => import("./TypeBrowser").then((module) => ({ default: module.TypePackBrowser })));
const CodeEditor = lazy(() => import("./CodeEditor").then((module) => ({ default: module.CodeEditor })));
const PropertiesPanel = lazy(() => import("./PropertiesPanel").then((module) => ({ default: module.PropertiesPanel })));
const emptyTypeDescriptors: CollectionTypeDescriptor[] = [];

type AppPhase = "starting" | "disconnected" | "loading" | "ready";
type SaveState = "saved" | "waiting" | "saving" | "conflict";
type MobilePane = "collections" | "notes" | "editor";
type Surface = "notes" | "types" | "settings";
type NoteActivity = "saving" | "properties" | "renaming" | "moving" | "deleting" | "validating";
type NoteFilter = { kind: "folder" | "tag" | "type"; value: string };
type ConnectionState = "connected" | "reconnecting";
type ContractCatalogLoadState =
  | { status: "idle" | "loading" }
  | { status: "ready"; catalog: ContractCatalog }
  | { status: "error"; message: string };

interface Confirmation {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  onConfirm: () => void | Promise<void>;
}

interface MobileHistoryState {
  mdbaseEditor: true;
  pane: MobilePane;
  surface: Surface;
}

interface Draft {
  title: string;
  body: string;
  source: TitleSource;
}

interface CreationContext {
  folder?: string;
  tag?: string;
  type?: string;
}

interface NoteSession {
  editorSessionKey: string;
  document: NoteDocument;
  draft: Draft;
  persistedDraft: Draft;
  remoteDocument?: NoteDocument;
  saveState: SaveState;
  activity?: NoteActivity;
  activityDetail?: string;
  mutationController?: AbortController;
  mutationCancellable?: boolean;
  error?: string;
  deleted?: boolean;
  saveAgain?: boolean;
  savePromise?: Promise<void>;
}

let noteEditorSession = 0;

interface NoteRowStatus {
  label: string;
  tone: "quiet" | "busy" | "error";
  busy: boolean;
  disabled?: boolean;
}

interface RenamePlan {
  session: NoteSession;
  from: string;
  to: string;
  affectedPaths: string[];
  warnings: string[];
}

interface DeletePlan {
  session: NoteSession;
  brokenLinkPaths: string[];
}

interface PendingRenameRecovery {
  plan: RenamePlan;
  updateRefs: boolean;
}

type RecoveryAction =
  | { kind: "delete"; document: NoteDocument }
  | { kind: "rename"; from: string; to: string };

interface NoteNavigationHistory {
  paths: string[];
  index: number;
}

interface NoteNavigationOptions {
  historyIndex?: number;
}

export function App({ gateway }: { gateway: CollectionGateway }) {
  const [phase, setPhase] = useState<AppPhase>("starting");
  const [description, setDescription] = useState<CollectionDescription>();
  const [allNotes, setAllNotes] = useState<NoteSummary[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [contentComplete, setContentComplete] = useState(false);
  const [contentIndexing, setContentIndexing] = useState(false);
  const [contentLoaded, setContentLoaded] = useState(0);
  const [contentError, setContentError] = useState<string>();
  const [sessionSnapshot, setSessionSnapshot] = useState<CollectionSessionSnapshot>(() => gateway.sessionSnapshot());
  const connectionSummary = sessionSnapshot.status === "ready" ? sessionSnapshot.connection : null;
  const [connectionState, setConnectionState] = useState<ConnectionState>("connected");
  const [connectionIssue, setConnectionIssue] = useState<string>();
  const [directAccessBusy, setDirectAccessBusy] = useState(false);
  const [connectionRetry, setConnectionRetry] = useState(0);
  const [collectionTotal, setCollectionTotal] = useState<number>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [document, setDocument] = useState<NoteDocument>();
  const [draft, setDraft] = useState<Draft>();
  const [noteLoading, setNoteLoading] = useState(false);
  const [pendingNotePath, setPendingNotePath] = useState<string>();
  const [creationMode, setCreationMode] = useState<"note" | "folder">();
  const [creationContext, setCreationContext] = useState<CreationContext>({});
  const [creationDirty, setCreationDirty] = useState(false);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [noteFilter, setNoteFilter] = useState<NoteFilter>();
  const [surface, setSurface] = useState<Surface>("notes");
  const [selectedTypeName, setSelectedTypeName] = useState<string>();
  const [typeWorkspace, setTypeWorkspace] = useState<"definition" | "packs">("definition");
  const [typeDocument, setTypeDocument] = useState<TypeDocument>();
  const [typeSource, setTypeSource] = useState("");
  const [typeCreating, setTypeCreating] = useState(false);
  const [typeLoading, setTypeLoading] = useState(false);
  const [typeSaving, setTypeSaving] = useState(false);
  const [typeError, setTypeError] = useState<string>();
  const [contractCatalog, setContractCatalog] = useState<ContractCatalogLoadState>({ status: "idle" });
  const [contractCatalogReload, setContractCatalogReload] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [notice, setNotice] = useState<string>();
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [backlinksOpen, setBacklinksOpen] = useState(false);
  const [propertiesError, setPropertiesError] = useState<string>();
  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const [deletePlan, setDeletePlan] = useState<DeletePlan>();
  const [renamePlan, setRenamePlan] = useState<RenamePlan>();
  const [pendingRenameRecovery, setPendingRenameRecovery] = useState<PendingRenameRecovery>();
  const [recoveryAction, setRecoveryAction] = useState<RecoveryAction>();
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [collectionSwitcherOpen, setCollectionSwitcherOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [recentPaths, setRecentPaths] = useState(loadRecentPaths);
  const [noteHistoryState, setNoteHistoryState] = useState<NoteNavigationHistory>({ paths: [], index: -1 });
  const [mobilePane, setMobilePane] = useState<MobilePane>("notes");
  const [preferences, setPreferences] = useState<EditorPreferences>(loadPreferences);
  const [layout, setLayout] = useState<LayoutPreferences>(loadLayoutPreferences);
  const [noteSort, setNoteSort] = useState<NoteSort>(loadNoteSort);
  const [resizingPane, setResizingPane] = useState<"collection" | "list" | "inspector">();
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [, setSessionTick] = useState(0);
  const indexGeneration = useRef(0);
  const documentGeneration = useRef(0);
  const navigationGeneration = useRef(0);
  const typeGeneration = useRef(0);
  const allNotesRef = useRef<NoteSummary[]>([]);
  const typeDescriptorsRef = useRef<CollectionTypeDescriptor[]>(emptyTypeDescriptors);
  const currentSession = useRef<NoteSession | undefined>(undefined);
  const noteHistory = useRef<NoteNavigationHistory>({ paths: [], index: -1 });
  const linkCreations = useRef(new Set<string>());
  const sessions = useRef(new Map<string, NoteSession>());
  const operationQueue = useRef(new KeyedOperationQueue<NoteSession>());
  const renameRequest = useRef<string | undefined>(undefined);
  const deleteRequest = useRef<string | undefined>(undefined);
  const contentHydration = useRef<Promise<void> | undefined>(undefined);
  const mobileHistoryInitialized = useRef(false);
  const ignoreNextMobileHistoryPush = useRef(false);
  const mobileLayout = viewportWidth <= 760;
  const typeDescriptors = description?.types ?? emptyTypeDescriptors;
  const notePreviewController = useNotePreview(gateway, allNotes, typeDescriptors);

  useEffect(() => { savePreferences(preferences); }, [preferences]);
  useEffect(() => { saveLayoutPreferences(layout); }, [layout]);
  useEffect(() => { saveNoteSort(noteSort); }, [noteSort]);
  useEffect(() => { allNotesRef.current = allNotes; }, [allNotes]);
  useEffect(() => {
    if (phase !== "ready" || surface !== "types") return;
    const controller = new AbortController();
    let active = true;
    setContractCatalog({ status: "loading" });
    void loadContractCatalog({ signal: controller.signal }).then(
      (catalog) => {
        if (active) setContractCatalog({ status: "ready", catalog });
      },
      (error: unknown) => {
        if (!active || controller.signal.aborted) return;
        setContractCatalog({
          status: "error",
          message: error instanceof Error ? error.message : "The contract catalog could not be loaded."
        });
      }
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [contractCatalogReload, phase, surface]);
  useEffect(() => {
    const updateViewportWidth = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", updateViewportWidth);
    return () => window.removeEventListener("resize", updateViewportWidth);
  }, []);
  useEffect(() => {
    if (phase !== "ready" || !mobileLayout) {
      mobileHistoryInitialized.current = false;
      return;
    }
    const onPopState = (event: PopStateEvent) => {
      if (!isMobileHistoryState(event.state)) return;
      ignoreNextMobileHistoryPush.current = true;
      setSurface(event.state.surface);
      setMobilePane(event.state.pane);
      setPropertiesOpen(false);
      setBacklinksOpen(false);
    };
    window.addEventListener("popstate", onPopState);
    if (!mobileHistoryInitialized.current) {
      const collectionState: MobileHistoryState = { mdbaseEditor: true, pane: "collections", surface: "notes" };
      history.replaceState(collectionState, "");
      if (mobilePane !== "collections") {
        const listSurface = surface === "settings" ? "settings" : surface;
        const listPane: MobilePane = surface === "settings" ? "editor" : "notes";
        history.pushState({ mdbaseEditor: true, pane: listPane, surface: listSurface } satisfies MobileHistoryState, "");
      }
      if (mobilePane === "editor" && surface !== "settings") {
        history.pushState({ mdbaseEditor: true, pane: "editor", surface } satisfies MobileHistoryState, "");
      }
      mobileHistoryInitialized.current = true;
    }
    return () => window.removeEventListener("popstate", onPopState);
  }, [mobileLayout, phase]);
  useEffect(() => {
    if (phase !== "ready" || !mobileLayout || !mobileHistoryInitialized.current) return;
    if (ignoreNextMobileHistoryPush.current) {
      ignoreNextMobileHistoryPush.current = false;
      return;
    }
    const current = history.state as Partial<MobileHistoryState> | null;
    if (current?.mdbaseEditor && current.pane === mobilePane && current.surface === surface) return;
    history.pushState({ mdbaseEditor: true, pane: mobilePane, surface } satisfies MobileHistoryState, "");
  }, [mobileLayout, mobilePane, phase, surface]);

  const loadIndex = useCallback(async () => {
    const generation = ++indexGeneration.current;
    contentHydration.current = undefined;
    let lastProgress: NoteListProgress | undefined;
    setListLoading(true);
    setFoldersLoading(true);
    setContentComplete(false);
    setContentIndexing(false);
    setContentLoaded(0);
    setContentError(undefined);
    const publish = (progress: NoteListProgress) => {
      if (generation !== indexGeneration.current) return;
      lastProgress = progress;
      setAllNotes(progress.notes);
      setCollectionTotal(progress.total ?? (progress.structureComplete ? progress.notes.length : undefined));
      setListLoading(!progress.complete);
      setFoldersLoading(!progress.structureComplete);
      setContentComplete(progress.contentComplete ?? progress.complete);
      setContentLoaded(progress.contentLoaded ?? (progress.contentComplete ? progress.notes.length : 0));
    };
    try {
      const notes = await gateway.list(publish);
      if (!lastProgress?.complete) publish({
        notes,
        structureComplete: true,
        complete: true,
        contentComplete: lastProgress?.contentComplete ?? false,
        contentLoaded: lastProgress?.contentLoaded ?? 0,
        total: notes.length
      });
    } catch (error) {
      if (generation === indexGeneration.current) {
        setListLoading(false);
        setFoldersLoading(false);
      }
      throw error;
    }
  }, [gateway]);

  const loadContentIndex = useCallback((): Promise<void> => {
    if (contentHydration.current) return contentHydration.current;
    const generation = indexGeneration.current;
    setContentIndexing(true);
    setContentError(undefined);
    const publish = (progress: NoteListProgress) => {
      if (generation !== indexGeneration.current) return;
      setAllNotes((current) => mergeHydratedNotes(current, progress.notes));
      setContentLoaded(progress.contentLoaded ?? progress.notes.length);
      setContentComplete(progress.contentComplete ?? progress.complete);
    };
    const promise = gateway.hydrateContent(publish).then((notes) => {
      if (generation !== indexGeneration.current) return;
      setAllNotes((current) => mergeHydratedNotes(current, notes));
      setContentLoaded(notes.length);
      setContentComplete(true);
    }).catch((error) => {
      if (generation === indexGeneration.current) setContentError(gatewayError(error));
    }).finally(() => {
      if (contentHydration.current === promise) contentHydration.current = undefined;
      if (generation === indexGeneration.current) setContentIndexing(false);
    });
    contentHydration.current = promise;
    return promise;
  }, [gateway]);

  const refreshDescription = useCallback(async () => {
    const next = await gateway.describe();
    typeDescriptorsRef.current = next.types;
    setDescription(next);
    setSelectedTypeName((current) => next.types.some((type) => type.name === current) ? current : next.types[0]?.name);
    return next;
  }, [gateway]);

  const refreshAfterConnectionGap = useCallback(async () => {
    setConnectionState("reconnecting");
    setConnectionIssue("Refreshing collection state before reconnecting.");
    try {
      await Promise.all([loadIndex(), refreshDescription()]);
      setConnectionRetry((value) => value + 1);
    } catch (error) {
      setConnectionIssue(gatewayError(error));
    }
  }, [loadIndex, refreshDescription]);

  const loadTypeSource = useCallback(async (name: string) => {
    const generation = ++typeGeneration.current;
    setTypeCreating(false);
    setTypeLoading(true);
    setTypeError(undefined);
    setTypeDocument(undefined);
    setTypeSource("");
    try {
      const next = await gateway.readType(name);
      if (generation !== typeGeneration.current) return;
      setTypeDocument(next);
      setTypeSource(next.document);
    } catch (error) {
      if (generation === typeGeneration.current) setTypeError(gatewayError(error));
    } finally {
      if (generation === typeGeneration.current) setTypeLoading(false);
    }
  }, [gateway]);

  const updateNoteSummary = useCallback((next: NoteDocument, previousPath = next.path) => {
    const summary = summaryFromDocument(next);
    setAllNotes((notes) => {
      const previous = notes.find((note) => note.path === previousPath || note.path === summary.path);
      const merged = previous?.file ? { ...summary, file: { ...previous.file, ...summary.file } } : summary;
      return [merged, ...notes.filter((note) => note.path !== previousPath && note.path !== summary.path)];
    });
  }, []);

  const publishNoteHistory = useCallback((next: NoteNavigationHistory) => {
    noteHistory.current = next;
    setNoteHistoryState(next);
  }, []);

  const recordNoteNavigation = useCallback((path: string) => {
    const current = noteHistory.current;
    if (current.paths[current.index] === path) return;
    const paths = [...current.paths.slice(0, current.index + 1), path].slice(-100);
    publishNoteHistory({ paths, index: paths.length - 1 });
  }, [publishNoteHistory]);

  const selectNoteHistoryIndex = useCallback((index: number, path: string) => {
    const current = noteHistory.current;
    if (index < 0 || index >= current.paths.length || current.paths[index] !== path) return;
    publishNoteHistory({ paths: current.paths, index });
  }, [publishNoteHistory]);

  const replaceNoteHistoryPath = useCallback((from: string, to: string) => {
    const current = noteHistory.current;
    if (!current.paths.includes(from)) return;
    publishNoteHistory({
      paths: current.paths.map((path) => path === from ? to : path),
      index: current.index
    });
  }, [publishNoteHistory]);

  const forgetNoteHistoryPath = useCallback((path: string) => {
    const current = noteHistory.current;
    const paths = current.paths.filter((candidate) => candidate !== path);
    const removedBeforeOrAtCurrent = current.paths.slice(0, current.index + 1)
      .filter((candidate) => candidate === path).length;
    publishNoteHistory({
      paths,
      index: Math.min(paths.length - 1, Math.max(-1, current.index - removedBeforeOrAtCurrent))
    });
  }, [publishNoteHistory]);

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
    setCreationMode(undefined);
    setCreationContext({});
    setEditingPath(false);
    setNotice(session.error);
    localStorage.setItem("mdbase-editor:last-note", session.document.path);
    setRecentPaths((current) => rememberRecentPath(current, session.document.path));
  }, []);

  const adoptDocument = useCallback((next: NoteDocument) => {
    const nextDraft = editableNote(next, typeDescriptorsRef.current);
    const session: NoteSession = {
      editorSessionKey: `note-editor-${++noteEditorSession}`,
      document: next,
      draft: nextDraft,
      persistedDraft: structuredClone(nextDraft),
      saveState: "saved"
    };
    sessions.current.set(next.path, session);
    activateSession(session);
  }, [activateSession]);

  const applyRemoteDocument = useCallback((session: NoteSession, next: NoteDocument) => {
    const nextDraft = editableNote(next, typeDescriptorsRef.current);
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

  const refreshChangedNote = useCallback(async (path: string) => {
    if (sessions.current.has(path)) {
      await refreshCachedNote(path);
      return;
    }

    const next = await gateway.read(path);
    if (sessions.current.has(path)) {
      await refreshCachedNote(path);
      return;
    }
    updateNoteSummary(next);
  }, [gateway, refreshCachedNote, updateNoteSummary]);

  const openNote = useCallback(async (path: string, options: NoteNavigationOptions = {}): Promise<boolean> => {
    const generation = ++documentGeneration.current;
    const cached = sessions.current.get(path);
    if (cached?.deleted) return false;
    setCreationMode(undefined);
    setCreationContext({});
    setNotice(undefined);
    setPropertiesError(undefined);
    if (mobileLayout) {
      setPropertiesOpen(false);
      setBacklinksOpen(false);
    }
    setDeletePlan(undefined);
    setRenamePlan(undefined);
    renameRequest.current = undefined;
    setMobilePane("editor");
    if (cached && !cached.deleted) {
      activateSession(cached);
      if (options.historyIndex === undefined) recordNoteNavigation(path);
      else selectNoteHistoryIndex(options.historyIndex, path);
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
      if (options.historyIndex === undefined) recordNoteNavigation(next.path);
      else selectNoteHistoryIndex(options.historyIndex, next.path);
      return true;
    } catch (error) {
      if (generation === documentGeneration.current) setNotice(gatewayError(error));
      return false;
    } finally {
      if (generation === documentGeneration.current) setNoteLoading(false);
    }
  }, [
    activateSession,
    adoptDocument,
    gateway,
    mobileLayout,
    recordNoteNavigation,
    selectNoteHistoryIndex
  ]);

  const start = useCallback(async () => {
    setPhase("loading");
    setNotice(undefined);
    setListLoading(true);
    setFoldersLoading(true);
    setCollectionTotal(undefined);
    setContentComplete(false);
    setContentIndexing(false);
    setContentLoaded(0);
    setContentError(undefined);
    setConnectionState("connected");
    setConnectionIssue(undefined);
    setNoteLoading(true);
    const generation = ++indexGeneration.current;
    contentHydration.current = undefined;
    let lastProgress: NoteListProgress | undefined;
    let descriptionLoaded = false;
    let firstPageResolved = false;
    let resolveFirstPage!: (notes: NoteSummary[]) => void;
    const firstPage = new Promise<NoteSummary[]>((resolve) => { resolveFirstPage = resolve; });
    const publish = (progress: NoteListProgress) => {
      if (generation !== indexGeneration.current) return;
      lastProgress = progress;
      setAllNotes(progress.notes);
      setCollectionTotal(progress.total ?? (progress.structureComplete ? progress.notes.length : undefined));
      setListLoading(!progress.complete);
      setFoldersLoading(!progress.structureComplete);
      setContentComplete(progress.contentComplete ?? progress.complete);
      setContentLoaded(progress.contentLoaded ?? (progress.contentComplete ? progress.notes.length : 0));
      if (!firstPageResolved && (progress.notes.length > 0 || progress.structureComplete)) {
        firstPageResolved = true;
        resolveFirstPage(progress.notes);
      }
    };
    const indexOutcome = gateway.list(publish).then(
      (notes) => {
        if (!lastProgress?.complete) publish({
          notes,
          structureComplete: true,
          complete: true,
          contentComplete: lastProgress?.contentComplete ?? false,
          contentLoaded: lastProgress?.contentLoaded ?? 0,
          total: notes.length
        });
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
      setPhase(descriptionLoaded && gateway.sessionSnapshot().status === "ready" ? "ready" : "disconnected");
    }
  }, [gateway, openNote, refreshDescription]);

  useEffect(() => {
    if (phase !== "ready" || listLoading || contentComplete || contentIndexing || contentError || !deferredSearch.trim()) return;
    void loadContentIndex();
  }, [contentComplete, contentError, contentIndexing, deferredSearch, listLoading, loadContentIndex, phase]);

  useEffect(() => {
    let alive = true;
    let stopSessionChanges: (() => void) | undefined;
    void (async () => {
      try {
        const initial = await gateway.startSession();
        if (!alive) return;
        setSessionSnapshot(initial);
        stopSessionChanges = gateway.onSessionChange((snapshot) => {
          setSessionSnapshot(snapshot);
          if (snapshot.status !== "ready") {
            setPhase((current) => current === "starting" ? current : "disconnected");
          }
        });
        const snapshot = gateway.sessionSnapshot();
        setSessionSnapshot(snapshot);
        const connection = snapshot.status === "ready" ? snapshot.connection : null;
        if (connection && missingCoreOperations(connection).length === 0) await start();
        else {
          setPhase("disconnected");
        }
      } catch (error) {
        if (!alive) return;
        setNotice(gatewayError(error));
        setPhase("disconnected");
      }
    })();
    return () => {
      alive = false;
      stopSessionChanges?.();
    };
  }, [gateway, start]);

  useEffect(() => {
    if (phase !== "ready" || !connectionSummary) return;
    void gateway.checkDirectAccess()
      .then(() => undefined)
      .catch(() => undefined);
  }, [connectionSummary?.collectionId, gateway, phase]);

  useEffect(() => {
    if (phase !== "ready") return;
    const controller = new AbortController();
    let refreshTimer: number | undefined;
    let resetHandled = false;
    const changedPaths = new Set<string>();
    const structuralChanges: CollectionChange[] = [];
    let typesChanged = false;
    let indexChanged = false;
    const handleChange = (change?: CollectionChange) => {
      if (change?.type === "mdbase.record.modified" && typeof change.payload.path === "string") {
        changedPaths.add(change.payload.path);
      } else if (change?.type === "mdbase.type.changed") {
        typesChanged = true;
        indexChanged = true;
      } else if (change?.type === "mdbase.record.created"
          || change?.type === "mdbase.record.deleted"
          || change?.type === "mdbase.record.renamed") {
        structuralChanges.push(change);
      } else {
        indexChanged = true;
      }
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        const paths = [...changedPaths];
        changedPaths.clear();
        const shouldRefreshTypes = typesChanged;
        typesChanged = false;
        const currentPaths = new Set(allNotesRef.current.map((note) => note.path));
        const shouldRefreshIndex = indexChanged || structuralChanges.some((change) => {
          const path = typeof change.payload.path === "string" ? change.payload.path : undefined;
          const from = typeof change.payload.from === "string" ? change.payload.from : undefined;
          const to = typeof change.payload.to === "string" ? change.payload.to : undefined;
          if (change.type === "mdbase.record.created") return !path || !currentPaths.has(path);
          if (change.type === "mdbase.record.deleted") return !path || currentPaths.has(path);
          return !from || !to || currentPaths.has(from) || !currentPaths.has(to);
        });
        structuralChanges.length = 0;
        indexChanged = false;
        if (shouldRefreshIndex) void loadIndex();
        for (const path of paths) void refreshChangedNote(path).catch((error) => {
          if (!controller.signal.aborted) setNotice(gatewayError(error));
        });
        if (shouldRefreshTypes) void refreshDescription();
      }, 180);
    };
    void gateway.watch(handleChange, controller.signal, (status) => {
      if (controller.signal.aborted) return;
      if (status.state === "reconnecting") {
        setConnectionState("reconnecting");
        setConnectionIssue(gatewayError(status.error));
      } else if (status.state === "connected") {
        setConnectionState("connected");
        setConnectionIssue(undefined);
      } else if (status.state === "reset_required") {
        resetHandled = true;
        void refreshAfterConnectionGap();
      }
    }).catch((error) => {
      if (!controller.signal.aborted && !resetHandled) {
          setConnectionState("reconnecting");
          setConnectionIssue(gatewayError(error));
      }
    });
    return () => {
      controller.abort();
      window.clearTimeout(refreshTimer);
    };
  }, [connectionRetry, gateway, loadIndex, phase, refreshAfterConnectionGap, refreshChangedNote, refreshDescription]);

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
          frontmatter: session.document.frontmatter,
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
    session.persistedDraft = editableNote(remote, typeDescriptors);
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

  function navigateToNote(path: string, options: NoteNavigationOptions = {}) {
    if (creationMode && creationDirty) {
      setConfirmation({
        title: `Discard this ${creationMode}?`,
        body: <p>The unfinished {creationMode} hasn’t been created.</p>,
        confirmLabel: `Discard ${creationMode}`,
        tone: "danger",
        onConfirm: () => finishNavigateToNote(path, options)
      });
      return;
    }
    finishNavigateToNote(path, options);
  }

  function finishNavigateToNote(path: string, options: NoteNavigationOptions = {}) {
    setCreationDirty(false);
    const generation = ++navigationGeneration.current;
    if (path === currentSession.current?.document.path && !noteLoading) {
      setPendingNotePath(undefined);
      setMobilePane("editor");
      if (options.historyIndex !== undefined) selectNoteHistoryIndex(options.historyIndex, path);
      return;
    }
    saveCurrentInBackground();
    setPendingNotePath(path);
    setNotice(undefined);
    void openNote(path, options).then((opened) => {
      if (generation === navigationGeneration.current && !opened) setPendingNotePath(undefined);
    });
  }

  function navigateNoteHistory(direction: -1 | 1) {
    const targetIndex = noteHistory.current.index + direction;
    const path = noteHistory.current.paths[targetIndex];
    if (!path) return;
    navigateToNote(path, { historyIndex: targetIndex });
  }

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (operationQueue.current.pendingCount > 0
          || [...sessions.current.values()].some((session) => !session.deleted && sessionDirty(session))
          || typeCreating
          || Boolean(typeDocument && typeSource !== typeDocument.document)) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [typeCreating, typeDocument, typeSource]);

  const searchIndex = useMemo(() => buildNoteSearchIndex(allNotes, typeDescriptors), [allNotes, typeDescriptors]);
  const searchedResults = useMemo(() => {
    return deferredSearch.trim() ? searchNoteResults(searchIndex, deferredSearch) : undefined;
  }, [deferredSearch, searchIndex]);
  const searchedNotes = useMemo(() => searchedResults
    ? searchedResults.map((result) => result.note)
    : allNotes, [allNotes, searchedResults]);
  const searchContexts = useMemo(() => new Map(
    searchedResults?.map((result) => [result.note.path, result.context]) ?? []
  ), [searchedResults]);
  const visibleNotes = useMemo(() => {
    const filtered = !noteFilter
      ? searchedNotes
      : noteFilter.kind === "folder"
        ? searchedNotes.filter((note) => note.path === noteFilter.value || note.path.startsWith(`${noteFilter.value}/`))
        : noteFilter.kind === "tag"
          ? searchedNotes.filter((note) => noteTags(note).includes(noteFilter.value))
          : searchedNotes.filter((note) => note.types.includes(noteFilter.value));
    return deferredSearch.trim() ? filtered : sortNotes(filtered, noteSort, typeDescriptors);
  }, [deferredSearch, noteFilter, noteSort, searchedNotes, typeDescriptors]);
  const linkTypeNames = useMemo(() => description?.types.map((type) => type.name) ?? [], [description]);
  const linkOptions = useMemo(() => linkSuggestions(allNotes, linkTypeNames, typeDescriptors), [allNotes, linkTypeNames, typeDescriptors]);
  const backlinkNotes = useMemo(() => document ? backlinksFor(document.path, allNotes, typeDescriptors) : [], [allNotes, document, typeDescriptors]);

  const runNoteOperation = useCallback(async <Result,>(
    session: NoteSession,
    activity: NoteActivity,
    operation: () => Promise<Result>
  ): Promise<Result> => operationQueue.current.run(session, async () => {
    session.activity = activity;
    session.activityDetail = undefined;
    touchSession(session);
    try {
      return await operation();
    } finally {
      if (session.activity === activity) session.activity = undefined;
      session.activityDetail = undefined;
      touchSession(session);
    }
  }), [touchSession]);

  async function connectCollection() {
    setNotice(undefined);
    try { await gateway.authorize("selected"); } catch (error) { setNotice(gatewayError(error)); }
  }

  async function connectFromConnectScreen() {
    setNotice(undefined);
    try {
      const snapshot = gateway.sessionSnapshot();
      if (snapshot.status === "unavailable"
        || (snapshot.status === "ready" && missingCoreOperations(snapshot.connection).length > 0)) {
        await gateway.authorize("selected");
      }
      else await gateway.authorize("choose");
    } catch (error) {
      setNotice(gatewayError(error));
    }
  }

  async function requestDirectAccess() {
    setDirectAccessBusy(true);
    setNotice(undefined);
    try {
      const connection = await gateway.requestDirectAccess();
      if (connection?.directAccess === "available") {
        setNotice("mdbase editor can now use mdbase on this computer.");
      } else if (connection?.directAccess === "denied") {
        setNotice("Local network access is blocked in this browser. Allow it in the site settings, then try again.");
      } else if (connection?.directAccess === "unavailable") {
        setNotice("mdbase could not be reached on this computer. Editing will continue through mdbase.");
      }
    } catch (error) {
      setNotice(gatewayError(error));
    } finally {
      setDirectAccessBusy(false);
    }
  }

  async function flushCollectionWork() {
    await Promise.all([...sessions.current.values()]
      .filter((session) => !session.deleted)
      .map((session) => flushSession(session)));
    await operationQueue.current.waitForIdle();
  }

  function clearCollectionWorkspace() {
    navigationGeneration.current += 1;
    documentGeneration.current += 1;
    typeGeneration.current += 1;
    currentSession.current = undefined;
    sessions.current.clear();
    publishNoteHistory({ paths: [], index: -1 });
    linkCreations.current.clear();
    typeDescriptorsRef.current = emptyTypeDescriptors;
    setDescription(undefined);
    setAllNotes([]);
    setCollectionTotal(undefined);
    setFoldersLoading(false);
    setDocument(undefined);
    setDraft(undefined);
    setSelectedPath(undefined);
    setPendingNotePath(undefined);
    setCreationMode(undefined);
    setCreationContext({});
    setCreationDirty(false);
    setPropertiesOpen(false);
    setBacklinksOpen(false);
    setSelectedTypeName(undefined);
    setTypeDocument(undefined);
    setTypeSource("");
    setTypeCreating(false);
    setTypeError(undefined);
    setSearch("");
    setNoteFilter(undefined);
    setSurface("notes");
    setMobilePane("notes");
  }

  async function openSavedCollection(collectionId: string) {
    setNotice(undefined);
    setCollectionSwitcherOpen(false);
    try {
      await flushCollectionWork();
      const selected = gateway.selectConnection(collectionId);
      clearCollectionWorkspace();
      if (missingCoreOperations(selected).length > 0) {
        setPhase("disconnected");
        await gateway.authorize("selected");
        return;
      }
      setPhase("loading");
      await start();
    } catch (error) {
      setNotice(gatewayError(error));
      setPhase("disconnected");
    }
  }

  function requestOpenSavedCollection(collectionId: string) {
    if (collectionId === connectionSummary?.collectionId) {
      setCollectionSwitcherOpen(false);
      return;
    }
    if (!typeDraftDirty() && !creationDirty) {
      void openSavedCollection(collectionId);
      return;
    }
    setConfirmation({
      title: "Switch collections?",
      body: <p>{creationDirty
        ? "The unfinished note or folder will be discarded. Saved note and property changes will finish first."
        : "Unsaved type definition changes will be discarded. Saved note and property changes will finish first."}</p>,
      confirmLabel: "Switch collection",
      onConfirm: () => openSavedCollection(collectionId)
    });
  }

  async function connectAnotherCollection() {
    setNotice(undefined);
    setCollectionSwitcherOpen(false);
    try {
      await flushCollectionWork();
      await gateway.authorize("choose");
    } catch (error) {
      setNotice(gatewayError(error));
    }
  }

  function requestConnectAnotherCollection() {
    if (!typeDraftDirty() && !creationDirty) {
      void connectAnotherCollection();
      return;
    }
    setConfirmation({
      title: "Choose another collection?",
      body: <p>Unsaved type or creation changes will be discarded when the new collection opens. Note and property changes will finish saving first.</p>,
      confirmLabel: "Continue",
      onConfirm: connectAnotherCollection
    });
  }

  function beginCreation(mode: "note" | "folder", context: CreationContext = {}) {
    navigationGeneration.current += 1;
    setPendingNotePath(undefined);
    setNotice(undefined);
    saveCurrentInBackground();
    setSurface("notes");
    setPropertiesOpen(false);
    setBacklinksOpen(false);
    setRenamePlan(undefined);
    renameRequest.current = undefined;
    setCreationDirty(false);
    setCreationContext(context);
    setCreationMode(mode);
    setMobilePane("editor");
  }

  function beginCreate() {
    const context = noteFilter?.kind === "folder"
      ? { folder: noteFilter.value }
      : noteFilter?.kind === "tag"
        ? { tag: noteFilter.value }
        : noteFilter?.kind === "type"
          ? { type: noteFilter.value }
          : {};
    beginCreation("note", context);
  }

  function beginFolderCreate() {
    beginCreation("folder", noteFilter?.kind === "folder" ? { folder: noteFilter.value } : {});
  }

  function beginNoteInFolder(folder: string) {
    setNoteFilter({ kind: "folder", value: folder });
    beginCreation("note", { folder });
  }

  function beginSubfolder(parent: string) {
    setNoteFilter({ kind: "folder", value: parent });
    beginCreation("folder", { folder: parent });
  }

  function beginNoteWithTag(tag: string) {
    setNoteFilter({ kind: "tag", value: tag });
    beginCreation("note", { tag });
  }

  function beginNoteWithType(type: string) {
    setNoteFilter({ kind: "type", value: type });
    beginCreation("note", { type });
  }

  function copyFacet(value: string, label: string) {
    void navigator.clipboard.writeText(value)
      .then(() => setNotice(`Copied ${label}.`))
      .catch(() => setNotice(`Couldn’t copy ${label}.`));
  }

  function openTypeFromRail(name: string) {
    const open = () => {
      finishSelectSurface("types");
      setTypeWorkspace("definition");
      setSelectedTypeName(name);
      void loadTypeSource(name);
    };
    if (typeDraftDirty() && (typeCreating || selectedTypeName !== name)) {
      setConfirmation({
        title: "Discard type changes?",
        body: <p>Your unsaved changes to this type definition won’t be kept.</p>,
        confirmLabel: "Discard changes",
        tone: "danger",
        onConfirm: open
      });
      return;
    }
    open();
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
    setDeletePlan(undefined);
    setCreationDirty(false);
    setCreationContext({});
    setMobilePane("editor");
    adoptDocument(created);
    recordNoteNavigation(created.path);
  }

  function createLinkedNote(target: string, label: string | undefined, format: "wikilink" | "markdown") {
    const sourcePath = currentSession.current?.document.path;
    const linked = unresolvedNoteTarget(target, label, sourcePath, format);
    if (!linked) {
      setNotice("That link does not point to a Markdown note that can be created.");
      return;
    }
    if (linkCreations.current.has(linked.path)) return;
    linkCreations.current.add(linked.path);
    saveCurrentInBackground();
    setPendingNotePath(linked.path);
    setNotice(undefined);
    void gateway.create({
      title: linked.title,
      body: "",
      path: linked.path,
      properties: {}
    }).then((created) => {
      const summary = summaryFromDocument(created);
      setAllNotes((notes) => [summary, ...notes.filter((note) => note.path !== created.path)]);
      setCollectionTotal((total) => total === undefined ? undefined : total + 1);
      documentGeneration.current += 1;
      setPropertiesError(undefined);
      setDeletePlan(undefined);
      setMobilePane("editor");
      adoptDocument(created);
      recordNoteNavigation(created.path);
    }).catch(async (error) => {
      const opened = await openNote(linked.path);
      if (!opened) setNotice(gatewayError(error));
    }).finally(() => {
      linkCreations.current.delete(linked.path);
      setPendingNotePath((current) => current === linked.path ? undefined : current);
    });
  }

  async function requestRename() {
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
    const requestKey = `${session.document.path}\n${nextPath}`;
    if (renameRequest.current === requestKey) return;
    renameRequest.current = requestKey;
    try {
      const from = session.document.path;
      await flushSession(session);
      if (session.document.path !== from) {
        throw new Error("This note moved before the rename check could begin.");
      }
      const preflight = await runNoteOperation(session, "validating", () => gateway.preflightRename(
        from,
        nextPath,
        session.document.revision
      ));
      if (currentSession.current !== session) {
        renameRequest.current = undefined;
        return;
      }
      const plan: RenamePlan = {
        session,
        from,
        to: nextPath,
        affectedPaths: preflight.affectedPaths,
        warnings: preflight.warnings
      };
      if (plan.affectedPaths.length > 0 || plan.warnings.length > 0) {
        setRenamePlan(plan);
        return;
      }
      await performRename(plan, true);
    } catch (error) {
      const message = gatewayError(error);
      session.error = message;
      if (currentSession.current === session) setPathDraft(session.document.path);
      setNotice(currentSession.current === session
        ? message
        : `Couldn’t check the rename for “${session.draft.title || session.document.path}”. ${message}`);
      renameRequest.current = undefined;
      touchSession(session);
    }
  }

  async function performRename(plan: RenamePlan, updateRefs: boolean) {
    const { session, from, to } = plan;
    const controller = new AbortController();
    setRenamePlan(undefined);
    session.mutationController = controller;
    session.mutationCancellable = false;
    touchSession(session);
    try {
      await flushSession(session);
      if (session.document.path !== from) throw new Error("This note moved before the rename could begin.");
      const renamed = await runNoteOperation(session, updateRefs ? "renaming" : "moving", () => gateway.rename(
        from,
        to,
        session.document.revision,
        updateRefs,
        {
          signal: controller.signal,
          onProgress: (progress) => updateMutationActivity(session, progress, touchSession)
        }
      ));
      setPendingRenameRecovery(undefined);
      session.document = renamed;
      session.error = undefined;
      sessions.current.delete(from);
      sessions.current.set(renamed.path, session);
      updateNoteSummary(renamed, from);
      if (currentSession.current === session) {
        setDocument(renamed);
        setSelectedPath(renamed.path);
        setPathDraft(renamed.path);
        localStorage.setItem("mdbase-editor:last-note", renamed.path);
      }
      setRecentPaths((current) => rememberRecentPath(forgetRecentPath(current, from), renamed.path));
      replaceNoteHistoryPath(from, renamed.path);
      setRecoveryAction({ kind: "rename", from, to: renamed.path });
      touchSession(session);
    } catch (error) {
      const message = gatewayError(error);
      session.error = message;
      if (error instanceof MdbaseConnectError && error.outcomeUnknown) {
        setPendingRenameRecovery({ plan, updateRefs });
        if (currentSession.current === session) {
          setPathDraft(to);
          setEditingPath(true);
        }
      } else if (currentSession.current === session) {
        setPathDraft(session.document.path);
      }
      setNotice(currentSession.current === session
        ? message
        : `Couldn’t rename “${session.draft.title || session.document.path}”. ${message}`);
      touchSession(session);
    } finally {
      if (session.mutationController === controller) {
        session.mutationController = undefined;
        session.mutationCancellable = false;
        touchSession(session);
      }
      renameRequest.current = undefined;
    }
  }

  function cancelActiveMutation() {
    currentSession.current?.mutationController?.abort("Cancelled in mdbase editor");
  }

  function cancelRename() {
    setRenamePlan(undefined);
    renameRequest.current = undefined;
    const session = currentSession.current;
    if (session) setPathDraft(session.document.path);
  }

  async function saveProperties(path: string, next: Record<string, unknown>) {
    const session = sessions.current.get(path);
    if (!session) return;
    setPropertiesError(undefined);
    try {
      await flushSession(session);
      const source = session.document.document ?? composeRecordSource(session.document.frontmatter, session.document.body ?? "");
      const updated = await runNoteOperation(session, "properties", () => gateway.updateDocument(
        session.document.path,
        replaceDocumentFrontmatter(source, next),
        session.document.revision
      ));
      const persistedDraft = editableNote(updated, typeDescriptors);
      session.document = updated;
      session.persistedDraft = persistedDraft;
      session.draft = persistedDraft;
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
      throw error;
    }
  }

  async function saveRecordSource(path: string, source: string, previousSource: string): Promise<boolean> {
    const session = sessions.current.get(path);
    if (!session || session.deleted) return false;
    if (currentSession.current === session) setPropertiesError(undefined);
    try {
      await flushSession(session);
      const currentSource = session.document.document ?? composeRecordSource(session.document.frontmatter, session.document.body ?? "");
      if (currentSource !== previousSource) {
        const message = "This note finished saving after Source was opened. Your source draft is preserved; close and reopen the panel to start from the latest record.";
        if (currentSession.current === session) setPropertiesError(message);
        else setNotice(`Couldn’t update source for “${session.draft.title || session.document.path}”. ${message}`);
        return false;
      }
      const updated = await runNoteOperation(session, "properties", () => gateway.updateDocument(
        session.document.path,
        source,
        session.document.revision
      ));
      const persistedDraft = editableNote(updated, typeDescriptors);
      session.document = updated;
      session.persistedDraft = persistedDraft;
      session.draft = persistedDraft;
      session.saveState = "saved";
      session.error = undefined;
      updateNoteSummary(updated);
      if (currentSession.current === session) {
        setDocument(updated);
        setDraft(persistedDraft);
        setSaveState("saved");
      }
      touchSession(session);
      return true;
    } catch (error) {
      const message = gatewayError(error);
      session.error = message;
      if (currentSession.current === session) setPropertiesError(message);
      setNotice(currentSession.current === session
        ? message
        : `Couldn’t update source for “${session.draft.title || session.document.path}”. ${message}`);
      touchSession(session);
      return false;
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

  async function requestDelete() {
    const session = currentSession.current;
    if (!session) return;
    const requestKey = `${session.document.path}\n${session.document.revision}`;
    if (deleteRequest.current === requestKey) return;
    deleteRequest.current = requestKey;
    setNotice(undefined);
    try {
      await flushSession(session);
      const preflight = await runNoteOperation(session, "validating", () => gateway.preflightDelete(
        session.document.path,
        session.document.revision
      ));
      if (currentSession.current === session) {
        setDeletePlan({ session, brokenLinkPaths: preflight.brokenLinkPaths });
      }
    } catch (error) {
      const message = gatewayError(error);
      session.error = message;
      setNotice(currentSession.current === session
        ? message
        : `Couldn’t check deletion for “${session.draft.title || session.document.path}”. ${message}`);
      touchSession(session);
    } finally {
      deleteRequest.current = undefined;
    }
  }

  function deleteNote(plan: DeletePlan) {
    const { session } = plan;
    const path = session.document.path;
    const next = allNotes.find((note) => note.path !== path);
    session.deleted = true;
    forgetNoteHistoryPath(path);
    setDeletePlan(undefined);
    if (currentSession.current === session) {
      currentSession.current = undefined;
      setDocument(undefined);
      setDraft(undefined);
      setSelectedPath(undefined);
      if (next) void openNote(next.path);
    }
    void (async () => {
      try {
        let deletedDocument: NoteDocument | undefined;
        await runNoteOperation(session, "deleting", async () => {
          deletedDocument = structuredClone(session.document);
          await gateway.delete(session.document.path, session.document.revision, {
            onProgress: (progress) => updateMutationActivity(session, progress, touchSession)
          });
        });
        sessions.current.delete(path);
        setAllNotes((notes) => notes.filter((note) => note.path !== path));
        setRecentPaths((current) => forgetRecentPath(current, path));
        setCollectionTotal((total) => total === undefined ? undefined : Math.max(0, total - 1));
        if (deletedDocument) setRecoveryAction({ kind: "delete", document: deletedDocument });
      } catch (error) {
        session.deleted = false;
        session.error = gatewayError(error);
        setNotice(`Couldn’t delete “${session.draft.title || path}”. ${session.error}`);
        touchSession(session);
      }
    })();
  }

  async function undoRecovery() {
    const action = recoveryAction;
    if (!action || recoveryBusy) return;
    setRecoveryBusy(true);
    setNotice(undefined);
    try {
      if (action.kind === "delete") {
        const restored = await gateway.restore(action.document);
        const restoredDraft = editableNote(restored, typeDescriptors);
        sessions.current.set(restored.path, {
          editorSessionKey: `note-editor-${++noteEditorSession}`,
          document: restored,
          draft: restoredDraft,
          persistedDraft: structuredClone(restoredDraft),
          saveState: "saved"
        });
        updateNoteSummary(restored);
        setCollectionTotal((total) => total === undefined ? undefined : total + 1);
        setNotice(`Restored “${noteTitle(restored, typeDescriptors)}”.`);
      } else {
        const session = sessions.current.get(action.to);
        if (!session || session.deleted) throw new Error("The renamed note is no longer available to restore.");
        await flushSession(session);
        const restored = await runNoteOperation(session, "renaming", () => gateway.rename(
          action.to,
          action.from,
          session.document.revision,
          true
        ));
        session.document = restored;
        session.error = undefined;
        sessions.current.delete(action.to);
        sessions.current.set(action.from, session);
        updateNoteSummary(restored, action.to);
        if (currentSession.current === session) {
          setDocument(restored);
          setSelectedPath(restored.path);
          setPathDraft(restored.path);
          localStorage.setItem("mdbase-editor:last-note", restored.path);
        }
        setRecentPaths((current) => rememberRecentPath(forgetRecentPath(current, action.to), restored.path));
        replaceNoteHistoryPath(action.to, restored.path);
        touchSession(session);
        setNotice(`Restored the path to “${action.from}”.`);
      }
      setRecoveryAction(undefined);
    } catch (error) {
      setNotice(`Couldn’t undo that change. ${gatewayError(error)}`);
    } finally {
      setRecoveryBusy(false);
    }
  }

  function selectType(name: string) {
    if (name === selectedTypeName && typeDocument?.name === name && !typeLoading) {
      setTypeWorkspace("definition");
      setMobilePane("editor");
      return;
    }
    const select = () => {
      setTypeWorkspace("definition");
      setSelectedTypeName(name);
      setMobilePane("editor");
      void loadTypeSource(name);
    };
    if (!typeDraftDirty()) {
      select();
      return;
    }
    setConfirmation({
      title: "Discard type changes?",
      body: <p>Your unsaved changes to this type definition won’t be kept.</p>,
      confirmLabel: "Discard changes",
      tone: "danger",
      onConfirm: select
    });
  }

  function beginTypeCreate() {
    const begin = () => {
      typeGeneration.current += 1;
      setTypeWorkspace("definition");
      setSelectedTypeName(undefined);
      setTypeDocument(undefined);
      setTypeSource(NEW_TYPE_SOURCE);
      setTypeCreating(true);
      setTypeLoading(false);
      setTypeSaving(false);
      setTypeError(undefined);
      setMobilePane("editor");
    };
    if (!typeDraftDirty()) {
      begin();
      return;
    }
    setConfirmation({
      title: "Discard type changes?",
      body: <p>Your unsaved changes to this type definition won’t be kept.</p>,
      confirmLabel: "Discard changes",
      tone: "danger",
      onConfirm: begin
    });
  }

  function openTypePacks() {
    setTypeWorkspace("packs");
    setMobilePane("editor");
  }

  function cancelTypeCreate() {
    if (typeDraftDirty()) {
      setConfirmation({
        title: "Discard this type?",
        body: <p>The new type definition hasn’t been saved.</p>,
        confirmLabel: "Discard type",
        tone: "danger",
        onConfirm: finishCancelTypeCreate
      });
      return;
    }
    finishCancelTypeCreate();
  }

  function finishCancelTypeCreate() {
    const next = description?.types[0]?.name;
    setTypeCreating(false);
    setTypeError(undefined);
    if (next) {
      setSelectedTypeName(next);
      void loadTypeSource(next);
    } else {
      setTypeDocument(undefined);
      setTypeSource("");
      setMobilePane("notes");
    }
  }

  async function saveType() {
    if (!typeCreating && !typeDocument) return;
    setTypeSaving(true);
    setTypeError(undefined);
    try {
      const saved = typeCreating
        ? await gateway.createType(typeSource)
        : await gateway.updateType(typeDocument!, typeSource);
      typeGeneration.current += 1;
      setTypeCreating(false);
      setTypeDocument(saved);
      setTypeSource(saved.document);
      await refreshDescription();
      setSelectedTypeName(saved.name);
      setNotice(typeCreating ? `Created type “${saved.name}”.` : `Saved type “${saved.name}”.`);
    } catch (error) {
      setTypeError(gatewayError(error));
    } finally {
      setTypeSaving(false);
    }
  }

  async function installCatalogPack(pack: ContractCatalogPack) {
    const previousTypes = new Set(description?.types.map((type) => type.name) ?? []);
    const provision = await loadTypePackProvision(pack);
    const installed = await gateway.installTypePack(provision);
    const next = await refreshDescription();
    const addedTypes = next.types.filter((type) => !previousTypes.has(type.name));
    const primaryType = pack.primaryType
      ? addedTypes.find((type) => type.name === pack.primaryType)
      : undefined;
    if (primaryType && !typeDraftDirty()) {
      setTypeWorkspace("definition");
      setSelectedTypeName(primaryType.name);
      setMobilePane("editor");
      await loadTypeSource(primaryType.name);
      setNotice(`Added “${pack.displayName}” and opened the new type.`);
      return;
    }
    setNotice(`Installed “${pack.displayName}” (${installed.resources.length} resources, ${addedTypes.length} new ${addedTypes.length === 1 ? "type" : "types"}).`);
  }

  function typeDraftDirty() {
    return typeCreating || Boolean(typeDocument && typeSource !== typeDocument.document);
  }

  function selectSurface(next: Surface) {
    if (creationMode && creationDirty) {
      setConfirmation({
        title: `Discard this ${creationMode}?`,
        body: <p>The unfinished {creationMode} hasn’t been created.</p>,
        confirmLabel: `Discard ${creationMode}`,
        tone: "danger",
        onConfirm: () => finishSelectSurface(next)
      });
      return;
    }
    finishSelectSurface(next);
  }

  function finishSelectSurface(next: Surface) {
    navigationGeneration.current += 1;
    setPendingNotePath(undefined);
    saveCurrentInBackground();
    setSurface(next);
    setCreationMode(undefined);
    setCreationContext({});
    setCreationDirty(false);
    setPropertiesOpen(false);
    setBacklinksOpen(false);
    setRenamePlan(undefined);
    renameRequest.current = undefined;
    setMobilePane(next === "settings" ? "editor" : "notes");
    if (next === "types" && !typeCreating) {
      const name = selectedTypeName ?? description?.types[0]?.name;
      if (name && (typeDocument?.name !== name || !typeSource)) {
        setSelectedTypeName(name);
        void loadTypeSource(name);
      }
    }
  }

  function cancelCreation(hasDraft: boolean) {
    if (!hasDraft) {
      finishCancelCreation();
      return;
    }
    const subject = creationMode === "folder" ? "folder" : "note";
    setConfirmation({
      title: `Discard this ${subject}?`,
      body: <p>The details you entered haven’t been created yet.</p>,
      confirmLabel: `Discard ${subject}`,
      tone: "danger",
      onConfirm: finishCancelCreation
    });
  }

  function finishCancelCreation() {
    setCreationMode(undefined);
    setCreationContext({});
    setCreationDirty(false);
    returnToMobilePane("notes");
  }

  function returnToMobilePane(fallback: MobilePane) {
    if (mobileLayout && isMobileHistoryState(history.state)) {
      history.back();
      return;
    }
    setMobilePane(fallback);
  }

  async function forgetConnection(collectionId: string) {
    const active = connectionSummary?.collectionId === collectionId;
    try {
      if (active) await flushCollectionWork();
      gateway.forgetConnection(collectionId);
      setCollectionSwitcherOpen(false);
      setNotice(undefined);
      if (active) {
        clearCollectionWorkspace();
        setPhase("disconnected");
      }
    } catch (error) {
      setNotice(gatewayError(error));
    }
  }

  function requestForgetConnection(connection: ConnectionSummary, displayName?: string) {
    const name = displayName ?? connection.displayName ?? "this collection";
    setConfirmation({
      title: `Forget “${name}” from this browser?`,
      body: <p>This removes the saved connection from this browser. It does not delete the collection or its files, and it does not revoke mdbase editor’s access in mdbase connect.</p>,
      confirmLabel: "Forget from this browser",
      tone: "danger",
      onConfirm: () => forgetConnection(connection.collectionId)
    });
  }

  function requestForgetCurrentCollection() {
    const connection = connectionSummary;
    if (connection) requestForgetConnection(connection, description?.display_name);
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      const key = event.key.toLocaleLowerCase();
      if (event.key === "Escape" && (quickOpen || shortcutsOpen)) {
        event.preventDefault();
        setQuickOpen(false);
        setShortcutsOpen(false);
        return;
      }
      if (modifier && (key === "p" || (key === "k" && !isEditableTarget(event.target)))) {
        event.preventDefault();
        setShortcutsOpen(false);
        setQuickOpen(true);
        return;
      }
      if (quickOpen || shortcutsOpen) return;
      if (phase !== "ready") return;
      if (modifier && event.shiftKey && key === "n") {
        event.preventDefault();
        beginCreate();
        return;
      }
      if (modifier && event.shiftKey && key === "l") {
        event.preventDefault();
        setLayout((current) => ({ ...current, listCollapsed: !current.listCollapsed }));
        return;
      }
      if (event.altKey && !modifier && (event.key === "ArrowLeft" || event.key === "ArrowRight")
          && surface === "notes" && !creationMode) {
        event.preventDefault();
        navigateNoteHistory(event.key === "ArrowLeft" ? -1 : 1);
        return;
      }
      if (event.altKey && !modifier && (key === "j" || key === "k") && surface === "notes" && !creationMode) {
        event.preventDefault();
        const selectedIndex = visibleNotes.findIndex((note) => note.path === selectedPath);
        const direction = key === "j" ? 1 : -1;
        const fallback = direction > 0 ? 0 : visibleNotes.length - 1;
        const nextIndex = selectedIndex < 0
          ? fallback
          : Math.min(visibleNotes.length - 1, Math.max(0, selectedIndex + direction));
        const next = visibleNotes[nextIndex];
        if (next) navigateToNote(next.path);
        return;
      }
      if (event.key === "?" && !isEditableTarget(event.target)) {
        event.preventDefault();
        setQuickOpen(false);
        setShortcutsOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [creationMode, phase, quickOpen, selectedPath, shortcutsOpen, surface, visibleNotes]);

  if (phase === "starting") return <OpeningScreen />;
  if (phase === "disconnected") return <>
    <ConnectScreen
      notice={notice}
      missingOperations={missingCoreOperations(connectionSummary)}
      connections={sessionSnapshot.connections}
      onConnect={() => void connectFromConnectScreen()}
      onOpen={(collectionId) => void openSavedCollection(collectionId)}
      onForget={requestForgetConnection}
    />
    {confirmation && <ConfirmDialog
      title={confirmation.title}
      body={confirmation.body}
      confirmLabel={confirmation.confirmLabel}
      cancelLabel={confirmation.cancelLabel}
      tone={confirmation.tone}
      onConfirm={confirmation.onConfirm}
      onClose={() => setConfirmation(undefined)}
    />}
  </>;
  if (phase === "loading" || !description) return <OpeningScreen />;

  const selectedType = description.types.find((type) => type.name === selectedTypeName);
  const hasListPane = surface !== "settings";
  const collectionTrack = layout.collectionCollapsed ? 0 : layout.collectionWidth;
  const listTrack = hasListPane && !layout.listCollapsed ? layout.listWidth : 0;
  const editorMinimum = viewportWidth <= 1120 ? 320 : 380;
  const inspectorVisible = propertiesOpen || backlinksOpen;
  const inspectorResizeMax = Math.max(INSPECTOR_WIDTH.min, Math.min(
    INSPECTOR_WIDTH.max,
    viewportWidth > 1120
      ? viewportWidth - collectionTrack - listTrack - editorMinimum
      : viewportWidth - editorMinimum
  ));
  const inspectorTrack = Math.min(layout.inspectorWidth, inspectorResizeMax);
  const reservedInspectorWidth = inspectorVisible && viewportWidth > 1120 ? inspectorTrack : 0;
  const collectionResizeMax = Math.max(COLLECTION_WIDTH.min, Math.min(
    COLLECTION_WIDTH.max,
    viewportWidth - listTrack - editorMinimum - reservedInspectorWidth
  ));
  const listResizeMax = Math.max(LIST_WIDTH.min, Math.min(
    LIST_WIDTH.max,
    viewportWidth - collectionTrack - editorMinimum - reservedInspectorWidth
  ));
  const listName = surface === "types" ? "types" : "notes";
  const historyBackPath = noteHistoryState.paths[noteHistoryState.index - 1];
  const historyForwardPath = noteHistoryState.paths[noteHistoryState.index + 1];
  const activeRemoteDocument = currentSession.current?.remoteDocument;
  const activeRemoteDraft = activeRemoteDocument ? editableNote(activeRemoteDocument, typeDescriptors) : undefined;
  const editorNotice = activeRemoteDocument ? undefined : notice;
  const activePendingRename = pendingRenameRecovery?.plan.session === currentSession.current
    ? pendingRenameRecovery
    : undefined;
  const mutationNotice = editorNotice ?? (activePendingRename
    ? "This rename was interrupted after it started. Resume it to recover the collection’s authoritative result."
    : undefined);
  const typeAccessMissing = missingTypeOperations(connectionSummary);
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
    style={{
      "--collection-track": `${collectionTrack}px`,
      "--list-track": `${listTrack}px`,
      "--inspector-track": `${inspectorTrack}px`
    } as CSSProperties}
  >
    {(!layout.collectionCollapsed || mobileLayout) && <CollectionRail
      collectionId={description.collection_id}
      name={description.display_name}
      count={collectionTotal ?? allNotes.length}
      types={description.types}
      activeFilter={noteFilter}
      notes={allNotes}
      foldersLoading={foldersLoading}
      surface={surface}
      onFilter={(filter) => { setNoteFilter(filter); selectSurface("notes"); }}
      onCreateFolder={beginFolderCreate}
      onCreateNoteInFolder={beginNoteInFolder}
      onCreateSubfolder={beginSubfolder}
      onCreateNoteWithTag={beginNoteWithTag}
      onCreateNoteWithType={beginNoteWithType}
      onOpenType={openTypeFromRail}
      onCopyFacet={copyFacet}
      onTypes={() => selectSurface("types")}
      onSettings={() => selectSurface("settings")}
      onShortcuts={() => setShortcutsOpen(true)}
      connectionState={connectionState}
      connectionIssue={connectionIssue}
      directAccess={connectionSummary?.directAccess}
      directAccessBusy={directAccessBusy}
      onRequestDirectAccess={() => void requestDirectAccess()}
      onReconnect={() => void refreshAfterConnectionGap()}
      onSwitch={() => setCollectionSwitcherOpen(true)}
      onCollapse={() => setLayout((current) => ({ ...current, collectionCollapsed: true }))}
    />}

    {surface === "notes" && <>
      {(!layout.listCollapsed || mobileLayout) && <NoteList
        notes={visibleNotes}
        types={description.types}
        loading={listLoading}
        structureLoading={foldersLoading}
        contentIndexing={contentIndexing}
        contentLoaded={contentLoaded}
        contentError={contentError}
        total={noteFilter ? undefined : collectionTotal}
        contentTotal={collectionTotal}
        selectedPath={selectedPath}
        pendingPath={pendingNotePath}
        statuses={noteStatuses}
        search={search}
        searchQuery={deferredSearch}
        searchContexts={searchContexts}
        sort={noteSort}
        scopeLabel={filterScopeLabel(noteFilter)}
        collectionName={filterLabel(noteFilter, description.display_name)}
        onSearch={setSearch}
        onSort={setNoteSort}
        onClearScope={() => setNoteFilter(undefined)}
        onQuickOpen={() => setQuickOpen(true)}
        onRetryContent={() => void loadContentIndex()}
        onSelect={navigateToNote}
        previewPath={notePreviewController.preview?.path}
        onPreview={notePreviewController.request}
        onDismissPreview={notePreviewController.dismiss}
        onCreate={beginCreate}
        onCollections={() => returnToMobilePane("collections")}
        leadingActions={layout.collectionCollapsed && <PaneControl label="Show collections sidebar" action="show" onClick={() => setLayout((current) => ({ ...current, collectionCollapsed: false }))} />}
        trailingActions={<PaneControl label="Hide notes sidebar" action="hide" onClick={() => setLayout((current) => ({ ...current, listCollapsed: true }))} />}
      />}
      {creationMode ? <NewNoteComposer
        types={description.types}
        defaultFolder={creationContext.folder}
        defaultTag={creationContext.tag}
        defaultType={creationContext.type}
        purpose={creationMode}
        preferences={preferences}
        recordPaths={allNotes.map((note) => note.path)}
        leadingActions={editorLeadingActions}
        onCreate={createNote}
        onCancel={cancelCreation}
        onDraftChange={setCreationDirty}
      /> : <main className="editor-pane" aria-label="Note editor">
        {noteLoading ? <NoteSkeleton leadingActions={editorLeadingActions} /> : document && draft ? <>
          <header className="editor-bar">
            <button className="mobile-back icon-button" aria-label="Back to notes" onClick={() => returnToMobilePane("notes")}><ArrowLeft aria-hidden="true" /></button>
            {editorLeadingActions}
            <div className="note-history" role="group" aria-label="Note history">
              <button
                className="icon-button"
                aria-label="Back in note history"
                title={historyBackPath ? `Back to ${historyBackPath} · Alt+Left` : "No earlier note"}
                disabled={!historyBackPath}
                onClick={() => navigateNoteHistory(-1)}
              ><ArrowLeft aria-hidden="true" /></button>
              <button
                className="icon-button"
                aria-label="Forward in note history"
                title={historyForwardPath ? `Forward to ${historyForwardPath} · Alt+Right` : "No later note"}
                disabled={!historyForwardPath}
                onClick={() => navigateNoteHistory(1)}
              ><ArrowRight aria-hidden="true" /></button>
            </div>
            <div className="path-wrap">
              {editingPath ? <form onSubmit={(event) => { event.preventDefault(); void requestRename(); }}>
                <label className="sr-only" htmlFor="note-path">Markdown path</label>
                <input id="note-path" className="path-input" value={pathDraft} onChange={(event) => setPathDraft(event.target.value)} onBlur={() => void requestRename()} autoFocus />
              </form> : <button className="path-button" onClick={() => setEditingPath(true)} title="Rename Markdown path"><span>{document.path}</span><Pencil aria-hidden="true" /></button>}
            </div>
            {preferences.vim && <span className="vim-label">vim</span>}
            <SaveIndicator
              state={saveState}
              activity={currentSession.current?.activity}
              detail={currentSession.current?.activityDetail}
              onCancel={currentSession.current?.mutationCancellable ? cancelActiveMutation : undefined}
            />
            {!mobileLayout && <button className={`icon-button backlink-button${backlinksOpen ? " active" : ""}`} aria-label="Backlinks" aria-pressed={backlinksOpen} onClick={() => {
              setBacklinksOpen((value) => {
                if (!value) setPropertiesOpen(false);
                return !value;
              });
            }}><Link2 aria-hidden="true" />{backlinkNotes.length > 0 && <span>{backlinkNotes.length}</span>}</button>}
            {!mobileLayout && <button className={`icon-button${propertiesOpen ? " active" : ""}`} aria-label="Note properties" aria-pressed={propertiesOpen} onClick={() => {
              setPropertiesOpen((value) => {
                if (!value) setBacklinksOpen(false);
                return !value;
              });
            }}><Info aria-hidden="true" /></button>}
            <ActionMenu label="More note actions" items={[
              ...(mobileLayout ? [
                { label: "Backlinks", icon: <Link2 aria-hidden="true" />, onSelect: () => { setPropertiesOpen(false); setBacklinksOpen(true); } },
                { label: "Note properties", icon: <Info aria-hidden="true" />, onSelect: () => { setBacklinksOpen(false); setPropertiesOpen(true); } }
              ] : []),
              { label: "Check note", icon: <Check aria-hidden="true" />, onSelect: () => void validateNote() },
              { label: "Delete note", icon: <Trash2 aria-hidden="true" />, tone: "danger", onSelect: () => void requestDelete() }
            ]} />
          </header>
          {activeRemoteDraft && <ConflictResolver local={draft} remote={activeRemoteDraft} onUseRemote={useRemoteVersion} onKeepLocal={keepLocalVersion} />}
          {mutationNotice && <div className="notice" role="status">
            <CircleAlert aria-hidden="true" />
            <span>{mutationNotice}</span>
            {activePendingRename && <div className="notice-actions"><button className="primary-notice-action" onClick={() => void performRename(activePendingRename.plan, activePendingRename.updateRefs)}>Resume rename</button></div>}
            {!activePendingRename && <button aria-label="Dismiss message" onClick={() => setNotice(undefined)}><X aria-hidden="true" /></button>}
          </div>}
          {renamePlan && renamePlan.session === currentSession.current && <div className="rename-confirm" role="alert">
            <div><strong>Rename this note?</strong><span>{renamePlan.affectedPaths.length.toLocaleString()} {renamePlan.affectedPaths.length === 1 ? "note contains" : "notes contain"} links that will change.{renamePlan.warnings.length > 0 ? ` ${renamePlan.warnings.length.toLocaleString()} ${renamePlan.warnings.length === 1 ? "link needs" : "links need"} attention and won’t be changed automatically.` : ""}</span></div>
            <button onClick={cancelRename}>Cancel</button>
            <button onClick={() => void performRename(renamePlan, false)}>Rename only</button>
            <button className="primary-confirm-action" onClick={() => void performRename(renamePlan, true)}>Rename and update links</button>
          </div>}
          {deletePlan && deletePlan.session === currentSession.current && <div className="delete-confirm" role="alert"><div><strong>Delete this note?</strong><span>{deletePlan.brokenLinkPaths.length > 0 ? `${deletePlan.brokenLinkPaths.length.toLocaleString()} ${deletePlan.brokenLinkPaths.length === 1 ? "note will keep a broken link" : "notes will keep broken links"}. ` : ""}You can undo the note deletion.</span></div><button onClick={() => setDeletePlan(undefined)}>Keep note</button><button className="danger-action" onClick={() => void deleteNote(deletePlan)}>Delete</button></div>}
          <article className="writing-surface" style={{ "--editor-font-size": `${preferences.fontSize}px` } as CSSProperties}>
            <label className="sr-only" htmlFor="note-title">Note title</label>
            <input id="note-title" className="title-input" value={draft.title} onChange={(event) => changeActiveDraft((current) => ({ ...current, title: event.target.value }))} placeholder="Untitled" spellCheck="true" />
            <Suspense fallback={<div className="body-editor code-editor-loading" role="status" aria-label="Loading note editor" aria-busy="true"><span /></div>}>
              <CodeEditor
                key={currentSession.current?.editorSessionKey ?? document.path}
                value={draft.body}
                onChange={(body) => changeActiveDraft((current) => ({ ...current, body }))}
                label="Note body"
                language="markdown"
                variant="writer"
                placeholder="Start writing"
                vimEnabled={preferences.vim}
                lineWrapping={preferences.lineWrapping}
                quietMarkdown={preferences.quietMarkdown}
                autoFocus
                className="body-editor"
                documentId={currentSession.current?.editorSessionKey}
                currentPath={document.path}
                recentPaths={recentPaths}
                linkSuggestions={linkOptions}
                linkTypes={linkTypeNames}
                onOpenLink={navigateToNote}
                onCreateLink={createLinkedNote}
                onPreviewLink={notePreviewController.request}
                onDismissLinkPreview={notePreviewController.dismiss}
              />
            </Suspense>
          </article>
        </> : <EmptyEditor
          leadingActions={editorLeadingActions}
          notice={editorNotice}
          onCreate={beginCreate}
          onRetry={() => void start()}
        />}
      </main>}
      {propertiesOpen && (document ? <Suspense fallback={<InspectorPanelLoading label="Note properties" />}>
        <PropertiesPanel
          key={document.path}
          note={document}
          types={description.types}
          recordPaths={allNotes.map((note) => note.path)}
          error={propertiesError}
          onClose={() => setPropertiesOpen(false)}
          onSave={saveProperties}
          onSaveDocument={(source, previousSource) => saveRecordSource(document.path, source, previousSource)}
        />
      </Suspense> : noteLoading ? <InspectorPanelLoading label="Note properties" /> : null)}
      {backlinksOpen && (document
        ? <BacklinksPanel notes={backlinkNotes} types={typeDescriptors} loading={foldersLoading} onClose={() => setBacklinksOpen(false)} onOpen={navigateToNote} />
        : noteLoading ? <InspectorPanelLoading label="Backlinks" /> : null)}
    </>}

    {surface === "types" && <Suspense fallback={<TypeWorkspaceLoading />}>{typeAccessMissing.length > 0 ? <TypeAccessPrompt
      leadingActions={layout.collectionCollapsed && <PaneControl label="Show collections sidebar" action="show" onClick={() => setLayout((current) => ({ ...current, collectionCollapsed: false }))} />}
      onAuthorize={() => void connectCollection()}
      onBack={() => returnToMobilePane("collections")}
    /> : <>
      {(!layout.listCollapsed || mobileLayout) && <TypeList
        types={description.types}
        selectedName={typeWorkspace === "definition" ? selectedTypeName : undefined}
        packsSelected={typeWorkspace === "packs"}
        leadingActions={layout.collectionCollapsed && <PaneControl label="Show collections sidebar" action="show" onClick={() => setLayout((current) => ({ ...current, collectionCollapsed: false }))} />}
        trailingActions={<PaneControl label="Hide types sidebar" action="hide" onClick={() => setLayout((current) => ({ ...current, listCollapsed: true }))} />}
        onSelect={selectType}
        onPacks={openTypePacks}
        onCreate={beginTypeCreate}
        onCollections={() => returnToMobilePane("collections")}
      />}
      {typeWorkspace === "packs" ? <TypePackBrowser
        types={description.types}
        contracts={description.contracts}
        catalog={contractCatalog.status === "ready" ? contractCatalog.catalog : undefined}
        loading={contractCatalog.status === "loading"}
        error={contractCatalog.status === "error" ? contractCatalog.message : undefined}
        canInstall={Boolean(connectionSummary?.operations.some((operation) =>
          operation === "all" || operation === "install_type_pack"
        ))}
        leadingActions={editorLeadingActions}
        onInstall={installCatalogPack}
        onOpenType={selectType}
        onRequestAccess={() => void connectCollection()}
        onReload={() => setContractCatalogReload((value) => value + 1)}
        onBack={() => returnToMobilePane("notes")}
      /> : <TypeInspector
        type={selectedType}
        availableTypes={description.types}
        contracts={description.contracts}
        document={typeDocument}
        source={typeSource}
        notes={allNotes}
        explicitTypeKeys={collectionExplicitTypeKeys(description.configuration)}
        creating={typeCreating}
        loading={typeLoading}
        saving={typeSaving}
        error={typeError}
        leadingActions={editorLeadingActions}
        onSourceChange={(source) => { setTypeSource(source); setTypeError(undefined); }}
        onSave={() => void saveType()}
        onRevert={() => {
          if (!typeDocument) return;
          setTypeSource(typeDocument.document);
          setTypeError(undefined);
        }}
        onCancel={cancelTypeCreate}
        onCreate={beginTypeCreate}
        onBrowsePacks={openTypePacks}
        onOpenSettings={() => selectSurface("settings")}
        onBack={() => returnToMobilePane("notes")}
      />}
    </>}</Suspense>}

    {surface === "settings" && <SettingsView
      description={description}
      connection={connectionSummary}
      noteCount={allNotes.length}
      preferences={preferences}
      directAccessBusy={directAccessBusy}
      leadingActions={layout.collectionCollapsed && <PaneControl label="Show collections sidebar" action="show" onClick={() => setLayout((current) => ({ ...current, collectionCollapsed: false }))} />}
      onChange={setPreferences}
      onBack={() => returnToMobilePane("collections")}
      onForget={requestForgetCurrentCollection}
      onRequestDirectAccess={() => void requestDirectAccess()}
    />}

    {(!layout.collectionCollapsed || (hasListPane && !layout.listCollapsed) || (inspectorVisible && !mobileLayout)) && <aside className="pane-resizers" aria-label="Sidebar layout controls">
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
      {inspectorVisible && !mobileLayout && <PaneResizeHandle
        className="inspector-resizer"
        label="Resize note inspector"
        value={inspectorTrack}
        min={INSPECTOR_WIDTH.min}
        max={inspectorResizeMax}
        direction="reverse"
        onChange={(inspectorWidth) => setLayout((current) => ({ ...current, inspectorWidth }))}
        onReset={() => setLayout((current) => ({ ...current, inspectorWidth: INSPECTOR_WIDTH.default }))}
        onDragChange={(dragging) => setResizingPane(dragging ? "inspector" : undefined)}
      />}
    </aside>}
    {recoveryAction && <div className="recovery-bar" role="status">
      <span>{recoveryAction.kind === "delete" ? `Deleted “${noteTitle(recoveryAction.document, typeDescriptors)}”.` : `Renamed to “${recoveryAction.to}”.`}</span>
      <button disabled={recoveryBusy} onClick={() => void undoRecovery()}><Undo2 aria-hidden="true" />{recoveryBusy ? "Undoing" : "Undo"}</button>
      <button className="icon-button" aria-label="Dismiss undo" disabled={recoveryBusy} onClick={() => setRecoveryAction(undefined)}><X aria-hidden="true" /></button>
    </div>}
    {quickOpen && <QuickOpen
      index={searchIndex}
      recentPaths={recentPaths}
      types={typeDescriptors}
      onSelect={(path) => {
        setSearch("");
        setNoteFilter(undefined);
        setSurface("notes");
        navigateToNote(path);
      }}
      onClose={() => setQuickOpen(false)}
    />}
    {shortcutsOpen && <ShortcutHelp onClose={() => setShortcutsOpen(false)} />}
    {collectionSwitcherOpen && <CollectionSwitcher
      activeCollectionId={connectionSummary?.collectionId}
      connections={sessionSnapshot.connections}
      displayName={description.display_name}
      onOpen={requestOpenSavedCollection}
      onConnect={requestConnectAnotherCollection}
      onClose={() => setCollectionSwitcherOpen(false)}
    />}
    {confirmation && <ConfirmDialog
      title={confirmation.title}
      body={confirmation.body}
      confirmLabel={confirmation.confirmLabel}
      cancelLabel={confirmation.cancelLabel}
      tone={confirmation.tone}
      onConfirm={confirmation.onConfirm}
      onClose={() => setConfirmation(undefined)}
    />}
    <NotePreviewCard preview={notePreviewController.preview} />
  </div>;
}

function ConnectScreen({ notice, missingOperations = [], connections, onConnect, onOpen, onForget }: {
  notice?: string;
  missingOperations?: string[];
  connections: ConnectionSummary[];
  onConnect: () => void;
  onOpen: (collectionId: string) => void;
  onForget: (connection: ConnectionSummary) => void;
}) {
  const updatingAccess = missingOperations.length > 0;
  return <main className="connect-screen"><section>
    <Wordmark />
    <h1>Your notes,<br />as files.</h1>
    <p className="connect-copy">{updatingAccess
      ? `Update access to ${accessSummary(missingOperations)} in this collection.`
      : "Choose the collection you want to write in."}</p>
    {connections.length > 0 && <div className="saved-collections" aria-label="Recent collections">
      <p>Recent collections</p>
      {connections.map((connection) => {
        const name = connection.displayName ?? "Untitled collection";
        return <div className="saved-collection-item" key={connection.collectionId}>
          <button className="saved-collection-row" onClick={() => onOpen(connection.collectionId)}>
            <span><strong>{name}</strong><small>Previously opened in mdbase editor</small></span>
            <ChevronRight aria-hidden="true" />
          </button>
          <ActionMenu label={`Collection options for ${name}`} items={[{
            label: "Forget from this browser",
            icon: <Trash2 aria-hidden="true" />,
            tone: "danger",
            onSelect: () => onForget(connection)
          }]} />
        </div>;
      })}
    </div>}
    <button className="connect-button" onClick={onConnect}>{updatingAccess
      ? "Update access"
      : connections.length
        ? "Choose another collection"
        : "Choose a collection"} <ChevronRight aria-hidden="true" /></button>
    <p className="access-copy">{updatingAccess
      ? "mdbase connect keeps the access you already approved and shows only what needs to be added."
      : "You’ll continue to mdbase connect. Sign in if asked, choose a collection, and approve mdbase editor. You’ll return here automatically; your files stay where they are."}</p>
    <details className="compatibility-help"><summary>Collection not listed?</summary><p>The editor opens mdbase 0.3 collections. For an older collection, use mdbase to upgrade a copy, verify that copy, then choose it here. Your original files can stay untouched while you check the result.</p></details>
    {notice && <p className="connect-error" role="alert">{notice}</p>}
  </section></main>;
}

function CollectionSwitcher({ activeCollectionId, connections, displayName, onOpen, onConnect, onClose }: {
  activeCollectionId?: string;
  connections: ConnectionSummary[];
  displayName: string;
  onOpen: (collectionId: string) => void;
  onConnect: () => void;
  onClose: () => void;
}) {
  return <Dialog titleId="collection-switcher-title" className="collection-switcher" onClose={onClose}>
    <header>
      <h2 id="collection-switcher-title">Choose a collection</h2>
      <button className="icon-button" aria-label="Close collection switcher" onClick={onClose}><X aria-hidden="true" /></button>
    </header>
    <div className="collection-switcher-list">
      {connections.map((connection) => {
        const active = connection.collectionId === activeCollectionId;
        const name = active ? displayName : connection.displayName ?? "Untitled collection";
        return <button
          key={connection.collectionId}
          className={active ? "current" : undefined}
          aria-current={active ? "true" : undefined}
          onClick={() => active ? onClose() : onOpen(connection.collectionId)}
        >
          <span><strong>{name}</strong>{active && <small>Current collection</small>}</span>
        </button>;
      })}
    </div>
    <footer>
      <button className="collection-connect-another" onClick={onConnect}><FilePlus2 aria-hidden="true" />Choose another collection</button>
    </footer>
  </Dialog>;
}

function TypeWorkspaceLoading() {
  return <>
    <section className="type-list-pane type-workspace-loading" aria-label="Loading types"><div /><span /><span /><span /></section>
    <main className="type-inspector type-workspace-loading" aria-label="Loading type definition"><div /><strong /><span /><span /></main>
  </>;
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

function MdbaseMark() {
  return <svg className="wordmark-mark" viewBox="18 18 84 84" aria-hidden="true" focusable="false">
    <g className="wordmark-mark-ink">
      <rect x="22" y="22" width="20" height="10" rx="2" />
      <rect x="50" y="22" width="20" height="10" rx="2" />
      <rect x="78" y="22" width="20" height="10" rx="2" />
      <rect x="22" y="44" width="12" height="10" rx="2" />
      <rect x="22" y="66" width="28" height="10" rx="2" />
      <rect x="58" y="66" width="40" height="10" rx="2" />
      <rect x="22" y="88" width="20" height="10" rx="2" />
      <rect x="50" y="88" width="20" height="10" rx="2" />
      <rect x="78" y="88" width="20" height="10" rx="2" />
    </g>
    <rect className="wordmark-mark-accent" x="42" y="44" width="56" height="10" rx="2" />
  </svg>;
}

function Wordmark() {
  return <div className="wordmark"><MdbaseMark /><span className="wordmark-label"><span>mdbase</span><strong>editor</strong></span></div>;
}

function CollectionRail({ collectionId, name, count, types, activeFilter, notes, foldersLoading, surface, connectionState, connectionIssue, directAccess, directAccessBusy, onFilter, onCreateFolder, onCreateNoteInFolder, onCreateSubfolder, onCreateNoteWithTag, onCreateNoteWithType, onOpenType, onCopyFacet, onTypes, onSettings, onShortcuts, onReconnect, onRequestDirectAccess, onSwitch, onCollapse }: {
  collectionId: string;
  name: string;
  count: number;
  types: CollectionTypeDescriptor[];
  activeFilter?: NoteFilter;
  notes: NoteSummary[];
  foldersLoading: boolean;
  surface: Surface;
  connectionState: ConnectionState;
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
  const collectionFolders = useMemo(() => folderTree(notes), [notes]);
  const tagFacets = useMemo(() => collectionTags(notes), [notes]);
  const typeFacets = useMemo(() => {
    const icons = new Map(types.map((type) => [type.name, collectionTypeIcon(type)]));
    return collectionTypes(notes, types.map((type) => type.name))
      .map((item) => ({ ...item, icon: icons.get(item.name) }));
  }, [notes, typeKey]);
  return <aside className="collection-rail" aria-label="Collection navigation">
    <div className="rail-header"><Wordmark /><PaneControl label="Hide collections sidebar" action="hide" onClick={onCollapse} /></div>
    <nav>
      <button className="collection-name" aria-label={`Switch collection, current collection ${name}`} onClick={onSwitch}><span>{name}</span><ChevronDown aria-hidden="true" /></button>
      <button className={surface === "notes" && !activeFilter ? "selected" : ""} aria-label={`Notes, ${count} total`} onClick={() => onFilter(undefined)}><span><NotebookPen aria-hidden="true" />Notes</span><small>{count}</small></button>
      <button className={surface === "types" ? "selected" : ""} aria-label={`Types (${types.length})`} onClick={onTypes}><span><Braces aria-hidden="true" />Types</span><small>{types.length}</small></button>
      <button className={surface === "settings" ? "selected" : ""} onClick={onSettings}><span><Settings2 aria-hidden="true" />Settings</span></button>
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
    </nav>
    <footer className="connection-footer">
      {directAccess === "permission_required" && connectionState === "connected"
        ? <button className="local-access-action" disabled={directAccessBusy} onClick={onRequestDirectAccess}>{directAccessBusy ? "Checking…" : "Use this computer"}</button>
        : <p role="status" aria-label={`Collection ${connectionState}`} title={connectionIssue}><span className={`status-dot ${connectionState}`} aria-hidden="true" /><span>{connectionState === "connected" ? "Connected" : "Reconnecting"}</span></p>}
      {connectionState === "reconnecting" && <button className="reconnect-action" aria-label="Retry connection" onClick={onReconnect}>Retry</button>}
      <button className="shortcut-action" aria-label="Keyboard shortcuts" title="Keyboard shortcuts" onClick={onShortcuts}><Keyboard aria-hidden="true" /><span>Shortcuts</span></button>
    </footer>
  </aside>;
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

function NoteList({ notes, types, selectedPath, pendingPath, statuses, search, searchQuery, searchContexts, sort, scopeLabel, collectionName, loading, structureLoading, contentIndexing, contentLoaded, contentError, total, contentTotal, leadingActions, trailingActions, onSearch, onSort, onClearScope, onQuickOpen, onRetryContent, onSelect, previewPath, onPreview, onDismissPreview, onCreate, onCollections }: {
  notes: NoteSummary[];
  types: CollectionTypeDescriptor[];
  selectedPath?: string;
  pendingPath?: string;
  statuses: Map<string, NoteRowStatus>;
  search: string;
  searchQuery: string;
  searchContexts: Map<string, NoteSearchContext>;
  sort: NoteSort;
  scopeLabel?: string;
  collectionName: string;
  loading: boolean;
  structureLoading: boolean;
  contentIndexing: boolean;
  contentLoaded: number;
  contentError?: string;
  total?: number;
  contentTotal?: number;
  leadingActions?: React.ReactNode;
  trailingActions?: React.ReactNode;
  onSearch: (value: string) => void;
  onSort: (sort: NoteSort) => void;
  onClearScope: () => void;
  onQuickOpen: () => void;
  onRetryContent: () => void;
  onSelect: (path: string) => void;
  previewPath?: string;
  onPreview: (path: string, anchor: NotePreviewAnchor, source: NotePreviewSource) => void;
  onDismissPreview: () => void;
  onCreate: () => void;
  onCollections: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({ count: notes.length, getScrollElement: () => scrollRef.current, estimateSize: () => 76, overscan: 8 });
  const typeIcons = useMemo(() => new Map(types.map((type) => [type.name, collectionTypeIcon(type)])), [types]);
  return <section className="note-list-pane" aria-label="Notes">
    <header className="list-header"><button className="mobile-collections icon-button" aria-label="Collections" onClick={onCollections}><PanelLeft aria-hidden="true" /></button>{leadingActions}<div><h1>{collectionName}</h1><p aria-live="polite">{noteCountLabel(notes.length, loading, structureLoading, contentIndexing, contentLoaded, total, contentTotal, Boolean(search.trim()), sort)}{contentError && <button className="list-retry" title={contentError} onClick={onRetryContent}>Retry search</button>}</p></div>{trailingActions}<button className="icon-button new-note" aria-label="New note" onClick={onCreate}><FilePlus2 aria-hidden="true" /></button></header>
    <div className="note-list-controls">
      <div className="search-field"><Search aria-hidden="true" /><label className="sr-only" htmlFor="note-search">Search every note</label><input id="note-search" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search" />{search ? <button aria-label="Clear search" onClick={() => onSearch("")}><X aria-hidden="true" /></button> : <button className="quick-open-trigger" aria-label="Quick open" title="Quick open" onClick={onQuickOpen}><kbd>{navigator.platform.includes("Mac") ? "⌘" : "Ctrl"} P</kbd></button>}</div>
      <NoteListViewOptions sort={sort} scopeLabel={scopeLabel} onSort={onSort} onClearScope={onClearScope} />
    </div>
    <div className="note-scroll" ref={scrollRef} role="listbox" aria-label="Collection notes" aria-busy={structureLoading}>
      {notes.length ? <div className="virtual-list" style={{ height: virtualizer.getTotalSize() }}>{virtualizer.getVirtualItems().map((virtualRow) => {
        const note = notes[virtualRow.index];
        const status: NoteRowStatus | undefined = pendingPath === note.path
          ? { label: "Opening", tone: "busy", busy: true }
          : statuses.get(note.path);
        const searchContext = searchQuery.trim() ? searchContexts.get(note.path) : undefined;
        const title = noteTitle(note, types);
        const typeIcon = note.types.map((type) => typeIcons.get(type)).find(isPhosphorIconName);
        const requestPreview = (target: HTMLButtonElement) => {
          const { left, right, top, bottom } = target.getBoundingClientRect();
          onPreview(note.path, { left, right, top, bottom }, "sidebar");
        };
        return <button
          key={note.path}
          role="option"
          aria-selected={note.path === selectedPath}
          aria-busy={status?.busy || undefined}
          aria-disabled={status?.disabled || undefined}
          aria-describedby={previewPath === note.path ? notePreviewPopoverId() : undefined}
          className={`note-row${note.path === selectedPath ? " selected" : ""}${status ? ` ${status.tone}` : ""}`}
          onMouseEnter={(event) => requestPreview(event.currentTarget)}
          onMouseLeave={onDismissPreview}
          onFocus={(event) => requestPreview(event.currentTarget)}
          onBlur={onDismissPreview}
          onClick={() => {
            onDismissPreview();
            if (!status?.disabled) onSelect(note.path);
          }}
          style={{ transform: `translateY(${virtualRow.start}px)`, height: virtualRow.size }}
        ><span className="note-title-line">{typeIcon && <PhosphorIcon name={typeIcon} aria-hidden="true" />}<span className="note-title"><SearchMatchText text={title} ranges={searchQuery ? searchTextRanges(title, searchQuery) : []} /></span></span>{status
            ? <span className="note-transition">{status.label}</span>
            : searchContext
              ? <span className={`note-detail note-search-context ${searchContext.kind}`}><SearchMatchText text={searchContext.text} ranges={searchContext.ranges} /></span>
              : <span className="note-detail"><time>{noteTimestamp(note)}</time>{notePreview(note, types)}</span>}</button>;
      })}</div> : structureLoading ? <NoteListSkeleton /> : <div className="list-empty"><p>{search ? "No notes found." : "This collection is empty."}</p>{!search && <button onClick={onCreate}>Create the first note</button>}</div>}
    </div>
  </section>;
}

function NoteListSkeleton() {
  return <div className="note-list-skeleton" aria-hidden="true">{Array.from({ length: 8 }, (_, index) => <div key={index}><span /><small /></div>)}</div>;
}

function noteCountLabel(count: number, loading: boolean, structureLoading: boolean, contentIndexing: boolean, contentLoaded: number, total: number | undefined, contentTotal: number | undefined, searching: boolean, sort: NoteSort): string {
  if (searching && contentIndexing) return `${count.toLocaleString()} found so far · searching ${contentLoaded.toLocaleString()} of ${contentTotal?.toLocaleString() ?? "…"}`;
  if (loading && searching) return count ? `${count.toLocaleString()} found so far` : "Searching";
  if (structureLoading && count === 0) return "Reading notes";
  if (structureLoading) return `${count.toLocaleString()} of ${total?.toLocaleString() ?? "…"} notes`;
  return `${count.toLocaleString()} ${count === 1 ? "note" : "notes"} · ${searching ? "relevance" : noteSortSummary(sort)}`;
}

function filterLabel(filter: NoteFilter | undefined, fallback: string): string {
  if (!filter) return fallback;
  return filter.kind === "tag" ? `#${filter.value}` : filter.value;
}

function filterScopeLabel(filter: NoteFilter | undefined): string | undefined {
  if (!filter) return undefined;
  if (filter.kind === "folder") return `Folder · ${filter.value}`;
  if (filter.kind === "tag") return `Tag · #${filter.value}`;
  return `Type · ${filter.value}`;
}

function accessSummary(operations: string[]): string {
  const labels: Record<string, string> = {
    describe: "inspect the collection",
    changes: "sync changes",
    read: "open notes",
    query: "list and search notes",
    validate: "check notes",
    create: "create notes",
    update: "edit notes",
    delete: "delete notes",
    rename: "move notes",
    read_type: "manage type definitions",
    create_type: "manage type definitions",
    update_type: "manage type definitions"
  };
  const missing = [...new Set(operations.map((operation) => labels[operation] ?? operation.replaceAll("_", " ")))];
  if (missing.length < 2) return missing[0] ?? "use the editor";
  if (missing.length === 2) return `${missing[0]} and ${missing[1]}`;
  return `${missing.slice(0, -1).join(", ")}, and ${missing.at(-1)}`;
}

function SaveIndicator({ state, activity, detail, onCancel }: { state: SaveState; activity?: NoteActivity; detail?: string; onCancel?: () => void }) {
  const activityLabels: Record<NoteActivity, string> = {
    saving: "Saving",
    properties: "Updating",
    renaming: "Renaming links",
    moving: "Moving",
    deleting: "Deleting",
    validating: "Checking"
  };
  const label = detail ?? (activity
    ? activityLabels[activity]
    : state === "saving" ? "Saving" : state === "waiting" ? "Unsaved" : state === "conflict" ? "Needs attention" : "Saved");
  const tone = activity ? "saving" : state;
  return <div className="save-indicator"><span className={`save-state ${tone}`} aria-live="polite">{!activity && state === "saved" && <Check aria-hidden="true" />}{label}</span>{onCancel && <button className="cancel-operation" onClick={onCancel}>Cancel</button>}</div>;
}

function BacklinksPanel({ notes, types, loading, onClose, onOpen }: {
  notes: NoteSummary[];
  types: CollectionTypeDescriptor[];
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
        <span><strong>{noteTitle(note, types)}</strong><small>{note.path}</small></span>
      </button>)}
      {!notes.length && <p className="quiet-empty">{loading ? "Reading collection links…" : "No notes link here yet."}</p>}
    </div>
  </aside>;
}

function NoteSkeleton({ leadingActions }: { leadingActions?: React.ReactNode }) {
  return <div className="note-skeleton" aria-label="Loading note" aria-busy="true"><div className="skeleton-bar">{leadingActions}<span /></div><div className="skeleton-document"><span className="skeleton-title" /><span /><span /><span className="short" /></div></div>;
}

function InspectorPanelLoading({ label }: { label: "Note properties" | "Backlinks" }) {
  return <aside className="properties-panel properties-panel-loading" aria-label={label} aria-busy="true"><div /><span /><span /><span /></aside>;
}

function TypeAccessPrompt({ leadingActions, onAuthorize, onBack }: {
  leadingActions?: React.ReactNode;
  onAuthorize: () => void;
  onBack: () => void;
}) {
  return <main className="empty-editor type-access-prompt" aria-label="Type access">
    <div className="empty-pane-actions"><button className="mobile-back icon-button" aria-label="Back to collections" onClick={onBack}><ArrowLeft aria-hidden="true" /></button>{leadingActions}</div>
    <div className="type-access-message">
      <Braces aria-hidden="true" />
      <h2>Type access needed</h2>
      <p>Notes are ready. Allow type-definition access only if you want to inspect or manage collection types.</p>
      <button onClick={onAuthorize}>Update access</button>
    </div>
  </main>;
}

function EmptyEditor({ leadingActions, notice, onCreate, onRetry }: {
  leadingActions?: React.ReactNode;
  notice?: string;
  onCreate: () => void;
  onRetry: () => void;
}) {
  return <div className="empty-editor">
    {leadingActions && <div className="empty-pane-actions">{leadingActions}</div>}
    {notice ? <div className="empty-error" role="alert">
      <CircleAlert aria-hidden="true" />
      <p>{notice}</p>
      <button onClick={onRetry}>Try again</button>
    </div> : <>
      <p>Select a note, or start a new one.</p>
      <button onClick={onCreate}>New note</button>
    </>}
  </div>;
}

function PaneControl({ label, action, onClick }: { label: string; action: "show" | "hide"; onClick: () => void }) {
  const Icon = action === "show" ? PanelLeftOpen : PanelLeftClose;
  return <button className="icon-button desktop-pane-control" aria-label={label} title={label} onClick={onClick}><Icon aria-hidden="true" /></button>;
}

function PaneResizeHandle({ className, label, value, min, max, direction = "forward", onChange, onReset, onDragChange }: {
  className: string;
  label: string;
  value: number;
  min: number;
  max: number;
  direction?: "forward" | "reverse";
  onChange: (value: number) => void;
  onReset: () => void;
  onDragChange: (dragging: boolean) => void;
}) {
  const drag = useRef<{ pointerId: number; startX: number; startValue: number } | undefined>(undefined);
  const boundedMax = Math.max(min, max);
  const directionFactor = direction === "reverse" ? -1 : 1;
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
      setBoundedValue(drag.current.startValue + directionFactor * (event.clientX - drag.current.startX));
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
      if (event.key === "ArrowLeft") next = value - directionFactor * step;
      if (event.key === "ArrowRight") next = value + directionFactor * step;
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

function updateMutationActivity(
  session: NoteSession,
  progress: MutationProgress,
  touch: (target: NoteSession) => void
): void {
  if (progress.state === "preflighting") {
    session.activityDetail = "Checking impact";
  } else if (progress.state === "applying") {
    if (progress.resumed) {
      session.activityDetail = progress.operation === "rename" ? "Recovering rename" : "Recovering deletion";
    } else if (progress.operation === "rename" && (progress.estimate?.affectedRecords ?? 0) > 0) {
      const count = progress.estimate!.affectedRecords;
      session.activityDetail = `Updating ${count.toLocaleString()} linked ${count === 1 ? "note" : "notes"}`;
    } else {
      session.activityDetail = progress.operation === "rename" ? "Moving note" : "Deleting note";
    }
  } else if (progress.state === "cancelled") {
    session.activityDetail = "Stopping safely";
  }
  session.mutationCancellable = progress.cancellable;
  touch(session);
}

function noteRowStatus(session: NoteSession): NoteRowStatus | undefined {
  if (session.deleted) return { label: "Deleting", tone: "busy", busy: true, disabled: true };
  if (session.remoteDocument) return { label: "Changed elsewhere", tone: "error", busy: false };
  if (session.activity) {
    const labels: Record<NoteActivity, string> = {
      saving: "Saving",
      properties: "Updating properties",
      renaming: "Renaming",
      moving: "Moving",
      deleting: "Deleting",
      validating: "Checking"
    };
    return { label: session.activityDetail ?? labels[session.activity], tone: "busy", busy: true };
  }
  if (session.saveState === "conflict") return { label: "Save failed", tone: "error", busy: false };
  if (session.error) return { label: "Needs attention", tone: "error", busy: false };
  if (session.saveState === "waiting") return { label: "Unsaved", tone: "quiet", busy: false };
  return undefined;
}

function summaryFromDocument(document: NoteDocument): NoteSummary {
  const { revision: _revision, ...summary } = document;
  return {
    ...summary,
    file: { ...document.file, path: document.path }
  };
}

function mergeHydratedNotes(current: NoteSummary[], hydrated: NoteSummary[]): NoteSummary[] {
  const byPath = new Map(hydrated.map((note) => [note.path, note]));
  const currentPaths = new Set(current.map((note) => note.path));
  const merged = current.map((note) => {
    const loaded = byPath.get(note.path);
    if (!loaded) return note;
    return {
      ...note,
      body: loaded.body,
      file: loaded.file ? { ...note.file, ...loaded.file } : note.file
    };
  });
  for (const note of hydrated) {
    if (!currentPaths.has(note.path)) merged.push(note);
  }
  return merged;
}

const RECENT_NOTES_KEY = "mdbase-editor:recent-notes";

function loadRecentPaths(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_NOTES_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 20) : [];
  } catch {
    return [];
  }
}

function rememberRecentPath(current: string[], path: string): string[] {
  const next = [path, ...current.filter((candidate) => candidate !== path)].slice(0, 20);
  localStorage.setItem(RECENT_NOTES_KEY, JSON.stringify(next));
  return next;
}

function forgetRecentPath(current: string[], path: string): string[] {
  const next = current.filter((candidate) => candidate !== path);
  localStorage.setItem(RECENT_NOTES_KEY, JSON.stringify(next));
  return next;
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (
    target.isContentEditable
    || target.matches("input, textarea, select, [role='textbox']")
    || Boolean(target.closest("[contenteditable='true']"))
  );
}

function collectionExplicitTypeKeys(configuration: unknown): string[] {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) return ["type", "types"];
  const settings = (configuration as Record<string, unknown>).settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return ["type", "types"];
  const configured = (settings as Record<string, unknown>).explicit_type_keys;
  if (!Array.isArray(configured)) return ["type", "types"];
  return configured.filter((key): key is string => typeof key === "string");
}

function isMobileHistoryState(value: unknown): value is MobileHistoryState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<MobileHistoryState>;
  return state.mdbaseEditor === true
    && (state.pane === "collections" || state.pane === "notes" || state.pane === "editor")
    && (state.surface === "notes" || state.surface === "types" || state.surface === "settings");
}
