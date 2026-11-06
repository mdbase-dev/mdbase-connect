import { countLabel } from "./count-label";
import { t, plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useLocaleRevision, i18n } from "@mdbase-dev/ui/i18n";
import {
  ConnectManagementClient,
  ManagementApiError,
  type HostedCollection,
  type HostedCollectionInvitation,
  type HostedCollectionMember,
  type ManagementOverview,
  type NativeCollection,
  type ManagementRequestOptions
} from "@mdbase/connect-management";
import { AppAccess, applicationGroups } from "./ApplicationAccess";
import { useCallback, useEffect, useRef, useState, Component, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { AccountManagement, DeletedAccount } from "./AccountManagement";
import {readCollectionCreation, keepCollectionCreation, finishCollectionCreation, type CollectionCreationIntent} from "./collection-creation-intent";
import { Brand, ThemeMenu } from "./portal-ui";
import { readRememberedCollection, rememberCollection, signInRedirectUrl } from "./portal-model";
import { CommandPalette, shortcutLabel } from "@mdbase-dev/ui/command-palette";
import { KeyboardShortcuts } from "@mdbase/connect-ui/keyboard";
import { ConfirmAction } from "@mdbase/connect-ui/confirm-action";
import { Dialog } from "@mdbase-dev/ui/dialog";
import { ConfirmDialog } from "@mdbase-dev/ui/confirm-dialog";
import { Menu } from "@mdbase-dev/ui/menu";
import { Tooltip } from "@mdbase-dev/ui/tooltip";
import { useNavPill } from "@mdbase/connect-ui/nav-pill";
import { transitionState } from "@mdbase/connect-ui/state-transition";
import { flushSync } from "react-dom";
import { StatusGlyph, type StatusGlyphState } from "@mdbase/connect-ui/status-glyph";
import { Toaster, toast } from "@mdbase-dev/ui/toast";
import "@mdbase-dev/ui/toast.css";
import { clearOverviewPreview, readOverviewPreview, writeOverviewPreview } from "./overview-cache";
import { applyOptimisticAction, type OptimisticAction, type PerformOperation } from "./optimistic-action";
import { clearPagePrefetch, prefetchAccount, prefetchSharing, takeSharingPrefetch, prefetchMode, takeModePrefetch } from "./page-prefetch";
import { CollectionModeControl } from "@mdbase-dev/ui/collection-mode";
import {
  ConnectEmpty as Empty,
  ConnectPage as Page,
  ConnectSectionTitle as SectionTitle,
  ConnectPreview,
  ListFilter,
  DesktopLink,
  relativeTime,
  errorMessage
} from "./ConnectPrimitives";
import { FeedbackPage } from "./FeedbackPage";
import { FeedbackButton, FeedbackProvider, feedbackApplication, useFeedback, resolveFeedbackEndpoint, type FeedbackFailure } from "@mdbase-dev/ui/feedback";
import {
  CloudIcon as Cloud,
  DesktopIcon as Computer,
  DotsThreeIcon as DotsThree,
  ListIcon as List,
  PlusIcon as Plus,
  WarningCircleIcon as Warning
} from "@phosphor-icons/react";
import "@mdbase-dev/ui/palette.css";
import "./connect.css";
import "@mdbase-dev/ui/feedback.css";
import { Select } from "@mdbase-dev/ui/select";
import { literal } from "./literal";
import { usePortalCommands, type ConnectView } from "./portal-commands";

type MemberRole = "viewer" | "editor";

// The owner row shows "Owner" instead of a role choice, so only assignable roles are listed.
const memberRoles: ReadonlyArray<{ value: MemberRole; label: string }> = [{ value: "viewer", get label() { return t(i18n)({ message: "Viewer", context: "Connect interface" }); } }, { value: "editor", get label() { return t(i18n)({ message: "Editor", context: "Connect interface" }); } }];

type Grant = ManagementOverview["grants"][number];
type BusyOperations = ReadonlySet<string>;

const management = new ConnectManagementClient(location.origin);
const desktopReleaseUrl = "https://mdbase.dev/downloads/";
export function ConnectApp() {
  useLocaleRevision();
  const [context, setContext] = useState<{ view: ConnectView; collectionName?: string }>({ view: viewFromPath() });
  const updateContext = useCallback((view: ConnectView, collectionName?: string) => {
    setContext((previous) => previous.view === view && previous.collectionName === collectionName ? previous : { view, collectionName });
  }, []);
  return <FeedbackProvider endpoint={resolveFeedbackEndpoint(import.meta.env.VITE_MDBASE_FEEDBACK_URL, import.meta.env.DEV)} turnstileSiteKey={import.meta.env.VITE_MDBASE_TURNSTILE_SITE_KEY?.trim() || null} application={feedbackApplication("mdbase connect", context.view, import.meta.env.VITE_MDBASE_REVISION, import.meta.env.VITE_MDBASE_ENV ?? (import.meta.env.DEV ? "development" : "production"))} collectionName={context.collectionName}>
    <ManagementErrorBoundary><ConnectWorkspace onFeedbackContext={updateContext} /><Toaster /></ManagementErrorBoundary>
  </FeedbackProvider>;
}

class ManagementErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <main className="connect-loading" role="alert"><h1><Trans>mdbase Connect needs to restart</Trans></h1><p><Trans>Your collections were not deleted.</Trans></p><button className="mdbase-button is-tertiary" onClick={() => location.reload()}><Trans>Reload Connect</Trans></button><FeedbackButton /></main> : this.props.children;
  }
}

function ConnectWorkspace({ onFeedbackContext }: { onFeedbackContext(view: ConnectView, collectionName?: string): void }) {
  useLocaleRevision();
  const { reportError, enabled: feedbackEnabled } = useFeedback();
  const [accountDeleted, setAccountDeleted] = useState(location.pathname === "/account-deleted");
  const [view, setView] = useState<ConnectView>(viewFromPath);
  const [data, setData] = useState<ManagementOverview>();
  const [preview, setPreview] = useState(readOverviewPreview);
  const hadSession = useRef(Boolean(preview));
  const [editorOrigin, setEditorOrigin] = useState<string>();
  const [sessions, setSessions] = useState<Awaited<ReturnType<typeof management.sessions>>["sessions"]>();
  const [refreshError, setRefreshError] = useState("");
  const [refreshing, setRefreshing] = useState(true);
  const [mutationError, setMutationError] = useState("");
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [invitationToken, setInvitationToken] = useState(invitationTokenFromHash);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const busyRef = useRef(new Set<string>());
  const refreshGenerationRef = useRef(0);
  const refreshInFlightRef = useRef<{ promise: Promise<void>; signal?: AbortSignal } | null>(null);
  const mutationRevisionRef = useRef(0);
  const optimisticRef = useRef(new Map<string, OptimisticAction>());
  const actionVersionsRef = useRef(new Map<string, number>());
  const navRef = useRef<HTMLElement>(null);
  const navPillRef = useRef<HTMLSpanElement>(null);
  const lifecycleRef = useRef<AbortController | null>(null);
  const endSession = useCallback(() => { lifecycleRef.current?.abort(); setPreview(undefined); setData(undefined); }, []);
  useEffect(() => {
    const expiry = Math.min(...(data?.pending_authorizations ?? []).map(request => Date.parse(request.expires_at)));
    if (!Number.isFinite(expiry)) return;
    const timer = window.setTimeout(() => setData(current => current && { ...current, pending_authorizations: current.pending_authorizations.filter(request => Date.parse(request.expires_at) > Date.now()) }), Math.max(0, expiry - Date.now()));
    return () => window.clearTimeout(timer);
  }, [data?.pending_authorizations]);
  useEffect(() => {
    const lifecycle = new AbortController();
    lifecycleRef.current = lifecycle;
    return () => lifecycle.abort(t(i18n)({ message: "Connect management closed" }));
  }, []);

  const refresh = useCallback((signal = lifecycleRef.current?.signal, animate = false): Promise<void> => {
    if (accountDeleted || signal?.aborted) return Promise.resolve();
    const pending = refreshInFlightRef.current;
    if (pending && !pending.signal?.aborted) return pending.promise;
    setRefreshing(true);
    const generation = ++refreshGenerationRef.current;
    const mutationRevision = mutationRevisionRef.current;
    const failed = (reason: unknown) => {
      if (signal?.aborted || generation !== refreshGenerationRef.current) return;
      if (reason instanceof ManagementApiError && reason.status === 401) {
        clearOverviewPreview(); setPreview(undefined); setData(undefined);
        location.href = signInRedirectUrl(management.baseUrl, hadSession.current);
        return;
      }
      setRefreshError(errorMessage(reason));
    };
    const request = (async () => {
      const next = await management.overview({ signal });
      if (signal?.aborted || lifecycleRef.current?.signal.aborted || generation !== refreshGenerationRef.current || mutationRevision !== mutationRevisionRef.current) return;
      writeOverviewPreview(next); setPreview(readOverviewPreview());
      hadSession.current = true;
      const update = () => {
        if (signal?.aborted || lifecycleRef.current?.signal.aborted || generation !== refreshGenerationRef.current || mutationRevision !== mutationRevisionRef.current) return;
        flushSync(() => setData([...optimisticRef.current.values()].reduce(applyOptimisticAction, next)));
      };
      await (animate ? transitionState(update) : update());
      setRefreshError("");
      void management.uiConfiguration({ signal }).then(async configuration => {
        if (generation !== refreshGenerationRef.current) return;
        setEditorOrigin(configuration.editor_url ? new URL(configuration.editor_url).origin : undefined);
        if (next.authentication.provider !== "tailscale") {
          const sessionResult = await management.sessions({ signal });
          if (generation !== refreshGenerationRef.current) return;
          setSessions(sessionResult.sessions);
        }
      }).catch(failed);
    })().catch(failed);
    refreshInFlightRef.current = { promise: request, signal };
    const settled = () => {
      if (refreshInFlightRef.current?.promise === request) {
        refreshInFlightRef.current = null;
        if (!signal?.aborted) setRefreshing(false);
      }
    };
    void request.then(settled, settled);
    return request;
  }, [accountDeleted]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refresh(controller.signal);
    };
    const timer = window.setInterval(refreshWhenVisible, 15_000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshWhenVisible);
    window.addEventListener("online", refreshWhenVisible);
    return () => {
      controller.abort();
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", refreshWhenVisible);
      window.removeEventListener("online", refreshWhenVisible);
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    const update = () => setView(viewFromPath());
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);

  function perform(id: string, action: (options: ManagementRequestOptions) => Promise<void>, inlineErrors = false, optimistic?: OptimisticAction, receipt?: string): Promise<boolean> {
    if (busyRef.current.has(id)) return Promise.resolve(false);
    const result = performRequest(id, action, inlineErrors, optimistic, receipt);
    return optimistic ? Promise.resolve(true) : result;
  }

  const performRequest: PerformOperation = async (id, action, inlineErrors = false, optimistic, receipt) => {
    if (busyRef.current.has(id)) return false;
    const lifecycle = lifecycleRef.current?.signal;
    if (!lifecycle || lifecycle.aborted) return false;
    const controller = new AbortController();
    const abort = () => controller.abort(lifecycle.reason);
    lifecycle.addEventListener("abort", abort, { once: true });
    busyRef.current.add(id);
    setBusy(new Set(busyRef.current));
    setMutationError("");
    clearPagePrefetch();
    const version = (actionVersionsRef.current.get(id) ?? 0) + 1;
    actionVersionsRef.current.set(id, version);
    mutationRevisionRef.current++;
    if (optimistic) {
      optimisticRef.current.set(id, optimistic);
      setData(current => current && applyOptimisticAction(current, optimistic));
    }
    let succeeded = false;
    try {
      await action({ signal: controller.signal });
      succeeded = true;
      if (!lifecycle.aborted && receipt) toast(receipt, optimistic ? () => {
        if (actionVersionsRef.current.get(id) !== version || busyRef.current.has(id)) { toast(t(i18n)`The value has changed again. Undo is no longer available.`); return; }
        const inverse = { ...optimistic, name: optimistic.previous, previous: optimistic.name };
        void perform(id, options => inverse.kind === "rename-computer"
          ? management.renameConnector(inverse.id, inverse.name, options)
          : management.renameHostedCollection(inverse.id, inverse.name, options), false, inverse, t(i18n)`Restored ${inverse.name}.`);
      } : undefined);
    } catch (reason) {
      if (!lifecycle.aborted) {
        reportError(feedbackFailure(reason));
        if (!inlineErrors) setMutationError(errorMessage(reason));
        if (optimistic) {
          setData(current => current && applyOptimisticAction(current, { ...optimistic, name: optimistic.previous }));
          toast(t(i18n)`Change could not be saved. Your previous value was restored.`);
        }
        if (reason instanceof ManagementApiError && reason.status === 401) {
          clearOverviewPreview();
          location.href = signInRedirectUrl(management.baseUrl, true);
        }
      }
    } finally {
      lifecycle.removeEventListener("abort", abort);
      optimisticRef.current.delete(id); clearPagePrefetch();
      mutationRevisionRef.current++;
      busyRef.current.delete(id);
      if (!lifecycle.aborted) {
        setBusy(new Set(busyRef.current));
        const readback = (refreshInFlightRef.current?.promise ?? Promise.resolve()).then(() => refresh(lifecycle, succeeded && !optimistic));
        if (succeeded && !optimistic) await readback;
      }
    }
    return succeeded;
  };

  async function acceptSharedCollection() {
    if (!invitationToken) return;
    let collectionId: string | undefined;
    const accepted = await perform("accept-collection-invitation", async (options) => {
      const result = await management.acceptCollectionInvitation(invitationToken, options);
      collectionId = result.membership.collection_id;
    });
    if (!accepted) return;
    clearInvitationHash();
    setInvitationToken(null);
    if (collectionId) navigate("overview", collectionId);
  }

  function dismissSharedCollection() {
    clearInvitationHash();
    setInvitationToken(null);
  }

  function navigate(next: ConnectView, collectionId?: string) {
    keyboard.cancel();
    const path = next === "overview" ? "/" : `/${next}`;
    const url = new URL(location.href);
    url.pathname = path;
    if (collectionId) {
      url.searchParams.set("collection", collectionId);
      rememberCollection(collectionId);
    }
    history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
    setView(next);
    setNavigationOpen(false);
  }

  const collections = data ? collectionRows(data) : [];
  const requestedCollectionId = new URLSearchParams(location.search).get("collection");
  const rememberedCollectionId = readRememberedCollection();
  const selectedCollection = collections.find((collection) => collection.id === requestedCollectionId)
    ?? collections.find((collection) => collection.id === rememberedCollectionId)
    ?? (collections.length === 1 ? collections[0] : undefined);
  const selectedCollectionId = selectedCollection?.id;

  useEffect(() => { onFeedbackContext(view, selectedCollection?.name); }, [view, selectedCollection?.name, onFeedbackContext]);

  useEffect(() => {
    if (!data || accountDeleted) return;
    if (selectedCollectionId) {
      rememberCollection(selectedCollectionId);
      if (requestedCollectionId !== selectedCollectionId) {
        const url = new URL(location.href);
        url.searchParams.set("collection", selectedCollectionId);
        history.replaceState(null, "", `${url.pathname}${url.search}`);
      }
      return;
    }
    if (isCollectionView(view)) {
      const url = new URL(location.href);
      url.pathname = "/collections";
      url.searchParams.delete("collection");
      history.replaceState(null, "", `${url.pathname}${url.search}`);
      setView("collections");
    }
  }, [accountDeleted, data, requestedCollectionId, selectedCollectionId, view]);

  useNavPill(navRef, navPillRef);

  const activeView = selectedCollection || !isCollectionView(view) ? view : "collections";
  const freshlyAuthorized = new Set(data?.grants
    .filter((grant) => grant.revocation_status === "active"
      && grant.scope.access === "full_collection"
      && grant.scope.contracts.length === 0)
    .map((grant) => `${grant.application_id}\0${grant.collection_id}`));
  const activeGrants = data?.grants.filter((grant) => grant.revocation_status !== "revoked"
    || (typeof grant.reauthorization_required_at === "string"
      && !freshlyAuthorized.has(`${grant.application_id}\0${grant.collection_id}`))) ?? [];
  const installations = data?.installation_access ?? [];
  const applications = applicationGroups(activeGrants, installations);
  const selectedGrants = selectedCollection
    ? activeGrants.filter((grant) => grant.collection_id === selectedCollection.id)
    : [];
  const selectedApplications = applicationGroups(selectedGrants, installations.filter((entry) => entry.collection_id === selectedCollection?.id));
  const pendingRequest = !refreshError ? data?.pending_authorizations.find(request => Date.parse(request.expires_at) > Date.now()) : undefined;
  const pendingCollection = pendingRequest?.collection_id
    ? collections.find((collection) => collection.id === pendingRequest.collection_id)
    : undefined;
  const keyboard = usePortalCommands({
    data, collections, applications, sessions, selectedCollectionId, navigate, viewLabel,
    enabled: Boolean(data) && !accountDeleted && !refreshError,
    openEditor: selectedCollection && editorOrigin && (selectedCollection.kind !== "local" || selectedCollection.available) ? () => location.assign(editorCollectionUrl(selectedCollection.id, editorOrigin)) : undefined,
    reviewRequest: pendingRequest ? () => location.assign(new URL(`/authorize/${pendingRequest.id}`, management.baseUrl).href) : undefined
  });
  if (accountDeleted) return <DeletedAccount client={management} />;
  const commands = keyboard.commands;
  const navigation = <nav ref={navRef} aria-label={t(i18n)`Navigation`}>
    <span ref={navPillRef} className="nav-pill" aria-hidden="true" hidden />
    {selectedCollection && isCollectionView(activeView) && <section className="connect-nav-group" aria-label={selectedCollection.name}>
      <p>{selectedCollection.name}</p>
      <NavLink label={t(i18n)({ message: "Overview", context: "Connect interface" })} selected={activeView === "overview"} view="overview" collectionId={selectedCollection.id} navigate={navigate} />
      <NavLink label={t(i18n)({ message: "Storage", context: "Connect interface" })} selected={activeView === "storage"} view="storage" collectionId={selectedCollection.id} navigate={navigate} prefetch={() => { if (selectedCollection.kind === "native") prefetchMode(management, selectedCollection.id); }} />
      <NavLink label={t(i18n)({ message: "Access", context: "Connect interface" })} selected={activeView === "access"} view="access" collectionId={selectedCollection.id} navigate={navigate} prefetch={() => { if (selectedCollection.kind !== "local" && selectedCollection.source.access.can_manage_members) prefetchSharing(management, selectedCollection.id); }} />
    </section>}
    <section className="connect-nav-group">
      <NavLink label={t(i18n)({ message: "Collections", context: "Connect interface" })} selected={activeView === "collections"} view="collections" collectionId={selectedCollection?.id} navigate={navigate} />
    </section>
    <section className="connect-nav-group connect-account-navigation">
      <NavLink label={t(i18n)({ message: "Apps", context: "Connect interface" })} selected={activeView === "applications"} view="applications" collectionId={selectedCollection?.id} navigate={navigate} />
      <NavLink label={t(i18n)({ message: "Computers", context: "Connect interface" })} selected={activeView === "computers"} view="computers" collectionId={selectedCollection?.id} navigate={navigate} />
      <NavLink label={t(i18n)({ message: "Account", context: "Connect interface" })} selected={activeView === "account"} view="account" collectionId={selectedCollection?.id} navigate={navigate} prefetch={() => prefetchAccount(management)} />
    </section>
  </nav>;
  const footer = <footer className="connect-nav-footer"><FeedbackButton /><div className="connect-account-slot">{data && <RouteLink view="account" navigate={navigate}><strong title={data.user.name}>{data.user.name}</strong><small title={data.user.email ?? undefined}>{data.user.login ? `@${data.user.login}` : data.user.email}</small></RouteLink>}</div></footer>;
  return <div className="connect-shell">
    <aside className="connect-nav" aria-label={t(i18n)({ message: "mdbase Connect navigation" })}>
      <header><Brand productLabel /><Tooltip label={t(i18n)({ message: "Open menu", context: "Connect interface" })}><button className="connect-mobile-nav-toggle mdbase-icon-button" aria-expanded={navigationOpen} onClick={() => setNavigationOpen(true)}><List aria-hidden="true" /></button></Tooltip></header>
      <button className="sidebar-search" onClick={keyboard.show}><span><Trans>Search</Trans></span><kbd>{shortcutLabel("mod+k")}</kbd></button>
      {!navigationOpen && <>{navigation}{footer}</>}
    </aside>
    <Dialog open={navigationOpen} title={t(i18n)`Navigation`} className="connect-navigation-sheet" onClose={() => setNavigationOpen(false)}><Brand productLabel />{navigation}{footer}</Dialog>
    <main className="connect-main" aria-busy={refreshing}>
      {mutationError && !refreshError && <div className="connect-notice error" role="alert"><Warning aria-hidden="true" />{mutationError}<button className="mdbase-button is-tertiary" onClick={() => setMutationError("")}><Trans>Dismiss</Trans></button></div>}
      {(!data || refreshError) && <ConnectPreview title={viewLabel(view)} rows={view === "computers" ? preview?.computers : isCollectionView(view) || view === "collections" ? preview?.collections : undefined} pending={refreshing} error={refreshError} retry={() => { setData(undefined); setRefreshError(""); void refresh(); }} />}
      {data && !refreshError && <>{invitationToken && <CollectionInvitationBanner
        busy={busy.has("accept-collection-invitation")}
        onAccept={() => void acceptSharedCollection()}
        onDismiss={dismissSharedCollection}
      />}
      {pendingRequest && <PendingRequestBanner request={pendingRequest} collectionName={pendingCollection?.name} count={data.pending_authorizations.length} />}
      {activeView === "overview" && (selectedCollection
        ? <CollectionOverview editorOrigin={editorOrigin} collection={selectedCollection} applications={selectedApplications} />
        : <Collections error={mutationError} key={data.user.id} editorOrigin={editorOrigin} data={data} busy={busy} perform={perform} navigate={navigate} />)}
      {activeView === "storage" && selectedCollection && <Storage error={mutationError} editorOrigin={editorOrigin} collection={selectedCollection} busy={busy} perform={perform} />}
      {activeView === "access" && !refreshError && selectedCollection && <AppAccess error={mutationError} collectionName={selectedCollection.name} groups={selectedApplications} client={management} busy={busy} perform={perform}>
        <section><SectionTitle title={t(i18n)({ message: "Your person record", context: "Connect interface" })} /><div className="connect-row"><div><strong><Trans>Use an existing person or create a note</Trans></strong><small><Trans>Link your account to an editable record in this collection. Collection access is approved separately.</Trans></small></div>{editorOrigin && <a href={`${editorSurfaceUrls(selectedCollection.id, editorOrigin).settings}#your-person`}><Trans>Choose or create my person record</Trans></a>}</div></section>
        {selectedCollection.kind !== "local" && selectedCollection.source.access.can_manage_members && <CollectionSharingPanel error={mutationError} key={selectedCollection.id} sharingAvailable={data.collection_sharing_available === true} collection={selectedCollection.source} busy={busy} perform={perform} />}
      </AppAccess>}
      {activeView === "collections" && <Collections error={mutationError} key={data.user.id} editorOrigin={editorOrigin} data={data} busy={busy} perform={perform} navigate={navigate} />}
      {activeView === "applications" && !refreshError && <AppAccess error={mutationError} editorOrigin={editorOrigin} groups={applications} client={management} busy={busy} perform={perform} />}
      {activeView === "computers" && <Computers error={mutationError} data={data} busy={busy} perform={perform} />}
      {activeView === "account" && <AccountManagement client={management} overview={data} sessions={sessions} onOverviewRefresh={refresh} onSignedOut={endSession} onDeleted={() => { clearOverviewPreview(); lifecycleRef.current?.abort(); setAccountDeleted(true); }} />}
      {activeView === "feedback" && feedbackEnabled && <FeedbackPage onDone={() => navigate("overview", selectedCollection?.id)} />}
      {activeView === "feedback" && !feedbackEnabled && <Page title={t(i18n)({ message: "Feedback unavailable", context: "Connect interface" })} intro={t(i18n)({ message: "This deployment has not configured a feedback destination." })}><section><Empty title={t(i18n)({ message: "Feedback is unavailable", context: "Connect interface" })} body={t(i18n)({ message: "Contact the person who operates this mdbase Connect deployment." })} /></section></Page>}
      </>}
    </main>
    <CommandPalette open={keyboard.open} commands={commands} onClose={keyboard.close} returnFocusRef={keyboard.invoker} showAll={["navigation", "commands"]} groupLabel={group => keyboard.groupLabels[group]} label={t(i18n)({ message: "Commands", context: "Connect interface" })} placeholder={t(i18n)`Search collections, apps, computers, sessions and actions`} emptyState={<><strong><Trans>No results</Trans></strong><p><Trans>Try an object name, its location, or an action such as Rename. Clear the search to browse.</Trans></p></>} />
    <KeyboardShortcuts keyboard={keyboard} commands={commands} />
  </div>;
}

function CollectionInvitationBanner({ busy, onAccept, onDismiss }: {
  busy: boolean;
  onAccept(): void;
  onDismiss(): void;
}) {
  useLocaleRevision();
  return <div className="connect-pending-banner connect-sharing-banner" role="status">
    <StatusGlyph state="attention" />
    <span><strong><Trans>A collection was shared with you</Trans></strong><small><Trans>Accept to add it to your collections. The invitation is bound to this account. Your account name and stable identifier can be shared with other members’ apps when they approve People access.</Trans></small></span>
    <span className="connect-banner-actions"><button className="mdbase-button is-tertiary" disabled={busy} onClick={onDismiss}><Trans>Not now</Trans></button><button className="connect-primary-action mdbase-button is-primary" disabled={busy} onClick={onAccept}>{busy ? t(i18n)({ message: "Accepting…", context: "Connect interface" }) : t(i18n)({ message: "Accept", context: "Connect interface" })}</button></span>
  </div>;
}

function PendingRequestBanner({ request, collectionName, count }: {
  request: ManagementOverview["pending_authorizations"][number];
  collectionName?: string;
  count: number;
}) {
  useLocaleRevision();
  const title = count === 1 ? t(i18n)`${request.application_name} is waiting` : t(i18n)`${count} access requests are waiting`;
  const detail = collectionName
    ? t(i18n)`Review ${request.application_name}’s request for ${collectionName}.`
    : t(i18n)`Review ${request.application_name}’s collection access request.`;
  return <a className="connect-pending-banner" href={new URL(`/authorize/${request.id}`, management.baseUrl).href}>
    <StatusGlyph state="attention" />
    <span><strong>{title}</strong><small>{detail}</small></span>
    <b>{count === 1 ? t(i18n)({ message: "Review request", context: "Connect interface" }) : t(i18n)({ message: "Review next request", context: "Connect interface" })}</b>
  </a>;
}

function CollectionOverview({ collection, applications, editorOrigin }: {
  editorOrigin?: string;
  collection: CollectionRow;
  applications: ReturnType<typeof applicationGroups>;
}) {
  useLocaleRevision();
  const place = collection.kind === "hosted" ? collection.detail : [collection.status, collection.detail].filter(Boolean).join(" · ");
  return <Page reading title={collection.name} status={<span className="connect-status">{collection.glyph !== "idle" && <StatusGlyph state={collection.glyph} />}{place}</span>} action={editorOrigin && (collection.kind !== "local" || collection.available) && <a className="mdbase-button is-primary" aria-label={t(i18n)`Open in editor: ${collection.name}`} href={editorCollectionUrl(collection.id, editorOrigin)}><Trans>Open in editor</Trans></a>}>
    {collection.glyph !== "online" && collection.kind === "local" && <p className="connect-attention"><StatusGlyph state={collection.glyph} /><span>{connectionDescription(collection)}</span></p>}
    <section>
      <SectionTitle title={t(i18n)({ message: "Apps with access to the entire collection", context: "Connect interface" })} />
      {applications.map((application) => <div className="connect-row connect-application-row" key={application.applicationId}><div><strong>{application.applicationName}</strong><small>{host(application.grants[0]?.homepage ?? application.installations[0].application_origin)}</small></div><span>{application.installations.length ? t(i18n)({ message: "Access as your account", context: "Connect interface" }) : permissionSummary(application.grants)}</span><a className="mdbase-button is-tertiary" href={`/access?collection=${encodeURIComponent(collection.id)}`}><Trans>Review access</Trans></a></div>)}
      {applications.length === 0 && <Empty title={t(i18n)({ message: "No apps with access" })} body={t(i18n)({ message: "Apps appear after you approve access to this collection." })} />}
    </section>
  </Page>;
}

function CollectionSharingPanel({ error, collection, busy, perform, sharingAvailable }: {
  sharingAvailable: boolean;
  collection: { id: string; display_name: string | null };
  busy: BusyOperations;
  error?: string;
  perform: PerformOperation;
}) {
  useLocaleRevision();
  const [members, setMembers] = useState<HostedCollectionMember[]>();
  const [invitations, setInvitations] = useState<HostedCollectionInvitation[]>();
  const [loadError, setLoadError] = useState<{ message: string; conflict: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [inviting, setInviting] = useState(false);
  const [targetMode, setTargetMode] = useState<"email" | "invitee_code">("email");
  const [target, setTarget] = useState("");
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
  const [shareLink, setShareLink] = useState("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const [memberResult, invitationResult] = await (takeSharingPrefetch(management, collection.id) ?? Promise.all([
        management.collectionMembers(collection.id, { signal }),
        management.collectionInvitations(collection.id, { signal })
      ]));
      if (signal?.aborted) return;
      setMembers(memberResult.members);
      setInvitations(invitationResult.invitations);
      setLoadError(null);
    } catch (reason) {
      if (!signal?.aborted) setLoadError({ message: errorMessage(reason), conflict: reason instanceof ManagementApiError && reason.status === 409 });
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [collection.id]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const hasPendingMembers = members?.some((member) => member.state === "changing" || member.state === "revoking") ?? false;
  useEffect(() => {
    if (!hasPendingMembers) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 3_000);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [hasPendingMembers, members, load]);

  async function invite(event: FormEvent) {
    event.preventDefault();
    const invitationTarget = target.trim();
    if (!invitationTarget) return;
    let token = "";
    const succeeded = await perform(
      `sharing-invite-${collection.id}`,
      async (options) => {
        const created = await management.createCollectionInvitation(
          collection.id,
          targetMode === "email"
            ? { email: invitationTarget, role }
            : { invitee_code: invitationTarget, role },
          options
        );
        token = created.invitation.token;
      }, false, undefined, t(i18n)`Created an invitation to ${collection.display_name ?? collection.id}`
    );
    if (!succeeded) return;
    setTarget("");
    setInviting(false);
    setCopied(false);
    setShareLink(collectionInvitationUrl(token));
    await load();
  }

  async function mutate(id: string, action: (options: ManagementRequestOptions) => Promise<void>, receipt: string) {
    const saved = await perform(id, action, false, undefined, receipt);
    if (saved) await load();
    return saved;
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const activeInvitations = invitations?.filter((invitation) => invitation.state === "pending") ?? [];
  return <section className="connect-sharing">
    <SectionTitle
      title={t(i18n)({ message: "People & sharing", context: "Connect interface" })}
      count={members?.length}
      action={sharingAvailable && <button className="mdbase-button is-tertiary" onClick={() => { setInviting(true); setShareLink(""); }}><Trans><Plus aria-hidden="true" />Invite person</Trans></button>}
    />
    {loadError && <div className="connect-notice error" role="alert"><div>{loadError.conflict ? <p><Trans>Resolve the conflicting changes in the desktop app on the computers holding this collection, then return here to change access.</Trans></p> : loadError.message}</div>{!loadError.conflict && <button className="mdbase-button is-tertiary" onClick={() => void load()}><Trans>Try again</Trans></button>}</div>}
    {sharingAvailable && inviting && <form className="connect-inline-form connect-sharing-form" onSubmit={(event) => void invite(event)}>
      <label><span><Trans>Invite using</Trans></span><Select aria-label={t(i18n)({ message: "Invite using", context: "Connect interface" })} value={targetMode} options={[{ value: "email", label: t(i18n)`Verified email` }, { value: "invitee_code", label: t(i18n)`Sharing code` }]} onChange={(next) => { setTargetMode(next); setTarget(""); }} /></label>
      <label><span>{targetMode === "email" ? t(i18n)({ message: "Email address", context: "Connect interface" }) : t(i18n)({ message: "Sharing code", context: "Connect interface" })}</span><input className="mdbase-field" autoFocus type={targetMode === "email" ? "email" : "text"} maxLength={targetMode === "email" ? 320 : 32} value={target} onChange={(event) => setTarget(event.target.value)} placeholder={targetMode === "email" ? t(i18n)({ message: "person@example.com", context: "Connect interface" }) : "ABCD-EFGH"} /></label>
      <label><span><Trans>Role</Trans></span><Select aria-label={t(i18n)({ message: "Role", context: "Connect interface" })} value={role} options={memberRoles} onChange={setRole} /></label>
      <p>{role === "viewer" ? t(i18n)({ message: "Can read this collection and connect read-only apps or folders." }) : t(i18n)({ message: "Can edit notes, manage types, rename this collection, and connect apps." })}</p>
      <div><button className="mdbase-button is-tertiary" type="button" onClick={() => setInviting(false)}><Trans>Cancel</Trans></button><button className="connect-primary-action mdbase-button is-primary" disabled={!target.trim() || busy.has(`sharing-invite-${collection.id}`)}>{busy.has(`sharing-invite-${collection.id}`) ? t(i18n)({ message: "Creating…", context: "Connect interface" }) : t(i18n)({ message: "Create invitation", context: "Connect interface" })}</button></div>
    </form>}
    {shareLink && <div className="connect-sharing-link" role="status"><div><strong><Trans>Invitation ready</Trans></strong><small><Trans>Send this private link to the invited person. Email invitations require an already registered, verified account. If they have just signed up, create a new invitation.</Trans></small></div><input className="mdbase-field" aria-label={t(i18n)({ message: "Collection invitation link" })} readOnly value={shareLink} onFocus={(event) => event.currentTarget.select()} /><button className="mdbase-button is-tertiary" onClick={() => void copyLink()}>{copied ? t(i18n)({ message: "Copied", context: "Connect interface" }) : t(i18n)({ message: "Copy link", context: "Connect interface" })}</button></div>}
    {members?.map((member) => <div className="connect-row connect-member-row" key={member.id ?? "owner"}>
      <div><strong>{member.name}</strong><small>{member.kind === "owner" ? t(i18n)({ message: "Collection owner", context: "Connect interface" }) : member.state === "changing" ? t(i18n)({ message: "Updating access…", context: "Connect interface" }) : member.state === "revoking" ? t(i18n)({ message: "Removing app and folder access…" }) : member.role === "editor" ? t(i18n)({ message: "Can edit notes and manage types" }) : t(i18n)({ message: "Can view and connect read-only apps" })}</small></div>
      {member.kind === "owner" ? <span><Trans>Owner</Trans></span> : <>
        <label className="connect-role-select"><span className="mdbase-visually-hidden"><Trans>Role for {literal(member.name)}</Trans></span><Select aria-label={t(i18n)`Role for ${member.name}`} value={member.role as MemberRole} options={memberRoles} disabled={member.state !== "active" || (!sharingAvailable && member.role === "viewer") || busy.has(`member-role-${member.id}`)} onChange={(next) => void mutate(`member-role-${member.id}`, (options) => management.changeCollectionMemberRole(collection.id, member.id!, next, options), t(i18n)`Updated ${member.name} access to ${collection.display_name ?? collection.id}`)} /></label>
        <ConfirmAction error={error} className="mdbase-button is-tertiary is-danger" label={member.state === "revoking" ? t(i18n)({ message: "Removing…", context: "Connect interface" }) : t(i18n)({ message: "Remove", context: "Connect interface" })} question={collection.display_name ? t(i18n)`Remove ${member.name} from ${collection.display_name}?` : t(i18n)`Remove ${member.name} from the unnamed collection?`} consequence={t(i18n)`Their app and folder access will also be revoked.`} pendingLabel={t(i18n)`Removing access…`} confirmLabel={t(i18n)({ message: "Remove access", context: "Connect interface" })} busy={member.state === "revoking" || busy.has(`member-revoke-${member.id}`)} onConfirm={() => mutate(`member-revoke-${member.id}`, (options) => management.revokeCollectionMember(collection.id, member.id!, options), t(i18n)`Removing ${member.name} from ${collection.display_name ?? collection.id}`)} />
      </>}
    </div>)}
    {loading && <p className="connect-muted" role="status"><Trans>Loading people…</Trans></p>}
    {activeInvitations.length > 0 && <>
      <SectionTitle title={t(i18n)({ message: "Pending invitations", context: "Connect interface" })} count={activeInvitations.length} />
      {activeInvitations.map((invitation) => <div className="connect-row" key={invitation.id}><div><strong>{invitation.submitted_email ?? t(i18n)({ message: "Invitee code", context: "Connect interface" })}</strong><small><Trans>{invitation.role === "editor" ? t(i18n)({ message: "Editor", context: "Connect interface" }) : t(i18n)({ message: "Viewer", context: "Connect interface" })} · Expires {i18n.date(new Date(invitation.expires_at), {dateStyle: "short"})}</Trans></small></div><span><Trans>Pending</Trans></span><ConfirmAction error={error} className="mdbase-button is-tertiary is-danger" label={t(i18n)({ message: "Cancel", context: "Connect interface" })} question={t(i18n)({ message: "Cancel this collection invitation?" })} consequence={t(i18n)`This invitation will no longer grant access to the collection.`} confirmLabel={t(i18n)({ message: "Cancel invitation", context: "Connect interface" })} busy={busy.has(`invitation-cancel-${invitation.id}`)} onConfirm={() => mutate(`invitation-cancel-${invitation.id}`, (options) => management.cancelCollectionInvitation(collection.id, invitation.id, options), t(i18n)`Cancelled invitation to ${collection.display_name ?? collection.id}`)} /></div>)}
    </>}
  </section>;
}

function Storage({ error, collection, busy, perform, editorOrigin }: {
  editorOrigin?: string;
  collection: CollectionRow;
  busy: BusyOperations;
  error?: string;
  perform: PerformOperation;
}) {
  useLocaleRevision();
  if (collection.kind === "native") {
    return <Page title={t(i18n)({ message: "Storage", context: "Connect interface" })} intro={collection.name}>
      <p>{collection.detail}</p>
      <CollectionModeControl key={collection.id} collectionId={collection.id} load={() => takeModePrefetch(management, collection.id) ?? management.collectionModeStatus(collection.id)} change={(targetMode, requestId) => management.requestCollectionMode(collection.id, {targetMode, requestId})} cancel={(_target, requestId) => management.cancelCollectionMode(collection.id, requestId)} />
      <section><SectionTitle title={t(i18n)({ message: "Sync", context: "Connect interface" })} /><div className="connect-row"><div><strong><Trans>Collection copies</Trans></strong>{!!collection.source.computer_ids?.length && <small><Trans>Copies sync between your computers. App access is managed separately.</Trans></small>}</div></div></section>
    </Page>;
  }
  if (collection.kind === "hosted") {
    const replicas = collection.source.replicas.filter((replica) => replica.revocation_status !== "revoked");
    return <Page title={t(i18n)({ message: "Storage", context: "Connect interface" })} intro={t(i18n)`Manage the main copy of ${collection.name} and its synced Markdown folders.`}>
      <section>
        <SectionTitle title={t(i18n)({ message: "Main copy", context: "Connect interface" })} />
        <CollectionSummary error={error} editorOrigin={editorOrigin} collection={collection} busy={busy} perform={perform} />
      </section>
      <section>
        <SectionTitle title={t(i18n)({ message: "Synced folders", context: "Connect interface" })} count={replicas.length} action={<DesktopLink href={`mdbase-connect://mirror?collection=${encodeURIComponent(collection.source.id)}`}><Plus aria-hidden="true" /><Trans>Sync a folder</Trans></DesktopLink>} />
        {replicas.map((replica) => <div className="connect-row" key={replica.id}><div><strong>{replica.name}</strong><small>{replica.mode === "read_only" ? t(i18n)({ message: "Downloads only", context: "Connect interface" }) : t(i18n)({ message: "Edits sync both ways", context: "Connect interface" })}</small></div><span>{replica.revocation_status === "revoking" ? t(i18n)({ message: "Disconnecting…", context: "Connect interface" }) : replica.sync_status ? t(i18n)`Seen ${relativeTime(replica.sync_status.last_seen_at ?? collection.source.created_at)}` : t(i18n)({ message: "Waiting to sync", context: "Connect interface" })}</span><ConfirmAction error={error} className="mdbase-button is-tertiary is-danger" label={t(i18n)({ message: "Disconnect", context: "Connect interface" })} question={t(i18n)`Disconnect ${replica.name}?`} consequence={t(i18n)`Syncing will stop after the computer confirms. Files already downloaded will remain.`} pendingLabel={t(i18n)`Disconnecting…`} confirmLabel={t(i18n)({ message: "Disconnect", context: "Connect interface" })} busy={replica.revocation_status === "revoking" || busy.has(`replica-${replica.id}`)} onConfirm={() => perform(`replica-${replica.id}`, (options) => management.revokeReplica(replica.id, options), false, undefined, t(i18n)`Disconnecting ${replica.name}`)} /></div>)}
        {replicas.length === 0 && <Empty title={t(i18n)({ message: "No synced folders", context: "Connect interface" })} body={t(i18n)({ message: "Use the desktop app to keep an ordinary Markdown folder on a computer." })} />}
      </section>
    </Page>;
  }
  return <Page title={t(i18n)({ message: "Storage", context: "Connect interface" })} intro={t(i18n)`${collection.name} keeps its main copy in a folder on a connected computer.`}>
    <section>
      <SectionTitle title={t(i18n)({ message: "Main copy", context: "Connect interface" })} />
      <div className="connect-row"><div><strong>{collection.detail}</strong><small><Trans>The folder remains the authority for this collection.</Trans></small></div><span className="connect-status"><StatusGlyph state={collection.glyph} />{collection.status}</span><DesktopLink href="mdbase-connect://open"><Trans>Open desktop app</Trans></DesktopLink></div>
    </section>
  </Page>;
}

function Collections({ error, data, busy, perform, navigate, editorOrigin }: {
  editorOrigin?: string;
  data: ManagementOverview;
  busy: BusyOperations;
  error?: string;
  perform: PerformOperation;
  navigate(view: ConnectView, collectionId?: string): void;
}) {
  useLocaleRevision();
  const [creating, setCreating] = useState(false);
  const [intent, setIntent] = useState<CollectionCreationIntent | null>(() => readCollectionCreation(data.user.id));
  const [name, setName] = useState(() => readCollectionCreation(data.user.id)?.displayName ?? "");
  const [creationError, setCreationError] = useState<string | null>(null);
  const [location, setLocation] = useState("");
  const [query, setQuery] = useState("");
  const hostedEnabled = data.hosted_collections_available === true;
  const hosted = location === "hosted";
  const rows = collectionRows(data);
  const initialIds = useRef(new Set(rows.map(collection => collection.id)));
  const terms = query.trim().toLocaleLowerCase(i18n.locale).split(/\s+/u).filter(Boolean);
  const visible = rows.filter(collection => terms.every(term => `${collection.name} ${collection.detail}`.toLocaleLowerCase(i18n.locale).includes(term)));
  const canCreate = data.collection_creation_available ?? data.hosted_collections_available !== false;
  function choose(location = "") {
    const pending = readCollectionCreation(data.user.id);
    setIntent(pending);
    setName(pending?.displayName ?? "");
    setLocation(pending ? "hosted" : location);
    setCreationError(null);
    setCreating(true);
  }
  function validateName() {
    const error = !name.trim() ? t(i18n)`Enter a collection name.` : /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ud800-\udfff]/u.test(name) ? t(i18n)({ message: "Use a single-line collection name." }) : null;
    setCreationError(error);
    return !error;
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (!hosted || !hostedEnabled || !canCreate || busy.has("create-collection") || !validateName()) return;
    let original: CollectionCreationIntent;
    try {
      original = readCollectionCreation(data.user.id) ?? {accountId:data.user.id, requestId:crypto.randomUUID(), displayName:name.trim(), timezone:Intl.DateTimeFormat().resolvedOptions().timeZone};
      keepCollectionCreation(original);
      setIntent(original); setName(original.displayName); setCreationError(null);
    } catch {
      setCreationError(t(i18n)({ message: "This browser could not keep your creation request. No request was sent." })); return;
    }
    const created = await perform("create-collection", async options => {
      try {await management.createCollection(original, options);}
      catch (error) {setCreationError(errorMessage(error)); throw error;}
    }, true, undefined, t(i18n)`Created ${original.displayName}`);
    if (created) {
      try {finishCollectionCreation(original);} catch {setCreationError(t(i18n)({ message: "Created, but this browser could not clear its request. Retrying will use the same collection." })); return;}
      setIntent(null); setCreating(false); setName("");
    }
  }
  const choices = <div className="connect-location-choices">
    <button data-command={!rows.length && hostedEnabled && canCreate ? "create" : undefined} data-autofocus={hostedEnabled && canCreate || undefined} className="connect-location-choice" disabled={!hostedEnabled || !canCreate} onClick={() => choose("hosted")}><Cloud aria-hidden="true" /><span><strong><Trans>Hosted by mdbase</Trans></strong><small><Trans>Keep the main copy in mdbase, with optional synced folders.</Trans></small></span></button>
    <button data-command={!rows.length && (!hostedEnabled || !canCreate) ? "create" : undefined} data-autofocus={!hostedEnabled || !canCreate || undefined} className="connect-location-choice" onClick={() => choose("native")}><Computer aria-hidden="true" /><span><strong><Trans>A folder on this computer</Trans></strong><small><Trans>Choose a Markdown folder in the desktop app. Your files stay here.</Trans></small></span></button>
  </div>;
  return <Page title={t(i18n)({ message: "Collections", context: "Connect interface" })} intro={rows.length ? t(i18n)({ message: "Open a collection in the editor or manage where its main copy lives." }) : undefined} action={rows.length > 0 && <button data-command="create" className="mdbase-button is-secondary" onClick={() => choose()}><Plus aria-hidden="true" /><Trans>Add collection</Trans></button>}>
    <section className="connect-collections-list" aria-label={t(i18n)({ message: "Collections", context: "Connect interface" })}>
      {rows.length >= 10 && <ListFilter label={t(i18n)`Filter collections`} value={query} onChange={setQuery} />}
      {visible.map(collection => <CollectionSummary error={error} key={collection.id} className={initialIds.current.has(collection.id) ? "" : "is-new"} collection={collection} navigate={navigate} editorOrigin={editorOrigin} busy={busy} perform={perform} />)}
      {rows.length > 0 && visible.length === 0 && <Empty title={t(i18n)`No collections match`} body={t(i18n)`Try another collection or computer name.`} action={<button className="mdbase-button is-tertiary" onClick={() => setQuery("")}><Trans>Clear filter</Trans></button>} />}
      {rows.length === 0 && <><Empty icon={false} title={t(i18n)({ message: "No collections", context: "Connect interface" })} body={t(i18n)`Choose where your first collection lives.`} />{choices}</>}
    </section>
    <Dialog open={creating} title={t(i18n)({ message: "Add collection", context: "Connect interface" })} closeDisabled={busy.has("create-collection")} onClose={() => setCreating(false)}>
      {!location && choices}
      {hosted && <form className="connect-edit-form" noValidate onSubmit={event => void create(event)}>
        <p className="connect-muted"><Trans>Hosted by mdbase</Trans></p>
        <label><span><Trans>Collection name</Trans></span><input className="mdbase-field" autoFocus maxLength={200} value={name} disabled={intent !== null || busy.has("create-collection")} aria-invalid={Boolean(creationError)} aria-describedby="collection-create-error" onBlur={validateName} onChange={event => setName(event.target.value)} /></label>
        <p className="connect-field-error" role={creationError ? "alert" : undefined} id="collection-create-error">{creationError}</p>
        {(!hostedEnabled || !canCreate) && <p><Trans>Hosted creation is unavailable on this server.</Trans></p>}
        {intent && <p role="status"><Trans>Your original request is kept. Retry it to avoid creating another collection.</Trans></p>}
        <footer className="mdbase-dialog-actions"><button className="mdbase-button is-tertiary" type="button" disabled={busy.has("create-collection")} onClick={() => setCreating(false)}><Trans>Cancel</Trans></button><button className="mdbase-button is-primary" disabled={!hostedEnabled || !canCreate || busy.has("create-collection")}>{busy.has("create-collection") ? t(i18n)({ message: "Creating…", context: "Connect interface" }) : intent ? t(i18n)({ message: "Retry creation", context: "Connect interface" }) : t(i18n)({ message: "Create", context: "Connect interface" })}</button></footer>
      </form>}
      {location === "native" && <div className="connect-edit-form"><p><Trans>Choose or create a folder in the desktop app. Collection files stay on this computer.</Trans></p><DesktopLink href="mdbase-connect://open"><Trans>Open desktop app</Trans></DesktopLink></div>}
    </Dialog>
  </Page>;
}

function Computers({ error, data, busy, perform }: {
  data: ManagementOverview;
  busy: BusyOperations;
  error?: string;
  perform: PerformOperation;
}) {
  useLocaleRevision();
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<{ id: string; kind: "menu" | "rename" | "revoke" } | null>(null);
  const [name, setName] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const query = search.trim().toLocaleLowerCase(i18n.locale);
  const renameReturn = useRef<HTMLElement | null>(null);
  const visible = data.connectors.filter(connector => connector.name.toLocaleLowerCase(i18n.locale).includes(query));
  return <Page title={t(i18n)({ message: "Computers", context: "Connect interface" })} intro={t(i18n)({ message: "Registered computers stay listed when offline. Revoking one also invalidates grants routed through it." })}>
    <section>
      <SectionTitle title={t(i18n)({ message: "Registered computers", context: "Connect interface" })} count={data.connectors.length} />
      {data.connectors.length >= 10 && <ListFilter label={t(i18n)`Filter computers`} value={search} onChange={setSearch} />}
      {visible.map((connector) => {
        const working = busy.has(`computer-${connector.id}`) || busy.has(`rename-computer-${connector.id}`);
        const upgradeRequired = connector.compatibility === "upgrade_required";
        const updateRecommended = connector.update_recommended === true;
        const online = !upgradeRequired && isConnectorOnline(connector.last_seen_at);
        const collections = data.collections.filter((collection) => collection.connector_id === connector.id);
        return <div className="connect-collection-row connect-computer-row" key={connector.id} data-list-item data-command={`computer:${connector.id}`} tabIndex={-1}>
          <span className="connect-location-glyph"><Computer aria-hidden="true" /></span>
          <div className="connect-collection-name"><strong>{connector.name}</strong><small>{countLabel(collections.length, "collection")} · {connector.last_seen_at ? t(i18n)`Seen ${relativeTime(connector.last_seen_at)}` : t(i18n)({ message: "Not connected yet", context: "Connect interface" })}</small></div>
          <span className="connect-status"><StatusGlyph state={upgradeRequired ? "attention" : online ? "online" : connector.last_seen_at ? "offline" : "idle"} />{upgradeRequired ? t(i18n)({ message: "Update required", context: "Connect interface" }) : online ? t(i18n)({ message: "Connected", context: "Connect interface" }) : connector.last_seen_at ? t(i18n)({ message: "Offline", context: "Connect interface" }) : t(i18n)({ message: "Not connected yet", context: "Connect interface" })}</span>
          {upgradeRequired && <a href={connector.update_url ?? desktopReleaseUrl} target="_blank" rel="noreferrer"><Trans>Install {connector.minimum_connector_version ? t(i18n)`version ${connector.minimum_connector_version} or later` : t(i18n)({ message: "the latest release", context: "Connect interface" })}</Trans></a>}
          {!upgradeRequired && updateRecommended && <a href={connector.update_url ?? desktopReleaseUrl} target="_blank" rel="noreferrer"><Trans>Update recommended for current policy protection</Trans></a>}
          <span className="connect-collection-menu"><Tooltip label={t(i18n)`Actions for ${connector.name}`}><button className="mdbase-icon-button" aria-haspopup="menu" aria-expanded={selection?.id === connector.id && selection.kind === "menu"} disabled={working} onClick={event => { trigger.current = event.currentTarget; setSelection({ id: connector.id, kind: "menu" }); }}><DotsThree aria-hidden="true" /></button></Tooltip>
            <Menu open={selection?.id === connector.id && selection.kind === "menu"} triggerRef={trigger} id={`computer-menu-${connector.id}`} label={connector.name} onClose={refocus => { setSelection(null); if (refocus) trigger.current?.focus(); }}>
              <button role="menuitem" className="mdbase-menu-item" data-action="rename" onClick={() => { renameReturn.current = trigger.current!.closest<HTMLElement>("[data-list-item]"); setName(connector.name); setSelection({ id: connector.id, kind: "rename" }); }}><Trans>Rename</Trans></button>
              <button role="menuitem" className="mdbase-menu-item is-danger" data-action="revoke" onClick={() => setSelection({ id: connector.id, kind: "revoke" })}>{t(i18n)({ message: "Revoke", context: "Connect interface" })}</button>
            </Menu>
          </span>
          <Dialog open={selection?.id === connector.id && selection.kind === "rename"} title={t(i18n)`Rename ${connector.name}`} returnFocusRef={renameReturn} closeDisabled={working} onClose={() => setSelection(null)}><form className="connect-edit-form" onSubmit={async event => {
            event.preventDefault();
            if (await perform(`rename-computer-${connector.id}`, options => management.renameConnector(connector.id, name.trim(), options), false, { kind: "rename-computer", id: connector.id, name: name.trim(), previous: connector.name }, t(i18n)`Renamed ${connector.name} to ${name.trim()}`)) setSelection(null);
          }}><label><span className="mdbase-visually-hidden"><Trans>Rename {connector.name}</Trans></span><input className="mdbase-field" data-autofocus maxLength={200} value={name} onFocus={event => event.currentTarget.select()} onChange={event => setName(event.target.value)} /></label><footer className="mdbase-dialog-actions"><button type="button" className="mdbase-button is-tertiary" disabled={working} onClick={() => setSelection(null)}><Trans>Cancel</Trans></button><button className="mdbase-button is-primary" disabled={working || !name.trim() || name.trim() === connector.name}>{working ? t(i18n)`Saving…` : t(i18n)`Save`}</button></footer></form></Dialog>
          <ConfirmDialog open={selection?.id === connector.id && selection.kind === "revoke"} title={t(i18n)`Revoke ${connector.name}?`} consequence={t(i18n)`Apps will lose access through this computer. Your local files will not be deleted.`} confirmLabel={t(i18n)({ message: "Revoke computer", context: "Connect interface" })} pendingLabel={t(i18n)`Revoking access…`} busy={working} returnFocusRef={trigger} onClose={() => setSelection(null)} onConfirm={async () => {
            if (await perform(`computer-${connector.id}`, options => management.revokeConnector(connector.id, options), false, undefined, t(i18n)`Revoked ${connector.name}`)) setSelection(null);
          }}>{error && <p role="alert">{error}</p>}</ConfirmDialog>
        </div>;
      })}
      {data.connectors.length > 0 && visible.length === 0 && <Empty title={t(i18n)({ message: "No computers match", context: "Connect interface" })} body={t(i18n)({ message: "Try a different computer name. Filtering does not revoke access." })} />}
      {data.connectors.length === 0 && <Empty title={t(i18n)({ message: "No computers connected", context: "Connect interface" })} body={t(i18n)({ message: "Open the mdbase Connect desktop app and choose Connect this computer." })} action={<span className="connect-empty-actions"><a href="mdbase-connect://open"><Trans>Open desktop app</Trans></a><a href={desktopReleaseUrl} target="_blank" rel="noreferrer"><Trans>Install the latest release</Trans></a></span>} />}
    </section>
  </Page>;
}
interface CollectionRowBase {
  glyph: StatusGlyphState;
  id: string;
  name: string;
  detail: string;
  status: string;
  available: boolean;
  upgradeRequired?: boolean;
}
type CollectionRow =
  | CollectionRowBase & { kind: "local"; paused: boolean }
  | CollectionRowBase & { kind: "hosted"; source: HostedCollection }
  | CollectionRowBase & { kind: "native"; source: NativeCollection };

function collectionRows(data: ManagementOverview): CollectionRow[] {
  const connectors = new Map(data.connectors.map((connector) => [connector.id, connector]));
  const local = data.collections.map((collection) => {
    const connector = connectors.get(collection.connector_id);
    const upgradeRequired = connector?.compatibility === "upgrade_required";
    const online = !upgradeRequired && isConnectorOnline(connector?.last_seen_at ?? null);
    return {
      id: collection.id,
      name: collection.display_name,
      detail: collection.connector_name,
      status: collection.unavailable_reason === "claimed_by_newer_runtime" ? t(i18n)({ message: "Moved to newer runtime", context: "Connect interface" }) : !collection.enabled ? t(i18n)({ message: "Paused", context: "Connect interface" }) : upgradeRequired ? t(i18n)({ message: "Update required", context: "Connect interface" }) : online ? t(i18n)({ message: "Connected", context: "Connect interface" }) : t(i18n)({ message: "Offline", context: "Connect interface" }),
      available: collection.enabled && online,
      glyph: (!collection.enabled ? "paused" : upgradeRequired ? "attention" : online ? "online" : "offline") as StatusGlyphState,
      paused: !collection.enabled,
      upgradeRequired,
      kind: "local" as const
    };
  });
  const hosted = data.hosted_collections.map((collection) => ({
    id: collection.authority_state === "transferred" && collection.transferred_collection_id ? collection.transferred_collection_id : collection.id,
    name: collection.display_name,
    detail: collection.authority_state === "active" ? t(i18n)({ message: "Hosted by mdbase", context: "Connect interface" }) : t(i18n)({ message: "Main copy moved to a computer" }),
    status: collection.authority_state === "active" ? t(i18n)({ message: "Hosted", context: "Connect interface" }) : t(i18n)({ message: "Moved", context: "Connect interface" }),
    available: collection.authority_state === "active",
    glyph: "idle" as StatusGlyphState,
    kind: "hosted" as const,
    source: collection
  }));
  const native = (data.native_collections ?? []).map((collection) => {
    const computers = (collection.computer_ids ?? []).flatMap((id) => {
      const computer = connectors.get(id);
      return computer ? [computer] : [];
    });
    const computer = computers.find((candidate) => isConnectorOnline(candidate.last_seen_at)) ?? computers[0];
    const status = collection.sync === "cloud_copy" ? "" : computer ? isConnectorOnline(computer.last_seen_at) ? t(i18n)`Connected` : t(i18n)`Offline`
      : t(i18n)({ message: "Computer not connected", context: "Connect interface" });
    return {
      id: collection.id,
      name: collection.display_name ?? t(i18n)({ message: "Unnamed collection", context: "Connect interface" }),
      detail: collection.sync === "cloud_copy" ? t(i18n)({ message: "Cloud copy configured", context: "Connect interface" }) : computer?.name ?? t(i18n)({ message: "Private collection", context: "Connect interface" }),
      status,
      // Computer presence is not content readiness, Effective, or an app grant.
      available: false,
      glyph: (collection.sync !== "cloud_copy" && computer ? isConnectorOnline(computer.last_seen_at) ? "online" : "offline" : "idle") as StatusGlyphState,
      kind: "native" as const,
      source: collection
    };
  });
  return [...native, ...hosted, ...local].sort((left, right) => left.name.localeCompare(right.name));
}

function CollectionSummary({ error, className = "", collection, navigate, editorOrigin, busy, perform }: {
  className?: string;
  editorOrigin?: string;
  collection: CollectionRow;
  navigate?(view: ConnectView, collectionId?: string): void;
  busy: BusyOperations;
  error?: string;
  perform: PerformOperation;
}) {
  useLocaleRevision();
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState<"rename" | "delete" | null>(null);
  const renameReturn = useRef<HTMLElement | null>(null);
  const [name, setName] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const hosted = collection.kind === "hosted" ? collection.source : null;
  const active = hosted?.authority_state === "active";
  const editorId = hosted && !active ? hosted.transferred_collection_id : collection.id;
  const working = busy.has(`collection-${collection.id}`);
  const folders = hosted?.replicas.filter(replica => replica.revocation_status !== "revoked").length ?? 0;
  const locationIcon = hosted || collection.kind === "native" && collection.source.sync === "cloud_copy" ? <Cloud aria-hidden="true" /> : <Computer aria-hidden="true" />;
  return <div className={`connect-collection-row ${className}`} data-list-item data-command={`collection:${collection.id}`}>
    <span className="connect-location-glyph">{locationIcon}</span>
    <div className="connect-collection-name">{navigate ? <RouteLink className="connect-collection-link" view="overview" collectionId={collection.id} navigate={navigate}><strong>{collection.name}</strong></RouteLink> : <strong>{collection.name}</strong>}<small>{collection.detail}{folders > 0 && <> · {countLabel(folders, "folder")}</>}</small></div>
    <span className="connect-status">{collection.glyph !== "idle" && !hosted && <StatusGlyph state={collection.glyph} />}{hosted && active ? "" : collection.status}</span>
    <span className="connect-collection-open">{editorOrigin && editorId && (collection.kind !== "local" || collection.available) && <a className="mdbase-button is-tertiary" aria-label={t(i18n)`Open in editor: ${collection.name}`} href={editorCollectionUrl(editorId, editorOrigin)}><Trans>Open in editor</Trans></a>}</span>
    <span className="connect-collection-menu"><Tooltip label={t(i18n)`Actions for ${collection.name}`}><button ref={trigger} className="mdbase-icon-button" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><DotsThree aria-hidden="true" /></button></Tooltip>
      <Menu open={menuOpen} triggerRef={trigger} id={`collection-menu-${collection.id}`} label={collection.name} onClose={refocus => { setMenuOpen(false); if (refocus) trigger.current?.focus(); }}>
        {navigate && <button role="menuitem" className="mdbase-menu-item" onClick={() => { setMenuOpen(false); navigate("overview", collection.id); }}>{t(i18n)({ message: "Overview", context: "Connect interface" })}</button>}
        {!hosted && <DesktopLink role="menuitem" href="mdbase-connect://open"><Trans>Open desktop app</Trans></DesktopLink>}
        {active && hosted.access.can_rename_collection && <button role="menuitem" className="mdbase-menu-item" data-action="rename" onClick={() => { renameReturn.current = trigger.current!.closest("[data-list-item]")!.querySelector<HTMLElement>(".connect-collection-link") ?? trigger.current; setMenuOpen(false); setName(collection.name); setEditing("rename"); }}><Trans>Rename</Trans></button>}
        {active && <DesktopLink role="menuitem" href={`mdbase-connect://mirror?collection=${encodeURIComponent(collection.id)}`}><Trans>Sync folder</Trans></DesktopLink>}
        {hosted?.access.can_delete_collection && <button role="menuitem" data-action="delete" className="mdbase-menu-item is-danger" onClick={() => { setMenuOpen(false); setName(""); setEditing("delete"); }}><Trans>Delete</Trans></button>}
      </Menu>
    </span>
    {hosted && <><Dialog open={editing === "rename"} title={t(i18n)`Rename ${collection.name}`} returnFocusRef={renameReturn} closeDisabled={working} onClose={() => setEditing(null)}><form className="connect-edit-form" onSubmit={async event => {
      event.preventDefault();
      if (await perform(`collection-${collection.id}`, options => management.renameHostedCollection(collection.id, name.trim(), options), false, {kind: "rename-collection", id: collection.id, name: name.trim(), previous: collection.name}, t(i18n)`Renamed ${collection.name} to ${name.trim()}`)) setEditing(null);
    }}><label><span><Trans>Collection name</Trans></span><input className="mdbase-field" aria-label={t(i18n)`Rename ${collection.name}`} data-autofocus onFocus={event => event.currentTarget.select()} maxLength={200} value={name} onChange={event => setName(event.target.value)} /></label><footer className="mdbase-dialog-actions"><button type="button" className="mdbase-button is-tertiary" onClick={() => setEditing(null)} disabled={working}><Trans>Cancel</Trans></button><button className="mdbase-button is-primary" disabled={working || !name.trim() || name.trim() === collection.name}>{working ? t(i18n)`Saving…` : t(i18n)`Save`}</button></footer></form></Dialog>
    <ConfirmDialog open={editing === "delete"} title={t(i18n)`Delete ${collection.name}?`} consequence={t(i18n)`All hosted data in ${collection.name} will be permanently deleted. This cannot be undone.`} confirmLabel={t(i18n)({ message: "Delete permanently", context: "Connect interface" })} pendingLabel={t(i18n)`Deleting…`} busy={working} disabled={name !== collection.name} returnFocusRef={trigger} onClose={() => setEditing(null)} onConfirm={async () => {
      if (await perform(`collection-${collection.id}`, options => management.deleteHostedCollection(collection.id, options), false, undefined, t(i18n)`Deleted ${collection.name}`)) setEditing(null);
    }}>{error && <p role="alert">{error}</p>}<label><span><Trans>Type {collection.name} to confirm</Trans></span><input className="mdbase-field" data-autofocus value={name} autoComplete="off" spellCheck={false} onChange={event => setName(event.target.value)} /></label></ConfirmDialog></>}
  </div>;
}

function connectionDescription(collection: CollectionRow): string {
  if (collection.kind === "native") return t(i18n)({ message: "Management access does not give apps access to collection content. Each app needs its own collection approval." });
  if (collection.kind === "hosted") {
    return collection.available
      ? t(i18n)({ message: "The hosted collection is available to the editor." })
      : t(i18n)({ message: "The main copy has moved away from hosted storage." });
  }
  if (collection.paused) return t(i18n)({ message: "Access to this collection is paused on its computer." });
  if (collection.upgradeRequired) {
    return t(i18n)`Update mdbase Connect on ${collection.detail} before using this collection.`;
  }
  return collection.available
    ? t(i18n)`The editor can reach this collection through ${collection.detail}.`
    : t(i18n)`Open desktop app on ${collection.detail} to make this collection available.`;
}

function isConnectorOnline(lastSeenAt: string | null): boolean { return lastSeenAt !== null && Date.now() - new Date(lastSeenAt).getTime() < 45_000; }

function NavLink({ label, selected, view, collectionId, navigate, prefetch }: {
  label: string;
  selected: boolean;
  view: ConnectView;
  collectionId?: string;
  navigate(view: ConnectView, collectionId?: string): void;
  prefetch?(): void;
}) {
  useLocaleRevision();
  return <RouteLink className={selected ? "selected" : ""} ariaCurrent={selected ? "page" : undefined} view={view} collectionId={collectionId} navigate={navigate} prefetch={prefetch}><strong>{label}</strong></RouteLink>;
}

function RouteLink({ view, collectionId, navigate, children, className = "", ariaCurrent, prefetch }: {
  view: ConnectView;
  collectionId?: string;
  navigate(view: ConnectView, collectionId?: string): void;
  children: ReactNode;
  className?: string;
  ariaCurrent?: "page";
  prefetch?(): void;
}) {
  useLocaleRevision();
  function activate(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(view, collectionId);
  }
  return <a className={className} href={connectViewUrl(view, collectionId)} aria-current={ariaCurrent} onClick={activate} onMouseEnter={prefetch} onFocus={prefetch}>{children}</a>;
}

function viewFromPath(): ConnectView {
  // Reader/SDK manage-access links still use this route; keep until those clients use /applications.
  if (location.pathname === "/account/applications") return "applications";
  const segment = location.pathname.split("/")[1];
  return segment === "storage" || segment === "access" || segment === "collections" || segment === "applications" || segment === "computers" || segment === "account" || segment === "feedback" ? segment : "overview";
}

function isCollectionView(view: ConnectView): boolean { return view === "overview" || view === "storage" || view === "access"; }

function viewLabel(view: ConnectView): string {
  if (view === "overview") return t(i18n)({ message: "Overview", context: "Connect interface" });
  if (view === "storage") return t(i18n)({ message: "Storage", context: "Connect interface" });
  if (view === "access") return t(i18n)({ message: "Access", context: "Connect interface" });
  if (view === "collections") return t(i18n)({ message: "Collections", context: "Connect interface" });
  if (view === "applications") return t(i18n)({ message: "Apps", context: "Connect interface" });
  if (view === "computers") return t(i18n)({ message: "Computers", context: "Connect interface" });
  if (view === "feedback") return t(i18n)({ message: "Send feedback", context: "Connect interface" });
  return t(i18n)({ message: "Account", context: "Connect interface" });
}

function invitationTokenFromHash(): string | null {
  const parameters = new URLSearchParams(location.hash.replace(/^#/, ""));
  const token = parameters.get("collection-invitation");
  return token?.startsWith("cinv_") ? token : null;
}

function clearInvitationHash(): void {
  if (!location.hash) return;
  const url = new URL(location.href);
  const parameters = new URLSearchParams(url.hash.replace(/^#/, ""));
  parameters.delete("collection-invitation");
  url.hash = parameters.toString();
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function collectionInvitationUrl(token: string): string {
  const url = new URL("/", management.baseUrl);
  url.hash = new URLSearchParams({ "collection-invitation": token }).toString();
  return url.href;
}

function permissionSummary(grants: Grant[]): string {
  const operations = new Set(grants.flatMap((grant) => grant.operations));
  const verbs = [
    operations.has("read") || operations.has("query") || operations.has("changes") ? "read" : "",
    operations.has("create") ? "create" : "",
    operations.has("update") || operations.has("rename") ? "update" : "",
    operations.has("delete") ? "delete" : ""
  ].filter(Boolean);
  const capabilities: string[] = [];
  if (verbs.length > 0) capabilities.push(t(i18n)`${joinWords(verbs)} records`);
  if (["create_type", "update_type", "apply_type_pack", "create_view_source", "update_view_source", "delete_view_source"].some((operation) => operations.has(operation))) capabilities.push(t(i18n)({ message: "manage types", context: "Connect interface" }));
  if (["put_timer", "cancel_timer", "reconcile_timers"].some((operation) => operations.has(operation))) capabilities.push(t(i18n)({ message: "manage timers", context: "Connect interface" }));
  if (capabilities.length === 0) return t(i18n)`${plural(operations.size, { one: "# permission", other: "# permissions" })}`;
  const summary = capabilities.join("; ");
  return summary[0].toUpperCase() + summary.slice(1);
}

function joinWords(words: string[]): string {
  if (words.length < 2) return words[0] ?? "";
  if (words.length === 2) return t(i18n)`${words[0]} and ${words[1]}`;
  return t(i18n)`${words.slice(0, -1).join(", ")}, and ${words.at(-1)}`;
}

function connectViewUrl(view: ConnectView, collectionId?: string): string {
  const url = new URL(view === "overview" ? "/" : `/${view}`, management.baseUrl);
  if (collectionId) url.searchParams.set("collection", collectionId);
  return `${url.pathname}${url.search}`;
}

function editorSurfaceUrls(collectionId: string | undefined, editorOrigin: string): { notes: string; types: string; settings: string } {
  const surface = (name?: "types" | "settings") => {
    const url = new URL("/", editorOrigin);
    url.searchParams.set("server", new URL(management.baseUrl).origin);
    if (collectionId) url.searchParams.set("collection", collectionId);
    if (name) url.searchParams.set("surface", name);
    return url.href;
  };
  return { notes: surface(), types: surface("types"), settings: surface("settings") };
}
function editorCollectionUrl(collectionId: string | undefined, editorOrigin: string): string { return editorSurfaceUrls(collectionId, editorOrigin).notes; }

function host(value: string): string {
  try { return new URL(value).host; } catch { return value; }
}
function feedbackFailure(reason: unknown): FeedbackFailure {
  if (!(reason instanceof ManagementApiError)) return { code: "unknown_error" };
  const codes = ["cancelled", "http_error", "invalid_response", "outcome_unknown", "partial_failure", "timeout", "network_error"] as const;
  const code = codes.find((value) => value === reason.code) ?? "http_error";
  return { code, ...(Number.isInteger(reason.status) && reason.status >= 100 && reason.status <= 599 ? { status: reason.status } : {}) };
}
