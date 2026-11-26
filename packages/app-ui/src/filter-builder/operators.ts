import type { FilterLabels } from "./labels.js";
import type { FilterContextVar, FilterFieldKind, FilterFieldSpec, FilterOperator, FilterRule, FilterValue } from "./types.js";

/** An operator as a menu shows it. */
export type OperatorOption = { op: FilterOperator; label: string };
type OperatorName =
  | "is" | "isNot" | "isAnyOf" | "isNoneOf" | "contains" | "doesNotContain" | "startsWith" | "endsWith"
  | "isEmpty" | "isNotEmpty" | "after" | "onOrAfter" | "before" | "onOrBefore" | "yearIs";
/** An operator and its text: a mathematical symbol, or the name of its label. */
type OperatorEntry = { op: FilterOperator; name: OperatorName } | { op: FilterOperator; symbol: string };

const EMPTY: OperatorEntry[] = [{ op: "is_empty", name: "isEmpty" }, { op: "is_not_empty", name: "isNotEmpty" }];
const TEXT: OperatorEntry[] = [
  { op: "contains", name: "contains" }, { op: "not_contains", name: "doesNotContain" },
  { op: "starts_with", name: "startsWith" }, { op: "ends_with", name: "endsWith" },
];
const NUMERIC: OperatorEntry[] = [
  { op: "eq", symbol: "=" }, { op: "neq", symbol: "≠" }, { op: "gt", symbol: ">" },
  { op: "gte", symbol: "≥" }, { op: "lt", symbol: "<" }, { op: "lte", symbol: "≤" },
];
const IS: OperatorEntry[] = [{ op: "eq", name: "is" }, { op: "neq", name: "isNot" }];
const IS_ANY: OperatorEntry = { op: "in", name: "isAnyOf" };
const IS_NONE: OperatorEntry = { op: "not_in", name: "isNoneOf" };

/**
 * Operators each field kind offers, in menu order; the first is the default
 * for a new rule. `in` and `not_in` are not listed: equality turns into them
 * when a rule holds several values (see `operatorMenu`).
 */
const OPERATORS: Record<FilterFieldKind, OperatorEntry[]> = {
  string: [...IS, ...TEXT, ...EMPTY],
  number: [...NUMERIC, ...EMPTY],
  date: [
    ...IS, { op: "gt", name: "after" }, { op: "gte", name: "onOrAfter" }, { op: "lt", name: "before" },
    { op: "lte", name: "onOrBefore" }, { op: "year_eq", name: "yearIs" }, ...EMPTY,
  ],
  enum: [...IS, ...EMPTY],
  boolean: [...IS, ...EMPTY],
  formula: [...NUMERIC, ...TEXT, ...EMPTY],
};

export const UNARY: ReadonlySet<FilterOperator> = new Set(["is_empty", "is_not_empty"]);
export const MULTI: ReadonlySet<FilterOperator> = new Set(["in", "not_in"]);
const EQUALITY: ReadonlySet<FilterOperator> = new Set(["eq", "neq", "in", "not_in"]);
const NEGATED: ReadonlySet<FilterOperator> = new Set(["neq", "not_in"]);
const TEXT_OPS: ReadonlySet<FilterOperator> = new Set(TEXT.map(item => item.op));

export const labelOf = (field: FilterFieldSpec) => field.label ?? field.key;

/** The operator a new rule on a field of `kind` starts with. */
export const defaultOperator = (kind: FilterFieldKind): FilterOperator => OPERATORS[kind][0]?.op ?? "eq";

const option = (labels: FilterLabels, entry: OperatorEntry): OperatorOption =>
  ({ op: entry.op, label: "symbol" in entry ? entry.symbol : labels[entry.name] });

export function operatorLabel(labels: FilterLabels, kind: FilterFieldKind, op: FilterOperator): string {
  const entry = [...OPERATORS[kind], IS_ANY, IS_NONE, ...NUMERIC, ...TEXT, ...EMPTY].find(item => item.op === op);
  return entry ? option(labels, entry).label : labels.yearIs;
}

/** The operator menu for `rule`: a rule holding several values shows `is any of` and `is none of` in place of equality. */
export function operatorMenu(labels: FilterLabels, kind: FilterFieldKind, rule: FilterRule): OperatorOption[] {
  const multi = MULTI.has(rule.op);
  const menu = OPERATORS[kind].map(item => option(labels, !multi ? item : item.op === "eq" ? IS_ANY : item.op === "neq" ? IS_NONE : item));
  return menu.some(item => item.op === rule.op) ? menu : [{ op: rule.op, label: operatorLabel(labels, kind, rule.op) }, ...menu];
}

/** The kind of value a rule compares against: `year is` takes a number and text operators take text. */
export function valueKindOf(kind: FilterFieldKind, op: FilterOperator): FilterFieldKind {
  if (op === "year_eq") return "number";
  if (TEXT_OPS.has(op)) return "string";
  return kind;
}

/** A field the query mentions but the host does not describe; its kind follows the rule. */
export function inferField(rule: FilterRule): FilterFieldSpec {
  const { op, value } = rule;
  const sample = value ?? rule.values?.[0];
  const kind: FilterFieldKind = op === "year_eq" ? "date" : typeof sample === "number" ? "number" : typeof sample === "boolean" ? "boolean" : "string";
  return { key: rule.field, kind };
}

const textual = (kind: FilterFieldKind) => kind === "string" || kind === "enum" || kind === "formula";

/** The `this.*` bindings a value of `kind` can compare against. */
export const varsFor = (vars: FilterContextVar[], kind: FilterFieldKind) =>
  vars.filter(item => item.kind === kind || (textual(item.kind) && textual(kind)) || (kind === "formula" && item.kind === "number"));

/** `rule` with a single `value`, or as a draft without one. */
export function withValue(rule: FilterRule, value?: FilterValue, valueKind: "literal" | "context" = "literal"): FilterRule {
  const { kind, id, field, op } = rule;
  return value === undefined ? { kind, id, field, op } : { kind, id, field, op, value, valueKind };
}

/** The literals an equality rule matches: its `values`, or its one literal `value`. */
export function selection(rule: FilterRule): FilterValue[] {
  if (MULTI.has(rule.op)) return rule.values ?? [];
  return EQUALITY.has(rule.op) && rule.valueKind !== "context" && rule.value !== undefined ? [rule.value] : [];
}

export const isNegated = (rule: FilterRule) => NEGATED.has(rule.op);

/** An equality rule matching `values`: one value is `eq`/`neq`, several are `in`/`not_in`, none is a draft. */
export function withSelection(rule: FilterRule, values: FilterValue[], negated: boolean): FilterRule {
  const { kind, id, field } = rule;
  if (values.length > 1) return { kind, id, field, op: negated ? "not_in" : "in", values };
  return withValue({ kind, id, field, op: negated ? "neq" : "eq" }, values[0]);
}

/** `rule` under operator `op`, keeping whatever value still fits. */
export function changeOperator(rule: FilterRule, field: FilterFieldSpec, op: FilterOperator): FilterRule {
  if (op === rule.op) return rule;
  const values = selection(rule);
  if (EQUALITY.has(op) && values.length) return withSelection(rule, values, NEGATED.has(op));
  const keep = !UNARY.has(op) && !MULTI.has(rule.op) && rule.value !== undefined && valueKindOf(field.kind, op) === valueKindOf(field.kind, rule.op);
  return keep ? withValue({ ...rule, op }, rule.value, rule.valueKind) : withValue({ ...rule, op });
}
