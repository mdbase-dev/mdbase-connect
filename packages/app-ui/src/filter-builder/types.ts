/** How a field's values are compared and edited. `formula` fields hold computed values of either text or number. */
export type FilterFieldKind = "string" | "number" | "boolean" | "date" | "enum" | "formula";

/** A record field the builder can filter on. */
export interface FilterFieldSpec {
  /** Frontmatter key, as written in the `where` expression. */
  key: string;
  /** Display name; defaults to `key`. */
  label?: string;
  kind: FilterFieldKind;
  /** Allowed values for `enum` fields, offered as choices. */
  enumValues?: FilterValue[];
}

/** A `this.*` context binding a rule can compare against. */
export interface FilterContextVar {
  /** The CEL expression, e.g. `this.fiscal_year`. */
  expr: string;
  /** Display name, e.g. `fiscal_year`. */
  label: string;
  /** Kind of the bound value; decides which rules offer it. */
  kind: FilterFieldKind;
  /** The current value, shown as a hint, e.g. `2026`. */
  preview?: string;
}

export type FilterValue = string | number | boolean;

/**
 * `year_eq` compares the year of a date field (`date.year() == 2026`).
 * `in` and `not_in` match any or none of several literals (`values`).
 * `is_empty` and `is_not_empty` take no value.
 */
export type FilterOperator =
  | "eq" | "neq" | "in" | "not_in" | "gt" | "gte" | "lt" | "lte"
  | "contains" | "not_contains" | "starts_with" | "ends_with"
  | "year_eq" | "is_empty" | "is_not_empty";

/**
 * One visual condition. A rule without a `value` (or, for `in` and `not_in`,
 * without `values`), other than a unary one, is a draft: it is shown but
 * compiles to nothing until a value is chosen.
 */
export interface FilterRule {
  kind: "rule";
  id: string;
  field: string;
  op: FilterOperator;
  /** A literal, or the context expression (`this.foo`) when `valueKind` is `context`. */
  value?: FilterValue;
  valueKind?: "literal" | "context";
  /** The literals `in` and `not_in` compare against, in order. */
  values?: FilterValue[];
}

/** A condition kept as CEL text, for anything a rule cannot express. Empty text compiles to nothing. */
export interface FilterExpr {
  kind: "expr";
  id: string;
  expression: string;
}

/** `all` joins children with `&&`, `any` with `||`, and `none` negates their disjunction. */
export type FilterCombinator = "all" | "any" | "none";

export interface FilterGroup {
  kind: "group";
  id: string;
  combinator: FilterCombinator;
  children: FilterNode[];
}

export type FilterNode = FilterGroup | FilterRule | FilterExpr;

type JsonSchemaProperty = { type?: unknown; format?: unknown; enum?: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isEnumValue = (value: unknown): value is FilterValue =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

function kindOf(property: JsonSchemaProperty): FilterFieldKind | null {
  if (Array.isArray(property.enum) && property.enum.length && property.enum.every(isEnumValue)) return "enum";
  const types = Array.isArray(property.type) ? property.type.filter(type => type !== "null") : [property.type];
  if (types.length !== 1) return null;
  switch (types[0]) {
    case "string": return property.format === "date" || property.format === "date-time" ? "date" : "string";
    case "number":
    case "integer": return "number";
    case "boolean": return "boolean";
    default: return null;
  }
}

/**
 * Derives filterable fields from a type's JSON Schema (`_types/<type>.md`).
 *
 * Scalar schema properties come first, in declaration order; objects, arrays
 * and untyped properties are skipped. Columns the schema does not describe
 * follow as `string` fields, so a schema-less table still gets a field list.
 */
export function fieldsFromJsonSchema(
  schema: Record<string, unknown> | null,
  fallbackColumns: string[],
  columnLabels: Record<string, string> = {},
): FilterFieldSpec[] {
  const properties = schema && isRecord(schema.properties) ? schema.properties : {};
  const spec = (key: string, kind: FilterFieldKind, enumValues?: FilterValue[]): FilterFieldSpec => ({
    key,
    kind,
    ...(columnLabels[key] && { label: columnLabels[key] }),
    ...(enumValues && { enumValues }),
  });
  const fields: FilterFieldSpec[] = [];
  for (const [key, property] of Object.entries(properties)) {
    if (!isRecord(property)) continue;
    const kind = kindOf(property);
    if (kind) fields.push(spec(key, kind, kind === "enum" ? (property.enum as FilterValue[]) : undefined));
  }
  for (const column of fallbackColumns) {
    if (!Object.hasOwn(properties, column)) fields.push(spec(column, "string"));
  }
  return fields;
}
