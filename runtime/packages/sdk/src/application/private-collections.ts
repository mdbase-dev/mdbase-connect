/**
 * SDK-10: Private collections (kept on the person's computers, reached through
 * the relay with an app grant) in the entry's one collection list, beside the
 * hosted ones, and opened by the same selection.
 *
 * Page-side and per tab: a Private collection opens as a thin client in this
 * page, never in the shared Worker. The list shows the collections this
 * browser holds a grant for; `add` asks for a new grant from the user gesture.
 */
import type { NativeCompletion } from "../app-grant/native-completion.js";
import type { AppNativeAuthorizationContext } from "../app-host/native-sign-in.js";
import type { NativeAuthorizationCall, NativeAuthorizationResult } from "./native-authorization-rpc.js";
import type { AppWebSignInPortal } from "../app-host/web-sign-in-session.js";
import type { MdbasePreparedAuthorization } from "../app-grant/client.js";
import type { AppInstallationCollection } from "../app-host/installation-sign-in.js";
import type { AppWebSignInSnapshot } from "../app-host/web-sign-in-session.js";
import type { AppWebSignInProblemDetail } from "../app-host/web-sign-in-problem.js";
import { relayCloseFromDetails } from "../transport/relay-close.js";
import type { MdbaseAppGrants, AppGrantPopup, MdbasePrivateCollection } from "../app-grant/client.js";
import type { MdbasePrivateSetup, MdbasePrivateSetupStatus } from "../app-grant/setup.js";
import type { CollectionAvailability, CollectionUnavailableReason } from "../collection-availability.js";
import type { MdbaseClient } from "../client.js";
import { isMdbaseError, mdbaseError } from "../errors.js";
import type { MdbaseApplicationDeclaration } from "./declaration.js";
import type { MdbaseApplicationConnection, MdbaseApplicationReadinessSnapshot } from "./entry.js";
import type { MdbaseSetupPlan, MdbaseSetupPlanOptions } from "./setup.js";

/** The grant operations this controller uses (a fake in tests). */
export type ApplicationPrivateGrants = Pick<MdbaseAppGrants, "collections" | "availability" | "waitForAvailable" | "connector" | "people" | "setup" | "forget" | "forgetAllGrants" | "authorize"> & Partial<Pick<MdbaseAppGrants,"prepareAuthorization" | "verifiedStoredNativeGrant">>;

export interface ApplicationPrivateCollectionsOptions {
  readonly declaration: MdbaseApplicationDeclaration;
  /** Loads the grants on first use (the relay, Noise and grant store load lazily). */
  readonly grants?: () => Promise<ApplicationPrivateGrants>;
  /** Open the thin client; defaults to `connect` over the grant's connector. */
  readonly connect?: (grants: ApplicationPrivateGrants, collectionId: string, signal: AbortSignal) => Promise<MdbaseClient>;
  readonly onChange: () => void;
  /** How long an open waits for the person's computer (default 10 minutes). */
  readonly waitMs?: number;
}

/** The open Private collection, in the session snapshot's terms. */
export interface ApplicationPrivateState {
  readonly collectionId: string;
  readonly status: "opening" | "ready" | "setup_required" | "blocked";
  readonly problem: string | null;
  readonly problemDetail?: AppWebSignInProblemDetail;
  readonly readiness: MdbaseApplicationReadinessSnapshot;
}

interface Open {
  readonly id: string;
  readonly life: AbortController;
  state: ApplicationPrivateState;
  client: MdbaseClient | null;
  setup: MdbasePrivateSetup | null;
  connection: MdbaseApplicationConnection | null;
  stopLink: (() => void) | null;
}

/** Read-only backpressure never replaces the original connection or retries apply. */
function assessmentDelay(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {clearTimeout(timer); reject(mdbaseError("cancelled", "The original collection closed."));};
    if (signal.aborted) {reject(mdbaseError("cancelled", "The original collection closed.")); return;}
    const timer = setTimeout(() => {signal.removeEventListener("abort", abort); resolve();}, ms);
    signal.addEventListener("abort", abort, {once: true});
  });
}
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const emptyFacet = Object.freeze({ checking: false, assessment: null, problem: null });
const facets = Object.freeze({ capabilities: emptyFacet, contracts: emptyFacet, configuration: emptyFacet, files: emptyFacet, people: emptyFacet, notifications: emptyFacet });
const readiness = (checking: boolean, status: MdbasePrivateSetupStatus | null): MdbaseApplicationReadinessSnapshot => {
  const assessment = status ? Object.freeze({ status, problem: status === "incompatible" ? Object.freeze({ code: "incompatible" }) : null }) : null;
  return Object.freeze({ checking, assessment, problem: null, facets: Object.freeze({ ...facets, configuration: Object.freeze({ checking, assessment, problem: null }) }) });
};
/** The copy key for an unavailable Private collection. */
const availabilityProblem = (reason: CollectionUnavailableReason): string => reason === "approval_required" ? "device_approval_required" : reason;
/** Reasons that clear by themselves or by an action on the person's computer. */
const waitable = (a: CollectionAvailability) => a.state === "opening" || (a.state === "unavailable" && a.reason !== "sync_required" && a.reason !== "access_removed" && a.reason !== "collection_deleted");
const problemOf = (error: unknown): string => {
  if (isMdbaseError(error)) {
    const availability = error.details instanceof Map ? error.details.get("availability") : undefined;
    if (typeof availability === "string") return availabilityProblem(availability as CollectionUnavailableReason);
    return error.reason ?? error.code;
  }
  return "open_failed";
};
const problemDetailOf = (error: unknown): AppWebSignInProblemDetail | undefined => {
  if (!isMdbaseError(error)) return undefined;
  const relay = relayCloseFromDetails(error.details);
  return Object.freeze({ name: "MdbaseError", code: error.code, ...(relay ? { relay } : {}) });
};

/** The declaration's redirect URI on its own origin (where the grant popup returns). */
export function appGrantRedirectUri(declaration: MdbaseApplicationDeclaration): string {
  const declared = (declaration.manifest as { redirect_uris?: unknown } | undefined)?.redirect_uris;
  const uris = Array.isArray(declared) ? declared.filter((uri): uri is string => typeof uri === "string") : [];
  return uris.find(uri => { try { return new URL(uri).origin === declaration.origin; } catch { return false; } }) ?? new URL("/", declaration.origin).href;
}

/** The entry's collection list with this browser's Private collections added
 * (a hosted entry of the same ID wins), and the open Private collection as the
 * session's selected one while no hosted collection is open. */
export function withPrivateCollections<T extends AppWebSignInSnapshot>(raw: T, entries: readonly AppInstallationCollection[], open: ApplicationPrivateState | null): T {
  if (raw.signIn?.state !== "paired" || (!entries.length && !open)) return raw;
  const hosted = new Set(raw.collections.map(c => c.collectionId));
  const added = entries.filter(e => !hosted.has(e.collectionId));
  const collections = added.length ? Object.freeze([...raw.collections, ...added]) : raw.collections;
  if (!open || raw.status !== "unselected" || hosted.has(open.collectionId)) return collections === raw.collections ? raw : Object.freeze({ ...raw, collections });
  const { problemDetail: _hosted, ...rest } = raw;
  return Object.freeze({ ...rest, collections, status: open.status, selectedCollectionId: open.collectionId, problem: open.problem, transport: null, live: null,
    ...(open.problemDetail ? { problemDetail: open.problemDetail } : {}),
    ...("readiness" in raw ? { readiness: open.readiness } : {}) }) as unknown as T;
}

export class ApplicationPrivateCollections {
  private readonly options: ApplicationPrivateCollectionsOptions;
  private loading: Promise<ApplicationPrivateGrants> | null = null;
  private list: readonly AppInstallationCollection[] = Object.freeze([]);
  private open: Open | null = null;
  private listed: string | null = null;
  /** The account whose list read finished (read or failed): until then a
   * requested collection missing from the list may still be in it. */
  private settled: string | null = null;
  private refreshing: Promise<void> | null = null;
  private closed = false;
  private bindings:readonly NativeCompletion[]|null=null;
  private bindingsAccount:string|null=null;
  private native: {context:AppNativeAuthorizationContext;prepared:MdbasePreparedAuthorization|null;portal:AppWebSignInPortal;life:AbortController}|null=null;
  /** Bumped on every change: entries and state are stable between bumps. */
  revision = 0;

  constructor(options: ApplicationPrivateCollectionsOptions) { this.options = options; }

  private grants(): Promise<ApplicationPrivateGrants> {
    const pending = this.loading ??= (this.options.grants ?? (async () => {
      const { MdbaseAppGrants } = await import("../app-grant/client.js");
      return new MdbaseAppGrants({ declaration: this.options.declaration, redirectUri: appGrantRedirectUri(this.options.declaration) });
    }))();
    pending.catch(() => { if (this.loading === pending) this.loading = null; });
    return pending;
  }
  private changed(): void { if (this.closed) return; this.revision++; try { this.options.onChange(); } catch { /* observers never own the collection */ } }

  /** Only verified SAME-account protected references may label stored keys. */
  bind(account:string|null,grants:readonly NativeCompletion[]):void {
    const next=grants.filter(c=>c.account_id===account);
    if(this.bindingsAccount===account && JSON.stringify(next)===JSON.stringify(this.bindings))return;
    this.bindingsAccount=account;this.bindings=Object.freeze([...next]);this.settled=null;this.listed=null;
    this.setList([]);
  }
  async nativeAuthorization(call:NativeAuthorizationCall,portal:AppWebSignInPortal,signal:AbortSignal):Promise<NativeAuthorizationResult>{
    if(call.action==="cancel"){this.native?.life.abort();this.native?.prepared?.cancel();this.native=null;return null;}
    if(this.closed || signal.aborted)throw mdbaseError("cancelled","Original Native authorization fenced");
    if(call.action==="prepare"){
      if(this.native || call.value.authorizationId)throw mdbaseError("unauthenticated","Original Native preparation unavailable");
      const slot={context:call.value,portal,prepared:null as MdbasePreparedAuthorization|null,life:new AbortController()};this.native=slot;
      const original=AbortSignal.any([signal,slot.life.signal]);
      const grants=await this.grants();
      if(!grants.prepareAuthorization)throw mdbaseError("unavailable","Native authorization unavailable");
      const nonce=btoa(String.fromCharCode(...Uint8Array.from(call.value.challenge.match(/../g)!,v=>parseInt(v,16)))).replaceAll("+","-").replaceAll("/","_").replace(/=+$/u,"");
      const prepared=await grants.prepareAuthorization({authorizationNonce:nonce,expectedAccountId:call.value.accountId,signal:original});
      slot.prepared=prepared;
      if(this.native!==slot || original.aborted || prepared.applicationId!==call.value.appId){prepared.cancel();throw mdbaseError("unauthenticated","Original application registration mismatch");}
      return Object.freeze({authorizationId:prepared.authorizationId,applicationId:prepared.applicationId,manifestDigest:prepared.manifestDigest});
    }
    const slot=this.native,p=slot?.prepared;
    if(!slot || !p || slot.portal!==portal || slot.context.requestId!==call.value.requestId || p.authorizationId!==call.value.authorizationRequestId)throw mdbaseError("unauthenticated","Original Native preparation unavailable");
    const completed=await p.finish({popup:portal,collection:call.value.collectionId,signal:AbortSignal.any([signal,slot.life.signal])});
    if(this.native!==slot || signal.aborted || !completed.nativeCompletion)throw mdbaseError("unauthenticated","Original Native completion unavailable");
    return completed.nativeCompletion;
  }
  /** Private collections this browser holds a grant for. */
  entries(): readonly AppInstallationCollection[] { return this.list; }
  has(collectionId: string): boolean { return this.list.some(c => c.collectionId === collectionId) || this.open?.id === collectionId; }
  state(): ApplicationPrivateState | null { return this.open?.state ?? null; }
  connection(collectionId: string): MdbaseApplicationConnection | null {
    const open = this.open;
    return open && open.id === collectionId && open.state.status === "ready" ? open.connection : null;
  }

  /** True until this browser's list for `account` has been read (or failed to
   * read): a collection not yet listed may still be one of them. */
  listing(account: string | null): boolean { return !this.closed && account !== null && this.settled !== account; }
  /** Read the list once per signed-in account (and again on `refresh`). */
  ensure(account: string): void { if (this.settled !== account && !this.refreshing) void this.refresh(account).catch(() => {}); }
  refresh(account: string | null = this.listed): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.refreshing) return this.refreshing;
    const pending = (async () => {
      try {
        const grants = await this.grants();
        const bindings=this.bindings;
        const verified:NativeCompletion[]=[];
        if(bindings)for(const c of bindings)if(c.account_id===account && await grants.verifiedStoredNativeGrant?.(c))verified.push(c);
        const found = await grants.collections(bindings===null?{}:{bindings:verified});
        if (this.closed || bindings!==this.bindings) return;
        this.listed = account;
        this.setList(found);
      } finally {
        // Read or failed, the list is settled for this account: a request
        // waiting on it decides now (a failed read is not retried in a loop).
        if (!this.closed && account !== null && this.settled !== account) { this.settled = account; this.changed(); }
      }
    })().finally(() => { if (this.refreshing === pending) this.refreshing = null; });
    this.refreshing = pending;
    return pending;
  }
  private setList(found: readonly MdbasePrivateCollection[]): void {
    const next = Object.freeze(found.filter(c => UUID.test(c.collectionId)).map(c => Object.freeze({
      collectionId: c.collectionId, displayName: c.displayName,
      // Display only (Connect checks every action); an unreported role reads as editor.
      role: c.role ?? "editor", availability: c.availability, kind: "private" as const,
    })));
    if (JSON.stringify(next) === JSON.stringify(this.list)) return;
    this.list = next; this.changed();
  }
  private setAvailability(collectionId: string, availability: CollectionAvailability): void {
    if (!this.list.some(c => c.collectionId === collectionId && JSON.stringify(c.availability) !== JSON.stringify(availability))) return;
    this.list = Object.freeze(this.list.map(c => c.collectionId === collectionId ? Object.freeze({ ...c, availability }) : c));
    this.changed();
  }
  private set(open: Open, update: Partial<ApplicationPrivateState>): void {
    if (this.open !== open || open.life.signal.aborted) return;
    const { problemDetail: previous, ...state } = open.state;
    const { problemDetail, ...next } = update;
    const detail = next.problem === null ? undefined : problemDetail ?? (next.problem === undefined ? previous : undefined);
    open.state = Object.freeze({ ...state, ...next, ...(detail ? { problemDetail: detail } : {}) }); this.changed();
  }

  /** Open one Private collection in this page (closing any open one). Waits,
   * bounded, for the person's computer; the state says what is happening. */
  async openCollection(collectionId: string, scope: { readonly account: string; readonly installation: string }): Promise<void> {
    if (this.closed) throw mdbaseError("cancelled", "Private collections closed", "application_entry_fenced");
    this.close(false);
    const open: Open = { id: collectionId, life: new AbortController(), client: null, setup: null, connection: null, stopLink: null,
      state: Object.freeze({ collectionId, status: "opening", problem: null, readiness: readiness(true, null) }) };
    this.open = open; this.changed();
    const signal = open.life.signal;
    try {
      const grants = await this.grants();
      const original=this.bindings?.find(c=>c.account_id===scope.account && c.collection_id===collectionId);
      const checkBinding=async()=>{
        if(this.bindings!==null && (!original || this.bindingsAccount!==scope.account || !this.bindings.includes(original) || !await grants.verifiedStoredNativeGrant?.(original)))throw mdbaseError("unauthenticated","Original account-bound Native grant unavailable");
        if(signal.aborted)throw mdbaseError("cancelled","Original Native open fenced");
      };
      await checkBinding();
      let availability = await grants.availability(collectionId, { signal });
      this.setAvailability(collectionId, availability);
      if (waitable(availability)) {
        // Show why (computer offline, approve on the computer) while waiting for it.
        if (availability.state === "unavailable") this.set(open, { status: "blocked", problem: availabilityProblem(availability.reason), readiness: readiness(false, null) });
        availability = await grants.waitForAvailable(collectionId, { signal, timeoutMs: this.options.waitMs ?? 10 * 60_000, onAvailability: next => {
          this.setAvailability(collectionId, next);
          if (next.state === "unavailable") this.set(open, { status: "blocked", problem: availabilityProblem(next.reason) });
          else this.set(open, { status: "opening", problem: null, readiness: readiness(true, null) });
        } });
      }
      if (availability.state !== "available") {
        if (availability.state === "opening") throw mdbaseError("unavailable", "The collection is still getting ready", "collection_unavailable");
        this.set(open, { status: "blocked", problem: availabilityProblem(availability.reason), readiness: readiness(false, null) }); return; }
      this.set(open, { status: "opening", problem: null });
      await checkBinding();
      const client = await (this.options.connect ?? defaultConnect(this.options.declaration))(grants, collectionId, signal);
      if (this.open !== open || signal.aborted || client.collection !== collectionId) { client.close(); if (this.open === open && !signal.aborted) throw mdbaseError("invalid_request", "a different collection opened", "collection_mismatch"); return; }
      open.client = client;
      open.setup = grants.setup(client);
      open.connection = Object.freeze({
        id: collectionId, displayName: this.list.find(c => c.collectionId === collectionId)?.displayName ?? "Collection",
        scope: Object.freeze({ account: scope.account, installation: scope.installation, collection: collectionId }),
        generation: crypto.randomUUID(), records: client, files: client.files, people: grants.people(collectionId, client),
        isCurrent: () => this.open === open && !signal.aborted && !this.closed,
      });
      await this.assessOpen(open);
      // Link failure alone cannot say whether access ended or the computer is
      // offline. Recheck the grant-backed availability; never infer authority
      // from cached data or retire the ready connection's unsaved work.
      let revision = 0;
      open.stopLink = client.onLink((link, error) => {
        // Diagnostics never demote READY, retire the connection or replay work.
        if (error) this.set(open, { problem: problemOf(error), problemDetail: problemDetailOf(error) });
        else if (link === "open") this.set(open, { problem: null });
        const request = ++revision;
        void grants.availability(collectionId, { signal }).then(next => {
          if (this.open === open && !signal.aborted && request === revision)
            this.setAvailability(collectionId, next);
        }).catch(() => { /* Unknown availability is not a consent decision. */ });
      });
    } catch (error) {
      if (this.open === open && !signal.aborted) this.set(open, { status: "blocked", problem: problemOf(error), problemDetail: problemDetailOf(error), readiness: readiness(false, null) });
      throw error;
    }
  }
  private async assessOpen(open: Open): Promise<MdbasePrivateSetupStatus> {
    this.set(open, { readiness: readiness(true, open.state.readiness.assessment?.status ?? null) });
    let delay = 1000;
    for (;;) {
      if (this.open !== open || open.life.signal.aborted) throw mdbaseError("cancelled", "The original collection closed.");
      let status: MdbasePrivateSetupStatus;
      try {status = await open.setup!.assess({ signal: open.life.signal });}
      catch (error) {
        if (!isMdbaseError(error) || error.code !== "rate_limited") throw error;
        const hint = error.retryAfterMs;
        await assessmentDelay(open.life.signal, Math.min(2_147_483_647, Math.max(delay, typeof hint === "number" && Number.isFinite(hint) ? hint : 0)));
        delay = Math.min(30000, delay * 2); continue;
      }
      if (this.open !== open || open.life.signal.aborted) throw mdbaseError("cancelled", "The original collection closed.");
      this.set(open, { status: status === "ready" ? "ready" : "setup_required", problem: null, readiness: readiness(false, status) });
      return status;
    }
  }
  private current(): Open {
    const open = this.open;
    if (!open?.setup || open.life.signal.aborted) throw mdbaseError("invalid_request", "No Private collection is open", "application_connection_fenced");
    return open;
  }
  isOpen(): boolean { return this.open !== null; }
  async assess(): Promise<MdbaseApplicationReadinessSnapshot> { const open = this.current(); await this.assessOpen(open); return open.state.readiness; }
  plan(options?: MdbaseSetupPlanOptions): Promise<MdbaseSetupPlan> { return this.current().setup!.plan(options); }
  async apply(plan: MdbaseSetupPlan, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    const open = this.current();
    const status = await open.setup!.apply(plan, options);
    this.set(open, { status: status === "ready" ? "ready" : "setup_required", problem: null, readiness: readiness(false, status) });
  }
  /** Set up from the declaration with nothing to review. */
  async configure(options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    const open = this.current();
    const plan = await open.setup!.plan(options.signal ? { signal: options.signal } : {});
    await this.apply(plan, options);
  }
  /** From the user gesture (the popup is already reserved): grant this app a
   * Private collection (or `collectionId` again). Resolves with its ID. */
  async add(popup: AppGrantPopup, collectionId?: string, signal?: AbortSignal): Promise<string> {
    let grants: ApplicationPrivateGrants;
    try { grants = await this.grants(); } catch (error) { popup.close(); throw error; }
    const granted = await grants.authorize({ popup, ...(collectionId ? { collection: collectionId } : {}), ...(signal ? { signal } : {}) });
    await this.refresh().catch(() => {});
    return granted.collectionId;
  }
  /** Forget the grant in this browser (does not revoke it at Connect). */
  async forget(collectionId: string): Promise<void> {
    if (this.open?.id === collectionId) this.close();
    const grants = await this.grants();
    const binding=this.bindings?.find(c=>c.collection_id===collectionId && c.account_id===this.bindingsAccount);
    if(this.bindings===null || binding && await grants.verifiedStoredNativeGrant?.(binding))await (binding?grants.forget(collectionId,{expectedNoisePublicKey:binding.client_noise_public_key}):grants.forget(collectionId));
    if (this.list.some(c => c.collectionId === collectionId)) { this.list = Object.freeze(this.list.filter(c => c.collectionId !== collectionId)); this.changed(); }
  }
  /** Sign-out: every grant this browser holds goes too — including any in
   * the store that this page never listed (grants carry no account, so one
   * left behind could serve a different account). Rejects when the wipe
   * could not complete; the caller reports it, never swallows it. */
  async forgetAll(): Promise<void> {
    this.native?.life.abort();this.native?.prepared?.cancel();this.native=null;
    this.close();
    try {
      const grants = await this.grants();
      await grants.forgetAllGrants();
    } finally {
      this.list = Object.freeze([]); this.listed = null; this.settled = null; this.changed();
    }
  }
  /** Close the open Private collection (its client), if any. */
  close(notify = true): void {
    const open = this.open; if (!open) return;
    this.open = null; open.life.abort();
    open.stopLink?.();
    try { open.client?.close(); } catch { /* closing is best effort */ }
    if (notify) this.changed();
  }
  dispose(): void { this.native?.life.abort();this.native?.prepared?.cancel();this.native=null;this.close(false); this.closed = true; }
}

function defaultConnect(declaration: MdbaseApplicationDeclaration) {
  return async (grants: ApplicationPrivateGrants, collectionId: string, signal: AbortSignal) => {
    const { connect } = await import("../client.js");
    return connect({ connector: grants.connector(collectionId), app: { name: declaration.id, version: "1" }, signal });
  };
}
