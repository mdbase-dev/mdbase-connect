import type { ClientKey, RelayRoute } from "@mdbase-dev/sdk";

/**
 * How this web app reaches an mdbase-next collection: which collection, under
 * which grant, and where its replica is right now.
 *
 * This is the only place the editor depends on the control plane. Everything
 * here is a PROPOSAL pending the control workstream (see the PR): the consent
 * flow that registers this app's `client_pk` with a grant, and the routing
 * endpoint. Swap `ProposedControlPlaneAccess` when the real API lands.
 */
export interface NextAccess {
  collection: string;
  grant: string | null;
  displayName?: string;
  /** Where to connect now; `null` when no device of the collection is online. */
  resolveRoute(): Promise<RelayRoute | null>;
}

export interface NextAccessProvider {
  /** Stored access for the selected collection, or `null` before consent. */
  current(): Promise<NextAccess | null>;
  /** Start consent; resolves when stored access exists or the page navigates away. */
  authorize(): Promise<void>;
  forget(collection: string): void;
}

const STORAGE_KEY = "mdbase-editor:next-access";

interface StoredAccess {
  collection: string;
  grant: string | null;
  displayName?: string;
}

/** Response of the proposed routing endpoint. */
interface ProposedRouteResponse {
  targets: Array<{ url: string; device: string; noise_pk: string }>;
}

/**
 * PROPOSED control-plane endpoints (not implemented by any server yet):
 *
 * - `GET {serverUrl}/v1/next/authorize?client_pk=…&redirect_uri=…` starts consent and
 *   registers `client_pk` (base64url X25519) with the grant it issues. It redirects
 *   back with `next_collection`, `next_grant` and optional `next_name` query params.
 * - `GET {serverUrl}/v1/next/collections/:id/route` (cookie session, plus
 *   `X-Mdbase-Client-Pk`) answers `{targets: [{url, device, noise_pk}]}` with the
 *   online device replicas or the hosted replica. An empty list means no device is
 *   online, which the SDK reports as `unavailable` / `no_device_online`.
 */
export class ProposedControlPlaneAccess implements NextAccessProvider {
  constructor(
    private readonly serverUrl: string,
    private readonly key: () => Promise<ClientKey>,
    private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = localStorage,
    private readonly fetcher: typeof fetch = (...args) => fetch(...args)
  ) {}

  async current(): Promise<NextAccess | null> {
    const stored = this.adoptCallback() ?? this.read();
    if (!stored) return null;
    const publicKey = base64url((await this.key()).publicKey);
    return {
      ...stored,
      resolveRoute: async () => {
        const response = await this.fetcher(
          new URL(`v1/next/collections/${encodeURIComponent(stored.collection)}/route`, withSlash(this.serverUrl)),
          { credentials: "include", headers: { "X-Mdbase-Client-Pk": publicKey } }
        );
        if (!response.ok) throw new Error(`The route service answered ${response.status}.`);
        const target = ((await response.json()) as ProposedRouteResponse).targets[0];
        return target ? { url: target.url, targetDevice: target.device, noisePublicKey: fromBase64url(target.noise_pk) } : null;
      }
    };
  }

  async authorize(): Promise<void> {
    const url = new URL("v1/next/authorize", withSlash(this.serverUrl));
    url.searchParams.set("client_pk", base64url((await this.key()).publicKey));
    url.searchParams.set("redirect_uri", location.href);
    location.assign(url.href);
  }

  forget(collection: string): void {
    if (this.read()?.collection === collection) this.storage.removeItem(STORAGE_KEY);
  }

  private read(): StoredAccess | null {
    try {
      const value = JSON.parse(this.storage.getItem(STORAGE_KEY) ?? "null") as StoredAccess | null;
      return value && typeof value.collection === "string" ? value : null;
    } catch {
      return null;
    }
  }

  private adoptCallback(): StoredAccess | null {
    const url = new URL(location.href);
    const collection = url.searchParams.get("next_collection");
    if (!collection) return null;
    const access: StoredAccess = {
      collection,
      grant: url.searchParams.get("next_grant"),
      ...(url.searchParams.get("next_name") ? { displayName: url.searchParams.get("next_name")! } : {})
    };
    this.storage.setItem(STORAGE_KEY, JSON.stringify(access));
    for (const name of ["next_collection", "next_grant", "next_name"]) url.searchParams.delete(name);
    history.replaceState(history.state, "", url.href);
    return access;
  }
}

function withSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
