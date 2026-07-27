import { describe, expect, it } from "vitest";
import { composeRecordSource, parseRecordSource, replaceDocumentFrontmatter } from "./record-source";

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

  it("keeps empty-frontmatter composition and edits body-only", () => {
    for (const source of ["", "Body", "Body\n", "---\nHorizontal rule without a closing fence"]) {
      expect(composeRecordSource({}, source)).toBe(source);
      expect(replaceDocumentFrontmatter(source, {})).toBe(source);
      expect(parseRecordSource(source)).toEqual({ frontmatter: {}, body: source });
    }
  });

  it("accepts an explicitly empty frontmatter block as an empty object", () => {
    const source = "---\n---\nBody\n";
    expect(parseRecordSource(source)).toEqual({ frontmatter: {}, body: "Body\n" });
    expect(replaceDocumentFrontmatter(source, {})).toBe("Body\n");
  });

  it("still rejects malformed YAML in a complete frontmatter block", () => {
    expect(() => parseRecordSource("---\nbroken: [\n---\nBody"))
      .toThrow();
    expect(() => parseRecordSource("---\n- scalar\n---\nBody"))
      .toThrow("Record frontmatter must be a YAML mapping.");
    expect(() => parseRecordSource("---\nnull\n---\nBody"))
      .toThrow("Record frontmatter must be a YAML mapping.");
  });
});
