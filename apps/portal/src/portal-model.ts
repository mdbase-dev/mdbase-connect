import type {
  AvailableCollection,
  ContractRequirement,
  PendingAuthorization,
  TypePackProvision
} from "./api";

export function installationAccountLabel(pairing: {
  account_selection_confirmed?: boolean;
  account_email?: string | null; account_provider?: string | null; account_login?: string | null;
  signed_in_account_email?: string | null; signed_in_account_provider?: string | null; signed_in_account_login?: string | null;
}): string | null {
  const confirmed = pairing.account_selection_confirmed;
  const email = confirmed ? pairing.account_email : pairing.signed_in_account_email;
  const provider = confirmed ? pairing.account_provider : pairing.signed_in_account_provider;
  const login = confirmed ? pairing.account_login : pairing.signed_in_account_login;
  return email || (provider === "github" && login ? `GitHub account @${login}` : null);
}

/** Where a denied pairing leaves this window. An app's sign-in or consent
 * window ends here: the app reads the denial as a cancelled outcome, so the
 * window closes (the app opened it) and otherwise shows "Sign-in cancelled" in
 * place. It never navigates into another app, such as the Editor. Only the
 * legacy computer pairing returns to the portal home. */
export function finishDeniedPairing(
  pairing: { installation_device?: boolean },
  target: { close(): void; location: { href: string } }
): "cancelled" | "home" {
  if (!pairing.installation_device) {
    target.location.href = "/";
    return "home";
  }
  try { target.close(); } catch { /* A window the browser keeps open shows the cancelled page. */ }
  return "cancelled";
}

export const NEW_COLLECTION = "new-collection";

export function pairingInspectionPath(pairingId: string, search: string): string {
  const incoming = new URLSearchParams(search), query = new URLSearchParams();
  for (const key of ["collection_hint", "return_url"]) {
    const value = incoming.get(key);
    if (value) query.set(key, value);
  }
  const encoded = query.toString();
  return `/v1/pairing-requests/${pairingId}${encoded ? `?${encoded}` : ""}`;
}

export function initialInstallationCollection(pairing: {
  account_selection_confirmed?: boolean;
  selected_collection_id?: string | null;
  collection_hint?: string | null;
  creation?: { collection_id: string; completed: boolean } | null;
  collections?: Array<{ collection_id: string }>;
}): string {
  if (pairing.creation && !pairing.creation.completed) return NEW_COLLECTION;
  if (pairing.selected_collection_id) return pairing.selected_collection_id;
  if (pairing.creation?.completed) return pairing.creation.collection_id;
  return pairing.account_selection_confirmed && pairing.collections?.some(collection => collection.collection_id === pairing.collection_hint)
    ? pairing.collection_hint! : "";
}

export function initials(value: string) { return value.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(); }
export function message(value: unknown) {
  let detail = value instanceof Error ? value.message : String(value);
  if (value && typeof value === "object" && "details" in value) {
    const diagnostics = (value.details as { diagnostics?: unknown } | undefined)?.diagnostics;
    const first = Array.isArray(diagnostics) ? diagnostics[0] : undefined;
    if (first && typeof first === "object") {
      const diagnostic = first as { message?: unknown; path?: unknown };
      if (typeof diagnostic.message === "string") {
        detail = typeof diagnostic.path === "string"
          ? `${diagnostic.message} (${diagnostic.path})`
          : diagnostic.message;
      }
    }
  }
  if (/failed to fetch|networkerror|network request failed/i.test(detail)) {
    return "mdbase connect could not reach the service. Check your connection and try again.";
  }
  if (/authorization.+(?:expired|not found)|request.+(?:expired|not found)/i.test(detail)) {
    return "This application request has expired. Return to the application and start again.";
  }
  if (/unsupported.+protocol|up-to-date connector|no longer compatible/i.test(detail)) {
    return "The mdbase connect app on this computer needs to be updated before you can continue.";
  }
  return detail;
}
/** A device sign-in step the portal refused. `cancel` marks refusals that no
 * retry in this window can fix: the portal cancels the window so the app stops
 * waiting and can offer sign-in again. Everything else stays retryable here. */
export function installationRefusal(reason: unknown, app: string): { heading: string; message: string; cancel: boolean } {
  const code = reason && typeof reason === "object" && "code" in reason ? (reason as { code?: unknown }).code : undefined;
  if (code === "installation_legacy_backend") {
    const details = (reason as { details?: unknown }).details;
    const upgrade = details && typeof details === "object" ? (details as { upgrade?: unknown }).upgrade : undefined;
    // Mid-upgrade the same window works once it finishes, so keep it open.
    if (upgrade === "in_progress")
      return { heading: "Account upgrade in progress", cancel: false, message: "Your mdbase account is being upgraded. This usually takes a few minutes. Try again shortly." };
    if (upgrade === "scheduled")
      return { heading: "Account upgrade scheduled", cancel: true, message: `Your mdbase account will be upgraded soon, so ${app} can't use it yet. Sign in again from ${app} once it is.` };
    return { heading: "Account upgrade needed", cancel: true, message: `Your mdbase account hasn't been upgraded yet, so ${app} can't use it. Email support@mdbase.dev and we'll upgrade it, or go back to ${app} to sign in with a different account.` };
  }
  if (code === "strict_device_approval")
    return { heading: "Desktop approval needed", cancel: true, message: `This account approves new devices from the mdbase desktop app. Add this device from the desktop app, then sign in again in ${app}.` };
  return { heading: "Couldn't finish sign-in", cancel: false, message: message(reason) };
}
export function host(value: string) { try { return new URL(value).host; } catch { return value; } }
export function formatDeviceCode(value: string) {
  const canonical = value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return canonical.length > 4
    ? `${canonical.slice(0, 4)}-${canonical.slice(4)}`
    : canonical;
}
export function neededProvisions(
  request: Pick<PendingAuthorization, "requirements" | "provisions">,
  _collection: Pick<AvailableCollection, "contracts">
): TypePackProvision[] {
  return request.provisions.type_packs;
}

export function hasContract(contracts: ContractRequirement[], required: ContractRequirement) { return contracts.some((contract) => sameContract(contract, required)); }
function sameContract(left: ContractRequirement, right: ContractRequirement) { return left.id === right.id && left.version === right.version && left.digest === right.digest; }
export function provisionNames(provisions: TypePackProvision[]) {
  return provisions
    .map((provision) => provision.manifest.name ?? provision.manifest.id)
    .join(" and ");
}
type ReturnLocation = Pick<Location, "origin" | "search">;

function validatedReturnTarget(currentLocation: ReturnLocation): URL | null {
  const requested = new URLSearchParams(currentLocation.search).get("return_to");
  if (!requested) return null;
  try {
    const target = new URL(requested, currentLocation.origin);
    return target.origin === currentLocation.origin ? target : null;
  } catch {
    return null;
  }
}

export function returnTarget(currentLocation: ReturnLocation = location) {
  return validatedReturnTarget(currentLocation)?.href ?? "/";
}

export function signInUrl(currentLocation: ReturnLocation = location): string {
  const target = validatedReturnTarget(currentLocation);
  if (!target) return "/login";
  const login = new URL("/login", currentLocation.origin);
  login.searchParams.set("return_to", target.href);
  return `${login.pathname}${login.search}`;
}
export type PortalBootstrapSecrets = Readonly<{
  invitationToken: string;
  verificationToken: string;
  resetToken: string;
  unsubscribeToken: string;
}>;

export function capturePortalBootstrapSecrets(
  currentLocation: Pick<Location, "hash" | "pathname" | "search"> = location,
  currentHistory: Pick<History, "replaceState" | "state"> = history
): PortalBootstrapSecrets {
  const parameters = new URLSearchParams(currentLocation.hash.slice(1));
  const secrets = Object.freeze({
    invitationToken: parameters.get("invitation")?.trim() ?? "",
    verificationToken: parameters.get("verification")?.trim() ?? "",
    resetToken: parameters.get("reset")?.trim() ?? "",
    unsubscribeToken: parameters.get("unsubscribe")?.trim() ?? ""
  });
  if (
    secrets.invitationToken
    || secrets.verificationToken
    || secrets.resetToken
    || secrets.unsubscribeToken
  ) {
    currentHistory.replaceState(
      currentHistory.state,
      "",
      `${currentLocation.pathname}${currentLocation.search}`
    );
  }
  return secrets;
}
export function isAuthorizationReturnTarget() {
  try {
    return new URL(returnTarget(), location.origin).pathname.startsWith("/authorize/");
  } catch {
    return false;
  }
}
export function relativeTime(value: string) {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1_000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return format.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, "hour");
  return format.format(Math.round(hours / 24), "day");
}
