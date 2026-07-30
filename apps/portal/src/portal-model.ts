import type {
  AvailableCollection,
  ContractRequirement,
  DashboardData,
  PendingAuthorization,
  TypePackProvision
} from "./api";

export const allOperations = ["describe", "changes", "read", "query", "list_views", "execute_view", "read_view_source", "validate", "create", "update", "delete", "rename", "create_view_source", "update_view_source", "delete_view_source", "read_type", "create_type", "update_type", "install_type_pack", "list_timers", "put_timer", "cancel_timer", "reconcile_timers"];

const editorBaseUrl = import.meta.env.VITE_MDBASE_EDITOR_URL ?? "https://editor.mdbase.dev/";

export function editorUrl(collectionId?: string): string {
  const url = new URL(editorBaseUrl);
  if (collectionId) url.searchParams.set("collection", collectionId);
  return url.href;
}

export function initials(value: string) { return value.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(); }
export function message(value: unknown) { return value instanceof Error ? value.message : String(value); }
export function host(value: string) { try { return new URL(value).host; } catch { return value; } }
export function formatDeviceCode(value: string) {
  const canonical = value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return canonical.length > 4
    ? `${canonical.slice(0, 4)}-${canonical.slice(4)}`
    : canonical;
}
export function pluralLabel(count: number, singular: string, pluralValue: string) { return `${count} ${count === 1 ? singular : pluralValue}`; }
export function neededProvisions(
  request: Pick<PendingAuthorization, "requirements" | "provisions">,
  collection: Pick<AvailableCollection, "contracts">
): TypePackProvision[] {
  const missing = request.requirements.contracts.filter((requirement) => !hasContract(collection.contracts, requirement));
  return request.provisions.type_packs.filter((provision) =>
    provision.provides.some((provided) => missing.some((requirement) => sameContract(provided, requirement)))
  );
}

export function hasContract(contracts: ContractRequirement[], required: ContractRequirement) { return contracts.some((contract) => sameContract(contract, required)); }
function sameContract(left: ContractRequirement, right: ContractRequirement) { return left.id === right.id && left.version === right.version; }
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
export function invitationTokenFromFragment() {
  return tokenFromFragment("invitation");
}
export function tokenFromFragment(name: string) {
  const token = new URLSearchParams(location.hash.slice(1))
    .get(name)
    ?.trim() ?? "";
  if (location.hash) {
    history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  }
  return token;
}
export function isAuthorizationReturnTarget() {
  try {
    return new URL(returnTarget(), location.origin).pathname.startsWith("/authorize/");
  } catch {
    return false;
  }
}
export function identityLabel(user: { email: string | null; login: string | null }) {
  return user.login ? `@${user.login}` : user.email ?? "Identity unavailable";
}
export function authenticationLabel(provider: DashboardData["authentication"]["provider"]) {
  if (provider === "google") return "Google";
  if (provider === "github") return "GitHub";
  if (provider === "tailscale") return "Tailscale identity";
  if (provider === "password") return "Email and password";
  return "Development session";
}
export function registrationLabel(registration: DashboardData["authentication"]["registration"]) {
  if (registration === "open") return "Open";
  if (registration === "invite") return "Invitation only";
  return "Closed";
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

