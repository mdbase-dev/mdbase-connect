import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { MdbaseConnect, type MdbaseApplication, type MdbaseApplicationConnection, type MdbaseApplicationDeclaration, type MdbaseApplicationEntry, type MdbaseClient } from "@mdbase-dev/sdk";
import { ConnectLayout, OpeningScreen } from "@mdbase-dev/ui/screens";
import { FeedbackButton } from "@mdbase-dev/ui/feedback";
import type { Surface } from "./app-state-types";
import { NativeEditorGateway } from "./native-gateway";
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
  return sdk;
}

/** The declaration each editor SDK was built from, for capability step-up. */
const declarations = new WeakMap<object, MdbaseApplicationDeclaration>();

export type EditorSdk = MdbaseApplicationEntry;
export interface EditorNativeScope {
  readonly application: MdbaseApplication;
  readonly connection: MdbaseApplicationConnection;
  readonly gateway: NativeEditorGateway;
}
export interface SdkEditorRootProps {
  sdk: EditorSdk;
  onSignedOut?(): void;
  onFeedbackContext?(surface: Surface, collectionName?: string): void;
  /** Real native domain UI only; defaults to the editor over the native gateway. */
  renderNative?(scope: EditorNativeScope): ReactNode;
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

function ApplicationView({ sdk, renderNative, onSignedOut, onFeedbackContext }: SdkEditorRootProps) {
  const declaration = declarations.get(sdk);
  const application = sdk.application();
  const snapshot = useSyncExternalStore((listener) => application.subscribe(listener), () => application.getSnapshot(), () => application.getSnapshot());
  const caller = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState(false);
  const [deleting, setDeleting] = useState<{ collectionId: string; displayName: string } | null>(null);
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
  const signOut = (signal: AbortSignal) => application.close().then(() => { signal.throwIfAborted(); onSignedOut?.(); });

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
    {choosing && !needsApproval && !invalidSelection && snapshot.collections.map((collection) => <div key={collection.collectionId} className="sdk-collection-choice">
      <button type="button" className="mdbase-connect-action mdbase-button" disabled={working}
        onClick={() => void act((signal) => application.select(collection.collectionId, { signal }))}>{collection.displayName}</button>
      {collection.role === "owner" && <button type="button" className="mdbase-button is-tertiary" disabled={working}
        aria-label={`Delete ${collection.displayName}`} onClick={() => setDeleting({ collectionId: collection.collectionId, displayName: collection.displayName })}>Delete</button>}
    </div>)}
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

function NativeScopeView({ application, connection, declaration, renderNative, onFeedbackContext }: {
  application: MdbaseApplication;
  connection: MdbaseApplicationConnection;
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
