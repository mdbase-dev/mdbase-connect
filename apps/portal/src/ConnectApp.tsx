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
import { readRememberedCollection, rememberCollection } from "./portal-model";
import { MdbaseMark } from "@mdbase-dev/ui/brand";
import { CollectionModeControl } from "@mdbase-dev/ui/collection-mode";

import {
  ConfirmAction,
  ConnectEmpty as Empty,
  ConnectPage as Page,
  ConnectSectionTitle as SectionTitle,
  InlineRename
} from "./ConnectPrimitives";
import { FeedbackPage } from "./FeedbackPage";
import { FeedbackButton, FeedbackProvider, feedbackApplication, useFeedback, resolveFeedbackEndpoint, type FeedbackFailure } from "@mdbase-dev/ui/feedback";
import {
  DesktopIcon as Desktop,
  FolderIcon as Folder,
  HardDrivesIcon as HardDrives,
  InfoIcon as Info,
  KeyIcon as Key,
  NotebookIcon as Notebook,
  PackageIcon as Package,
  PlusIcon as Plus,
  UserCircleIcon as Account,
  WarningCircleIcon as Warning
} from "@phosphor-icons/react";
import "./connect.css";
import "@mdbase-dev/ui/feedback.css";
import { Select } from "@mdbase-dev/ui/select";
import { literal } from "./literal";

type MemberRole = "viewer" | "editor";

// The owner row shows "Owner" instead of a role choice, so only assignable roles are listed.
const memberRoles: ReadonlyArray<{ value: MemberRole; label: string }> = [{ value: "viewer", get label() { return t(i18n)({ message: "Viewer", context: "Connect interface" }); } }, { value: "editor", get label() { return t(i18n)({ message: "Editor", context: "Connect interface" }); } }];

type ConnectView = "overview" | "storage" | "access" | "collections" | "applications" | "computers" | "account" | "feedback";
type Grant = ManagementOverview["grants"][number];
type BusyOperations = ReadonlySet<string>;
type PerformOperation = (
  id: string,
  action: (options: ManagementRequestOptions) => Promise<void>,
  inlineErrors?: boolean
) => Promise<boolean>;

const management = new ConnectManagementClient(location.origin);
const desktopReleaseUrl = "https://mdbase.dev/downloads/";
export function ConnectApp() {
  useLocaleRevision();
  const [context, setContext] = useState<{ view: ConnectView; collectionName?: string }>({ view: viewFromPath() });
  const updateContext = useCallback((view: ConnectView, collectionName?: string) => {
    setContext((previous) => previous.view === view && previous.collectionName === collectionName ? previous : { view, collectionName });
  }, []);
  return <FeedbackProvider endpoint={resolveFeedbackEndpoint(import.meta.env.VITE_MDBASE_FEEDBACK_URL, import.meta.env.DEV)} turnstileSiteKey={import.meta.env.VITE_MDBASE_TURNSTILE_SITE_KEY?.trim() || null} application={feedbackApplication("mdbase connect", context.view, import.meta.env.VITE_MDBASE_REVISION, import.meta.env.VITE_MDBASE_ENV ?? (import.meta.env.DEV ? "development" : "production"))} collectionName={context.collectionName}>
    <ManagementErrorBoundary><ConnectWorkspace onFeedbackContext={updateContext} /></ManagementErrorBoundary>
  </FeedbackProvider>;
}

class ManagementErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <main className="connect-loading" role="alert"><h1><Trans>mdbase connect needs to restart</Trans></h1><p><Trans>Your collections were not deleted.</Trans></p><button onClick={() => location.reload()}><Trans>Reload Connect</Trans></button><FeedbackButton /></main> : this.props.children;
  }
}

function ConnectWorkspace({ onFeedbackContext }: { onFeedbackContext(view: ConnectView, collectionName?: string): void }) {
  useLocaleRevision();
  const { reportError, enabled: feedbackEnabled } = useFeedback();
  const [accountDeleted, setAccountDeleted] = useState(location.pathname === "/account-deleted");
  const [view, setView] = useState<ConnectView>(viewFromPath);
  const [data, setData] = useState<ManagementOverview>();
  const [editorOrigin, setEditorOrigin] = useState<string>();
  const [sessions, setSessions] = useState<Awaited<ReturnType<typeof management.sessions>>["sessions"]>();
  const [refreshError, setRefreshError] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [invitationToken, setInvitationToken] = useState(invitationTokenFromHash);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const busyRef = useRef(new Set<string>());
  const refreshGenerationRef = useRef(0);
  const refreshInFlightRef = useRef<{ promise: Promise<void>; signal?: AbortSignal } | null>(null);
  const lifecycleRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const lifecycle = new AbortController();
    lifecycleRef.current = lifecycle;
    return () => lifecycle.abort(t(i18n)({ message: "Connect management closed" }));
  }, []);

  const refresh = useCallback((signal = lifecycleRef.current?.signal): Promise<void> => {
    if (accountDeleted || signal?.aborted) return Promise.resolve();
    const pending = refreshInFlightRef.current;
    if (pending && !pending.signal?.aborted) return pending.promise;
    const generation = ++refreshGenerationRef.current;
    const request = (async () => {
      try {
        const next = await management.overview({ signal });
        if (generation !== refreshGenerationRef.current) return;
        setData(next);
        setRefreshError("");
        const configuration = await management.uiConfiguration({ signal });
        if (generation !== refreshGenerationRef.current) return;
        setEditorOrigin(configuration.editor_url ? new URL(configuration.editor_url).origin : undefined);
        if (next.authentication.provider !== "tailscale") {
          const sessionResult = await management.sessions({ signal });
          if (generation !== refreshGenerationRef.current) return;
          setSessions(sessionResult.sessions);
        }
      } catch (reason) {
        if (signal?.aborted || generation !== refreshGenerationRef.current) return;
        if (reason instanceof ManagementApiError && reason.status === 401) {
          location.href = new URL("/login", management.baseUrl).href;
          return;
        }
        setRefreshError(errorMessage(reason));
      }
    })();
    refreshInFlightRef.current = { promise: request, signal };
    const settled = () => {
      if (refreshInFlightRef.current?.promise === request) refreshInFlightRef.current = null;
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
    return () => {
      controller.abort();
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    const update = () => setView(viewFromPath());
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);

  async function perform(
    id: string,
    action: (options: ManagementRequestOptions) => Promise<void>,
    inlineErrors = false
  ): Promise<boolean> {
    if (busyRef.current.has(id)) return false;
    const lifecycle = lifecycleRef.current?.signal;
    if (!lifecycle) return false;
    if (lifecycle.aborted) return false;
    const controller = new AbortController();
    const abort = () => controller.abort(lifecycle.reason);
    lifecycle.addEventListener("abort", abort, { once: true });
    busyRef.current.add(id);
    setBusy(new Set(busyRef.current));
    setMutationError("");
    let succeeded = false;
    try {
      await action({ signal: controller.signal });
      succeeded = true;
    } catch (reason) {
      if (!lifecycle.aborted) {
        reportError(feedbackFailure(reason));
        if (!inlineErrors) setMutationError(errorMessage(reason));
      }
    } finally {
      lifecycle.removeEventListener("abort", abort);
      // A pre-mutation overview cannot confirm this operation. Let that read
      // settle, then request a fresh snapshot without overlapping inventory scans.
      if (!lifecycle.aborted) {
        await refreshInFlightRef.current?.promise;
        if (!lifecycle.aborted) await refresh(lifecycle);
      }
      busyRef.current.delete(id);
      if (!lifecycle.aborted) setBusy(new Set(busyRef.current));
    }
    return succeeded;
  }

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

  if (accountDeleted) return <DeletedAccount client={management} />;
  if (!data) return <ConnectLoading error={refreshError} onRetry={() => { setRefreshError(""); void refresh(); }} />;

  const activeView = selectedCollection || !isCollectionView(view) ? view : "collections";
  const freshlyAuthorized = new Set(data.grants
    .filter((grant) => grant.revocation_status === "active"
      && grant.scope.access === "full_collection"
      && grant.scope.contracts.length === 0)
    .map((grant) => `${grant.application_id}\0${grant.collection_id}`));
  const activeGrants = data.grants.filter((grant) => grant.revocation_status !== "revoked"
    || (typeof grant.reauthorization_required_at === "string"
      && !freshlyAuthorized.has(`${grant.application_id}\0${grant.collection_id}`)));
  const installations = data.installation_access ?? [];
  const applications = applicationGroups(activeGrants, installations);
  const selectedGrants = selectedCollection
    ? activeGrants.filter((grant) => grant.collection_id === selectedCollection.id)
    : [];
  const selectedApplications = applicationGroups(selectedGrants, installations.filter((entry) => entry.collection_id === selectedCollection?.id));
  const pendingRequest = data.pending_authorizations[0];
  const pendingCollection = pendingRequest?.collection_id
    ? collections.find((collection) => collection.id === pendingRequest.collection_id)
    : undefined;
  return <div className="connect-shell">
    <aside className="connect-nav" aria-label={t(i18n)({ message: "mdbase connect navigation" })}>
      <header><Brand productLabel /><button className="connect-mobile-nav-toggle" aria-expanded={navigationOpen} aria-controls="connect-section-navigation" onClick={() => setNavigationOpen((open) => !open)}><span>{viewLabel(activeView)}</span><small>{navigationOpen ? t(i18n)({ message: "Close menu", context: "Connect interface" }) : t(i18n)({ message: "Open menu", context: "Connect interface" })}</small></button></header>
      <nav id="connect-section-navigation" className={navigationOpen ? "open" : ""}>
        {selectedCollection && <section className="connect-nav-group" aria-labelledby="current-collection-navigation">
          <p id="current-collection-navigation">{selectedCollection.name}</p>
          <NavLink label={t(i18n)({ message: "Overview", context: "Connect interface" })} icon={<Info />} selected={activeView === "overview"} view="overview" collectionId={selectedCollection.id} navigate={navigate} />
          <NavLink label={t(i18n)({ message: "Storage & sync", context: "Connect interface" })} icon={<HardDrives />} selected={activeView === "storage"} view="storage" collectionId={selectedCollection.id} navigate={navigate} />
          <NavLink label={t(i18n)({ message: "App access", context: "Connect interface" })} icon={<Key />} selected={activeView === "access"} view="access" collectionId={selectedCollection.id} navigate={navigate} />
        </section>}
        <section className="connect-nav-group" aria-labelledby="account-navigation">
          <p id="account-navigation"><Trans>Account</Trans></p>
          <NavLink label={t(i18n)({ message: "All collections", context: "Connect interface" })} icon={<Folder />} selected={activeView === "collections"} view="collections" collectionId={selectedCollection?.id} navigate={navigate} />
          <NavLink label={t(i18n)({ message: "Applications", context: "Connect interface" })} icon={<Package />} selected={activeView === "applications"} view="applications" collectionId={selectedCollection?.id} navigate={navigate} />
          <NavLink label={t(i18n)({ message: "Computers", context: "Connect interface" })} icon={<Desktop />} selected={activeView === "computers"} view="computers" collectionId={selectedCollection?.id} navigate={navigate} />
          <NavLink label={t(i18n)({ message: "Account & sessions", context: "Connect interface" })} icon={<Account />} selected={activeView === "account"} view="account" collectionId={selectedCollection?.id} navigate={navigate} />
          <FeedbackButton className="connect-feedback-mobile-link" />
        </section>
      </nav>
      <footer className="connect-nav-footer"><ThemeMenu /><FeedbackButton />{editorOrigin && <a href={editorCollectionUrl(selectedCollection?.id, editorOrigin)}><Trans>Open editor</Trans></a>}<RouteLink view="account" navigate={navigate} ariaLabel={t(i18n)({ message: "Open account and sessions" })}><strong>{data.user.name}</strong><small>{data.user.login ? `@${data.user.login}` : data.user.email}</small></RouteLink></footer>
    </aside>
    <main className="connect-main">
      {(mutationError || refreshError) && <div className="connect-notice error" role="alert"><Warning aria-hidden="true" />{mutationError || refreshError}<button onClick={() => mutationError ? setMutationError("") : setRefreshError("")}><Trans>Dismiss</Trans></button></div>}
      {invitationToken && <CollectionInvitationBanner
        busy={busy.has("accept-collection-invitation")}
        onAccept={() => void acceptSharedCollection()}
        onDismiss={dismissSharedCollection}
      />}
      {pendingRequest && <PendingRequestBanner request={pendingRequest} collectionName={pendingCollection?.name} count={data.pending_authorizations.length} />}
      {activeView === "overview" && (selectedCollection
        ? <CollectionOverview editorOrigin={editorOrigin} sharingAvailable={data.collection_sharing_available === true} collection={selectedCollection} applications={selectedApplications} busy={busy} perform={perform} navigate={navigate} />
        : <Collections key={data.user.id} editorOrigin={editorOrigin} data={data} busy={busy} perform={perform} navigate={navigate} />)}
      {activeView === "storage" && selectedCollection && <Storage editorOrigin={editorOrigin} collection={selectedCollection} busy={busy} perform={perform} />}
      {activeView === "access" && selectedCollection && <AppAccess collectionName={selectedCollection.name} groups={selectedApplications} client={management} busy={busy} perform={perform} />}
      {activeView === "collections" && <Collections key={data.user.id} editorOrigin={editorOrigin} data={data} busy={busy} perform={perform} navigate={navigate} />}
      {activeView === "applications" && <AppAccess groups={applications} client={management} busy={busy} perform={perform} />}
      {activeView === "computers" && <Computers data={data} busy={busy} perform={perform} />}
      {activeView === "account" && <AccountManagement client={management} overview={data} sessions={sessions} onOverviewRefresh={refresh} onDeleted={() => setAccountDeleted(true)} />}
      {activeView === "feedback" && feedbackEnabled && <FeedbackPage onDone={() => navigate("overview", selectedCollection?.id)} />}
      {activeView === "feedback" && !feedbackEnabled && <Page title={t(i18n)({ message: "Feedback unavailable", context: "Connect interface" })} intro={t(i18n)({ message: "This deployment has not configured a feedback destination." })}><section><Empty title={t(i18n)({ message: "Feedback is unavailable", context: "Connect interface" })} body={t(i18n)({ message: "Contact the person who operates this mdbase connect deployment." })} /></section></Page>}
    </main>
  </div>;
}

function CollectionInvitationBanner({ busy, onAccept, onDismiss }: {
  busy: boolean;
  onAccept(): void;
  onDismiss(): void;
}) {
  useLocaleRevision();
  return <div className="connect-pending-banner connect-sharing-banner" role="status">
    <Notebook aria-hidden="true" />
    <span><strong><Trans>A collection was shared with you</Trans></strong><small><Trans>Accept to add it to your collections. The invitation is bound to this account. Your account name and stable identifier can be shared with other members’ apps when they approve People access.</Trans></small></span>
    <span className="connect-banner-actions"><button disabled={busy} onClick={onDismiss}><Trans>Not now</Trans></button><button className="connect-primary-action mdbase-button is-primary" disabled={busy} onClick={onAccept}>{busy ? t(i18n)({ message: "Accepting…", context: "Connect interface" }) : t(i18n)({ message: "Accept", context: "Connect interface" })}</button></span>
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
    <Warning aria-hidden="true" />
    <span><strong>{title}</strong><small>{detail}</small></span>
    <b>{count === 1 ? t(i18n)({ message: "Review request", context: "Connect interface" }) : t(i18n)({ message: "Review next request", context: "Connect interface" })}</b>
  </a>;
}

function CollectionOverview({ collection, applications, busy, perform, navigate, sharingAvailable, editorOrigin }: {
  editorOrigin?: string;
  sharingAvailable: boolean;
  collection: CollectionRow;
  applications: ReturnType<typeof applicationGroups>;
  busy: BusyOperations;
  perform: PerformOperation;
  navigate(view: ConnectView, collectionId?: string): void;
}) {
  useLocaleRevision();
  return <Page title={collection.name} intro={t(i18n)({ message: "Manage where this collection lives and which applications can use it." })}>
    <section>
      <SectionTitle title={t(i18n)({ message: "Storage", context: "Connect interface" })} action={<RouteLink view="storage" collectionId={collection.id} navigate={navigate}>{t(i18n)({ message: "Manage", context: "Connect interface" })}</RouteLink>} />
      <div className="connect-row connect-storage-summary"><div><strong><Trans>Main copy</Trans></strong><small>{collection.kind === "native" ? t(i18n)({ message: "Stored on your devices", context: "Connect interface" }) : collection.kind === "hosted" ? t(i18n)({ message: "Stored by mdbase", context: "Connect interface" }) : t(i18n)`Stored on ${collection.detail}`}</small></div><span className={`connect-status ${collection.available ? "online" : "idle"}`}><i />{collection.status}</span></div>
    </section>
    <section>
      <SectionTitle title={t(i18n)({ message: "Application access", context: "Connect interface" })} count={applications.length} action={<RouteLink view="access" collectionId={collection.id} navigate={navigate}>{t(i18n)({ message: "Review all", context: "Connect interface" })}</RouteLink>} />
      {applications.map((application) => <div className="connect-row connect-application-row" key={application.applicationId}><div><strong>{application.applicationName}</strong><small>{host(application.grants[0]?.homepage ?? application.installations[0].application_origin)}</small></div><span>{application.installations.length ? t(i18n)({ message: "Access as your account", context: "Connect interface" }) : permissionSummary(application.grants)}</span><RouteLink view="access" collectionId={collection.id} navigate={navigate}>{t(i18n)({ message: "Review", context: "Connect interface" })}</RouteLink></div>)}
      {applications.length === 0 && <Empty title={t(i18n)({ message: "No connected applications" })} body={t(i18n)({ message: "Applications appear after you approve access to this collection." })} />}
    </section>
    <section><SectionTitle title={t(i18n)({ message: "Your person record", context: "Connect interface" })} /><div className="connect-row"><div><strong><Trans>Use an existing person or create a note</Trans></strong><small><Trans>Link your account to an editable record in this collection. Collection access is approved separately.</Trans></small></div>{editorOrigin && <a href={`${editorSurfaceUrls(collection.id, editorOrigin).settings}#your-person`}><Trans>Choose or create my person record</Trans></a>}</div></section>
    {collection.kind !== "local" && collection.source.access.can_manage_members && <CollectionSharingPanel key={collection.id} sharingAvailable={sharingAvailable} collection={collection.source} busy={busy} perform={perform} />}
    <section>
      <SectionTitle title={t(i18n)({ message: "Connection", context: "Connect interface" })} />
      <div className="connect-row connect-connection-summary"><div><small>{connectionDescription(collection)}</small></div><span className={`connect-status ${collection.available ? "online" : "idle"}`}><i />{collection.status}</span></div>
    </section>
  </Page>;
}

function CollectionSharingPanel({ collection, busy, perform, sharingAvailable }: {
  sharingAvailable: boolean;
  collection: { id: string; display_name: string | null };
  busy: BusyOperations;
  perform: PerformOperation;
}) {
  useLocaleRevision();
  const [members, setMembers] = useState<HostedCollectionMember[]>();
  const [invitations, setInvitations] = useState<HostedCollectionInvitation[]>();
  const [loadError, setLoadError] = useState("");
  const [inviting, setInviting] = useState(false);
  const [targetMode, setTargetMode] = useState<"email" | "invitee_code">("email");
  const [target, setTarget] = useState("");
  const [role, setRole] = useState<"viewer" | "editor">("viewer");
  const [shareLink, setShareLink] = useState("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [memberResult, invitationResult] = await Promise.all([
        management.collectionMembers(collection.id, { signal }),
        management.collectionInvitations(collection.id, { signal })
      ]);
      if (signal?.aborted) return;
      setMembers(memberResult.members);
      setInvitations(invitationResult.invitations);
      setLoadError("");
    } catch (reason) {
      if (!signal?.aborted) setLoadError(errorMessage(reason));
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
      }
    );
    if (!succeeded) return;
    setTarget("");
    setInviting(false);
    setCopied(false);
    setShareLink(collectionInvitationUrl(token));
    await load();
  }

  async function mutate(id: string, action: (options: ManagementRequestOptions) => Promise<void>) {
    if (await perform(id, action)) await load();
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
      action={sharingAvailable && <button onClick={() => { setInviting(true); setShareLink(""); }}><Trans><Plus aria-hidden="true" />Invite person</Trans></button>}
    />
    {loadError && <div className="connect-notice error" role="alert">{loadError}<button onClick={() => void load()}><Trans>Try again</Trans></button></div>}
    {sharingAvailable && inviting && <form className="connect-inline-form connect-sharing-form" onSubmit={(event) => void invite(event)}>
      <label><span><Trans>Invite using</Trans></span><Select aria-label={t(i18n)({ message: "Invite using", context: "Connect interface" })} value={targetMode} options={[{ value: "email", label: t(i18n)`Verified email` }, { value: "invitee_code", label: t(i18n)`Sharing code` }]} onChange={(next) => { setTargetMode(next); setTarget(""); }} /></label>
      <label><span>{targetMode === "email" ? t(i18n)({ message: "Email address", context: "Connect interface" }) : t(i18n)({ message: "Sharing code", context: "Connect interface" })}</span><input autoFocus type={targetMode === "email" ? "email" : "text"} maxLength={targetMode === "email" ? 320 : 32} value={target} onChange={(event) => setTarget(event.target.value)} placeholder={targetMode === "email" ? t(i18n)({ message: "person@example.com", context: "Connect interface" }) : "ABCD-EFGH"} /></label>
      <label><span><Trans>Role</Trans></span><Select aria-label={t(i18n)({ message: "Role", context: "Connect interface" })} value={role} options={memberRoles} onChange={setRole} /></label>
      <p>{role === "viewer" ? t(i18n)({ message: "Can read this collection and connect read-only apps or folders." }) : t(i18n)({ message: "Can edit notes, manage types, rename this collection, and connect apps." })}</p>
      <div><button type="button" onClick={() => setInviting(false)}><Trans>Cancel</Trans></button><button className="connect-primary-action mdbase-button is-primary" disabled={!target.trim() || busy.has(`sharing-invite-${collection.id}`)}>{busy.has(`sharing-invite-${collection.id}`) ? t(i18n)({ message: "Creating…", context: "Connect interface" }) : t(i18n)({ message: "Create invitation", context: "Connect interface" })}</button></div>
    </form>}
    {shareLink && <div className="connect-sharing-link" role="status"><div><strong><Trans>Invitation ready</Trans></strong><small><Trans>Send this private link to the invited person. Email invitations require an already registered, verified account. If they have just signed up, create a new invitation.</Trans></small></div><input aria-label={t(i18n)({ message: "Collection invitation link" })} readOnly value={shareLink} onFocus={(event) => event.currentTarget.select()} /><button onClick={() => void copyLink()}>{copied ? t(i18n)({ message: "Copied", context: "Connect interface" }) : t(i18n)({ message: "Copy link", context: "Connect interface" })}</button></div>}
    {members?.map((member) => <div className="connect-row connect-member-row" key={member.id ?? "owner"}>
      <div><strong>{member.name}</strong><small>{member.kind === "owner" ? t(i18n)({ message: "Collection owner", context: "Connect interface" }) : member.state === "changing" ? t(i18n)({ message: "Updating access…", context: "Connect interface" }) : member.state === "revoking" ? t(i18n)({ message: "Removing application and folder access…" }) : member.role === "editor" ? t(i18n)({ message: "Can edit notes and manage types" }) : t(i18n)({ message: "Can view and connect read-only apps" })}</small></div>
      {member.kind === "owner" ? <span><Trans>Owner</Trans></span> : <>
        <label className="connect-role-select"><span className="sr-only"><Trans>Role for {literal(member.name)}</Trans></span><Select aria-label={t(i18n)`Role for ${member.name}`} value={member.role as MemberRole} options={memberRoles} disabled={member.state !== "active" || (!sharingAvailable && member.role === "viewer") || busy.has(`member-role-${member.id}`)} onChange={(next) => void mutate(`member-role-${member.id}`, (options) => management.changeCollectionMemberRole(collection.id, member.id!, next, options))} /></label>
        <ConfirmAction className="danger" label={member.state === "revoking" ? t(i18n)({ message: "Removing…", context: "Connect interface" }) : t(i18n)({ message: "Remove", context: "Connect interface" })} question={collection.display_name ? t(i18n)`Remove ${member.name} from ${collection.display_name}? Their application and folder access will also be revoked.` : t(i18n)`Remove ${member.name} from the unnamed collection? Their application and folder access will also be revoked.`} confirmLabel={t(i18n)({ message: "Remove access", context: "Connect interface" })} busy={member.state === "revoking" || busy.has(`member-revoke-${member.id}`)} onConfirm={() => void mutate(`member-revoke-${member.id}`, (options) => management.revokeCollectionMember(collection.id, member.id!, options))} />
      </>}
    </div>)}
    {members === undefined && !loadError && <p className="connect-muted" role="status"><Trans>Loading people…</Trans></p>}
    {activeInvitations.length > 0 && <>
      <SectionTitle title={t(i18n)({ message: "Pending invitations", context: "Connect interface" })} count={activeInvitations.length} />
      {activeInvitations.map((invitation) => <div className="connect-row" key={invitation.id}><div><strong>{invitation.submitted_email ?? t(i18n)({ message: "Invitee code", context: "Connect interface" })}</strong><small><Trans>{invitation.role === "editor" ? t(i18n)({ message: "Editor", context: "Connect interface" }) : t(i18n)({ message: "Viewer", context: "Connect interface" })} · Expires {relativeTime(invitation.expires_at)}</Trans></small></div><span><Trans>Pending</Trans></span><ConfirmAction className="danger" label={t(i18n)({ message: "Cancel", context: "Connect interface" })} question={t(i18n)({ message: "Cancel this collection invitation?" })} confirmLabel={t(i18n)({ message: "Cancel invitation", context: "Connect interface" })} busy={busy.has(`invitation-cancel-${invitation.id}`)} onConfirm={() => void mutate(`invitation-cancel-${invitation.id}`, (options) => management.cancelCollectionInvitation(collection.id, invitation.id, options))} /></div>)}
    </>}
  </section>;
}

function Storage({ collection, busy, perform, editorOrigin }: {
  editorOrigin?: string;
  collection: CollectionRow;
  busy: BusyOperations;
  perform: PerformOperation;
}) {
  useLocaleRevision();
  if (collection.kind === "native") {
    return <Page title={t(i18n)({ message: "Storage & sync", context: "Connect interface" })} intro={t(i18n)`${collection.name} is stored in mdbase replicas on your devices.`}>
      <CollectionModeControl key={collection.id} collectionId={collection.id} load={() => management.collectionModeStatus(collection.id)} change={(targetMode, requestId) => management.requestCollectionMode(collection.id, {targetMode, requestId})} />
      <section><SectionTitle title={t(i18n)({ message: "Sync", context: "Connect interface" })} /><div className="connect-row"><div><strong><Trans>Collection replicas</Trans></strong><small><Trans>Replicas sync between your devices. Application access is managed separately.</Trans></small></div></div></section>
    </Page>;
  }
  if (collection.kind === "hosted") {
    const replicas = collection.source.replicas.filter((replica) => replica.revocation_status !== "revoked");
    return <Page title={t(i18n)({ message: "Storage & sync", context: "Connect interface" })} intro={t(i18n)`Manage the main copy of ${collection.name} and its synced Markdown folders.`}>
      <section>
        <SectionTitle title={t(i18n)({ message: "Main copy", context: "Connect interface" })} />
        <HostedCollectionRow editorOrigin={editorOrigin} collection={collection.source} busy={busy} perform={perform} showReplicas={false} />
      </section>
      <section>
        <SectionTitle title={t(i18n)({ message: "Synced folders", context: "Connect interface" })} count={replicas.length} action={<a href={`mdbase-connect://mirror?collection=${encodeURIComponent(collection.source.id)}`}><Trans><Plus aria-hidden="true" />Sync a folder</Trans></a>} />
        {replicas.map((replica) => <div className="connect-row" key={replica.id}><div><strong>{replica.name}</strong><small>{replica.mode === "read_only" ? t(i18n)({ message: "Downloads only", context: "Connect interface" }) : t(i18n)({ message: "Edits sync both ways", context: "Connect interface" })}</small></div><span>{replica.revocation_status === "revoking" ? t(i18n)({ message: "Disconnecting…", context: "Connect interface" }) : replica.sync_status ? t(i18n)`Seen ${relativeTime(replica.sync_status.last_seen_at ?? collection.source.created_at)}` : t(i18n)({ message: "Waiting to sync", context: "Connect interface" })}</span><ConfirmAction className="danger" label={replica.revocation_status === "revoking" ? t(i18n)({ message: "Disconnecting…", context: "Connect interface" }) : t(i18n)({ message: "Disconnect", context: "Connect interface" })} question={t(i18n)`Disconnect ${replica.name}?`} confirmLabel={t(i18n)({ message: "Disconnect", context: "Connect interface" })} busy={replica.revocation_status === "revoking" || busy.has(`replica-${replica.id}`)} onConfirm={() => void perform(`replica-${replica.id}`, (options) => management.revokeReplica(replica.id, options))} /></div>)}
        {replicas.length === 0 && <Empty title={t(i18n)({ message: "No synced folders", context: "Connect interface" })} body={t(i18n)({ message: "Use the desktop app to keep an ordinary Markdown folder on a computer." })} />}
        <DesktopRecoveryHelp action={t(i18n)({ message: "sync a folder", context: "Connect interface" })} />
      </section>
    </Page>;
  }
  return <Page title={t(i18n)({ message: "Storage & sync", context: "Connect interface" })} intro={t(i18n)`${collection.name} keeps its main copy in a folder on a connected computer.`}>
    <section>
      <SectionTitle title={t(i18n)({ message: "Main copy", context: "Connect interface" })} />
      <div className="connect-row"><div><strong>{collection.detail}</strong><small><Trans>The folder remains the authority for this collection.</Trans></small></div><span className={`connect-status ${collection.available ? "online" : "idle"}`}><i />{collection.status}</span><a href="mdbase-connect://open"><Trans>Open desktop app</Trans></a></div>
      <DesktopRecoveryHelp action={t(i18n)({ message: "open this collection", context: "Connect interface" })} />
    </section>
  </Page>;
}

function Collections({ data, busy, perform, navigate, editorOrigin }: {
  editorOrigin?: string;
  data: ManagementOverview;
  busy: BusyOperations;
  perform: PerformOperation;
  navigate(view: ConnectView, collectionId?: string): void;
}) {
  useLocaleRevision();
  const [creating, setCreating] = useState(false);
  const [intent, setIntent] = useState<CollectionCreationIntent | null>(() => readCollectionCreation(data.user.id));
  const [name, setName] = useState(() => readCollectionCreation(data.user.id)?.displayName ?? "My collection");
  const [creationError, setCreationError] = useState<string | null>(null);
  const [location, setLocation] = useState("");
  const hostedEnabled = data.hosted_collections_available === true;
  const locations = [
    ...(data.native_collection_creation_available ? [{ value: "native", label: t(i18n)({ message: "On this computer", context: "Connect interface" }) }] : []),
    ...(hostedEnabled || intent !== null ? [{ value: "hosted", label: t(i18n)({ message: "Hosted", context: "Connect interface" }) }] : [])
  ];
  const hosted = location === "hosted" && (hostedEnabled || intent !== null);
  const native = location === "native" && data.native_collection_creation_available === true && intent === null;
  const rows = collectionRows(data);
  const canCreate = data.collection_creation_available ?? data.hosted_collections_available !== false;
  async function create(event: FormEvent) {
    event.preventDefault();
    if (!hosted || !hostedEnabled || !name.trim() || !canCreate || busy.has("create-collection")) return;
    if (!intent && /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ud800-\udfff]/u.test(name)) {setCreationError(t(i18n)({ message: "Use a single-line collection name." })); return;}
    let original: CollectionCreationIntent;
    try {
      original = readCollectionCreation(data.user.id) ?? {accountId:data.user.id, requestId:crypto.randomUUID(), displayName:name.trim(), timezone:Intl.DateTimeFormat().resolvedOptions().timeZone};
      keepCollectionCreation(original); // Persist BEFORE any POST or unknown result.
      setIntent(original); setName(original.displayName); setCreationError(null);
    } catch {
      setCreationError(t(i18n)({ message: "This browser could not keep your creation request. No request was sent." })); return;
    }
    const created = await perform("create-collection", async options => {
      try {await management.createCollection(original, options);}
      catch (error) {setCreationError(errorMessage(error)); throw error;}
    }, true);
    if (created) {
      try {finishCollectionCreation(original);} catch {setCreationError(t(i18n)({ message: "Created, but this browser could not clear its request. Retrying will use the same collection." })); return;}
      setIntent(null); setCreating(false); setName("My collection");
    }
  }
  return <Page title={t(i18n)({ message: "Collections", context: "Connect interface" })} intro={t(i18n)({ message: "Open a collection in the editor or manage where its main copy lives." })}>
    <section>
      <SectionTitle title={t(i18n)({ message: "All collections", context: "Connect interface" })} count={rows.length} action={<button onClick={() => {
        const pending = readCollectionCreation(data.user.id);
        setIntent(pending);
        if (pending) setName(pending.displayName);
        setLocation(pending ? "hosted" : locations.length === 1 ? locations[0]!.value : "");
        setCreating(true);
      }}><Trans><Plus aria-hidden="true" />Add collection</Trans></button>} />
      {creating && <form className="connect-inline-form connect-add-collection" onSubmit={(event) => void create(event)} aria-label={t(i18n)({ message: "Add collection", context: "Connect interface" })}>
        {locations.length > 0 ? <label><span><Trans>Location</Trans></span><Select aria-label={t(i18n)({ message: "Location", context: "Connect interface" })} value={location} onChange={setLocation} options={locations} placeholder={t(i18n)({ message: "Choose a location", context: "Connect interface" })} disabled={intent !== null || busy.has("create-collection")} /></label>
          : <p><Trans>Connect a computer to add a collection.</Trans></p>}
        {hosted && <>
          <label><span><Trans>Collection name</Trans></span><input autoFocus maxLength={200} value={name} disabled={intent !== null || busy.has("create-collection")} aria-describedby={creationError ? "collection-create-error" : undefined} onChange={(event) => setName(event.target.value)} /></label>
          {(!hostedEnabled || !canCreate) && <p><Trans>Hosted creation is unavailable on this server.</Trans></p>}
        </>}
        {native && <p><Trans>Choose or create a folder in the desktop app. Collection files stay on this computer.</Trans></p>}
        {creationError && <p role="alert" id="collection-create-error">{creationError}</p>}
        {intent && <p role="status"><Trans>Your original request is kept. Retry it to avoid creating another collection.</Trans></p>}
        <div><button type="button" onClick={() => setCreating(false)}><Trans>Close</Trans></button>
          {(native || locations.length === 0) && <a href="mdbase-connect://open"><Trans>Open mdbase connect</Trans></a>}
          {hosted && <button className="connect-primary-action mdbase-button is-primary" disabled={!hostedEnabled || !canCreate || busy.has("create-collection") || !name.trim()}>{busy.has("create-collection") ? t(i18n)({ message: "Creating…", context: "Connect interface" }) : intent ? t(i18n)({ message: "Retry creation", context: "Connect interface" }) : t(i18n)({ message: "Create", context: "Connect interface" })}</button>}
        </div>
      </form>}
      {rows.map((collection) => collection.kind === "hosted"
        ? <HostedCollectionRow editorOrigin={editorOrigin} key={collection.id} collection={collection.source} busy={busy} perform={perform} manage={{ collectionId: collection.id, navigate }} />
        : <CollectionSummary editorOrigin={editorOrigin} key={collection.id} collection={collection} navigate={navigate} />)}
      {rows.length === 0 && <Empty title={t(i18n)({ message: "No collections", context: "Connect interface" })} body={t(i18n)({ message: "Add a collection to get started." })} />}
      {rows.some((collection) => collection.kind === "hosted" && collection.source.authority_state === "active") && <DesktopRecoveryHelp action={t(i18n)({ message: "sync a folder", context: "Connect interface" })} />}
    </section>
  </Page>;
}

function HostedCollectionRow({ collection, busy, perform, manage, showReplicas = true, editorOrigin }: {
  editorOrigin?: string;
  collection: HostedCollection;
  busy: BusyOperations;
  perform: PerformOperation;
  manage?: { collectionId: string; navigate(view: ConnectView, collectionId?: string): void };
  showReplicas?: boolean;
}) {
  useLocaleRevision();
  const active = collection.authority_state === "active";
  const editorId = active ? collection.id : collection.transferred_collection_id;
  const replicas = collection.replicas.filter((replica) => replica.revocation_status !== "revoked");
  return <div className="connect-row connect-collection-row">
    <div><strong>{collection.display_name}</strong><small>{active ? t(i18n)`Hosted by mdbase · ${countLabel(replicas.length, "folder")}` : collection.authority_state === "transferring" ? t(i18n)({ message: "Moving to a computer", context: "Connect interface" }) : t(i18n)({ message: "Main copy moved to a computer" })}</small></div>
    <span className={`connect-status ${active ? "online" : "idle"}`}><i />{active ? t(i18n)({ message: "Hosted", context: "Connect interface" }) : t(i18n)({ message: "Moved", context: "Connect interface" })}</span>
    <div className="connect-row-actions">
      {manage && <RouteLink view="overview" collectionId={manage.collectionId} navigate={manage.navigate}>{t(i18n)({ message: "Manage", context: "Connect interface" })}</RouteLink>}
      {editorId && editorOrigin && <a href={editorCollectionUrl(editorId, editorOrigin)}><Trans>Open</Trans></a>}
      {active && <a href={`mdbase-connect://mirror?collection=${encodeURIComponent(collection.id)}`}><Trans>Sync folder</Trans></a>}
      {active && collection.access.can_rename_collection && <InlineRename value={collection.display_name} inputLabel={t(i18n)`Rename ${collection.display_name}`} busy={busy.has(`collection-${collection.id}`)} onSubmit={(name) => perform(`collection-${collection.id}`, (options) => management.renameHostedCollection(collection.id, name, options))} />}
      {collection.access.can_delete_collection && <ConfirmAction className="danger" label={t(i18n)({ message: "Delete", context: "Connect interface" })} question={t(i18n)`Delete ${collection.display_name} and all of its hosted data? This cannot be undone.`} confirmLabel={t(i18n)({ message: "Delete permanently", context: "Connect interface" })} busy={busy.has(`collection-${collection.id}`)} onConfirm={() => void perform(`collection-${collection.id}`, (options) => management.deleteHostedCollection(collection.id, options))} />}
    </div>
    {showReplicas && replicas.length > 0 && <details className="connect-row-detail"><summary><Trans>Synced folders</Trans></summary>{replicas.map((replica) => <div key={replica.id}>
      <span><strong>{replica.name}</strong><small>{replica.mode === "read_only" ? t(i18n)({ message: "Downloads only", context: "Connect interface" }) : t(i18n)({ message: "Two-way sync", context: "Connect interface" })}</small></span>
      <ConfirmAction className="danger" label={replica.revocation_status === "revoking" ? t(i18n)({ message: "Revoking…", context: "Connect interface" }) : t(i18n)({ message: "Revoke", context: "Connect interface" })} question={t(i18n)`Revoke ${replica.name}?`} confirmLabel={t(i18n)({ message: "Revoke", context: "Connect interface" })} busy={replica.revocation_status === "revoking" || busy.has(`replica-${replica.id}`)} onConfirm={() => void perform(`replica-${replica.id}`, (options) => management.revokeReplica(replica.id, options))} />
    </div>)}</details>}
  </div>;
}

function Computers({ data, busy, perform }: {
  data: ManagementOverview;
  busy: BusyOperations;
  perform: PerformOperation;
}) {
  useLocaleRevision();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const status = (connector: ManagementOverview["connectors"][number]) => connector.compatibility === "upgrade_required"
    ? "upgrade_required" : !connector.last_seen_at ? "not_connected" : isConnectorOnline(connector.last_seen_at) ? "online" : "offline";
  const query = search.trim().toLowerCase();
  const visible = data.connectors.filter((connector) => (filter === "all" || status(connector) === filter)
    && (!query || connector.name.toLowerCase().includes(query) || connector.id.toLowerCase().includes(query)));
  return <Page title={t(i18n)({ message: "Computers", context: "Connect interface" })} intro={t(i18n)({ message: "Registered computers stay listed when offline. Revoking one also invalidates grants routed through it." })}>
    <section>
      <SectionTitle title={t(i18n)({ message: "Registered computers", context: "Connect interface" })} count={data.connectors.length} />
      {data.connectors.length > 0 && <>
        <div className="connect-computer-tools">
          <label><span><Trans>Find a computer</Trans></span><input type="search" value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder={t(i18n)({ message: "Name or registration ID", context: "Connect interface" })} /></label>
          <label><span><Trans>Status</Trans></span><Select aria-label={t(i18n)({ message: "Computer status", context: "Connect interface" })} value={filter} onChange={setFilter} options={[
            { value: "all", label: t(i18n)`All statuses` }, { value: "online", label: t(i18n)`Online` }, { value: "offline", label: t(i18n)`Offline` },
            { value: "not_connected", label: t(i18n)`Not connected yet` }, { value: "upgrade_required", label: t(i18n)`Update required` }
          ]} /></label>
        </div>
        <p className="connect-muted" role="status" aria-label={t(i18n)({ message: "Computer filter results", context: "Connect interface" })}><Trans>Showing {visible.length} of {data.connectors.length} registered computers.</Trans></p>
      </>}
      {visible.map((connector) => {
        const upgradeRequired = connector.compatibility === "upgrade_required";
        const updateRecommended = connector.update_recommended === true;
        const online = !upgradeRequired && isConnectorOnline(connector.last_seen_at);
        const collections = data.collections.filter((collection) => collection.connector_id === connector.id);
        return <div className="connect-row" key={connector.id}>
          <div><strong>{connector.name}</strong><small>{countLabel(collections.length, "collection")} · {connector.last_seen_at ? t(i18n)`Seen ${relativeTime(connector.last_seen_at)}` : t(i18n)({ message: "Not connected yet", context: "Connect interface" })}</small><small><Trans>Registered {new Date(connector.created_at).toLocaleString()} · ID {connector.id.slice(-8)}</Trans></small></div>
          <span className={`connect-status ${online ? "online" : "idle"}`}><i />{upgradeRequired ? t(i18n)({ message: "Update required", context: "Connect interface" }) : online ? t(i18n)({ message: "Online", context: "Connect interface" }) : connector.last_seen_at ? t(i18n)({ message: "Offline", context: "Connect interface" }) : t(i18n)({ message: "Not connected yet", context: "Connect interface" })}</span>
          {upgradeRequired && <a href={connector.update_url ?? desktopReleaseUrl} target="_blank" rel="noreferrer"><Trans>Install {connector.minimum_connector_version ? t(i18n)`version ${connector.minimum_connector_version} or later` : t(i18n)({ message: "the latest release", context: "Connect interface" })}</Trans></a>}
          {!upgradeRequired && updateRecommended && <a href={connector.update_url ?? desktopReleaseUrl} target="_blank" rel="noreferrer"><Trans>Update recommended for current policy protection</Trans></a>}
          <div className="connect-row-actions"><InlineRename value={connector.name} inputLabel={t(i18n)`Rename ${connector.name}`} busy={busy.has(`computer-${connector.id}`)} onSubmit={(name) => perform(`computer-${connector.id}`, (options) => management.renameConnector(connector.id, name, options))} /><ConfirmAction className="danger" label={t(i18n)({ message: "Revoke", context: "Connect interface" })} question={t(i18n)`Revoke ${connector.name} and the application grants routed through it?`} confirmLabel={t(i18n)({ message: "Revoke computer", context: "Connect interface" })} busy={busy.has(`computer-${connector.id}`)} onConfirm={() => void perform(`computer-${connector.id}`, (options) => management.revokeConnector(connector.id, options))} /></div>
        </div>;
      })}
      {data.connectors.length > 0 && visible.length === 0 && <Empty title={t(i18n)({ message: "No computers match", context: "Connect interface" })} body={t(i18n)({ message: "Try a different name, registration ID or status. Filtering does not revoke access." })} />}
      {data.connectors.length === 0 && <Empty title={t(i18n)({ message: "No computers connected", context: "Connect interface" })} body={t(i18n)({ message: "Open the mdbase connect desktop app and choose Connect this computer." })} action={<span className="connect-empty-actions"><a href="mdbase-connect://open"><Trans>Open mdbase connect</Trans></a><a href={desktopReleaseUrl} target="_blank" rel="noreferrer"><Trans>Install the latest release</Trans></a></span>} />}
    </section>
  </Page>;
}

interface CollectionRowBase {
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
    kind: "hosted" as const,
    source: collection
  }));
  const native = (data.native_collections ?? []).map((collection) => {
    const computers = (collection.computer_ids ?? []).flatMap((id) => {
      const computer = connectors.get(id);
      return computer ? [computer] : [];
    });
    const computer = computers.find((candidate) => isConnectorOnline(candidate.last_seen_at)) ?? computers[0];
    const status = collection.sync === "cloud_copy" ? t(i18n)({ message: "Hosted", context: "Connect interface" })
      : computer ? isConnectorOnline(computer.last_seen_at) ? t(i18n)`On ${computer.name}` : t(i18n)`On ${computer.name}: offline`
      : t(i18n)({ message: "Computer not connected", context: "Connect interface" });
    return {
      id: collection.id,
      name: collection.display_name ?? t(i18n)({ message: "Unnamed collection", context: "Connect interface" }),
      detail: collection.sync === "cloud_copy" ? t(i18n)({ message: "Cloud copy configured", context: "Connect interface" }) : t(i18n)({ message: "Stored on your devices", context: "Connect interface" }),
      status,
      // Computer presence is not content readiness, Effective, or an app grant.
      available: false,
      kind: "native" as const,
      source: collection
    };
  });
  return [...native, ...hosted, ...local].sort((left, right) => left.name.localeCompare(right.name));
}

function CollectionSummary({ collection, navigate, editorOrigin }: { editorOrigin?: string; collection: CollectionRow; navigate(view: ConnectView, collectionId?: string): void }) {
  useLocaleRevision();
  return <div className="connect-row"><div><strong>{collection.name}</strong><small>{collection.detail}</small></div><span className={`connect-status ${collection.available ? "online" : "idle"}`}><i />{collection.status}</span><div className="connect-row-actions"><RouteLink view="overview" collectionId={collection.id} navigate={navigate}>{t(i18n)({ message: "Manage", context: "Connect interface" })}</RouteLink>{editorOrigin && <a href={editorCollectionUrl(collection.id, editorOrigin)}><Trans>Open in editor</Trans></a>}</div></div>;
}

function connectionDescription(collection: CollectionRow): string {
  if (collection.kind === "native") return t(i18n)({ message: "Management access does not give applications access to collection content. Each application needs its own collection approval." });
  if (collection.kind === "hosted") {
    return collection.available
      ? t(i18n)({ message: "The hosted collection is available to the editor." })
      : t(i18n)({ message: "The main copy has moved away from hosted storage." });
  }
  if (collection.paused) return t(i18n)({ message: "Access to this collection is paused on its computer." });
  if (collection.upgradeRequired) {
    return t(i18n)`Update mdbase connect on ${collection.detail} before using this collection.`;
  }
  return collection.available
    ? t(i18n)`The editor can reach this collection through ${collection.detail}.`
    : t(i18n)`Open mdbase connect on ${collection.detail} to make this collection available.`;
}

function isConnectorOnline(lastSeenAt: string | null): boolean {
  return lastSeenAt !== null && Date.now() - new Date(lastSeenAt).getTime() < 45_000;
}

function NavLink({ label, icon, selected, view, collectionId, navigate }: {
  label: string;
  icon: ReactNode;
  selected: boolean;
  view: ConnectView;
  collectionId?: string;
  navigate(view: ConnectView, collectionId?: string): void;
}) {
  useLocaleRevision();
  return <RouteLink className={selected ? "selected" : ""} ariaCurrent={selected ? "page" : undefined} view={view} collectionId={collectionId} navigate={navigate}><span aria-hidden="true">{icon}</span><strong>{label}</strong></RouteLink>;
}

function RouteLink({ view, collectionId, navigate, children, className = "", ariaLabel, ariaCurrent }: {
  view: ConnectView;
  collectionId?: string;
  navigate(view: ConnectView, collectionId?: string): void;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
  ariaCurrent?: "page";
}) {
  useLocaleRevision();
  function activate(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(view, collectionId);
  }
  return <a className={className} href={connectViewUrl(view, collectionId)} aria-label={ariaLabel} aria-current={ariaCurrent} onClick={activate}>{children}</a>;
}

const connectLoadingFailed = { kind: "error", id: 1 } as const;

function ConnectLoading({ error, onRetry }: { error: string; onRetry(): void }) {
  useLocaleRevision();
  const { reportError } = useFeedback();
  const reportedInitialFailure = useRef(false);
  useEffect(() => {
    if (error && !reportedInitialFailure.current) { reportedInitialFailure.current = true; reportError({ code: "unknown_error" }); }
  }, [error, reportError]);
  return <div className="connect-loading" aria-busy={!error}><MdbaseMark motion="orbit" signal={error ? connectLoadingFailed : null} className="wordmark-mark" /><strong>{error ? t(i18n)({ message: "mdbase connect is unavailable" }) : t(i18n)({ message: "Opening mdbase connect", context: "Connect interface" })}</strong><p>{error || t(i18n)({ message: "Loading your account and collections…" })}</p>{error && <button onClick={onRetry}><Trans>Try again</Trans></button>}<FeedbackButton topic={error ? "problem" : undefined} /></div>;
}

function DesktopRecoveryHelp({ action }: { action: string }) {
  useLocaleRevision();
  return <p className="connect-desktop-help"><Trans>If the desktop app does not open when you {action}, <a href={desktopReleaseUrl} target="_blank" rel="noreferrer">install the latest release</a> and try again.</Trans></p>;
}

function viewFromPath(): ConnectView {
  // Reader/SDK manage-access links still use this route; keep until those clients use /applications.
  if (location.pathname === "/account/applications") return "applications";
  const segment = location.pathname.split("/")[1];
  return segment === "storage" || segment === "access" || segment === "collections" || segment === "applications" || segment === "computers" || segment === "account" || segment === "feedback" ? segment : "overview";
}

function isCollectionView(view: ConnectView): boolean {
  return view === "overview" || view === "storage" || view === "access";
}

function viewLabel(view: ConnectView): string {
  if (view === "overview") return t(i18n)({ message: "Overview", context: "Connect interface" });
  if (view === "storage") return t(i18n)({ message: "Storage & sync", context: "Connect interface" });
  if (view === "access") return t(i18n)({ message: "App access", context: "Connect interface" });
  if (view === "collections") return t(i18n)({ message: "All collections", context: "Connect interface" });
  if (view === "applications") return t(i18n)({ message: "Applications", context: "Connect interface" });
  if (view === "computers") return t(i18n)({ message: "Computers", context: "Connect interface" });
  if (view === "feedback") return t(i18n)({ message: "Send feedback", context: "Connect interface" });
  return t(i18n)({ message: "Account & sessions", context: "Connect interface" });
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
  history.replaceState(
    null,
    "",
    `${url.pathname}${url.search}${url.hash}`
  );
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

function errorMessage(value: unknown): string {
  const detail = value instanceof Error ? value.message : String(value);
  return /failed to fetch|networkerror|network request failed/i.test(detail)
    ? t(i18n)({ message: "mdbase connect could not be reached. Check your connection and try again." })
    : detail;
}

function host(value: string): string {
  try { return new URL(value).host; } catch { return value; }
}

function feedbackFailure(reason: unknown): FeedbackFailure {
  if (!(reason instanceof ManagementApiError)) return { code: "unknown_error" };
  const codes = ["cancelled", "http_error", "invalid_response", "outcome_unknown", "partial_failure", "timeout", "network_error"] as const;
  const code = codes.find((value) => value === reason.code) ?? "http_error";
  return { code, ...(Number.isInteger(reason.status) && reason.status >= 100 && reason.status <= 599 ? { status: reason.status } : {}) };
}

function relativeTime(value: string): string {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1_000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return format.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, "hour");
  return format.format(Math.round(hours / 24), "day");
}
