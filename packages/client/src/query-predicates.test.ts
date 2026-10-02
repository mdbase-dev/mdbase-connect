import { describe, expect, it } from "vitest";
import { linksTo } from "./query-predicates.js";

describe("linksTo", () => {
  it("guards missing/null/unresolved scalar links and compares the exact resolved path", () => {
    expect(linksTo("source", "sources/book.md")).toBe('"source" in record && record["source"] != null && record["source"].asFile() != null && record["source"].asFile().file.path == "sources/book.md"');
  });
  it("uses an existential resolved predicate for declared link lists", () => {
    expect(linksTo("assignees", "people/alice.md", { multiple: true })).toBe('"assignees" in record && record["assignees"] != null && record["assignees"].exists(link, link != null && link.asFile() != null && link.asFile().file.path == "people/alice.md")');
  });
  it("treats field names and target paths as literals, not CEL", () => {
    const field = 'x"] || true || record["', path = 'quote"\\line\n雪.md';
    const expression = linksTo(field, path);
    expect(expression).toContain(`record[${JSON.stringify(field)}]`);
    expect(expression).toContain(`== ${JSON.stringify(path)}`);
    expect(linksTo("file", "note.md")).toContain('record["file"]');
  });
});
