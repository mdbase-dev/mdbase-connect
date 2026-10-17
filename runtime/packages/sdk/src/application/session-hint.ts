/**
 * Page-side hint of the last paired session: the signed-in view and the
 * approved collections, from this browser. Presentation only, never authority:
 * the native session decides what opens. It lets a returning app show its
 * collection list at once while the session starts (P4), and lets a second
 * tab of the app say "open in another tab" instead of offering Sign in.
 * Signing out removes it.
 */
import type { AppInstallationCollection, AppInstallationSignInView } from "../app-host/installation-sign-in.js";
import type { AppWebSignInSnapshot } from "../app-host/web-sign-in-session.js";

export interface ApplicationSessionHint {
  readonly signIn: AppInstallationSignInView;
  readonly collections: readonly AppInstallationCollection[];
}
export interface ApplicationSessionHintStore {
  read(): ApplicationSessionHint | null;
  /** Record a settled paired snapshot; a signed-out one clears the hint. */
  observe(snapshot: AppWebSignInSnapshot): void;
  clear(): void;
}

const ROLES = new Set(["owner", "editor", "viewer"]);
const text = (v: unknown, max = 512): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const SETTLED = new Set(["unselected", "opening", "setup_required", "ready"]);

function collection(v: unknown): AppInstallationCollection | null {
  const c = v as AppInstallationCollection;
  if (!c || typeof c !== "object" || !text(c.collectionId, 64) || typeof c.displayName !== "string" || c.displayName.length > 512 || !ROLES.has(c.role)) return null;
  return Object.freeze({ collectionId: c.collectionId, displayName: c.displayName, role: c.role });
}
function view(v: unknown): AppInstallationSignInView | null {
  const s = v as AppInstallationSignInView;
  if (!s || typeof s !== "object" || s.state !== "paired" || !text(s.requestId, 64) || !text(s.installationId, 64) || !text(s.deviceId, 64)
    || !text(s.appId, 64) || (s.kind !== "app-runtime" && s.kind !== "mobile") || !text(s.verificationUri, 2048) || !text(s.accountId, 64)
    || !Array.isArray(s.collectionIds) || s.collectionIds.length > 1024 || !s.collectionIds.every(id => text(id, 64))) return null;
  return Object.freeze({
    requestId: s.requestId, installationId: s.installationId, deviceId: s.deviceId, appId: s.appId, kind: s.kind,
    verificationUri: s.verificationUri, state: "paired", accountId: s.accountId,
    ...(typeof s.accountEmail === "string" && s.accountEmail.length <= 320 ? { accountEmail: s.accountEmail } : {}),
    collectionIds: Object.freeze([...s.collectionIds]), createCollections: s.createCollections === true, requestedCreateCollections: s.requestedCreateCollections === true,
  });
}

export function applicationSessionHint(namespace: string, cpOrigin: string): ApplicationSessionHintStore {
  const key = `mdbase.${namespace}.session-hint.v1.${encodeURIComponent(cpOrigin)}`;
  let cached: { raw: string | null; value: ApplicationSessionHint | null } | null = null, written: string | null = null;
  const storage = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };
  const read = (): ApplicationSessionHint | null => {
    let raw: string | null = null;
    try { raw = storage()?.getItem(key) ?? null; } catch { return null; }
    if (cached && cached.raw === raw) return cached.value;
    let value: ApplicationSessionHint | null = null;
    try {
      const parsed = raw ? JSON.parse(raw) as { v?: unknown; signIn?: unknown; collections?: unknown } : null;
      const signIn = parsed?.v === 1 ? view(parsed.signIn) : null;
      const list = Array.isArray(parsed?.collections) && parsed.collections.length <= 1024 ? parsed.collections.map(collection) : null;
      if (signIn && list && list.every(c => c !== null)) value = Object.freeze({ signIn, collections: Object.freeze(list as AppInstallationCollection[]) });
    } catch { value = null; }
    cached = { raw, value };
    return value;
  };
  const clear = () => { written = null; try { storage()?.removeItem(key); } catch { /* optional */ } };
  return Object.freeze({
    read,
    clear,
    observe(snapshot: AppWebSignInSnapshot) {
      if (snapshot.status === "signed_out" && snapshot.signIn === null) { if (written !== "") { clear(); written = ""; } return; }
      if (!SETTLED.has(snapshot.status) || snapshot.signIn?.state !== "paired") return;
      const signIn = view(snapshot.signIn), collections = snapshot.collections.map(collection);
      if (!signIn || !collections.every(c => c !== null)) return;
      const raw = JSON.stringify({ v: 1, signIn, collections });
      if (raw === written) return;
      written = raw;
      try { storage()?.setItem(key, raw); } catch { /* optional */ }
    },
  });
}
