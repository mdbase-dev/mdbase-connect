import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { MdbaseConnect, type MdbaseApplicationDeclaration, type MdbaseApplicationEntry, type MdbaseClient } from "@mdbase-dev/sdk";
import { ConnectLayout, OpeningScreen } from "@mdbase-dev/ui/screens";
import { FeedbackButton } from "@mdbase-dev/ui/feedback";
import { describeError } from "@mdbase-dev/sdk/describe";
import type { Surface } from "./app-state-types";
import type { CollectionAvailability, MdbaseCollectionEntry, MdbasePrivateCollection } from "@mdbase-dev/sdk/app-grant";
import { NativeEditorGateway, type EditorConnection, type EditorScopeActions } from "./native-gateway";
import { appGrantCollections, type PrivateCollections } from "./private-collections";
import { DeleteCollectionDialog } from "./DeleteCollectionDialog";
import manifest from "../public/.well-known/mdbase-app.json";

const EditorApp = lazy(() => import("./App").then((module) => ({ default: module.App })));

/** The exact bundled declaration goes to SDK self-registration unchanged.
 * Runtime origin is separate from its canonical HTTPS homepage. Registration,
 * consent, Worker/native assets and collection selection remain SDK-owned. */
export function createEditorApplication(input: {
  origin: string;
  environment: MdbaseApplicationDeclaration["environment"];
}): MdbaseConnect {
  const declaration: MdbaseApplicationDeclaration = { id: manifest.id, name: manifest.name,
    origin: input.origin, environment: input.environment, manifest };
  const sdk = new MdbaseConnect(declaration);
  declarations.set(sdk, declaration);
  privateSources.set(sdk, appGrantCollections(declaration));
  return sdk;
}

/** The declaration each editor SDK was built from, for capability step-up. */
const declarations = new WeakMap<object, MdbaseApplicationDeclaration>();
/** Each editor SDK's Private collection grants (app-grant entry, relay to a computer). */
const privateSources = new WeakMap<object, PrivateCollections>();

export type EditorSdk = MdbaseApplicationEntry;
export interface EditorNativeScope {
  readonly application: EditorScopeActions;
  readonly connection: EditorConnection;
  readonly gateway: NativeEditorGateway;
}
export interface SdkEditorRootProps {
  sdk: EditorSdk;
  onSignedOut?(): void;
  onFeedbackContext?(surface: Surface, collectionName?: string): void;
  /** Real native domain UI only; defaults to the editor over the native gateway. */
  renderNative?(scope: EditorNativeScope): ReactNode;
  /** Private collections; defaults to app grants for an SDK made by createEditorApplication. */
  privateCollections?: PrivateCollections;
}

const keys = new WeakMap<EditorSdk, number>();
let nextKey = 0;
function key(sdk: EditorSdk): number {
  let value = keys.get(sdk);
  if (value === undefined) { value = ++nextKey; keys.set(sdk, value); }
  return value;
}

/** Public SDK lifecycle, selection, readiness and currentness for the editor.
 * The SDK owns sign-in, consent, setup and collection selection; this view
 * never closes the borrowed client and never opens its own popup. */
export function SdkEditorRoot(props: SdkEditorRootProps) {
  return <ApplicationView key={key(props.sdk)} {...props} />;
}

/** A Private collection the editor opened itself: it owns this client and closes it on leave. */
interface PrivateScope {
  readonly connection: EditorConnection;
  readonly actions: EditorScopeActions;
}
let privateGeneration = 0;

function ApplicationView({ sdk, renderNative, onSignedOut, onFeedbackContext, privateCollections }: SdkEditorRootProps) {
  const declaration = declarations.get(sdk);
  const privates = privateCollections ?? privateSources.get(sdk) ?? null;
  const application = sdk.application();
  const snapshot = useSyncExternalStore((listener) => application.subscribe(listener), () => application.getSnapshot(), () => application.getSnapshot());
  const caller = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState(false);
  const [deleting, setDeleting] = useState<{ collectionId: string; displayName: string } | null>(null);
  // Developer-only detail (e.g. which manifest fields a registration refusal named): logs, never the screen.
  const developerMessage = snapshot.status === "blocked" ? describeError(snapshot)?.developerMessage ?? null : null;
  useEffect(() => { if (developerMessage) console.warn(`mdbase editor: ${developerMessage}`); }, [developerMessage]);
  useEffect(() => {
    const scope = new AbortController();
    caller.current = scope;
    const foreground = () => {
      if (scope.signal.aborted || application.getSnapshot().status === "closed") return;
      try { application.setForeground(document.visibilityState === "visible"); } catch { /* The SDK owner may be retired. */ }
    };
    document.addEventListener("visibilitychange", foreground);
    foreground();
    // StrictMode replays effects; only the surviving scope starts the SDK.
    queueMicrotask(() => {
      if (scope.signal.aborted || application.getSnapshot().status !== "not_started") return;
      void application.start({ signal: scope.signal }).catch(() => { if (!scope.signal.aborted) setProblem(true); });
    });
    return () => {
      scope.abort();
      document.removeEventListener("visibilitychange", foreground);
      try { if (application.getSnapshot().status !== "closed") application.setForeground(false); } catch { /* No close claim on teardown. */ }
    };
  }, [application]);
  const act = async (action: (signal: AbortSignal) => Promise<unknown>) => {
    const scope = caller.current;
    if (!scope || scope.signal.aborted || busy.current) return;
    busy.current = true;
    setWorking(true);
    setProblem(false);
    try { await action(scope.signal); }
    catch { if (!scope.signal.aborted) setProblem(true); }
    finally { if (!scope.signal.aborted) { busy.current = false; setWorking(false); } }
  };
  // Private collections: listed from this browser's grants, opened through the relay.
  const [privateList, setPrivateList] = useState<readonly MdbasePrivateCollection[]>([]);
  const [privateProblem, setPrivateProblem] = useState<string | null>(null);
  const [privateWaiting, setPrivateWaiting] = useState<string | null>(null);
  const [privateScope, setPrivateScope] = useState<PrivateScope | null>(null);
  const signedIn = snapshot.status !== "closed" && snapshot.signIn?.state === "paired";
  const listPrivate = useCallback(async (signal: AbortSignal) => {
    if (!privates) return;
    try {
      const list = await privates.collections({ signal });
      if (!signal.aborted) { setPrivateList(list); setPrivateProblem(null); }
    } catch (error) {
      if (!signal.aborted) setPrivateProblem(describeError(error)?.message ?? "Private collections couldn't be loaded.");
    }
  }, [privates]);
  useEffect(() => {
    if (!signedIn || !privates) return;
    const scope = new AbortController();
    void listPrivate(scope.signal);
    return () => scope.abort();
  }, [signedIn, privates, listPrivate]);
  useEffect(() => () => { privateScope?.actions.chooseAnother().catch(() => {}); }, [privateScope]);
  const setAvailability = (collectionId: string, availability: CollectionAvailability) =>
    setPrivateList((list) => list.map((entry) => entry.collectionId === collectionId ? { ...entry, availability } : entry));
  /** Private actions report their own problem (with the SDK's copy) instead of the generic one. */
  const actPrivate = (action: (signal: AbortSignal) => Promise<unknown>) => act(async (signal) => {
    setPrivateProblem(null);
    try { await action(signal); }
    catch (error) { if (!signal.aborted) setPrivateProblem(describeError(error)?.message ?? "The collection couldn't be opened. Try again."); }
  });
  const openPrivate = async (entry: Pick<MdbaseCollectionEntry, "collectionId" | "displayName" | "availability">, signal: AbortSignal) => {
    if (!privates) return;
    let availability = entry.availability;
    if (availability.state !== "available") {
      setPrivateWaiting(entry.collectionId);
      try {
        availability = await privates.waitForAvailable(entry.collectionId, { signal, timeoutMs: 10 * 60_000,
          onAvailability: (next) => setAvailability(entry.collectionId, next) });
      } finally { if (!signal.aborted) setPrivateWaiting(null); }
      setAvailability(entry.collectionId, availability);
      if (availability.state !== "available") return;
    }
    const client = await privates.open(entry.collectionId, { signal });
    if (signal.aborted || client.collection !== entry.collectionId) { client.close(); if (!signal.aborted) throw new Error("The collection that opened isn't the one you chose."); return; }
    let open = true;
    const leave = () => { if (!open) return; open = false; client.close(); setPrivateScope((current) => current?.connection.records === client ? null : current); };
    const connection: EditorConnection = { id: client.collection, displayName: entry.displayName, generation: `private:${++privateGeneration}`,
      records: client, files: client.files, isCurrent: () => open };
    const actions: EditorScopeActions = {
      chooseAnother: async () => { leave(); return application.getSnapshot(); },
      reauthorize: async (options) => { await privates.authorize(entry.collectionId, options); leave(); return application.getSnapshot(); },
      select: async (collectionId, options) => { leave(); return application.select(collectionId, options); },
      forget: async (collectionId, options) => {
        if (collectionId !== entry.collectionId) return application.forget(collectionId, options);
        leave(); await privates.forget(collectionId); setPrivateList((list) => list.filter((item) => item.collectionId !== collectionId));
        return application.getSnapshot();
      }
    };
    setPrivateScope({ connection, actions });
  };
  const authorizePrivate = (collectionId?: string) => {
    if (!privates || busy.current) return;
    // Reserve the consent popup inside the click, before act's first await.
    const granted = privates.authorize(collectionId, caller.current ? { signal: caller.current.signal } : {});
    granted.catch(() => {});
    void actPrivate(async (signal) => {
      const { collectionId: approved } = await granted;
      const list = await privates.collections({ signal });
      if (signal.aborted) return;
      setPrivateList(list);
      const entry = list.find((item) => item.collectionId === approved);
      if (entry) await openPrivate(entry, signal);
    });
  };
  const signOut = (signal: AbortSignal) => application.close().then(() => { signal.throwIfAborted(); onSignedOut?.(); });

  if (privateScope) {
    return <NativeScopeView key={privateScope.connection.generation} application={privateScope.actions} connection={privateScope.connection}
      declaration={declaration} renderNative={renderNative} onFeedbackContext={onFeedbackContext} />;
  }
  const selected = snapshot.collections.find((collection) => collection.collectionId === snapshot.selectedCollectionId);
  const connection = selected && snapshot.status === "ready" ? sdk.connection(selected.collectionId) : null;
  const ready = Boolean(snapshot.selection.state === "usable" && snapshot.selection.usable?.collectionId === selected?.collectionId
    && connection && connection.id === selected?.collectionId && connection.records.hello.collection === connection.id && connection.isCurrent()
    && !snapshot.readiness.checking && snapshot.readiness.problem === null
    && snapshot.readiness.assessment?.status === "ready" && snapshot.readiness.assessment.problem === null);
  if (ready && connection) {
    return <NativeScopeView key={`${connection.id}:${connection.generation}`} application={application} connection={connection} declaration={declaration}
      renderNative={renderNative} onFeedbackContext={onFeedbackContext} />;
  }

  const unavailable = snapshot.problem === "application_not_yet_available";
  const blocked = snapshot.status === "blocked" && !unavailable ? describeError(snapshot) : null;
  const closed = snapshot.status === "closed";
  const selection = snapshot.selection;
  const waiting = snapshot.status === "authorizing" || selection.state === "approving";
  const needsApproval = selection.state === "approval_required";
  const invalidSelection = selection.state === "invalid";
  const opening = snapshot.status === "starting" || snapshot.status === "opening" || snapshot.readiness.checking;
  const setup = !closed && !unavailable && (snapshot.status === "setup_required" || snapshot.readiness.assessment?.status === "setup_required");
  const signIn = !closed && snapshot.signIn?.state === "paired" ? snapshot.signIn : null;
  const identity = signIn?.accountEmail ? `Signed in as ${signIn.accountEmail}`
    : signIn?.accountProvider === "github" && signIn.accountLogin ? `Signed in as ${signIn.accountLogin} on GitHub` : null;
  const error = problem || snapshot.status === "blocked" || invalidSelection;
  const message = unavailable ? "Opening collections isn't available in this build yet."
    : closed ? "mdbase editor has signed out. Reload to sign in again."
    : invalidSelection ? "This collection link is invalid. Choose another collection."
    : blocked ? blocked.message
    : error ? "This action could not be completed. Please try again."
    : waiting ? "Waiting for approval in the mdbase tab…"
    : needsApproval ? "This collection needs approval for mdbase editor."
    : setup ? "This collection needs mdbase editor setup before editing."
    : opening || snapshot.status === "ready" ? `Opening ${selected?.displayName ?? "your collection"}…`
    : signIn ? "Choose the collection you want to write in."
    : "Sign in with your mdbase account to open your collections.";
  const choosing = !closed && !unavailable && !waiting && !opening;
  return <ConnectLayout app="editor" title={<>Your notes,<br />as files.</>}
    status={error || unavailable ? undefined : message} error={error || unavailable ? message : undefined}>
    {identity && <p className="mdbase-connect-status">{identity}</p>}
    {choosing && !signIn && !invalidSelection && !needsApproval && <button type="button" className="mdbase-connect-action mdbase-button is-primary" disabled={working}
      onClick={() => void act((signal) => application.approve(undefined, { signal }))}>Sign in</button>}
    {choosing && needsApproval && <button type="button" className="mdbase-connect-action mdbase-button is-primary" disabled={working}
      onClick={() => void act((signal) => application.approve(selection.requested.collectionId, { signal }))}>Approve collection</button>}
    {choosing && signIn && !needsApproval && !invalidSelection && <button type="button" className="mdbase-connect-action mdbase-button" disabled={working}
      onClick={() => void act((signal) => application.reauthorize({ signal }))}>Review access</button>}
    {setup && <button type="button" className="mdbase-connect-action mdbase-button is-primary" disabled={working}
      onClick={() => void act((signal) => application.configure({ signal }))}>Set up mdbase editor</button>}
    {choosing && !needsApproval && !invalidSelection && (privates?.merge(snapshot.collections, signIn ? privateList : []) ?? snapshot.collections.map((c) => ({ collectionId: c.collectionId, displayName: c.displayName, kind: "cloud_copy" as const, availability: { state: "available" as const } }))).map((entry) => {
      if (entry.kind === "private") return <PrivateCollectionRow key={entry.collectionId} entry={entry} working={working}
        waiting={privateWaiting === entry.collectionId} onOpen={() => void actPrivate((signal) => openPrivate(entry, signal))}
        onAuthorize={() => authorizePrivate(entry.collectionId)}
        onForget={() => void actPrivate(async () => {
          await privates?.forget(entry.collectionId);
          setPrivateList((list) => list.filter((item) => item.collectionId !== entry.collectionId));
        })} />;
      const role = snapshot.collections.find((collection) => collection.collectionId === entry.collectionId)?.role;
      return <div key={entry.collectionId} className="sdk-collection-choice" role="group" aria-label={entry.displayName}>
        <button type="button" className="mdbase-connect-action mdbase-button" disabled={working}
          onClick={() => void act((signal) => application.select(entry.collectionId, { signal }))}>{entry.displayName}</button>
        {role === "owner" && <button type="button" className="mdbase-button is-tertiary" disabled={working}
          aria-label={`Delete ${entry.displayName}`} onClick={() => setDeleting({ collectionId: entry.collectionId, displayName: entry.displayName })}>Delete</button>}
      </div>;
    })}
    {choosing && signIn && privates && <button type="button" className="mdbase-connect-action mdbase-button" disabled={working}
      onClick={() => authorizePrivate()}>Add a Private collection</button>}
    {privateProblem && <p className="mdbase-connect-status" role="alert">{privateProblem}</p>}
    {snapshot.selectedCollectionId && !closed && <>
      <button type="button" className="mdbase-connect-action mdbase-button" disabled={working} onClick={() => {
        const collectionId = snapshot.selectedCollectionId;
        if (collectionId) void act((signal) => application.forget(collectionId, { signal }));
      }}>Forget collection</button>
    </>}
    {!closed && !unavailable && !waiting && (snapshot.selectedCollectionId || selection.requested.collectionId || invalidSelection) &&
      <button type="button" className="mdbase-connect-action mdbase-button" disabled={working}
        onClick={() => void act((signal) => application.chooseAnother({ signal }))}>Choose another collection</button>}
    {signIn && <button type="button" className="mdbase-connect-action mdbase-button" disabled={working} onClick={() => void act(signOut)}>Sign out</button>}
    <FeedbackButton />
    {deleting && caller.current && <DeleteCollectionDialog application={application} collection={deleting} signal={caller.current.signal}
      onClose={() => setDeleting(null)} />}
  </ConnectLayout>;
}

/** A Private collection in the chooser: its availability in the SDK's plain copy, and
 * the one action that can change it. Opening waits (bounded) while it isn't available. */
function PrivateCollectionRow({ entry, working, waiting, onOpen, onAuthorize, onForget }: {
  entry: MdbaseCollectionEntry;
  working: boolean;
  waiting: boolean;
  onOpen(): void;
  onAuthorize(): void;
  onForget(): void;
}) {
  const availability = entry.availability;
  const reason = availability.state === "unavailable" ? availability.reason : null;
  const copy = reason ? describeError(availability) : null;
  const openable = reason !== "sync_required" && reason !== "access_removed";
  return <div className="sdk-collection-choice is-private" role="group" aria-label={entry.displayName}>
    {openable && <button type="button" className="mdbase-connect-action mdbase-button" disabled={working} onClick={onOpen}>{entry.displayName}</button>}
    {!openable && <span className="sdk-collection-name">{entry.displayName}</span>}
    <span className="sdk-collection-kind">Private</span>
    {waiting && <p className="mdbase-connect-status" role="status">Waiting for your computer…</p>}
    {availability.state === "opening" && !waiting && <p className="mdbase-connect-status">Getting this collection ready…</p>}
    {copy && <div className="sdk-collection-availability"><strong>{copy.title}</strong><p>{copy.message}</p></div>}
    {reason === "sync_required" && <button type="button" className="mdbase-button" disabled={working} onClick={onAuthorize}>Give access again</button>}
    {reason === "access_removed" && <button type="button" className="mdbase-button is-tertiary" disabled={working} onClick={onForget}>Remove from this browser</button>}
  </div>;
}

function NativeScopeView({ application, connection, declaration, renderNative, onFeedbackContext }: {
  application: EditorScopeActions;
  connection: EditorConnection;
  declaration?: MdbaseApplicationDeclaration;
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
  return <Suspense fallback={opening}><EditorApp gateway={view.scope.gateway} onFeedbackContext={onFeedbackContext} /></Suspense>;
}
