import { describe, expect, it } from "vitest";

import { compileWhere, countActive, parseWhere, ruleToExpression, tryExpressionToRule } from "./filter-ast.js";
import { fieldsFromJsonSchema, type FilterGroup, type FilterNode } from "./types.js";

const roundTrip = (where: string) => compileWhere(parseWhere(where));
/** The tree without ids, as [combinator, ...children] with rules as [field, op, value?, valueKind?] (or [field, op, values]) and exprs as text. */
function shape(node: FilterNode): unknown {
  if (node.kind === "group") return [node.combinator, ...node.children.map(shape)];
  if (node.kind === "expr") return node.expression;
  if (node.values) return [node.field, node.op, node.values];
  return node.value === undefined ? [node.field, node.op] : [node.field, node.op, node.value, node.valueKind];
}
const tree = (where: string) => shape(parseWhere(where));

describe("parseWhere", () => {
  it("reads an empty query as an empty all group", () => {
    expect(tree("")).toEqual(["all"]);
    expect(tree("   ")).toEqual(["all"]);
  });

  it("parses a type filter with a year bound to a context variable", () => {
    expect(tree('type == "expense" && year(date) == this.fiscal_year')).toEqual(["all",
      ["type", "eq", "expense", "literal"], ["date", "year_eq", "this.fiscal_year", "context"]]);
    expect(roundTrip('type == "expense" && year(date) == this.fiscal_year')).toBe('type == "expense" && date.year() == this.fiscal_year');
    expect(roundTrip("date.year() == 2026")).toBe("date.year() == 2026");
  });

  it("round-trips nested all, any and none groups", () => {
    const nested = 'status != "draft" && (category == "Software" || amount >= 1000)';
    expect(tree(nested)).toEqual(["all", ["status", "neq", "draft", "literal"], ["any", ["category", "eq", "Software", "literal"], ["amount", "gte", 1000, "literal"]]]);
    expect(roundTrip(nested)).toBe(nested);
    const none = '!(status == "churned" || amount > 5)';
    expect(tree(none)).toEqual(["none", ["status", "eq", "churned", "literal"], ["amount", "gt", 5, "literal"]]);
    expect(roundTrip(none)).toBe(none);
    const deep = 'a == 1 || (b == 2 && !(c == 3 || (d == 4 && e == 5)))';
    expect(tree(deep)).toEqual(["any", ["a", "eq", 1, "literal"], ["all", ["b", "eq", 2, "literal"],
      ["none", ["c", "eq", 3, "literal"], ["all", ["d", "eq", 4, "literal"], ["e", "eq", 5, "literal"]]]]]);
    expect(roundTrip(deep)).toBe(deep);
  });

  it("collapses same-field literal equalities into in and not_in rules", () => {
    const any = 'category == "Software" || category == "Travel"';
    expect(tree(any)).toEqual(["all", ["category", "in", ["Software", "Travel"]]]);
    expect(roundTrip(any)).toBe(any);
    const scoped = 'date.year() == 2026 && (category == "Software" || category == "Travel")';
    expect(tree(scoped)).toEqual(["all", ["date", "year_eq", 2026, "literal"], ["category", "in", ["Software", "Travel"]]]);
    expect(roundTrip(scoped)).toBe(scoped);
    const none = '!(status == "churned" || status == "trial" || status == "draft") && amount > 5';
    expect(tree(none)).toEqual(["all", ["status", "not_in", ["churned", "trial", "draft"]], ["amount", "gt", 5, "literal"]]);
    expect(roundTrip(none)).toBe(none);
    expect(tree("n == 1 || n == 2.5")).toEqual(["all", ["n", "in", [1, 2.5]]]);
  });

  it("keeps heterogeneous or partial OR groups as groups", () => {
    expect(tree('category == "Software" || amount > 1000')).toEqual(["any", ["category", "eq", "Software", "literal"], ["amount", "gt", 1000, "literal"]]);
    expect(tree('a == 1 || b == 1')).toEqual(["any", ["a", "eq", 1, "literal"], ["b", "eq", 1, "literal"]]);
    expect(tree('a == 1 || a == this.x')).toEqual(["any", ["a", "eq", 1, "literal"], ["a", "eq", "this.x", "context"]]);
    expect(tree('a == 1 || (a == 2 || a == 3)')).toEqual(["any", ["a", "eq", 1, "literal"], ["a", "in", [2, 3]]]);
    expect(roundTrip('a == 1 || (a == 2 || a == 3)')).toBe('a == 1 || (a == 2 || a == 3)');
    expect(tree('!(a == 1)')).toEqual(["none", ["a", "eq", 1, "literal"]]);
  });

  it("keeps custom CEL as expression leaves beside visual rules and groups", () => {
    const mixed = 'status == "open" && amount * 1.1 > 500 && (size(tags) > 2 || priority == 1)';
    expect(tree(mixed)).toEqual(["all", ["status", "eq", "open", "literal"], "amount * 1.1 > 500", ["any", "size(tags) > 2", ["priority", "eq", 1, "literal"]]]);
    expect(roundTrip(mixed)).toBe(mixed);
  });

  it("parses every text operator in function and method form", () => {
    expect(tree('contains(title, "Q1 \\"draft\\"") && title.contains(\'rent\')')).toEqual(["all",
      ["title", "contains", 'Q1 "draft"', "literal"], ["title", "contains", "rent", "literal"]]);
    expect(tree('!contains(title, "x") && !title.contains("y") && startsWith(title, "Q") && title.endsWith(this.suffix)')).toEqual(["all",
      ["title", "not_contains", "x", "literal"], ["title", "not_contains", "y", "literal"],
      ["title", "starts_with", "Q", "literal"], ["title", "ends_with", "this.suffix", "context"]]);
    expect(roundTrip('title.contains("rent") && !title.contains("y") && title.startsWith("Q") && title.endsWith("z")'))
      .toBe('contains(title, "rent") && !contains(title, "y") && startsWith(title, "Q") && endsWith(title, "z")');
  });

  it("parses the unary emptiness checks", () => {
    const where = '(due == null || due == "") && (title != null && title != "")';
    expect(tree(where)).toEqual(["all", ["due", "is_empty"], ["title", "is_not_empty"]]);
    expect(roundTrip(where)).toBe(where);
    expect(tree('due == null || due == ""')).toEqual(["all", ["due", "is_empty"]]);
  });

  it("parses every numeric comparison and literal kind", () => {
    const where = "amount > 10 && amount >= -2.5 && amount < 1e3 && amount <= 99 && count != 0 && paid == true && note != this.label";
    expect(tree(where)).toEqual(["all",
      ["amount", "gt", 10, "literal"], ["amount", "gte", -2.5, "literal"], ["amount", "lt", 1000, "literal"], ["amount", "lte", 99, "literal"],
      ["count", "neq", 0, "literal"], ["paid", "eq", true, "literal"], ["note", "neq", "this.label", "context"]]);
    expect(roundTrip(where)).toBe("amount > 10 && amount >= -2.5 && amount < 1000 && amount <= 99 && count != 0 && paid == true && note != this.label");
  });

  it("drops redundant parentheses but keeps written groups", () => {
    expect(roundTrip('((type == "task")) && (status == "open" && (priority > 2))')).toBe('type == "task" && (status == "open" && priority > 2)');
    expect(tree("((a == 1))")).toEqual(["all", ["a", "eq", 1, "literal"]]);
  });

  it.each([
    '"open" == status',
    "this.year == 2026",
    "due == null",
    "year(date) == 2026.5",
    "a == b",
    "date.month() == 3",
    "!paid",
    "size(tags) > 2",
    'contains(title, 3)',
  ])("keeps %s as one expression", where => {
    expect(tree(where)).toEqual(["all", where]);
    expect(roundTrip(where)).toBe(where);
  });

  it.each([
    'status == "open" &&',
    'status == "unterminated',
    "(status == 1",
    'a ? b == 1 || c == 2 : d',
  ])("never splits malformed or ternary text: %s", where => {
    expect(tree(where)).toEqual(["all", where]);
    expect(roundTrip(where)).toBe(where);
  });
});

describe("compileWhere", () => {
  const rule = (id: string, field: string, value?: number): FilterNode => ({ kind: "rule", id, field, op: "gt", ...(value !== undefined && { value, valueKind: "literal" as const }) });
  const group = (combinator: FilterGroup["combinator"], ...children: FilterNode[]): FilterGroup => ({ kind: "group", id: "g", combinator, children });

  it("skips drafts, blank expressions and empty groups", () => {
    const root = group("all", rule("a", "amount", 5), rule("b", "amount"), { kind: "expr", id: "c", expression: "  " }, group("any"), group("any", rule("d", "x")));
    expect(compileWhere(root)).toBe("amount > 5");
    expect(countActive(root)).toBe(1);
    expect(compileWhere(group("none"))).toBe("");
  });

  it("parenthesises loose expressions and nested groups", () => {
    expect(compileWhere(group("all", { kind: "expr", id: "e", expression: "a == 1 || b == 2" }, rule("r", "x", 1)))).toBe("(a == 1 || b == 2) && x > 1");
    expect(compileWhere(group("any", { kind: "expr", id: "e", expression: "c ? d : e" }, group("all", rule("r", "x", 1), rule("s", "y", 2))))).toBe("(c ? d : e) || (x > 1 && y > 2)");
    expect(compileWhere(group("all", group("none", rule("r", "x", 1)), { kind: "expr", id: "e", expression: "(a || b)" }))).toBe("!(x > 1) && (a || b)");
  });

  it("compiles in and not_in, folding a single value to equality", () => {
    const multi = (op: "in" | "not_in", values: (string | number)[]) => ruleToExpression({ kind: "rule", id: "m", field: "category", op, values });
    expect(multi("in", ["Software", "Travel"])).toBe('category == "Software" || category == "Travel"');
    expect(multi("not_in", ["Software", "Travel"])).toBe('!(category == "Software" || category == "Travel")');
    expect(multi("in", ["Software"])).toBe('category == "Software"');
    expect(multi("not_in", [3])).toBe("category != 3");
    expect(multi("in", [])).toBe("");
    expect(compileWhere(group("all", rule("a", "amount", 5), { kind: "rule", id: "m", field: "category", op: "in", values: ["A", "B"] })))
      .toBe('amount > 5 && (category == "A" || category == "B")');
  });

  it("escapes strings and rejects malformed context expressions", () => {
    expect(ruleToExpression({ kind: "rule", id: "a", field: "note", op: "eq", value: 'say "hi"\n', valueKind: "literal" })).toBe('note == "say \\"hi\\"\\n"');
    expect(roundTrip('note == "tab\\t\\"q\\"\\\\"')).toBe('note == "tab\\t\\"q\\"\\\\"');
    expect(() => ruleToExpression({ kind: "rule", id: "a", field: "x", op: "eq", value: "this.a || true", valueKind: "context" })).toThrow();
  });

  it("converts single expressions to rules only when they are visual", () => {
    expect(tryExpressionToRule("(amount >= 10)", "r1")).toEqual({ kind: "rule", id: "r1", field: "amount", op: "gte", value: 10, valueKind: "literal" });
    expect(tryExpressionToRule("amount * 2 > 10")).toBeNull();
    expect(tryExpressionToRule("a == 1 && b == 2")).toBeNull();
    expect(tryExpressionToRule('c == "A" || c == "B"', "r2")).toEqual({ kind: "rule", id: "r2", field: "c", op: "in", values: ["A", "B"] });
    expect(tryExpressionToRule('!(c == "A" || c == "B")', "r3")).toEqual({ kind: "rule", id: "r3", field: "c", op: "not_in", values: ["A", "B"] });
    expect(tryExpressionToRule("")).toBeNull();
  });
});

describe("fieldsFromJsonSchema", () => {
  it("maps scalar schema properties and appends undescribed columns", () => {
    const schema = {
      type: "object",
      properties: {
        type: { type: "string", enum: ["expense", "income"] },
        amount: { type: "number" },
        count: { type: ["integer", "null"] },
        paid: { type: "boolean" },
        date: { type: "string", format: "date" },
        note: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        meta: { type: "object" },
      },
    };
    expect(fieldsFromJsonSchema(schema, ["date", "tags", "vendor"], { amount: "Amount", vendor: "Vendor" })).toEqual([
      { key: "type", kind: "enum", enumValues: ["expense", "income"] },
      { key: "amount", kind: "number", label: "Amount" },
      { key: "count", kind: "number" },
      { key: "paid", kind: "boolean" },
      { key: "date", kind: "date" },
      { key: "note", kind: "string" },
      { key: "vendor", kind: "string", label: "Vendor" },
    ]);
  });

  it("falls back to string columns without a schema", () => {
    expect(fieldsFromJsonSchema(null, ["title"])).toEqual([{ key: "title", kind: "string" }]);
  });
});
