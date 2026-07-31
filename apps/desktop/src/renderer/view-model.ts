import type { ConnectionDotState } from "./connection-state.mjs";

export type Route = "overview" | "collections" | "access" | "activity" | "settings";

export interface AuthorizationCollection {
  id: string;
  display_name: string;
  spec_version: string;
  contracts: ContractRequirement[];
  kind: "local" | "hosted";
  provisionable: boolean;
  types: CollectionTypeDescriptor[];
}

export const allOperations = ["describe", "changes", "read", "query", "list_views", "execute_view", "read_view_source", "create", "update", "rename", "delete", "create_view_source", "update_view_source", "delete_view_source", "validate", "read_type", "create_type", "update_type", "install_type_pack", "list_timers", "put_timer", "cancel_timer", "reconcile_timers"];

export function neededProvisions(
  requirements: ApplicationRequirements,
  provisions: ApplicationProvisions | undefined,
  collection: Pick<AuthorizationCollection, "contracts">
): TypePackProvision[] {
  const missing = requirements.contracts.filter((requirement) => !hasContract(collection.contracts, requirement));
  return (provisions?.type_packs ?? []).filter((provision) =>
    provision.provides.some((provided) => missing.some((requirement) => sameContract(provided, requirement)))
  );
}

const MDBASE_03_OPERATIONS = new Set([
  "query",
  "list_views",
  "execute_view",
  "read_type",
  "create_type",
  "update_type",
  "install_type_pack"
]);

export function hostedCollectionCompatible(
  request: PendingAuthorization,
  collection: HostedCollectionSummary
): boolean {
  if (
    request.requested_operations.some((operation) => MDBASE_03_OPERATIONS.has(operation))
    && !/^0\.3(?:\.|$)/.test(collection.spec_version)
  ) {
    return false;
  }
  return request.requirements.contracts.every((required) =>
    hasContract(collection.contracts, required)
    || request.provisions.type_packs.some((provision) =>
      provision.provides.some((provided) => sameContract(provided, required))
    )
  );
}

export function mirrorState(mirror: DesktopMirrorSummary | undefined): {
  dot: ConnectionDotState;
  label: string;
} {
  if (!mirror) return { dot: "idle", label: "Not mirrored" };
  if (mirror.promotion) {
    return {
      dot: "connecting",
      label: authorityPromotionPhaseLabel(mirror.promotion.phase)
    };
  }
  if (mirror.syncing) return { dot: "connecting", label: "Synchronizing" };
  if (mirror.error || mirror.state === "offline") return { dot: "danger", label: "Mirror needs attention" };
  if (mirror.conflicts.length > 0) return { dot: "paused", label: "Conflicts need a decision" };
  if (mirror.local_issues.length > 0 || mirror.state === "attention") return { dot: "paused", label: "Local files need attention" };
  if (mirror.state === "changes_waiting" || mirror.pending > 0) return { dot: "connecting", label: "Changes waiting" };
  if (mirror.state === "not_initialized") return { dot: "idle", label: "Not synchronized yet" };
  return { dot: "connected", label: "Up to date" };
}

export function authorityPromotionState(
  collection: HostedCollectionSummary,
  mirror: DesktopMirrorSummary | undefined,
  starting: boolean
): { enabled: boolean; title: string; detail: string; button: string } {
  if (!mirror) {
    return {
      enabled: false,
      title: "A two-way mirror is required",
      detail: "Create and synchronize a two-way mirror on this computer first.",
      button: "Move authority to this computer"
    };
  }
  if (starting && !mirror.promotion) {
    return {
      enabled: false,
      title: "Preparing authority transfer",
      detail: "Checking the folder before opening browser confirmation.",
      button: "Preparing transfer…"
    };
  }
  if (mirror.promotion) {
    const label = authorityPromotionPhaseLabel(mirror.promotion.phase);
    return {
      enabled: false,
      title: label,
      detail: mirror.promotion.phase === "awaiting_approval"
        ? "Approve the move in your browser. Hosted writes continue until approval."
        : "Keep mdbase connect open while the handoff finishes.",
      button: `${label}…`
    };
  }
  if (mirror.promotion_pending) {
    return {
      enabled: true,
      title: "Authority transfer ready to resume",
      detail: "The folder was already verified. Finish activating it as the source of truth.",
      button: "Resume authority move"
    };
  }
  if (mirror.mode !== "read_write") {
    return {
      enabled: false,
      title: "A two-way mirror is required",
      detail: "Receive-only folders cannot become authoritative. Recreate this mirror as two-way.",
      button: "Move authority to this computer"
    };
  }
  if (collection.authority_state !== "active") {
    return {
      enabled: false,
      title: "Authority transfer already in progress",
      detail: "Return to the browser confirmation or wait for the current request to expire.",
      button: "Move authority to this computer"
    };
  }
  if (mirror.syncing) {
    return {
      enabled: false,
      title: "Mirror is synchronizing",
      detail: "Authority can move after the current synchronization finishes.",
      button: "Move authority to this computer"
    };
  }
  if (
    mirror.error
    || mirror.state === "offline"
    || mirror.conflicts.length > 0
    || mirror.local_issues.length > 0
    || mirror.state === "attention"
  ) {
    return {
      enabled: false,
      title: "Mirror needs attention",
      detail: "Resolve mirror errors and file conflicts before moving authority.",
      button: "Move authority to this computer"
    };
  }
  if (mirror.state !== "up_to_date" || mirror.pending > 0) {
    return {
      enabled: false,
      title: "Synchronize this mirror first",
      detail: "The folder must match the hosted collection before it can become authoritative.",
      button: "Move authority to this computer"
    };
  }
  return {
    enabled: true,
    title: "Move authority to this computer",
    detail: "Browser confirmation will pause hosted writes, verify this folder, and revoke existing application access.",
    button: "Move authority to this computer"
  };
}

function authorityPromotionPhaseLabel(
  phase: NonNullable<DesktopMirrorSummary["promotion"]>["phase"]
): string {
  if (phase === "synchronizing") return "Synchronizing mirror";
  if (phase === "awaiting_approval") return "Waiting for browser approval";
  if (phase === "verifying") return "Verifying exact folder contents";
  if (phase === "registering") return "Registering local authority";
  if (phase === "registered" || phase === "activating") return "Activating local authority";
  if (phase === "resuming") return "Resuming authority transfer";
  return "Finishing authority transfer";
}

export function hasContract(contracts: ContractRequirement[], required: ContractRequirement) { return contracts.some((contract) => sameContract(contract, required)); }
function sameContract(left: ContractRequirement, right: ContractRequirement) { return left.id === right.id && left.version === right.version; }
export function provisionNames(provisions: TypePackProvision[]) {
  return provisions
    .map((provision) => provision.manifest.name ?? provision.manifest.id)
    .join(" and ");
}

export function scopeDescription(contracts: ContractRequirement[]): string {
  const names = contracts.map((contract) => `${contract.id} v${contract.version}`);
  return `Records matching ${names.join(" and ")} only`;
}

export function host(value: string) { try { return new URL(value).host; } catch { return value; } }
export function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function plural(count: number, singular: string, pluralValue: string) { return count === 1 ? singular : pluralValue; }
export function relativeTime(value: string) {
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  const seconds = Math.round((date.getTime() - Date.now()) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

