/** Restricted shared TaskNotes query compiler. Execution belongs to the replica.
 * Bases syntax is parsed by the pinned obsidian-bases-expression package, never
 * by an independent parser. This first slice deliberately rejects functions,
 * temporal values, computed selection, grouping and native-CEL source input.
 */
import { inspectExpression, parseExpression, tokenize, type Expression } from "obsidian-bases-expression";

export const TASKNOTES_QUERY_COMPILER_VERSION = 1;
export const TASKNOTES_QUERY_PARSER_VERSION = "0.3.0-rc.4";
const MAX_SOURCE_BYTES = 16 * 1024;
// An individual parser call is bounded before recursion (including unary chains).
const MAX_EXPRESSION_BYTES = 512;
const MAX_NODES = 256;
const MAX_DEPTH = 32;
const MAX_FIELDS = 16;
const encoder = new TextEncoder();

type Literal = string | number | boolean | null;
export interface TaskNotesFilterCondition {
  readonly type: "condition";
  readonly id: string;
  readonly property: string;
  readonly operator: string;
  readonly value: Literal | readonly string[];
}
export interface TaskNotesFilterGroup {
  readonly type: "group";
  readonly id: string;
  readonly conjunction: "and" | "or";
  readonly children: readonly (TaskNotesFilterCondition | TaskNotesFilterGroup)[];
}
export interface TaskNotesQuerySort {
  readonly property: string;
  readonly direction: "asc" | "desc";
}
/** Caller supplies the actual catalogue field mapping, not guessed aliases.
 * Bases inputs read raw metadata with identity field names and no overriding
 * evaluation-context objects. Generic FilterQuery remains unsupported.
 * Typing declarations must come from the same captured catalogue/Bases context.
 */
export interface TaskNotesQueryBindings {
  readonly types: readonly string[];
  readonly fields: Readonly<Record<string, string>>;
  readonly filterQueryBasis: "raw" | "effective";
  /** Catalogue-derived native Timestamp fields for the matched type union. */
  readonly nativeTimestampFields: readonly string[];
  /** Fields typed by the actual Bases oracle context (dates/links/etc.). */
  readonly basesTypedFields: readonly string[];
}
export type TaskNotesQueryInput =
  | { readonly dialect: "tasknotes-filter"; readonly filter: TaskNotesFilterGroup;
      readonly sortKey?: string; readonly sortDirection?: "asc" | "desc";
      readonly groupKey?: string; readonly subgroupKey?: string }
  | { readonly dialect: "obsidian-bases"; readonly filter?: unknown;
      readonly globalFilter?: unknown; readonly sort?: readonly TaskNotesQuerySort[];
      readonly groupProperty?: string; readonly computedProperties?: readonly unknown[];
      readonly properties?: readonly string[] }
  | { readonly dialect: "mdbase-cel"; readonly filter?: unknown };
export interface CompiledTaskNotesQuery {
  readonly compilerVersion: 1;
  readonly parserVersion: "0.3.0-rc.4";
  readonly query: { readonly types: string[]; readonly where?: string };
  readonly dependencies: readonly { readonly source: "raw" | "effective"; readonly field: string }[];
  /** Translation is NOT proof of index eligibility, authority, budgets or execution. */
  readonly requiresReplicaValidation: true;
}
export type TaskNotesQueryErrorCode = "invalid_input" | "query_budget" | "unsupported_dialect"
  | "unsupported_expression" | "unsupported_operator" | "unsupported_field"
  | "unsupported_sort" | "unsupported_group" | "unsupported_projection";
export class TaskNotesQueryError extends Error {
  constructor(readonly code: TaskNotesQueryErrorCode) { super(code); this.name = "TaskNotesQueryError"; }
}
const fail = (code: TaskNotesQueryErrorCode): never => { throw new TaskNotesQueryError(code); };
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function text(value: unknown): string {
  if (typeof value !== "string") return fail("invalid_input");
  if (value.length > MAX_SOURCE_BYTES || encoder.encode(value).length > MAX_SOURCE_BYTES) return fail("query_budget");
  // CEL/Rust text is Unicode scalar data. Do not replace unpaired surrogates.
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return fail("invalid_input");
    } else if (c >= 0xdc00 && c <= 0xdfff) return fail("invalid_input");
  }
  return value;
}
function literal(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(text(value));
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)
      && (!Number.isInteger(value) || Number.isSafeInteger(value))) return JSON.stringify(value);
  return fail("invalid_input");
}

/** All-or-error: unsupported subtrees never disappear from the query. */
export function compileTaskNotesQuery(input: TaskNotesQueryInput, bindings: TaskNotesQueryBindings): CompiledTaskNotesQuery {
  if (!object(input) || !object(bindings) || !object(bindings.fields)
      || !Array.isArray(bindings.types) || bindings.types.length === 0 || bindings.types.length > MAX_FIELDS
      || !["raw", "effective"].includes(bindings.filterQueryBasis)
      || !Array.isArray(bindings.nativeTimestampFields) || !Array.isArray(bindings.basesTypedFields)) return fail("invalid_input");
  for (const fields of [bindings.nativeTimestampFields, bindings.basesTypedFields]) {
    if (fields.length > MAX_FIELDS) return fail("query_budget");
    for (const name of fields) if (!text(name) || name.length > 128) return fail("invalid_input");
  }
  const allowed = input.dialect === "obsidian-bases"
    ? ["dialect", "filter", "globalFilter", "sort", "groupProperty", "computedProperties", "properties"]
    : input.dialect === "tasknotes-filter"
      ? ["dialect", "filter", "sortKey", "sortDirection", "groupKey", "subgroupKey"]
      : ["dialect", "filter"];
  if (Object.keys(input).some(key => !allowed.includes(key))) return fail("invalid_input");
  const dense = (array: readonly unknown[]) => {
    for (let i = 0; i < array.length; i++) if (!Object.hasOwn(array, i)) fail("invalid_input");
  };
  dense(bindings.types);
  const types = bindings.types.map(t => {
    const name = text(t);
    if (!name || name.length > 128) return fail("invalid_input");
    return name;
  });
  const dependencies = new Map<string, { source: "raw" | "effective"; field: string }>();
  let nodes = 0, sourceBytes = 0, scalarBytes = 0;
  const boundedLiteral = (value: unknown): string => {
    const result = literal(value);
    scalarBytes += encoder.encode(result).length;
    if (scalarBytes > MAX_SOURCE_BYTES) return fail("query_budget");
    return result;
  };
  const active = new Set<object>();
  const visit = (depth: number) => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) fail("query_budget");
  };
  const field = (name: string, basis: "raw" | "effective"): string => {
    const mapped = Object.hasOwn(bindings.fields, name) ? text(bindings.fields[name]) : fail("unsupported_field");
    // A Bases property reads that exact raw key. Logical TaskNotes aliases need
    // their own proven frontend, not a silent rename of the Bases expression.
    if (!mapped || mapped.length > 128 || mapped !== name) return fail("unsupported_field");
    if (bindings.nativeTimestampFields.includes(mapped) || bindings.basesTypedFields.includes(mapped)) return fail("unsupported_expression");
    dependencies.set(`${basis}:${mapped}`, { source: basis, field: mapped });
    if (dependencies.size > MAX_FIELDS) return fail("query_budget");
    const root = basis === "raw" ? "raw" : "record";
    const key = JSON.stringify(mapped);
    // Missing map lookup is an error in Core. Bases missing properties are null.
    // Explicit presence rewrite preserves null/missing without guessing defaults.
    return `((${key} in ${root}) ? ${root}[${key}] : null)`;
  };
  const predicate = (node: Expression): boolean => {
    if (node.type === "Literal") return typeof node.value === "boolean";
    if (node.type === "Unary") return node.operator === "!" && predicate(node.argument);
    if (node.type !== "Binary") return false;
    if (node.operator === "&&" || node.operator === "||") return predicate(node.left) && predicate(node.right);
    return node.operator === "==" || node.operator === "!=";
  };
  const ast = (node: Expression, depth: number): string => {
    visit(depth);
    switch (node.type) {
      case "Literal": return boundedLiteral(node.value);
      case "Identifier":
        if (["note", "file", "this", "formula"].includes(node.name)) return fail("unsupported_expression");
        return field(text(node.name), "raw");
      case "Member": {
        if (node.object.type !== "Identifier" || node.object.name !== "note") return fail("unsupported_expression");
        const name = typeof node.property === "string" ? node.property
          : node.property.type === "Literal" && typeof node.property.value === "string" ? node.property.value
          : fail("unsupported_expression");
        return field(text(name), "raw");
      }
      case "Unary":
        if (node.operator !== "!") return fail("unsupported_operator");
        return `!(${ast(node.argument, depth + 1)})`;
      case "Binary": {
        if (!["==", "!=", "&&", "||"].includes(node.operator)) return fail("unsupported_operator");
        if (node.operator === "==" || node.operator === "!=") {
          const property = (expr: Expression) => expr.type === "Identifier" || expr.type === "Member";
          const scalar = (expr: Expression) => expr.type === "Literal" && (typeof expr.value === "string" || expr.value === null);
          if (!(property(node.left) && scalar(node.right) || scalar(node.left) && property(node.right))) return fail("unsupported_expression");
        }
        return `(${ast(node.left, depth + 1)} ${node.operator} ${ast(node.right, depth + 1)})`;
      }
      default: return fail("unsupported_expression");
    }
  };
  const expression = (value: unknown, depth: number): string => {
    const source = text(value);
    const bytes = encoder.encode(source).length;
    if (bytes > MAX_EXPRESSION_BYTES) return fail("query_budget");
    sourceBytes += bytes;
    if (sourceBytes > MAX_SOURCE_BYTES) return fail("query_budget");
    // Reuse the package lexer for admission; punctuation inside quoted values
    // must not be treated as syntax. Byte bounds also cap unary/parser recursion.
    const lexed = tokenize(source);
    if (lexed.tokens.length > MAX_NODES) return fail("query_budget");
    let nesting = 0;
    for (const token of lexed.tokens) {
      if (token.type !== "punct") continue;
      if (["(", "[", "{"].includes(token.value)) {
        if (++nesting > MAX_DEPTH) return fail("query_budget");
      } else if ([")", "]", "}"].includes(token.value)) nesting--;
    }
    const parsed = parseExpression(source);
    if (!parsed.ast || parsed.diagnostics.some(d => d.severity === "error")) return fail("invalid_input");
    // Validate operators/subtrees first for specific, bounded error codes.
    const lowered = ast(parsed.ast, depth);
    // Reuse dependency inspection too; no production evaluator/fetch-all path.
    const inspected = inspectExpression(parsed.ast);
    if (inspected.hasThisReference || inspected.fileProperties.length || inspected.formulaProperties.length
        || inspected.functions.length) return fail("unsupported_expression");
    if (!predicate(parsed.ast)) return fail("unsupported_expression");
    return lowered;
  };
  const bases = (value: unknown, depth: number): string => {
    visit(depth);
    if (typeof value === "string") return expression(value, depth + 1);
    if (!object(value) || active.has(value)) return fail("invalid_input");
    const keys = Object.keys(value);
    if (keys.length !== 1 || !["and", "or", "not"].includes(keys[0]!)) return fail("invalid_input");
    const key = keys[0]!, children = value[key];
    if (!Array.isArray(children) || children.length === 0) return fail("invalid_input");
    if (children.length > MAX_NODES) return fail("query_budget");
    dense(children);
    active.add(value);
    const combined = children.map(child => bases(child, depth + 1)).join(key === "or" ? " || " : " && ");
    active.delete(value);
    return key === "not" ? `!(${combined})` : `(${combined})`;
  };
  const absentOrEmptyArray = (value: unknown): boolean => value === undefined || Array.isArray(value) && value.length === 0;
  let where: string | undefined;
  if (input.dialect === "tasknotes-filter") {
    if (!object(input.filter)) return fail("invalid_input");
    const tree = input.filter as unknown as Record<string, unknown>;
    if (input.groupKey && input.groupKey !== "none" || input.subgroupKey && input.subgroupKey !== "none"
        || tree.groupKey && tree.groupKey !== "none" || tree.subgroupKey && tree.subgroupKey !== "none") return fail("unsupported_group");
    if (input.sortKey !== undefined || input.sortDirection !== undefined || tree.sortKey !== undefined || tree.sortDirection !== undefined) return fail("unsupported_sort");
    // FilterUtils has numeric coercion, scalar-array existential equality and
    // natural-date semantics. A field-name/status hint is not domain proof,
    // even when a catalogue expects a string: persisted invalid rows exist.
    // Never pretend typed CEL equality implements the legacy predicate.
    return fail("unsupported_dialect");
  } else if (input.dialect === "obsidian-bases") {
    if (input.groupProperty) return fail("unsupported_group");
    if (!absentOrEmptyArray(input.sort)) return fail("unsupported_sort");
    if (!absentOrEmptyArray(input.computedProperties) || !absentOrEmptyArray(input.properties)) return fail("unsupported_projection");
    const terms = [input.globalFilter, input.filter].filter(value => value !== undefined).map(value => bases(value, 0));
    if (terms.length) where = `(${terms.join(" && ")})`;
  } else return fail("unsupported_dialect");
  if (where && encoder.encode(where).length > MAX_SOURCE_BYTES) return fail("query_budget");
  return { compilerVersion: TASKNOTES_QUERY_COMPILER_VERSION, parserVersion: TASKNOTES_QUERY_PARSER_VERSION,
    query: { types, ...(where === undefined ? {} : { where }) }, dependencies: [...dependencies.values()], requiresReplicaValidation: true };
}
