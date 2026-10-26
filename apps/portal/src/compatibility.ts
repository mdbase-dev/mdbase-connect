import { t } from "@lingui/core/macro";
import { i18n } from "@mdbase-dev/ui/i18n";
import type {
  AvailableCollection,
  UnavailableConnector,
  ContractRequirement,
  PendingAuthorization
} from "./api";

export type CollectionCompatibility =
  | { compatible: true }
  | {
      compatible: false;
      code: "collection_kind" | "legacy_spec" | "missing_contracts" | "permissions";
      label: string;
      detail: string;
    };

export function collectionCompatibility(
  request: Pick<PendingAuthorization, "distribution" | "requirements" | "provisions" | "requested_operations">,
  collection: AvailableCollection
): CollectionCompatibility {
  if (collection.authorization?.available === false) {
    return {
      compatible: false,
      code: "permissions",
      label: t(i18n)({ message: "More access required", context: "Connect interface" }),
      detail: collection.authorization.detail
    };
  }
  if (request.requirements.collection_kind === "hosted" && collection.kind !== "hosted") {
    return {
      compatible: false,
      code: "collection_kind",
      label: t(i18n)({ message: "Cloud collection required" }),
      detail: t(i18n)({ message: "This application needs a collection hosted by mdbase." })
    };
  }
  if (requiresMdbase03(request.requested_operations) && !supportsMdbase03(collection.spec_version)) {
    return {
      compatible: false,
      code: "legacy_spec",
      label: t(i18n)({ message: "Needs mdbase 0.3", context: "Connect interface" }),
      detail: t(i18n)`${collection.display_name} uses mdbase ${collection.spec_version}. Upgrade a copy to mdbase 0.3 and verify it before approving access; the original can stay untouched.`
    };
  }
  // A Private collection's types are end-to-end encrypted; the app checks them once connected.
  if (collection.kind === "private") return { compatible: true };
  const unavailable = request.requirements.contracts.filter((requirement) =>
    !hasContract(collection.contracts, requirement)
    && !request.provisions.type_packs.some((provision) =>
      provision.provides.some((provided) => sameContract(provided, requirement))
    )
  );
  if (unavailable.length > 0) {
    return {
      compatible: false,
      code: "missing_contracts",
      label: t(i18n)({ message: "Missing required types", context: "Connect interface" }),
      detail: t(i18n)`This collection does not provide ${new Intl.ListFormat(i18n.locale, { type: "conjunction" }).format(unavailable.map(contractLabel))}.`
    };
  }
  return { compatible: true };
}

export function supportsMdbase03(specVersion: string): boolean {
  return /^0\.3(?:\.|$)/.test(specVersion.trim());
}

const PORTABLE_PROFILE_OPERATIONS = new Set([
  "query",
  "list_views",
  "execute_view",
  "read_type",
  "create_type",
  "update_type",
  "assess_type_pack",
  "apply_type_pack"
]);

function requiresMdbase03(operations: readonly string[]): boolean {
  return operations.some((operation) => PORTABLE_PROFILE_OPERATIONS.has(operation));
}

function hasContract(contracts: ContractRequirement[], required: ContractRequirement): boolean {
  return contracts.some((contract) => sameContract(contract, required));
}

function sameContract(left: ContractRequirement, right: ContractRequirement): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest;
}

function contractLabel(contract: ContractRequirement): string {
  return t(i18n)`${contract.id} v${contract.version}`;
}

export function lostCollectionNotice(
  collection: AvailableCollection,
  unavailable: Array<{ collection: AvailableCollection; compatibility: ReturnType<typeof collectionCompatibility> }>,
  unavailableConnectors: UnavailableConnector[]
): string {
  const incompatible = unavailable.find((choice) => choice.collection.id === collection.id)?.compatibility;
  if (incompatible && !incompatible.compatible) {
    return t(i18n)`${collection.display_name} can no longer be used: ${incompatible.detail} Choose another collection.`;
  }
  const connector = unavailableConnectors.find((candidate) => candidate.connector_name === collection.connector_name);
  if (connector) {
    return connector.reason === "paused" ? t(i18n)`${collection.display_name} is unavailable because ${connector.connector_name} has remote access paused. Choose another collection.` : t(i18n)`${collection.display_name} is unavailable because ${connector.connector_name} is offline. Choose another collection.`;
  }
  return t(i18n)`${collection.display_name} is no longer available. Choose another collection.`;
}
