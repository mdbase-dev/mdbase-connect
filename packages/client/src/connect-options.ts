import type { JsonObject, MdbaseAppManifest } from "@mdbase-dev/connect-protocol";
import type { GrantKeyStore } from "./crypto.js";
import type { ApplicationIdentityStore } from "./application-identity.js";

export interface MdbaseConnectTimeouts {
  requestMs?: number | null;
  watchStartMs?: number | null;
  uploadMs?: number | null;
  syncMs?: number | null;
}

export interface MdbaseConnectOptions {
  serverUrl: string | URL;
  /**
   * A bundled v1 application manifest or its app-local URL. String values
   * are loaded by this SDK and posted inline; Connect never fetches them.
   */
  manifest?: MdbaseAppManifest | string | URL;
  redirectUri?: string | URL;
  storage?: Storage;
  /** Encrypted relay is required by default for newly authorized grants. */
  relayEncryption?: "required" | "disabled";
  keyStore?: GrantKeyStore;
  /** Persistent installation signing identity; separate from disposable grant keys. */
  identityStore?: ApplicationIdentityStore;
  /** Prefer same-computer connector access when the browser permits it. */
  directAccess?: "auto" | "disabled";
  /** Loopback origin override for development and automated testing. */
  loopbackUrl?: string | URL;
  /** Override browser navigation, for example to use a native system browser. */
  navigate?: (url: string) => void | Promise<void>;
  /** Workload-specific defaults. Per-call timeoutMs always wins. */
  timeouts?: MdbaseConnectTimeouts;
}

export type MdbaseFrontmatter = JsonObject;
