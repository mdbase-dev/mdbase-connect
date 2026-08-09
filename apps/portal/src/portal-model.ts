import type {
  AvailableCollection,
  ContractRequirement,
  PendingAuthorization,
  TypePackProvision
} from "./api";

const editorBaseUrl = import.meta.env?.VITE_MDBASE_EDITOR_URL ?? "https://editor.mdbase.dev/";

export function editorConnectUrl(connectOrigin = location.origin): string {
  const url = new URL("connect", editorBaseUrl);
  url.searchParams.set("server", new URL(connectOrigin).origin);
  return url.href;
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
export function scopeDescription(contracts: ContractRequirement[]) {
  const names = contracts.map((contract) => `${contract.id} v${contract.version}`);
  return `Access is limited to records matching ${names.join(" and ")}.`;
}
export function returnTarget() {
  const requested = new URLSearchParams(location.search).get("return_to");
  if (!requested) return "/";
  const target = new URL(requested, location.origin);
  return target.origin === location.origin ? target.href : "/";
}
export type PortalBootstrapSecrets = Readonly<{
  invitationToken: string;
  resetToken: string;
}>;

export function capturePortalBootstrapSecrets(
  currentLocation: Pick<Location, "hash" | "pathname" | "search"> = location,
  currentHistory: Pick<History, "replaceState" | "state"> = history
): PortalBootstrapSecrets {
  const parameters = new URLSearchParams(currentLocation.hash.slice(1));
  const secrets = Object.freeze({
    invitationToken: parameters.get("invitation")?.trim() ?? "",
    resetToken: parameters.get("reset")?.trim() ?? ""
  });
  if (secrets.invitationToken || secrets.resetToken) {
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
