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
    `export function isConnectProblemCode(code: string): code is ConnectProblemCode {\n  return Object.hasOwn(CONNECT_PROBLEM_CATALOG, code);\n}\n`;
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
    `pub fn connect_problem_definition(code: &str) -> Option<ConnectProblemDefinition> {\n    match code {\n${definitions}\n        _ => None,\n    }\n}\n`;
}

function rustVariant(value) {
  return value.split("_").map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join("");
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
