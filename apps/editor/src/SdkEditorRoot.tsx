import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createMdbase, type Mdbase, type MdbaseApplicationDeclaration, type MdbaseClient } from "@mdbase-dev/sdk";
import { CollectionGate, CollectionSwitcher, DeleteCollectionDialog, useCollectionUi } from "@mdbase-dev/ui/collections";
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
  const sdk = createMdbase(declaration);
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

/** The editor over the SDK's mdbase entry. The shared collection gate owns sign-in,
 * choosing, approval, setup, problems, deletion and sign-out; the editor opens only
 * the connection the gate hands over in phase `ready`, and never closes the entry.
 * Private collections still come from app grants beside the gate. */
export function SdkEditorRoot({ sdk, renderNative, onFeedbackContext, privateCollections }: SdkEditorRootProps) {
  const declaration = declarations.get(sdk);
  const privates = privateCollections ?? privateSources.get(sdk) ?? null;
  const snapshot = useSyncExternalStore((listener) => sdk.subscribe(listener), () => sdk.getSnapshot(), () => sdk.getSnapshot());
  // Developer-only detail (e.g. which manifest fields a registration refusal named): logs, never the screen.
  const developerMessage = snapshot.status === "blocked" ? describeError(snapshot)?.developerMessage ?? null : null;
  useEffect(() => { if (developerMessage) console.warn(`mdbase editor: ${developerMessage}`); }, [developerMessage]);
  useEffect(() => {
    // Safe to call again (StrictMode); failures surface as the snapshot's phase.
    sdk.start().catch(() => undefined);
  }, [sdk]);
  const [privateScope, setPrivateScope] = useState<PrivateScope | null>(null);
  // Choosing a hosted collection from the rail leaves an open Private collection.
  useEffect(() => { if (privateScope && snapshot.phase.kind !== "choosing") void privateScope.actions.chooseAnother().catch(() => {}); }, [privateScope, snapshot.phase.kind]);
  useEffect(() => () => { privateScope?.actions.chooseAnother().catch(() => {}); }, [privateScope]);
  const leavePrivate = useCallback((generation: string) => setPrivateScope((current) => current?.connection.generation === generation ? null : current), []);
  const switcher: EditorCollectionSwitcher = (onBeforeLeave) => <CollectionSwitcher mdbase={sdk} app={editorCollectionApp} allowDelete
    variant="full" className="editor-collection-switcher" onBeforeLeave={onBeforeLeave} />;

  if (privateScope) {
    return <NativeScopeView key={privateScope.connection.generation} application={privateScope.actions} connection={privateScope.connection}
      declaration={declaration} switcher={switcher} renderNative={renderNative} onFeedbackContext={onFeedbackContext} />;
  }
  const choosing = snapshot.phase.kind === "choosing" && privates !== null;
  return <div className="editor-collections">
    <CollectionGate mdbase={sdk} app={editorCollectionApp} allowDelete extraActions={<FeedbackButton />}>
      {(connection) => <NativeScopeView key={`${connection.id}:${connection.generation}`} application={sdk.application} connection={connection}
        declaration={declaration} switcher={switcher} renderNative={renderNative} onFeedbackContext={onFeedbackContext} />}
    </CollectionGate>
    {choosing && <PrivateCollectionsSection sdk={sdk} privates={privates} onOpen={setPrivateScope} onLeave={leavePrivate} />}
  </div>;
}

/** Private collections, listed from this browser's grants and opened through the relay.
 * The shared gate lists only the installation's collections, so these sit beside it. */
function PrivateCollectionsSection({ sdk, privates, onOpen, onLeave }: { sdk: Mdbase; privates: PrivateCollections; onOpen(scope: PrivateScope): void; onLeave(generation: string): void }) {
  const ui = useCollectionUi({ mdbase: sdk, app: editorCollectionApp, allowDelete: true });
  const caller = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const [working, setWorking] = useState(false);
  const [list, setList] = useState<readonly MdbasePrivateCollection[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    const scope = new AbortController();
    caller.current = scope;
    return () => scope.abort();
  }, []);
  const refresh = useCallback(async (signal: AbortSignal) => {
    try {
      const next = await privates.collections({ signal });
      if (!signal.aborted) { setList(next); setProblem(null); }
    } catch (error) {
      if (!signal.aborted) setProblem(describeError(error)?.message ?? "Private collections couldn't be loaded.");
    }
  }, [privates]);
  useEffect(() => {
    const scope = new AbortController();
    void refresh(scope.signal);
    return () => scope.abort();
  }, [refresh]);
  /** Private actions report their own problem with the SDK's copy. */
  const act = async (action: (signal: AbortSignal) => Promise<unknown>) => {
    const scope = caller.current;
    if (!scope || scope.signal.aborted || busy.current) return;
    busy.current = true; setWorking(true); setProblem(null);
    try { await action(scope.signal); }
    catch (error) { if (!scope.signal.aborted) setProblem(describeError(error)?.message ?? "The collection couldn't be opened. Try again."); }
    finally { if (!scope.signal.aborted) { busy.current = false; setWorking(false); } }
  };
  const setAvailability = (collectionId: string, availability: CollectionAvailability) =>
    setList((current) => current.map((entry) => entry.collectionId === collectionId ? { ...entry, availability } : entry));
  const open = async (entry: Pick<MdbasePrivateCollection, "collectionId" | "displayName" | "availability">, signal: AbortSignal) => {
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
    const leave = () => { if (!live) return; live = false; client.close(); onLeave(connection.generation); };
    const connection: EditorConnection = { id: client.collection, displayName: entry.displayName, generation: `private:${++privateGeneration}`,
      records: client, files: client.files, isCurrent: () => live };
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
    onOpen({ connection, actions });
  };
  const authorize = (collectionId?: string) => {
    if (busy.current) return;
    // Reserve the consent popup inside the click, before act's first await.
    const granted = privates.authorize(collectionId, caller.current ? { signal: caller.current.signal } : {});
    granted.catch(() => {});
    void act(async (signal) => {
      const { collectionId: approved } = await granted;
      const next = await privates.collections({ signal });
      if (signal.aborted) return;
      setList(next);
      const entry = next.find((item) => item.collectionId === approved);
      if (entry) await open(entry, signal);
    });
  };
  return <section className="editor-private-collections" aria-labelledby="editor-private-collections-title">
    <h2 id="editor-private-collections-title">Private collections</h2>
    {list.map((entry) => <PrivateCollectionRow key={entry.collectionId} entry={entry} working={working}
      waiting={waiting === entry.collectionId} onOpen={() => void act((signal) => open(entry, signal))}
      onAuthorize={() => authorize(entry.collectionId)}
      onDelete={entry.role === "owner" ? () => setDeleting({ id: entry.collectionId, name: entry.displayName }) : undefined}
      onForget={() => void act(async () => {
        await privates.forget(entry.collectionId);
        setList((current) => current.filter((item) => item.collectionId !== entry.collectionId));
      })} />)}
    <button type="button" className="mdbase-button" disabled={working} onClick={() => authorize()}>Add a Private collection</button>
    {problem && <p className="editor-private-problem" role="alert">{problem}</p>}
    {deleting && <DeleteCollectionDialog ui={ui} collection={deleting} onClose={() => {
      setDeleting(null);
      if (caller.current) void refresh(caller.current.signal);
    }} />}
  </section>;
}

/** A Private collection: its availability in the SDK's plain copy, and the one action
 * that can change it. Opening waits (bounded) while it isn't available. */
function PrivateCollectionRow({ entry, working, waiting, onOpen, onAuthorize, onForget, onDelete }: {
  entry: MdbasePrivateCollection;
  working: boolean;
  waiting: boolean;
  onOpen(): void;
  onAuthorize(): void;
  onForget(): void;
  /** Owners only (Connect's reported role); the SDK and control plane check again. */
  onDelete: (() => void) | undefined;
}) {
  const availability = entry.availability;
  const reason = availability.state === "unavailable" ? availability.reason : null;
  const copy = reason ? describeError(availability) : null;
  // Approval, deletion and removal can't be fixed by opening; the row offers the SDK's action instead.
  const openable = copy?.action !== "approve" && copy?.action !== "choose_collection";
  return <div className="sdk-collection-choice is-private" role="group" aria-label={entry.displayName}>
    {openable && <button type="button" className="mdbase-connect-action mdbase-button" disabled={working} onClick={onOpen}>{entry.displayName}</button>}
    {!openable && <span className="sdk-collection-name">{entry.displayName}</span>}
    <span className="sdk-collection-kind">Private</span>
    {waiting && <p className="mdbase-connect-status" role="status">Waiting for your computer…</p>}
    {availability.state === "opening" && !waiting && <p className="mdbase-connect-status">Getting this collection ready…</p>}
    {copy && <div className="sdk-collection-availability"><strong>{copy.title}</strong><p>{copy.message}</p></div>}
    {copy?.action === "approve" && <button type="button" className="mdbase-button" disabled={working} onClick={onAuthorize}>{copy.actionLabel}</button>}
    {copy?.action === "update_app" && copy.updateUrl && <a className="mdbase-button" href={copy.updateUrl} target="_blank" rel="noreferrer">{copy.actionLabel}</a>}
    {copy?.action === "choose_collection" && <button type="button" className="mdbase-button is-tertiary" disabled={working} onClick={onForget}>Remove from this browser</button>}
    {onDelete && reason !== "access_removed" && reason !== "collection_deleted" && <button type="button" className="mdbase-button is-tertiary" disabled={working}
      aria-label={`Delete ${entry.displayName}`} onClick={onDelete}>Delete</button>}
  </div>;
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
