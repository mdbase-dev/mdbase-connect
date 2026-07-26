import { describe, expect, it } from "vitest";
import { parseRecordSource, replaceDocumentFrontmatter } from "./record-source";

describe("record source", () => {
  it("preserves document framing, comments, CRLF, body whitespace, and explicit nulls", () => {
    const source = "\u{feff}---\r\ntitle: \"Before\" # title comment\r\ncustom: null\r\nremove: me\r\n---\r\nBody  \r\n";
    const next = replaceDocumentFrontmatter(source, { title: "After", custom: null, added: true });

    expect(next).toMatch(/^\u{feff}---\r\n/u);
    expect(next).toContain("# title comment\r\n");
    expect(next).toContain("custom: null\r\n");
    expect(next).not.toContain("remove:");
    expect(next).toContain("added: true\r\n");
    expect(next.endsWith("---\r\nBody  \r\n")).toBe(true);
    expect(parseRecordSource(next)).toEqual({
      frontmatter: { title: "After", custom: null, added: true },
      body: "Body  \r\n"
    });
  });

  it("adds frontmatter to a body-only record", () => {
    expect(replaceDocumentFrontmatter("Body\n", { title: "Note" })).toBe("---\ntitle: Note\n---\nBody\n");
  });
});
