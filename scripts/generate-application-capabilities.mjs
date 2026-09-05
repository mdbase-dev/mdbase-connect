import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = resolve(root, "packages/protocol/schemas/application-capability-catalog.v2.json");
const legacyCatalogPath = resolve(root, "packages/protocol/schemas/application-capability-catalog.v1.json");
const legacyCatalog = JSON.parse(readFileSync(legacyCatalogPath, "utf8"));
const operationCatalogPath = resolve(root, "packages/protocol/schemas/operation-catalog.v1.json");
const manifestSchemaPath = resolve(root, "packages/protocol/schemas/mdbase-app.schema.json");
const typescriptPath = resolve(root, "packages/protocol/src/capabilities.ts");
const rustPath = resolve(root, "crates/connect-protocol/src/application_capabilities_generated.rs");
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
const operationCatalog = JSON.parse(readFileSync(operationCatalogPath, "utf8"));
const manifestSchema = JSON.parse(readFileSync(manifestSchemaPath, "utf8"));
const check = process.argv.includes("--check");

validateCatalog(catalog, operationCatalog, manifestSchema);
validateLegacyCatalog(legacyCatalog, operationCatalog);
emit(typescriptPath, typescriptSource(catalog) + legacyTypescriptSource(legacyCatalog));
emit(rustPath, rustSource(catalog) + legacyRustSource(legacyCatalog));

// V1 is a historical intent table, not a partition of the operation catalog:
// empty aliases and operations shared between capabilities must remain intact.
function validateLegacyCatalog(value, operations) {
  if (value.catalog_version !== 1 || !Array.isArray(value.capabilities) || !value.capabilities.length) {
    throw new Error("Legacy application capability catalog must be version 1.");
  }
  const ids = new Set();
  const known = new Set(operations.collection_operations.map(({ id }) => id));
  for (const { id, operations: expansion } of value.capabilities) {
    if (typeof id !== "string" || !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u.test(id) || ids.has(id)) {
      throw new Error(`Invalid legacy capability identifier: ${id}`);
    }
    ids.add(id);
    if (!Array.isArray(expansion) || expansion.some((operation) => !known.has(operation))) {
      throw new Error(`Invalid legacy capability operations: ${id}`);
    }
  }
}

function emit(path, content) {
  if (check) {
    if (readFileSync(path, "utf8") !== content) {
      throw new Error(`${path.slice(root.length + 1)} is stale; run pnpm generate:capabilities.`);
    }
    return;
  }
  writeFileSync(path, content);
}

function validateCatalog(value, operations, schema) {
  if (value.catalog_version !== 2) throw new Error("Application capability catalog version must be 2.");
  if (!Array.isArray(value.capabilities) || value.capabilities.length === 0) {
    throw new Error("Application capability definitions are missing.");
  }
  const ids = value.capabilities.map(({ id }) => id);
  if (ids.some((id) => !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/u.test(id))) {
    throw new Error("Application capability identifiers must be dotted lowercase names.");
  }
  if (new Set(ids).size !== ids.length) throw new Error("Application capability identifiers must be unique.");

  const publicOperations = value.capabilities.flatMap(({ id, operations: capabilityOperations }) => {
    if (!Array.isArray(capabilityOperations) || capabilityOperations.length === 0) {
      throw new Error(`Application capability ${id} must expand to at least one operation.`);
    }
    if (new Set(capabilityOperations).size !== capabilityOperations.length) {
      throw new Error(`Application capability ${id} repeats an operation.`);
    }
    return capabilityOperations;
  });
  if (new Set(publicOperations).size !== publicOperations.length) {
    throw new Error("An internal operation may belong to only one public capability.");
  }

  const structured = value.structured_authorities?.application_setup;
  if (!Array.isArray(structured) || structured.length === 0 || new Set(structured).size !== structured.length) {
    throw new Error("Application setup operations must be one non-empty unique list.");
  }
  const assigned = [...publicOperations, ...structured];
  if (new Set(assigned).size !== assigned.length) {
    throw new Error("Structured-authority operations must not overlap public capabilities.");
  }
  const known = operations.collection_operations.map(({ id }) => id);
  const missing = known.filter((operation) => !assigned.includes(operation));
  const unknown = assigned.filter((operation) => !known.includes(operation));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(`Capability assignment must cover the operation catalog exactly; missing=${missing.join(",")} unknown=${unknown.join(",")}`);
  }

  const schemaVersion = schema.$defs.capabilityRequirements.properties.contract_version.const;
  const schemaIds = schema.$defs.applicationCapability.enum;
  if (schemaVersion !== value.catalog_version || JSON.stringify(schemaIds) !== JSON.stringify(ids)) {
    throw new Error("mdbase-app.schema.json capability version or identifiers differ from the canonical catalog.");
  }
}

function typescriptSource(value) {
  const definitions = value.capabilities.map(({ id, operations }) =>
    `  ${JSON.stringify(id)}: ${JSON.stringify(operations)}`
  ).join(",\n");
  const setup = value.structured_authorities.application_setup.map(JSON.stringify).join(",\n  ");
  return `// Generated by scripts/generate-application-capabilities.mjs. Do not edit directly.\n\n` +
    `import type { CollectionOperation } from "./operations.js";\n\n` +
    `export const APPLICATION_CAPABILITY_CONTRACT_VERSION = ${value.catalog_version} as const;\n\n` +
    `export const APPLICATION_CAPABILITY_DEFINITIONS = {\n${definitions}\n} as const satisfies Record<string, readonly CollectionOperation[]>;\n\n` +
    `export const APPLICATION_SETUP_OPERATIONS = [\n  ${setup}\n] as const satisfies readonly CollectionOperation[];\n\n` +
    `export type ApplicationCapabilityId = keyof typeof APPLICATION_CAPABILITY_DEFINITIONS;\n\n` +
    `export interface ApplicationCapabilityRequirements {\n` +
    `  contract_version: typeof APPLICATION_CAPABILITY_CONTRACT_VERSION;\n` +
    `  required: ApplicationCapabilityId[];\n` +
    `  optional?: ApplicationCapabilityId[];\n` +
    `}\n\n` +
    `export function operationsForApplicationCapabilities(\n` +
    `  requirements: ApplicationCapabilityRequirements,\n` +
    `  options: { includeOptional?: boolean } = {}\n` +
    `): CollectionOperation[] {\n` +
    `  const capabilities = options.includeOptional === false\n` +
    `    ? requirements.required\n` +
    `    : [...requirements.required, ...(requirements.optional ?? [])];\n` +
    `  return [...new Set(capabilities.flatMap(\n` +
    `    (capability) => APPLICATION_CAPABILITY_DEFINITIONS[capability]\n` +
    `  ))];\n` +
    `}\n\n` +
    `export function capabilityOperations(\n` +
    `  capability: ApplicationCapabilityId\n` +
    `): CollectionOperation[] {\n` +
    `  return [...APPLICATION_CAPABILITY_DEFINITIONS[capability]];\n` +
    `}\n\n` +
    `export function applicationOperationSelectionIsAtomic(\n` +
    `  requirements: ApplicationCapabilityRequirements,\n` +
    `  operations: readonly string[]\n` +
    `): boolean {\n` +
    `  const selected = new Set(operations);\n` +
    `  const declared = [...requirements.required, ...(requirements.optional ?? [])];\n` +
    `  const allowed = new Set<string>(declared.flatMap(\n` +
    `    (capability) => APPLICATION_CAPABILITY_DEFINITIONS[capability]\n` +
    `  ));\n` +
    `  if ([...selected].some((operation) => !allowed.has(operation))) {\n` +
    `    return false;\n` +
    `  }\n` +
    `  return declared.every((capability) => {\n` +
    `    const capabilityOperations = APPLICATION_CAPABILITY_DEFINITIONS[capability];\n` +
    `    const count = capabilityOperations.filter((operation) => selected.has(operation)).length;\n` +
    `    return requirements.required.includes(capability)\n` +
    `      ? count === capabilityOperations.length\n` +
    `      : count === 0 || count === capabilityOperations.length;\n` +
    `  });\n` +
    `}\n`;
}

function legacyTypescriptSource(value) {
  const definitions = value.capabilities.map(({ id, operations }) =>
    `  ${JSON.stringify(id)}: Object.freeze(${JSON.stringify(operations)} as const)`
  ).join(",\n");
  return `\n// Frozen predecessor catalog. Lookup availability does not imply declaration acceptance.\n` +
    `export const APPLICATION_CAPABILITY_V1_CONTRACT_VERSION = 1 as const;\n\n` +
    `export const APPLICATION_CAPABILITY_V1_DEFINITIONS = Object.freeze({\n${definitions}\n} as const satisfies Record<string, readonly CollectionOperation[]>);\n\n` +
    `export type LegacyApplicationCapabilityId = keyof typeof APPLICATION_CAPABILITY_V1_DEFINITIONS;\n\n` +
    `export interface LegacyApplicationCapabilityRequirements {\n` +
    `  contract_version: typeof APPLICATION_CAPABILITY_V1_CONTRACT_VERSION;\n` +
    `  required: LegacyApplicationCapabilityId[];\n` +
    `  optional?: LegacyApplicationCapabilityId[];\n` +
    `}\n\n` +
    `export function capabilityOperationsForContractVersion(\n` +
    `  contractVersion: number,\n` +
    `  capability: string\n` +
    `): CollectionOperation[] | undefined {\n` +
    `  const definitions = contractVersion === 1 ? APPLICATION_CAPABILITY_V1_DEFINITIONS\n` +
    `    : contractVersion === 2 ? APPLICATION_CAPABILITY_DEFINITIONS : undefined;\n` +
    `  if (!definitions || !Object.hasOwn(definitions, capability)) return undefined;\n` +
    `  return [...(definitions as Readonly<Record<string, readonly CollectionOperation[]>>)[capability]];\n` +
    `}\n`;
}

function legacyRustSource(value) {
  const ids = value.capabilities.map(({ id }) => `    ${JSON.stringify(id)},`).join("\n");
  const matches = value.capabilities.map(({ id, operations }) =>
    `        ${JSON.stringify(id)} => Some(&[${operations.map(JSON.stringify).join(", ")}]),`
  ).join("\n");
  return `\n// Frozen predecessor catalog. Lookup availability does not imply declaration acceptance.\n` +
    `pub const APPLICATION_CAPABILITY_V1_CONTRACT_VERSION: u32 = 1;\n\n` +
    `pub const APPLICATION_CAPABILITY_V1_IDS: &[&str] = &[\n${ids}\n];\n\n` +
    `pub fn application_capability_operations_for_contract_version(\n` +
    `    contract_version: u32,\n` +
    `    capability: &str,\n` +
    `) -> Option<&'static [&'static str]> {\n` +
    `    match contract_version {\n` +
    `        1 => legacy_application_capability_operations(capability),\n` +
    `        2 => application_capability_operations(capability),\n` +
    `        _ => None,\n` +
    `    }\n}\n\n` +
    `fn legacy_application_capability_operations(capability: &str) -> Option<&'static [&'static str]> {\n` +
    `    match capability {\n${matches}\n        _ => None,\n    }\n}\n`;
}

function rustSource(value) {
  const ids = value.capabilities.map(({ id }) => `    ${JSON.stringify(id)},`).join("\n");
  const matches = value.capabilities.map(({ id, operations }) => {
    if (operations.length <= 2) {
      return `        ${JSON.stringify(id)} => Some(&[${operations.map(JSON.stringify).join(", ")}]),`;
    }
    const entries = operations.map((operation) => `            ${JSON.stringify(operation)},`).join("\n");
    return `        ${JSON.stringify(id)} => Some(&[\n${entries}\n        ]),`;
  }).join("\n");
  const setup = value.structured_authorities.application_setup;
  const setupSource = setup.length <= 2
    ? `&[${setup.map(JSON.stringify).join(", ")}]`
    : `&[\n${setup.map((operation) => `    ${JSON.stringify(operation)},`).join("\n")}\n]`;
  return `// Generated by scripts/generate-application-capabilities.mjs. Do not edit directly.\n\n` +
    `pub const APPLICATION_CAPABILITY_CONTRACT_VERSION: u32 = ${value.catalog_version};\n\n` +
    `pub const APPLICATION_CAPABILITY_IDS: &[&str] = &[\n${ids}\n];\n\n` +
    `pub const APPLICATION_SETUP_OPERATIONS: &[&str] =\n    ${setupSource};\n\n` +
    `pub fn application_capability_operations(capability: &str) -> Option<&'static [&'static str]> {\n` +
    `    match capability {\n${matches}\n        _ => None,\n    }\n}\n`;
}
