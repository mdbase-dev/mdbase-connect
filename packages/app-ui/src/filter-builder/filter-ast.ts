import { MULTI, UNARY } from "./operators.js";
import type { FilterCombinator, FilterExpr, FilterGroup, FilterNode, FilterOperator, FilterRule, FilterValue } from "./types.js";

/**
 * Bidirectional mapping between `mdbase.view` CEL `where` strings and a tree
 * of boolean groups.
 *
 * Parsing never fails and never drops text: top-level `||` becomes an `any`
 * group, `&&` an `all` group, `!(a || b)` a `none` group, recognised
 * comparisons become rules, and every other sub-expression is kept verbatim
 * as an `expr` leaf beside its siblings. An `||` of literal equalities on one
 * field (`a == 1 || a == 2`) is an `in` rule, and its negation `not_in`.
 *
 * Canonical output uses `field.year()` (the runtime evaluates `year` only in
 * method form) and the global forms `contains(field, "text")`,
 * `startsWith(…)` and `endsWith(…)`; the parser also accepts `year(field)`
 * and the method forms.
 */

type Token = { t: "ident" | "str" | "num" | "op" | "bad"; v: string | number; start: number; end: number };

const OPERATORS = ["&&", "||", "==", "!=", ">=", "<=", ">", "<", "!", "(", ")", "[", "]", "{", "}", ",", ".", "?", ":", "+", "-", "*", "/", "%"];
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/;
const NUMBER = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "\\": "\\", '"': '"', "'": "'" };
const CONTEXT = /^this(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const OPEN = new Set(["(", "[", "{"]);
const CLOSE = new Set([")", "]", "}"]);

/** Tokenizes enough CEL to find group structure. Malformed text yields `bad` tokens, which no rule matches. */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const space = /^\s+/.exec(rest);
    if (space) { i += space[0].length; continue; }
    const quote = rest[0];
    if (quote === '"' || quote === "'") {
      let value = "";
      let bad = false;
      let j = 1;
      for (; j < rest.length && rest[j] !== quote; j++) {
        if (rest[j] !== "\\") { value += rest[j]; continue; }
        const next = rest[++j];
        if (next === "u" && /^[0-9a-fA-F]{4}$/.test(rest.slice(j + 1, j + 5))) {
          value += String.fromCharCode(parseInt(rest.slice(j + 1, j + 5), 16));
          j += 4;
        } else if (next !== undefined && next in ESCAPES) value += ESCAPES[next];
        else bad = true;
      }
      const end = Math.min(rest.length, j + 1);
      tokens.push({ t: bad || j >= rest.length ? "bad" : "str", v: value, start: i, end: i + end });
      i += end;
      continue;
    }
    // A leading minus is part of a number only where an operand may start.
    const previous = tokens.at(-1);
    const negative = rest[0] === "-" && (!previous || (previous.t === "op" && !CLOSE.has(String(previous.v))));
    const number = NUMBER.exec(negative ? rest.slice(1) : rest);
    if (number) {
      const length = number[0].length + (negative ? 1 : 0);
      tokens.push({ t: "num", v: Number(number[0]) * (negative ? -1 : 1), start: i, end: i + length });
      i += length;
      continue;
    }
    const ident = IDENT.exec(rest);
    if (ident) { tokens.push({ t: "ident", v: ident[0], start: i, end: i + ident[0].length }); i += ident[0].length; continue; }
    const op = OPERATORS.find(candidate => rest.startsWith(candidate));
    tokens.push({ t: op ? "op" : "bad", v: op ?? rest.charAt(0), start: i, end: i + (op?.length ?? 1) });
    i += op?.length ?? 1;
  }
  return tokens;
}

const isOp = (token: Token | undefined, value: string) => token?.t === "op" && token.v === value;
const isIdent = (token: Token | undefined, value: string) => token?.t === "ident" && token.v === value;

/** Index of the bracket closing the one at `open`, or -1. */
function closing(tokens: Token[], open: number): number {
  let depth = 0;
  for (const [offset, token] of tokens.slice(open).entries()) {
    if (token.t !== "op") continue;
    if (OPEN.has(String(token.v))) depth++;
    else if (CLOSE.has(String(token.v)) && --depth === 0) return open + offset;
  }
  return -1;
}

function unwrap(tokens: Token[]): Token[] {
  while (tokens.length > 2 && isOp(tokens[0], "(") && closing(tokens, 0) === tokens.length - 1) tokens = tokens.slice(1, -1);
  return tokens;
}

/** Splits on a top-level operator; null when brackets are unbalanced or a part is empty. */
function split(tokens: Token[], op: string): Token[][] | null {
  const parts: Token[][] = [];
  let depth = 0;
  let start = 0;
  for (const [i, token] of tokens.entries()) {
    if (token.t === "op" && OPEN.has(String(token.v))) depth++;
    else if (token.t === "op" && CLOSE.has(String(token.v)) && --depth < 0) return null;
    else if (depth === 0 && isOp(token, op)) { parts.push(tokens.slice(start, i)); start = i + 1; }
  }
  parts.push(tokens.slice(start));
  return depth === 0 && parts.every(part => part.length) ? parts : null;
}

const COMPARISONS: Record<string, FilterOperator> = { "==": "eq", "!=": "neq", ">": "gt", ">=": "gte", "<": "lt", "<=": "lte" };
const TEXT_CALLS: Record<string, FilterOperator> = { contains: "contains", startsWith: "starts_with", endsWith: "ends_with" };

function field(token: Token | undefined): string | null {
  if (token?.t !== "ident") return null;
  const name = String(token.v);
  return name === "this" || name.startsWith("this.") || ["true", "false", "null"].includes(name) ? null : name;
}

type Operand = Pick<FilterRule, "value" | "valueKind">;

function operand(token: Token | undefined): Operand | null {
  if (token?.t === "str" || token?.t === "num") return { value: token.v, valueKind: "literal" };
  if (isIdent(token, "true") || isIdent(token, "false")) return { value: token!.v === "true", valueKind: "literal" };
  if (token?.t === "ident" && CONTEXT.test(String(token.v))) return { value: String(token.v), valueKind: "context" };
  return null;
}

const textOperand = (token: Token | undefined) => (token?.t === "num" || isIdent(token, "true") || isIdent(token, "false") ? null : operand(token));

function yearOperand(token: Token | undefined): Operand | null {
  const value = operand(token);
  return value && (value.valueKind === "context" || (typeof value.value === "number" && Number.isInteger(value.value))) ? value : null;
}

function rule(id: string, name: string | null, op: FilterOperator | undefined, value: Operand | null | undefined): FilterRule | null {
  if (name === null || op === undefined || value === null) return null;
  return { kind: "rule", id, field: name, op, ...value };
}

/** `field.method` → [field, method] when `method` is one of `methods`. */
function method(token: Token | undefined, methods: string[]): [string | null, string] | null {
  if (token?.t !== "ident") return null;
  const name = String(token.v);
  const dot = name.lastIndexOf(".");
  if (dot < 0 || !methods.includes(name.slice(dot + 1))) return null;
  return [field({ ...token, v: name.slice(0, dot) }), name.slice(dot + 1)];
}

/** Matches the exact token shapes the compiler emits (plus their alternate call forms). */
function matchRule(tokens: Token[], id: string): FilterRule | null {
  const [a, b, c, d, e, f, g] = tokens;
  switch (tokens.length) {
    case 3: // field <cmp> operand
      return b?.t === "op" && String(b.v) in COMPARISONS ? rule(id, field(a), COMPARISONS[String(b.v)], operand(c)) : null;
    case 4: { // field.contains("text")
      const call = method(a, Object.keys(TEXT_CALLS));
      return call && isOp(b, "(") && isOp(d, ")") ? rule(id, call[0], TEXT_CALLS[call[1]], textOperand(c)) : null;
    }
    case 5: { // !field.contains("text")  |  field.year() == operand
      const negated = isOp(a, "!") ? method(b, ["contains"]) : null;
      if (negated && isOp(c, "(") && isOp(e, ")")) return rule(id, negated[0], "not_contains", textOperand(d));
      const year = method(a, ["year"]);
      return year && isOp(b, "(") && isOp(c, ")") && isOp(d, "==") ? rule(id, year[0], "year_eq", yearOperand(e)) : null;
    }
    case 6: // contains(field, "text")  |  year(field) == operand
      if (a?.t === "ident" && String(a.v) in TEXT_CALLS && isOp(b, "(") && isOp(d, ",") && isOp(f, ")")) return rule(id, field(c), TEXT_CALLS[String(a.v)], textOperand(e));
      return isIdent(a, "year") && isOp(b, "(") && isOp(d, ")") && isOp(e, "==") ? rule(id, field(c), "year_eq", yearOperand(f)) : null;
    case 7: { // !contains(field, "text")  |  (field == null || field == "")
      if (isOp(a, "!") && isIdent(b, "contains") && isOp(c, "(") && isOp(e, ",") && isOp(g, ")")) return rule(id, field(d), "not_contains", textOperand(f));
      const name = field(a);
      const empty = isOp(b, "==") && isOp(d, "||") && isOp(f, "==");
      const filled = isOp(b, "!=") && isOp(d, "&&") && isOp(f, "!=");
      if (!name || !(empty || filled) || !isIdent(c, "null") || e?.t !== "ident" || e.v !== name || g?.t !== "str" || g.v !== "") return null;
      return rule(id, name, empty ? "is_empty" : "is_not_empty", undefined);
    }
    default:
      return null;
  }
}

type Ids = () => string;

/** `a == 1 || a == 2` as `a in [1, 2]`, or null when the children are not literal equalities on one field. */
function collapse(id: string, children: FilterNode[]): FilterRule | null {
  const [first] = children;
  if (children.length < 2 || first?.kind !== "rule") return null;
  const same = children.every(child => child.kind === "rule" && child.op === "eq" && child.valueKind === "literal" && child.field === first.field);
  return same ? { kind: "rule", id, field: first.field, op: "in", values: children.map(child => (child as FilterRule).value!) } : null;
}

function parseTokens(source: string, tokens: Token[], ids: Ids): FilterNode {
  tokens = unwrap(tokens);
  const id = ids();
  const leaf = matchRule(tokens, id);
  if (leaf) return leaf;
  const expr: FilterExpr = { kind: "expr", id, expression: source.slice(tokens[0]!.start, tokens.at(-1)!.end) };
  // A top-level ternary binds looser than `||`; splitting would cut it apart.
  if (tokens.some(token => token.t === "bad") || split(tokens, "?")?.length !== 1) return expr;
  for (const [op, combinator] of [["||", "any"], ["&&", "all"]] as const) {
    const parts = split(tokens, op);
    if (!parts || parts.length < 2) continue;
    const children = parts.map(part => parseTokens(source, part, ids));
    return (combinator === "any" && collapse(id, children)) || { kind: "group", id, combinator, children };
  }
  if (isOp(tokens[0], "!") && isOp(tokens[1], "(") && closing(tokens, 1) === tokens.length - 1) {
    const inner = parseTokens(source, tokens.slice(2, -1), ids);
    if (inner.kind === "rule" && inner.op === "in") return { ...inner, id, op: "not_in" };
    return { kind: "group", id, combinator: "none", children: inner.kind === "group" && inner.combinator === "any" ? inner.children : [inner] };
  }
  return expr;
}

/** Parses a `where` expression into a root group. Empty text is an empty `all` group. */
export function parseWhere(where: string): FilterGroup {
  let next = 0;
  const ids = () => `n${next++}`;
  const tokens = tokenize(where);
  if (!tokens.length) return { kind: "group", id: ids(), combinator: "all", children: [] };
  const node = parseTokens(where, tokens, ids);
  return node.kind === "group" ? node : { kind: "group", id: ids(), combinator: "all", children: [node] };
}

/** The rule `expression` spells, or null when it is custom CEL. */
export function tryExpressionToRule(expression: string, id = "rule"): FilterRule | null {
  const tokens = tokenize(expression);
  if (!tokens.length) return null;
  const node = parseTokens(expression, tokens, () => id);
  return node.kind === "rule" ? node : null;
}

const SYMBOLS: Partial<Record<FilterOperator, string>> = { eq: "==", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" };
const CALLS: Partial<Record<FilterOperator, string>> = { contains: "contains", not_contains: "!contains", starts_with: "startsWith", ends_with: "endsWith" };

function literal(value: FilterValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`Cannot compile non-finite number ${value}`);
  return String(value);
}

/** True when a rule has everything it needs to compile. */
export const isComplete = (rule: FilterRule) => UNARY.has(rule.op) || (MULTI.has(rule.op) ? !!rule.values?.length : rule.value !== undefined);

/** The CEL for one rule, or "" for a draft without a value. */
export function ruleToExpression({ field, op, value, valueKind, values }: FilterRule): string {
  if (op === "is_empty") return `(${field} == null || ${field} == "")`;
  if (op === "is_not_empty") return `(${field} != null && ${field} != "")`;
  if (MULTI.has(op)) {
    if (!values?.length) return "";
    if (values.length === 1) return `${field} ${op === "in" ? "==" : "!="} ${literal(values[0]!)}`;
    const any = values.map(item => `${field} == ${literal(item)}`).join(" || ");
    return op === "in" ? any : `!(${any})`;
  }
  if (value === undefined) return "";
  if (valueKind === "context" && (typeof value !== "string" || !CONTEXT.test(value))) throw new Error(`Invalid context expression ${String(value)}`);
  const right = valueKind === "context" ? (value as string) : literal(value);
  if (op === "year_eq") return `${field}.year() == ${right}`;
  const call = CALLS[op];
  return call ? `${call}(${field}, ${right})` : `${field} ${SYMBOLS[op]} ${right}`;
}

/** Whether CEL text must be parenthesised to stand as one operand of `&&` or `||`. */
function loose(expression: string): boolean {
  const tokens = tokenize(expression);
  if (tokens.some(token => token.t === "bad")) return true;
  return ["||", "&&", "?"].some(op => split(tokens, op)?.length !== 1);
}

const JOIN: Record<FilterCombinator, string> = { all: " && ", any: " || ", none: " || " };

/** The CEL for a node, parenthesised when it is one of several operands and would otherwise bind loosely. */
function compileNode(node: FilterNode, operand: boolean): string {
  switch (node.kind) {
    case "rule":
    case "expr": {
      const text = node.kind === "rule" ? ruleToExpression(node) : node.expression.trim();
      return operand && text && loose(text) ? `(${text})` : text;
    }
    case "group": {
      const text = compileGroup(node);
      return operand && text && loose(text) ? `(${text})` : text;
    }
  }
}

function compileGroup(group: FilterGroup): string {
  const active = group.children.filter(child => countActive(child) > 0);
  const parts = active.map(child => compileNode(child, active.length > 1));
  if (!parts.length) return "";
  return group.combinator === "none" ? `!(${parts.join(JOIN.none)})` : parts.join(JOIN[group.combinator]);
}

/** Emits the canonical `where` expression for a root group. Drafts and empty groups compile to nothing. */
export function compileWhere(root: FilterGroup): string {
  return compileGroup(root);
}

/** Rules and expressions that currently contribute to the compiled query. */
export function countActive(node: FilterNode): number {
  if (node.kind === "group") return node.children.reduce((total, child) => total + countActive(child), 0);
  return compileNode(node, false) ? 1 : 0;
}
