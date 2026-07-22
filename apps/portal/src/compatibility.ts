import type {
  AvailableCollection,
  ContractRequirement,
  PendingAuthorization
} from "./api";

export type CollectionCompatibility =
  | { compatible: true }
  | {
      compatible: false;
      code: "collection_kind" | "legacy_spec" | "missing_contracts";
      label: string;
      detail: string;
    };

export function collectionCompatibility(
  request: Pick<PendingAuthorization, "requirements" | "provisions">,
  collection: AvailableCollection
): CollectionCompatibility {
  if (request.requirements.collection_kind === "hosted" && collection.kind !== "hosted") {
    return {
      compatible: false,
      code: "collection_kind",
      label: "Cloud collection required",
      detail: "This application needs a collection hosted by mdbase."
    };
  }
  if (!supportsMdbase03(collection.spec_version)) {
    return {
      compatible: false,
      code: "legacy_spec",
      label: "Needs mdbase 0.3",
      detail: `${collection.display_name} uses mdbase ${collection.spec_version}. Upgrade a copy to mdbase 0.3 and verify it before approving access; the original can stay untouched.`
    };
  }
  const unavailable = request.requirements.contracts.filter((requirement) =>
    !hasContract(collection.contracts, requirement)
    && !(collection.kind === "hosted" && request.provisions.types.some((provision) =>
      provision.provides.some((provided) => sameContract(provided, requirement))
    ))
  );
  if (unavailable.length > 0) {
    return {
      compatible: false,
      code: "missing_contracts",
      label: "Missing required types",
      detail: `This collection does not provide ${unavailable.map(contractLabel).join(" and ")}.`
    };
  }
  return { compatible: true };
}

export function supportsMdbase03(specVersion: string): boolean {
  return /^0\.3(?:\.|$)/.test(specVersion.trim());
}

function hasContract(contracts: ContractRequirement[], required: ContractRequirement): boolean {
  return contracts.some((contract) => sameContract(contract, required));
}

function sameContract(left: ContractRequirement, right: ContractRequirement): boolean {
  return left.id === right.id && left.version === right.version;
}

function contractLabel(contract: ContractRequirement): string {
  return `${contract.id} v${contract.version}`;
}
