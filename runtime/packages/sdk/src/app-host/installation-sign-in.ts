/** First-party protected installation sign-in. Internal until SAME original
 * native-owner/cloud-host composition is qualified. No app-grant authority,
 * ambient cookies, automatic polling/renewal or new-actor retry. */
import { boundNativeCompletion, type AppNativeAuthorizationContext, type AppNativePreparation, type AppNativeSelection } from "./native-sign-in.js";
import type { NativeCompletion } from "../app-grant/native-completion.js";
import { parseCollectionAvailability, type CollectionAvailability } from "../collection-availability.js";
import { uuidToBytes } from "../codec.js";
import { LOCAL_APPLICATION_BUILD, localApplicationEnvironment, localApplicationHttpOrigin } from "../application/local-build.js";
import { collectionDisplayName } from "./collection-display-name.js";
import { isAppEnvironmentSelection, type AppEnvironmentSelection } from "./app-environment.js";
import { AppInstallationStore, AppInstallationStorageError, type AppInstallationStoreOptions } from "./installation-store.js";
import { isAppInstallationId, type AppInstallationCustodyAuthority } from "./owner.js";
import type { AppCloudCopyHostSession } from "./cloud-copy-host.js";
import type { AppDeviceCustodyPersistence } from "./device-registration.js";
import type { AppDeviceKeyCustodyPin } from "./device-key-custody.js";
import { appServerOutcome, appServerProblem, type AppServerOutcome, type AppServerProblem } from "./cp-problem.js";
import type { AppNoiseCustodyResult, AppWasmRuntime, AppDeviceRegistrationReceipt } from "./wasm-runtime.js";
export class AppInstallationSignInError extends Error {
  constructor(readonly reason: "binding" | "fenced" | "busy" | "open_in_another_tab" | "account_confirmation_required" | "recovery_account_mismatch" | "outcome_unknown" | "unavailable" | "response" | "refused" | "expired" | "recovery_required" | AppServerOutcome, readonly server?: AppServerProblem) {
    super(`app installation sign-in: ${reason}`); this.name = "AppInstallationSignInError";
  }
}
const fail = (reason: AppInstallationSignInError["reason"]) => new AppInstallationSignInError(reason);
// Preserve definite HTTP status provenance even when its body cannot be parsed.
const nonOkResponses = new WeakSet<AppInstallationSignInError>();
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
/** Strictly parsed CP display/scope metadata, never native readiness. */
function collectionListing(value: unknown): readonly AppInstallationCollection[] {
  if (!Array.isArray(value) || value.length > 1000) throw fail("response");
  const seen = new Set<string>();
  return Object.freeze(value.map(value => {
    const has = (key: string) => value && typeof value === "object" && key in value ? `,${key}` : "";
    const r = object(value, `collection_id,display_name,role${has("availability")}${has("file_actions")}`), collectionId = id(r.collection_id);
    if (seen.has(collectionId) || typeof r.display_name !== "string" || !r.display_name.length || r.display_name.length > 1024 || (r.role !== "owner" && r.role !== "editor" && r.role !== "viewer")) throw fail("response");
    const availability = parseCollectionAvailability(r.availability);
    const allowed = "file_actions" in r ? fileActions(r.file_actions) : null;
    seen.add(collectionId); return Object.freeze({collectionId, displayName: r.display_name, role: r.role, ...(availability ? {availability} : {}), ...(allowed ? {fileActions: allowed} : {})});
  }));
}

interface State {
  version: 3; requestId: string; installationId: string; deviceId: string; secret: string;
  renewal: {requestId: string; secret: string} | null;
  requestedCreateCollections: boolean; collectionIds: string[]; createCollections: boolean;
  consentRequest: ConsentRequest | null;
  collectionSelection?: AppInstallationCollectionSelection;
  nativeAuthorization?: AppNativePreparation & {requestId: string};
  nativeSelection?: AppNativeSelection;
  nativeGrants?: NativeCompletion[];
  /** Last authenticated listing, protected under the SAME completed installation. */
  collectionListing?: unknown;
  /** Retired collection scopes and explicit fresh local installation-slot IDs.
   * References only: never copied credentials, keys, approvals or readiness. */
  collectionRecoveries?: Record<string, string | null>;
  /** Constraint of a fresh scoped recovery slot, not carried consent. */
  recoveryFor?: {accountId: string; collectionId: string};
  timerConsent?: AppInstallationTimerConsent;
  timerChannel?: AppInstallationTimerChannel;
  appId: string; kind: "app-runtime" | "mobile";
  /** Present exactly when the store is owner-labelled; see AppInstallationStoreOptions.owner. */
  owner?: string;
  origin: string; cpOrigin: string; environment: string;
  selection: Selection | null; confirmed: boolean; nativeStarted: boolean; proof: Proof | null; token: string | null;
}
export interface AppInstallationSignInOptions extends AppInstallationStoreOptions {
  /** Expected registered display name, compared exactly with CP responses. */
  readonly appName: string;
  /** SAME authenticated bundled release environment; not runtime discovery. */
  readonly environment: "lab" | "staging" | "production" | "local";
  readonly fetch?: typeof fetch;
  /** Explicit first-run request, committed before START. Omit to retain an
   * existing request; false is the default for a fresh installation. */
  readonly requestedCreateCollections?: boolean;
  /** Create request for a FRESH installation (and its later collection
   * consent requests) when requestedCreateCollections is omitted. A restored
   * ledger keeps its stored request; this never rewrites original terms. */
  readonly freshRequestedCreateCollections?: boolean;
  /** Explicit next-app build selection; absent retains the frozen original
   * environment/origin policy, never selects a new origin implicitly. */
  readonly environmentSelection?: AppEnvironmentSelection;
  /** Pairing kind; "mobile" for Capacitor apps. Bound into the stored request. */
  readonly installationKind?: "app-runtime" | "mobile";
  /** SDK-owned fresh scoped slot. Bound locally before START; account selection
   * and the ordinary new receipt must independently match these constraints. */
  readonly recoveryFor?: Readonly<{accountId: string; collectionId: string}>;
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
  /** Present only when Connect reports it; absent means available. */
  readonly availability?: CollectionAvailability;
  /** Optional file actions the person allowed for this app here. Present
   * only when Connect reports them. A recorded choice the SDK follows; it
   * does not narrow the device's access. */
  readonly fileActions?: readonly AppFileAction[];
  /** SDK-10: `private` for a collection kept on the person's computers and
   * reached through the relay; absent or `cloud_copy` for a hosted one. */
  readonly kind?: "cloud_copy" | "private";
}
export type AppFileAction = "list" | "read" | "add" | "replace" | "move" | "delete";
const FILE_ACTIONS: readonly AppFileAction[] = ["list", "read", "add", "replace", "move", "delete"];
function fileActions(v: unknown, allowed: readonly AppFileAction[] = FILE_ACTIONS, empty = true): readonly AppFileAction[] {
  if (!Array.isArray(v) || v.length > FILE_ACTIONS.length || (!empty && !v.length) || new Set(v).size !== v.length || v.some(a => !allowed.includes(a))) throw fail("response");
  return Object.freeze(FILE_ACTIONS.filter(a => v.includes(a)));
}
/** One at-the-moment-of-use request for optional file actions. Held only in
 * the SDK Worker's memory; never persisted. */
export interface AppInstallationFileAccessRequest {
  readonly requestId: string; readonly secret: string; readonly collectionId: string;
  readonly actions: readonly AppFileAction[]; readonly verificationUri: string; readonly expiresAt: number;
}
export type AppInstallationFileAccessOutcome =
  | {readonly state: "pending"} | {readonly state: "granted"; readonly actions: readonly AppFileAction[]} | {readonly state: "declined"};
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
  /** Published only after original verified OAuth completion AND native custody ACK. */
  readonly nativeSelection?: AppNativeSelection | null;
  readonly nativeGrants?: readonly NativeCompletion[];
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
  private nativeAcknowledged = false;
  private expiredRequestId: string | null = null;
  /** Definite authenticated pre-proof refusal only, never an HTTP unknown. */
  private wrongAccountRequestId: string | null = null;
  private readonly lifetime = new AbortController();
  private readonly request: typeof fetch;
  private readonly parent: AbortSignal;
  private readonly onAbort = () => { void this.close(); };
  private constructor(private readonly store: AppInstallationStore, private state: State, private readonly options: Readonly<AppInstallationSignInOptions>) {
    this.request = options.fetch ?? ((input, init) => globalThis.fetch(input, init)); this.parent = options.signal;
    this.parent.addEventListener("abort", this.onAbort, {once: true}); this.check();
  }
  static async open(options: AppInstallationSignInOptions): Promise<AppProtectedInstallationSignIn> {
    const p = Object.freeze({...options, ...(options.recoveryFor ? {recoveryFor: Object.freeze({...options.recoveryFor})} : {})}); let opened: Awaited<ReturnType<typeof AppInstallationStore.open>> | null = null;
    try {
      if ((LOCAL_APPLICATION_BUILD ? !localApplicationEnvironment(p.environment) : !["lab", "staging", "production"].includes(p.environment)) || !isAppInstallationId(p.appId) ||
          typeof p.appName !== "string" || !p.appName.length || p.appName.length > 100 || p.appName.trim() !== p.appName) throw fail("binding");
      // Capacitor ("mobile") keeps custody in the WebView's origin-bound
      // IndexedDB, like a browser app; the CP binds the declared native origin.
      if (p.installationKind !== undefined && p.installationKind !== "app-runtime" && p.installationKind !== "mobile") throw fail("binding");
      const selection = p.environmentSelection;
      if (p.requestedCreateCollections !== undefined && typeof p.requestedCreateCollections !== "boolean") throw fail("binding");
      if (p.freshRequestedCreateCollections !== undefined && typeof p.freshRequestedCreateCollections !== "boolean") throw fail("binding");
      if (p.recoveryFor !== undefined) {
        const binding = object(p.recoveryFor, "accountId,collectionId"); id(binding.accountId); id(binding.collectionId);
        if (!p.owner || p.requestedCreateCollections === true || p.freshRequestedCreateCollections === true) throw fail("binding");
      }
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
          return new TextEncoder().encode(JSON.stringify({version: 3, renewal: null, requestedCreateCollections: p.requestedCreateCollections ?? p.freshRequestedCreateCollections ?? false, collectionIds: [], createCollections: false, consentRequest: null, requestId: crypto.randomUUID(), installationId: crypto.randomUUID(), deviceId: crypto.randomUUID(), secret, appId: p.appId, ...(p.owner === undefined ? {} : {owner: p.owner}), kind: p.installationKind ?? "app-runtime", origin: p.origin, cpOrigin: p.cpOrigin, environment: p.environment, selection: null, confirmed: false, nativeStarted: false, proof: null, token: null, ...(p.recoveryFor ? {recoveryFor: p.recoveryFor} : {})} satisfies State));
        } finally { bytes.fill(0); }
      });
      const state = this.decode(opened.plaintext, p);
      return new AppProtectedInstallationSignIn(opened.store, state, p);
    } catch (e) { await opened?.store.close(); if (e instanceof AppInstallationSignInError) throw e; if (e instanceof AppInstallationStorageError && e.reason === "busy") throw fail("open_in_another_tab"); throw fail("recovery_required"); }
    finally { opened?.plaintext.fill(0); }
  }
  private static decode(bytes: Uint8Array, p: Readonly<AppInstallationSignInOptions>): State {
    const parsed = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
    const base = "version,requestId,installationId,deviceId,secret,appId,kind,origin,cpOrigin,environment,selection,confirmed,nativeStarted,proof,token";
    const legacy = parsed?.version === 1;
    const fields = `${base},requestedCreateCollections,collectionIds,createCollections,consentRequest`;
    const r = legacy ? {...object(parsed, base), version: 3, renewal: null, requestedCreateCollections: false, collectionIds: [], createCollections: false, consentRequest: null}
      : parsed?.version === 2 ? {...object(parsed, fields), version: 3, renewal: null}
      : object(parsed, `${fields},renewal${Object.hasOwn(parsed, "collectionSelection") ? ",collectionSelection" : ""}${Object.hasOwn(parsed,"timerConsent") ? ",timerConsent" : ""}${Object.hasOwn(parsed,"timerChannel") ? ",timerChannel" : ""}${Object.hasOwn(parsed,"owner") ? ",owner" : ""}${Object.hasOwn(parsed,"collectionListing") ? ",collectionListing" : ""}${Object.hasOwn(parsed,"collectionRecoveries") ? ",collectionRecoveries" : ""}${Object.hasOwn(parsed,"recoveryFor") ? ",recoveryFor" : ""}${Object.hasOwn(parsed,"nativeAuthorization") ? ",nativeAuthorization" : ""}${Object.hasOwn(parsed,"nativeSelection") ? ",nativeSelection" : ""}${Object.hasOwn(parsed,"nativeGrants") ? ",nativeGrants" : ""}`);
    if (r.version !== 3 || r.appId !== p.appId || (r as {owner?: unknown}).owner !== p.owner || r.kind !== (p.installationKind ?? "app-runtime") || r.origin !== p.origin || r.cpOrigin !== p.cpOrigin || r.environment !== p.environment || typeof r.confirmed !== "boolean" || typeof r.nativeStarted !== "boolean") throw fail("recovery_required");
    const s = r as unknown as State;
    if (typeof s.requestedCreateCollections !== "boolean" || typeof s.createCollections !== "boolean" ||
        (p.requestedCreateCollections !== undefined && p.requestedCreateCollections !== s.requestedCreateCollections)) throw fail("binding");
    s.collectionIds = this.collectionIds(s.collectionIds);
    if (s.recoveryFor !== undefined) {
      const binding = object(s.recoveryFor, "accountId,collectionId"); id(binding.accountId); id(binding.collectionId);
    }
    if ((s.recoveryFor === undefined) !== (p.recoveryFor === undefined) || s.recoveryFor?.accountId !== p.recoveryFor?.accountId || s.recoveryFor?.collectionId !== p.recoveryFor?.collectionId || (s.recoveryFor && (s.requestedCreateCollections || s.createCollections ||
      (s.selection && s.selection.accountId !== s.recoveryFor.accountId) || (s.token && (s.nativeSelection ? s.collectionIds.length !== 0 || s.nativeSelection.collectionId !== s.recoveryFor.collectionId : s.collectionIds.length !== 1 || s.collectionIds[0] !== s.recoveryFor.collectionId || s.collectionSelection?.selectedCollectionId !== s.recoveryFor.collectionId))))) throw fail("recovery_required");
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
    if (s.collectionListing !== undefined) {
      if (!s.token || !s.confirmed || !s.selection || !s.proof || collectionListing(s.collectionListing).some(c => !s.collectionIds.includes(c.collectionId))) throw fail("recovery_required");
    }
    if (s.collectionRecoveries !== undefined) {
      if (!s.token || !s.confirmed || !s.selection || !s.proof || !s.collectionRecoveries || typeof s.collectionRecoveries !== "object" || Array.isArray(s.collectionRecoveries)) throw fail("recovery_required");
      const entries = Object.entries(s.collectionRecoveries);
      if (entries.length > 1000 || entries.some(([collection, replacement]) => !(s.collectionIds.includes(id(collection)) || s.nativeGrants?.some(c=>c.collection_id===collection)) || (replacement !== null && !id(replacement)))) throw fail("recovery_required");
    }
    if (s.nativeAuthorization) {
      const a = object(s.nativeAuthorization, "requestId,authorizationId,applicationId,manifestDigest");
      id(a.requestId); id(a.authorizationId); if (a.applicationId !== s.appId || !s.proof || !s.confirmed) throw fail("recovery_required"); text(a.manifestDigest, /^[0-9a-f]{64}$/);
    }
    if (s.nativeSelection) {
      const n = object(s.nativeSelection, "requestId,authorizationRequestId,collectionId"); id(n.requestId); id(n.authorizationRequestId); id(n.collectionId);
      if (!s.token || !s.nativeAuthorization || n.requestId !== s.nativeAuthorization.requestId || n.authorizationRequestId !== s.nativeAuthorization.authorizationId) throw fail("recovery_required");
    }
    if (s.nativeGrants) {
      if (!s.token || !s.selection || !Array.isArray(s.nativeGrants) || s.nativeGrants.length > 1000) throw fail("recovery_required");
      s.nativeGrants = s.nativeGrants.map(c => boundNativeCompletion(c, {requestId:s.requestId, authorizationRequestId:c.authorization_request_id, collectionId:c.collection_id}, s.selection!.accountId,s.appId,s.origin,c.application_manifest_digest));
      if (new Set(s.nativeGrants.map(c => c.collection_id)).size !== s.nativeGrants.length) throw fail("recovery_required");
    }
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
    return Object.freeze({requestId: s.requestId, installationId: s.installationId, deviceId: s.deviceId, appId: s.appId, kind: s.kind, verificationUri: `${s.cpOrigin}/pair/${s.requestId}`, state: s.token ? "paired" : s.proof ? "awaiting_approval" : s.confirmed ? "account_confirmed" : s.selection ? "account_selected" : "pending", accountId: s.selection?.accountId ?? null, accountEmail: identity?.accountEmail ?? null, ...(identity?.accountProvider ? {accountProvider: identity.accountProvider, accountLogin: identity.accountLogin!} : {}), collectionSelection: s.collectionSelection ? Object.freeze({...s.collectionSelection, createdCollectionIds: Object.freeze([...s.collectionSelection.createdCollectionIds])}) : null, nativeSelection: s.nativeSelection && s.nativeGrants?.some(c => c.authorization_request_id === s.nativeSelection!.authorizationRequestId && c.collection_id === s.nativeSelection!.collectionId) ? Object.freeze({...s.nativeSelection}) : null, nativeGrants: Object.freeze([...(s.nativeGrants ?? [])]), ...(s.timerConsent ? {timerConsent:s.timerConsent} : {}), collectionIds: Object.freeze([...s.collectionIds]), createCollections: s.createCollections, requestedCreateCollections: s.requestedCreateCollections});
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
  private async json(path: string, secret: boolean, body?: unknown, auth?: {bearer: string; get?: boolean; patch?: boolean; delete?: boolean}): Promise<{status: number; value: Record<string, unknown>}> {
    this.check(); this.wrongAccountRequestId = null;
    const ctrl = new AbortController(), abort = () => ctrl.abort(), timer = setTimeout(abort, 15000);
    this.lifetime.signal.addEventListener("abort", abort, {once: true});
    let response: Response | null = null, reader: ReadableStreamDefaultReader<Uint8Array> | null = null, drained = false, decoding = false;
    // Scoped metadata may contain 1000 UUIDs; discovery additionally contains
    // bounded names. Reject oversize before accumulating/parsing the body.
    const bytes = new Uint8Array(auth?.get || path.endsWith("/exchange") ? 1024 * 1024 : 64 * 1024); let count = 0;
    try {
      // Default cache mode, also for the authenticated GETs: Chrome skips its CORS preflight cache
      // for "no-store" requests. The CP answers them with Cache-Control: no-store, so nothing is HTTP-cached.
      response = await this.request(`${this.state.cpOrigin}${path}`, {method: auth?.get ? "GET" : auth?.patch ? "PATCH" : auth?.delete ? "DELETE" : "POST", headers: {...(auth ? {authorization: `Bearer ${auth.bearer}`} : secret ? {authorization: `Bearer ${this.state.secret}`} : {}), ...(body === undefined ? {} : {"content-type": "application/json"})}, body: body === undefined ? undefined : JSON.stringify(body), credentials: "omit", redirect: "error", cache: "default", referrerPolicy: "no-referrer", signal: ctrl.signal});
      this.check(); if (ctrl.signal.aborted) throw fail("outcome_unknown");
      const length = response.headers.get("content-length");
      // Fetch decodes content-encoding, which CORS may hide. Wire length is
      // only an early over-cap hint; the decoded stream is the hard bound.
      if (length !== null && /^(0|[1-9][0-9]*)$/.test(length) && Number(length) > bytes.length) {ctrl.abort(); throw fail("response");}
      if (!response.body) throw fail("response"); reader = response.body.getReader();
      for (;;) {
        const {done, value} = await reader.read();
        try { this.check(); if (ctrl.signal.aborted) throw fail("outcome_unknown"); if (done) { drained = true; break; } if (count + value.length > bytes.length) {ctrl.abort(); throw fail("response");} bytes.set(value, count); count += value.length; } finally { value?.fill(0); }
      }
      decoding = true;
      const value: unknown = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes.subarray(0, count)));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("response");
      if (!response.ok) {
        const error = (value as Record<string, unknown>).error;
        if (!auth && response.status === 404 &&
            (path === "/v1/pairing-requests" || path === `/v1/pairing-requests/${this.state.requestId}/exchange` || path === `/v1/pairing-requests/${this.state.requestId}/attest`) &&
            error && typeof error === "object" && !Array.isArray(error) &&
            ((error as Record<string,unknown>).code === "installation_pairing_expired" || (error as Record<string,unknown>).code === "installation_pairing_denied")) {
          // Expired or cancelled in the portal: the SAME actor may renew this
          // window from an explicit user retry. Any other 404 stays terminal.
          this.expiredRequestId = this.state.requestId;
          throw fail((error as Record<string,unknown>).code === "installation_pairing_expired" ? "expired" : "refused");
        }
        const server = appServerProblem(response.status, value, response.headers);
        throw new AppInstallationSignInError(appServerOutcome(server) ?? "refused", server);
      }
      return {status: response.status, value: value as Record<string, unknown>};
    } catch (e) {
      this.check();
      const error = e instanceof AppInstallationSignInError ? e : fail(auth?.get && !ctrl.signal.aborted && !(e instanceof DOMException && e.name === "AbortError") ? decoding ? "response" : !response || response.ok ? "unavailable" : "refused" : "outcome_unknown");
      if (response && !response.ok) nonOkResponses.add(error);
      throw error;
    }
    // Cancel only an unfinished body: cancelling a drained one makes the browser
    // record a completed request as aborted.
    finally { bytes.fill(0); if (!drained) void (reader?.cancel() ?? response?.body?.cancel())?.catch(() => {}); reader?.releaseLock(); clearTimeout(timer); this.lifetime.signal.removeEventListener("abort", abort); }
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
      if (s.recoveryFor && hint !== null && hint !== s.recoveryFor.collectionId) throw fail("binding");
      const {status, value: v} = await this.json("/v1/pairing-requests", false, {installation: {app_id: s.appId, request_id: s.requestId, pairing_secret: s.secret, installation_id: s.installationId, device_id: s.deviceId, kind: s.kind, requested_create_collections: s.requestedCreateCollections, ...(s.recoveryFor ? {recovery_collection_id: s.recoveryFor.collectionId} : {}), ...(s.renewal ? {renewal:{request_id:s.renewal.requestId, pairing_secret:s.renewal.secret}} : {})}, ...(hint ? {collection_hint: hint} : {})});
      if (status !== 200 && status !== 201) throw fail("response");
      object(v, `pairing_id,pairing_secret,verification_uri,expires_in,installation_device,app_id,app_origin,app_name${this.recoveryTargetKeys()}`);
      this.assertRecoveryTarget(v);
      const uri = verificationUri(v.verification_uri, `${s.cpOrigin}/pair/${s.requestId}`, hint);
      if (v.pairing_id !== s.requestId || v.pairing_secret !== s.secret || uri === null || v.installation_device !== true || v.app_id !== s.appId || v.app_origin !== s.origin || v.app_name !== this.options.appName || !Number.isSafeInteger(v.expires_in) || (v.expires_in as number) < 0 || (v.expires_in as number) > 600) throw fail("response");
      this.expiredRequestId = null;
      return Object.freeze({...this.view(), verificationUri: uri});
  }
  /** Scoped replies must echo the immutable protected CID. Legacy normal
   * replies omit it; missing support is refusal, never a hint-only fallback. */
  private recoveryTargetKeys(): string {return this.state.recoveryFor ? ",recovery_collection_id" : "";}
  private assertRecoveryTarget(value: Record<string, unknown>): void {
    if (this.state.recoveryFor && id(value.recovery_collection_id) !== this.state.recoveryFor.collectionId) throw fail("binding");
  }
  private selected(v: Record<string, unknown>): Selection {
    const s = this.state;
    this.assertRecoveryTarget(v);
    if (v.request_id !== s.requestId || v.installation_id !== s.installationId || v.device_id !== s.deviceId || v.kind !== s.kind || v.app_id !== s.appId || v.app_origin !== s.origin || v.approval_mode !== "password-ak1" || !Number.isSafeInteger(v.expires_at) || (v.expires_at as number) < 0) throw fail("response");
    const next: Selection = {accountId: id(v.account_id), connectorId: id(v.connector_id), challenge: text(v.challenge, /^[0-9a-f]{64}$/), approvalMode: "password-ak1"};
    if (s.selection && (next.accountId !== s.selection.accountId || next.connectorId !== s.selection.connectorId || next.challenge !== s.selection.challenge || next.approvalMode !== s.selection.approvalMode)) throw fail("binding");
    Object.assign(next, portalMetadata(v));
    if (s.selection) assertOriginalPortal(s.selection, next);
    if (s.recoveryFor && next.accountId !== s.recoveryFor.accountId) {
      if (v.status === "account_selected" && !s.selection && !s.confirmed && !s.nativeStarted && !s.proof && !s.token) {
        this.wrongAccountRequestId = s.requestId;
        throw fail("recovery_account_mismatch");
      }
      throw fail("binding");
    }
    this.wrongAccountRequestId = null;
    return next;
  }
  /** The owner may offer an explicit NEW browser slot only after this exact
   * fully validated wrong-account response, before any confirmation or keys.
   * A generic binding failure, loss, later refusal or closed actor never permits
   * abandoning a possibly completed original attempt. No CP row is reset. */
  canAbandonWrongAccount(): boolean {
    const s = this.state;
    return this.isCurrent() && s.recoveryFor !== undefined && this.wrongAccountRequestId === s.requestId &&
      !s.selection && !s.confirmed && !s.nativeStarted && !s.proof && !s.token && !s.consentRequest;
  }
  /** No account KEK/native opens here. The SDK-owned selection must be explicitly
   * confirmed by guarded portal choice or manual legacy confirmation before
   * confirmedSelection/attestation is permitted. */
  exchange(): Promise<AppInstallationSignInView> {
    return this.exclusive(async () => {
      if (this.state.token) return this.view();
      const {status, value: v} = await this.json(`/v1/pairing-requests/${this.state.requestId}/exchange`, true);
      if (v.status === "pending") { object(v, "status"); if (status !== 202 || this.state.selection) throw fail("response"); return this.view(); }
      const keys = `status,request_id,account_id,connector_id,device_id,installation_id,kind,challenge,approval_mode,app_id,app_origin,expires_at${portalKeys(v)}${this.recoveryTargetKeys()}`;
      if (v.status === "account_selected" || v.status === "awaiting_approval") {
        object(v, keys); if (status !== 202 || (v.status === "awaiting_approval" && !this.state.proof)) throw fail("response");
        const selection = this.selected(v); if (JSON.stringify(selection) !== JSON.stringify(this.state.selection)) await this.save({...this.state, selection}); return this.view();
      }
      // Pre-C5 receipts give NO scope; never infer access from old enrollment.
      const scoped = Object.hasOwn(v, "collection_ids") || Object.hasOwn(v, "create_collections");
      const picked = Object.hasOwn(v, "selected_collection_id") || Object.hasOwn(v, "created_collection_ids");
      const native = Object.hasOwn(v, "native_selection");
      object(v, `${keys},connector,token,registration${scoped ? ",collection_ids,create_collections" : ""}${picked ? ",selected_collection_id,created_collection_ids" : ""}${native ? ",native_selection" : ""}${timerKeys(v)}`); if (status !== 200 || v.status !== "paired" || !this.state.confirmed || !this.state.proof) throw fail("response");
      const selection = this.selected(v), connector = object(v.connector, "id,name"), r = object(v.registration, "device_id,sign_pk,kem_pk,noise_pk");
      if (connector.id !== selection.connectorId || connector.name !== this.options.appName || r.device_id !== this.state.deviceId || r.sign_pk !== this.state.proof.sign_pk || r.kem_pk !== this.state.proof.kem_pk || r.noise_pk !== this.state.proof.noise_pk) throw fail("binding");
      const collectionIds = scoped ? AppProtectedInstallationSignIn.collectionIds(v.collection_ids) : [];
      const createCollections = scoped ? v.create_collections : false;
      if (typeof createCollections !== "boolean" || (createCollections && !this.state.requestedCreateCollections)) throw fail("response");
      const collectionSelection = picked ? this.collectionSelection(v, collectionIds, this.state.requestId) : undefined;
      const nativeSelection = native ? this.parseNativeSelection(v.native_selection, this.state.requestId) : undefined;
      if (native && (!scoped || picked || createCollections || collectionIds.length !== 0 || v.timer_consent === true)) throw fail("response");
      if (this.state.recoveryFor && nativeSelection && nativeSelection.collectionId !== this.state.recoveryFor.collectionId) throw fail("binding");
      if (this.state.recoveryFor && !nativeSelection && (createCollections || collectionIds.length !== 1 || collectionIds[0] !== this.state.recoveryFor.collectionId ||
        collectionSelection?.selectedCollectionId !== this.state.recoveryFor.collectionId || collectionSelection.createdCollectionIds.length !== 0)) throw fail("binding");
      if (v.timer_consent===true && !collectionSelection) throw fail("response");
      const reminder=timerConsent(v,this.state.requestId,collectionIds,selection.portalConfirmed===true,collectionSelection?.selectedCollectionId);
      const token = text(v.token, /^idev_[A-Za-z0-9_-]{43}$/); await this.save({...this.state, selection, token, collectionIds, createCollections, nativeSelection, ...(nativeSelection ? {collectionSelection:undefined} : collectionSelection ? {collectionSelection} : {}), ...(reminder ? {timerConsent:reminder} : {})}); return this.view();
    });
  }
  private parseNativeSelection(value: unknown, requestId: string): AppNativeSelection {
    const n = object(value,"authorization_request_id,collection_id"), a = this.state.nativeAuthorization;
    if (!a || a.requestId !== requestId || id(n.authorization_request_id) !== a.authorizationId) throw fail("binding");
    return Object.freeze({requestId,authorizationRequestId:a.authorizationId,collectionId:id(n.collection_id)});
  }
  pendingNativeSelection(): AppNativeSelection | null { this.check(); return this.state.nativeSelection ?? null; }
  nativeAuthorizationContext(installation: AppInstallationCustodyAuthority): AppNativeAuthorizationContext | null {
    this.check(); this.owned(installation); const s=this.state, r=s.consentRequest && !s.consentRequest.completed ? s.consentRequest : null;
    const challenge=r?.challenge ?? s.selection?.challenge, confirmed=r ? r.portalConfirmed : s.selection?.portalConfirmed;
    if (!s.proof || !s.confirmed || !confirmed || !challenge || (s.token && !r)) return null;
    const requestId=r?.requestId ?? s.requestId, a=s.nativeAuthorization;
    return Object.freeze({requestId,accountId:s.selection!.accountId,appId:s.appId,challenge,...(a?.requestId===requestId?{authorizationId:a.authorizationId}:{})});
  }
  attachNativeAuthorization(installation: AppInstallationCustodyAuthority, context: AppNativeAuthorizationContext, prepared: AppNativePreparation): Promise<void> {
    const original=Object.freeze({...context}), p=Object.freeze({...prepared}), callback=installation.isCurrent;
    return this.exclusive(async()=>{
      this.owned(installation); const current=this.nativeAuthorizationContext(installation);
      if (!current || installation.isCurrent!==callback || current.requestId!==original.requestId || current.challenge!==original.challenge || current.accountId!==original.accountId || p.applicationId!==current.appId || !/^[0-9a-f]{64}$/.test(p.manifestDigest)) throw fail("binding");
      id(p.authorizationId); if (current.authorizationId && current.authorizationId!==p.authorizationId) throw fail("binding");
      await this.save({...this.state,nativeAuthorization:{...p,requestId:current.requestId}});
      const bearer=current.requestId===this.state.requestId?this.state.secret:this.state.consentRequest!.secret;
      const {status,value}=await this.json(`/v1/pairing-requests/${current.requestId}/native-authorization`,false,{authorization_request_id:p.authorizationId},{bearer});
      this.owned(installation); if(installation.isCurrent!==callback)throw fail("fenced");
      object(value,"request_id,authorization_request_id,account_id");
      if(status!==200 || value.request_id!==current.requestId || value.authorization_request_id!==p.authorizationId || value.account_id!==current.accountId)throw fail("binding");
    });
  }
  completeNativeAuthorization(installation: AppInstallationCustodyAuthority, completion: NativeCompletion): Promise<void> {
    const check=this.consentGuard(installation);
    return this.exclusive(async()=>{
      check(); const s=this.state,n=s.nativeSelection,a=s.nativeAuthorization;
      if(!this.nativeAcknowledged || !n || !a)throw fail("binding");
      const verified=boundNativeCompletion(completion,n,s.selection!.accountId,s.appId,s.origin,a.manifestDigest);
      await this.save({...s,nativeGrants:[...(s.nativeGrants ?? []).filter(c=>c.collection_id!==n.collectionId),verified]}); check();
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
  /** A consent window the CP reports closed (denied in the portal, or expired) can
   * never be reopened, and re-consent windows are not renewable. Forget it, so the
   * next explicit consent starts a new window instead of re-sending the dead one. */
  private async consentWindow<T>(requestId: string, work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (error) {
      const code = error instanceof AppInstallationSignInError ? error.server?.code : null;
      if ((code === "installation_pairing_denied" || code === "installation_pairing_expired") && error instanceof AppInstallationSignInError && error.server?.status === 404) {
        const r = this.state.consentRequest;
        if (r && !r.completed && r.requestId === requestId) await this.save({...this.state, consentRequest: null});
        throw fail(code === "installation_pairing_expired" ? "expired" : "refused");
      }
      throw error;
    }
  }
  /** Explicit additive consent, not renewal/registration/account selection.
   * A new secret/request is protected BEFORE HTTP; unknown outcomes only permit
   * an explicit repeat of that exact request, never new keys or a new actor. */
  startCollectionConsent(installation: AppInstallationCustodyAuthority, requestedCreateCollections = false, options: AppInstallationStartOptions = {}): Promise<AppInstallationCollectionConsentView> {
    const check = this.consentGuard(installation);
    let hint: string | null; try { hint = collectionHint(options); } catch (error) { return Promise.reject(error); }
    const attempt = async (): Promise<AppInstallationCollectionConsentView> => {
      check(); if (this.state.recoveryFor || typeof requestedCreateCollections !== "boolean") throw fail("binding");
      let r = this.state.consentRequest;
      if (!r || r.completed) {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        try {
          const secret = `pair_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
          r = {requestId: crypto.randomUUID(), secret, requestedCreateCollections, challenge: null, completed: false, addedCollectionIds: [], approvedCreateCollections: false};
          await this.save({...this.state, consentRequest: r}); check();
        } finally { bytes.fill(0); }
      } else if (r.requestedCreateCollections !== requestedCreateCollections) throw fail("binding");
      const s = this.state, token = s.token!, req = r;
      const {status, value: v} = await this.consentWindow(req.requestId, () => this.json("/v1/pairing-requests", false, {installation: {app_id: s.appId, request_id: req.requestId, pairing_secret: req.secret, installation_id: s.installationId, device_id: s.deviceId, kind: s.kind, requested_create_collections: req.requestedCreateCollections, reconsent: true}, ...(hint ? {collection_hint: hint} : {})}, {bearer: token})); check();
      object(v, "pairing_id,pairing_secret,verification_uri,expires_in,installation_device,app_id,app_origin,app_name");
      let uri: string | null = null;
      if ((status !== 200 && status !== 201) || v.pairing_id !== r.requestId || v.pairing_secret !== r.secret || (uri = verificationUri(v.verification_uri, `${s.cpOrigin}/pair/${r.requestId}`, hint)) === null || v.installation_device !== true || v.app_id !== s.appId || v.app_origin !== s.origin || v.app_name !== this.options.appName || !Number.isSafeInteger(v.expires_in) || (v.expires_in as number) < 0 || (v.expires_in as number) > 600 || token !== this.state.token) throw fail("response");
      return Object.freeze({...this.collectionConsentView()!, verificationUri: uri!});
    };
    return this.exclusive(async () => {
      const stored = this.state.consentRequest, reused = stored !== null && !stored.completed;
      try { return await attempt(); } catch (error) {
        // The stored window was already closed in Connect (and is now forgotten):
        // a definite outcome, same credential, so open the new window for this gesture.
        if (reused && this.state.consentRequest === null && error instanceof AppInstallationSignInError && (error.reason === "refused" || error.reason === "expired")) return await attempt();
        throw error;
      }
    });
  }
  /** The ORIGINAL consent-request secret consumes approval. Strict response
   * keys forbid replacement tokens/registrations; original actor/proof remains. */
  exchangeCollectionConsent(installation: AppInstallationCustodyAuthority): Promise<AppInstallationCollectionConsentView> {
    const check = this.consentGuard(installation);
    return this.exclusive(async () => {
      check(); const r = this.state.consentRequest, s = this.state;
      if (!r) throw fail("binding"); if (r.completed) return this.collectionConsentView()!;
      const {status, value: v} = await this.consentWindow(r.requestId, () => this.json(`/v1/pairing-requests/${r.requestId}/exchange`, false, undefined, {bearer: r.secret})); check();
      const portal = portalKeys(v);
      const keys = `status,request_id,account_id,connector_id,device_id,installation_id,kind,challenge,approval_mode,app_id,app_origin,expires_at${portal}`;
      const done = v.status === "scope_updated";
      const picked = done && (Object.hasOwn(v, "selected_collection_id") || Object.hasOwn(v, "created_collection_ids"));
      const native = done && Object.hasOwn(v,"native_selection");
      object(v, `${keys}${done ? ",added_collection_ids,approved_create_collections" : ""}${picked ? ",selected_collection_id,created_collection_ids" : ""}${native ? ",native_selection" : ""}${done ? timerKeys(v) : ""}`);
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
      const nativeSelection = native ? this.parseNativeSelection(v.native_selection,r.requestId) : undefined;
      if (native && (picked || addedCollectionIds.length !== 0 || v.approved_create_collections !== false || v.timer_consent === true)) throw fail("response");
      if (v.timer_consent===true && !collectionSelection) throw fail("response");
      const reminder=timerConsent(v,r.requestId,addedCollectionIds,confirmation.portalConfirmed===true,collectionSelection?.selectedCollectionId);
      await this.save({...s, collectionIds, nativeSelection, ...(nativeSelection ? {collectionSelection:undefined} : collectionSelection ? {collectionSelection} : {}), ...(reminder ? {timerConsent:reminder} : {}), createCollections: s.createCollections || v.approved_create_collections, consentRequest: {...r, ...confirmation, challenge, completed: true, addedCollectionIds, approvedCreateCollections: v.approved_create_collections}}); check();
      return this.collectionConsentView()!;
    });
  }
  /** Current approved/member cloud-copy metadata only; never readiness, keying,
   * or permission inferred from this response or retained consent snapshots. */
  listApprovedCollections(installation: AppInstallationCustodyAuthority): Promise<readonly AppInstallationCollection[]> {
    const check = this.consentGuard(installation);
    return this.exclusive(async () => {
      check();
      let reply: Awaited<ReturnType<AppProtectedInstallationSignIn["json"]>>;
      try { reply = await this.json("/v1/next/collections?include=file_actions", false, undefined, {bearer: this.state.token!, get: true}); }
      catch (error) {
        check();
        if (error instanceof AppInstallationSignInError && error.reason === "unavailable" && !error.server && !nonOkResponses.has(error) && this.state.collectionListing !== undefined)
          return Object.freeze(collectionListing(this.state.collectionListing).filter(c => this.state.collectionIds.includes(c.collectionId)).map(c => Object.freeze({...c, fileActions: Object.freeze([])})));
        if (error instanceof AppInstallationSignInError && (error.server || nonOkResponses.has(error)) && this.state.collectionListing !== undefined) {
          const state = {...this.state}; delete state.collectionListing;
          await this.save(state); check();
        }
        throw error;
      }
      check(); const {status, value: v} = reply; object(v, "collections");
      if (status !== 200) throw fail("response");
      const collections = collectionListing(v.collections);
      // Receipt references narrow replay; metadata cannot add consent or infer a role.
      const approved = (v.collections as Record<string, unknown>[]).filter(c => this.state.collectionIds.includes(c.collection_id as string)).map(c => { const metadata = {...c}; delete metadata.file_actions; return metadata; });
      const state = {...this.state}; delete state.collectionListing;
      const cached = {...state, collectionListing: approved};
      // Keep the original 128 KiB protected-ledger ceiling. An oversized listing
      // remains usable online but cannot leave an obsolete offline cache behind.
      await this.save(new TextEncoder().encode(JSON.stringify(cached)).length <= 128 * 1024 ? cached : state); check();
      return collections;
    });
  }
  /** Protected references to retired scopes. Each non-null value identifies a
   * separate original installation ledger, never a replacement credential. */
  collectionRecoveries(): Readonly<Record<string, string | null>> {
    this.check(); return Object.freeze({...this.state.collectionRecoveries});
  }
  retireCollectionScope(installation: AppInstallationCustodyAuthority, collection: string, expectedReplacement: string | null = null): Promise<void> {
    const check = this.consentGuard(installation);
    return this.exclusive(async () => {
      check(); id(collection);
      if (!(this.state.collectionIds.includes(collection) || this.state.nativeGrants?.some(c=>c.collection_id===collection))) throw fail("binding");
      if (expectedReplacement !== null) {
        id(expectedReplacement);
        if (this.state.collectionRecoveries?.[collection] !== expectedReplacement) throw fail("fenced");
      } else if (Object.hasOwn(this.state.collectionRecoveries ?? {}, collection)) return;
      await this.saveRecovery(collection, null); check();
    });
  }
  /** Only an explicit recovery gesture creates this new slot reference. The
   * new slot performs ordinary account confirmation, attestation and approval. */
  freshCollectionInstallation(installation: AppInstallationCustodyAuthority, collection: string): Promise<string> {
    const check = this.consentGuard(installation);
    return this.exclusive(async () => {
      check(); id(collection);
      if (!Object.hasOwn(this.state.collectionRecoveries ?? {}, collection)) throw fail("binding");
      const existing = this.state.collectionRecoveries![collection];
      if (existing !== null) return existing!; // pending/unknown retries keep the SAME fresh slot
      const replacement = crypto.randomUUID();
      await this.saveRecovery(collection, replacement); check(); return replacement;
    });
  }
  private async saveRecovery(collection: string, replacement: string | null): Promise<void> {
    const state = {...this.state, collectionRecoveries: {...this.state.collectionRecoveries, [collection]: replacement}};
    // Recovery metadata shares the original ledger bound; discard only display
    // cache if necessary, never the original receipt or unrelated scope state.
    if (new TextEncoder().encode(JSON.stringify(state)).length > 128 * 1024) delete state.collectionListing;
    await this.save(state);
  }
  /** Ask, from a fresh user gesture, for declared optional file actions on one
   * approved collection, with a one-line reason shown by Connect. A scope-only
   * re-consent under a new in-memory secret: nothing is persisted, so a lost
   * Worker simply drops the request. */
  startFileAccess(installation: AppInstallationCustodyAuthority, collectionId: string, actions: readonly AppFileAction[], reason: string): Promise<AppInstallationFileAccessRequest> {
    const check = this.consentGuard(installation);
    let requested: readonly AppFileAction[];
    try { id(collectionId); requested = fileActions([...actions], FILE_ACTIONS, false); if (requested.length !== actions.length) throw fail("binding"); }
    catch { return Promise.reject(fail("binding")); }
    return this.exclusive(async () => {
      check();
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      try {
        const requestId = crypto.randomUUID(), secret = `pair_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
        const s = this.state, token = s.token!;
        const {status, value: v} = await this.json("/v1/pairing-requests", false, {installation: {app_id: s.appId, request_id: requestId, pairing_secret: secret, installation_id: s.installationId, device_id: s.deviceId, kind: s.kind, requested_create_collections: false, reconsent: true, file_access: {collection_id: collectionId, actions: [...requested], reason}}}, {bearer: token}); check();
        object(v, "pairing_id,pairing_secret,verification_uri,expires_in,installation_device,app_id,app_origin,app_name");
        const uri = `${s.cpOrigin}/pair/${requestId}`;
        if ((status !== 200 && status !== 201) || v.pairing_id !== requestId || v.pairing_secret !== secret || v.verification_uri !== uri || v.installation_device !== true || v.app_id !== s.appId || v.app_origin !== s.origin || v.app_name !== this.options.appName || !Number.isSafeInteger(v.expires_in) || (v.expires_in as number) < 0 || (v.expires_in as number) > 600 || token !== this.state.token) throw fail("response");
        return Object.freeze({requestId, secret, collectionId, actions: requested, verificationUri: uri, expiresAt: Date.now() + (v.expires_in as number) * 1000});
      } finally { bytes.fill(0); }
    });
  }
  /** One read of that request's outcome. Connect records an approval when the
   * person allows it; this only reports it. */
  exchangeFileAccess(installation: AppInstallationCustodyAuthority, request: AppInstallationFileAccessRequest): Promise<AppInstallationFileAccessOutcome> {
    const check = this.consentGuard(installation);
    return this.exclusive(async () => {
      check(); const s = this.state;
      const {status, value: v} = await this.json(`/v1/pairing-requests/${request.requestId}/exchange`, false, undefined, {bearer: request.secret}); check();
      if (v.status === "pending") { object(v, "status"); if (status !== 202) throw fail("response"); return Object.freeze({state: "pending" as const}); }
      if (v.status === "account_selected" || v.status === "awaiting_approval") {
        object(v, `status,request_id,account_id,connector_id,device_id,installation_id,kind,challenge,approval_mode,app_id,app_origin,expires_at${portalKeys(v)}`);
        if (status !== 202 || v.request_id !== request.requestId || v.account_id !== s.selection?.accountId || v.installation_id !== s.installationId || v.device_id !== s.deviceId || v.app_id !== s.appId) throw fail("binding");
        return Object.freeze({state: "pending" as const});
      }
      if (v.status === "declined") {
        object(v, "status,request_id"); if (status !== 200 || v.request_id !== request.requestId) throw fail("response");
        return Object.freeze({state: "declined" as const});
      }
      object(v, "status,request_id,collection_id,file_actions");
      if (status !== 200 || v.status !== "file_access_updated" || v.request_id !== request.requestId || v.collection_id !== request.collectionId) throw fail("response");
      return Object.freeze({state: "granted" as const, actions: fileActions(v.file_actions, request.actions, false)});
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
  /** Fresh explicit owner intent only: soft-delete one approved collection for
   * everyone. `confirmName` must equal the current name (the CP checks it).
   * The CP is authoritative for ownership, freeze and scope. No retry: a lost
   * response is UNKNOWN; refresh the catalog, never infer the outcome. */
  deleteApprovedCollection(installation: AppInstallationCustodyAuthority, collectionId: string, confirmName: string): Promise<Readonly<{collectionId: string; deleted: true}>> {
    let name: string;
    try { id(collectionId); name = collectionDisplayName(confirmName); } catch { return Promise.reject(fail("binding")); }
    const check = this.consentGuard(installation);
    return this.exclusive(async () => {
      check(); if (!this.state.collectionIds.includes(collectionId)) throw fail("refused");
      const {status, value} = await this.json(`/v1/next/collections/${collectionId}`, false, {confirm_name: name}, {bearer: this.state.token!, delete: true}); check();
      const response = object(value, "collection_id,deleted");
      if (status !== 200 || response.collection_id !== collectionId || response.deleted !== true) throw fail("response");
      return Object.freeze({collectionId, deleted: true as const});
    });
  }
  /** UX-011: end this installation's server session. One DELETE
   * /v1/next/installation with the installation's own `idev_` credential, no
   * retry. `revoked`: the CP revoked it now. `already_signed_out`: 401
   * `invalid_connector`, the CP no longer accepts this credential. Every other
   * outcome (403 `installation_required`, 5xx, network loss) rejects. */
  signOutInstallation(): Promise<"revoked" | "already_signed_out"> {
    return this.exclusive(async () => {
      const token = this.state.token; if (!token) throw fail("binding");
      try {
        const {status, value} = await this.json("/v1/next/installation", false, undefined, {bearer: token, delete: true});
        // Required fields only: no authority is derived from this response.
        if (status !== 200 || value.ok !== true || value.revoked !== true || !Number.isSafeInteger(value.collections) || (value.collections as number) < 0
          || (value.fence !== "closed" && value.fence !== "committed_with_degraded_fence")) throw fail("response");
        return "revoked" as const;
      } catch (error) {
        if (error instanceof AppInstallationSignInError && error.server?.status === 401 && error.server.code === "invalid_connector") return "already_signed_out" as const;
        throw error;
      }
    });
  }
  /** True when this installation registered a Web Push channel (so a browser
   * push subscription exists for the app). Metadata only. */
  hasWebPushChannel(): boolean { this.check(); return this.state.timerChannel?.kind === "web_push"; }
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
      await persistence.registered(r, {signal: this.lifetime.signal}); check(); runtime.acknowledgeDeviceRegistration(r); check(); this.nativeAcknowledged = true; return r;
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
    const u = new URL(logOrigin); if (u.origin !== logOrigin || (u.protocol !== "https:" && !(LOCAL_APPLICATION_BUILD && localApplicationHttpOrigin(logOrigin))) || u.username || u.password) throw fail("binding");
    return Object.freeze({...selected, logOrigin, timerConsent:()=>{this.check();return this.state.timerConsent??null;}, connectorBearer: async ({signal}: {signal: AbortSignal}) => { this.check(); if (signal.aborted || !this.state.token) throw fail("fenced"); return this.state.token; }});
  }
  async close(): Promise<void> {
    if (!this.closed) { this.closed = true; this.lifetime.abort(); this.parent.removeEventListener("abort", this.onAbort); this.state.secret = ""; this.state.token = null; if (this.state.consentRequest) this.state.consentRequest.secret = ""; if (this.state.renewal) this.state.renewal.secret = ""; this.state.renewal = null; }
    await this.store.close();
  }
}
