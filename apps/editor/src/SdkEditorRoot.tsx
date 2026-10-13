import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createMdbase, type Mdbase, type MdbaseApplicationDeclaration, type MdbaseClient } from "@mdbase-dev/sdk";
import { CollectionGate, CollectionSwitcher, defaultCollectionCopy, type CollectionSection, type CollectionSectionItem, type CollectionSectionItemAction, type CollectionView } from "@mdbase-dev/ui/collections";
import { OpeningScreen } from "@mdbase-dev/ui/screens";
import { FeedbackButton } from "@mdbase-dev/ui/feedback";
import { describeError } from "@mdbase-dev/sdk/describe";
import type { Surface } from "./app-state-types";
import type { CollectionAvailability, MdbasePrivateCollection } from "@mdbase-dev/sdk/app-grant";
import { NativeEditorGateway, type EditorConnection, type EditorScopeActions } from "./native-gateway";
import { appGrantCollections, type PrivateCollections } from "./private-collections";
import { editorCollectionApp, type EditorCollectionSwitcher } from "./editor-collections";
import manifest from "../public/.well-known/mdbase-app.json";
import "@mdbase-dev/ui/collections.css";
import "./styles/shared-collections.css";

const EditorApp = lazy(() => import("./App").then((module) => ({ default: module.App })));

/** The exact bundled declaration goes to SDK self-registration unchanged.
 * Runtime origin is separate from its canonical HTTPS homepage. Registration,
 * consent, Worker/native assets and collection selection remain SDK-owned. */
export function createEditorMdbase(input: {
  origin: string;
  environment: MdbaseApplicationDeclaration["environment"];
}): Mdbase {
  const declaration: MdbaseApplicationDeclaration = { id: manifest.id, name: manifest.name,
    origin: input.origin, environment: input.environment, manifest };
  // The editor lists Private collections in its own section (app grants), so
  // the SDK leaves them out of its collection list.
  const sdk = createMdbase(declaration, { privateCollections: false });
  declarations.set(sdk, declaration);
  privateSources.set(sdk, appGrantCollections(declaration));
  return sdk;
}

/** The declaration each editor SDK was built from, for capability step-up. */
const declarations = new WeakMap<object, MdbaseApplicationDeclaration>();
/** Each editor SDK's Private collection grants (app-grant entry, relay to a computer). */
const privateSources = new WeakMap<object, PrivateCollections>();

export type EditorSdk = Mdbase;
export interface EditorNativeScope {
  readonly application: EditorScopeActions;
  readonly connection: EditorConnection;
  readonly gateway: NativeEditorGateway;
}
export interface SdkEditorRootProps {
  sdk: EditorSdk;
  onFeedbackContext?(surface: Surface, collectionName?: string): void;
  /** Real native domain UI only; defaults to the editor over the native gateway. */
  renderNative?(scope: EditorNativeScope): ReactNode;
  /** Private collections; defaults to app grants for an SDK made by createEditorMdbase. */
  privateCollections?: PrivateCollections;
}

/** A Private collection the editor opened itself: it owns this client and closes it on leave. */
interface PrivateScope {
  readonly connection: EditorConnection;
  readonly actions: EditorScopeActions;
}
let privateGeneration = 0;

/** The editor over the SDK's mdbase entry. The shared collection gate starts it
 * and owns sign-in, choosing, approval, setup, problems, deletion and sign-out;
 * the editor opens only the connection the gate hands over in phase `ready`, and
 * never closes the entry. Private collections come from app grants, listed as the
 * gate's and switcher's "Private collections" section. */
export function SdkEditorRoot({ sdk, renderNative, onFeedbackContext, privateCollections }: SdkEditorRootProps) {
  const declaration = declarations.get(sdk);
  const privates = privateCollections ?? privateSources.get(sdk) ?? null;
  const snapshot = useSyncExternalStore((listener) => sdk.subscribe(listener), () => sdk.getSnapshot(), () => sdk.getSnapshot());
  // Developer-only detail (e.g. which manifest fields a registration refusal named): logs, never the screen.
  const developerMessage = snapshot.status === "blocked" ? describeError(snapshot)?.developerMessage ?? null : null;
  useEffect(() => { if (developerMessage) console.warn(`mdbase editor: ${developerMessage}`); }, [developerMessage]);
  const priv = usePrivateSection(sdk, privates);
  const sections = priv.section ? [priv.section] : undefined;
  const switcher: EditorCollectionSwitcher = (onBeforeLeave) => <CollectionSwitcher mdbase={sdk} app={editorCollectionApp} allowDelete
    variant="full" allowPrivate={false} className="editor-collection-switcher" sections={sections} onBeforeLeave={onBeforeLeave} />;
  const extraActions = (view: CollectionView) => <>
    {priv.section && view.kind === "choosing" && <button type="button" className="mdbase-button" onClick={priv.add}>Add a Private collection</button>}
    {priv.problem && <p className="editor-private-problem" role="alert">{priv.problem}</p>}
    <FeedbackButton />
  </>;
  return <CollectionGate mdbase={sdk} app={editorCollectionApp} allowPrivate={false} allowDelete extraActions={extraActions} sections={sections}
    renderAppCollection={() => priv.scope && <NativeScopeView key={priv.scope.connection.generation} application={priv.scope.actions}
      connection={priv.scope.connection} declaration={declaration} switcher={switcher} renderNative={renderNative} onFeedbackContext={onFeedbackContext} />}>
    {(connection) => <NativeScopeView key={`${connection.id}:${connection.generation}`} application={sdk.application} connection={connection}
      declaration={declaration} switcher={switcher} renderNative={renderNative} onFeedbackContext={onFeedbackContext} />}
  </CollectionGate>;
}

/** The "Private collections" section: this browser's grants, opened through the relay.
 * Selecting a row does what its availability needs: open (waiting, bounded, for the
 * computer), approve again, get the update, or remove one that is gone. Owners get
 * "Delete collection…" in the row's menu, through the shared typed-name dialog. */
function usePrivateSection(sdk: Mdbase, privates: PrivateCollections | null) {
  const caller = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const [list, setList] = useState<readonly MdbasePrivateCollection[]>([]);
  const [scope, setScope] = useState<PrivateScope | null>(null);
  const [waiting, setWaiting] = useState<string | null>(null);
  /** The last failure, on its row when it has one. */
  const [failure, setFailure] = useState<{ id: string | null; message: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    caller.current = controller;
    return () => controller.abort();
  }, []);
  // The editor owns an open Private collection's client: close it with the root.
  useEffect(() => () => { scope?.actions.chooseAnother().catch(() => {}); }, [scope]);
  const load = useCallback((signal: AbortSignal) => {
    if (!privates) return;
    privates.collections({ signal }).then((next) => { if (!signal.aborted) setList(next); },
      (error: unknown) => { if (!signal.aborted) setFailure({ id: null, message: describeError(error)?.message ?? "Private collections couldn't be loaded." }); });
  }, [privates]);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);
  if (!privates) return { section: null, scope: null, problem: null, add: () => {} };

  /** One action at a time; it reports its own problem with the SDK's copy. */
  const act = async (id: string | null, action: (signal: AbortSignal) => Promise<unknown>) => {
    const controller = caller.current;
    if (!controller || controller.signal.aborted || busy.current) return;
    busy.current = true; setFailure(null);
    try { await action(controller.signal); }
    catch (error) { if (!controller.signal.aborted) setFailure({ id, message: describeError(error)?.message ?? "The collection couldn't be opened. Try again." }); }
    finally { busy.current = false; }
  };
  const setAvailability = (collectionId: string, availability: CollectionAvailability) =>
    setList((current) => current.map((entry) => entry.collectionId === collectionId ? { ...entry, availability } : entry));
  const open = async (entry: MdbasePrivateCollection, signal: AbortSignal) => {
    let availability = entry.availability;
    if (availability.state !== "available") {
      setWaiting(entry.collectionId);
      try {
        availability = await privates.waitForAvailable(entry.collectionId, { signal, timeoutMs: 10 * 60_000,
          onAvailability: (next) => setAvailability(entry.collectionId, next) });
      } finally { if (!signal.aborted) setWaiting(null); }
      setAvailability(entry.collectionId, availability);
      if (availability.state !== "available") return;
    }
    const client = await privates.open(entry.collectionId, { signal });
    if (signal.aborted || client.collection !== entry.collectionId) { client.close(); if (!signal.aborted) throw new Error("The collection that opened isn't the one you chose."); return; }
    let live = true;
    const application = sdk.application;
    const connection: EditorConnection = { id: client.collection, displayName: entry.displayName, generation: `private:${++privateGeneration}`,
      records: client, files: client.files, isCurrent: () => live };
    const leave = () => { if (!live) return; live = false; client.close(); setScope((current) => current?.connection === connection ? null : current); };
    const actions: EditorScopeActions = {
      chooseAnother: async () => { leave(); return application.getSnapshot(); },
      reauthorize: async (options) => { await privates.authorize(entry.collectionId, options); leave(); return application.getSnapshot(); },
      select: async (collectionId, options) => { leave(); return application.select(collectionId, options); },
      forget: async (collectionId, options) => {
        if (collectionId !== entry.collectionId) return application.forget(collectionId, options);
        leave(); await privates.forget(collectionId);
        return application.getSnapshot();
      }
    };
    setScope({ connection, actions });
  };
  const authorize = (collectionId?: string) => {
    if (busy.current) return;
    // Reserve the consent popup inside the click, before act's first await.
    const granted = privates.authorize(collectionId, caller.current ? { signal: caller.current.signal } : {});
    granted.catch(() => {});
    void act(collectionId ?? null, async (signal) => {
      const { collectionId: approved } = await granted;
      const next = await privates.collections({ signal });
      if (signal.aborted) return;
      setList(next);
      const entry = next.find((item) => item.collectionId === approved);
      if (entry) await open(entry, signal);
    });
  };
  const select = (item: CollectionSectionItem) => {
    const entry = list.find((candidate) => candidate.collectionId === item.id);
    if (!entry) return;
    const copy = entry.availability.state === "unavailable" ? describeError(entry.availability) : null;
    if (copy?.action === "approve") authorize(entry.collectionId);
    else if (copy?.action === "update_app") { if (copy.updateUrl) window.open(copy.updateUrl, "_blank", "noreferrer"); }
    else if (copy?.action === "choose_collection") void act(entry.collectionId, async () => {
      await privates.forget(entry.collectionId);
      setList((current) => current.filter((candidate) => candidate.collectionId !== entry.collectionId));
    });
    else void act(entry.collectionId, (signal) => open(entry, signal));
  };
  /** Owners only (Connect's reported role); the SDK and control plane check again. The dialog asks for the name first. */
  const deleteAction = (entry: MdbasePrivateCollection): CollectionSectionItemAction => ({
    id: "delete", label: defaultCollectionCopy.deleteCollection, danger: true,
    onSelect: (_item, { confirmDelete }) => confirmDelete((outcome) => {
      if (outcome === "cancelled") return;
      if (outcome === "deleted" && scope?.connection.id === entry.collectionId) void scope.actions.chooseAnother().catch(() => {});
      // The relay stops listing a deleted collection.
      if (caller.current) load(caller.current.signal);
    }),
  });
  const items = list.map((entry): CollectionSectionItem => {
    const reason = entry.availability.state === "unavailable" ? entry.availability.reason : null;
    const deletable = entry.role === "owner" && reason !== "access_removed" && reason !== "collection_deleted";
    return {
      id: entry.collectionId, name: entry.displayName, current: scope?.connection.id === entry.collectionId,
      detail: failure?.id === entry.collectionId ? failure.message : waiting === entry.collectionId ? "Waiting for your computer…" : privateDetail(entry.availability),
      actions: deletable ? [deleteAction(entry)] : undefined,
    };
  });
  return {
    section: { id: "private", title: "Private collections", items, onSelect: select, onClose: () => scope?.actions.chooseAnother().catch(() => {}) } satisfies CollectionSection,
    scope,
    problem: failure?.id === null ? failure.message : null,
    add: () => authorize(),
  };
}

/** A Private row's second line: its availability, and what selecting it does when that isn't opening. */
function privateDetail(availability: CollectionAvailability): string | null {
  if (availability.state === "opening") return "Getting this collection ready…";
  const copy = availability.state === "unavailable" ? describeError(availability) : null;
  if (!copy) return null;
  const fix = copy.action === "choose_collection" ? "Remove from this browser"
    : copy.action === "approve" || copy.action === "update_app" ? copy.actionLabel : null;
  return fix ? `${copy.title} · ${fix}` : copy.title;
}

function NativeScopeView({ application, connection, declaration, switcher, renderNative, onFeedbackContext }: {
  application: EditorScopeActions;
  connection: EditorConnection;
  declaration?: MdbaseApplicationDeclaration;
  switcher: EditorCollectionSwitcher;
  renderNative?: SdkEditorRootProps["renderNative"];
  onFeedbackContext?: SdkEditorRootProps["onFeedbackContext"];
}) {
  const client = connection.records;
  // The parent keys by original SDK ID/generation. A later snapshot may return
  // a new facade object for the same scope; it must not retire this gateway.
  const [original] = useState(connection);
  const [view, setView] = useState<{ client: MdbaseClient; scope: EditorNativeScope } | null>(null);
  useEffect(() => {
    const gateway = new NativeEditorGateway(application, original, declaration);
    let active = true;
    queueMicrotask(() => { if (active) setView({ client, scope: { application, connection: original, gateway } }); });
    return () => { active = false; gateway.dispose(); };
  }, [application, client, declaration, original]);
  const opening = <OpeningScreen app="editor" title={`Opening ${original.displayName}`} />;
  if (!view || view.client !== client) return opening;
  if (renderNative) return renderNative(view.scope);
  return <Suspense fallback={opening}><EditorApp gateway={view.scope.gateway} collectionSwitcher={switcher} onFeedbackContext={onFeedbackContext} /></Suspense>;
}
