/** Public, build-pinned app assets only. Collection/auth traffic is never cached here. */
export interface OfflineShellManifest {
  base: string;
  version: string;
  assets: { path: string; sha256: string }[];
}
interface ShellEvent { waitUntil(promise: Promise<unknown>): void }
interface ShellFetchEvent extends ShellEvent {
  request: Request;
  clientId?: string;
  resultingClientId?: string;
  respondWith(response: Promise<Response>): void;
}
interface ShellClient { id: string; url: string }
interface ShellMessageEvent extends ShellEvent { data: unknown; source: ShellClient | null }
interface ShellWorker {
  location: { origin: string };
  clients: { claim(): Promise<void>; matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<readonly ShellClient[]> };
  /** A release installing or waiting behind this one owns one of the other caches. */
  registration: { readonly installing: unknown; readonly waiting: unknown };
  skipWaiting(): Promise<void>;
  addEventListener(type: "message", listener: (event: ShellMessageEvent) => void): void;
  addEventListener(type: "install" | "activate", listener: (event: ShellEvent) => void): void;
  addEventListener(type: "fetch", listener: (event: ShellFetchEvent) => void): void;
}

/** Installs the same shell policy in generated workers and app notification workers.
 * A page and its same-named assets always come from one release: a navigation to
 * a pinned page is answered from the controlling worker's own cache, never with a
 * newer deployment's HTML. A new release waits until a page asks for it (the
 * generated registration does so when the app starts) and then reloads into it.
 * Other open tabs keep their pinned assets until they leave. */
export function installOfflineShell(worker: ShellWorker, manifest: OfflineShellManifest): void {
  const prefix = `mdbase-shell:${manifest.base}:`;
  const name = `${prefix}${manifest.version}`;
  const root = new URL(manifest.base, worker.location.origin);
  const index = new URL("index.html", root).href;
  const assets = new Map(manifest.assets.map(asset => [new URL(asset.path, root).href, asset.sha256]));
  const fetchAsset = async (url: string, expected: string): Promise<Response> => {
    const response = await fetch(url, { cache: "reload", credentials: "omit", redirect: "error" });
    if (!response.ok) throw new Error("Offline shell asset unavailable");
    const bytes = await response.clone().arrayBuffer();
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const actual = Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
    if (actual !== expected) throw new Error("Offline shell asset changed during deployment");
    return response;
  };
  const fetchPinnedAsset = (url: string, expected: string): Promise<Response> => {
    const cleanUrl = new URL(url);
    if (!cleanUrl.pathname.endsWith(".html")) return fetchAsset(url, expected);
    // Pages redirects HTML filenames to clean URLs. Prefer that URL, and try
    // the filename for hosts that serve it directly or rewrite the clean URL.
    // Both responses must match the manifest and redirects are still refused.
    cleanUrl.pathname = cleanUrl.pathname.endsWith("/index.html")
      ? cleanUrl.pathname.slice(0, -"index.html".length)
      : cleanUrl.pathname.slice(0, -".html".length);
    return fetchAsset(cleanUrl.href, expected).catch(() => fetchAsset(url, expected));
  };
  /** The pinned page a navigation names: `dir/` is `dir/index.html`, a clean URL
   * `page` is `page.html`. Its query is the page's own business, never a cache key. */
  const pinnedPage = (url: URL): string | undefined => {
    const path = url.pathname;
    const page = new URL(path.endsWith("/") ? `${path}index.html` : path.endsWith(".html") ? path : `${path}.html`, root).href;
    return assets.has(page) ? page : undefined;
  };
  let acceptingClient: string | undefined;
  const otherClients = async (except: readonly (string | undefined)[]) =>
    (await worker.clients.matchAll({ type: "window", includeUncontrolled: true }))
      .some(client => client.url.startsWith(root.href) && !except.includes(client.id));
  /** Retire older releases' caches, never a newer one that is installing or waiting. */
  const clean = async () => {
    if (worker.registration.installing || worker.registration.waiting) return;
    for (const key of await caches.keys()) if (key.startsWith(prefix) && key !== name) await caches.delete(key);
  };
  worker.addEventListener("message", event => {
    if (!event.data || typeof event.data !== "object" || (event.data as { type?: unknown }).type !== "mdbase-shell:activate") return;
    if (!event.source?.url.startsWith(root.href)) return;
    acceptingClient = event.source.id;
    event.waitUntil(worker.skipWaiting());
  });
  worker.addEventListener("install", event => {
    event.waitUntil((async () => {
      const cache = await caches.open(name);
      try {
        // Sequential fetches bound peak memory for the native WASM assets.
        for (const [url, expected] of assets) await cache.put(url, await fetchPinnedAsset(url, expected));
      } catch (error) {
        await caches.delete(name);
        throw error;
      }
    })());
  });
  worker.addEventListener("activate", event => {
    event.waitUntil((async () => {
      if (!await otherClients([acceptingClient])) await clean();
      await worker.clients.claim();
    })());
  });
  worker.addEventListener("fetch", event => {
    const request = event.request;
    if (request.method !== "GET") return;
    const url = new URL(request.url);
    if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) return;
    // Exact URLs only: query-bearing auth/callback traffic must never be cached.
    if (assets.has(url.href)) {
      event.respondWith((async () => {
        const cache = await caches.open(name);
        return await cache.match(url.href) ?? fetch(request);
      })());
    } else if (!url.search && ["script", "style", "font", "image", "worker"].includes(request.destination)) {
      // A controller replacement must not strand another tab's lazy imports.
      event.respondWith((async () => {
        for (const key of await caches.keys()) {
          if (!key.startsWith(prefix)) continue;
          const cached = await (await caches.open(key)).match(url.href);
          if (cached) return cached;
        }
        return fetch(request);
      })());
    } else if (request.mode === "navigate") {
      event.respondWith((async () => {
        const cache = await caches.open(name);
        const page = pinnedPage(url);
        // This release's own page: another deployment's HTML would load against
        // this release's same-named styles and scripts.
        let shell = page === undefined ? undefined : await cache.match(page);
        if (!shell) {
          try { return await fetch(request); }
          catch { shell = await cache.match(index); }
        }
        if (shell && !await otherClients([event.clientId, event.resultingClientId])) await clean();
        return shell ?? new Response("The app is not available offline yet. Reconnect and try again.", {
          status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      })());
    }
  });
}
