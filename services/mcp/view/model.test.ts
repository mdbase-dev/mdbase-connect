import { describe, expect, it } from "vitest";
import { appendPage, recordTitle, shownResult, type Records } from "./model";

const record = {
  path: "tasks/renew-passport.md", revision: "r2", types: ["task"],
  frontmatter: { title: "Renew passport", status: "open" }, effective_frontmatter: { title: "Renew passport", status: "open", priority: "normal" },
  body: "Book an appointment.", file: { path: "tasks/renew-passport.md", name: "renew-passport", folder: "tasks" }
};

describe("what a tool result shows", () => {
  it("shows a read record as a record, by its persisted frontmatter", () => {
    expect(shownResult({ structuredContent: record })).toEqual({
      kind: "record",
      renamedFrom: undefined,
      record: { path: record.path, revision: "r2", types: ["task"], frontmatter: record.frontmatter, body: "Book an appointment.", name: "renew-passport" }
    });
  });

  it("shows the record a write saved, and where a rename moved it from", () => {
    const receipt = { request_id: "q", retry: "Reuse this request_id." };
    expect(shownResult({ structuredContent: { mutation_receipt: receipt, outcome: record } })).toMatchObject({ kind: "record", record: { revision: "r2" } });
    expect(shownResult({ structuredContent: { mutation_receipt: receipt, outcome: { ...record, from: "inbox/passport.md", to: record.path } } }))
      .toMatchObject({ kind: "record", renamedFrom: "inbox/passport.md" });
    expect(shownResult({ structuredContent: { mutation_receipt: receipt, outcome: { path: record.path, deleted: true } } })).toEqual({ kind: "unsupported" });
  });

  it("shows query results as rows, with columns from what the records hold unless the query selected them", () => {
    const shown = shownResult({
      structuredContent: {
        results: [record, { ...record, path: "tasks/b.md", file: { name: "b" }, frontmatter: { status: "done", due: "2026-12-01" } }],
        meta: { has_more: true, cursor: "c1", total_count: 9 }
      }
    });
    expect(shown).toMatchObject({
      kind: "records",
      columns: [{ key: "status", label: "status" }, { key: "due", label: "due" }],
      cursor: "c1",
      total: 9
    });
    expect((shown as Records).rows.map((row) => [row.name, row.cells.status])).toEqual([["renew-passport", "open"], ["b", "done"]]);
  });

  it("takes selected columns' values from the query's values, labelled as the query labels them", () => {
    const shown = shownResult({
      structuredContent: {
        output: "metadata",
        results: [{ path: "tasks/a.md", types: ["task"], revision: "r1", values: { status: "open", overdue: true } }],
        meta: { has_more: false }
      }
    }, { select: ["file.name", "status", { name: "overdue", expr: "due < today()", label: "Overdue" }] }) as Records;
    expect(shown.columns).toEqual([{ key: "status", label: "status" }, { key: "overdue", label: "Overdue" }]);
    expect(shown.rows[0]).toMatchObject({ name: "a", cells: { status: "open", overdue: true } });
    expect(shown.cursor).toBeUndefined();
  });

  it("shows grouped results that carry no records as their groups", () => {
    expect(shownResult({
      structuredContent: { results: [], meta: { has_more: false, groups: [{ values: { status: "open" }, count: 3, summaries: { hours: 5 } }] } }
    })).toEqual({
      kind: "groups",
      columns: [{ key: "status", label: "status" }, { key: "hours", label: "hours" }],
      groups: [{ values: { status: "open" }, count: 3, summaries: { hours: 5 } }]
    });
  });

  it("shows a refusal with its re-approval link, and anything else as unsupported", () => {
    expect(shownResult({
      isError: true,
      structuredContent: { error: { code: "reconnect_required", message: "Approve Notes again.", details: { authorization_url: "https://mcp.example/connections/new?ticket=t" } } }
    })).toEqual({ kind: "error", code: "reconnect_required", message: "Approve Notes again.", link: "https://mcp.example/connections/new?ticket=t" });
    expect(shownResult({ structuredContent: { connections: [] } })).toEqual({ kind: "unsupported" });
    expect(shownResult({})).toEqual({ kind: "unsupported" });
  });
});

describe("the next page of results", () => {
  it("adds its rows after the ones shown, keeps their columns, and takes its cursor", () => {
    const first = shownResult({ structuredContent: { results: [record], meta: { has_more: true, cursor: "c1" } } }) as Records;
    const next = shownResult({ structuredContent: { results: [{ ...record, path: "tasks/c.md", frontmatter: { owner: "Sam" } }], meta: { has_more: false } } });
    const merged = appendPage(first, next)!;
    expect(merged.rows.map((row) => row.path)).toEqual(["tasks/renew-passport.md", "tasks/c.md"]);
    expect(merged.columns.map((column) => column.key)).toEqual(["status", "owner"]);
    expect(merged.cursor).toBeUndefined();
    expect(appendPage(first, { kind: "error", code: "cursor_expired", message: "", link: undefined })).toBeUndefined();
  });
});

describe("a record's title", () => {
  it("is its title property, or else its file name", () => {
    expect(recordTitle({ frontmatter: { title: "  Renew passport " }, name: "renew-passport" })).toBe("Renew passport");
    expect(recordTitle({ frontmatter: { title: 3 }, name: "renew-passport" })).toBe("renew-passport");
  });
});
