/**
 * Another app can open a record here: `?collection=<id>#note=<path>`. The path rides in the
 * fragment so that it never reaches a server, and is kept for this tab until the collection it
 * belongs to starts, since signing in and approving can reload the page on the way.
 */
const key = "mdbase-editor:requested-note";

/** Takes `#note=` out of the address, remembering it for the collection the address names. */
export function captureRequestedNote(target: Location | URL = location, store: Pick<Storage, "setItem"> | undefined = sessionStore()): void {
  const url = new URL(target.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const path = fragment.get("note");
  if (path === null) return;
  fragment.delete("note");
  url.hash = fragment.toString();
  history.replaceState(history.state, "", url);
  const collection = url.searchParams.get("collection");
  if (!collection || !path) return;
  store?.setItem(key, JSON.stringify({ collection, path }));
}

/** The record a link asked for in this collection, once: undefined when there is none. */
export function takeRequestedNote(collectionId: string, store: Pick<Storage, "getItem" | "removeItem"> | undefined = sessionStore()): string | undefined {
  const saved = store?.getItem(key);
  if (!saved) return undefined;
  const requested = JSON.parse(saved) as { collection?: unknown; path?: unknown };
  if (requested.collection !== collectionId || typeof requested.path !== "string") return undefined;
  store?.removeItem(key);
  return requested.path;
}

/** Session storage, or nothing where the browser withholds it (a link then opens the collection only). */
function sessionStore(): Storage | undefined {
  try {
    return sessionStorage;
  } catch {
    return undefined;
  }
}
