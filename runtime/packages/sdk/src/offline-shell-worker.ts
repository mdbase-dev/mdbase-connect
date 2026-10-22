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
  skipWaiting(): Promise<void>;
  addEventListener(type: "message", listener: (event: ShellMessageEvent) => void): void;
  addEventListener(type: "install" | "activate", listener: (event: ShellEvent) => void): void;
  addEventListener(type: "fetch", listener: (event: ShellFetchEvent) => void): void;
}

/** Installs the same shell policy in generated workers and app notification workers.
 * Activation is explicit. Older tabs keep their pinned assets until they leave. */
export function installOfflineShell(worker: ShellWorker, manifest: OfflineShellManifest): void {
  const prefix = `mdbase-shell:${manifest.base}:`;
  const name = `${prefix}${manifest.version}`;
  const root = new URL(manifest.base, worker.location.origin);
  const index = new URL("index.html", root).href;
  const assets = new Map(manifest.assets.map(asset => [new URL(asset.path, root).href, asset.sha256]));
  let acceptingClient: string | undefined;
  const otherClients = async (except: readonly (string | undefined)[]) =>
    (await worker.clients.matchAll({ type: "window", includeUncontrolled: true }))
      .some(client => client.url.startsWith(root.href) && !except.includes(client.id));
  const clean = async () => {
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
        for (const [url, expected] of assets) {
          const options: RequestInit = { cache: "reload", credentials: "omit", redirect: "error" };
          let response: Response;
          try { response = await fetch(url, options); }
          catch (error) {
            const canonical = new URL(url);
            if (!canonical.pathname.endsWith(".html")) throw error;
            // Pages and similar hosts redirect HTML filenames to clean URLs. Try
            // that one public path directly; never follow arbitrary redirects.
            canonical.pathname = canonical.pathname.endsWith("/index.html")
              ? canonical.pathname.slice(0, -"index.html".length)
              : canonical.pathname.slice(0, -".html".length);
            response = await fetch(canonical.href, options);
          }
          if (!response.ok) throw new Error("Offline shell asset unavailable");
          const bytes = await response.clone().arrayBuffer();
          const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
          const actual = Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
          if (actual !== expected) throw new Error("Offline shell asset changed during deployment");
          await cache.put(url, response);
        }
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
        try { return await fetch(request); }
        catch {
          const cache = await caches.open(name);
          const shell = await cache.match(index);
          if (shell && !await otherClients([event.clientId, event.resultingClientId])) await clean();
          return shell ?? new Response("The app is not available offline yet. Reconnect and try again.", {
            status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
      })());
    }
  });
}
