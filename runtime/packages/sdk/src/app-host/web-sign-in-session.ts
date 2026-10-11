/** Shared first-party browser sign-in lifecycle. The original protected request,
 * installation owner and native device are retained; no app-grant/key loan API.
 * Collection adapters run in the trusted owner Worker, never in a redirect. */
import { appServerOutcome, isAppServerProblem, sanitizeAppServerProblem, MIN_SERVER_RETRY_MS, MAX_SERVER_RETRY_MS, type AppServerProblem } from "./cp-problem.js";
import { AppProtectedInstallationSignIn, AppInstallationSignInError, type AppInstallationSignInOptions, type AppInstallationSignInView, type AppInstallationCollection } from "./installation-sign-in.js";
import { AppWebCloudCopyHost } from "./cloud-copy-host.js";
import { AppCollectionDeleteError, collectionDeleteError } from "./collection-delete.js";
import { webSignInProblem, type AppWebSignInProblemDetail } from "./web-sign-in-problem.js";
import { appBrowserDirectAccess, type AppBrowserDirectAccessOptions, type AppBrowserDirectAccessSnapshot } from "./browser-direct-access.js";
import { AppCloudCopyBootstrapError, type AppBundledReleaseTrust } from "./cloud-copy-bootstrap.js";
import { selectAppEnvironment } from "./app-environment.js";
import { acquireAppInstallationLease, acquireAppReplicaLease, type AppInstallationCustodyAuthority, type AppReplicaLease, type AppReplicaScope } from "./owner.js";

export interface AppWebCollectionConnection<Connection> {
  /** Actual native/current setup assessment, not discovery or enrollment. */
  readonly state: "ready" | "setup_required";
  readonly connection: Connection;
  /** The live collection's latest specific server refusal (migrating, moved,
   * suspended), or null. The connection stays usable for local work. */
  readonly problem?: AppServerProblem | null;
  /** Close adapter resources. The session retains the collection lease until
   * both this adapter and the original native host have stopped. */
  close(): Promise<void>;
  /** Optional same-owner semantic assessment push. Required result ABI remains
   * state/connection/close; stale/closed adapter notifications are ignored. */
  subscribe?(listener: () => void): () => void;
}
export interface AppWebSignInPortal {
  navigate(uri: string): void;
  close(): void;
}
export interface AppWebSignInSessionOptions<Connection> extends Omit<AppInstallationSignInOptions, "mode" | "environmentSelection" | "environment"> {
  readonly environment: "lab" | "production";
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
    signal: AbortSignal;
  }): Promise<AppWebCollectionConnection<Connection>>;
  /** "only" (default) opens a sole approved collection and a fresh portal pick.
   * "never" leaves every open to the owner: a fresh pick stays visible as
   * signIn.collectionSelection, so an owner whose collection handoff needs its
   * own request slot (the SDK application Worker) opens it explicitly. */
  readonly autoSelect?: "only" | "never";
}
export interface AppWebSignInSnapshot {
  readonly status: "not_started" | "starting" | "signed_out" | "authorizing" | "unselected" | "opening" | "setup_required" | "ready" | "blocked" | "closed";
  readonly signIn: AppInstallationSignInView | null;
  readonly collections: readonly AppInstallationCollection[];
  readonly selectedCollectionId: string | null;
  /** Stable error code only: never log a response, bearer, proof or key. */
  readonly problem: string | null;
  /** Optional allowlisted name/code of the original rejection. No message,
   * stack, response, cause, identifiers or custody fields. Not retry authority. */
  readonly problemDetail?: AppWebSignInProblemDetail;
  /** Click-to-native/session screen, not a browser paint measurement. */
  readonly timing: Readonly<{firstScreenMs: number | null; readyMs: number | null}> | null;
}
const failure = (reason: AppInstallationSignInError["reason"]) => new AppInstallationSignInError(reason);
const liveOutcomes = new Set(["collection_migrating", "account_suspended", "update_required"]);
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
  private readonly flowLifetime = new AbortController();
  private readonly options: Readonly<AppWebSignInSessionOptions<Connection>>;
  private readonly listeners = new Set<() => void>();
  private flow: AppProtectedInstallationSignIn | null = null;
  private host: AppWebCloudCopyHost | null = null;
  private installation: AppInstallationCustodyAuthority | null = null;
  private installationLease: AppReplicaLease | null = null;
  private collectionLease: AppReplicaLease | null = null;
  private selected: AppWebCollectionConnection<Connection> | null = null;
  private selectedScope: Readonly<AppReplicaScope> | null = null;
  private stopAssessment: (() => void) | null = null;
  private collectionLeaseScope: Readonly<AppReplicaScope> | null = null;
  private collectionLifetime: AbortController | null = null;
  private selectionUsable = false;
  private readonly abortCollection = () => { this.collectionLifetime?.abort(); };
  private snapshotValue: AppWebSignInSnapshot = Object.freeze({status: "not_started", signIn: null, collections: Object.freeze([]), selectedCollectionId: null, problem: null, timing: null});
  private authorizationStartedAt: number | null = null;
  private pending: Promise<unknown> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closing: Promise<void> | null = null;
  private foreground = true;
  private receiptRead: ReceiptRead | null = null;
  private foregroundRead: ReceiptRead | null = null;
  private attested = false;
  private acknowledged = false;
  private consentPending = false;
  private freshApproval = false;
  private readonly forgotten = new Set<string>();
  private readonly onAbort = () => { void this.close().catch(() => {}); };

  constructor(options: AppWebSignInSessionOptions<Connection>) {
    this.options = Object.freeze({...options});
    // Validate the authenticated environment before touching storage or HTTP.
    selectAppEnvironment({environment: options.environment, appOrigin: options.origin, release: options.release});
    options.signal.addEventListener("abort", this.onAbort, {once: true});
    this.lifetime.signal.addEventListener("abort", this.abortCollection, {once: true});
  }
  getSnapshot(): AppWebSignInSnapshot { return this.snapshotValue; }
  snapshot(): AppWebSignInSnapshot { return this.getSnapshot(); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  connection(): Connection | null {
    if (this.closing || this.options.signal.aborted || !this.selectionUsable || this.collectionLifetime?.signal.aborted || !this.installation?.isCurrent()
      || !["ready", "setup_required"].includes(this.snapshotValue.status) || !this.sameScope(this.selectedScope, this.collectionLeaseScope)
      || this.selectedScope?.collection !== this.snapshotValue.selectedCollectionId) return null;
    return this.selected?.connection ?? null;
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
  private publish(update: Partial<AppWebSignInSnapshot>): void {
    this.check();
    let timing = update.timing ?? this.snapshotValue.timing;
    if (this.authorizationStartedAt !== null && (update.status === "ready" || update.status === "setup_required")) {
      const elapsed = Math.max(0, performance.now() - this.authorizationStartedAt);
      timing = Object.freeze({firstScreenMs: timing?.firstScreenMs ?? elapsed, readyMs: update.status === "ready" ? timing?.readyMs ?? elapsed : timing?.readyMs ?? null});
    }
    const {problemDetail: previousDetail, ...previous} = this.snapshotValue;
    const detail = update.problem === null ? undefined : update.problemDetail ?? previousDetail;
    this.snapshotValue = Object.freeze({...previous, ...update, timing, signIn: this.flow?.view() ?? null, ...(detail ? {problemDetail: detail} : {})});
    for (const listener of [...this.listeners]) { try { listener(); } catch { /* subscriber cannot interrupt durable lifecycle */ } }
  }
  private stopPolling(): void { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
  private operation<T>(work: () => Promise<T>): Promise<T> {
    this.check(); if (this.pending) return Promise.reject(failure("busy"));
    this.foregroundRead = null;
    this.stopPolling();
    const workResult = Promise.resolve().then(() => { this.check(); return work(); });
    // Keep cleanup in the original occupied operation. close() must await it,
    // not race a second native/SQL/lease stop against a rejected work promise.
    const pending = workResult.catch(async error => {
      if (!this.closing && !this.options.signal.aborted) {
        const {problem, detail} = webSignInProblem(error);
        if (problem === "open_failed") {
          try { console.error("mdbase web sign-in open failed", detail.name, detail.code); }
          catch { /* Diagnostics must never replace the original failure. */ }
        }
        let retryableChallenge = false;
        try {retryableChallenge = error instanceof AppCloudCopyBootstrapError && error.reason === "unavailable" && error.retryable === true &&
          this.snapshotValue.status === "opening" && this.snapshotValue.selectedCollectionId !== null &&
          this.snapshotValue.collections.some(c => c.collectionId === this.snapshotValue.selectedCollectionId) &&
          this.flow?.view().state === "paired" && this.installation?.isCurrent() === true;} catch { /* no inferred retry authority */ }
        if (retryableChallenge) {
          try { await this.closeCollection(); this.check(); }
          catch (stopError) {
            if (!this.closing && !this.options.signal.aborted) this.publish({status:"blocked",problem:"recovery_required",problemDetail:webSignInProblem(stopError).detail});
            throw stopError; // failed stop keeps original scope/leases quarantined
          }
          this.publish({status:"unselected",problem,problemDetail:detail});
        } else this.publish({status: "blocked", problem, problemDetail: detail});
      }
      throw error;
    });
    this.pending = pending;
    return pending.finally(() => { if (this.pending === pending) this.pending = null; this.schedulePoll(); });
  }
  /** Atomic create-or-restore; never recover a malformed ledger as fresh. A
   * completed installation restores locally. Pending HTTP retains SAME request. */
  start(): Promise<AppWebSignInSnapshot> {
    return this.operation(async () => {
      if (this.flow) return this.getSnapshot();
      this.publish({status: "starting", problem: null});
      const p = this.options;
      this.flow = await AppProtectedInstallationSignIn.open({...p, mode: "open", signal: this.flowLifetime.signal,
        environmentSelection: selectAppEnvironment({environment: p.environment, appOrigin: p.origin, release: p.release})});
      this.check();
      const view = await this.flow.start(); this.check();
      if (view.state === "paired") {
        await this.openDevice();
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
    this.check(); if (!this.flow || this.pending) return Promise.reject(failure("busy"));
    const hint = {collectionHint: options.collectionHint ?? null};
    const view = this.flow.view();
    const portal = this.options.openPortal();
    this.authorizationStartedAt = performance.now();
    this.publish({timing: Object.freeze({firstScreenMs: null, readyMs: null})});
    return this.operation(async () => {
      try {
        if (view.state === "paired") {
          await this.openDevice(); this.check();
          const consent = await this.flow!.startCollectionConsent(this.installation!, this.options.requestedCreateCollections ?? false, hint); this.check();
          this.consentPending = true; portal.navigate(consent.verificationUri);
        } else {
          const started = await this.flow!.start(hint); this.check(); portal.navigate(started.verificationUri);
        }
        this.publish({status: "authorizing", problem: null});
        await this.advance(); return this.getSnapshot();
      } catch (error) { portal.close(); throw error; }
    });
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
      const consent = await this.exchangeReceipt(() => this.flow!.exchangeCollectionConsent(this.installation!)); this.check();
      if (!consent) return;
      if (consent.state === "scope_updated") {
        if (consent.accountSelectionConfirmed !== true) throw failure("account_confirmation_required");
        if (this.flow!.view().collectionSelection?.requestId !== consent.requestId) throw failure("response");
        this.consentPending = false; this.freshApproval = true;
        await this.refreshCollections();
      } else this.publish({status: "authorizing", problem: null});
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
    }
    if (view.state === "paired") {
      if (view.collectionSelection?.requestId !== view.requestId) throw failure("response");
      this.freshApproval = true;
      await this.openDevice(); this.check(); await this.refreshCollections();
    } else this.publish({status: "authorizing", problem: null});
  }
  private async openDevice(): Promise<void> {
    if (!this.installation) {
      const selected = this.flow!.confirmedSelection();
      const scope = Object.freeze({account: selected.accountId, installation: selected.installationId});
      this.installationLease = await acquireAppInstallationLease(this.options.locks, scope, this.lifetime.signal); this.check();
      this.installation = Object.freeze({scope, isCurrent: () => !this.closing && !this.options.signal.aborted && !this.lifetime.signal.aborted && this.installationLease !== null});
    }
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
    const visible = Object.freeze(collections.filter(c => !this.forgotten.has(c.collectionId)));
    // Re-approval of a still-approved open collection keeps it open; the
    // same-scope adapter/lease and connection stay current.
    const open = this.selectionUsable && this.selected !== null && visible.some(c => c.collectionId === this.snapshotValue.selectedCollectionId);
    this.publish({status: open ? this.selected!.state : "unselected", collections: visible, problem: null});
    const picked = this.flow!.view().collectionSelection?.selectedCollectionId;
    if ((this.options.autoSelect ?? "only") !== "only") return;
    if (this.freshApproval && picked && visible.some(c => c.collectionId === picked)) await this.selectCollection(picked);
    else if (visible.length === 1) await this.selectCollection(visible[0]!.collectionId);
  }
  private schedulePoll(): void {
    if (this.pending && !this.closing && !this.options.signal.aborted) return; // Keep ONE original occupied slot.
    const read = this.foregroundRead; this.foregroundRead = null;
    const wait = this.retryAfterMs();
    if (wait !== null && !this.closing && !this.options.signal.aborted && this.timer === null && this.snapshotValue.status === "blocked") {
      // Server-directed: the collection is being upgraded. Reopen the SAME
      // selected collection; the app only shows the description.
      this.timer = setTimeout(() => {
        this.timer = null;
        const s = this.snapshotValue, id = s.selectedCollectionId;
        if (s.status !== "blocked" || s.problem !== "collection_migrating" || id === null || this.flow?.view().state !== "paired") return;
        void this.operation(() => this.selectCollection(id)).catch(() => {});
      }, wait);
      return;
    }
    if (this.closing || this.options.signal.aborted || this.timer !== null || this.snapshotValue.status !== "authorizing") return;
    const resume = this.foreground && read && this.currentReceipt(read) ? read : null;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.operation(async () => {
        if (resume && (!this.foreground || !this.currentReceipt(resume))) return;
        await this.advance();
      }).catch(() => {});
    }, resume ? 0 : !this.foreground ? 10000 : this.snapshotValue.problem === "outcome_unknown" ? 5000 : 1000);
  }
  /** Server-directed retry (collection_migrating): clamp 5 s..10 min. */
  private retryAfterMs(): number | null {
    const s = this.snapshotValue;
    if (s.problem !== "collection_migrating") return null;
    let retry: number | null = null; try { retry = sanitizeAppServerProblem(s.problemDetail?.server)?.retryAfterMs ?? null; } catch { retry = null; }
    return Math.min(MAX_SERVER_RETRY_MS, Math.max(MIN_SERVER_RETRY_MS, retry ?? 30_000));
  }
  /** Owners forward visibility changes; Workers have no ambient document. */
  setForeground(active: boolean): void {
    this.check(); const resumed = active && !this.foreground;
    this.foreground = active; this.stopPolling();
    if (!active) this.foregroundRead = null;
    else if (resumed && this.receiptRead?.operation === this.pending) this.foregroundRead = this.receiptRead;
    if (active && this.snapshotValue.status === "authorizing" && !this.pending) void this.operation(() => this.advance()).catch(() => {});
    else this.schedulePoll();
  }
  select(collectionId: string): Promise<AppWebSignInSnapshot> {
    return this.operation(async () => { await this.selectCollection(collectionId); return this.getSnapshot(); });
  }
  private async selectCollection(collectionId: string): Promise<void> {
    this.check();
    const collection = this.snapshotValue.collections.find(c => c.collectionId === collectionId);
    if (!collection || this.flow?.view().state !== "paired" || !this.installation) throw failure("refused");
    if (this.selectionUsable && this.selected && !this.collectionLifetime?.signal.aborted && this.sameScope(this.selectedScope, this.collectionLeaseScope) && this.selectedScope?.collection === collectionId) {
      this.publish({status: this.selected.state, selectedCollectionId: collectionId, problem: null}); return;
    }
    // Quarantine BEFORE publishing a requested target. Snapshot IDs are not the
    // immutable scope of the old adapter/lease, especially after failed shutdown.
    this.selectionUsable = false; this.collectionLifetime?.abort();
    this.publish({status: "opening", selectedCollectionId: collectionId, problem: null});
    if (this.collectionLease || this.selected) await this.closeCollection();
    this.check(); await this.openDevice(); this.check();
    const scope = Object.freeze({...this.installation.scope, collection: collectionId});
    this.collectionLease = await acquireAppReplicaLease(this.options.locks, scope, this.lifetime.signal); this.collectionLeaseScope = scope; this.check();
    this.collectionLifetime = new AbortController();
    const newlyCreated = this.freshApproval && this.flow!.view().collectionSelection?.createdCollectionIds.includes(collectionId) === true;
    this.selected = await this.options.openCollection({host: this.host!, installation: this.installation, scope, collection,
      setupPolicy: newlyCreated ? "approved-new-collection" : "explicit", signal: this.collectionLifetime.signal}); this.selectedScope = scope; this.check();
    if (this.selected.state !== "ready" && this.selected.state !== "setup_required") throw failure("response");
    this.selectionUsable = true;
    const selected = this.selected;
    this.stopAssessment = selected.subscribe?.(() => {
      if (this.closing || !this.selectionUsable || this.selected !== selected || this.collectionLifetime?.signal.aborted ||
        !this.sameScope(this.selectedScope, this.collectionLeaseScope) || this.selectedScope?.collection !== this.snapshotValue.selectedCollectionId) return;
      if (selected.state === "ready" || selected.state === "setup_required") this.publish({status: selected.state, ...this.liveProblem(selected)});
    }) ?? null;
    this.publish({status: this.selected.state});
  }
  /** Live problem of the open collection: shown while it lasts, cleared after. */
  private liveProblem(selected: AppWebCollectionConnection<Connection>): Partial<AppWebSignInSnapshot> {
    let server: AppServerProblem | null = null; try { server = selected.problem ?? null; } catch { server = null; }
    const outcome = isAppServerProblem(server) ? appServerOutcome(server) : null;
    if (outcome && server) return {problem: outcome, problemDetail: Object.freeze({name: "AppHttpLogError", code: outcome, server})};
    return liveOutcomes.has(this.snapshotValue.problem ?? "") ? {problem: null} : {};
  }
  private async closeCollection(): Promise<void> {
    // Failed adapter/native shutdown keeps the original adapter/scope and leases
    // for fail-stop cleanup, but cannot expose a connection or take a ready shortcut.
    this.selectionUsable = false;
    const stopAssessment = this.stopAssessment; this.stopAssessment = null;
    try {stopAssessment?.();} catch { /* observer must not prevent native/lease cleanup */ }
    this.collectionLifetime?.abort();
    await this.selected?.close(); this.selected = null; this.selectedScope = null; this.collectionLifetime = null;
    await this.host?.close(); this.host = null; this.acknowledged = false;
    await this.collectionLease?.release(); this.collectionLease = null; this.collectionLeaseScope = null;
  }
  clearSelection(): Promise<AppWebSignInSnapshot> {
    return this.operation(async () => { await this.closeCollection(); this.publish({status: "unselected", selectedCollectionId: null, problem: null}); return this.getSnapshot(); });
  }
  /** Forget only local presentation/selection, never revoke CP consent, delete
   * collection data or erase original protected installation/custody storage. */
  forget(collectionId: string): Promise<AppWebSignInSnapshot> {
    return this.operation(async () => {
      if (this.snapshotValue.selectedCollectionId === collectionId) { await this.closeCollection(); this.check(); }
      this.forgotten.add(collectionId);
      this.publish({collections: Object.freeze(this.snapshotValue.collections.filter(c => c.collectionId !== collectionId)),
        ...(this.snapshotValue.selectedCollectionId === collectionId ? {status: "unselected", selectedCollectionId: null} : {})});
      return this.getSnapshot();
    });
  }
  /** Owner-only soft delete of a listed collection, for everyone. A refusal
   * never blocks the session; it rejects with a bounded delete code and
   * leaves the collection open. On success the caller forgets it locally. */
  deleteCollection(collectionId: string, confirmName: string): Promise<AppWebSignInSnapshot> {
    let refusal: AppCollectionDeleteError | null = null;
    return this.operation(async () => {
      const entry = this.snapshotValue.collections.find(c => c.collectionId === collectionId);
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
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const pending = this.pending; this.foregroundRead = null; this.stopPolling(); this.options.signal.removeEventListener("abort", this.onAbort);
    this.closing = Promise.resolve().then(async () => {
      await pending?.catch(() => {});
      await this.closeCollection();
      await this.flow?.close(); this.flowLifetime.abort(); this.flow = null; this.installation = null;
      await this.installationLease?.release(); this.installationLease = null;
      this.snapshotValue = Object.freeze({status: "closed", signIn: null, collections: Object.freeze([]), selectedCollectionId: null, problem: null, timing: this.snapshotValue.timing});
      for (const listener of [...this.listeners]) { try { listener(); } catch { /* close remains fail-stop */ } }
      this.listeners.clear();
    });
    this.lifetime.abort(); return this.closing;
  }
}
