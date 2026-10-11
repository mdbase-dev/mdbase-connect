// Golden mapping of every legacy query_records input onto the mdbase-next query.
import { describe, expect, it } from "vitest";
import type { RecordView } from "@mdbase-dev/sdk";
import { changesInput, changesOutput, nextQueryPlan, queryOutput, recordDocument } from "./next-mapping.js";

const effective = { effective: true, body: false };

describe("query_records input mapping (golden)", () => {
  it.each<[string, Record<string, unknown>, unknown]>([
    ["types", { types: ["task", "note"] }, { query: { types: ["task", "note"] }, include: effective }],
    ["timezone", { timezone: "Australia/Sydney" }, { query: { timezone: "Australia/Sydney" }, include: effective }],
    ["context", { context: { this: { path: "a.md" } } }, { query: { context: { this: { path: "a.md" } } }, include: effective }],
    ["projections", { projections: { age: { expr: "now() - created", description: "Age" } } }, { query: { projections: { age: { expr: "now() - created", description: "Age" } } }, include: effective }],
    ["where", { where: "status == 'open'" }, { query: { where: "status == 'open'" }, include: effective }],
    ["select", { select: ["title", { name: "due", expr: "due", label: "Due" }] }, { query: { select: ["title", { name: "due", expr: "due", label: "Due" }] }, include: effective }],
    ["order_by", { order_by: [{ field: "due", direction: "desc" }] }, { query: { order_by: [{ field: "due", direction: "desc" }] }, include: effective }],
    ["group_by", { group_by: ["status"] }, { query: { group_by: ["status"] }, include: effective }],
    ["summary_functions", { summary_functions: { total: { expr: "values.sum()" } } }, { query: { summary_functions: { total: { expr: "values.sum()" } } }, include: effective }],
    ["summaries", { summaries: [{ field: "estimate", function: "sum" }] }, { query: { summaries: [{ field: "estimate", function: "sum" }] }, include: effective }],
    ["limit", { limit: 25 }, { query: { limit: 25 }, include: effective }],
    ["offset", { offset: 50 }, { query: { offset: 50 }, include: effective }],
    ["cursor", { cursor: "c1" }, { query: { cursor: "c1" }, include: effective }],
    ["pagination (dropped: cursors are returned whenever rows remain)", { pagination: "cursor", limit: 10 }, { query: { limit: 10 }, include: effective }],
    ["snapshot (dropped: next cursors are snapshot bound)", { snapshot: "s1", cursor: "c2" }, { query: { cursor: "c2" }, include: effective }],
    ["include_body", { include_body: true }, { query: {}, include: { effective: true, body: true } }],
    ["frontmatter_mode effective (default)", { frontmatter_mode: "effective" }, { query: {}, include: effective, mode: "effective" }],
    ["frontmatter_mode persisted", { frontmatter_mode: "persisted" }, { query: {}, include: { effective: false, body: false }, mode: "persisted" }],
    ["frontmatter_mode both", { frontmatter_mode: "both" }, { query: {}, include: effective, mode: "both" }],
    ["output metadata", { output: "metadata", select: ["title"] }, { query: { select: ["title"] }, include: { effective: false, body: false }, output: "metadata" }]
  ])("%s", (_name, input, expected) => {
    expect(nextQueryPlan(input)).toMatchObject({ kind: "query", ...(expected as object) });
    expect((nextQueryPlan(input) as { query: object }).query).toEqual((expected as { query: object }).query);
  });

  it("contract selects the contract query with where, limit (capped at 128) and cursor", () => {
    expect(nextQueryPlan({ contract: { id: "dev.tasks/task", version: "1.0.0", type: "task" }, where: "done == false", limit: 500, cursor: "c" })).toEqual({
      kind: "contract", contract: { id: "dev.tasks/task", version: "1.0.0", type: "task" }, where: "done == false", pageSize: 128, cursor: "c", includeBody: false
    });
    expect(() => nextQueryPlan({ contract: { id: "x", version: "1" }, order_by: ["due"] })).toThrow(/contract query accepts/);
    expect(() => nextQueryPlan({ contract: { id: "x" } })).toThrow(/id and version/);
  });

  it("refuses what the legacy authority refused, and unknown members", () => {
    expect(() => nextQueryPlan({ output: "metadata", include_body: true })).toThrow(/Metadata output/);
    expect(() => nextQueryPlan({ frontmatter_mode: "raw" })).toThrow(/frontmatter_mode/);
    expect(() => nextQueryPlan({ properties: {} })).toThrow(/Unknown query member/);
  });
});

const view = (over: Partial<RecordView> = {}): RecordView => ({
  id: "0190aaaa-0000-7000-8000-000000000001", path: "notes/a.md", revision: "rev1",
  frontmatter: new Map<string, never>([["title", "Persisted" as never]]),
  effective: new Map<string, never>([["title", "Persisted" as never], ["status", "open" as never]]),
  body: "Body", types: ["note"], state: { pending: false } as never, mtime: Date.UTC(2026, 9, 1), ...over
});

describe("query_records output mapping", () => {
  const result = { records: [view({ values: new Map([["title", "Persisted" as never]]) })], cursor: "next", complete: true, asOf: 7, totalCount: 3, hasMore: true };
  it("keeps the legacy row and meta shape per frontmatter_mode", () => {
    const plan = nextQueryPlan({ frontmatter_mode: "both" }) as Extract<ReturnType<typeof nextQueryPlan>, { kind: "query" }>;
    expect(queryOutput(plan, result)).toEqual({
      results: [{
        path: "notes/a.md", revision: "rev1", frontmatter: { title: "Persisted" }, effective_frontmatter: { title: "Persisted", status: "open" },
        body: "Body", types: ["note"], file: { path: "notes/a.md", name: "a", folder: "notes", mtime: "2026-10-01T00:00:00.000Z" }, values: { title: "Persisted" }
      }],
      meta: { total_count: 3, has_more: true, cursor: "next" }
    });
    const defaults = queryOutput(nextQueryPlan({}) as never, result) as { results: Array<Record<string, unknown>> };
    expect(defaults.results[0].frontmatter).toEqual({ title: "Persisted", status: "open" });
    expect(defaults.results[0]).not.toHaveProperty("effective_frontmatter");
  });

  it("metadata output returns path, types, revision and values only", () => {
    expect(queryOutput(nextQueryPlan({ output: "metadata" }) as never, result)).toEqual({
      output: "metadata",
      results: [{ path: "notes/a.md", types: ["note"], revision: "rev1", values: { title: "Persisted" } }],
      meta: { total_count: 3, has_more: true, cursor: "next" }
    });
  });

  it("read returns a legacy RecordDocument", () => {
    expect(recordDocument(view({ document: "---\ntitle: Persisted\n---\nBody" }))).toMatchObject({
      path: "notes/a.md", revision: "rev1", types: ["note"], frontmatter: { title: "Persisted" },
      effective_frontmatter: { title: "Persisted", status: "open" }, body: "Body", document: "---\ntitle: Persisted\n---\nBody"
    });
  });
});

describe("list_changes mapping", () => {
  it("passes opaque cursors; a legacy integer cursor becomes a cursor the replica resets", () => {
    expect(changesInput({})).toEqual({});
    expect(changesInput({ after: "12:40", limit: 5 })).toEqual({ cursor: "12:40", limit: 5 });
    expect(changesInput({ after: 2 })).toEqual({ cursor: "2" });
  });

  it("maps changes to legacy events with typed kinds", () => {
    const page = changesOutput({ changes: [
      { id: "i1", path: "a.md", kind: "put", version: 4, entity: "record" },
      { id: "i2", path: "b.md", kind: "remove", version: 5 },
      { id: "i3", path: "c.pdf", kind: "put", version: 6, entity: "file" }
    ], cursor: "9:6", reset: false }, 3);
    expect(page).toEqual({
      events: [
        { cursor: 4, type: "mdbase.record.modified", occurred_at: null, payload: { path: "a.md" } },
        { cursor: 5, type: "mdbase.record.deleted", occurred_at: null, payload: { path: "b.md" } },
        { cursor: 6, type: "mdbase.file.put", occurred_at: null, payload: { path: "c.pdf" } }
      ],
      cursor: "9:6", has_more: true, reset: false
    });
  });
});
