/** First-party protected installation sign-in. Internal until SAME original
 * native-owner/cloud-host composition is qualified. No app-grant authority,
 * ambient cookies, automatic polling/renewal or new-actor retry. */
import { uuidToBytes } from "../codec.js";
import { collectionDisplayName } from "./collection-display-name.js";
import { isAppEnvironmentSelection, type AppEnvironmentSelection } from "./app-environment.js";
import { AppInstallationStore, AppInstallationStorageError, type AppInstallationStoreOptions } from "./installation-store.js";
import { isAppInstallationId, type AppInstallationCustodyAuthority } from "./owner.js";
import type { AppCloudCopyHostSession } from "./cloud-copy-host.js";
import type { AppDeviceCustodyPersistence } from "./device-registration.js";
import type { AppDeviceKeyCustodyPin } from "./device-key-custody.js";
import type { AppNoiseCustodyResult, AppWasmRuntime, AppDeviceRegistrationReceipt } from "./wasm-runtime.js";
export class AppInstallationSignInError extends Error {
  constructor(readonly reason: "binding" | "fenced" | "busy" | "account_confirmation_required" | "outcome_unknown" | "response" | "refused" | "expired" | "recovery_required") {
    super(`app installation sign-in: ${reason}`); this.name = "AppInstallationSignInError";
  }
}
const fail = (reason: AppInstallationSignInError["reason"]) => new AppInstallationSignInError(reason);
const hex = (b: Uint8Array) => Array.from(b, v => v.toString(16).padStart(2, "0")).join("");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function id(v: unknown): string { if (typeof v !== "string" || !UUID.test(v) || uuidToBytes(v).every(b => b === 0)) throw fail("response"); return v; }
function text(v: unknown, pattern: RegExp): string { if (typeof v !== "string" || !pattern.test(v)) throw fail("response"); return v; }
function object(v: unknown, keys: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join() !== keys.split(",").sort().join()) throw fail("response"); return v as Record<string, unknown>;
}
interface PortalMetadata {
  /** Display metadata only. Never namespace, custody or inferred consent. */
  accountEmail?: string | null; portalConfirmed?: true;
  accountProvider?: "github"; accountLogin?: string;
}
interface Selection extends PortalMetadata {
  accountId: string; connectorId: string; challenge: string; approvalMode: "password-ak1";
}
function accountEmail(value: unknown): string {
  if (typeof value !== "string" || value.length > 320 || !/^[^\s@\u0000-\u001f\u007f]+@[^\s@\u0000-\u001f\u007f]+$/.test(value)) throw fail("response");
  return value;
}
function portalKeys(v: object, stored = false): string {
  const [email, marker, provider, login] = stored ? ["accountEmail", "portalConfirmed", "accountProvider", "accountLogin"] as const : ["account_email", "account_selection_confirmed", "account_provider", "account_login"] as const;
  return [email, marker, provider, login].some(key => Object.hasOwn(v, key))
    ? `,${email},${marker}${Object.hasOwn(v, provider) || Object.hasOwn(v, login) ? `,${provider},${login}` : ""}` : "";
}
function portalMetadata(v: Record<string, unknown>, stored = false): PortalMetadata {
  const keys = portalKeys(v, stored);
  if (!keys) return {};
  const email = stored ? v.accountEmail : v.account_email;
  const marker = stored ? v.portalConfirmed : v.account_selection_confirmed;
  const provider = stored ? v.accountProvider : v.account_provider;
  const login = stored ? v.accountLogin : v.account_login;
  if (marker !== true) throw fail("response");
  if (keys.includes(stored ? "accountProvider" : "account_provider")) {
    if (email !== null || provider !== "github" || typeof login !== "string" || !login.length || new TextEncoder().encode(login).byteLength > 100 || /[\s\u0000-\u001f\u007f]/.test(login)) throw fail("response");
    return {accountEmail: null, portalConfirmed: true, accountProvider: "github", accountLogin: login};
  }
  return {accountEmail: accountEmail(email), portalConfirmed: true};
}
function assertOriginalPortal(before: PortalMetadata, after: PortalMetadata): void {
  if (before.portalConfirmed && (after.portalConfirmed !== true || before.accountEmail !== after.accountEmail || before.accountProvider !== after.accountProvider || before.accountLogin !== after.accountLogin)) throw fail("binding");
}
interface Proof { sign_pk: string; kem_pk: string; noise_pk: string; sig: string }
export interface AppInstallationCollectionSelection {
  readonly requestId: string;
  readonly selectedCollectionId: string;
  /** Server-tracked attempt-owned creations, intersected with approved scope.
   * Provenance metadata, not native/current readiness or setup authority. */
  readonly createdCollectionIds: readonly string[];
}
/** Original authenticated consent references, not current CP authority. */
export interface AppInstallationTimerConsent {
  readonly requestId: string;
  readonly approved: boolean;
  /** Only the original explicitly chosen collection is retained. Other public
   * references in the response never authorize future chooser selections. */
  readonly grants: readonly {readonly grantId:string; readonly collectionId:string; readonly declarationDigest:string}[];
}
function timerKeys(value: Record<string,unknown>): string {
  return Object.hasOwn(value,"timer_consent") || Object.hasOwn(value,"timer_grants") ? ",timer_consent,timer_grants" : "";
}
function timerConsent(value: Record<string,unknown>, requestId:string, approved:readonly string[], confirmed:boolean, selected?:string): AppInstallationTimerConsent | undefined {
  if (!timerKeys(value)) return undefined;
  if (![true,false,null].includes(value.timer_consent as boolean|null) || !Array.isArray(value.timer_grants) || value.timer_grants.length>1000) throw fail("response");
  const grants=value.timer_grants.map(item=>{
    const row=object(item,"grant_id,collection_id,declaration_digest"),collectionId=id(row.collection_id);
    if (!approved.includes(collectionId)) throw fail("response");
    return Object.freeze({grantId:id(row.grant_id),collectionId,declarationDigest:text(row.declaration_digest,/^[0-9a-f]{64}$/)});
  });
  if (new Set(grants.map(grant=>grant.grantId)).size!==grants.length || new Set(grants.map(grant=>grant.collectionId)).size!==grants.length
    || (value.timer_consent===true ? !confirmed || !selected || !grants.some(grant=>grant.collectionId===selected) : grants.length!==0)
    || new Set(grants.map(grant=>grant.declarationDigest)).size>1) throw fail("response");
  // Omission is neither approval nor withdrawal: retain ORIGINAL consent,
  // never inherit it into the newly approved collection scope.
  return value.timer_consent===null ? undefined : Object.freeze({requestId,approved:value.timer_consent===true,grants:Object.freeze(grants.filter(grant=>grant.collectionId===selected))});
}
/** Protected channel operation metadata. Target/token bytes are never retained. */
export interface AppInstallationTimerChannel {
  readonly grantId:string; readonly kind:"web_push"|"fcm"; readonly targetDigest:string;
  readonly channelId:string|null; readonly pending:"register"|"delete"|null;
}
function timerChannel(value:unknown):AppInstallationTimerChannel {
  const row=object(value,"grantId,kind,targetDigest,channelId,pending");
  if(!["web_push","fcm"].includes(row.kind as string) || ![null,"register","delete"].includes(row.pending as null|"register"|"delete")
    || (row.channelId===null && row.pending!=="register"))throw fail("response");
  return Object.freeze({grantId:id(row.grantId),kind:row.kind as "web_push"|"fcm",targetDigest:text(row.targetDigest,/^[0-9a-f]{64}$/),
    channelId:row.channelId===null?null:id(row.channelId),pending:row.pending as null|"register"|"delete"});
}
interface ConsentRequest extends PortalMetadata {
  requestId: string; secret: string; requestedCreateCollections: boolean;
  challenge: string | null; completed: boolean;
  addedCollectionIds: string[]; approvedCreateCollections: boolean;
}
interface State {
  version: 3; requestId: string; installationId: string; deviceId: string; secret: string;
  renewal: {requestId: string; secret: string} | null;
  requestedCreateCollections: boolean; collectionIds: string[]; createCollections: boolean;
  consentRequest: ConsentRequest | null;
  collectionSelection?: AppInstallationCollectionSelection;
  timerConsent?: AppInstallationTimerConsent;
  timerChannel?: AppInstallationTimerChannel;
  appId: string; kind: "app-runtime" | "mobile";
  origin: string; cpOrigin: string; environment: string;
  selection: Selection | null; confirmed: boolean; nativeStarted: boolean; proof: Proof | null; token: string | null;
}
export interface AppInstallationSignInOptions extends AppInstallationStoreOptions {
  /** Expected registered display name, compared exactly with CP responses. */
  readonly appName: string;
  /** SAME authenticated bundled release environment; not runtime discovery. */
  readonly environment: "lab" | "staging" | "production";
  readonly fetch?: typeof fetch;
  /** Explicit first-run request, committed before START. Omit to retain an
   * existing request; false is the default for a fresh installation. */
  readonly requestedCreateCollections?: boolean;
  /** Explicit next-app build selection; absent retains the frozen original
   * environment/origin policy, never selects a new origin implicitly. */
  readonly environmentSelection?: AppEnvironmentSelection;
}
export interface AppInstallationCollectionConsentView {
  readonly requestId: string;
  readonly verificationUri: string;
  readonly state: "pending" | "scope_updated";
  readonly requestedCreateCollections: boolean;
  readonly addedCollectionIds: readonly string[];
  readonly approvedCreateCollections: boolean;
  readonly accountEmail?: string | null;
  readonly accountProvider?: "github";
  readonly accountLogin?: string;
  readonly accountSelectionConfirmed?: boolean;
}
export interface AppInstallationCollection {
  readonly collectionId: string;
  readonly displayName: string;
  readonly role: "owner" | "editor" | "viewer";
}
export interface AppInstallationSignInView {
  readonly requestId: string; readonly installationId: string; readonly deviceId: string;
  readonly appId: string; readonly kind: "app-runtime" | "mobile";
  readonly verificationUri: string;
  readonly state: "pending" | "account_selected" | "account_confirmed" | "awaiting_approval" | "paired";
  /** Account namespace authority, not a display label. Explicit user account
   * confirmation (guarded portal choice or manual legacy confirmation) must
   * precede ANY account-scoped KEK/native custody. */
  readonly accountId: string | null;
  /** Authenticated portal display metadata only, never custody/namespace input. */
  readonly accountEmail?: string | null;
  readonly accountProvider?: "github";
  readonly accountLogin?: string;
  readonly collectionSelection?: AppInstallationCollectionSelection | null;
  readonly timerConsent?: AppInstallationTimerConsent | null;
  /** Consent metadata only; current CP/native authority is checked per request. */
  readonly collectionIds: readonly string[];
  readonly createCollections: boolean;
  readonly requestedCreateCollections: boolean;
}
/** Owns pre-account origin slot and original secret capability, not the account
 * installation/native lease. User account confirmation + actual installation
 * acquisition both precede keys. Close native/Workers before closing this flow. */
/** Transient START metadata: Connect may preselect this collection if the
 * confirmed account can approve it. Never persisted, never consent. */
export interface AppInstallationStartOptions {readonly collectionHint?: string | null}
function collectionHint(options: AppInstallationStartOptions): string | null {
  const hint = options.collectionHint ?? null;
  if (hint !== null && (typeof hint !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(hint) || hint === "00000000-0000-0000-0000-000000000000")) throw fail("binding");
  return hint;
}
/** The exact returned URI: the plain pairing URI or, from a Connect with hint
 * support, the same URI carrying exactly the requested hint. */
function verificationUri(value: unknown, base: string, hint: string | null): string | null {
  return value === base || (hint !== null && value === `${base}?collection_hint=${hint}`) ? value as string : null;
}
export class AppProtectedInstallationSignIn {
  private closed = false;
  private busy = false;
  private expiredRequestId: string | null = null;
  private readonly lifetime = new AbortController();
  private readonly request: typeof fetch;
  private readonly parent: AbortSignal;
  private readonly onAbort = () => { void this.close(); };
  private constructor(private readonly store: AppInstallationStore, private state: State, private readonly options: Readonly<AppInstallationSignInOptions>) {
    this.request = options.fetch ?? ((input, init) => globalThis.fetch(input, init)); this.parent = options.signal;
    this.parent.addEventListener("abort", this.onAbort, {once: true}); this.check();
  }
  static async open(options: AppInstallationSignInOptions): Promise<AppProtectedInstallationSignIn> {
    const p = Object.freeze({...options}); let opened: Awaited<ReturnType<typeof AppInstallationStore.open>> | null = null;
    try {
      if (!["lab", "staging", "production"].includes(p.environment) || !isAppInstallationId(p.appId) ||
          typeof p.appName !== "string" || !p.appName.length || p.appName.length > 100 || p.appName.trim() !== p.appName) throw fail("binding");
      // Browser host only. Capacitor OS custody and per-environment mobile origins
      // are not qualified here; do not silently use web storage for mobile.
      const selection = p.environmentSelection;
      if (p.requestedCreateCollections !== undefined && typeof p.requestedCreateCollections !== "boolean") throw fail("binding");
      if (selection !== undefined) {
        if (!isAppEnvironmentSelection(selection) || selection.environment !== p.environment ||
            selection.appOrigin !== p.origin || selection.cpOrigin !== p.cpOrigin ||
            (p.allowLoopbackHttp === true && !selection.allowLoopbackHttp)) throw fail("binding");
      }
      // The application supplies its exact origin; the origin-bound store and
      // CP registry authorize it. No brand-specific client allowlist.
      opened = await AppInstallationStore.open({...p, allowLoopbackHttp: selection?.allowLoopbackHttp ?? p.allowLoopbackHttp}, () => {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        try {
          const secret = `pair_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
          return new TextEncoder().encode(JSON.stringify({version: 3, renewal: null, requestedCreateCollections: p.requestedCreateCollections ?? false, collectionIds: [], createCollections: false, consentRequest: null, requestId: crypto.randomUUID(), installationId: crypto.randomUUID(), deviceId: crypto.randomUUID(), secret, appId: p.appId, kind: "app-runtime", origin: p.origin, cpOrigin: p.cpOrigin, environment: p.environment, selection: null, confirmed: false, nativeStarted: false, proof: null, token: null} satisfies State));
        } finally { bytes.fill(0); }
      });
      const state = this.decode(opened.plaintext, p);
      return new AppProtectedInstallationSignIn(opened.store, state, p);
    } catch (e) { await opened?.store.close(); if (e instanceof AppInstallationSignInError) throw e; if (e instanceof AppInstallationStorageError && e.reason === "busy") throw fail("busy"); throw fail("recovery_required"); }
    finally { opened?.plaintext.fill(0); }
  }
  private static decode(bytes: Uint8Array, p: Readonly<AppInstallationSignInOptions>): State {
    const parsed = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
    const base = "version,requestId,installationId,deviceId,secret,appId,kind,origin,cpOrigin,environment,selection,confirmed,nativeStarted,proof,token";
    const legacy = parsed?.version === 1;
    const fields = `${base},requestedCreateCollections,collectionIds,createCollections,consentRequest`;
    const r = legacy ? {...object(parsed, base), version: 3, renewal: null, requestedCreateCollections: false, collectionIds: [], createCollections: false, consentRequest: null}
      : parsed?.version === 2 ? {...object(parsed, fields), version: 3, renewal: null}
      : object(parsed, `${fields},renewal${Object.hasOwn(parsed, "collectionSelection") ? ",collectionSelection" : ""}${Object.hasOwn(parsed,"timerConsent") ? ",timerConsent" : ""}${Object.hasOwn(parsed,"timerChannel") ? ",timerChannel" : ""}`);
    if (r.version !== 3 || r.appId !== p.appId || r.kind !== "app-runtime" || r.origin !== p.origin || r.cpOrigin !== p.cpOrigin || r.environment !== p.environment || typeof r.confirmed !== "boolean" || typeof r.nativeStarted !== "boolean") throw fail("recovery_required");
    const s = r as unknown as State;
    if (typeof s.requestedCreateCollections !== "boolean" || typeof s.createCollections !== "boolean" ||
        (p.requestedCreateCollections !== undefined && p.requestedCreateCollections !== s.requestedCreateCollections)) throw fail("binding");
    s.collectionIds = this.collectionIds(s.collectionIds);
    if (s.consentRequest !== null) {
      const c = object(s.consentRequest, `requestId,secret,requestedCreateCollections,challenge,completed,addedCollectionIds,approvedCreateCollections${portalKeys(s.consentRequest, true)}`);
      portalMetadata(c, true);
      id(c.requestId); text(c.secret, /^pair_[A-Za-z0-9_-]{43}$/);
      if (c.requestId === s.requestId || c.secret === s.secret || typeof c.requestedCreateCollections !== "boolean" || typeof c.completed !== "boolean" || typeof c.approvedCreateCollections !== "boolean" || (c.approvedCreateCollections && !c.requestedCreateCollections)) throw fail("recovery_required");
      if (c.challenge !== null) text(c.challenge, /^[0-9a-f]{64}$/);
      this.collectionIds(c.addedCollectionIds);
      if (!s.token || !s.selection || (c.completed && c.challenge === null)) throw fail("recovery_required");
    }
    if ((s.createCollections && !s.token) || (s.collectionIds.length && !s.token)) throw fail("recovery_required");
    if (s.collectionSelection !== undefined) {
      const c = object(s.collectionSelection, "requestId,selectedCollectionId,createdCollectionIds");
      id(c.requestId); if (!s.token || !s.collectionIds.includes(id(c.selectedCollectionId)) || this.collectionIds(c.createdCollectionIds).some(v => !s.collectionIds.includes(v))) throw fail("recovery_required");
    }
    id(s.requestId); id(s.installationId); id(s.deviceId); text(s.secret, /^pair_[A-Za-z0-9_-]{43}$/);
    if (s.renewal !== null) {
      const r = object(s.renewal, "requestId,secret"); id(r.requestId); text(r.secret, /^pair_[A-Za-z0-9_-]{43}$/);
      if (r.requestId === s.requestId || r.secret === s.secret) throw fail("recovery_required");
    }
    if(s.timerChannel!==undefined) {
      if(!s.token || !s.selection)throw fail("recovery_required");
      try{s.timerChannel=timerChannel(s.timerChannel);}catch{throw fail("recovery_required");}
    }
    if (s.timerConsent !== undefined) {
      const receipt=object(s.timerConsent,"requestId,approved,grants"); id(receipt.requestId);
      if (!s.token || !s.selection || typeof receipt.approved!=="boolean" || !Array.isArray(receipt.grants) || receipt.grants.length>1) throw fail("recovery_required");
      const grants=receipt.grants.map(grant=>{
        const row=object(grant,"grantId,collectionId,declarationDigest");
        return {grant_id:row.grantId,collection_id:row.collectionId,declaration_digest:row.declarationDigest};
      });
      // Original timer approval may precede later omitted reconsent attempts;
      // UUID/scope/protected receipt remain original, never reconstructed.
      const confirmed=s.selection.portalConfirmed===true || s.consentRequest?.portalConfirmed===true;
      s.timerConsent=timerConsent({timer_consent:receipt.approved,timer_grants:grants},id(receipt.requestId),s.collectionIds,confirmed,grants[0]?.collection_id as string|undefined);
    }
    if (s.selection !== null) {
      const v = object(s.selection, `accountId,connectorId,challenge,approvalMode${portalKeys(s.selection, true)}`); id(v.accountId); id(v.connectorId); text(v.challenge, /^[0-9a-f]{64}$/); if (v.approvalMode !== "password-ak1") throw fail("response");
      portalMetadata(v, true);
    }
    if (s.proof !== null) this.proof(s.proof);
    if (s.token !== null) text(s.token, /^idev_[A-Za-z0-9_-]{43}$/);
    if ((s.confirmed && !s.selection) || (s.nativeStarted && !s.confirmed) || (s.proof && !s.nativeStarted) || (s.token && !s.proof)) throw fail("recovery_required");
    return s;
  }
  private static collectionIds(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > 1000) throw fail("response");
    const ids = value.map(id);
    if (new Set(ids).size !== ids.length) throw fail("response");
    return ids;
  }
  private static proof(value: unknown): Proof {
    const r = object(value, "sign_pk,kem_pk,noise_pk,sig");
    return {sign_pk: text(r.sign_pk, /^[0-9a-f]{64}$/), kem_pk: text(r.kem_pk, /^[0-9a-f]{64}$/), noise_pk: text(r.noise_pk, /^[0-9a-f]{64}$/), sig: text(r.sig, /^[0-9a-f]{128}$/)};
  }
  isCurrent(): boolean { return !this.closed && !this.parent.aborted && !this.lifetime.signal.aborted && this.store.isCurrent(); }
  private check(): void { if (!this.isCurrent()) throw fail("fenced"); }
  view(): AppInstallationSignInView {
    this.check(); const s = this.state, identity = s.consentRequest?.portalConfirmed ? s.consentRequest : s.selection;
    return Object.freeze({requestId: s.requestId, installationId: s.installationId, deviceId: s.deviceId, appId: s.appId, kind: s.kind, verificationUri: `${s.cpOrigin}/pair/${s.requestId}`, state: s.token ? "paired" : s.proof ? "awaiting_approval" : s.confirmed ? "account_confirmed" : s.selection ? "account_selected" : "pending", accountId: s.selection?.accountId ?? null, accountEmail: identity?.accountEmail ?? null, ...(identity?.accountProvider ? {accountProvider: identity.accountProvider, accountLogin: identity.accountLogin!} : {}), collectionSelection: s.collectionSelection ? Object.freeze({...s.collectionSelection, createdCollectionIds: Object.freeze([...s.collectionSelection.createdCollectionIds])}) : null, ...(s.timerConsent ? {timerConsent:s.timerConsent} : {}), collectionIds: Object.freeze([...s.collectionIds]), createCollections: s.createCollections, requestedCreateCollections: s.requestedCreateCollections});
  }
  /** Persist before exposing changed selection/proof/credential or native ACK. */
  private async save(next: State): Promise<void> {
    this.check(); const bytes = new TextEncoder().encode(JSON.stringify(next));
    try { await this.store.commit(bytes); this.check(); this.state = next; }
    catch { await this.close(); throw fail("recovery_required"); }
    finally { bytes.fill(0); }
  }
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    this.check(); if (this.busy) throw fail("busy"); this.busy = true;
    try { return await work(); } finally { this.busy = false; }
  }
  /** Single bounded request, no cookie, redirect, ambient auth or automatic retry.
   * A network failure may have committed: only explicit SAME-request reconcile. */
  private async json(path: string, secret: boolean, body?: unknown, auth?: {bearer: string; get?: boolean; patch?: boolean}): Promise<{status: number; value: Record<string, unknown>}> {
    this.check(); const ctrl = new AbortController(), abort = () => ctrl.abort(), timer = setTimeout(abort, 15000);
    this.lifetime.signal.addEventListener("abort", abort, {once: true});
    let response: Response | null = null, reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    // Scoped metadata may contain 1000 UUIDs; discovery additionally contains
    // bounded names. Reject oversize before accumulating/parsing the body.
    const bytes = new Uint8Array(auth?.get || path.endsWith("/exchange") ? 1024 * 1024 : 64 * 1024); let count = 0;
    try {
      response = await this.request(`${this.state.cpOrigin}${path}`, {method: auth?.get ? "GET" : auth?.patch ? "PATCH" : "POST", headers: {...(auth ? {authorization: `Bearer ${auth.bearer}`} : secret ? {authorization: `Bearer ${this.state.secret}`} : {}), ...(body === undefined ? {} : {"content-type": "application/json"})}, body: body === undefined ? undefined : JSON.stringify(body), credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer", signal: ctrl.signal});
      this.check(); if (ctrl.signal.aborted) throw fail("outcome_unknown");
      const length = response.headers.get("content-length");
      // Fetch decodes content-encoding, which CORS may hide. Wire length is
      // only an early over-cap hint; the decoded stream is the hard bound.
      if (length !== null && /^(0|[1-9][0-9]*)$/.test(length) && Number(length) > bytes.length) {ctrl.abort(); throw fail("response");}
      if (!response.body) throw fail("response"); reader = response.body.getReader();
      for (;;) {
        const {done, value} = await reader.read();
        try { this.check(); if (ctrl.signal.aborted) throw fail("outcome_unknown"); if (done) break; if (count + value.length > bytes.length) {ctrl.abort(); throw fail("response");} bytes.set(value, count); count += value.length; } finally { value?.fill(0); }
      }
      const value: unknown = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes.subarray(0, count)));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("response");
      if (!response.ok) {
        const error = (value as Record<string, unknown>).error;
        if (!auth && response.status === 404 &&
            (path === "/v1/pairing-requests" || path === `/v1/pairing-requests/${this.state.requestId}/exchange` || path === `/v1/pairing-requests/${this.state.requestId}/attest`) &&
            error && typeof error === "object" && !Array.isArray(error) && (error as Record<string,unknown>).code === "installation_pairing_expired") {
          this.expiredRequestId = this.state.requestId;
          throw fail("expired");
        }
        throw fail("refused");
      }
      return {status: response.status, value: value as Record<string, unknown>};
    } catch (e) { this.check(); if (e instanceof AppInstallationSignInError) throw e; throw fail("outcome_unknown"); }
    finally { bytes.fill(0); void (reader?.cancel() ?? response?.body?.cancel())?.catch(() => {}); reader?.releaseLock(); clearTimeout(timer); this.lifetime.signal.removeEventListener("abort", abort); }
  }
  /** Original operation+secret already committed before this FIRST HTTP. An
   * explicit repeat uses the same request, never a new installation/device. */
  start(options: AppInstallationStartOptions = {}): Promise<AppInstallationSignInView> {
    let hint: string | null; try { hint = collectionHint(options); } catch (error) { return Promise.reject(error); }
    return this.exclusive(() => this.startRequest(hint));
  }
  /** Explicit user retry after an exact typed expiry. Renew ONLY the pairing
   * window; installation/device/account/challenge/keys/proof remain original.
   * Persist the new request and its parent capability BEFORE HTTP. Unknown
   * outcomes resume that SAME new request via start(), never renew again. */
  renewExpiredPairing(): Promise<AppInstallationSignInView> {
    return this.exclusive(async () => {
      const s = this.state;
      if (s.token || this.expiredRequestId !== s.requestId) throw fail("recovery_required");
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      try {
        const requestId = crypto.randomUUID(), secret = `pair_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
        if (requestId === s.requestId || requestId === s.renewal?.requestId || secret === s.secret) throw fail("binding");
        await this.save({...s, requestId, secret, renewal: {requestId:s.requestId, secret:s.secret}});
        this.expiredRequestId = null;
        return await this.startRequest();
      } finally { bytes.fill(0); }
    });
  }
  private async startRequest(hint: string | null = null): Promise<AppInstallationSignInView> {
      if (this.state.token) return this.view(); const s = this.state;
      const {status, value: v} = await this.json("/v1/pairing-requests", false, {installation: {app_id: s.appId, request_id: s.requestId, pairing_secret: s.secret, installation_id: s.installationId, device_id: s.deviceId, kind: s.kind, requested_create_collections: s.requestedCreateCollections, ...(s.renewal ? {renewal:{request_id:s.renewal.requestId, pairing_secret:s.renewal.secret}} : {})}, ...(hint ? {collection_hint: hint} : {})});
      if (status !== 200 && status !== 201) throw fail("response");
      object(v, "pairing_id,pairing_secret,verification_uri,expires_in,installation_device,app_id,app_origin,app_name");
      const uri = verificationUri(v.verification_uri, `${s.cpOrigin}/pair/${s.requestId}`, hint);
      if (v.pairing_id !== s.requestId || v.pairing_secret !== s.secret || uri === null || v.installation_device !== true || v.app_id !== s.appId || v.app_origin !== s.origin || v.app_name !== this.options.appName || !Number.isSafeInteger(v.expires_in) || (v.expires_in as number) < 0 || (v.expires_in as number) > 600) throw fail("response");
      this.expiredRequestId = null;
      return Object.freeze({...this.view(), verificationUri: uri});
  }
  private selected(v: Record<string, unknown>): Selection {
    const s = this.state;
    if (v.request_id !== s.requestId || v.installation_id !== s.installationId || v.device_id !== s.deviceId || v.kind !== s.kind || v.app_id !== s.appId || v.app_origin !== s.origin || v.approval_mode !== "password-ak1" || !Number.isSafeInteger(v.expires_at) || (v.expires_at as number) < 0) throw fail("response");
    const next: Selection = {accountId: id(v.account_id), connectorId: id(v.connector_id), challenge: text(v.challenge, /^[0-9a-f]{64}$/), approvalMode: "password-ak1"};
    if (s.selection && (next.accountId !== s.selection.accountId || next.connectorId !== s.selection.connectorId || next.challenge !== s.selection.challenge || next.approvalMode !== s.selection.approvalMode)) throw fail("binding");
    Object.assign(next, portalMetadata(v));
    if (s.selection) assertOriginalPortal(s.selection, next);
    return next;
  }
  /** No account KEK/native opens here. The SDK-owned selection must be explicitly
   * confirmed by guarded portal choice or manual legacy confirmation before
   * confirmedSelection/attestation is permitted. */
  exchange(): Promise<AppInstallationSignInView> {
    return this.exclusive(async () => {
      if (this.state.token) return this.view();
      const {status, value: v} = await this.json(`/v1/pairing-requests/${this.state.requestId}/exchange`, true);
      if (v.status === "pending") { object(v, "status"); if (status !== 202 || this.state.selection) throw fail("response"); return this.view(); }
      const keys = `status,request_id,account_id,connector_id,device_id,installation_id,kind,challenge,approval_mode,app_id,app_origin,expires_at${portalKeys(v)}`;
      if (v.status === "account_selected" || v.status === "awaiting_approval") {
        object(v, keys); if (status !== 202 || (v.status === "awaiting_approval" && !this.state.proof)) throw fail("response");
        const selection = this.selected(v); if (JSON.stringify(selection) !== JSON.stringify(this.state.selection)) await this.save({...this.state, selection}); return this.view();
      }
      // Pre-C5 receipts give NO scope; never infer access from old enrollment.
      const scoped = Object.hasOwn(v, "collection_ids") || Object.hasOwn(v, "create_collections");
      const picked = Object.hasOwn(v, "selected_collection_id") || Object.hasOwn(v, "created_collection_ids");
      object(v, `${keys},connector,token,registration${scoped ? ",collection_ids,create_collections" : ""}${picked ? ",selected_collection_id,created_collection_ids" : ""}${timerKeys(v)}`); if (status !== 200 || v.status !== "paired" || !this.state.confirmed || !this.state.proof) throw fail("response");
      const selection = this.selected(v), connector = object(v.connector, "id,name"), r = object(v.registration, "device_id,sign_pk,kem_pk,noise_pk");
      if (connector.id !== selection.connectorId || connector.name !== this.options.appName || r.device_id !== this.state.deviceId || r.sign_pk !== this.state.proof.sign_pk || r.kem_pk !== this.state.proof.kem_pk || r.noise_pk !== this.state.proof.noise_pk) throw fail("binding");
      const collectionIds = scoped ? AppProtectedInstallationSignIn.collectionIds(v.collection_ids) : [];
      const createCollections = scoped ? v.create_collections : false;
      if (typeof createCollections !== "boolean" || (createCollections && !this.state.requestedCreateCollections)) throw fail("response");
      const collectionSelection = picked ? this.collectionSelection(v, collectionIds, this.state.requestId) : undefined;
      if (v.timer_consent===true && !collectionSelection) throw fail("response");
      const reminder=timerConsent(v,this.state.requestId,collectionIds,selection.portalConfirmed===true,collectionSelection?.selectedCollectionId);
      const token = text(v.token, /^idev_[A-Za-z0-9_-]{43}$/); await this.save({...this.state, selection, token, collectionIds, createCollections, ...(collectionSelection ? {collectionSelection} : {}), ...(reminder ? {timerConsent:reminder} : {})}); return this.view();
    });
  }
  private collectionSelection(v: Record<string, unknown>, approved: readonly string[], requestId: string): AppInstallationCollectionSelection {
    const selectedCollectionId = id(v.selected_collection_id), createdCollectionIds = AppProtectedInstallationSignIn.collectionIds(v.created_collection_ids);
    if (!approved.includes(selectedCollectionId) || createdCollectionIds.some(value => !approved.includes(value))) throw fail("response");
    return Object.freeze({requestId, selectedCollectionId, createdCollectionIds: Object.freeze(createdCollectionIds)});
  }
  collectionConsentView(): AppInstallationCollectionConsentView | null {
    this.check(); const r = this.state.consentRequest;
    return r ? Object.freeze({requestId: r.requestId, verificationUri: `${this.state.cpOrigin}/pair/${r.requestId}`, state: r.completed ? "scope_updated" : "pending", requestedCreateCollections: r.requestedCreateCollections, addedCollectionIds: Object.freeze([...r.addedCollectionIds]), approvedCreateCollections: r.approvedCreateCollections, accountEmail: r.accountEmail ?? null, ...(r.accountProvider ? {accountProvider: r.accountProvider, accountLogin: r.accountLogin!} : {}), accountSelectionConfirmed: r.portalConfirmed === true}) : null;
  }
  private consentGuard(installation: AppInstallationCustodyAuthority): () => void {
    const callback = installation.isCurrent;
    return () => { this.check(); this.owned(installation); this.receipt(); if (installation.isCurrent !== callback) throw fail("fenced"); };
  }
  /** Explicit additive consent, not renewal/registration/account selection.
   * A new secret/request is protected BEFORE HTTP; unknown outcomes only permit
   * an explicit repeat of that exact request, never new keys or a new actor. */
  startCollectionConsent(installation: AppInstallationCustodyAuthority, requestedCreateCollections = false, options: AppInstallationStartOptions = {}): Promise<AppInstallationCollectionConsentView> {
    const check = this.consentGuard(installation);
    let hint: string | null; try { hint = collectionHint(options); } catch (error) { return Promise.reject(error); }
    return this.exclusive(async () => {
      check(); if (typeof requestedCreateCollections !== "boolean") throw fail("binding");
      let r = this.state.consentRequest;
      if (!r || r.completed) {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        try {
          const secret = `pair_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
          r = {requestId: crypto.randomUUID(), secret, requestedCreateCollections, challenge: null, completed: false, addedCollectionIds: [], approvedCreateCollections: false};
          await this.save({...this.state, consentRequest: r}); check();
        } finally { bytes.fill(0); }
      } else if (r.requestedCreateCollections !== requestedCreateCollections) throw fail("binding");
      const s = this.state, token = s.token!;
      const {status, value: v} = await this.json("/v1/pairing-requests", false, {installation: {app_id: s.appId, request_id: r.requestId, pairing_secret: r.secret, installation_id: s.installationId, device_id: s.deviceId, kind: s.kind, requested_create_collections: r.requestedCreateCollections, reconsent: true}, ...(hint ? {collection_hint: hint} : {})}, {bearer: token}); check();
      object(v, "pairing_id,pairing_secret,verification_uri,expires_in,installation_device,app_id,app_origin,app_name");
      let uri: string | null = null;
      if ((status !== 200 && status !== 201) || v.pairing_id !== r.requestId || v.pairing_secret !== r.secret || (uri = verificationUri(v.verification_uri, `${s.cpOrigin}/pair/${r.requestId}`, hint)) === null || v.installation_device !== true || v.app_id !== s.appId || v.app_origin !== s.origin || v.app_name !== this.options.appName || !Number.isSafeInteger(v.expires_in) || (v.expires_in as number) < 0 || (v.expires_in as number) > 600 || token !== this.state.token) throw fail("response");
      return Object.freeze({...this.collectionConsentView()!, verificationUri: uri!});
    });
  }
  /** The ORIGINAL consent-request secret consumes approval. Strict response
   * keys forbid replacement tokens/registrations; original actor/proof remains. */
  exchangeCollectionConsent(installation: AppInstallationCustodyAuthority): Promise<AppInstallationCollectionConsentView> {
    const check = this.consentGuard(installation);
    return this.exclusive(async () => {
      check(); const r = this.state.consentRequest, s = this.state;
      if (!r) throw fail("binding"); if (r.completed) return this.collectionConsentView()!;
      const {status, value: v} = await this.json(`/v1/pairing-requests/${r.requestId}/exchange`, false, undefined, {bearer: r.secret}); check();
      const portal = portalKeys(v);
      const keys = `status,request_id,account_id,connector_id,device_id,installation_id,kind,challenge,approval_mode,app_id,app_origin,expires_at${portal}`;
      const done = v.status === "scope_updated";
      const picked = done && (Object.hasOwn(v, "selected_collection_id") || Object.hasOwn(v, "created_collection_ids"));
      object(v, `${keys}${done ? ",added_collection_ids,approved_create_collections" : ""}${picked ? ",selected_collection_id,created_collection_ids" : ""}${done ? timerKeys(v) : ""}`);
      if ((!done && (status !== 202 || v.status !== "awaiting_approval")) || (done && status !== 200) || v.request_id !== r.requestId || v.account_id !== s.selection!.accountId || v.connector_id !== s.selection!.connectorId || v.device_id !== s.deviceId || v.installation_id !== s.installationId || v.kind !== s.kind || v.app_id !== s.appId || v.app_origin !== s.origin || v.approval_mode !== s.selection!.approvalMode || !Number.isSafeInteger(v.expires_at) || (v.expires_at as number) < 0) throw fail("binding");
      const confirmation = portalMetadata(v);
      if (r.portalConfirmed && !portal) throw fail("response");
      assertOriginalPortal(r, confirmation);
      const challenge = text(v.challenge, /^[0-9a-f]{64}$/);
      if (r.challenge !== null && r.challenge !== challenge) throw fail("binding");
      if (!done) { if (r.challenge === null || (portal && !r.portalConfirmed)) await this.save({...s, consentRequest: {...r, ...confirmation, challenge}}); check(); return this.collectionConsentView()!; }
      const addedCollectionIds = AppProtectedInstallationSignIn.collectionIds(v.added_collection_ids);
      if (typeof v.approved_create_collections !== "boolean" || (v.approved_create_collections && !r.requestedCreateCollections)) throw fail("response");
      const collectionIds = AppProtectedInstallationSignIn.collectionIds([...new Set([...s.collectionIds, ...addedCollectionIds])]);
      const collectionSelection = picked ? this.collectionSelection(v, collectionIds, r.requestId) : undefined;
      if (v.timer_consent===true && !collectionSelection) throw fail("response");
      const reminder=timerConsent(v,r.requestId,addedCollectionIds,confirmation.portalConfirmed===true,collectionSelection?.selectedCollectionId);
      await this.save({...s, collectionIds, ...(collectionSelection ? {collectionSelection} : {}), ...(reminder ? {timerConsent:reminder} : {}), createCollections: s.createCollections || v.approved_create_collections, consentRequest: {...r, ...confirmation, challenge, completed: true, addedCollectionIds, approvedCreateCollections: v.approved_create_collections}}); check();
      return this.collectionConsentView()!;
    });
  }
  /** Current approved/member cloud-copy metadata only; never readiness, keying,
   * or permission inferred from this response or retained consent snapshots. */
  listApprovedCollections(installation: AppInstallationCustodyAuthority): Promise<readonly AppInstallationCollection[]> {
    const check = this.consentGuard(installation);
    return this.exclusive(async () => {
      check(); const {status, value: v} = await this.json("/v1/next/collections", false, undefined, {bearer: this.state.token!, get: true}); check();
      object(v, "collections"); if (status !== 200 || !Array.isArray(v.collections) || v.collections.length > 1000) throw fail("response");
      const seen = new Set<string>();
      return Object.freeze(v.collections.map(value => {
        const r = object(value, "collection_id,display_name,role"), collectionId = id(r.collection_id);
        if (seen.has(collectionId) || typeof r.display_name !== "string" || !r.display_name.length || r.display_name.length > 1024 || (r.role !== "owner" && r.role !== "editor" && r.role !== "viewer")) throw fail("response");
        seen.add(collectionId); return Object.freeze({collectionId, displayName: r.display_name, role: r.role});
      }));
    });
  }
  /** Fresh explicit user intent only. CP owner/approved scope remains authoritative;
   * private installation consent is not widened. Names are cleartext metadata,
   * not paths or native readiness. No CAS/request ledger or automatic retry:
   * a lost response is UNKNOWN; refresh catalog, never infer commit from equality.
   */
  renameApprovedCollection(installation: AppInstallationCustodyAuthority, collectionId: string, displayName: string): Promise<Readonly<{collectionId: string; displayName: string}>> {
    // Capture/validate caller input synchronously, before exclusive/HTTP awaits.
    let name: string;
    try { id(collectionId); name = collectionDisplayName(displayName); } catch { return Promise.reject(fail("binding")); }
    const check = this.consentGuard(installation);
    return this.exclusive(async () => {
      check(); if (!this.state.collectionIds.includes(collectionId)) throw fail("refused");
      const {status, value} = await this.json(`/v1/next/collections/${collectionId}/name`, false, {display_name: name}, {bearer: this.state.token!, patch: true}); check();
      const response = object(value, "collection_id,display_name");
      if (status !== 200 || response.collection_id !== collectionId || response.display_name !== name) throw fail("response");
      return Object.freeze({collectionId, displayName: name});
    });
  }
  /** Consume only this object's protected current portal-confirmed selection.
   * The CP marker comes from an explicit authenticated portal account choice,
   * bound to the original request secret/app/origin/actor/challenge. Identity is
   * display metadata. This grants no collection scope and bypasses no final CP
   * approval, original native ownership or attestation requirement. */
  confirmPortalSelectedAccount(): Promise<AppInstallationSignInView> {
    return this.exclusive(async () => {
      const selection = this.state.selection;
      if (!selection?.portalConfirmed) throw fail("account_confirmation_required");
      if (!this.state.confirmed) await this.save({...this.state, confirmed: true});
      this.check(); if (this.state.selection !== selection) throw fail("binding");
      return this.view();
    });
  }
  confirmSelectedAccount(accountId: string): Promise<AppInstallationSignInView> {
    return this.exclusive(async () => { if (!this.state.selection || accountId !== this.state.selection.accountId) throw fail("binding"); if (!this.state.confirmed) await this.save({...this.state, confirmed: true}); return this.view(); });
  }
  confirmedSelection(): Readonly<{accountId: string; connectorId: string; installationId: string; deviceId: string; kind: "app-runtime" | "mobile"; cpOrigin: string; approvalMode: "password-ak1"; isCurrent(): boolean}> {
    this.check(); if (!this.state.confirmed || !this.state.selection) throw fail("account_confirmation_required"); const s = this.state, selected = s.selection!;
    return Object.freeze({accountId: selected.accountId, connectorId: selected.connectorId, installationId: s.installationId, deviceId: s.deviceId, kind: s.kind, cpOrigin: s.cpOrigin, approvalMode: selected.approvalMode, isCurrent: () => this.isCurrent()});
  }
  private owned(installation: AppInstallationCustodyAuthority): void {
    const s = this.confirmedSelection(); if (installation.isCurrent() !== true || installation.scope.account !== s.accountId || installation.scope.installation !== s.installationId) throw fail("fenced");
  }
  /** Commit the explicit original native attempt BEFORE KEK/provider/keys/native.
   * Once attempted, even missing/partial stores require EXISTING restore or visible
   * recovery; never infer fresh from a null key/Noise record. */
  prepareOriginalDevice(installation: AppInstallationCustodyAuthority): Promise<Readonly<{mode: "fresh" | "existing"; pin: AppDeviceKeyCustodyPin}>> {
    const callback = installation.isCurrent;
    const current = () => { try { this.check(); this.owned(installation); return installation.isCurrent === callback; } catch { return false; } };
    return this.exclusive(async () => {
      if (!current()) throw fail("fenced");
      const mode = this.state.nativeStarted ? "existing" : "fresh";
      if (!this.state.nativeStarted) await this.save({...this.state, nativeStarted: true});
      if (!current()) throw fail("fenced");
      return Object.freeze({mode, pin: Object.freeze({...this.confirmedSelection(), isCurrent: current, installationOwned: current})});
    });
  }
  /** Fixed native cp-enrol transcript only. Original protected keys/native owner
   * already opened under actual account-install ownership; no generic signer. */
  attest(options: {runtime: AppWasmRuntime; custody: AppNoiseCustodyResult; persistence: AppDeviceCustodyPersistence; installation: AppInstallationCustodyAuthority}): Promise<AppInstallationSignInView> {
    const {runtime, custody, persistence, installation} = options;
    const callback = installation.isCurrent;
    const check = () => { this.check(); this.owned(installation); if (installation.isCurrent !== callback || !runtime.deviceCustodyCurrent(this.confirmedSelection(), custody)) throw fail("fenced"); };
    return this.exclusive(async () => {
      check(); if (!this.state.nativeStarted) throw fail("recovery_required"); if (this.state.token) return this.view();
      if (!this.state.proof) {
        await persistence.pending(new Uint8Array(custody.envelope), {signal: this.lifetime.signal}); check();
        const challenge = Uint8Array.from(this.state.selection!.challenge.match(/../g)!, v => parseInt(v, 16));
        let signature: Uint8Array | null = null;
        try {
          const proof = runtime.signCpEnrol(challenge); signature = proof.signature; check();
          await this.save({...this.state, proof: AppProtectedInstallationSignIn.proof({sign_pk: hex(proof.signPublicKey), kem_pk: hex(proof.kemPublicKey), noise_pk: hex(proof.noisePublicKey), sig: hex(signature)})}); check();
        } finally { challenge.fill(0); signature?.fill(0); }
      }
      const p = this.state.proof!;
      if (p.sign_pk !== hex(custody.signPublicKey) || p.kem_pk !== hex(custody.kemPublicKey) || p.noise_pk !== hex(custody.noisePublicKey)) throw fail("binding");
      const {status, value} = await this.json(`/v1/pairing-requests/${this.state.requestId}/attest`, true, p); check();
      object(value, "ok");
      if (status !== 200 || value.ok !== true) throw fail("response"); return this.view();
    });
  }
  private receipt(): AppDeviceRegistrationReceipt {
    const s = this.state, p = s.proof; this.check(); if (!s.token || !p || !s.selection) throw fail("binding");
    const bytes = (v: string) => Uint8Array.from(v.match(/../g)!, x => parseInt(x, 16));
    return Object.freeze({connectorId: s.selection.connectorId, deviceId: s.deviceId, installationId: s.installationId, signPublicKey: bytes(p.sign_pk), kemPublicKey: bytes(p.kem_pk), noisePublicKey: bytes(p.noise_pk)});
  }
  /** Protect receipt in the SAME Noise custody before the SAME native ACK.
   * Failure preserves the already protected credential for explicit restore. */
  acknowledge(options: {runtime: AppWasmRuntime; custody: AppNoiseCustodyResult; persistence: AppDeviceCustodyPersistence; installation: AppInstallationCustodyAuthority}): Promise<AppDeviceRegistrationReceipt> {
    const {runtime, custody, persistence, installation} = options, callback = installation.isCurrent;
    const check = () => { this.check(); this.owned(installation); if (installation.isCurrent !== callback || !runtime.deviceCustodyCurrent(this.confirmedSelection(), custody)) throw fail("fenced"); };
    return this.exclusive(async () => {
      check(); const r = this.receipt();
      if (hex(r.signPublicKey) !== hex(custody.signPublicKey) || hex(r.kemPublicKey) !== hex(custody.kemPublicKey) || hex(r.noisePublicKey) !== hex(custody.noisePublicKey)) throw fail("binding");
      await persistence.registered(r, {signal: this.lifetime.signal}); check(); runtime.acknowledgeDeviceRegistration(r); check(); return r;
    });
  }
  /** Trusted SAME-host timer composition only. Metadata is not CP authority. */
  originalTimerChannel(grantId:string):AppInstallationTimerChannel|null {
    this.check();this.receipt();
    if(!this.state.timerConsent?.approved || !this.state.timerConsent.grants.some(grant=>grant.grantId===grantId))throw fail("fenced");
    const row=this.state.timerChannel;return row?.grantId===grantId?row:null;
  }
  retainTimerChannel(grantId:string,value:AppInstallationTimerChannel|null):Promise<void> {
    return this.exclusive(async()=>{
      this.originalTimerChannel(grantId);
      if(value!==null && timerChannel(value).grantId!==grantId)throw fail("binding");
      await this.save({...this.state,timerChannel:value===null?undefined:timerChannel(value)});
      this.originalTimerChannel(grantId);
    });
  }
  /** Scoped first-party CP credential callback, never cookies or log bearer.
   * This is installation authority, NOT a keyed/readable/Saved proof. */
  session(logOrigin: string): AppCloudCopyHostSession {
    this.receipt(); return this.confirmedHostSession(logOrigin, this.state.environment);
  }
  /** Internal SAME-owner composition before pairing completes. This conveys only
   * explicitly confirmed account scope: the bearer callback refuses until the
   * exact protected credential exists. No pending scope becomes CP authority. */
  confirmedHostSession(logOrigin: string, environment: string): AppCloudCopyHostSession {
    const selected = this.confirmedSelection();
    if (environment !== this.state.environment) throw fail("binding");
    const u = new URL(logOrigin); if (u.origin !== logOrigin || u.protocol !== "https:" || u.username || u.password) throw fail("binding");
    return Object.freeze({...selected, logOrigin, timerConsent:()=>{this.check();return this.state.timerConsent??null;}, connectorBearer: async ({signal}: {signal: AbortSignal}) => { this.check(); if (signal.aborted || !this.state.token) throw fail("fenced"); return this.state.token; }});
  }
  async close(): Promise<void> {
    if (!this.closed) { this.closed = true; this.lifetime.abort(); this.parent.removeEventListener("abort", this.onAbort); this.state.secret = ""; this.state.token = null; if (this.state.consentRequest) this.state.consentRequest.secret = ""; if (this.state.renewal) this.state.renewal.secret = ""; this.state.renewal = null; }
    await this.store.close();
  }
}
