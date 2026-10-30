/** Shared first-party browser sign-in lifecycle. The original protected request,
 * installation owner and native device are retained; no app-grant/key loan API.
 * Collection adapters run in the trusted owner Worker, never in a redirect. */
import type { AppNativeAuthorizationPort, AppNativeAuthorizationContext, AppNativePreparation } from "./native-sign-in.js";
import { appServerOutcome, isAppServerProblem, sanitizeAppServerProblem, MIN_SERVER_RETRY_MS, MAX_SERVER_RETRY_MS, type AppServerProblem } from "./cp-problem.js";
import { AppProtectedInstallationSignIn, AppInstallationSignInError, type AppInstallationSignInOptions, type AppInstallationSignInView, type AppInstallationCollection, type AppFileAction, type AppInstallationFileAccessRequest, type AppInstallationFileAccessOutcome } from "./installation-sign-in.js";
import { AppWebCloudCopyHost } from "./cloud-copy-host.js";
import { AppCollectionDeleteError, collectionDeleteError } from "./collection-delete.js";
import { webSignInProblem, type AppWebSignInProblemDetail } from "./web-sign-in-problem.js";
import { appBrowserDirectAccess, type AppBrowserDirectAccessOptions, type AppBrowserDirectAccessSnapshot } from "./browser-direct-access.js";
import { AppCloudCopyBootstrapError, type AppBundledReleaseTrust } from "./cloud-copy-bootstrap.js";
import { selectAppEnvironment } from "./app-environment.js";
import { acquireAppInstallationLease, acquireAppReplicaLease, type AppInstallationCustodyAuthority, type AppReplicaLease, type AppReplicaScope } from "./owner.js";
import { eraseAppInstallationData, eraseAppCollectionAccess } from "./sign-out-erase.js";
import type { AppLogHealth } from "./log-pump.js";
import { mdbaseError } from "../errors.js";

export interface AppWebCollectionConnection<Connection> {
  /** Actual native/current setup assessment, not discovery or enrollment. */
  readonly state: "ready" | "setup_required";
  readonly connection: Connection;
  /** The live collection's latest specific server refusal (migrating, moved,
   * suspended), or null. The connection stays usable for local work. */
  readonly problem?: AppServerProblem | null;
  /** Typed health of the path to the log (offline, server busy, rate limited,
   * auth, unreachable) from the latest failed call, or null. Display only. */
  readonly health?: AppLogHealth | null;
  /** False while other devices' changes are not arriving live (no push socket):
   * they appear on the next focus, visibility or reconnect. Null when unknown. */
  readonly live?: boolean | null;
  /** Access ended on the log: `forbidden` (removed from the collection, or this
   * device removed by policy), `revoked` (this device's sign-in revoked) or
   * `gone` (collection deleted). Terminal for this collection. */
  readonly ended?: "forbidden" | "revoked" | "gone" | null;
  /** Close adapter resources. The session retains the collection lease until
   * both this adapter and the original native host have stopped. */
  close(): Promise<void>;
  /** Optional same-owner semantic assessment push. Required result ABI remains
   * state/connection/close; stale/closed adapter notifications are ignored. */
  subscribe?(listener: () => void): () => void;
}
export interface AppWebSignInPortal {
  /** SDK-private SAME-page companion. Neither keys nor pairing bearer cross it. */
  readonly nativeAuthorization?: AppNativeAuthorizationPort;
  navigate(uri: string): void;
  close(): void;
  /** Optional: true once the approval window is gone (the person closed it),
   * read like `Window.closed`; a getter is fine. While a held window reports
   * closed, the session reads the receipt once more, then stops waiting:
   * signed_out with "approval_window_closed". */
  readonly closed?: boolean;
}
export interface AppWebSignInSessionOptions<Connection> extends Omit<AppInstallationSignInOptions, "mode" | "environmentSelection" | "environment"> {
  readonly environment: "lab" | "staging" | "production" | "local";
  readonly release: AppBundledReleaseTrust;
  loadRuntime(options: {signal: AbortSignal}): Promise<Uint8Array>;
  /** Reserve a first-party Connect popup/tab synchronously in the UI gesture.
   * The UI may retain window.opener so the Connect popup can close itself.
   * navigate gets only an SDK-validated public verification URI, never a secret.
   * Worker consumers proxy navigation to that UI-owned tab, not window.open after
   * asynchronous device/network work, which browsers can block. */
  openPortal(): AppWebSignInPortal;
  /** Configured native collection/SQL/setup adapter, shared by apps. Discovery
   * metadata is never itself a proof that a collection is readable or set up. */
  openCollection(options: {
    host: AppWebCloudCopyHost;
    installation: AppInstallationCustodyAuthority;
    scope: Readonly<AppReplicaScope>;
    collection: AppInstallationCollection;
    /** Only a freshly consumed CP receipt can permit automatic new setup.
     * Restored or merely discovered collections always need explicit setup. */
    setupPolicy: "approved-new-collection" | "explicit";
    onProgress?: (progress: import("./opening-progress.js").AppOpeningProgress) => void;
    signal: AbortSignal;
  }): Promise<AppWebCollectionConnection<Connection>>;
  /** "only" (default) opens a sole approved collection and a fresh portal pick.
   * "never" leaves every open to the owner: a fresh pick stays visible as
   * signIn.collectionSelection, so an owner whose collection handoff needs its
   * own request slot (the SDK application Worker) opens it explicitly. */
  readonly autoSelect?: "only" | "never";
  /** App-scoped IndexedDB databases the collection adapter uses (join ledger,
   * setup journal). signOut deletes them with the installation's own stores. */
  readonly localDatabases?: readonly string[];
  /** SDK scoped actor composition: restore never creates a missing child
   * ledger, while a freshly allocated reference creates only an absent slot. */
  readonly storeMode?: "fresh" | "existing" | "open";
}
/** How the last signOut ended. A diagnostic, never a blocking problem. */
export interface AppWebSignOutResult {
  /** `incomplete`: the server sign-out failed (offline, 5xx, refused). This
   * device is signed out anyway; the device stays listed under the account
   * until it is removed there. `not_paired`: there was no server session. */
  readonly server: "revoked" | "already_signed_out" | "not_paired" | "incomplete";
  /** `incomplete`: some local store could not be removed (in use, refused). */
  readonly local: "erased" | "incomplete";
  /** Page-side Private grants, wiped by the application entry on sign-out:
   * `incomplete` means a grant (its keys and refresh token) may still be in
   * this browser — tell the person some local data could not be removed.
   * Absent when no entry ran the wipe. Also reflected in `local`. */
  readonly grants?: "erased" | "incomplete";
  /** The installation had a Web Push channel: the app's push subscription
   * should be removed by the page (Workers cannot reach it reliably). */
  readonly webPush: boolean;
}
export interface AppWebSignInSnapshot {
  /** Content-free display only; never a readiness or retry certificate. */
  readonly openingProgress?: import("./opening-progress.js").AppOpeningProgress | null;
  readonly status: "not_started" | "starting" | "signed_out" | "authorizing" | "unselected" | "opening" | "setup_required" | "ready" | "blocked" | "closed";
  readonly signIn: AppInstallationSignInView | null;
  readonly collections: readonly AppInstallationCollection[];
  readonly selectedCollectionId: string | null;
  /** Known terminal scope removals, never inferred from a locally hidden row. */
  readonly removedScopeIds?: readonly string[];
  /** Original protected account display label for scoped recovery. Never an
   * account identifier, credential, consent or namespace input. */
  readonly recoveryAccountLabel?: string;
  /** Stable error code only: never log a response, bearer, proof or key. */
  readonly problem: string | null;
  /** The open collection's sync transport health (offline, server busy, ...),
   * or null. Display only; local work continues. */
  readonly transport?: AppLogHealth | null;
  /** False while live updates from other devices are paused; null when unknown. */
  readonly live?: boolean | null;
  /** Optional allowlisted name/code of the original rejection. No message,
   * stack, response, cause, identifiers or custody fields. Not retry authority. */
  readonly problemDetail?: AppWebSignInProblemDetail;
  /** The latest at-the-moment-of-use file access request and its outcome. */
  readonly fileAccess?: Readonly<{requestId: string; collectionId: string; actions: readonly AppFileAction[]; state: "pending" | "granted" | "declined" | "expired"}>;
  /** SDK-6: set when the last approval window was closed before Connect
   * answered; cleared when the next authorization starts. */
  /** How the latest approval window ended without approval: closed by the
   * person, or (signed in, adding collections) denied or expired in Connect. */
  readonly approval?: Readonly<{outcome: "closed" | "cancelled"}> | null;
  /** Set by signOut (UX-011); cleared when the session starts again. */
  readonly signOutResult?: AppWebSignOutResult | null;
  /** Click-to-native/session screen, not a browser paint measurement. */
  readonly timing: Readonly<{firstScreenMs: number | null; readyMs: number | null}> | null;
}
/** One collection the session holds open (or tried to open): what a page
 * showing that collection shows while the sign-in itself is settled. */
export interface AppWebCollectionView {
  readonly openingProgress?: import("./opening-progress.js").AppOpeningProgress | null;
  readonly status: "unselected" | "opening" | "setup_required" | "ready" | "blocked";
  readonly problem: string | null;
  readonly problemDetail?: AppWebSignInProblemDetail;
  readonly transport: AppLogHealth | null;
  readonly live: boolean | null;
}
/** The adapter, native host, lease and view of one open collection. */
interface CollectionSlot<Connection> {
  readonly id: string;
  host: AppWebCloudCopyHost | null;
  lease: AppReplicaLease | null;
  leaseScope: Readonly<AppReplicaScope> | null;
  selected: AppWebCollectionConnection<Connection> | null;
  scope: Readonly<AppReplicaScope> | null;
  lifetime: AbortController | null;
  usable: boolean;
  stopAssessment: (() => void) | null;
  /** Server-directed reopen (collection_migrating). */
  timer: ReturnType<typeof setTimeout> | null;
  view: AppWebCollectionView;
}
const closedView: AppWebCollectionView = Object.freeze({status: "unselected", problem: null, transport: null, live: null});
const failure = (reason: AppInstallationSignInError["reason"]) => new AppInstallationSignInError(reason);
const liveOutcomes = new Set(["collection_not_yet_migrated", "collection_migrating", "account_suspended", "update_required"]);
// Private one-shot READ intent, never a queue for mutations or another flow.
type ReceiptRead = Readonly<{
  flow: AppProtectedInstallationSignIn;
  caller: AbortSignal;
  operation: Promise<unknown>;
  generation: string;
  installation: AppInstallationCustodyAuthority | null;
  attested: boolean;
  acknowledged: boolean;
}>;

export class AppWebSignInSession<Connection> {
  private readonly lifetime = new AbortController();
  // Origin store closes only AFTER native shutdown, not on the host abort.
  // Replaced by signOut, so Sign in works again in the same session.
  private flowLifetime = new AbortController();
  private readonly options: Readonly<AppWebSignInSessionOptions<Connection>>;
  private readonly listeners = new Set<() => void>();
  private flow: AppProtectedInstallationSignIn | null = null;
  private host: AppWebCloudCopyHost | null = null;
  private installation: AppInstallationCustodyAuthority | null = null;
  private installationLease: AppReplicaLease | null = null;
  /** Every collection this session holds open (or failed to open). Pages of
   * the app may each show a different one; `focus` is the one `getSnapshot`
   * shows (the last `select`). Each has its own native host and lease. */
  private readonly slots = new Map<string, CollectionSlot<Connection>>();
  private focus: string | null = null;
  /** The slot the current operation is opening, for its failure handling. */
  private openingSlot: CollectionSlot<Connection> | null = null;
  private readonly abortCollections = () => { for (const slot of this.slots.values()) slot.lifetime?.abort(); };
  /** Sign-in state shared by every collection; `selectedCollectionId` stays null. */
  private base: AppWebSignInSnapshot = Object.freeze({status: "not_started", signIn: null, collections: Object.freeze([]), selectedCollectionId: null, problem: null, timing: null});
  private snapshotValue: AppWebSignInSnapshot = this.base;
  private authorizationStartedAt: number | null = null;
  private authorizationRetryAt = 0;
  private authorizationRateLimit: AppInstallationSignInError | null = null;
  private pending: Promise<unknown> | null = null;
  /** The background approval poll currently occupying `pending`, if any. */
  private polling: Promise<unknown> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closing: Promise<void> | null = null;
  private foreground = true;
  private receiptRead: ReceiptRead | null = null;
  private foregroundRead: ReceiptRead | null = null;
  private attested = false;
  private acknowledged = false;
  private consentPending = false;
  private fileAccess: AppInstallationFileAccessRequest | null = null;
  private freshApproval = false;
  /** The window this session's approval (or file access request) is shown in. */
  private approvalWindow: AppWebSignInPortal | null = null;
  private nativePending: {context:AppNativeAuthorizationContext;port:AppNativeAuthorizationPort;life:AbortController;prepared:AppNativePreparation|null;failed:boolean;attempted:boolean}|null = null;
  private readonly forgotten = new Set<string>();
  private readonly removedScopes = new Set<string>();
  private readonly onAbort = () => { void this.close().catch(() => {}); };

  constructor(options: AppWebSignInSessionOptions<Connection>) {
    this.options = Object.freeze({...options});
    // Validate the authenticated environment before touching storage or HTTP.
    selectAppEnvironment({environment: options.environment, appOrigin: options.origin, release: options.release});
    options.signal.addEventListener("abort", this.onAbort, {once: true});
    this.lifetime.signal.addEventListener("abort", this.abortCollections, {once: true});
  }
  getSnapshot(): AppWebSignInSnapshot { return this.snapshotValue; }
  snapshot(): AppWebSignInSnapshot { return this.getSnapshot(); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  /** The snapshot a page showing `collectionId` (null: none) sees: the shared
   * sign-in state, with that collection's status while sign-in is settled. */
  viewFor(collectionId: string | null, options: {readonly bystander?: boolean} = {}): AppWebSignInSnapshot {
    // `bystander`: the page did not start the approval in progress. Adding a
    // collection keeps the open ones open, so its page keeps showing its own.
    if (options.bystander && this.base.status === "authorizing" && this.consentPending && collectionId !== null && this.slots.has(collectionId))
      return this.compose(collectionId, true);
    if (collectionId === this.focus) return this.snapshotValue;
    return this.compose(collectionId);
  }
  /** The open collection's own view, or null when this session does not hold it. */
  collectionView(collectionId: string): AppWebCollectionView | null { return this.slots.get(collectionId)?.view ?? null; }
  /** Collections this session holds (open, opening or failed to open). */
  heldCollections(): string[] { return [...this.slots.keys()]; }
  private compose(collectionId: string | null, settled = false): AppWebSignInSnapshot {
    const base = this.base, slot = collectionId === null ? undefined : this.slots.get(collectionId);
    if (!slot) return base;
    if (base.status !== "unselected" && !settled) return Object.freeze({...base, selectedCollectionId: slot.id, transport: slot.view.transport, live: slot.view.live});
    const {problemDetail: _shared, ...shared} = base, {problemDetail, ...view} = slot.view;
    return Object.freeze({...shared, ...(settled ? {status: "unselected" as const, problem: null, approval: null} : {}), ...view, selectedCollectionId: slot.id, ...(problemDetail ? {problemDetail} : {})});
  }
  /** The connection of an open collection (default: the focused one). Null
   * while the sign-in is not settled (signing in, blocked) or it is not open. */
  connection(collectionId: string | null = this.focus): Connection | null {
    const slot = collectionId === null ? undefined : this.slots.get(collectionId);
    const settled = this.base.status === "unselected" || (this.base.status === "authorizing" && this.consentPending);
    if (!slot || this.closing || this.options.signal.aborted || !slot.usable || slot.lifetime?.signal.aborted || !this.installation?.isCurrent() || !settled
      || !["ready", "setup_required"].includes(slot.view.status) || !this.sameScope(slot.scope, slot.leaseScope) || slot.scope?.collection !== slot.id) return null;
    return slot.selected?.connection ?? null;
  }
  private sameScope(a: Readonly<AppReplicaScope> | null, b: Readonly<AppReplicaScope> | null): boolean {
    return a !== null && b !== null && a.account === b.account && a.installation === b.installation && a.collection === b.collection
      && a.account === this.installation?.scope.account && a.installation === this.installation?.scope.installation;
  }
  readonly directAccess = appBrowserDirectAccess;
  checkDirectAccess(options?: AppBrowserDirectAccessOptions): Promise<AppBrowserDirectAccessSnapshot> {
    this.check(); return this.directAccess.check(options);
  }
  requestDirectAccess(options?: AppBrowserDirectAccessOptions): Promise<AppBrowserDirectAccessSnapshot> {
    this.check(); return this.directAccess.request(options);
  }
  private check(): void { if (this.closing || this.options.signal.aborted || this.lifetime.signal.aborted) throw failure("fenced"); }
  /** Shared sign-in state (never a collection's status; see publishSlot). */
  private publish(update: Partial<AppWebSignInSnapshot>): void {
    this.check(); this.setBase(update); this.changed();
  }
  private setBase(update: Partial<AppWebSignInSnapshot>): void {
    const {problemDetail: previousDetail, ...previous} = this.base;
    const detail = update.problem === null ? undefined : update.problemDetail ?? previousDetail;
    this.base = Object.freeze({...previous, ...update, selectedCollectionId: null, signIn: this.flow?.view() ?? null, ...(detail ? {problemDetail: detail} : {})});
  }
  /** One open collection's status, problem and transport. */
  private publishSlot(slot: CollectionSlot<Connection>, update: Partial<AppWebCollectionView>): void {
    this.check();
    if (this.slots.get(slot.id) !== slot) return;
    let timing = this.base.timing;
    if (this.authorizationStartedAt !== null && (update.status === "ready" || update.status === "setup_required")) {
      const elapsed = Math.max(0, performance.now() - this.authorizationStartedAt);
      timing = Object.freeze({firstScreenMs: timing?.firstScreenMs ?? elapsed, readyMs: update.status === "ready" ? timing?.readyMs ?? elapsed : timing?.readyMs ?? null});
    }
    this.setBase({timing});
    const {problemDetail: previousDetail, ...previous} = slot.view;
    const detail = update.problem === null ? undefined : update.problemDetail ?? previousDetail;
    const openingProgress = (update.status ?? previous.status) === "opening" ? ("openingProgress" in update ? update.openingProgress ?? null : previous.openingProgress ?? null) : null;
    slot.view = Object.freeze({...previous, ...update, openingProgress, ...(detail ? {problemDetail: detail} : {})});
    this.changed();
  }
  private changed(): void {
    this.snapshotValue = this.compose(this.focus);
    for (const listener of [...this.listeners]) { try { listener(); } catch { /* subscriber cannot interrupt durable lifecycle */ } }
  }
  /** Background approval read; a sign-in gesture may wait for it (authorize). */
  private poll(work: () => Promise<unknown>): void {
    if (this.pending) return;
    void this.operation(work).catch(() => {});
    this.polling = this.pending;
  }
  private stopPolling(): void { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
  /** `contained`: a failure rejects the caller only; the session stays as it was. */
  private operation<T>(work: () => Promise<T>, contained = false): Promise<T> {
    this.check(); if (this.pending) return Promise.reject(failure("busy"));
    this.foregroundRead = null;
    this.stopPolling();
    const workResult = Promise.resolve().then(() => { this.check(); return work(); });
    // Keep cleanup in the original occupied operation. close() must await it,
    // not race a second native/SQL/lease stop against a rejected work promise.
    const pending = workResult.catch(async error => {
      if (!contained && !this.closing && !this.options.signal.aborted) {
        const {problem, detail} = webSignInProblem(error);
        if (problem === "open_failed") {
          try { console.error("mdbase web sign-in open failed", detail.name, detail.code); }
          catch { /* Diagnostics must never replace the original failure. */ }
        }
        // A failed open blocks that collection only; other pages keep theirs.
        const slot = this.openingSlot; this.openingSlot = null;
        if (slot && this.slots.get(slot.id) === slot) {
          let retryableChallenge = false;
          try {retryableChallenge = error instanceof AppCloudCopyBootstrapError && error.reason === "unavailable" && error.retryable === true &&
            slot.view.status === "opening" && this.base.collections.some(c => c.collectionId === slot.id) &&
            this.flow?.view().state === "paired" && this.installation?.isCurrent() === true;} catch { /* no inferred retry authority */ }
          if (retryableChallenge) {
            try { await this.closeSlot(slot); this.check(); }
            catch (stopError) {
              if (!this.closing && !this.options.signal.aborted) this.publishSlot(slot, {status:"blocked",problem:"recovery_required",problemDetail:webSignInProblem(stopError).detail});
              throw stopError; // failed stop keeps original scope/leases quarantined
            }
            this.publishSlot(slot, {status:"unselected",problem,problemDetail:detail});
          } else this.publishSlot(slot, {status: "blocked", problem, problemDetail: detail});
        } else this.publish({status: "blocked", problem, problemDetail: detail});
      }
      throw error;
    });
    this.pending = pending;
    return pending.finally(() => { if (this.pending === pending) this.pending = null; this.schedulePoll(); });
  }
  /** Atomic create-or-restore; never recover a malformed ledger as fresh. A
   * completed installation restores locally. No Connect request before the
   * sign-in gesture; a pending ledger keeps its SAME request for authorize(). */
  start(): Promise<AppWebSignInSnapshot> {
    return this.operation(async () => {
      if (this.flow) return this.getSnapshot();
      this.publish({status: "starting", problem: null, signOutResult: null});
      const p = this.options;
      this.flow = await AppProtectedInstallationSignIn.open({...p, mode: p.storeMode ?? "open", signal: this.flowLifetime.signal,
        environmentSelection: selectAppEnvironment({environment: p.environment, appOrigin: p.origin, release: p.release})});
      this.check();
      // Local ledger only: the pairing request is created by the sign-in
      // gesture (authorize), never by a page load.
      const view = this.flow.view();
      if (view.state === "paired") {
        if(this.flow.pendingNativeSelection?.() && !view.nativeSelection)throw failure("recovery_required");
        // Restored scoped actors load only their OWN protected metadata here.
        // Their ordinary native receipt/ACK/custody opens when selected; never
        // initialize one native engine per restored recovery reference.
        await this.openDevice(false, this.options.recoveryFor !== undefined);
        if (this.flow.collectionConsentView()?.state === "pending") {
          this.consentPending = true; this.publish({status: "authorizing"});
        } else await this.refreshCollections();
      } else this.publish({status: view.state === "pending" ? "signed_out" : "authorizing"});
      return this.getSnapshot();
    });
  }
  /** Call from the app's single sign-in user gesture after start(). No manual
   * exchange, confirmation or attestation controls are needed by consumers. */
  authorize(options: {readonly collectionHint?: string | null} = {}): Promise<AppWebSignInSnapshot> {
    this.check();
    if (this.authorizationRateLimit && Date.now() < this.authorizationRetryAt) return Promise.reject(this.authorizationRateLimit);
    const poll = this.pending !== null && this.pending === this.polling ? this.pending : null;
    if (!this.flow || (this.pending && !poll)) return Promise.reject(failure("busy"));
    const portal = this.options.openPortal();
    if (!poll) return this.beginAuthorization(portal, options);
    // A background approval poll holds the session: let it settle, then use
    // this gesture's window. Only a session still waiting for approval restarts.
    return poll.catch(() => {}).then(() => {
      try { this.check(); } catch (error) { portal.close(); throw error; }
      if (this.pending) { portal.close(); throw failure("busy"); }
      const status = this.base.status;
      if (status !== "authorizing" && status !== "signed_out") { portal.close(); return this.getSnapshot(); }
      return this.beginAuthorization(portal, options);
    });
  }
  private beginAuthorization(portal: AppWebSignInPortal, options: {readonly collectionHint?: string | null}): Promise<AppWebSignInSnapshot> {
    const hint = {collectionHint: options.collectionHint ?? null};
    const view = this.flow!.view();
    this.authorizationStartedAt = performance.now();
    this.publish({timing: Object.freeze({firstScreenMs: null, readyMs: null}), approval: null});
    return this.operation(async () => {
      try {
        if (view.state === "paired") {
          if(this.flow!.pendingNativeSelection?.() && !view.nativeSelection)throw failure("recovery_required");
          await this.openDevice(); this.check();
          const consent = await this.flow!.startCollectionConsent(this.installation!, this.options.requestedCreateCollections ?? this.options.freshRequestedCreateCollections ?? false, hint); this.check();
          this.consentPending = true; portal.navigate(consent.verificationUri);
        } else {
          const started = await this.flow!.start(hint).catch(error => this.renewFromGesture(error)); this.check(); portal.navigate(started.verificationUri);
        }
        this.holdApprovalWindow(portal);
        this.publish({status: "authorizing", problem: null});
        await this.advance(); return this.getSnapshot();
      } catch (error) {
        if (error instanceof AppInstallationSignInError && error.server?.status === 429) {
          this.authorizationRateLimit = error;
          this.authorizationRetryAt = Date.now() + Math.min(MAX_SERVER_RETRY_MS, Math.max(MIN_SERVER_RETRY_MS, error.server.retryAfterMs ?? 30_000));
        }
        portal.close(); throw error;
      }
    });
  }
  /** From the app's user gesture: ask for declared optional file actions on an
   * approved collection. The open collection stays open; the outcome arrives
   * through pollFileAccess. A refusal leaves the session unchanged. */
  requestFileAccess(collectionId: string, actions: readonly AppFileAction[], reason: string): Promise<AppWebSignInSnapshot> {
    this.check(); if (!this.flow || this.pending) return Promise.reject(failure("busy"));
    const portal = this.options.openPortal();
    return this.operation(async () => {
      try {
        if (this.flow!.view().state !== "paired" || !this.installation || !this.base.collections.some(c => c.collectionId === collectionId)) throw failure("refused");
        const request = await this.flow!.startFileAccess(this.installation, collectionId, actions, reason); this.check();
        this.fileAccess = request; portal.navigate(request.verificationUri); this.holdApprovalWindow(portal);
        this.publish({fileAccess: Object.freeze({requestId: request.requestId, collectionId, actions: request.actions, state: "pending"})});
        return this.getSnapshot();
      } catch (error) { portal.close(); throw error; }
    }, true);
  }
  /** One read of the current file access request. Lost reads stay pending
   * until the request expires; a busy session answers with the current view. */
  pollFileAccess(requestId: string): Promise<AppWebSignInSnapshot> {
    const request = this.fileAccess;
    if (!request || request.requestId !== requestId || this.pending || !this.flow || !this.installation) return Promise.resolve(this.getSnapshot());
    return this.operation(async () => {
      let outcome: AppInstallationFileAccessOutcome = {state: "pending"};
      try { outcome = await this.flow!.exchangeFileAccess(this.installation!, request); } catch { /* still pending until it expires */ }
      this.check();
      if (this.fileAccess !== request || (outcome.state === "pending" && Date.now() < request.expiresAt)) return this.getSnapshot();
      this.fileAccess = null; this.closeApprovalWindow();
      const granted = outcome.state === "granted" ? outcome.actions : null;
      const collections = granted ? Object.freeze(this.base.collections.map(c => c.collectionId !== request.collectionId ? c
        : Object.freeze({...c, fileActions: Object.freeze([...new Set([...(c.fileActions ?? []), ...granted])])}))) : this.base.collections;
      this.publish({collections, fileAccess: Object.freeze({requestId, collectionId: request.collectionId, actions: granted ?? request.actions, state: outcome.state === "pending" ? "expired" : outcome.state})});
      return this.getSnapshot();
    }, true);
  }
  /** This sign-in gesture renews a window that expired or was cancelled in the
   * portal. The flow decides renewability; otherwise the original error stands. */
  private async renewFromGesture(error: unknown): Promise<AppInstallationSignInView> {
    if (!(error instanceof AppInstallationSignInError) || (error.reason !== "expired" && error.reason !== "refused")) throw error;
    try { return await this.flow!.renewExpiredPairing(); }
    catch (renewal) { throw renewal instanceof AppInstallationSignInError && renewal.reason === "recovery_required" ? error : renewal; }
  }
  /** A typed expired window renews only from an explicit user gesture. Unknown
   * HTTP outcomes never cause automatic renewal, new keys or another actor. */
  renewExpiredPairing(): Promise<AppWebSignInSnapshot> {
    return this.operation(async () => {
      if (!this.flow) throw failure("binding");
      await this.flow.renewExpiredPairing(); this.check();
      this.publish({status: "signed_out", problem: null}); return this.getSnapshot();
    });
  }
  /** Only SAME-secret receipt reads may retry transient HTTP loss. START,
   * native attestation, custody and unknown mutations never use this path. */
  private receiptGeneration(flow: AppProtectedInstallationSignIn): string | null {
    try {
      if (!flow.isCurrent()) return null;
      const view = flow.view(), consent = this.consentPending ? flow.collectionConsentView() : null;
      if (this.consentPending ? consent?.state !== "pending" : !["pending", "awaiting_approval"].includes(view.state)) return null;
      return JSON.stringify([view.requestId, view.installationId, view.deviceId, view.accountId, view.state,
        this.consentPending, consent?.requestId, consent?.state]);
    } catch { return null; } // Optional latency shortcut cannot replace a rejection.
  }
  private currentReceipt(read: ReceiptRead): boolean {
    try {
      return !this.closing && !this.lifetime.signal.aborted && !this.flowLifetime.signal.aborted && !read.caller.aborted &&
        this.options.signal === read.caller && this.flow === read.flow && this.installation === read.installation &&
        (read.installation === null || read.installation.isCurrent() === true) &&
        this.attested === read.attested && this.acknowledged === read.acknowledged &&
        this.receiptGeneration(read.flow) === read.generation;
    } catch { return false; }
  }
  private async exchangeReceipt<T>(read: () => Promise<T>): Promise<T | null> {
    const flow = this.flow, operation = this.pending, generation = flow ? this.receiptGeneration(flow) : null;
    const slot: ReceiptRead | null = flow && operation && generation !== null ? Object.freeze({
      flow, operation, generation, caller: this.options.signal, installation: this.installation,
      attested: this.attested, acknowledged: this.acknowledged,
    }) : null;
    this.receiptRead = slot;
    let completed = false;
    try { const value = await read(); completed = value !== null && value !== undefined; return value; }
    catch (error) {
      if (error instanceof AppInstallationSignInError && error.reason === "outcome_unknown" && this.flow?.isCurrent()) {
        this.publish({status: "authorizing", problem: "outcome_unknown"}); return null;
      }
      throw error;
    } finally {
      if (this.receiptRead === slot) this.receiptRead = null;
      if (this.foregroundRead === slot && (!completed || !slot || !this.currentReceipt(slot))) this.foregroundRead = null;
    }
  }
  private async advance(): Promise<void> {
    if (this.consentPending) {
      let consent: Awaited<ReturnType<AppProtectedInstallationSignIn["exchangeCollectionConsent"]>> | null;
      try { consent = await this.exchangeReceipt(() => this.flow!.exchangeCollectionConsent(this.installation!)); }
      catch (error) {
        // Already signed in: a re-consent denied or expired in Connect is a
        // cancellation, never a blocked sign-in. Back to the collections view.
        if (!(error instanceof AppInstallationSignInError) || (error.reason !== "refused" && error.reason !== "expired")) throw error;
        // Leave "authorizing" in the same publication that ends the consent:
        // pages that did not start it never see a sign-in for their collection.
        this.check(); this.consentPending = false; this.closeApprovalWindow();
        this.publish({status: "unselected", problem: null, approval: Object.freeze({outcome: "cancelled" as const})}); await this.refreshCollections(); return;
      }
      this.check();
      if (!consent) return;
      if (consent.state === "scope_updated") {
        if (consent.accountSelectionConfirmed !== true) throw failure("account_confirmation_required");
        const native=this.flow!.pendingNativeSelection?.();
        if(native?.requestId===consent.requestId)await this.finishNativeChoice(native);
        else if (this.flow!.view().collectionSelection?.requestId !== consent.requestId) throw failure("response");
        this.consentPending = false; this.freshApproval = true; this.closeApprovalWindow();
        await this.refreshCollections();
      } else { await this.prepareNativeChoice(); this.publish({status: "authorizing", problem: null}); }
      return;
    }
    let view = await this.exchangeReceipt(() => this.flow!.exchange()); this.check();
    if (!view) return;
    if (view.state === "account_selected") {
      // This consumes only the current SDK-owned, portal-confirmed selection.
      // A view/account ID supplied by an app is not an authority capability.
      view = await this.flow!.confirmPortalSelectedAccount(); this.check();
    }
    if (view.state === "account_confirmed" || view.state === "awaiting_approval") {
      await this.openDevice(); this.check();
      if (!this.attested) { await this.host!.attestInstallation(); this.check(); this.attested = true; }
      await this.prepareNativeChoice();
    }
    if (view.state === "paired") {
      const native=this.flow!.pendingNativeSelection?.();
      if(native?.requestId===view.requestId)await this.finishNativeChoice(native);
      else if (view.collectionSelection?.requestId !== view.requestId) throw failure("response");
      this.freshApproval = true; this.closeApprovalWindow();
      await this.openDevice(); this.check(); await this.refreshCollections();
    } else this.publish({status: "authorizing", problem: null});
  }
  /** Preparation is optional and never blocks a genuine Hosted approval. Only
   * the original lifecycle turn attaches after observing its matching context. */
  private async prepareNativeChoice(): Promise<void> {
    const port=this.approvalWindow?.nativeAuthorization;
    if(!port || !this.installation)return;
    const context=this.flow!.nativeAuthorizationContext(this.installation);
    if(!context)return;
    let slot=this.nativePending;
    if(!slot){
      slot={context,port,life:new AbortController(),prepared:null,failed:false,attempted:false};this.nativePending=slot;
      if(context.authorizationId){slot.failed=true;return;} // lost original keys: never regenerate
      const original=slot;
      const signal=AbortSignal.any([this.lifetime.signal,this.flowLifetime.signal,slot.life.signal]);
      void port.prepare(context,signal).then(prepared=>{
        if(this.nativePending!==original || signal.aborted)return;
        original.prepared=Object.freeze({...prepared});
      },()=>{original.failed=true;});
    }
    if(slot.context.requestId!==context.requestId || slot.context.accountId!==context.accountId || slot.context.challenge!==context.challenge)throw failure("fenced");
    if(slot.prepared && !slot.attempted){
      slot.attempted=true;
      try{await this.flow!.attachNativeAuthorization(this.installation,slot.context,slot.prepared);this.check();}
      catch{slot.failed=true;} // closed Hosted parent/unknown: actual receipt decides; never replay
    }
  }
  private async finishNativeChoice(selection: import("./native-sign-in.js").AppNativeSelection): Promise<void> {
    const slot=this.nativePending;
    if(!slot || !slot.prepared || !slot.attempted || slot.context.requestId!==selection.requestId || slot.prepared.authorizationId!==selection.authorizationRequestId)throw failure("recovery_required");
    await this.openDevice();this.check();
    const completion=await slot.port.finish(selection,AbortSignal.any([this.lifetime.signal,this.flowLifetime.signal,slot.life.signal]));this.check();
    if(this.nativePending!==slot || !this.acknowledged || !this.installation)throw failure("fenced");
    await this.flow!.completeNativeAuthorization(this.installation,completion);this.check();
  }
  private holdApprovalWindow(portal: AppWebSignInPortal): void {
    if (this.approvalWindow !== portal) this.closeApprovalWindow();
    this.approvalWindow = portal;
  }
  /** Approval observed: the opener closes the approval window (the Connect page
   * cannot be relied on to close itself); the window adapter refocuses the app. */
  private closeApprovalWindow(): void {
    const portal = this.approvalWindow; this.approvalWindow = null;
    const native=this.nativePending;this.nativePending=null;native?.life.abort();
    try{native?.port.cancel();}catch{/* cancellation cannot replace the original custody drain */}
    if (!portal) return;
    try { portal.close(); } catch { /* already closed by the person */ }
  }
  /** The installation's device: a native host for sign-in work, and one per
   * open collection (`forCollection`). An acknowledged installation whose
   * collections already hold hosts needs no spare one for sign-in. */
  private async openDevice(forCollection = false, metadataOnly = false): Promise<void> {
    if (!this.installation) {
      const selected = this.flow!.confirmedSelection();
      const scope = Object.freeze({account: selected.accountId, installation: selected.installationId});
      this.installationLease = await acquireAppInstallationLease(this.options.locks, scope, this.lifetime.signal); this.check();
      this.installation = Object.freeze({scope, isCurrent: () => !this.closing && !this.options.signal.aborted && !this.lifetime.signal.aborted && this.installationLease !== null});
    }
    if (metadataOnly) return;
    if (!this.host && !forCollection && this.acknowledged && this.flow!.view().state === "paired" && [...this.slots.values()].some(slot => slot.host !== null)) return;
    if (!this.host) {
      this.host = await AppWebCloudCopyHost.openInstallationDevice({signIn: this.flow!, installation: this.installation,
        release: this.options.release, origin: this.options.origin, signal: this.lifetime.signal,
        loadRuntime: this.options.loadRuntime,
        allowLoopbackHttp: selectAppEnvironment({environment: this.options.environment, appOrigin: this.options.origin, release: this.options.release}).allowLoopbackHttp}); this.check();
      this.acknowledged = this.flow!.view().state === "paired";
    } else if (!this.acknowledged && this.flow!.view().state === "paired") {
      await this.host.completeInstallationSignIn(); this.check(); this.acknowledged = true;
    }
  }
  private async refreshCollections(): Promise<void> {
    const collections = await this.flow!.listApprovedCollections(this.installation!); this.check();
    for (const id of this.flow!.view().collectionIds) if (!collections.some(c => c.collectionId === id)) this.removedScopes.add(id);
    const visible = Object.freeze(collections.filter(c => !this.forgotten.has(c.collectionId)));
    // Re-approval of a still-approved open collection keeps it open; the
    // same-scope adapter/lease and connection stay current.
    // A collection no longer approved reads unselected (its page offers approval).
    for (const slot of this.slots.values()) {
      if (slot.usable && slot.selected && !visible.some(c => c.collectionId === slot.id)) {
        slot.usable = false; slot.lifetime?.abort();
        await this.closeSlot(slot); this.check(); this.deleteSlot(slot);
        continue;
      }
      const open = slot.usable && slot.selected !== null && visible.some(c => c.collectionId === slot.id);
      const {problemDetail: _stale, ...view} = slot.view;
      slot.view = Object.freeze({...view, status: open ? slot.selected!.state : "unselected", problem: null});
    }
    this.publish({status: "unselected", collections: visible, problem: null});
    const picked = this.flow!.view().collectionSelection?.selectedCollectionId;
    if ((this.options.autoSelect ?? "only") !== "only") return;
    if (this.freshApproval && picked && visible.some(c => c.collectionId === picked)) await this.openSlot(picked, true);
    else if (visible.length === 1) await this.openSlot(visible[0]!.collectionId, true);
  }
  private schedulePoll(): void {
    if (this.pending && !this.closing && !this.options.signal.aborted) return; // Keep ONE original occupied slot.
    const read = this.foregroundRead; this.foregroundRead = null;
    for (const slot of this.closing || this.options.signal.aborted ? [] : this.slots.values()) {
      const wait = this.retryAfterMs(slot);
      if (wait === null || slot.timer !== null || slot.view.status !== "blocked") continue;
      // Server-directed: the collection is being upgraded. Reopen the SAME
      // collection; the app only shows the description.
      slot.timer = setTimeout(() => {
        slot.timer = null;
        if (this.slots.get(slot.id) !== slot || slot.view.status !== "blocked" || slot.view.problem !== "collection_migrating" || this.flow?.view().state !== "paired") return;
        void this.operation(() => this.openSlot(slot.id)).catch(() => {});
      }, wait);
    }
    if (this.closing || this.options.signal.aborted || this.timer !== null || this.base.status !== "authorizing") return;
    const resume = this.foreground && read && this.currentReceipt(read) ? read : null;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.poll(async () => {
        if (resume && (!this.foreground || !this.currentReceipt(resume))) return;
        await this.advanceApproval();
      });
    }, resume ? 0 : !this.foreground ? 10000 : this.base.problem === "outcome_unknown" ? 5000 : 1000);
  }
  /** Server-directed retry (collection_migrating): clamp 5 s..10 min. */
  private retryAfterMs(slot: CollectionSlot<Connection>): number | null {
    const s = slot.view;
    if (s.problem !== "collection_migrating") return null;
    let retry: number | null = null; try { retry = sanitizeAppServerProblem(s.problemDetail?.server)?.retryAfterMs ?? null; } catch { retry = null; }
    return Math.min(MAX_SERVER_RETRY_MS, Math.max(MIN_SERVER_RETRY_MS, retry ?? 30_000));
  }
  /** Owners forward visibility changes; Workers have no ambient document.
   * This report does not acquire the authenticated inventory operation slot:
   * the owning WorkerHost serializes revalidation with its lifecycle requests. */
  setForeground(active: boolean): void {
    this.check(); const resumed = active && !this.foreground;
    this.foreground = active; this.stopPolling();
    if (!active) this.foregroundRead = null;
    else if (resumed && this.receiptRead?.operation === this.pending) this.foregroundRead = this.receiptRead;
    if (active && this.base.status === "authorizing" && !this.pending) this.poll(() => this.advanceApproval());
    else this.schedulePoll();
    // Visibility is non-blocking. WorkerHost queues authenticated inventory
    // revalidation with start/select; it must not occupy this operation slot here.
  }
  /** Owners forward a report that the held approval window was closed (a
   * Worker's proxy portal reflects it in `closed`). Read now when idle; a busy
   * session reads at its next scheduled poll. */
  approvalWindowClosed(): void {
    this.check();
    if (this.pending || this.base.status !== "authorizing" || !this.approvalWindowGone()) return;
    this.stopPolling(); this.poll(() => this.advanceApproval());
  }
  private approvalWindowGone(): boolean {
    const portal = this.approvalWindow;
    try { return portal?.closed === true; } catch { return false; }
  }
  /** One scheduled approval read. If the held window was already closed, this
   * read is the final one: Connect records an approval before its window
   * closes, so only a still-pending, definite answer ends the wait. */
  private async advanceApproval(): Promise<void> {
    const portal = this.approvalWindowGone() ? this.approvalWindow : null;
    await this.advance(); this.check();
    if (!portal || this.approvalWindow !== portal || this.base.status !== "authorizing") return;
    // Unknown read outcome: keep the window state and read again next poll.
    if (this.base.problem === "outcome_unknown") return;
    this.closeApprovalWindow();
    if (this.consentPending) {
      // Already signed in: a closed add-collection window is a cancellation,
      // not a sign-in problem. Return to the paired collections view.
      this.consentPending = false; this.publish({status: "unselected", problem: null, approval: Object.freeze({outcome: "closed" as const})}); await this.refreshCollections(); return;
    }
    this.publish({status: "signed_out", problem: "approval_window_closed", approval: Object.freeze({outcome: "closed" as const})});
  }
  /** Open `collectionId` as the only open collection (closing any other). */
  select(collectionId: string): Promise<AppWebSignInSnapshot> {
    return this.operation(async () => { await this.openSlot(collectionId, true); return this.getSnapshot(); });
  }
  /** Open `collectionId` beside any other open collection: each page of the
   * app may show its own. Already open: a no-op. Resolves with its view. */
  openCollection(collectionId: string): Promise<AppWebSignInSnapshot> {
    return this.operation(async () => { await this.openSlot(collectionId); return this.viewFor(collectionId); });
  }
  /** Close one open collection (its adapter, native host and lease); the
   * others stay open. Not held: a no-op. */
  releaseCollection(collectionId: string): Promise<AppWebSignInSnapshot> {
    if (!this.slots.has(collectionId)) return Promise.resolve(this.getSnapshot());
    return this.operation(async () => {
      const slot = this.slots.get(collectionId);
      if (slot) { await this.closeSlot(slot); this.check(); this.deleteSlot(slot); this.changed(); }
      return this.getSnapshot();
    });
  }
  private async openSlot(collectionId: string, only = false): Promise<void> {
    this.check();
    const collection = this.base.collections.find(c => c.collectionId === collectionId);
    if (!collection || this.flow?.view().state !== "paired" || !this.installation) throw failure("refused");
    const others = only ? [...this.slots.values()].filter(other => other.id !== collectionId) : [];
    const existing = this.slots.get(collectionId);
    if (existing && existing.usable && existing.selected && !existing.lifetime?.signal.aborted && this.sameScope(existing.scope, existing.leaseScope) && existing.scope?.collection === collectionId) {
      for (const other of others) { other.usable = false; other.lifetime?.abort(); }
      this.focus = collectionId; this.settleBase();
      this.publishSlot(existing, {status: existing.selected.state, problem: null});
      for (const other of others) { await this.closeSlot(other); this.check(); this.deleteSlot(other); this.changed(); }
      return;
    }
    // Quarantine BEFORE publishing a requested target. Snapshot IDs are not the
    // immutable scope of the old adapter/lease, especially after failed shutdown.
    for (const other of others) { other.usable = false; other.lifetime?.abort(); }
    const slot: CollectionSlot<Connection> = existing ?? {id: collectionId, host: null, lease: null, leaseScope: null, selected: null, scope: null, lifetime: null, usable: false, stopAssessment: null, timer: null, view: closedView};
    slot.usable = false; slot.lifetime?.abort();
    this.slots.set(collectionId, slot); this.focus = collectionId; this.openingSlot = slot; this.settleBase();
    this.publishSlot(slot, {status: "opening", problem: null, openingProgress: null});
    for (const other of others) { await this.closeSlot(other); this.check(); this.deleteSlot(other); this.changed(); }
    if (slot.lease || slot.selected || slot.host) await this.closeSlot(slot);
    this.check(); await this.openDevice(true); this.check();
    // The first open collection takes the sign-in's native host; each further
    // one gets its own host on the SAME installation.
    slot.host = this.host!; this.host = null;
    const scope = Object.freeze({...this.installation.scope, collection: collectionId});
    slot.lease = await acquireAppReplicaLease(this.options.locks, scope, this.lifetime.signal); slot.leaseScope = scope; this.check();
    slot.lifetime = new AbortController();
    const newlyCreated = this.freshApproval && this.flow!.view().collectionSelection?.createdCollectionIds.includes(collectionId) === true;
    const lifetime = slot.lifetime;
    const selected = await this.options.openCollection({host: slot.host, installation: this.installation, scope, collection,
      setupPolicy: newlyCreated ? "approved-new-collection" : "explicit", signal: lifetime.signal,
      onProgress: progress => {
        if (this.closing || this.slots.get(slot.id) !== slot || slot.lifetime !== lifetime || lifetime.signal.aborted || slot.view.status !== "opening") return;
        if (slot.view.openingProgress !== progress) this.publishSlot(slot, {openingProgress: progress});
      }});
    slot.selected = selected; slot.scope = scope; this.check();
    if (selected.state !== "ready" && selected.state !== "setup_required") throw failure("response");
    slot.usable = true; if (this.openingSlot === slot) this.openingSlot = null;
    slot.stopAssessment = selected.subscribe?.(() => {
      if (this.closing || this.slots.get(slot.id) !== slot || !slot.usable || slot.selected !== selected || slot.lifetime?.signal.aborted ||
        !this.sameScope(slot.scope, slot.leaseScope) || slot.scope?.collection !== slot.id) return;
      let ended: "forbidden" | "revoked" | "gone" | null = null; try { ended = selected.ended ?? null; } catch { ended = null; }
      if (ended) { this.accessEnded(slot, selected, ended); return; }
      if (selected.state === "ready" || selected.state === "setup_required") this.publishSlot(slot, {status: selected.state, ...this.liveProblem(slot, selected)});
    }) ?? null;
    this.publishSlot(slot, {status: selected.state, transport: null, live: null, openingProgress: null});
  }
  /** Opening a collection settles a blocked sign-in view; it never ends an
   * approval in progress (a page adding a collection keeps waiting for it). */
  private settleBase(): void {
    if (this.base.status === "blocked" || this.base.status === "unselected") this.setBase({status: "unselected", problem: null});
  }
  private deleteSlot(slot: CollectionSlot<Connection>): void {
    if (slot.timer !== null) clearTimeout(slot.timer); slot.timer = null;
    if (this.slots.get(slot.id) === slot) this.slots.delete(slot.id);
    if (this.focus === slot.id) this.focus = null;
    if (this.openingSlot === slot) this.openingSlot = null;
  }
  /** The log ended access to an open collection. Block it at once (no
   * connection is handed out, so every page showing it stops writing), then
   * stop it, which fences every page's data ports. Local data stays here. */
  private accessEnded(slot: CollectionSlot<Connection>, selected: AppWebCollectionConnection<Connection>, reason: "forbidden" | "revoked" | "gone"): void {
    if (slot.selected !== selected || !slot.usable) return;
    const problem = reason === "gone" ? "collection_deleted" : reason === "revoked" ? "unauthenticated" : "access_removed";
    if (reason !== "gone") this.removedScopes.add(slot.id);
    slot.usable = false;
    this.publishSlot(slot, {status: "blocked", problem, transport: null, live: null});
    const stop = (): void => {
      if (this.closing || this.options.signal.aborted || slot.selected !== selected || this.slots.get(slot.id) !== slot) return;
      if (this.pending) { void this.pending.catch(() => {}).then(stop); return; }
      void this.operation(async () => {
        await this.closeSlot(slot); this.publishSlot(slot, {status: "blocked", problem});
        // The server closed the socket because access changed: re-read the
        // approved list so a removed or deleted collection drops out of it.
        // A failed read keeps the current list; the block stays either way.
        if (!this.flow || !this.installation || this.flow.view().state !== "paired") return;
        try {
          const collections = await this.flow.listApprovedCollections(this.installation); this.check();
          this.publish({collections: Object.freeze(collections.filter(c => !this.forgotten.has(c.collectionId)))});
        } catch { /* list refresh is best effort */ }
      }).catch(() => {});
    };
    stop();
  }
  /** Live problem of an open collection: shown while it lasts, cleared after. */
  private liveProblem(slot: CollectionSlot<Connection>, selected: AppWebCollectionConnection<Connection>): Partial<AppWebCollectionView> {
    let server: AppServerProblem | null = null; try { server = selected.problem ?? null; } catch { server = null; }
    let health: AppLogHealth | null = null; try { health = selected.health ?? null; } catch { health = null; }
    const transport = health ? Object.freeze({...health}) : null;
    let live: boolean | null = null; try { const v = selected.live; live = typeof v === "boolean" ? v : null; } catch { live = null; }
    const outcome = isAppServerProblem(server) ? appServerOutcome(server) : null;
    if (outcome && server) return {problem: outcome, problemDetail: Object.freeze({name: "AppHttpLogError", code: outcome, server}), transport, live};
    return {...(liveOutcomes.has(slot.view.problem ?? "") ? {problem: null} : {}), transport, live};
  }
  private async closeSlot(slot: CollectionSlot<Connection>): Promise<void> {
    // Failed adapter/native shutdown keeps the original adapter/scope and leases
    // for fail-stop cleanup, but cannot expose a connection or take a ready shortcut.
    slot.usable = false;
    if (slot.timer !== null) clearTimeout(slot.timer); slot.timer = null;
    const stopAssessment = slot.stopAssessment; slot.stopAssessment = null;
    try {stopAssessment?.();} catch { /* observer must not prevent native/lease cleanup */ }
    slot.lifetime?.abort();
    await slot.selected?.close(); slot.selected = null; slot.scope = null; slot.lifetime = null;
    await slot.host?.close(); slot.host = null;
    await slot.lease?.release(); slot.lease = null; slot.leaseScope = null;
  }
  /** Close every open collection, in order; the first failure stops (quarantined). */
  private async closeSlots(): Promise<void> {
    for (const slot of [...this.slots.values()]) { await this.closeSlot(slot); this.deleteSlot(slot); }
    const host = this.host; this.host = null; await host?.close();
  }
  clearSelection(): Promise<AppWebSignInSnapshot> {
    return this.operation(async () => { await this.closeSlots(); this.focus = null; this.publish({status: "unselected", problem: null}); return this.getSnapshot(); });
  }
  /** SDK-2: re-read the approved collection list (the app is shown or focused
   * again). Only a settled paired session; a busy session answers with the
   * current view. The open collection stays open; a failed read changes nothing. */
  refreshCollectionList(): Promise<AppWebSignInSnapshot> {
    if (this.pending || !this.flow || !this.installation || this.consentPending || this.flow.view().state !== "paired"
      || this.base.status !== "unselected") return Promise.resolve(this.getSnapshot());
    return this.operation(async () => { await this.refreshCollections(); return this.getSnapshot(); }, true);
  }
  /** Accepted COMPLETE inventory omission or terminal native/log refusal only.
   * Local Forget, failed GETs and transient transport failures do not qualify. */
  scopeWasRemoved(collectionId: string): boolean {return this.removedScopes.has(collectionId);}
  removedScopeIds(): readonly string[] {return Object.freeze([...this.removedScopes]);}
  /** Explicit hosted/browser gesture permission, not a diagnostic-code test.
   * No native owner, keys or collection adapter may have started in this slot. */
  canAbandonWrongAccount(): boolean {
    return !this.closing && !this.options.signal.aborted && this.pending === null && this.flow?.canAbandonWrongAccount() === true &&
      this.installation === null && this.host === null && this.slots.size === 0 && !this.attested && !this.acknowledged;
  }
  /** SDK composition metadata only. Protected references never loan the
   * original credential/keys or carry consent into a fresh installation. */
  scopeRecoveryContext(): Readonly<{accountId: string; accountLabel: string | null; references: Readonly<Record<string, string | null>>}> | null {
    if (!this.flow || !this.installation || this.flow.view().state !== "paired") return null;
    const view = this.flow.view();
    return Object.freeze({accountId: this.installation.scope.account, accountLabel: view.accountEmail ?? (view.accountLogin ? `@${view.accountLogin}` : null), references: this.flow.collectionRecoveries()});
  }
  /** Explicit recovery gesture, after terminal access removal. Stop/fence and
   * erase ONLY the old collection scope before allocating its fresh local slot.
   * A failed stop/erase refuses recovery rather than releasing old authority. */
  prepareScopedRecovery(collectionId: string, expectedReplacement?: string): Promise<Readonly<{accountId: string; reference: string}>> {
    this.check();
    if (this.pending) return this.pending.catch(() => {}).then(() => this.prepareScopedRecovery(collectionId, expectedReplacement));
    return this.operation(async () => {
      if (!this.flow || !this.installation || this.consentPending || this.flow.view().state !== "paired" || !this.flow.view().collectionIds.includes(collectionId)) throw failure("binding");
      const refs = this.flow.collectionRecoveries(), slot = this.slots.get(collectionId);
      if (expectedReplacement === undefined && !Object.hasOwn(refs, collectionId) && !this.scopeWasRemoved(collectionId)) throw failure("binding");
      if (slot) {await this.closeSlot(slot); this.check(); this.deleteSlot(slot);}
      await this.flow.retireCollectionScope(this.installation, collectionId, expectedReplacement ?? null); this.check();
      const selected = this.flow.confirmedSelection(), p = this.options;
      if (!await eraseAppCollectionAccess({cpOrigin: p.cpOrigin, appId: p.appId, accountId: selected.accountId, connectorId: selected.connectorId,
        installationId: selected.installationId, deviceId: selected.deviceId, collectionIds: [collectionId], databases: []}, collectionId)) throw failure("recovery_required");
      this.check();
      const reference = await this.flow.freshCollectionInstallation(this.installation, collectionId); this.check();
      return Object.freeze({accountId: selected.accountId, reference});
    }, true);
  }
  /** Forget only local presentation/selection, never revoke CP consent, delete
   * collection data or erase original protected installation/custody storage. */
  forget(collectionId: string): Promise<AppWebSignInSnapshot> {
    return this.operation(async () => {
      const slot = this.slots.get(collectionId);
      if (slot) { await this.closeSlot(slot); this.check(); this.deleteSlot(slot); }
      this.forgotten.add(collectionId);
      this.publish({collections: Object.freeze(this.base.collections.filter(c => c.collectionId !== collectionId))});
      return this.getSnapshot();
    });
  }
  /** Owner-only soft delete of a listed collection, for everyone. A refusal
   * never blocks the session; it rejects with a bounded delete code and
   * leaves the collection open. On success the caller forgets it locally. */
  deleteCollection(collectionId: string, confirmName: string): Promise<AppWebSignInSnapshot> {
    let refusal: AppCollectionDeleteError | null = null;
    return this.operation(async () => {
      const entry = this.base.collections.find(c => c.collectionId === collectionId);
      if (!this.flow || !this.installation || !entry) refusal = new AppCollectionDeleteError("collection_delete_not_found");
      else if (entry.role !== "owner") refusal = new AppCollectionDeleteError("collection_delete_not_owner");
      else {
        try { await this.flow.deleteApprovedCollection(this.installation, collectionId, confirmName); }
        catch (error) { refusal = collectionDeleteError(error); }
        this.check();
      }
      return this.getSnapshot();
    }).then(snapshot => { if (refusal) throw refusal; return snapshot; });
  }
  /** UX-011: end the server session and erase this browser's sign-in data,
   * keys and cached collections for this installation. Afterwards start()
   * finds no installation (signed_out) and authorize() begins a fresh pairing.
   * Pending-write checks belong to the page owner of the connection.
   *
   * Order: close the open collection (adapter, native host, lease), attempt
   * the server sign-out, close the flow (and its ledger connection) and leases,
   * THEN erase. A failed server sign-out (offline, 5xx, any refusal other than
   * "already signed out") still erases local state: a person who signs out
   * must not stay signed in on this device because the network failed. It is
   * reported in `signOutResult.server` as a diagnostic, not a problem. Only a
   * failure to remove the installation ledger itself (a reload would restore
   * the session) or to stop the open collection is `sign_out_failed`. */
  signOut(): Promise<AppWebSignInSnapshot> {
    this.check();
    // A background approval poll holds the slot: let it settle first.
    const poll = this.pending !== null && this.pending === this.polling ? this.pending : null;
    return Promise.resolve(poll?.catch(() => {})).then(() => this.operation(async () => {
      const flow = this.flow;
      let view: AppInstallationSignInView | null = null, connectorId: string | null = null, webPush = false;
      try { view = flow?.view() ?? null; } catch { view = null; }
      try { connectorId = flow?.confirmedSelection().connectorId ?? null; } catch { connectorId = null; }
      try { webPush = flow?.hasWebPushChannel() === true; } catch { webPush = false; }
      const collectionIds = [...new Set([...(view?.collectionIds ?? []), ...this.base.collections.map(c => c.collectionId)])];
      this.closeApprovalWindow(); this.fileAccess = null; this.consentPending = false;
      try { await this.closeSlots(); } catch (error) { this.failSignOut(); throw error; }
      this.check();
      let server: "revoked" | "already_signed_out" | "not_paired" | "incomplete" = "not_paired";
      if (flow && view?.state === "paired") {
        try { server = await flow.signOutInstallation(); } catch { server = "incomplete"; }
        this.check();
      }
      // Close every connection to this installation's stores before deleting them.
      this.flow = null; this.installation = null;
      try { await flow?.close(); } catch { /* the ledger handle closes on versionchange anyway */ }
      this.flowLifetime.abort(); this.flowLifetime = new AbortController();
      await this.installationLease?.release(); this.installationLease = null;
      this.attested = false; this.acknowledged = false; this.freshApproval = false; this.authorizationStartedAt = null;
      this.receiptRead = null; this.foregroundRead = null; this.forgotten.clear(); this.removedScopes.clear();
      const p = this.options;
      const local = await eraseAppInstallationData({cpOrigin: p.cpOrigin, appId: p.appId, ...(p.owner === undefined ? {} : {owner: p.owner}),
        accountId: view?.accountId ?? null, connectorId, installationId: view?.installationId ?? null, deviceId: view?.deviceId ?? null,
        collectionIds, databases: p.localDatabases ?? [], ...(p.recoveryFor ? {isolated: true} : {})});
      this.check();
      if (!local.ledger) { this.failSignOut(); throw mdbaseError("unavailable", "This device couldn't remove its sign-in data.", "sign_out_failed"); }
      this.emit(Object.freeze({status: "signed_out", signIn: null, collections: Object.freeze([]), selectedCollectionId: null, problem: null, timing: null,
        signOutResult: Object.freeze({server, local: local.complete ? "erased" : "incomplete", webPush})}));
      return this.getSnapshot();
    }, true));
  }
  private failSignOut(): void {
    if (this.closing || this.options.signal.aborted) return;
    let signIn: AppInstallationSignInView | null = null; try { signIn = this.flow?.view() ?? null; } catch { signIn = null; }
    const {problemDetail: _stale, ...previous} = this.base;
    this.focus = null;
    this.emit(Object.freeze({...previous, status: "blocked", signIn, selectedCollectionId: null, problem: "sign_out_failed"}));
  }
  private emit(snapshot: AppWebSignInSnapshot): void {
    this.check(); this.base = snapshot;
    // Signed out: no collection is held (a failed stop keeps its slot quarantined).
    if (snapshot.status === "signed_out") { for (const slot of [...this.slots.values()]) this.deleteSlot(slot); this.focus = null; }
    this.changed();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const pending = this.pending; this.foregroundRead = null; this.stopPolling(); this.options.signal.removeEventListener("abort", this.onAbort);
    this.closing = Promise.resolve().then(async () => {
      await pending?.catch(() => {});
      await this.closeSlots(); this.focus = null;
      await this.flow?.close(); this.flowLifetime.abort(); this.flow = null; this.installation = null;
      await this.installationLease?.release(); this.installationLease = null;
      this.base = Object.freeze({status: "closed", signIn: null, collections: Object.freeze([]), selectedCollectionId: null, problem: null, timing: this.base.timing});
      this.snapshotValue = this.base;
      for (const listener of [...this.listeners]) { try { listener(); } catch { /* close remains fail-stop */ } }
      this.listeners.clear();
    });
    this.lifetime.abort(); return this.closing;
  }
}
