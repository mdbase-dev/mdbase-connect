import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = resolve(root, "packages/protocol/schemas/operation-catalog.v1.json");
const typescriptPath = resolve(root, "packages/protocol/src/operations.ts");
const rustPath = resolve(root, "crates/connect-protocol/src/collection_operations_generated.rs");
const classificationFixturePath = resolve(root, "packages/protocol/schemas/operation-mutation-classification.v1.json");
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
const check = process.argv.includes("--check");

validateCatalog(catalog);
emit(typescriptPath, typescriptSource(catalog));
emit(rustPath, rustSource(catalog));
emit(classificationFixturePath, `${JSON.stringify(classificationFixture(catalog), null, 2)}\n`);

function emit(path, content) {
  if (check) {
    if (readFileSync(path, "utf8") !== content) {
      throw new Error(`${path.slice(root.length + 1)} is stale; run pnpm generate:operations.`);
    }
    return;
  }
  writeFileSync(path, content);
}

function validateCatalog(value) {
  if (value.catalog_version !== 1) throw new Error("Operation catalog version must be 1.");
  if (!Array.isArray(value.collection_operations) || !Array.isArray(value.file_control_messages)) {
    throw new Error("Operation catalog lists are missing.");
  }
  const collectionIds = value.collection_operations.map(({ id }) => id);
  const fileIds = value.file_control_messages.map(({ id }) => id);
  for (const id of [...collectionIds, ...fileIds]) {
    if (!/^[a-z][a-z0-9_]*$/u.test(id)) throw new Error(`Invalid operation identifier: ${id}`);
  }
  if (new Set(collectionIds).size !== collectionIds.length || new Set(fileIds).size !== fileIds.length) {
    throw new Error("Operation identifiers must be unique within their channel.");
  }
  for (const operation of value.collection_operations) {
    if (!Number.isSafeInteger(operation.input_schema_version) || operation.input_schema_version < 1) {
      throw new Error(`Invalid input schema version for ${operation.id}.`);
    }
    if (!["never", "always", "sync_action"].includes(operation.mutation)) {
      throw new Error(`Invalid mutation rule for ${operation.id}.`);
    }
    if (operation.requires_timer_criterion !== undefined
      && operation.requires_timer_criterion !== true) {
      throw new Error(`Invalid timer-criterion rule for ${operation.id}.`);
    }
    if (operation.mutation === "sync_action" && operation.id !== "sync") {
      throw new Error("Only sync may use the sync_action mutation rule.");
    }
    if (operation.dry_run !== undefined && operation.dry_run !== "nonmutating") {
      throw new Error(`Invalid dry-run policy for ${operation.id}.`);
    }
    if (operation.dry_run === "nonmutating" && operation.mutation !== "always") {
      throw new Error(`Nonmutating dry-run policy requires an always-mutating operation: ${operation.id}.`);
    }
  }
  if (value.file_control_messages.some(({ mutation }) => typeof mutation !== "boolean")) {
    throw new Error("File-control mutation flags must be boolean.");
  }
  if (value.file_control_messages.some(({ input_schema_version }) =>
    !Number.isSafeInteger(input_schema_version) || input_schema_version < 1)) {
    throw new Error("File-control input schema versions must be positive integers.");
  }
}

function classificationFixture(value) {
  const cases = [];
  for (const operation of value.collection_operations) {
    const identifier = operation.mutation === "always" ? operation.id : null;
    cases.push({ operation: operation.id, input: {}, schema_version: operation.input_schema_version, identifier });
    cases.push({
      operation: operation.id,
      input: { dry_run: true },
      schema_version: operation.input_schema_version,
      identifier: operation.dry_run === "nonmutating" ? null : identifier
    });
  }
  cases.push(
    { operation: "sync", input: { action: "changes", dry_run: true }, schema_version: 1, identifier: null },
    { operation: "sync", input: { action: "mutate", dry_run: true }, schema_version: 1, identifier: "sync:mutate" }
  );
  for (const message of value.file_control_messages) {
    const identifier = message.mutation ? `file_control:${message.id}` : null;
    for (const dry_run of [false, true]) {
      cases.push({
        operation: "file_control",
        input: { type: message.id, ...(dry_run ? { dry_run: true } : {}) },
        schema_version: message.input_schema_version,
        identifier
      });
    }
  }
  return { catalog_version: value.catalog_version, cases };
}

function typescriptSource(value) {
  const collection = value.collection_operations;
  const files = value.file_control_messages;
  const collectionIds = collection.map(({ id }) => JSON.stringify(id)).join(",\n  ");
  const fileIds = files.map(({ id }) => JSON.stringify(id)).join(",\n  ");
  const rules = collection.map(({ id, mutation }) => `  ${JSON.stringify(id)}: ${JSON.stringify(mutation)}`).join(",\n");
  const schemaVersions = collection.map(({ id, input_schema_version }) =>
    `  ${JSON.stringify(id)}: ${input_schema_version}`
  ).join(",\n");
  const fileSchemaVersions = files.map(({ id, input_schema_version }) =>
    `  ${JSON.stringify(id)}: ${input_schema_version}`
  ).join(",\n");
  const mutatingFiles = files.filter(({ mutation }) => mutation).map(({ id }) => JSON.stringify(id)).join(",\n  ");
  const nonmutatingDryRuns = collection.filter(({ dry_run }) => dry_run === "nonmutating")
    .map(({ id }) => JSON.stringify(id)).join(",\n  ");
  const identifiers = [
    ...collection.filter(({ mutation }) => mutation === "always").map(({ id }) => id),
    "sync:mutate",
    ...files.filter(({ mutation }) => mutation).map(({ id }) => `file_control:${id}`)
  ].map(JSON.stringify).join(",\n  ");
  const timerCriterionOperations = collection
    .filter(({ requires_timer_criterion }) => requires_timer_criterion)
    .map(({ id }) => JSON.stringify(id))
    .join(",\n  ");
  return `// Generated by scripts/generate-operation-catalog.mjs. Do not edit directly.\n\n` +
    `export const OPERATION_CATALOG_VERSION = 1 as const;\n\n` +
    `export const COLLECTION_OPERATIONS = [\n  ${collectionIds}\n] as const;\n\n` +
    `export type CollectionOperation = typeof COLLECTION_OPERATIONS[number];\n\n` +
    `export const FILE_CONTROL_MESSAGE_TYPES = [\n  ${fileIds}\n] as const;\n\n` +
    `export type FileControlMessageType = typeof FILE_CONTROL_MESSAGE_TYPES[number];\n` +
    `export type EncryptedOperation = CollectionOperation | "file_control";\n\n` +
    `const COLLECTION_MUTATION_RULES = {\n${rules}\n} as const;\n\n` +
    `const COLLECTION_INPUT_SCHEMA_VERSIONS = {\n${schemaVersions}\n} as const;\n\n` +
    `const FILE_CONTROL_INPUT_SCHEMA_VERSIONS = {\n${fileSchemaVersions}\n} as const;\n\n` +
    `const MUTATING_FILE_CONTROL_MESSAGE_TYPES: ReadonlySet<string> = new Set([\n  ${mutatingFiles}\n]);\n\n` +
    `const NONMUTATING_DRY_RUN_OPERATIONS: ReadonlySet<string> = new Set([\n  ${nonmutatingDryRuns}\n]);\n\n` +
    `export const MUTATING_OPERATION_IDENTIFIERS = [\n  ${identifiers}\n] as const;\n\n` +
    `const TIMER_CRITERION_OPERATIONS: ReadonlySet<string> = new Set([\n  ${timerCriterionOperations}\n]);\n\n` +
    `export type MutationOperationIdentifier = typeof MUTATING_OPERATION_IDENTIFIERS[number];\n\n` +
    `const COLLECTION_OPERATION_SET: ReadonlySet<string> = new Set(COLLECTION_OPERATIONS);\n` +
    `const FILE_CONTROL_MESSAGE_TYPE_SET: ReadonlySet<string> = new Set(FILE_CONTROL_MESSAGE_TYPES);\n\n` +
    `export function isCollectionOperation(value: string): value is CollectionOperation {\n  return COLLECTION_OPERATION_SET.has(value);\n}\n\n` +
    `export function areCollectionOperations(values: readonly string[]): values is readonly CollectionOperation[] {\n  return values.every(isCollectionOperation);\n}\n\n` +
    `export function operationRequiresTimerCriterion(operation: CollectionOperation): boolean {\n  return TIMER_CRITERION_OPERATIONS.has(operation);\n}\n\n` +
    `export function isFileControlMessageType(value: string): value is FileControlMessageType {\n  return FILE_CONTROL_MESSAGE_TYPE_SET.has(value);\n}\n\n` +
    `export function operationInputSchemaVersion(\n  operation: EncryptedOperation,\n  input: unknown\n): number {\n` +
    `  if (operation === "file_control") {\n` +
    `    const type = isObject(input) && typeof input.type === "string" ? input.type : "";\n` +
    `    if (!isFileControlMessageType(type)) throw new Error(\`Unknown file-control message: \${type}\`);\n` +
    `    return FILE_CONTROL_INPUT_SCHEMA_VERSIONS[type];\n  }\n` +
    `  return COLLECTION_INPUT_SCHEMA_VERSIONS[operation];\n}\n\n` +
    `export function mutationOperationIdentifier(\n  operation: EncryptedOperation,\n  input: unknown\n): MutationOperationIdentifier | null {\n` +
    `  const object = isObject(input) ? input : {};\n` +
    `  if (object.dry_run === true && NONMUTATING_DRY_RUN_OPERATIONS.has(operation)) return null;\n` +
    `  if (operation === "file_control") {\n` +
    `    const type = typeof object.type === "string" ? object.type : "";\n` +
    `    return MUTATING_FILE_CONTROL_MESSAGE_TYPES.has(type)\n` +
    `      ? \`file_control:\${type}\` as MutationOperationIdentifier\n` +
    `      : null;\n  }\n` +
    `  const rule = COLLECTION_MUTATION_RULES[operation];\n` +
    `  if (rule === "always") return operation as MutationOperationIdentifier;\n` +
    `  if (rule === "sync_action" && object.action === "mutate") return "sync:mutate";\n` +
    `  return null;\n}\n\n` +
    `export function isMutatingOperation(operation: EncryptedOperation, input: unknown): boolean {\n` +
    `  return mutationOperationIdentifier(operation, input) !== null;\n}\n\n` +
    `function isObject(value: unknown): value is Record<string, unknown> {\n` +
    `  return value !== null && typeof value === "object" && !Array.isArray(value);\n}\n`;
}

function rustSource(value) {
  const collection = value.collection_operations;
  const files = value.file_control_messages;
  const collectionIds = collection.map(({ id }) => `    ${JSON.stringify(id)},`).join("\n");
  const fileIds = files.map(({ id }) => `    ${JSON.stringify(id)},`).join("\n");
  const collectionRules = collection.map(({ id, mutation }) => {
    if (mutation === "always") return `        ${JSON.stringify(id)} => Some(${JSON.stringify(id)}),`;
    if (mutation === "sync_action") return `        ${JSON.stringify(id)} if input.get("action").and_then(Value::as_str) == Some("mutate") => {\n            Some("sync:mutate")\n        }`;
    return "";
  }).filter(Boolean).join("\n");
  const fileRules = files.filter(({ mutation }) => mutation).map(({ id }) =>
    `            ${JSON.stringify(id)} => Some(${JSON.stringify(`file_control:${id}`)}),`
  ).join("\n");
  const nonmutatingDryRuns = collection.filter(({ dry_run }) => dry_run === "nonmutating")
    .map(({ id }) => JSON.stringify(id)).join(", ");
  const collectionSchemaVersions = collection.map(({ id, input_schema_version }) =>
    `        ${JSON.stringify(id)} => Some(${input_schema_version}),`
  ).join("\n");
  const fileSchemaVersions = files.map(({ id, input_schema_version }) =>
    `            ${JSON.stringify(id)} => Some(${input_schema_version}),`
  ).join("\n");
  const identifiers = [
    ...collection.filter(({ mutation }) => mutation === "always").map(({ id }) => id),
    "sync:mutate",
    ...files.filter(({ mutation }) => mutation).map(({ id }) => `file_control:${id}`)
  ].map((id) => `    ${JSON.stringify(id)},`).join("\n");
  const timerCriterionOperations = collection
    .filter(({ requires_timer_criterion }) => requires_timer_criterion)
    .map(({ id }) => `    ${JSON.stringify(id)},`)
    .join("\n");
  return `// Generated by scripts/generate-operation-catalog.mjs. Do not edit directly.\n\n` +
    `use serde_json::Value;\n\npub const OPERATION_CATALOG_VERSION: u32 = 1;\n\n` +
    `pub const COLLECTION_OPERATIONS: &[&str] = &[\n${collectionIds}\n];\n\n` +
    `pub const FILE_CONTROL_MESSAGE_TYPES: &[&str] = &[\n${fileIds}\n];\n\n` +
    `pub const MUTATING_OPERATION_IDENTIFIERS: &[&str] = &[\n${identifiers}\n];\n\n` +
    `pub const TIMER_CRITERION_OPERATIONS: &[&str] = &[\n${timerCriterionOperations}\n];\n\n` +
    `const NONMUTATING_DRY_RUN_OPERATIONS: &[&str] = &[${nonmutatingDryRuns}];\n\n` +
    `pub fn is_collection_operation(operation: &str) -> bool {\n    COLLECTION_OPERATIONS.contains(&operation)\n}\n\n` +
    `pub fn operation_requires_timer_criterion(operation: &str) -> bool {\n    TIMER_CRITERION_OPERATIONS.contains(&operation)\n}\n\n` +
    `pub fn operation_input_schema_version(operation: &str, input: &Value) -> Option<u32> {\n` +
    `    if operation == "file_control" {\n        return match input.get("type").and_then(Value::as_str).unwrap_or("") {\n${fileSchemaVersions}\n            _ => None,\n        };\n    }\n` +
    `    match operation {\n${collectionSchemaVersions}\n        _ => None,\n    }\n}\n\n` +
    `pub fn mutation_operation_identifier<'a>(operation: &'a str, input: &Value) -> Option<&'a str> {\n` +
    `    if input.get("dry_run").and_then(Value::as_bool) == Some(true)\n        && NONMUTATING_DRY_RUN_OPERATIONS.contains(&operation)\n    {\n        return None;\n    }\n` +
    `    if operation == "file_control" {\n        return match input.get("type").and_then(Value::as_str).unwrap_or("") {\n${fileRules}\n            _ => None,\n        };\n    }\n` +
    `    match operation {\n${collectionRules}\n        _ => None,\n    }\n}\n\n` +
    `pub fn is_mutating_operation(operation: &str, input: &Value) -> bool {\n` +
    `    mutation_operation_identifier(operation, input).is_some()\n}\n`;
}
