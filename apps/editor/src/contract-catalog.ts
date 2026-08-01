import type { TypePackProvision } from "@mdbase-dev/connect";

export const DEFAULT_CONTRACT_CATALOG_URL = import.meta.env.VITE_MDBASE_CONTRACT_CATALOG_URL
  ?? "https://mdbase.dev/contracts/catalog.json";

export interface ContractCatalogReference {
  id: string;
  version: string;
}

export interface ContractCatalogStandard {
  name: string;
  version: string;
  scope: string;
  references: string[];
}

export interface ContractCatalogContract extends ContractCatalogReference {
  name: string;
  description: string;
  contractType: "record" | "event" | "action";
  digest: string;
  artifactUrl: string;
  standards: ContractCatalogStandard[];
}

export interface ContractCatalogPack extends ContractCatalogReference {
  name: string;
  description: string;
  digest: string;
  provisionUrl: string;
  provides: ContractCatalogReference[];
  resourceCount: number;
  displayName: string;
  summary: string;
  category: "people" | "work" | "research" | "calendar" | "infrastructure" | "other";
  audience: "general" | "developer" | "infrastructure";
  icon: string;
  badges: string[];
  visibility: "default" | "advanced" | "hidden";
  recommendation: "user" | "optional" | "integration-managed";
  primaryType?: string;
  installedTypes: Array<{ name: string; label: string }>;
  caution?: string;
}

export interface ContractCatalog {
  catalogVersion: 1 | 2;
  id: string;
  name: string;
  description: string;
  homepage: string;
  publisher: {
    name: string;
    url: string;
  };
  sourceUrl: string;
  contracts: ContractCatalogContract[];
  packs: ContractCatalogPack[];
}

export type ContractCatalogStatus = "available" | "partial" | "installed";

const MAX_TYPE_PACK_BYTES = 1024 * 1024;

export async function loadContractCatalog({
  url = DEFAULT_CONTRACT_CATALOG_URL,
  signal,
  fetcher = fetch
}: {
  url?: string;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
} = {}): Promise<ContractCatalog> {
  const response = await fetcher(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal
  });
  if (!response.ok) {
    throw new Error(`The contract catalog returned ${response.status}.`);
  }
  const sourceUrl = response.url || url;
  return parseContractCatalog(await response.json(), sourceUrl);
}

export async function loadTypePackProvision(
  pack: ContractCatalogPack,
  {
    signal,
    fetcher = fetch
  }: {
    signal?: AbortSignal;
    fetcher?: typeof fetch;
  } = {}
): Promise<TypePackProvision> {
  const response = await fetcher(pack.provisionUrl, {
    headers: { Accept: "application/json" },
    signal
  });
  if (!response.ok) {
    throw new Error(`The type pack returned ${response.status}.`);
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_TYPE_PACK_BYTES) {
    throw new Error("The type pack is larger than the editor can install.");
  }
  const digest = `sha256:${hex(await crypto.subtle.digest("SHA-256", bytes))}`;
  if (digest !== pack.digest) {
    throw new Error("The type pack does not match its catalog digest.");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("The type pack is not valid JSON.");
  }
  return parseTypePackProvision(value, pack);
}

export function parseContractCatalog(value: unknown, sourceUrl: string): ContractCatalog {
  const catalog = requiredRecord(value, "The contract catalog");
  if (catalog.catalog_version !== 1 && catalog.catalog_version !== 2) {
    throw new Error("The contract catalog uses an unsupported version.");
  }
  const catalogVersion = catalog.catalog_version;
  const publisher = requiredRecord(catalog.publisher, "The contract catalog publisher");
  const contracts = requiredArray(catalog.contracts, "contracts").map((candidate, index) => {
    const contract = requiredRecord(candidate, `contracts[${index}]`);
    const contractType = requiredString(contract.contract_type, `contracts[${index}].contract_type`);
    if (!["record", "event", "action"].includes(contractType)) {
      throw new Error(`contracts[${index}].contract_type is not supported.`);
    }
    return {
      id: requiredString(contract.id, `contracts[${index}].id`),
      version: requiredString(contract.version, `contracts[${index}].version`),
      name: requiredString(contract.name, `contracts[${index}].name`),
      description: requiredString(contract.description, `contracts[${index}].description`),
      contractType: contractType as ContractCatalogContract["contractType"],
      digest: requiredDigest(contract.digest, `contracts[${index}].digest`),
      artifactUrl: artifactUrl(contract.artifact, sourceUrl, `contracts[${index}].artifact`),
      standards: requiredArray(contract.standards, `contracts[${index}].standards`)
        .map((standard, standardIndex) => parseStandard(
          standard,
          `contracts[${index}].standards[${standardIndex}]`
        ))
    };
  });
  const packs = requiredArray(catalog.packs, "packs").map((candidate, index) => {
    const pack = requiredRecord(candidate, `packs[${index}]`);
    const resourceCount = pack.resource_count;
    if (!Number.isInteger(resourceCount) || Number(resourceCount) < 1) {
      throw new Error(`packs[${index}].resource_count must be a positive integer.`);
    }
    const common = {
      id: requiredString(pack.id, `packs[${index}].id`),
      version: requiredString(pack.version, `packs[${index}].version`),
      name: requiredString(pack.name, `packs[${index}].name`),
      description: requiredString(pack.description, `packs[${index}].description`),
      digest: requiredDigest(pack.digest, `packs[${index}].digest`),
      provisionUrl: artifactUrl(pack.provision, sourceUrl, `packs[${index}].provision`),
      provides: requiredArray(pack.provides, `packs[${index}].provides`)
        .map((provided, providedIndex) => parseReference(
          provided,
          `packs[${index}].provides[${providedIndex}]`
        )),
      resourceCount: Number(resourceCount)
    };
    if (catalogVersion === 1) {
      if (typeof pack.featured !== "boolean") {
        throw new Error(`packs[${index}].featured must be a boolean.`);
      }
      return {
        ...common,
        displayName: common.name,
        summary: common.description,
        category: "other" as const,
        audience: "general" as const,
        icon: "package",
        badges: [],
        visibility: pack.featured ? "default" as const : "advanced" as const,
        recommendation: "optional" as const,
        installedTypes: []
      };
    }
    return {
      ...common,
      ...parsePackPresentation(pack, `packs[${index}]`)
    };
  });

  assertUnique(contracts, "contract");
  assertUnique(packs, "pack");
  return {
    catalogVersion,
    id: requiredString(catalog.id, "id"),
    name: requiredString(catalog.name, "name"),
    description: requiredString(catalog.description, "description"),
    homepage: absoluteHttpUrl(catalog.homepage, sourceUrl, "homepage"),
    publisher: {
      name: requiredString(publisher.name, "publisher.name"),
      url: absoluteHttpUrl(publisher.url, sourceUrl, "publisher.url")
    },
    sourceUrl,
    contracts,
    packs
  };
}

export function parseTypePackProvision(
  value: unknown,
  pack: ContractCatalogPack
): TypePackProvision {
  const provision = requiredRecord(value, "The type pack");
  const manifest = requiredRecord(provision.manifest, "The type-pack manifest");
  if (manifest.kind !== "mdbase.type-pack") {
    throw new Error("The type-pack manifest has an unsupported kind.");
  }
  if (requiredString(manifest.id, "manifest.id") !== pack.id
      || requiredString(manifest.version, "manifest.version") !== pack.version) {
    throw new Error("The type-pack identity does not match the catalog.");
  }

  const manifestResources = requiredArray(manifest.resources, "manifest.resources");
  if (!manifestResources.length || manifestResources.length > 100
      || manifestResources.length !== pack.resourceCount) {
    throw new Error("The type-pack resource count does not match the catalog.");
  }
  const sources = new Set<string>();
  for (const [index, candidate] of manifestResources.entries()) {
    const resource = requiredRecord(candidate, `manifest.resources[${index}]`);
    const kind = requiredString(resource.kind, `manifest.resources[${index}].kind`);
    if (!["contract", "type", "schema"].includes(kind)) {
      throw new Error(`manifest.resources[${index}].kind is not supported.`);
    }
    const source = safeRelativePath(resource.source, `manifest.resources[${index}].source`);
    safeRelativePath(resource.target, `manifest.resources[${index}].target`);
    requiredDigest(resource.digest, `manifest.resources[${index}].digest`);
    if (sources.has(source)) {
      throw new Error(`The type pack contains duplicate source ${source}.`);
    }
    sources.add(source);
  }

  const documents = requiredArray(provision.resources, "resources");
  if (documents.length !== manifestResources.length) {
    throw new Error("The type pack does not contain every declared resource.");
  }
  const documentSources = new Set<string>();
  for (const [index, candidate] of documents.entries()) {
    const resource = requiredRecord(candidate, `resources[${index}]`);
    const source = safeRelativePath(resource.source, `resources[${index}].source`);
    const document = requiredString(resource.document, `resources[${index}].document`);
    if (new TextEncoder().encode(document).byteLength > 262_144) {
      throw new Error(`resources[${index}].document is too large.`);
    }
    if (!sources.has(source) || documentSources.has(source)) {
      throw new Error(`The type pack contains an unexpected resource ${source}.`);
    }
    documentSources.add(source);
  }

  const provides = requiredArray(provision.provides, "provides")
    .map((provided, index) => parseReference(provided, `provides[${index}]`));
  const expectedProvides = new Set(pack.provides.map(referenceKey));
  const actualProvides = new Set(provides.map(referenceKey));
  if (expectedProvides.size !== actualProvides.size
      || [...expectedProvides].some((provided) => !actualProvides.has(provided))) {
    throw new Error("The type pack does not provide the contracts declared by the catalog.");
  }
  return value as TypePackProvision;
}

export function contractCatalogPackStatus(
  pack: ContractCatalogPack,
  installedContracts: Array<{ id: string; version: string }>,
  installedTypes: Array<{ name: string }> = []
): ContractCatalogStatus {
  const installed = new Set(installedContracts.map(({ id, version }) => `${id}@${version}`));
  const typeNames = new Set(installedTypes.map(({ name }) => name));
  const contractCount = pack.provides
    .filter(({ id, version }) => installed.has(`${id}@${version}`)).length;
  const typeCount = pack.installedTypes.filter(({ name }) => typeNames.has(name)).length;
  const expected = pack.provides.length + pack.installedTypes.length;
  const present = contractCount + typeCount;
  if (present === expected) return "installed";
  return present > 0 ? "partial" : "available";
}

function parsePackPresentation(
  pack: Record<string, unknown>,
  label: string
): Pick<
  ContractCatalogPack,
  | "displayName"
  | "summary"
  | "category"
  | "audience"
  | "icon"
  | "badges"
  | "visibility"
  | "recommendation"
  | "primaryType"
  | "installedTypes"
  | "caution"
> {
  const display = requiredRecord(pack.display, `${label}.display`);
  const installation = requiredRecord(pack.installation, `${label}.installation`);
  const category = requiredEnum(
    display.category,
    ["people", "work", "research", "calendar", "infrastructure", "other"] as const,
    `${label}.display.category`
  );
  const audience = requiredEnum(
    display.audience,
    ["general", "developer", "infrastructure"] as const,
    `${label}.display.audience`
  );
  const visibility = requiredEnum(
    installation.visibility,
    ["default", "advanced", "hidden"] as const,
    `${label}.installation.visibility`
  );
  const recommendation = requiredEnum(
    installation.recommendation,
    ["user", "optional", "integration-managed"] as const,
    `${label}.installation.recommendation`
  );
  const installedTypes = requiredArray(installation.types, `${label}.installation.types`)
    .map((candidate, index) => {
      const type = requiredRecord(candidate, `${label}.installation.types[${index}]`);
      return {
        name: requiredString(type.name, `${label}.installation.types[${index}].name`),
        label: requiredString(type.label, `${label}.installation.types[${index}].label`)
      };
    });
  const primaryType = installation.primary_type === null
    ? undefined
    : requiredString(installation.primary_type, `${label}.installation.primary_type`);
  if (primaryType && !installedTypes.some(({ name }) => name === primaryType)) {
    throw new Error(`${label}.installation.primary_type must name an installed type.`);
  }
  const badges = requiredArray(display.badges ?? [], `${label}.display.badges`)
    .map((badge, index) => requiredString(badge, `${label}.display.badges[${index}]`));
  const caution = installation.caution === undefined
    ? undefined
    : requiredString(installation.caution, `${label}.installation.caution`);
  return {
    displayName: requiredString(display.name, `${label}.display.name`),
    summary: requiredString(display.summary, `${label}.display.summary`),
    category,
    audience,
    icon: requiredString(display.icon, `${label}.display.icon`),
    badges,
    visibility,
    recommendation,
    primaryType,
    installedTypes,
    ...(caution ? { caution } : {})
  };
}

function parseReference(value: unknown, label: string): ContractCatalogReference {
  const reference = requiredRecord(value, label);
  return {
    id: requiredString(reference.id, `${label}.id`),
    version: requiredString(reference.version, `${label}.version`)
  };
}

function parseStandard(value: unknown, label: string): ContractCatalogStandard {
  const standard = requiredRecord(value, label);
  return {
    name: requiredString(standard.name, `${label}.name`),
    version: requiredString(standard.version, `${label}.version`),
    scope: requiredString(standard.scope, `${label}.scope`),
    references: requiredArray(standard.references, `${label}.references`)
      .map((reference, index) => absoluteHttpUrl(reference, undefined, `${label}.references[${index}]`))
  };
}

function artifactUrl(value: unknown, sourceUrl: string, label: string): string {
  return absoluteHttpUrl(value, sourceUrl, label);
}

function absoluteHttpUrl(value: unknown, base: string | undefined, label: string): string {
  const raw = requiredString(value, label);
  let resolved: URL;
  try {
    resolved = base ? new URL(raw, base) : new URL(raw);
  } catch {
    throw new Error(`${label} must be a URL.`);
  }
  if (!["http:", "https:"].includes(resolved.protocol)) {
    throw new Error(`${label} must use HTTP or HTTPS.`);
  }
  return resolved.href;
}

function requiredDigest(value: unknown, label: string): string {
  const digest = requiredString(value, label);
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`${label} must be a SHA-256 digest.`);
  }
  return digest;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function requiredEnum<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${label} is not supported.`);
  }
  return value;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function safeRelativePath(value: unknown, label: string): string {
  const path = requiredString(value, label);
  if (path.startsWith("/") || path.startsWith("\\") || path.includes("\0")
      || path.split(/[\\/]/).some((segment) => segment === "..")) {
    throw new Error(`${label} must stay inside the collection.`);
  }
  return path;
}

function referenceKey(reference: ContractCatalogReference): string {
  return `${reference.id}@${reference.version}`;
}

function hex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function assertUnique(values: ContractCatalogReference[], label: string) {
  const seen = new Set<string>();
  for (const value of values) {
    const identity = `${value.id}@${value.version}`;
    if (seen.has(identity)) throw new Error(`The catalog contains duplicate ${label} ${identity}.`);
    seen.add(identity);
  }
}
