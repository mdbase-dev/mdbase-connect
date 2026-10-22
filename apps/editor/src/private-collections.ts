import type { MdbaseApplicationSnapshot, MdbaseClient } from "@mdbase-dev/sdk";
import type {
  CollectionAvailability,
  MdbaseCollectionEntry,
  MdbasePrivateCollection,
  MdbaseWaitOptions
} from "@mdbase-dev/sdk/app-grant";

type AppInstallationCollection = MdbaseApplicationSnapshot["collections"][number];

/** Isolated test-adapter surface. Production collection authority and lifetime
 * belong to the SDK's account-bound Native controller. */
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
