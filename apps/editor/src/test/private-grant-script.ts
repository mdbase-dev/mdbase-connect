import { MdbaseAppGrants, memoryAppGrantStore, type AppGrantStore } from "@mdbase-dev/sdk/app-grant";
import type { MdbaseApplicationDeclaration, MdbaseSnapshot } from "@mdbase-dev/sdk";
import { parseVersionedAppManifest } from "@mdbase-dev/connect-protocol/manifest";
import { vi } from "vitest";
import manifest from "../../public/.well-known/mdbase-app.json";

export type Completion = NonNullable<NonNullable<MdbaseSnapshot["signIn"]>["nativeGrants"]>[number];
export const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
export const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";
export const PRIVATE_A = "0190a5a0-0000-7000-8000-000000000011";
export const PRIVATE_B = "0190a5a0-0000-7000-8000-000000000022";
export const NAME_A = "Account A research";
export const NAME_B = "Account B research";
const APP = "5cdfa020-c201-4da8-845a-f2cc9969eade";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/** Real public grant client + WebCrypto + storage. Every CP request is scripted;
 * no LAB/network, trust override, Worker, or native admission is exercised. */
export async function privateGrantScript() {
  // Use the installed original production SDK's real packaged release context.
  // The declaration changes target, not trust: there is no release override.
  const targetManifest = { ...manifest, homepage: `${location.origin}/`, redirect_uris: [`${location.origin}/`],
    installation_origins: { production: { "app-runtime": [location.origin] } } };
  const declaration: MdbaseApplicationDeclaration = { id: manifest.id, name: manifest.name,
    origin: location.origin, environment: "production", manifest: targetManifest };
  const canonical = parseVersionedAppManifest(targetManifest).manifest;
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(canonical))))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const backing = memoryAppGrantStore();
  const owner = `bundle:${manifest.id}`;
  let pauseWrite: (() => Promise<void>) | null = null;
  const store: AppGrantStore = { ...backing,
    putIdentityIfAbsent: (identity) => backing.putIdentityIfAbsent({ ...identity, owner }),
    putGrant: async (grant) => {
      await backing.putGrant({ ...grant, owner });
      const pause = pauseWrite; pauseWrite = null;
      if (pause) await pause();
    }
  };
  let listener: ((url: string) => void) | null = null;
  const callbacks = { subscribe(next: (url: string) => void) {
    listener = next;
    return () => { if (listener === next) listener = null; };
  } };
  let current = { account: ACCOUNT_A, collection: PRIVATE_A };
  let binding: Record<string, string> | null = null;
  let noise = "";
  let callback = "";
  let completion: Completion | null = null;
  let observedInventory: (() => void) | null = null;
  const refreshes = new Map<string, string>();
  const requests: string[] = [];
  const tokens = (collection: string) => {
    const refresh = `fixture-refresh-${crypto.randomUUID()}`;
    refreshes.set(refresh, collection);
    return { access_token: `fixture-access-${collection}`, refresh_token: refresh, collection_id: collection,
      expires_in: 3600, refresh_expires_in: 7200 };
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== "https://connect.mdbase.dev") throw new Error("Unexpected scripted CP target; no network fallback exists");
    const path = url.pathname;
    requests.push(path);
    const body = new URLSearchParams(String(init?.body ?? ""));
    if (path === "/v1/apps/register") return Response.json({ application: { id: APP, name: manifest.name,
      manifest_digest: digest, canonical_identity: `bundle:${manifest.id}:sha256:${digest}`,
      family_identity: `bundle:${manifest.id}`, distribution: "web", application_declaration: canonical } });
    if (path === "/oauth/authorization_request") {
      binding = (JSON.parse(body.get("application_authorization")!) as { binding: Record<string, string> }).binding;
      noise = (JSON.parse(body.get("client_noise_key")!) as { public_key: string }).public_key;
      callback = `${declaration.origin}/?state=${binding.state}&code=fixture-code`;
      return Response.json({ authorization_id: binding.authorization_id, authorization_uri: `${url.origin}/oauth/authorize?id=fixture` });
    }
    if (path === "/oauth/token" && body.get("grant_type") === "authorization_code") {
      if (!binding) throw new Error("No original fixture preparation");
      const grant = crypto.randomUUID();
      completion = { version: 1, account_id: current.account, collection_id: current.collection,
        authorization_request_id: binding.authorization_id!, application_id: APP,
        application_declaration_id: manifest.id, application_manifest_digest: digest,
        application_installation_id: binding.application_installation_id!, application_origin: declaration.origin,
        grant_id: grant, grant_signing_public_key: binding.grant_signing_public_key!, client_noise_public_key: noise };
      return Response.json({ ...tokens(current.collection), grant_id: grant, application_origin: declaration.origin, native_completion: completion });
    }
    if (path === "/oauth/token" && body.get("grant_type") === "refresh_token") {
      const collection = refreshes.get(body.get("refresh_token") ?? "");
      if (!collection) throw new Error("Unexpected fixture refresh");
      // A's valid credential still issues A authority, regardless of the UI account.
      return Response.json(tokens(collection));
    }
    if (/^\/v1\/next\/collections\/[0-9a-f-]+\/route$/u.test(path)) {
      const collection = path.split("/")[4];
      if (new Headers(init?.headers).get("authorization") !== `Bearer fixture-access-${collection}`) throw new Error("Wrong fixture route authority");
      return Response.json({ collection, targets: [], availability: { state: "available" } });
    }
    if (path === "/v1/next/apps/collections") {
      const authorization = new Headers(init?.headers).get("authorization");
      const collection = authorization?.slice("Bearer fixture-access-".length);
      if (collection !== PRIVATE_A && collection !== PRIVATE_B) throw new Error("Unexpected fixture inventory authority");
      observedInventory?.();
      return Response.json({ collections: [{ collection, name: collection === PRIVATE_A ? NAME_A : NAME_B,
        operations: ["read"], role: "owner", availability: { state: "available" } }] });
    }
    throw new Error("Unexpected scripted request; no network fallback exists");
  });
  const options = { store, fetch, callbacks };
  const make = () => new MdbaseAppGrants({ declaration, redirectUri: `${declaration.origin}/`, ...options });
  const popup = { navigate: (_url: string) => queueMicrotask(() => listener?.(callback)), close: vi.fn(), closed: false };
  const begin = async (account = ACCOUNT_A, collection = PRIVATE_A, issuedAccount = account) => {
    current = { account: issuedAccount, collection };
    const grants = make();
    const nonce = btoa(String.fromCharCode(...new Uint8Array(32).fill(19))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
    const prepared = await grants.prepareAuthorization({ expectedAccountId: account, authorizationNonce: nonce, collection });
    popup.navigate(prepared.authorizationUri);
    const finish = prepared.finish({ popup, collection });
    void finish.catch(() => {});
    return { grants, prepared, finish };
  };
  return { declaration, backing, store, options, make, begin, requests,
    choose: (account: string, collection: string) => { current = { account, collection }; },
    deliverCallback: () => queueMicrotask(() => listener?.(callback)),
    completion: () => { if (!completion) throw new Error("No fixture token completion"); return completion; },
    pauseNextWrite: (pause: () => Promise<void>) => { pauseWrite = pause; },
    nextInventory: () => {
      const observed = deferred<void>();
      observedInventory = () => { observedInventory = null; observed.resolve(); };
      return observed.promise;
    }
  };
}
