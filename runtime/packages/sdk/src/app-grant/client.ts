/**
 * Application grants for web apps: OAuth authorization code + PKCE against the
 * Connect portal, with the grant's Noise client key registered at consent
 * (`client_noise_key`, attested by the grant signing key), then thin-client sessions
 * to a Private collection over the relay (Noise IK to one of the account's devices).
 *
 * The CP grant is only an offer: the collection's replica admits the app after the
 * user approves it in the mdbase desktop app. Until then the collection is listed as
 * `unavailable/approval_required`.
 *
 * Storage: see `grant-store.ts`. Access tokens stay in memory; the refresh token is
 * encrypted under a non-extractable key; the Noise key is non-extractable.
 */
import {
  APPLICATION_AUTHORIZATION_PROTOCOL_VERSION,
  applicationInstallationIdFromPublicKey,
  authorizationSigningMessage,
  type ApplicationAuthorizationBinding,
} from "@mdbase-dev/connect-protocol";
import { selectAppEnvironment } from "../app-host/app-environment.js";
import type { AppInstallationCollection } from "../app-host/installation-sign-in.js";
import { applicationDeclaration, type MdbaseApplicationDeclaration } from "../application/declaration.js";
import { compileApplicationManifest } from "../application/manifest.js";
import { appReleaseTrust } from "../application/packaged-trust.js";
import { resolveApplicationRegistration, type ApplicationRegistration } from "../application/registration.js";
import { uuidToBytes } from "../codec.js";
import {
  collectionUnavailableError,
  parseCollectionAvailability,
  type CollectionAvailability,
} from "../collection-availability.js";
import { isMdbaseError, mdbaseError } from "../errors.js";
import { orderTargets, type NextRouteResponse, type NextRouteTarget } from "../transport/next-relay.js";
import { clientPrologue, type StaticKey } from "../transport/noise.js";
import { noiseConnector, type WebSocketFactory } from "../transport/noise-session.js";
import type { Connector } from "../transport/port.js";
import { registerNextRelayFence } from "../transport/read-fence-policy.js";
import { relayPipeCarrier } from "../transport/relay-pipe.js";
import { MdbasePeopleClient } from "../people.js";
import type { MdbaseClient } from "../client.js";
import { appGrantPeopleAuthority } from "./people.js";
import { privateCollectionSetup, type MdbasePrivateSetup, type PrivateSetupEngine } from "./setup.js";
import { indexedDbAppGrantStore, type AppGrantStore, type StoredAppGrant, type StoredAppIdentity } from "./grant-store.js";

/** A window the UI reserved synchronously in the user's gesture (`window.open`). */
export interface AppGrantPopup {
  navigate(url: string): void;
  close(): void;
  /** True once the person closed it. Optional; without it only the timeout applies. */
  readonly closed?: boolean;
}

/** How the redirect page's URL reaches the waiting flow. Default: a same-origin BroadcastChannel. */
export interface AppGrantCallbackPort {
  subscribe(listener: (url: string) => void): () => void;
}

export interface MdbaseAppGrantsOptions {
  readonly declaration: MdbaseApplicationDeclaration;
  /** One of the manifest's `redirect_uris`. That page calls {@link deliverAppGrantCallback}. */
  readonly redirectUri: string;
  readonly store?: AppGrantStore;
  readonly callbacks?: AppGrantCallbackPort;
  readonly fetch?: typeof fetch;
  readonly webSocket?: WebSocketFactory;
}

export interface MdbaseAuthorizeOptions {
  readonly popup: AppGrantPopup;
  /** Ask for this collection only. */
  readonly collection?: string;
  readonly signal?: AbortSignal;
  /** Default 10 minutes, at most 30. */
  readonly timeoutMs?: number;
}

/** The account's role in a collection; `null` when Connect didn't report one. */
export type MdbaseCollectionRole = "owner" | "editor" | "viewer";
const ROLES: ReadonlySet<unknown> = new Set<MdbaseCollectionRole>(["owner", "editor", "viewer"]);

/** A Private collection this app has a grant for. */
export interface MdbasePrivateCollection {
  readonly collectionId: string;
  readonly displayName: string;
  readonly operations: readonly string[];
  /** Display and UI gating only (e.g. owner actions); Connect checks every action. */
  readonly role: MdbaseCollectionRole | null;
  readonly availability: CollectionAvailability;
}

/** One entry of the merged list: cloud copies opened by the installation, Private collections by a grant. */
export interface MdbaseCollectionEntry {
  readonly collectionId: string;
  readonly displayName: string;
  readonly kind: "cloud_copy" | "private";
  readonly availability: CollectionAvailability;
  /** The cloud copy's role, or the Private collection's when Connect reported it. */
  readonly role: MdbaseCollectionRole | null;
}

export interface MdbaseWaitOptions {
  readonly signal?: AbortSignal;
  /** Default 60 s, at most 10 minutes. */
  readonly timeoutMs?: number;
  /** Default 3 s, at least 1 s. */
  readonly intervalMs?: number;
  onAvailability?(availability: CollectionAvailability): void;
}

const CHANNEL = "mdbase.app-grant.v1";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const REQUEST_MS = 15_000;
const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");
const NOISE_KEY_DOMAIN = new TextEncoder().encode("mdbase-next client noise key v1\0");

/** Call from the redirect page with `location.href`; the waiting flow picks it up. */
export function deliverAppGrantCallback(url: string): void {
  const Channel = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
  if (!Channel) throw mdbaseError("unavailable", "BroadcastChannel is not available", "authorization_callback");
  const channel = new Channel(CHANNEL);
  channel.postMessage({ type: "callback", url: String(url) });
  channel.close();
}

function broadcastCallbacks(): AppGrantCallbackPort {
  return {
    subscribe(listener) {
      const Channel = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
      if (!Channel) throw mdbaseError("unavailable", "BroadcastChannel is not available", "authorization_callback");
      const channel = new Channel(CHANNEL);
      channel.onmessage = (event: MessageEvent) => {
        const data = event.data as { type?: unknown; url?: unknown } | null;
        if (data?.type === "callback" && typeof data.url === "string") listener(data.url);
      };
      return () => channel.close();
    },
  };
}

/** Cloud copies from the installation sign-in plus Private collections, by name. */
export function mergeCollectionEntries(
  cloud: readonly AppInstallationCollection[],
  privates: readonly MdbasePrivateCollection[],
): MdbaseCollectionEntry[] {
  const out = new Map<string, MdbaseCollectionEntry>();
  for (const c of cloud) {
    out.set(c.collectionId, Object.freeze({ collectionId: c.collectionId, displayName: c.displayName, kind: "cloud_copy", availability: c.availability ?? Object.freeze({ state: "available" }), role: c.role }));
  }
  for (const p of privates) {
    if (!out.has(p.collectionId)) out.set(p.collectionId, Object.freeze({ collectionId: p.collectionId, displayName: p.displayName, kind: "private", availability: p.availability, role: p.role }));
  }
  return [...out.values()].sort((a, b) => a.displayName.localeCompare(b.displayName) || a.collectionId.localeCompare(b.collectionId));
}

const b64u = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
};

/** Low-S P1363 ECDSA P-256 signature (what Connect and the daemon accept). */
async function signP256(key: CryptoKey, message: Uint8Array): Promise<Uint8Array> {
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, message as BufferSource));
  if (sig.length !== 64) throw mdbaseError("internal", "unexpected signature length", "authorization_signature");
  let s = 0n;
  for (const b of sig.subarray(32)) s = (s << 8n) | BigInt(b);
  if (s <= P256_ORDER / 2n) return sig;
  let low = P256_ORDER - s;
  for (let i = 63; i >= 32; i--) { sig[i] = Number(low & 0xffn); low >>= 8n; }
  return sig;
}

async function p256Pair(usages: KeyUsage[], algorithm: "ECDSA" | "ECDH"): Promise<{ privateKey: CryptoKey; publicKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: algorithm, namedCurve: "P-256" }, false, usages)) as CryptoKeyPair;
  return { privateKey: pair.privateKey, publicKey: b64u(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))) };
}

async function noisePair(): Promise<{ privateKey: CryptoKey; publicKey: Uint8Array }> {
  let pair: CryptoKeyPair;
  try {
    pair = (await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
  } catch {
    throw mdbaseError("unavailable", "this browser cannot keep a non-extractable X25519 key", "browser_unsupported");
  }
  if (pair.privateKey.extractable) throw mdbaseError("unavailable", "the Noise key must be non-extractable", "browser_unsupported");
  return { privateKey: pair.privateKey, publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)) };
}

function staticKeyOf(grant: StoredAppGrant): StaticKey {
  return {
    publicKey: grant.noisePublicKey,
    dh: async (remote) => {
      const pub = await crypto.subtle.importKey("raw", remote as BufferSource, { name: "X25519" }, false, []);
      return new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: pub } as AlgorithmIdentifier, grant.noisePrivateKey, 256));
    },
  };
}

function bounded(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; done(): void } {
  const control = new AbortController();
  const abort = () => control.abort();
  const timer = setTimeout(abort, ms);
  (timer as { unref?: () => void }).unref?.();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) control.abort();
  return { signal: control.signal, done: () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); } };
}

interface Tokens { access: string; expiresAt: number }

/**
 * Application grants of one app installation (a browser profile) against its
 * Connect environment. Generic: no app-specific behaviour.
 */
export class MdbaseAppGrants {
  private readonly declaration: ReturnType<typeof applicationDeclaration>;
  private readonly cpOrigin: string;
  private readonly redirect: URL;
  private readonly fetcher: typeof fetch;
  private readonly callbacks: AppGrantCallbackPort;
  private storeValue: AppGrantStore | null;
  private registration: Promise<Readonly<ApplicationRegistration>> | null = null;
  private readonly tokens = new Map<string, Tokens>();
  private readonly refreshing = new Map<string, Promise<string>>();
  private readonly forgotten = new Set<string>();
  private setupEngine: Promise<PrivateSetupEngine> | null = null;

  constructor(private readonly options: MdbaseAppGrantsOptions) {
    this.declaration = applicationDeclaration(options.declaration);
    this.cpOrigin = selectAppEnvironment({ environment: this.declaration.environment, appOrigin: this.declaration.origin, release: appReleaseTrust() }).cpOrigin;
    try { this.redirect = new URL(options.redirectUri); } catch { throw mdbaseError("invalid_request", "redirectUri must be an absolute URL", "redirect_uri"); }
    if (this.redirect.origin !== this.declaration.origin || this.redirect.hash) {
      throw mdbaseError("invalid_request", "redirectUri must be on the app's origin, without a fragment", "redirect_uri");
    }
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.callbacks = options.callbacks ?? broadcastCallbacks();
    this.storeValue = options.store ?? null;
  }

  private register(): Promise<Readonly<ApplicationRegistration>> {
    const pending = this.registration ??= resolveApplicationRegistration({
      declaration: this.options.declaration, signal: new AbortController().signal, isCurrent: () => true, fetch: this.fetcher,
    });
    pending.catch(() => { if (this.registration === pending) this.registration = null; });
    return pending;
  }

  private ownerValue: string | null = null;
  /**
   * The local owner of this app's grants: its manifest family from the ORIGINAL
   * declaration, never the CP-assigned id. It labels the default store and binds
   * the refresh ciphertext, so a wrong registration id cannot select, use or
   * delete another app's grants.
   */
  private owner(): string {
    return this.ownerValue ??= `bundle:${String((compileApplicationManifest(this.declaration).manifest as { id?: unknown }).id)}`;
  }

  private async store(): Promise<AppGrantStore> {
    if (this.storeValue) return this.storeValue;
    const owner = this.owner();
    return (this.storeValue = indexedDbAppGrantStore(this.cpOrigin, (await this.register()).id, { owner }));
  }

  private async identity(): Promise<StoredAppIdentity> {
    const store = await this.store();
    const existing = await store.getIdentity();
    if (existing) return existing;
    const created = await p256Pair(["sign"], "ECDSA");
    return store.putIdentityIfAbsent({ version: 1, privateKey: created.privateKey, publicKey: created.publicKey });
  }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<{ status: number; body: Record<string, unknown> | null }> {
    const budget = bounded(signal, REQUEST_MS);
    try {
      let res: Response;
      try {
        res = await this.fetcher(`${this.cpOrigin}${path}`, { ...init, redirect: "error", signal: budget.signal });
      } catch {
        if (signal?.aborted) throw mdbaseError("cancelled", "request cancelled");
        throw mdbaseError("unavailable", "cannot reach the control plane", "control_unreachable");
      }
      let body: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = await res.json();
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      } catch { body = null; }
      return { status: res.status, body };
    } finally { budget.done(); }
  }

  /**
   * Ask the person for access in the popup: Connect's consent lists their
   * collections, including Private ones. Resolves with the approved collection.
   * The collection then usually reports `approval_required` until the person also
   * approves the app in the mdbase desktop app.
   */
  async authorize(o: MdbaseAuthorizeOptions): Promise<{ collectionId: string }> {
    const popup = o.popup;
    try {
      if (o.collection !== undefined && !UUID.test(o.collection)) throw mdbaseError("invalid_request", "collection must be a UUID");
      const registration = await this.register();
      const compiled = compileApplicationManifest(this.declaration);
      const identity = await this.identity();
      const grantAgreement = await p256Pair(["deriveBits"], "ECDH");
      const grantSigning = await p256Pair(["sign"], "ECDSA");
      const noise = await noisePair();
      const verifier = b64u(random(32));
      const challenge = b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
      const state = b64u(random(24));
      const authorizationId = crypto.randomUUID();
      const issued = new Date();
      const binding: ApplicationAuthorizationBinding = {
        protocol_version: APPLICATION_AUTHORIZATION_PROTOCOL_VERSION,
        authorization_id: authorizationId,
        application_id: registration.id,
        application_declaration_id: String((compiled.manifest as { id?: unknown }).id),
        application_manifest_digest: registration.manifestDigest,
        application_installation_id: await applicationInstallationIdFromPublicKey(identity.publicKey),
        installation_signing_public_key: identity.publicKey,
        grant_agreement_public_key: grantAgreement.publicKey,
        grant_signing_public_key: grantSigning.publicKey,
        flow: "authorization_code",
        authorization_nonce: b64u(random(32)),
        issued_at: issued.toISOString(),
        expires_at: new Date(issued.getTime() + 10 * 60_000).toISOString(),
        redirect_uri: this.redirect.href,
        state,
        code_challenge: challenge,
        contracts: compiled.contracts,
        requested_operations: [...compiled.operations],
        ...(compiled.files ? { requested_files: compiled.files } : {}),
        ...(o.collection ? { collection_id: o.collection } : {}),
      };
      const proof = { binding, signature: b64u(await signP256(identity.privateKey, authorizationSigningMessage(binding))) };
      const keyMessage = concat(NOISE_KEY_DOMAIN, u32(16), uuidToBytes(authorizationId), u32(32), noise.publicKey);
      const clientNoiseKey = { public_key: b64u(noise.publicKey), signature: b64u(await signP256(grantSigning.privateKey, keyMessage)) };
      const started = await this.request("/oauth/authorization_request", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: registration.id,
          redirect_uri: this.redirect.href,
          code_challenge: challenge,
          code_challenge_method: "S256",
          state,
          operations: compiled.operations.join(","),
          ...(o.collection ? { collection_id: o.collection } : {}),
          application_authorization: JSON.stringify(proof),
          client_noise_key: JSON.stringify(clientNoiseKey),
        }),
      }, o.signal);
      const uri = started.body?.authorization_uri;
      if (started.status !== 200 || started.body?.authorization_id !== authorizationId || typeof uri !== "string"
          || !uri.startsWith(`${this.cpOrigin}/oauth/authorize?`)) {
        throw mdbaseError("unavailable", `authorization could not be started (${started.status})`, "authorization_start");
      }
      popup.navigate(uri);
      const code = await this.awaitCallback(state, popup, o);
      const exchanged = await this.request("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: registration.id, redirect_uri: this.redirect.href, code_verifier: verifier }),
      }, o.signal);
      const collectionId = await this.saveTokens(exchanged, { noise, collection: o.collection });
      return { collectionId };
    } finally {
      try { popup.close(); } catch { /* already closed */ }
    }
  }

  private awaitCallback(state: string, popup: AppGrantPopup, o: MdbaseAuthorizeOptions): Promise<string> {
    const timeoutMs = Math.min(Math.max(o.timeoutMs ?? 10 * 60_000, 1_000), 30 * 60_000);
    return new Promise<string>((resolve, reject) => {
      let closedSince: number | null = null;
      const finish = (f: () => void) => { unsubscribe(); clearTimeout(timer); clearInterval(watch); o.signal?.removeEventListener("abort", abort); f(); };
      const abort = () => finish(() => reject(mdbaseError("cancelled", "authorization cancelled", "authorization_cancelled")));
      const unsubscribe = this.callbacks.subscribe((raw) => {
        let url: URL;
        try { url = new URL(raw); } catch { return; }
        if (url.origin !== this.redirect.origin || url.pathname !== this.redirect.pathname || url.searchParams.get("state") !== state) return;
        const error = url.searchParams.get("error");
        if (error) return finish(() => reject(mdbaseError("forbidden", "access was not approved", "authorization_denied")));
        const code = url.searchParams.get("code");
        if (!code) return finish(() => reject(mdbaseError("unavailable", "the authorization callback has no code", "authorization_callback")));
        finish(() => resolve(code));
      });
      const timer = setTimeout(() => finish(() => reject(mdbaseError("cancelled", "authorization timed out", "authorization_timed_out"))), timeoutMs);
      // A closed popup ends the wait after a short grace for its final callback.
      const watch = setInterval(() => {
        let closed = false;
        try { closed = popup.closed === true; } catch { closed = false; }
        if (!closed) { closedSince = null; return; }
        closedSince ??= Date.now();
        if (Date.now() - closedSince >= 3_000) finish(() => reject(mdbaseError("cancelled", "the authorization window was closed", "authorization_cancelled")));
      }, 500);
      o.signal?.addEventListener("abort", abort, { once: true });
      if (o.signal?.aborted) abort();
    });
  }

  private async saveTokens(
    res: { status: number; body: Record<string, unknown> | null },
    from: { noise?: { privateKey: CryptoKey; publicKey: Uint8Array }; collection?: string | undefined; previous?: StoredAppGrant },
  ): Promise<string> {
    const b = res.body;
    if (res.status !== 200 || !b) {
      if (res.status === 400 && b && typeof b.error === "string" && b.error === "invalid_grant") {
        throw mdbaseError("unauthenticated", "the grant is no longer valid", "grant_invalid");
      }
      if (res.status === 400) throw collectionUnavailableError("sync_required");
      throw mdbaseError("unavailable", `token request failed (${res.status})`, "token_error");
    }
    const access = b.access_token, refresh = b.refresh_token, collection = b.collection_id;
    const expiresIn = b.expires_in, refreshExpiresIn = b.refresh_expires_in;
    if (typeof access !== "string" || typeof refresh !== "string" || typeof collection !== "string" || !UUID.test(collection)
        || typeof expiresIn !== "number" || !(expiresIn > 0) || typeof refreshExpiresIn !== "number" || !(refreshExpiresIn > 0)) {
      throw mdbaseError("unavailable", "invalid token response", "token_response");
    }
    const id = collection.toLowerCase();
    if (from.collection && from.collection.toLowerCase() !== id) throw mdbaseError("forbidden", "a different collection was approved", "collection_mismatch");
    if (from.previous && from.previous.collection !== id) throw mdbaseError("unavailable", "the token names another collection", "token_response");
    const refreshKey = from.previous?.refreshKey
      ?? (await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])) as CryptoKey;
    const iv = random(12);
    const sealed = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: this.aad(id) }, refreshKey, new TextEncoder().encode(refresh) as BufferSource));
    const noise = from.noise ?? { privateKey: from.previous!.noisePrivateKey, publicKey: from.previous!.noisePublicKey };
    await (await this.store()).putGrant({
      version: 1, collection: id, noisePrivateKey: noise.privateKey, noisePublicKey: noise.publicKey,
      refreshKey, refresh: concat(iv, sealed), refreshExpiresAt: Date.now() + refreshExpiresIn * 1000,
    });
    this.tokens.set(id, { access, expiresAt: Date.now() + expiresIn * 1000 });
    this.forgotten.delete(id);
    return id;
  }

  private aad(collection: string): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(`mdbase.app-grant.v2\0${this.cpOrigin}\0${this.owner()}\0${collection}`);
  }

  /** A current access token for the collection's grant, refreshing when needed. */
  private async accessToken(collection: string, force = false): Promise<string> {
    const cached = this.tokens.get(collection);
    if (!force && cached && cached.expiresAt - Date.now() > 60_000) return cached.access;
    const running = this.refreshing.get(collection);
    if (running) return running;
    const work = this.withLock(collection, () => this.refresh(collection));
    this.refreshing.set(collection, work);
    try { return await work; } finally { if (this.refreshing.get(collection) === work) this.refreshing.delete(collection); }
  }

  /** Refresh tokens are single use: serialize refreshes across tabs where Web Locks exist. */
  private async withLock<T>(collection: string, f: () => Promise<T>): Promise<T> {
    const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
    if (!locks) return f();
    return locks.request(`mdbase.app-grant.refresh:${this.cpOrigin}:${collection}`, { mode: "exclusive" }, f) as Promise<T>;
  }

  private async refresh(collection: string): Promise<string> {
    const store = await this.store();
    const grant = await store.getGrant(collection);
    if (!grant || grant.refreshExpiresAt <= Date.now()) throw collectionUnavailableError("sync_required");
    let refresh: string;
    try {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: grant.refresh.slice(0, 12), additionalData: this.aad(collection) }, grant.refreshKey, grant.refresh.slice(12));
      refresh = new TextDecoder().decode(plain);
    } catch {
      throw mdbaseError("unauthenticated", "the stored grant could not be read", "grant_storage");
    }
    const registration = await this.register();
    const res = await this.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: registration.id }),
    });
    try {
      await this.saveTokens(res, { previous: grant });
    } catch (e) {
      // A refused refresh token will never work again: forget the grant locally.
      if (isMdbaseError(e, "unauthenticated") && e.reason === "grant_invalid") {
        this.forgotten.add(collection);
        await store.deleteGrant(collection);
      }
      throw e;
    }
    return this.tokens.get(collection)!.access;
  }

  /** Fetch the route; one forced refresh on 401. */
  private async route(collection: string, signal?: AbortSignal): Promise<{ token: string; route: NextRouteResponse; availability: CollectionAvailability }> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken(collection, attempt > 0);
      const res = await this.request(`/v1/next/collections/${encodeURIComponent(collection)}/route`, { headers: { authorization: `Bearer ${token}` } }, signal);
      if (res.status === 401 && attempt === 0) continue;
      if (res.status === 401) throw mdbaseError("unauthenticated", "the control plane refused the access token");
      if (res.status === 409) throw mdbaseError("unauthenticated", "this app's key is not registered with its grant", "client_key_required");
      if (res.status !== 200 || !res.body) throw mdbaseError("unavailable", `control plane answered ${res.status}`, "control_error");
      const route = res.body as unknown as NextRouteResponse;
      if (typeof route.collection !== "string" || route.collection.toLowerCase() !== collection || !Array.isArray(route.targets)) {
        throw mdbaseError("unauthenticated", "the route does not match this collection's grant", "route_mismatch");
      }
      const parsed = parseCollectionAvailability(route.availability);
      const availability: CollectionAvailability = parsed ?? (orderTargets(route, null).length
        ? { state: "available" } : { state: "unavailable", reason: route.reason === "no_device_registered" ? "no_device_registered" : "device_offline" });
      return { token, route, availability };
    }
  }

  /** Private collections this app has a grant for, with their availability. */
  async collections(options: { signal?: AbortSignal } = {}): Promise<MdbasePrivateCollection[]> {
    const local = await (await this.store()).listGrants();
    const held = new Set(local.map((g) => g.collection));
    for (const grant of local) {
      let token: string;
      try { token = await this.accessToken(grant.collection); }
      catch (e) { if (isMdbaseError(e, "unavailable") && e.reason !== "sync_required") throw e; continue; }
      const res = await this.request("/v1/next/apps/collections", { headers: { authorization: `Bearer ${token}` } }, options.signal);
      if (res.status === 401) { this.tokens.delete(grant.collection); continue; }
      if (res.status !== 200 || !Array.isArray(res.body?.collections)) throw mdbaseError("unavailable", `control plane answered ${res.status}`, "control_error");
      const out: MdbasePrivateCollection[] = [];
      for (const raw of res.body.collections as Record<string, unknown>[]) {
        const id = typeof raw.collection === "string" ? raw.collection.toLowerCase() : "";
        if (!UUID.test(id) || out.some((c) => c.collectionId === id)) continue;
        const parsed = parseCollectionAvailability(raw.availability);
        if (raw.state !== "synced_e2e" && !parsed) continue; // other collections open through the installation
        const availability: CollectionAvailability = !held.has(id)
          ? { state: "unavailable", reason: "sync_required" } // no key in this browser
          : parsed ?? { state: "opening" }; // the grant is still being published to the collection
        out.push(Object.freeze({
          collectionId: id,
          displayName: typeof raw.name === "string" ? raw.name : "Collection",
          operations: Object.freeze(Array.isArray(raw.operations) ? raw.operations.filter((x): x is string => typeof x === "string") : []),
          availability: Object.freeze(availability),
          role: ROLES.has(raw.role) ? raw.role as MdbaseCollectionRole : null,
        }));
      }
      return out;
    }
    return [];
  }

  /** The collection's availability now, from its route. Never throws for `unavailable`. */
  async availability(collection: string, options: { signal?: AbortSignal } = {}): Promise<CollectionAvailability> {
    const id = collection.toLowerCase();
    try { return (await this.route(id, options.signal)).availability; }
    catch (e) {
      if (isMdbaseError(e) && e.details instanceof Map && typeof e.details.get("availability") === "string") {
        return parseCollectionAvailability({ state: "unavailable", reason: e.details.get("availability") })!;
      }
      throw e;
    }
  }

  /**
   * Wait, bounded, until the collection is available: e.g. while the person opens
   * the desktop app or approves this app there. Resolves with the last availability
   * (still `unavailable` on timeout); never waits on `sync_required` or `access_removed`.
   */
  async waitForAvailable(collection: string, o: MdbaseWaitOptions = {}): Promise<CollectionAvailability> {
    const deadline = Date.now() + Math.min(Math.max(o.timeoutMs ?? 60_000, 0), 10 * 60_000);
    const interval = Math.max(o.intervalMs ?? 3_000, 1_000);
    let last: CollectionAvailability | null = null;
    for (;;) {
      if (o.signal?.aborted) throw mdbaseError("cancelled", "wait cancelled");
      const now = await this.availability(collection, o.signal ? { signal: o.signal } : {});
      if (!last || now.state !== last.state || (now.state === "unavailable" && last.state === "unavailable" && now.reason !== last.reason)) o.onAvailability?.(now);
      last = now;
      if (now.state === "available" || (now.state === "unavailable" && (now.reason === "sync_required" || now.reason === "access_removed"))) return now;
      const left = deadline - Date.now();
      if (left <= 0) return now;
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, Math.min(interval, left));
        function done() { clearTimeout(t); o.signal?.removeEventListener("abort", done); resolve(); }
        o.signal?.addEventListener("abort", done, { once: true });
      });
    }
  }

  /**
   * A connector for `connect()`: every (re)connect resolves the route, refuses an
   * unavailable collection with its reason, and opens a Noise IK session through the
   * relay to a serving device (sticky while it stays listed).
   */
  connector(collection: string): Connector & { readonly target: string | null } {
    const id = collection.toLowerCase();
    if (!UUID.test(id)) throw mdbaseError("invalid_request", "collection must be a UUID");
    let sticky: string | null = null;
    const webSocket = this.options.webSocket;
    let staticKey: StaticKey | null = null;
    const key: StaticKey = {
      get publicKey() { return staticKey?.publicKey ?? new Uint8Array(32); },
      dh: (remote) => { if (!staticKey) throw mdbaseError("unauthenticated", "grant key unavailable"); return staticKey.dh(remote); },
    };
    const connector = noiseConnector({
      description: `app-grant:${id}`,
      staticKey: key,
      target: async (signal) => {
        const grant = await (await this.store()).getGrant(id);
        if (!grant) throw collectionUnavailableError("sync_required");
        staticKey = staticKeyOf(grant);
        const { token, route, availability } = await this.route(id, signal);
        if (availability.state === "unavailable") throw collectionUnavailableError(availability.reason);
        if (!UUID.test(route.grant)) throw mdbaseError("unauthenticated", "the route names no grant", "route_mismatch");
        const target: NextRouteTarget | undefined = orderTargets(route, sticky)[0];
        if (!target) throw collectionUnavailableError("device_offline");
        const remoteStatic = new Uint8Array(32);
        for (let i = 0; i < 32; i++) remoteStatic[i] = parseInt(target.noise_pk.slice(2 * i, 2 * i + 2), 16);
        return {
          prologue: clientPrologue(uuidToBytes(target.relay_collection!), uuidToBytes(route.grant), uuidToBytes(target.device)),
          remoteStatic,
          device: target.device,
          openCarrier: (s) => relayPipeCarrier(target.url, {
            accessToken: token, collection: target.relay_collection!, grant: route.grant, device: target.device, devicePublicKey: remoteStatic,
          }, webSocket, s),
        };
      },
    });
    return registerNextRelayFence({
      description: connector.description,
      open: async (hello, signal) => {
        const opened = await connector.open(hello, signal);
        sticky = opened.device ?? null;
        return opened;
      },
      get target() { return sticky; },
    });
  }

  /**
   * People metadata and Person records for a Private collection: the same
   * `MdbasePeopleClient` as cloud copies, over `client` (opened with
   * `connector(collection)`) and Connect's people metadata for this grant. Until a
   * computer approves the app, metadata fails with availability `approval_required`.
   */
  people(collection: string, client: Pick<MdbaseClient, "queryContract" | "readyForRead" | "currentSession">): MdbasePeopleClient {
    const id = collection.toLowerCase();
    if (!UUID.test(id)) throw mdbaseError("invalid_request", "collection must be a UUID");
    return new MdbasePeopleClient(client, appGrantPeopleAuthority(id, {
      cpOrigin: this.cpOrigin,
      fetch: this.fetcher,
      accessToken: (c, force) => this.accessToken(c, force),
      holds: (c) => !this.forgotten.has(c),
    }));
  }

  /**
   * Setup and readiness for a Private collection, over `client` (opened with
   * `connector(collection)`): the same plan, review wording and guarded apply as
   * a hosted collection's setup. The planner (the SDK's packaged runtime) loads
   * on first use. Planning changes nothing; `apply` writes one guarded mutation.
   */
  setup(client: MdbaseClient): MdbasePrivateSetup {
    const compiled = compileApplicationManifest(this.declaration);
    return privateCollectionSetup({
      client, manifest: compiled.manifest, operations: compiled.operations,
      engine: () => {
        const pending = this.setupEngine ??= packagedSetupEngine(this.declaration, this.fetcher);
        pending.catch(() => { if (this.setupEngine === pending) this.setupEngine = null; });
        return pending;
      },
    });
  }

  /** Forget a grant in this browser (its keys and refresh token). Does not revoke it at Connect. */
  async forget(collection: string): Promise<void> {
    const id = collection.toLowerCase();
    this.forgotten.add(id);
    this.tokens.delete(id);
    await (await this.store()).deleteGrant(id);
  }
}

/** The SDK's own packaged runtime, fetched against its pinned digest. */
async function packagedSetupEngine(declaration: Readonly<{ environment: "lab" | "production"; origin: string }>, fetcher: typeof fetch): Promise<PrivateSetupEngine> {
  const [{ AppSetupEngine }, { packagedApplicationAssets }, { applicationAssetLoader }] = await Promise.all([
    import("../app-host/setup-engine.js"), import("../application/packaged-assets.js"), import("../application/asset-loader.js")]);
  const assets = packagedApplicationAssets(declaration.environment, declaration.origin);
  const load = applicationAssetLoader(assets.runtime, { origin: declaration.origin, environment: declaration.environment, fetch: fetcher });
  return AppSetupEngine.create(new Uint8Array(await load({ signal: new AbortController().signal })));
}
