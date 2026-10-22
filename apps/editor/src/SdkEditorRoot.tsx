import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createMdbase, type Mdbase, type MdbaseApplicationDeclaration, type MdbaseClient } from "@mdbase-dev/sdk";
import { CollectionGate, CollectionSwitcher, defaultCollectionCopy, type CollectionSection, type CollectionSectionItem, type CollectionSectionItemAction, type CollectionView } from "@mdbase-dev/ui/collections";
import { OpeningScreen } from "@mdbase-dev/ui/screens";
import { FeedbackButton } from "@mdbase-dev/ui/feedback";
import { describeError } from "@mdbase-dev/sdk/describe";
import type { Surface } from "./app-state-types";
import type { CollectionAvailability, MdbasePrivateCollection } from "@mdbase-dev/sdk/app-grant";
import { NativeEditorGateway, type EditorConnection, type EditorScopeActions } from "./native-gateway";
import type { PrivateCollections } from "./private-collections";
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
  // The SDK owns Native approvals, account-bound inventory and client lifetime.
  // Unbound browser history is not a fallback source of collection authority.
  const sdk = createMdbase(declaration, { privateCollections: true });
  declarations.set(sdk, declaration);
  return sdk;
}

/** The declaration each editor SDK was built from, for capability step-up. */
const declarations = new WeakMap<object, MdbaseApplicationDeclaration>();

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
  /** @internal Isolated tests only; ignored outside test builds. Production uses SDK-owned Native collections. */
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
 * never closes the entry or its SDK-owned Native clients. Isolated tests may
 * supply an app-owned collection section, never a production fallback. */
export function SdkEditorRoot({ sdk, renderNative, onFeedbackContext, privateCollections }: SdkEditorRootProps) {
  const declaration = declarations.get(sdk);
  const privates = import.meta.env.MODE === "test" ? privateCollections ?? null : null;
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

/** Session fence only: this never assigns account ownership to a stored custom grant. */
function privateAccount(sdk: Mdbase): string | null {
  const signIn = sdk.getSnapshot().signIn;
  return signIn?.state === "paired" ? signIn.accountId ?? null : null;
}

/** An explicitly injected custom adapter retains its owned client actions.
 * Production never loads historical grants through this adapter. */
function usePrivateSection(sdk: Mdbase, privates: PrivateCollections | null) {
  const caller = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const [list, setList] = useState<readonly MdbasePrivateCollection[]>([]);
  const [scope, setScope] = useState<PrivateScope | null>(null);
  const [waiting, setWaiting] = useState<string | null>(null);
  /** The last failure, on its row when it has one. */
  const [failure, setFailure] = useState<{ id: string | null; message: string } | null>(null);
  const load = useCallback((signal: AbortSignal) => {
    if (!privates) return;
    privates.collections({ signal }).then((next) => { if (!signal.aborted) setList(next); },
      (error: unknown) => { if (!signal.aborted) setFailure({ id: null, message: describeError(error)?.message ?? "Private collections couldn't be loaded." }); });
  }, [privates]);
  useLayoutEffect(() => {
    if (!privates) return;
    let account = privateAccount(sdk);
    let controller: AbortController | null = null;
    const restart = () => {
      const previous = controller;
      controller = new AbortController();
      caller.current = controller;
      busy.current = false;
      previous?.abort();
      setList([]); setWaiting(null); setFailure(null);
      load(controller.signal);
    };
    restart();
    // Observe every notification, not only React commits: A → B → A must not
    // revive the original authority when React batches the intermediate views.
    const check = () => {
      const next = privateAccount(sdk);
      if (next !== account) { account = next; restart(); }
    };
    const unsubscribe = sdk.subscribe(check);
    check();
    return () => {
      unsubscribe(); controller?.abort();
      if (caller.current === controller) caller.current = null;
    };
  }, [sdk, load, privates]);
  // An injected test adapter owns its client; SDK-owned Native clients never enter here.
  useEffect(() => () => { scope?.actions.chooseAnother().catch(() => {}); }, [scope]);
  if (!privates) return { section: null, scope: null, problem: null, add: () => {} };

  /** One action at a time; it reports its own problem with the SDK's copy. */
  const current = (signal: AbortSignal) => !signal.aborted && caller.current?.signal === signal;
  const act = async (id: string | null, action: (signal: AbortSignal) => Promise<unknown>, controller = caller.current) => {
    if (!controller || !current(controller.signal) || busy.current) return;
    busy.current = true; setFailure(null);
    try { await action(controller.signal); }
    catch (error) { if (current(controller.signal)) setFailure({ id, message: describeError(error)?.message ?? "The collection couldn't be opened. Try again." }); }
    finally { if (caller.current === controller) busy.current = false; }
  };
  const setAvailability = (collectionId: string, availability: CollectionAvailability, signal: AbortSignal) =>
    setList((entries) => current(signal) ? entries.map((entry) => entry.collectionId === collectionId ? { ...entry, availability } : entry) : entries);
  const open = async (entry: MdbasePrivateCollection, signal: AbortSignal) => {
    if (!current(signal)) return;
    let availability = entry.availability;
    if (availability.state !== "available") {
      setWaiting(entry.collectionId);
      try {
        availability = await privates.waitForAvailable(entry.collectionId, { signal, timeoutMs: 10 * 60_000,
          onAvailability: (next) => { if (current(signal)) setAvailability(entry.collectionId, next, signal); } });
      } finally { if (current(signal)) setWaiting(null); }
      if (!current(signal)) return;
      setAvailability(entry.collectionId, availability, signal);
      if (availability.state !== "available") return;
    }
    const client = await privates.open(entry.collectionId, { signal });
    if (!current(signal) || client.collection !== entry.collectionId) {
      client.close();
      if (current(signal)) throw new Error("The collection that opened isn't the one you chose.");
      return;
    }
    let live = true;
    const life = new AbortController();
    const application = sdk.application;
    const connection: EditorConnection = { id: client.collection, displayName: entry.displayName, generation: `private:${++privateGeneration}`,
      records: client, files: client.files, isCurrent: () => live && current(signal) };
    const requireCurrent = () => {
      if (!connection.isCurrent()) throw new DOMException("The collection session has ended.", "AbortError");
    };
    const requestSignal = (supplied?: AbortSignal) => AbortSignal.any([signal, life.signal, ...(supplied ? [supplied] : [])]);
    const leave = () => {
      if (!live) return;
      live = false; signal.removeEventListener("abort", leave); life.abort(); client.close();
      setScope((next) => next?.connection === connection ? null : next);
    };
    signal.addEventListener("abort", leave, { once: true });
    const actions: EditorScopeActions = {
      chooseAnother: async () => { leave(); return application.getSnapshot(); },
      reauthorize: async (options) => {
        requireCurrent();
        const requested = requestSignal(options?.signal); requested.throwIfAborted();
        await privates.authorize(entry.collectionId, { ...options, signal: requested });
        requested.throwIfAborted(); requireCurrent();
        leave(); return application.getSnapshot();
      },
      select: async (collectionId, options) => {
        requireCurrent();
        const requested = AbortSignal.any([signal, ...(options?.signal ? [options.signal] : [])]);
        requested.throwIfAborted(); leave();
        return application.select(collectionId, { ...options, signal: requested });
      },
      forget: async (collectionId, options) => {
        requireCurrent();
        const requested = AbortSignal.any([signal, ...(options?.signal ? [options.signal] : [])]);
        requested.throwIfAborted();
        if (collectionId !== entry.collectionId) return application.forget(collectionId, { ...options, signal: requested });
        leave(); await privates.forget(collectionId);
        requested.throwIfAborted();
        return application.getSnapshot();
      }
    };
    setScope({ connection, actions });
  };
  const authorize = (collectionId?: string) => {
    const controller = caller.current;
    if (!controller || !current(controller.signal) || busy.current) return;
    // Reserve the consent popup inside the click, before act's first await.
    const granted = privates.authorize(collectionId, { signal: controller.signal });
    granted.catch(() => {});
    void act(collectionId ?? null, async (signal) => {
      const { collectionId: approved } = await granted;
      if (!current(signal)) return;
      const next = await privates.collections({ signal });
      if (!current(signal)) return;
      setList(next);
      const entry = next.find((item) => item.collectionId === approved);
      if (entry) await open(entry, signal);
    }, controller);
  };
  const select = (item: CollectionSectionItem) => {
    const entry = list.find((candidate) => candidate.collectionId === item.id);
    if (!entry) return;
    const copy = entry.availability.state === "unavailable" ? describeError(entry.availability) : null;
    if (copy?.action === "approve") authorize(entry.collectionId);
    else if (copy?.action === "update_app") { if (copy.updateUrl) window.open(copy.updateUrl, "_blank", "noreferrer"); }
    else if (copy?.action === "choose_collection") void act(entry.collectionId, async (signal) => {
      await privates.forget(entry.collectionId);
      setList((entries) => current(signal) ? entries.filter((candidate) => candidate.collectionId !== entry.collectionId) : entries);
    });
    else void act(entry.collectionId, (signal) => open(entry, signal));
  };
  /** Owners only (Connect's reported role); the SDK and control plane check again. The dialog asks for the name first. */
  const deleteAction = (entry: MdbasePrivateCollection): CollectionSectionItemAction => {
    const controller = caller.current;
    return {
      id: "delete", label: defaultCollectionCopy.deleteCollection, danger: true,
      onSelect: (_item, { confirmDelete }) => {
        if (!controller || !current(controller.signal)) return;
        confirmDelete((outcome) => {
          if (outcome === "cancelled" || !current(controller.signal)) return;
          if (outcome === "deleted" && scope?.connection.id === entry.collectionId) void scope.actions.chooseAnother().catch(() => {});
          // The relay stops listing a deleted collection.
          load(controller.signal);
        });
      },
    };
  };
  const items = list.map((entry): CollectionSectionItem => {
    const reason = entry.availability.state === "unavailable" ? entry.availability.reason : null;
    const deletable = entry.role === "owner" && reason !== "access_removed" && reason !== "collection_deleted";
    return {
      id: entry.collectionId, name: entry.displayName, current: !!scope?.connection.isCurrent() && scope.connection.id === entry.collectionId,
      detail: failure?.id === entry.collectionId ? failure.message : waiting === entry.collectionId ? "Waiting for your computer…" : privateDetail(entry.availability),
      actions: deletable ? [deleteAction(entry)] : undefined,
    };
  });
  return {
    section: { id: "private", title: "Private collections", items, onSelect: select, onClose: () => scope?.actions.chooseAnother().catch(() => {}) } satisfies CollectionSection,
    scope: scope?.connection.isCurrent() ? scope : null,
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
