import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = resolve(root, "packages/protocol/schemas/connect-problems.v1.catalog.json");
const schemaPath = resolve(root, "packages/protocol/schemas/connect-problem.v1.schema.json");
const typescriptPath = resolve(root, "packages/protocol/src/connect-problems.generated.ts");
const rustPath = resolve(root, "crates/connect-protocol/src/connect_problems_generated.rs");
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
const check = process.argv.includes("--check");

validateCatalog(catalog);
emit(schemaPath, `${JSON.stringify(problemSchema(catalog), null, 2)}\n`);
emit(typescriptPath, typescriptSource(catalog));
emit(rustPath, rustSource(catalog));

function emit(path, content) {
  if (check) {
    if (readFileSync(path, "utf8") !== content) {
      throw new Error(`${path.slice(root.length + 1)} is stale; run pnpm generate:problems.`);
    }
    return;
  }
  writeFileSync(path, content);
}

function validateCatalog(value) {
  if (value.problem_version !== 1) throw new Error("Connect problem catalog version must be 1.");
  if (!Array.isArray(value.categories) || !Array.isArray(value.recovery_actions)) {
    throw new Error("Connect problem catalog enums are missing.");
  }
  const codes = Object.keys(value.codes ?? {});
  if (codes.length === 0 || codes.join("\n") !== [...codes].sort().join("\n")) {
    throw new Error("Connect problem codes must be non-empty and sorted.");
  }
  for (const [code, definition] of Object.entries(value.codes)) {
    if (!/^[a-z][a-z0-9_]*$/.test(code)) throw new Error(`Invalid problem code: ${code}`);
    if (!value.categories.includes(definition.category)) throw new Error(`Invalid category for ${code}.`);
    if (!value.recovery_actions.includes(definition.recovery)) throw new Error(`Invalid recovery for ${code}.`);
    if (definition.details) validateDetails(code, definition.details);
  }
}

function validateDetails(code, details) {
  if (!Array.isArray(details.required) || !plainObject(details.properties)) {
    throw new Error(`Invalid details schema for ${code}.`);
  }
  for (const required of details.required) {
    if (!(required in details.properties)) throw new Error(`Unknown required detail ${code}.${required}.`);
  }
}

function problemSchema(value) {
  const variants = Object.entries(value.codes).map(([code, definition]) => {
    const required = ["problem_version", "code", "category", "recovery", "message"];
    const properties = {
      problem_version: { const: 1 },
      code: { const: code },
      category: { const: definition.category },
      recovery: { const: definition.recovery },
      message: { type: "string", minLength: 1 },
      operation_outcome: { enum: ["not_sent", "rejected", "unknown"] },
      trace_id: { type: "string", minLength: 1 }
    };
    if (definition.details) {
      properties.details = objectSchema(definition.details);
      if (definition.details.required.length > 0) required.push("details");
    }
    return { type: "object", additionalProperties: false, required, properties };
  });
  variants.push({
    type: "object",
    additionalProperties: false,
    required: ["problem_version", "code", "server_code", "category", "recovery", "message"],
    properties: {
      problem_version: { const: 1 },
      code: { const: "unknown" },
      server_code: { type: "string", minLength: 1 },
      category: { const: "unknown" },
      recovery: { const: "none" },
      message: { type: "string", minLength: 1 },
      details: true,
      operation_outcome: { enum: ["not_sent", "rejected", "unknown"] },
      trace_id: { type: "string", minLength: 1 }
    }
  });
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://schemas.mdbase.dev/connect/problem/v1",
    title: "mdbase connect problem v1",
    oneOf: variants
  };
}

function objectSchema(details) {
  return {
    type: "object",
    additionalProperties: false,
    required: details.required,
    properties: Object.fromEntries(
      Object.entries(details.properties).map(([name, schema]) => [name, normalizeSchema(schema)])
    )
  };
}

function normalizeSchema(schema) {
  if (!plainObject(schema) || Object.keys(schema).length === 0) return true;
  if (schema.type === "object") {
    if (!plainObject(schema.properties)) return { type: "object" };
    const properties = schema.properties;
    return {
      type: "object",
      additionalProperties: false,
      required: Array.isArray(schema.required) ? schema.required : [],
      properties: Object.fromEntries(
        Object.entries(properties).map(([name, value]) => [name, normalizeSchema(value)])
      )
    };
  }
  if (schema.type === "array") return { type: "array", items: normalizeSchema(schema.items ?? {}) };
  return schema;
}

function typescriptSource(value) {
  const definitions = Object.entries(value.codes)
    .map(([code, definition]) => `  ${JSON.stringify(code)}: { category: ${JSON.stringify(definition.category)}, recovery: ${JSON.stringify(definition.recovery)} }`)
    .join(",\n");
  const details = Object.entries(value.codes)
    .map(([code, definition]) => `  ${JSON.stringify(code)}: ${definition.details ? tsObject(definition.details) : "undefined"};`)
    .join("\n");
  const problems = Object.entries(value.codes)
    .map(([code, definition]) => {
      const detailsMember = definition.details
        ? `${definition.details.required.length > 0 ? "details" : "details?"}: ConnectProblemDetailsByCode[${JSON.stringify(code)}];`
        : "details?: never;";
      return `  ${JSON.stringify(code)}: ConnectProblemBase & {\n    code: ${JSON.stringify(code)};\n    category: ${JSON.stringify(definition.category)};\n    recovery: ${JSON.stringify(definition.recovery)};\n    ${detailsMember}\n  };`;
    })
    .join("\n");
  const categoryUnion = [...value.categories, "unknown"].map(JSON.stringify).join(" | ");
  const recoveryUnion = value.recovery_actions.map(JSON.stringify).join(" | ");
  const detailSchemas = Object.fromEntries(
    Object.entries(value.codes)
      .filter(([, definition]) => definition.details)
      .map(([code, definition]) => [code, { type: "object", ...definition.details }])
  );
  return `// Generated by scripts/generate-connect-problems.mjs. Do not edit directly.\n\n` +
    `export const CONNECT_PROBLEM_VERSION = 1 as const;\n\n` +
    `export const CONNECT_PROBLEM_CATALOG = {\n${definitions}\n} as const;\n\n` +
    `export type ConnectProblemCode = keyof typeof CONNECT_PROBLEM_CATALOG;\n` +
    `export type ConnectProblemCategory = ${categoryUnion};\n` +
    `export type ConnectRecoveryAction = ${recoveryUnion};\n` +
    `export type ConnectOperationOutcome = "not_sent" | "rejected" | "unknown";\n\n` +
    `export interface ConnectProblemBase {\n  problem_version: typeof CONNECT_PROBLEM_VERSION;\n  message: string;\n  operation_outcome?: ConnectOperationOutcome;\n  trace_id?: string;\n}\n\n` +
    `export interface ConnectProblemDetailsByCode {\n${details}\n}\n\n` +
    `export interface ConnectProblemByCode {\n${problems}\n}\n\n` +
    `export type KnownConnectProblem<Code extends ConnectProblemCode = ConnectProblemCode> = ConnectProblemByCode[Code];\n\n` +
    `export type UnknownConnectProblem = ConnectProblemBase & {\n  code: "unknown";\n  server_code: string;\n  category: "unknown";\n  recovery: "none";\n  details?: unknown;\n};\n\n` +
    `export type ConnectProblem<Code extends ConnectProblemCode = ConnectProblemCode> = KnownConnectProblem<Code> | UnknownConnectProblem;\n\n` +
    `type ConnectProblemDetailSchema = {\n  type?: "string" | "integer" | "number" | "boolean" | "array" | "object";\n  required?: readonly string[];\n  properties?: Readonly<Record<string, ConnectProblemDetailSchema>>;\n  items?: ConnectProblemDetailSchema;\n};\n\n` +
    `const CONNECT_PROBLEM_DETAIL_SCHEMAS: Readonly<Record<string, ConnectProblemDetailSchema>> = ${JSON.stringify(detailSchemas, null, 2)};\n\n` +
    `export function isConnectProblemCode(code: string): code is ConnectProblemCode {\n  return Object.hasOwn(CONNECT_PROBLEM_CATALOG, code);\n}\n\n` +
    `export function isConnectProblem(value: unknown): value is ConnectProblem {\n  if (!isPlainObject(value)) return false;\n  const candidate = value as Record<string, unknown>;\n  if (candidate.problem_version !== CONNECT_PROBLEM_VERSION || typeof candidate.message !== "string" || candidate.message.length === 0) return false;\n  if (candidate.operation_outcome !== undefined && candidate.operation_outcome !== "not_sent" && candidate.operation_outcome !== "rejected" && candidate.operation_outcome !== "unknown") return false;\n  if (candidate.trace_id !== undefined && (typeof candidate.trace_id !== "string" || candidate.trace_id.length === 0)) return false;\n  if (candidate.code === "unknown") {\n    return typeof candidate.server_code === "string"\n      && candidate.server_code.length > 0\n      && candidate.category === "unknown"\n      && candidate.recovery === "none";\n  }\n  if (typeof candidate.code !== "string" || !isConnectProblemCode(candidate.code) || candidate.server_code !== undefined) return false;\n  const definition = CONNECT_PROBLEM_CATALOG[candidate.code];\n  const detailsSchema = CONNECT_PROBLEM_DETAIL_SCHEMAS[candidate.code];\n  const detailsMatch = detailsSchema === undefined\n    ? candidate.details === undefined\n    : candidate.details === undefined\n      ? (detailsSchema.required?.length ?? 0) === 0\n      : matchesDetailSchema(candidate.details, detailsSchema);\n  return candidate.category === definition.category\n    && candidate.recovery === definition.recovery\n    && detailsMatch;\n}\n\n` +
    `function matchesDetailSchema(value: unknown, schema: ConnectProblemDetailSchema): boolean {\n  if (schema.type === undefined) return true;\n  if (schema.type === "string") return typeof value === "string";\n  if (schema.type === "integer") return typeof value === "number" && Number.isInteger(value);\n  if (schema.type === "number") return typeof value === "number" && Number.isFinite(value);\n  if (schema.type === "boolean") return typeof value === "boolean";\n  if (schema.type === "array") return Array.isArray(value) && value.every((item) => matchesDetailSchema(item, schema.items ?? {}));\n  if (!isPlainObject(value)) return false;\n  if (!schema.properties) return true;\n  const candidate = value as Record<string, unknown>;\n  if (!Object.keys(candidate).every((key) => Object.hasOwn(schema.properties!, key))) return false;\n  if (!(schema.required ?? []).every((key) => Object.hasOwn(candidate, key))) return false;\n  return Object.entries(candidate).every(([key, item]) => matchesDetailSchema(item, schema.properties![key]!));\n}\n\n` +
    `function isPlainObject(value: unknown): value is Record<string, unknown> {\n  return value !== null && typeof value === "object" && !Array.isArray(value);\n}\n\n` +
    `export function normalizeConnectProblem(\n  serverCode: string,\n  message: string,\n  options: { details?: unknown; operation_outcome?: ConnectOperationOutcome; trace_id?: string } = {}\n): ConnectProblem {\n  if (isConnectProblemCode(serverCode)) {\n    const definition = CONNECT_PROBLEM_CATALOG[serverCode];\n    const candidate = {\n      problem_version: CONNECT_PROBLEM_VERSION,\n      code: serverCode,\n      category: definition.category,\n      recovery: definition.recovery,\n      message,\n      ...(options.details === undefined ? {} : { details: options.details }),\n      ...(options.operation_outcome === undefined ? {} : { operation_outcome: options.operation_outcome }),\n      ...(options.trace_id === undefined ? {} : { trace_id: options.trace_id })\n    };\n    if (isConnectProblem(candidate)) return candidate;\n  }\n  return {\n    problem_version: CONNECT_PROBLEM_VERSION,\n    code: "unknown",\n    server_code: serverCode,\n    category: "unknown",\n    recovery: "none",\n    message,\n    ...(options.details === undefined ? {} : { details: options.details }),\n    ...(options.operation_outcome === undefined ? {} : { operation_outcome: options.operation_outcome }),\n    ...(options.trace_id === undefined ? {} : { trace_id: options.trace_id })\n  };\n}\n`;
}

function tsObject(schema, indent = "") {
  const required = new Set(schema.required ?? []);
  const memberIndent = `${indent}  `;
  const members = Object.entries(schema.properties ?? {}).map(([name, property]) =>
    `${memberIndent}${JSON.stringify(name)}${required.has(name) ? "" : "?"}: ${tsType(property, memberIndent)};`
  );
  return `{\n${members.join("\n")}\n${indent}}`;
}

function tsType(schema, indent) {
  if (!plainObject(schema) || Object.keys(schema).length === 0) return "unknown";
  if (schema.type === "string") return "string";
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "array") return `Array<${tsType(schema.items ?? {}, indent)}>`;
  if (schema.type === "object") {
    return Object.keys(schema.properties ?? {}).length === 0
      ? "Record<string, unknown>"
      : tsObject(schema, indent);
  }
  return "unknown";
}

function rustSource(value) {
  const categories = [...value.categories, "unknown"];
  const recovery = [...new Set([...value.recovery_actions, "none"])];
  const categoryVariants = categories.map((item) => `    ${rustVariant(item)},`).join("\n");
  const recoveryVariants = recovery.map((item) => `    ${rustVariant(item)},`).join("\n");
  const definitions = Object.entries(value.codes).map(([code, definition]) =>
    `        ${JSON.stringify(code)} => Some(ConnectProblemDefinition { category: ConnectProblemCategory::${rustVariant(definition.category)}, recovery: ConnectRecoveryAction::${rustVariant(definition.recovery)} }),`
  ).join("\n");
  return `// Generated by scripts/generate-connect-problems.mjs. Do not edit directly.\n\n` +
    `use serde::{Deserialize, Serialize};\nuse serde_json::Value;\n\npub const CONNECT_PROBLEM_VERSION: u32 = 1;\n\n` +
    `#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]\n#[serde(rename_all = "snake_case")]\npub enum ConnectProblemCategory {\n${categoryVariants}\n}\n\n` +
    `#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]\n#[serde(rename_all = "snake_case")]\npub enum ConnectRecoveryAction {\n${recoveryVariants}\n}\n\n` +
    `#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]\n#[serde(rename_all = "snake_case")]\npub enum ConnectOperationOutcome {\n    NotSent,\n    Rejected,\n    Unknown,\n}\n\n` +
    `#[derive(Debug, Clone, Copy, PartialEq, Eq)]\npub struct ConnectProblemDefinition {\n    pub category: ConnectProblemCategory,\n    pub recovery: ConnectRecoveryAction,\n}\n\n` +
    `#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]\npub struct ConnectProblem {\n    pub problem_version: u32,\n    pub code: String,\n    pub category: ConnectProblemCategory,\n    pub recovery: ConnectRecoveryAction,\n    pub message: String,\n    #[serde(default, skip_serializing_if = "Option::is_none")]\n    pub details: Option<Value>,\n    #[serde(default, skip_serializing_if = "Option::is_none")]\n    pub operation_outcome: Option<ConnectOperationOutcome>,\n    #[serde(default, skip_serializing_if = "Option::is_none")]\n    pub trace_id: Option<String>,\n    #[serde(default, skip_serializing_if = "Option::is_none")]\n    pub server_code: Option<String>,\n}\n\n` +
    `#[rustfmt::skip]\npub fn connect_problem_definition(code: &str) -> Option<ConnectProblemDefinition> {\n    match code {\n${definitions}\n        _ => None,\n    }\n}\n\n` +
    `impl ConnectProblem {\n    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {\n        let server_code = code.into();\n        let message = message.into();\n        match connect_problem_definition(&server_code) {\n            Some(definition) => Self {\n                problem_version: CONNECT_PROBLEM_VERSION,\n                code: server_code,\n                category: definition.category,\n                recovery: definition.recovery,\n                message,\n                details: None,\n                operation_outcome: None,\n                trace_id: None,\n                server_code: None,\n            },\n            None => Self {\n                problem_version: CONNECT_PROBLEM_VERSION,\n                code: "unknown".to_string(),\n                category: ConnectProblemCategory::Unknown,\n                recovery: ConnectRecoveryAction::None,\n                message,\n                details: None,\n                operation_outcome: None,\n                trace_id: None,\n                server_code: Some(server_code),\n            },\n        }\n    }\n\n    pub fn with_details(mut self, details: Value) -> Self {\n        self.details = Some(details);\n        self\n    }\n\n    pub fn with_operation_outcome(mut self, outcome: ConnectOperationOutcome) -> Self {\n        self.operation_outcome = Some(outcome);\n        self\n    }\n\n    pub fn with_trace_id(mut self, trace_id: impl Into<String>) -> Self {\n        self.trace_id = Some(trace_id.into());\n        self\n    }\n}\n`;
}

function rustVariant(value) {
  return value.split("_").map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join("");
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
