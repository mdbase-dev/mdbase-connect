import { describe, expect, it } from "vitest";
import { createEvaluationContext, evaluateToPlain } from "obsidian-bases-expression";
import { compileTaskNotesQuery, TaskNotesQueryError, type TaskNotesQueryBindings, type TaskNotesQueryInput } from "../src/query/tasknotes.js";

const bindings: TaskNotesQueryBindings = { types: ["task"], fields: { status: "status", priority: "priority", "Review Status": "Review Status", raw: "raw" }, filterQueryBasis: "effective", nativeTimestampFields: [], basesTypedFields: [] };
const bases = (filter: unknown): TaskNotesQueryInput => ({ dialect: "obsidian-bases", filter });
function code(input: TaskNotesQueryInput): string {
  try { compileTaskNotesQuery(input, bindings); return "unexpected_success"; }
  catch (error) { expect(error).toBeInstanceOf(TaskNotesQueryError); return (error as TaskNotesQueryError).code; }
}

describe("restricted shared TaskNotes query compiler (source checks, not Core execution)", () => {
  it("uses raw Bases fields with missing-to-null rewrite, not unsafe note-to-record substitution", () => {
    const result = compileTaskNotesQuery(bases('note.status == "open"'), bindings);
    expect(result.query).toEqual({ types: ["task"], where: '(((("status" in raw) ? raw["status"] : null) == "open"))' });
    expect(result.dependencies).toEqual([{ source: "raw", field: "status" }]);
    expect(result.requiresReplicaValidation).toBe(true);
    expect(result.parserVersion).toBe("0.3.0-rc.4");
  });
  it("conjoins source-global and view-local filters", () => {
    const result = compileTaskNotesQuery({ dialect: "obsidian-bases", globalFilter: 'status == "open"', filter: { or: ['priority == "high"', 'priority == "normal"'] } }, bindings);
    expect(result.query.where).toContain('"status" in raw');
    expect(result.query.where).toContain(" && ");
    expect(result.query.where).toContain(" || ");
    expect(result.dependencies.map(d => d.field)).toEqual(["status", "priority"]);
  });
  it("refuses generic FilterQuery: string catalogue/status names do not prove legacy coercion or array semantics", () => {
    const input: TaskNotesQueryInput = { dialect: "tasknotes-filter", filter: { type: "group", id: "root", conjunction: "and", children: [{ type: "condition", id: "one", property: "status", operator: "is", value: "open" }] } };
    expect(code(input)).toBe("unsupported_dialect");
    // Actual FilterUtils isEqual does scalar-array existential matching; Bases
    // (and the proven Core packet) instead compare these as unequal. Until the
    // real legacy oracle/lowering is supplied, there must be no query output.
    expect(evaluateToPlain('status == "open"', createEvaluationContext({ note: { status: ["open"] }, thisRecord: null }))).toBe(false);
    expect(() => compileTaskNotesQuery(input, { ...bindings, fields: { status: "Review Status" }, filterQueryBasis: "raw" })).toThrow(TaskNotesQueryError);
  });
  it("requires explicit catalogue/Bases typing metadata and rejects typed temporal/link fields", () => {
    expect(() => compileTaskNotesQuery(bases('status == "open"'), { ...bindings, nativeTimestampFields: ["status"] })).toThrow("unsupported_expression");
    expect(() => compileTaskNotesQuery(bases('status == "open"'), { ...bindings, basesTypedFields: ["status"] })).toThrow("unsupported_expression");
    const missing = { types: bindings.types, fields: bindings.fields, filterQueryBasis: bindings.filterQueryBasis, basesTypedFields: bindings.basesTypedFields };
    expect(() => compileTaskNotesQuery(bases('status == "open"'), missing as TaskNotesQueryBindings)).toThrow("invalid_input");
  });
  it.each([
    ['file.hasTag("task")', "unsupported_expression"],
    ['due < today()', "unsupported_operator"],
    ['this.file.name == "x"', "unsupported_expression"],
    ['formula.urgencyScore == 2', "unsupported_expression"],
    ['priority >= 2', "unsupported_operator"],
    ['note.projects.contains("work")', "unsupported_expression"],
    ['note.status', "unsupported_expression"],
    ['!note.status', "unsupported_expression"],
    ['status && true', "unsupported_expression"],
    ['unknown == "open"', "unsupported_field"],
    ['status ==', "invalid_input"],
  ])("rejects %s without dropping a subtree", (source, expected) => expect(code(bases(source))).toBe(expected));
  it("refuses unsupported grouping/sorting/projections and unblessed native CEL", () => {
    expect(code({ ...bases('status == "open"'), groupProperty: "status" } as TaskNotesQueryInput)).toBe("unsupported_group");
    expect(code({ dialect: "obsidian-bases", sort: [{ property: "status", direction: "asc" }] })).toBe("unsupported_sort");
    expect(code({ dialect: "obsidian-bases", computedProperties: [{ name: "rank", expression: "priority" }] })).toBe("unsupported_projection");
    expect(code({ dialect: "mdbase-cel", filter: "status in ['open']" })).toBe("unsupported_dialect");
  });
  it("does not silently ignore sort/group embedded in actual plugin FilterQuery", () => {
    const filter = { type: "group", id: "root", conjunction: "and", children: [{ type: "condition", id: "one", property: "status", operator: "is", value: "open" }], sortKey: "priority" };
    expect(code({ dialect: "tasknotes-filter", filter } as TaskNotesQueryInput)).toBe("unsupported_sort");
  });
  it("rejects empty, malformed and cyclic structured filters", () => {
    expect(code(bases({ and: [] }))).toBe("invalid_input");
    expect(code(bases({ or: new Array(2) }))).toBe("invalid_input");
    expect(() => compileTaskNotesQuery(bases("true"), { ...bindings, types: new Array(1) })).toThrow("invalid_input");
    expect(code(bases({ and: ['status == "open"'], or: ["true"] }))).toBe("invalid_input");
    const cyclic: { and: unknown[] } = { and: [] }; cyclic.and.push(cyclic);
    expect(code(bases(cyclic))).toBe("invalid_input");
    expect(code({ dialect: "obsidian-bases", sort: {} } as unknown as TaskNotesQueryInput)).toBe("unsupported_sort");
  });
  it("bounds individual parser calls including unary chains, UTF8 and tree work", () => {
    expect(code(bases("!".repeat(513) + "true"))).toBe("query_budget");
    expect(code(bases("(".repeat(33) + "true" + ")".repeat(33)))).toBe("query_budget");
    expect(code(bases({ and: Array(257).fill("true") }))).toBe("query_budget");
    expect(code(bases('status == "\ud800"'))).toBe("invalid_input");
  });
  it("escapes field names and literals as data", () => {
    const value = 'x" || true || "';
    const result = compileTaskNotesQuery(bases(`note["Review Status"] == ${JSON.stringify(value)}`), bindings);
    expect(result.query.where).toContain(JSON.stringify(value));
    expect(result.query.where).toContain('raw["Review Status"]');
  });
  it("refuses unknown query descriptor keys instead of dropping selection/context options", () => {
    expect(code({ ...bases('status == "open"'), select: ["status"] } as unknown as TaskNotesQueryInput)).toBe("invalid_input");
    expect(code({ ...bases('status == "open"'), groupDirection: "desc" } as unknown as TaskNotesQueryInput)).toBe("invalid_input");
  });
  it("preserves special Bases roots and refuses unproven renaming of raw property keys", () => {
    const roots = { ...bindings, fields: { ...bindings.fields, file: "file", note: "note", formula: "formula" } };
    for (const root of ["file", "note", "formula"]) {
      expect(() => compileTaskNotesQuery(bases(`${root} == null`), roots)).toThrow("unsupported_expression");
    }
    expect(compileTaskNotesQuery(bases('note.file == null'), roots).dependencies).toEqual([{ source: "raw", field: "file" }]);
    expect(() => compileTaskNotesQuery(bases('status == "open"'), { ...bindings, fields: { status: "Review Status" } })).toThrow("unsupported_field");
  });
  it("uses package tokens, not string contents, to bound delimiter nesting", () => {
    const value = "(".repeat(40);
    expect(compileTaskNotesQuery(bases(`status == ${JSON.stringify(value)}`), bindings).query.where).toContain(JSON.stringify(value));
  });
  it("records the pinned Bases oracle on missing/null/mixed kinds; does not fake CEL execution", () => {
    const cases = [{}, { status: null }, { status: "open" }, { status: 1 }, { status: true }, { status: ["open"] }];
    expect(cases.map(note => evaluateToPlain('note.status == "open"', createEvaluationContext({ note, thisRecord: null })))).toEqual([false, false, true, false, false, false]);
    expect(cases.map(note => evaluateToPlain('note.status != "open"', createEvaluationContext({ note, thisRecord: null })))).toEqual([true, true, false, true, true, true]);
  });
});
