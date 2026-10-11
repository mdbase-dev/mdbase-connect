import { connect, MdbaseError, type MdbaseApplicationDeclaration, type MdbaseApplicationSnapshot, type MdbaseClient } from "@mdbase-dev/sdk";
import type {
  AppGrantPopup,
  CollectionAvailability,
  MdbaseCollectionEntry,
  MdbasePrivateCollection,
  MdbaseWaitOptions
} from "@mdbase-dev/sdk/app-grant";
import { version } from "../package.json";

type AppInstallationCollection = MdbaseApplicationSnapshot["collections"][number];

/** Private collections reach the editor through an app grant and the relay to one
 * of the account's computers, not through the installation sign-in. This is the
 * whole surface the chooser uses, so tests can supply a fake. */
export interface PrivateCollections {
  /** Private collections this browser holds a grant for, with their availability. */
  collections(options?: { signal?: AbortSignal }): Promise<MdbasePrivateCollection[]>;
  /** Call synchronously from the click: reserves the consent popup before any await. */
  authorize(collection?: string, options?: { signal?: AbortSignal }): Promise<{ collectionId: string }>;
  /** Bounded wait while the person opens or approves the app on their computer. */
  waitForAvailable(collection: string, options?: MdbaseWaitOptions): Promise<CollectionAvailability>;
  /** A client for the available collection. The caller owns and closes it. */
  open(collection: string, options?: { signal?: AbortSignal }): Promise<MdbaseClient>;
  /** Forget the grant in this browser only. */
  forget(collection: string): Promise<void>;
  /** Cloud copies plus Private collections, by name (the SDK's `mergeCollectionEntries`). */
  merge(cloud: readonly AppInstallationCollection[], privates: readonly MdbasePrivateCollection[]): MdbaseCollectionEntry[];
}

/** Cloud copies only, before the app-grant code has loaded (no Private entries exist yet). */
function cloudEntries(cloud: readonly AppInstallationCollection[]): MdbaseCollectionEntry[] {
  return cloud.map((c) => ({ collectionId: c.collectionId, displayName: c.displayName, kind: "cloud_copy" as const, availability: { state: "available" as const }, role: c.role ?? null }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.collectionId.localeCompare(b.collectionId));
}

/** The declaration's redirect URI on its own origin; the editor root handles the callback. */
export function appGrantRedirectUri(declaration: MdbaseApplicationDeclaration): string {
  const declared = (declaration.manifest as { redirect_uris?: unknown }).redirect_uris;
  const uris = Array.isArray(declared) ? declared.filter((uri): uri is string => typeof uri === "string") : [];
  return uris.find((uri) => URL.canParse(uri) && new URL(uri).origin === declaration.origin) ?? new URL("/", declaration.origin).href;
}

/** The app-grant code (relay, Noise, grant storage) loads on first use, outside the initial bundle. */
export function appGrantCollections(declaration: MdbaseApplicationDeclaration): PrivateCollections {
  type Loaded = { module: typeof import("@mdbase-dev/sdk/app-grant"); grants: import("@mdbase-dev/sdk/app-grant").MdbaseAppGrants };
  let loaded: Loaded | null = null;
  let loading: Promise<Loaded> | null = null;
  const load = () => loading ??= import("@mdbase-dev/sdk/app-grant").then((module) =>
    (loaded = { module, grants: new module.MdbaseAppGrants({ declaration, redirectUri: appGrantRedirectUri(declaration) }) }))
    .catch((error: unknown) => { loading = null; throw error; });
  return {
    collections: async (options) => (await load()).grants.collections(options),
    authorize(collection, options = {}) {
      const popup = reservePopup();
      if (!popup) return Promise.reject(new MdbaseError({ code: "cancelled", recovery: "none", message: "Allow pop-ups for mdbase editor, then try again." }));
      return load().then(({ grants }) => grants.authorize({ popup, ...(collection ? { collection } : {}), ...(options.signal ? { signal: options.signal } : {}) }),
        (error: unknown) => { popup.close(); throw error; });
    },
    waitForAvailable: async (collection, options) => (await load()).grants.waitForAvailable(collection, options),
    open: async (collection, options = {}) => {
      const { grants } = await load();
      return connect({ connector: grants.connector(collection), app: { name: declaration.id, version }, ...(options.signal ? { signal: options.signal } : {}) });
    },
    forget: async (collection) => (await load()).grants.forget(collection),
    merge: (cloud, privates) => loaded ? loaded.module.mergeCollectionEntries(cloud, privates) : cloudEntries(cloud)
  };
}

function reservePopup(): AppGrantPopup | null {
  const opened = window.open("about:blank", "mdbase-private-access", "popup,width=520,height=720");
  if (!opened) return null;
  return {
    navigate: (url) => { opened.location.href = url; },
    close: () => opened.close(),
    get closed() { return opened.closed; }
  };
}

/** The consent popup lands back on the redirect URI with `state` and `code` or `error`. */
export function isAppGrantCallback(url: URL): boolean {
  return url.searchParams.has("state") && (url.searchParams.has("code") || url.searchParams.has("error"));
}

/** Hand the callback to the waiting editor tab. Returns false when there is nothing to deliver. */
export async function deliverAppGrantCallbackFrom(url: URL): Promise<boolean> {
  if (!isAppGrantCallback(url)) return false;
  (await import("@mdbase-dev/sdk/app-grant")).deliverAppGrantCallback(url.href);
  return true;
}
