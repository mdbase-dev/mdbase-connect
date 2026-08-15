import {
  ArrowCounterClockwiseIcon as Undo2,
  ArrowLeftIcon as ArrowLeft,
  ArrowRightIcon as ArrowRight,
  CheckIcon as Check,
  InfoIcon as Info,
  LinkIcon as Link2,
  PencilSimpleIcon as Pencil,
  TrashIcon as Trash2,
  WarningCircleIcon as CircleAlert,
  XIcon as X
} from "./icons";
import { MdbaseConnectError, type CollectionDescription, type CollectionTypeDescriptor, type MutationProgress } from "@mdbase-dev/connect";
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
import { AttachmentTransfer, attachmentMenuItem, useAttachmentUpload } from "./AttachmentUpload";
import { useCollectionBrowserEntries } from "./collection-browser";
import { CollectionRail } from "./CollectionRail";
import { CollectionSwitcher, ConnectScreen } from "./ConnectionScreens";
import { ConflictResolver } from "./ConflictResolver";
import { ConfirmDialog } from "./Dialog";
import {
  loadContractCatalog,
  type ContractCatalogPack
} from "./contract-catalog";
import { reviewCatalogPackInstallation } from "./catalog-pack-installation";
import type { AppPhase, ConnectionState, ContractCatalogLoadState, CreationContext, MobileHistoryState, MobilePane, Surface } from "./app-state-types";
import { gatewayError, missingCoreCapabilities, missingTypeCapabilities } from "./gateway";
import { useCollectionAuthorization } from "./collection-authorization";
import { OpeningScreen, TypeWorkspaceLoading } from "./LoadingScreens";
import { MarkdownNoteEditor } from "./MarkdownNoteEditor";
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
  CollectionFile,
  CollectionSessionSnapshot,
  ConnectionSummary,
  CreateNoteInput,
  NoteDocument,
  NoteSummary,
  TypeDocument
} from "./model";
import {
  editableNote,
  noteTags,
  noteTitle,
  safeRenamePath
} from "./note";
import { NoteOperationCoordinator } from "./note-operation-coordinator";
import {
  NoteSessionStore,
  sessionDirty,
  type Draft,
  type NoteActivity,
  type NoteSession,
  type SaveState
} from "./note-session";
import { loadNoteSort, saveNoteSort, sortNotes, type NoteSort } from "./note-list-view";
import { filterLabel, filterScopeLabel, NoteList, type NoteFilter, type NoteRowStatus } from "./NoteList";
import {
  NotePreviewCard,
  useNotePreview
} from "./NotePreview";
import {
  IncrementalNoteSearchIndex,
  searchNoteResults
} from "./note-search";
import { initialEditorSurface, loadPreferences, savePreferences, type EditorPreferences } from "./preferences";
import { composeRecordSource, replaceDocumentFrontmatter } from "./record-source";
import { QuickOpen, ShortcutHelp } from "./QuickOpen";
import { SettingsView } from "./SettingsView";
import { NEW_TYPE_SOURCE } from "./type-constants";
import { useCollectionIndex } from "./use-collection-index";
import { useCollectionWatch } from "./use-collection-watch";
import { useFileInventory } from "./use-file-inventory";
import { useFileAssetStore } from "./use-file-assets";
import { useFileWorkspace } from "./use-file-workspace";
import { useEmbeddedNoteReferences } from "./note-embeds";
import { useVisibleEmbedKeys } from "./use-visible-embed-keys";
import {
  BacklinksPanel,
  EmptyEditor,
  InspectorPanelLoading,
  NoteSkeleton,
  PaneControl,
  PaneResizeHandle,
  SaveIndicator,
  TypeAccessPrompt
} from "./WorkspaceChrome";

const TypeList = lazy(() => import("./TypeBrowser").then((module) => ({ default: module.TypeList })));
const TypeInspector = lazy(() => import("./TypeBrowser").then((module) => ({ default: module.TypeInspector })));
const TypePackBrowser = lazy(() => import("./TypeBrowser").then((module) => ({ default: module.TypePackBrowser })));
const PropertiesPanel = lazy(() => import("./PropertiesPanel").then((module) => ({ default: module.PropertiesPanel })));
const NewNoteComposer = lazy(() => import("./NewNoteComposer").then((module) => ({ default: module.NewNoteComposer })));
const FileViewer = lazy(() => import("./FileViewer").then((module) => ({ default: module.FileViewer })));
const FileWorkspace = lazy(() => import("./FileViewer").then((module) => ({ default: module.FileWorkspace })));
const emptyTypeDescriptors: CollectionTypeDescriptor[] = [];

interface Confirmation {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  initialFocus?: "confirm" | "cancel";
  onConfirm: () => void | Promise<void>;
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
  const { controller: indexController, state: collectionIndex } = useCollectionIndex(gateway);
  const { controller: fileController, state: fileInventory } = useFileInventory(gateway);
  const fileAssetStore = useFileAssetStore(gateway);
  const {
    notes: allNotes,
    total: collectionTotal,
    listLoading,
    structureLoading: foldersLoading,
    structureComplete,
    contentComplete,
    contentIndexing,
    contentLoaded,
    contentError
  } = collectionIndex;
  const [phase, setPhase] = useState<AppPhase>("starting");
  const [description, setDescription] = useState<CollectionDescription>();
  const [sessionSnapshot, setSessionSnapshot] = useState<CollectionSessionSnapshot>(() => gateway.sessionSnapshot());
  const connectionSummary = sessionSnapshot.status === "ready" ? sessionSnapshot.connection : null;
  const [connectionState, setConnectionState] = useState<ConnectionState>("connected");
  const [connectionIssue, setConnectionIssue] = useState<string>();
  const [directAccessBusy, setDirectAccessBusy] = useState(false);
  const [connectionRetry, setConnectionRetry] = useState(0);
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
  const [surface, setSurface] = useState<Surface>(initialEditorSurface);
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
  const { files: visibleFileEmbedKeys, notes: visibleNoteEmbedKeys,
    updateFiles: updateVisibleFileEmbeds, updateNotes: updateVisibleNoteEmbeds } = useVisibleEmbedKeys(document?.path);
  const [, setSessionTick] = useState(0);
  const documentGeneration = useRef(0);
  const navigationGeneration = useRef(0);
  const typeGeneration = useRef(0);
  const typeDescriptorsRef = useRef<CollectionTypeDescriptor[]>(emptyTypeDescriptors);
  const noteSessions = useRef(new NoteSessionStore());
  const noteHistory = useRef<NoteNavigationHistory>({ paths: [], index: -1 });
  const linkCreations = useRef(new Set<string>());
  const renameRequest = useRef<string | undefined>(undefined);
  const deleteRequest = useRef<string | undefined>(undefined);
  const searchIndexCache = useRef(new IncrementalNoteSearchIndex());
  const mobileHistoryInitialized = useRef(false);
  const ignoreNextMobileHistoryPush = useRef(false);
  const mobileLayout = viewportWidth <= 760;
  const typeDescriptors = description?.types ?? emptyTypeDescriptors;
  const notePreviewController = useNotePreview(gateway, allNotes, typeDescriptors);
  const fileWorkspace = useFileWorkspace(
    fileAssetStore,
    fileInventory.files,
    draft?.body ?? "",
    document?.path,
    visibleFileEmbedKeys
  );
  const { selectedFile: selectedCollectionFile, setSelectedFile: setSelectedCollectionFile, selectedAsset: selectedFileAsset,
    pendingFilePath, setPendingFilePath, openAsset: openFileAsset, setOpenAsset: setOpenFileAsset, embeddedFiles } = fileWorkspace;
  const attachments = useAttachmentUpload({ gateway, inventory: fileController,
    inventoryFiles: fileInventory.files, activeSession: () => noteSessions.current.active, setNotice });
  useEffect(() => { savePreferences(preferences); }, [preferences]);
  useEffect(() => { saveLayoutPreferences(layout); }, [layout]);
  useEffect(() => { saveNoteSort(noteSort); }, [noteSort]);
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
    await indexController.reload();
  }, [indexController]);

  const loadContentIndex = useCallback((): Promise<void> => {
    return indexController.hydrate();
  }, [indexController]);

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
      await Promise.all([loadIndex(), fileController.reload(), refreshDescription()]);
      setConnectionRetry((value) => value + 1);
    } catch (error) {
      setConnectionIssue(gatewayError(error));
    }
  }, [fileController, loadIndex, refreshDescription]);

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
    indexController.upsert(summaryFromDocument(next), previousPath);
  }, [indexController]);

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
    if (noteSessions.current.active === session) setSaveState(session.activity === "saving" ? "saving" : session.saveState);
    setSessionTick((value) => value + 1);
  }, []);

  const noteOperations = useMemo(() => new NoteOperationCoordinator({
    update: (input) => gateway.update(input),
    onSaved: (session, next) => {
      updateNoteSummary(next);
      if (noteSessions.current.active === session) setDocument(next);
    },
    onSaveError: (session, error) => {
      const message = gatewayError(error);
      session.error = message;
      setNotice(noteSessions.current.active === session
        ? message
        : `Couldn’t save “${session.draft.title || session.document.path}”. ${message}`);
    },
    onChange: touchSession
  }), [gateway, touchSession, updateNoteSummary]);

  const activateSession = useCallback((session: NoteSession) => {
    noteSessions.current.activate(session);
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
    const session = noteSessions.current.create(next, typeDescriptorsRef.current);
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
    if (noteSessions.current.active === session) {
      setDocument(next);
      setDraft(nextDraft);
      setPathDraft(next.path);
    }
    touchSession(session);
  }, [touchSession, updateNoteSummary]);

  const refreshCachedNote = useCallback(async (path: string) => {
    const initial = noteSessions.current.get(path);
    if (!initial || initial.deleted) return;

    await noteOperations.wait(initial);
    const session = noteSessions.current.get(path);
    if (session !== initial || session.deleted) return;

    const next = await gateway.read(path);
    if (noteSessions.current.get(path) !== session || session.deleted || next.revision === session.document.revision) return;

    if (sessionDirty(session)) {
      session.remoteDocument = next;
      session.saveState = "conflict";
      session.error = `“${session.draft.title || session.document.path}” changed elsewhere. Your edits are still here.`;
      touchSession(session);
      if (noteSessions.current.active === session) setNotice(session.error);
      return;
    }

    applyRemoteDocument(session, next);
  }, [applyRemoteDocument, gateway, noteOperations, touchSession]);

  const refreshChangedNote = useCallback(async (path: string) => {
    if (noteSessions.current.has(path)) {
      await refreshCachedNote(path);
      return;
    }

    const next = await gateway.read(path);
    if (noteSessions.current.has(path)) {
      await refreshCachedNote(path);
      return;
    }
    updateNoteSummary(next);
  }, [gateway, refreshCachedNote, updateNoteSummary]);

  const openNote = useCallback(async (path: string, options: NoteNavigationOptions = {}): Promise<boolean> => {
    const generation = ++documentGeneration.current;
    const cached = noteSessions.current.get(path);
    if (cached?.deleted) return false;
    setCreationMode(undefined);
    setSelectedCollectionFile(undefined);
    setPendingFilePath(undefined);
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
    const indexLoad = indexController.beginLoad();
    const fileLoad = fileController.reload().catch(() => []);
    const indexOutcome = indexLoad.complete.then(
      (result) => ({ result } as const),
      (error: unknown) => ({ error } as const)
    );
    setPhase("loading");
    setNotice(undefined);
    setConnectionState("connected");
    setConnectionIssue(undefined);
    setNoteLoading(true);
    let descriptionLoaded = false;
    try {
      const nextDescription = await refreshDescription();
      descriptionLoaded = true;
      setPhase("ready");
      const remembered = localStorage.getItem("mdbase-editor:last-note");
      let opened = remembered ? await openNote(remembered) : false;
      if (!opened) {
        setNoteLoading(true);
        const initial = (await indexLoad.firstPage)[0]?.path;
        if (initial) opened = await openNote(initial);
      }
      if (!opened) setNoteLoading(false);
      const outcome = await indexOutcome;
      await fileLoad;
      if ("error" in outcome) throw outcome.error;
      if (outcome.result.cancelled) return;
      if (!nextDescription.types.length) setSelectedTypeName(undefined);
    } catch (error) {
      setNoteLoading(false);
      setNotice(gatewayError(error));
      setPhase(descriptionLoaded && gateway.sessionSnapshot().status === "ready" ? "ready" : "disconnected");
    }
  }, [fileController, gateway, indexController, openNote, refreshDescription]);

  const { authorizeCollection } = useCollectionAuthorization({
    gateway,
    phase,
    start,
    setSessionSnapshot
  });

  useEffect(() => {
    if (phase !== "ready" || !structureComplete || listLoading || contentComplete || contentIndexing || contentError) return;
    void loadContentIndex();
  }, [contentComplete, contentError, contentIndexing, listLoading, loadContentIndex, phase, structureComplete]);

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
        if (connection && missingCoreCapabilities(connection).length === 0) await start();
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

  useCollectionWatch({ phase, connectionRetry, gateway, index: indexController, files: fileController, assets: fileAssetStore,
    loadIndex, refreshChangedNote, refreshDescription, refreshAfterConnectionGap, setConnectionState, setConnectionIssue, setNotice });

  const requestSave = useCallback(
    (session: NoteSession) => noteOperations.requestSave(session),
    [noteOperations]
  );

  const flushSession = useCallback(
    (session: NoteSession) => noteOperations.flush(session),
    [noteOperations]
  );

  const saveCurrentInBackground = useCallback(() => {
    const session = noteSessions.current.active;
    if (!session || (!sessionDirty(session) && !session.savePromise)) return;
    void requestSave(session).catch(() => undefined);
  }, [requestSave]);

  useEffect(() => {
    const session = noteSessions.current.active;
    if (!document || !draft || !session || session.remoteDocument || session.document.path !== document.path || !sessionDirty(session)) return;
    if (session.saveState !== "saving") {
      session.saveState = "waiting";
      setSaveState("waiting");
    }
    const timer = window.setTimeout(() => void requestSave(session).catch(() => undefined), 650);
    return () => window.clearTimeout(timer);
  }, [document, draft, requestSave]);

  function changeActiveDraft(change: (current: Draft) => Draft) {
    const session = noteSessions.current.active;
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
    const session = noteSessions.current.active;
    if (!session?.remoteDocument) return;
    applyRemoteDocument(session, session.remoteDocument);
    setNotice("Loaded the latest version.");
  }

  function keepLocalVersion() {
    const session = noteSessions.current.active;
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

  function navigateToFile(file: CollectionFile) {
    if (creationMode && creationDirty) {
      setConfirmation({
        title: `Discard this ${creationMode}?`,
        body: <p>The unfinished {creationMode} hasn’t been created.</p>,
        confirmLabel: `Discard ${creationMode}`,
        tone: "danger",
        onConfirm: () => finishNavigateToFile(file)
      });
      return;
    }
    finishNavigateToFile(file);
  }

  function finishNavigateToFile(file: CollectionFile) {
    navigationGeneration.current += 1;
    saveCurrentInBackground();
    setCreationMode(undefined);
    setCreationContext({});
    setCreationDirty(false);
    setPropertiesOpen(false);
    setBacklinksOpen(false);
    setSelectedCollectionFile(file);
    setPendingFilePath(file.path);
    setPendingNotePath(undefined);
    setMobilePane("editor");
    setNotice(undefined);
  }

  function finishNavigateToNote(path: string, options: NoteNavigationOptions = {}) {
    setCreationDirty(false);
    const generation = ++navigationGeneration.current;
    if (path === noteSessions.current.active?.document.path && !noteLoading) {
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
      if (noteOperations.pendingCount > 0
          || [...noteSessions.current.values()].some((session) => !session.deleted && sessionDirty(session))
          || typeCreating
          || Boolean(typeDocument && typeSource !== typeDocument.document)) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [typeCreating, typeDocument, typeSource]);

  const searchIndex = useMemo(() => searchIndexCache.current.build(allNotes, typeDescriptors), [allNotes, typeDescriptors]);
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
  const { visibleFiles, entries: visibleBrowserEntries } = useCollectionBrowserEntries(
    visibleNotes, fileInventory.files, noteFilter, deferredSearch, noteSort, typeDescriptors);
  const linkTypeNames = useMemo(() => description?.types.map((type) => type.name) ?? [], [description]);
  const linkOptions = useMemo(() => linkSuggestions(allNotes, linkTypeNames, typeDescriptors), [allNotes, linkTypeNames, typeDescriptors]);
  const embeddedNotes = useEmbeddedNoteReferences(
    gateway,
    draft?.body ?? "",
    allNotes,
    linkOptions,
    fileInventory.files,
    document?.path,
    visibleNoteEmbedKeys
  );
  const backlinkNotes = useMemo(() => document ? backlinksFor(document.path, allNotes, typeDescriptors) : [], [allNotes, document, typeDescriptors]);

  const runNoteOperation = useCallback(async <Result,>(
    session: NoteSession,
    activity: NoteActivity,
    operation: () => Promise<Result>
  ): Promise<Result> => noteOperations.run(session, async () => {
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
  }), [noteOperations, touchSession]);

  async function connectCollection() {
    setNotice(undefined);
    try { await authorizeCollection("selected"); } catch (error) { setNotice(gatewayError(error)); }
  }

  async function connectFromConnectScreen() {
    setNotice(undefined);
    try {
      const snapshot = gateway.sessionSnapshot();
      if (snapshot.status === "unavailable"
        || (snapshot.status === "ready" && missingCoreCapabilities(snapshot.connection).length > 0)) {
        await authorizeCollection("selected");
      }
      else await authorizeCollection("choose");
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
    await Promise.all([...noteSessions.current.values()]
      .filter((session) => !session.deleted)
      .map((session) => flushSession(session)));
    await noteOperations.waitForIdle();
  }

  function clearCollectionWorkspace() {
    indexController.reset();
    fileController.reset();
    fileAssetStore.reset();
    searchIndexCache.current.clear();
    navigationGeneration.current += 1;
    documentGeneration.current += 1;
    typeGeneration.current += 1;
    noteSessions.current.clear();
    publishNoteHistory({ paths: [], index: -1 });
    linkCreations.current.clear();
    typeDescriptorsRef.current = emptyTypeDescriptors;
    setDescription(undefined);
    setDocument(undefined);
    setDraft(undefined);
    setSelectedPath(undefined);
    setPendingNotePath(undefined);
    setSelectedCollectionFile(undefined);
    setPendingFilePath(undefined);
    setOpenFileAsset(undefined);
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
      if (missingCoreCapabilities(selected).length > 0) {
        setPhase("disconnected");
        await authorizeCollection("selected");
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
      await authorizeCollection("choose");
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
    indexController.create(summaryFromDocument(created));
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
    const sourcePath = noteSessions.current.active?.document.path;
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
      indexController.create(summaryFromDocument(created));
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
    const session = noteSessions.current.active;
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
      if (noteSessions.current.active !== session) {
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
      if (noteSessions.current.active === session) setPathDraft(session.document.path);
      setNotice(noteSessions.current.active === session
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
      noteSessions.current.move(from, renamed.path, session);
      updateNoteSummary(renamed, from);
      if (noteSessions.current.active === session) {
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
      if (error instanceof MdbaseConnectError && error.problem.operation_outcome === "unknown") {
        setPendingRenameRecovery({ plan, updateRefs });
        if (noteSessions.current.active === session) {
          setPathDraft(to);
          setEditingPath(true);
        }
      } else if (noteSessions.current.active === session) {
        setPathDraft(session.document.path);
      }
      setNotice(noteSessions.current.active === session
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
    noteSessions.current.active?.mutationController?.abort("Cancelled in mdbase editor");
  }

  function cancelRename() {
    setRenamePlan(undefined);
    renameRequest.current = undefined;
    const session = noteSessions.current.active;
    if (session) setPathDraft(session.document.path);
  }

  async function saveProperties(path: string, next: Record<string, unknown>) {
    const session = noteSessions.current.get(path);
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
      if (noteSessions.current.active === session) {
        setDocument(updated);
        setDraft(session.draft);
        setSaveState(session.saveState);
      }
      touchSession(session);
    } catch (error) {
      const message = gatewayError(error);
      session.error = message;
      setPropertiesError(message);
      setNotice(noteSessions.current.active === session
        ? message
        : `Couldn’t update properties for “${session.draft.title || session.document.path}”. ${message}`);
      touchSession(session);
      throw error;
    }
  }

  async function saveRecordSource(path: string, source: string, previousSource: string): Promise<NoteDocument | false> {
    const session = noteSessions.current.get(path);
    if (!session || session.deleted) return false;
    if (noteSessions.current.active === session) setPropertiesError(undefined);
    try {
      await flushSession(session);
      const currentSource = session.document.document ?? composeRecordSource(session.document.frontmatter, session.document.body ?? "");
      if (currentSource !== previousSource) {
        const message = "This note finished saving after Source was opened. Your source draft is preserved; close and reopen the panel to start from the latest record.";
        if (noteSessions.current.active === session) setPropertiesError(message);
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
      if (noteSessions.current.active === session) {
        setDocument(updated);
        setDraft(persistedDraft);
        setSaveState("saved");
      }
      touchSession(session);
      return updated;
    } catch (error) {
      const message = gatewayError(error);
      session.error = message;
      if (noteSessions.current.active === session) setPropertiesError(message);
      setNotice(noteSessions.current.active === session
        ? message
        : `Couldn’t update source for “${session.draft.title || session.document.path}”. ${message}`);
      touchSession(session);
      return false;
    }
  }

  async function validateNote() {
    const session = noteSessions.current.active;
    if (!session) return;
    setNotice(undefined);
    try {
      await flushSession(session);
      const diagnostics = await runNoteOperation(
        session,
        "validating",
        () => gateway.validate(session.document.path)
      );
      if (noteSessions.current.active === session) {
        setNotice(diagnostics.length ? diagnostics.map((item) => item.message).join(" ") : "No validation issues.");
      }
    } catch (error) {
      const message = gatewayError(error);
      setNotice(noteSessions.current.active === session
        ? message
        : `Couldn’t check “${session.draft.title || session.document.path}”. ${message}`);
    }
  }

  async function requestDelete() {
    const session = noteSessions.current.active;
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
      if (noteSessions.current.active === session) {
        setDeletePlan({ session, brokenLinkPaths: preflight.brokenLinkPaths });
      }
    } catch (error) {
      const message = gatewayError(error);
      session.error = message;
      setNotice(noteSessions.current.active === session
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
    indexController.stageRemoval(path);
    forgetNoteHistoryPath(path);
    setDeletePlan(undefined);
    if (noteSessions.current.active === session) {
      noteSessions.current.deactivate(session);
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
        noteSessions.current.delete(path);
        indexController.commitRemoval(path);
        setRecentPaths((current) => forgetRecentPath(current, path));
        if (deletedDocument) setRecoveryAction({ kind: "delete", document: deletedDocument });
      } catch (error) {
        session.deleted = false;
        indexController.rollbackRemoval(summaryFromDocument(session.document));
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
        noteSessions.current.create(restored, typeDescriptors);
        indexController.create(summaryFromDocument(restored));
        setNotice(`Restored “${noteTitle(restored, typeDescriptors)}”.`);
      } else {
        const session = noteSessions.current.get(action.to);
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
        noteSessions.current.move(action.to, action.from, session);
        updateNoteSummary(restored, action.to);
        if (noteSessions.current.active === session) {
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
    await reviewCatalogPackInstallation(pack, gateway, {
      installedTypeNames: description?.types.map(({ name }) => name) ?? [],
      confirm: (confirmation) => setConfirmation(confirmation),
      refreshDescription,
      isTypeDraftDirty: typeDraftDirty,
      openType: async (name) => {
        setTypeWorkspace("definition");
        setSelectedTypeName(name);
        setMobilePane("editor");
        await loadTypeSource(name);
      },
      notify: setNotice,
      onError: (error) => setTypeError(gatewayError(error))
    });
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
    if (connection) requestForgetConnection(connection, description?.displayName);
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
        const selectedIndex = visibleBrowserEntries.findIndex((entry) => entry.kind === "note"
          ? !selectedCollectionFile && entry.path === selectedPath
          : entry.path === selectedCollectionFile?.path);
        const direction = key === "j" ? 1 : -1;
        const fallback = direction > 0 ? 0 : visibleNotes.length - 1;
        const nextIndex = selectedIndex < 0
          ? fallback
          : Math.min(visibleBrowserEntries.length - 1, Math.max(0, selectedIndex + direction));
        const next = visibleBrowserEntries[nextIndex];
        if (next?.kind === "note") navigateToNote(next.path);
        else if (next) navigateToFile(next.file);
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
  }, [creationMode, phase, quickOpen, selectedCollectionFile, selectedPath, shortcutsOpen, surface, visibleBrowserEntries]);

  if (phase === "starting") return <OpeningScreen />;
  if (phase === "disconnected") return <>
    <ConnectScreen
      notice={notice}
      missingCapabilities={missingCoreCapabilities(connectionSummary)}
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
      initialFocus={confirmation.initialFocus}
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
  const activeRemoteDocument = noteSessions.current.active?.remoteDocument;
  const activeRemoteDraft = activeRemoteDocument ? editableNote(activeRemoteDocument, typeDescriptors) : undefined;
  const editorNotice = activeRemoteDocument ? undefined : notice;
  const activePendingRename = pendingRenameRecovery?.plan.session === noteSessions.current.active
    ? pendingRenameRecovery
    : undefined;
  const mutationNotice = editorNotice ?? (activePendingRename
    ? "This rename was interrupted after it started. Resume it to recover the collection’s authoritative result."
    : undefined);
  const canAttachFiles = Boolean(connectionSummary?.fileActions?.includes("add"));
  const typeAccessMissing = missingTypeCapabilities(connectionSummary);
  const editorLeadingActions = layout.listCollapsed ? <>
    {layout.collectionCollapsed && <PaneControl label="Show collections sidebar" action="show" onClick={() => setLayout((current) => ({ ...current, collectionCollapsed: false }))} />}
    <PaneControl label={`Show ${listName} sidebar`} action="show" onClick={() => setLayout((current) => ({ ...current, listCollapsed: false }))} />
  </> : undefined;
  const noteStatuses = new Map<string, NoteRowStatus>();
  for (const session of noteSessions.current.values()) {
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
      collectionId={description.collectionId}
      name={description.displayName}
      count={(collectionTotal ?? allNotes.length) + fileInventory.files.length}
      types={description.types}
      activeFilter={noteFilter}
      notes={allNotes}
      files={fileInventory.files}
      foldersLoading={foldersLoading || fileInventory.loading}
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
        entries={visibleBrowserEntries}
        noteCount={visibleNotes.length}
        fileCount={visibleFiles.length}
        types={description.types}
        loading={listLoading}
        structureLoading={foldersLoading}
        filesLoading={fileInventory.loading}
        fileError={fileInventory.error}
        contentIndexing={contentIndexing}
        contentLoaded={contentLoaded}
        contentError={contentError}
        total={noteFilter ? undefined : collectionTotal}
        contentTotal={collectionTotal}
        selectedPath={selectedCollectionFile ? undefined : selectedPath}
        selectedFilePath={selectedCollectionFile?.path}
        pendingPath={pendingNotePath}
        pendingFilePath={pendingFilePath}
        statuses={noteStatuses}
        search={search}
        searchQuery={deferredSearch}
        searchContexts={searchContexts}
        sort={noteSort}
        scopeLabel={filterScopeLabel(noteFilter)}
        collectionName={filterLabel(noteFilter, description.displayName)}
        onSearch={setSearch}
        onSort={setNoteSort}
        onClearScope={() => setNoteFilter(undefined)}
        onQuickOpen={() => setQuickOpen(true)}
        onRetryContent={() => void loadContentIndex()}
        onRetryFiles={() => void fileController.reload().catch(() => undefined)}
        onSelect={navigateToNote}
        onSelectFile={navigateToFile}
        previewPath={notePreviewController.preview?.path}
        onPreview={notePreviewController.request}
        onDismissPreview={notePreviewController.dismiss}
        onCreate={beginCreate}
        onCollections={() => returnToMobilePane("collections")}
        leadingActions={layout.collectionCollapsed && <PaneControl label="Show collections sidebar" action="show" onClick={() => setLayout((current) => ({ ...current, collectionCollapsed: false }))} />}
        trailingActions={<PaneControl label="Hide notes sidebar" action="hide" onClick={() => setLayout((current) => ({ ...current, listCollapsed: true }))} />}
      />}
      {selectedCollectionFile && selectedFileAsset ? <Suspense fallback={<NoteSkeleton leadingActions={editorLeadingActions} />}><FileWorkspace
        file={selectedCollectionFile}
        asset={selectedFileAsset}
        leadingActions={editorLeadingActions}
        onBack={() => returnToMobilePane("notes")}
        onRetry={() => void fileAssetStore.retry(selectedCollectionFile)}
      /></Suspense> : creationMode ? <Suspense fallback={<NoteSkeleton leadingActions={editorLeadingActions} />}><NewNoteComposer
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
      /></Suspense> : <main className="editor-pane" aria-label="Note editor">
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
              activity={noteSessions.current.active?.activity}
              detail={noteSessions.current.active?.activityDetail}
              onCancel={noteSessions.current.active?.mutationCancellable ? cancelActiveMutation : undefined}
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
              attachmentMenuItem(attachments, canAttachFiles, () => void authorizeCollection("selected").catch((error) => setNotice(gatewayError(error)))),
              { label: "Check note", icon: <Check aria-hidden="true" />, onSelect: () => void validateNote() },
              { label: "Delete note", icon: <Trash2 aria-hidden="true" />, tone: "danger", onSelect: () => void requestDelete() }
            ]} />
          </header>
          <AttachmentTransfer controller={attachments} />
          {activeRemoteDraft && <ConflictResolver local={draft} remote={activeRemoteDraft} onUseRemote={useRemoteVersion} onKeepLocal={keepLocalVersion} />}
          {mutationNotice && <div className="notice" role="status">
            <CircleAlert aria-hidden="true" />
            <span>{mutationNotice}</span>
            {activePendingRename && <div className="notice-actions"><button className="primary-notice-action" onClick={() => void performRename(activePendingRename.plan, activePendingRename.updateRefs)}>Resume rename</button></div>}
            {!activePendingRename && <button aria-label="Dismiss message" onClick={() => setNotice(undefined)}><X aria-hidden="true" /></button>}
          </div>}
          {renamePlan && renamePlan.session === noteSessions.current.active && <div className="rename-confirm" role="alert">
            <div><strong>Rename this note?</strong><span>{renamePlan.affectedPaths.length.toLocaleString()} {renamePlan.affectedPaths.length === 1 ? "note contains" : "notes contain"} links that will change.{renamePlan.warnings.length > 0 ? ` ${renamePlan.warnings.length.toLocaleString()} ${renamePlan.warnings.length === 1 ? "link needs" : "links need"} attention and won’t be changed automatically.` : ""}</span></div>
            <button onClick={cancelRename}>Cancel</button>
            <button onClick={() => void performRename(renamePlan, false)}>Rename only</button>
            <button className="primary-confirm-action" onClick={() => void performRename(renamePlan, true)}>Rename and update links</button>
          </div>}
          {deletePlan && deletePlan.session === noteSessions.current.active && <div className="delete-confirm" role="alert"><div><strong>Delete this note?</strong><span>{deletePlan.brokenLinkPaths.length > 0 ? `${deletePlan.brokenLinkPaths.length.toLocaleString()} ${deletePlan.brokenLinkPaths.length === 1 ? "note will keep a broken link" : "notes will keep broken links"}. ` : ""}You can undo the note deletion.</span></div><button onClick={() => setDeletePlan(undefined)}>Keep note</button><button className="danger-action" onClick={() => void deleteNote(deletePlan)}>Delete</button></div>}
          <MarkdownNoteEditor editorKey={noteSessions.current.active?.editorSessionKey ?? document.path}
            draft={draft} preferences={preferences} documentId={noteSessions.current.active?.editorSessionKey}
            currentPath={document.path} recentPaths={recentPaths} linkSuggestions={linkOptions} linkTypes={linkTypeNames}
            embeddedFiles={embeddedFiles} embeddedNotes={embeddedNotes} files={fileInventory.files} notes={allNotes}
            insertion={attachments.insertion} onTitleChange={(title) => changeActiveDraft((current) => ({ ...current, title }))}
            onBodyChange={(body) => changeActiveDraft((current) => ({ ...current, body }))} onOpenLink={navigateToNote}
            onCreateLink={createLinkedNote} onPreviewLink={notePreviewController.request}
            onDismissLinkPreview={notePreviewController.dismiss} onOpenFile={setOpenFileAsset} onOpenFileLink={navigateToFile}
            onVisibleFileEmbeds={updateVisibleFileEmbeds} onVisibleNoteEmbeds={updateVisibleNoteEmbeds} />
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
          operation === "all" || operation === "apply_type_pack"
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
      displayName={description.displayName}
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
      initialFocus={confirmation.initialFocus}
      onConfirm={confirmation.onConfirm}
      onClose={() => setConfirmation(undefined)}
    />}
    {openFileAsset && <Suspense fallback={null}><FileViewer asset={openFileAsset} onClose={() => setOpenFileAsset(undefined)} /></Suspense>}
    <NotePreviewCard preview={notePreviewController.preview} />
  </div>;
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
