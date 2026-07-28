import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  internalLinkPathAt,
  lineSeparatorFor,
  linkCompletion,
  markdownEdit,
  mentionScope,
  restoreLineSeparators,
  yamlFrontmatterDiagnostics
} from "./CodeEditor";
import type { LinkSuggestion } from "./links";

describe("mdbase mention scope", () => {
  const types = ["note", "person", "reading-item"];

  it("searches all objects for a plain @ mention", () => {
    expect(mentionScope("Ada Lovelace", types)).toEqual({
      query: "Ada Lovelace",
      typeQuery: "",
      showTypes: false
    });
  });

  it("offers declared types and scopes object search", () => {
    expect(mentionScope("/per", types)).toEqual({
      query: "",
      typeQuery: "per",
      showTypes: true
    });
    expect(mentionScope("/person/ada", types)).toEqual({
      query: "ada",
      type: "person",
      typeQuery: "",
      showTypes: false
    });
  });

  it("does not accept undeclared mdbase types", () => {
    expect(mentionScope("/contact/ada", types)).toEqual({
      query: "ada",
      type: undefined,
      typeQuery: "contact",
      showTypes: true
    });
  });
});

it("retains the source document line separator while editing", () => {
  const separator = lineSeparatorFor("---\r\ntitle: Note\r\n---\r\n");
  const state = EditorState.create({ doc: "---\r\ntitle: Note\r\n---\r\n" });
  expect(restoreLineSeparators(state.doc.toString(), separator)).toBe("---\r\ntitle: Note\r\n---\r\n");
});

describe("YAML frontmatter diagnostics", () => {
  it("accepts a complete type file as one frontmatter document", () => {
    expect(yamlFrontmatterDiagnostics(`---
kind: mdbase.type
name: note
---
`)).toEqual([]);
  });

  it("offsets YAML errors into the complete type source", () => {
    const source = `---
kind: mdbase.type
schema: [
---
`;
    const diagnostics = yamlFrontmatterDiagnostics(source);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).not.toContain("multiple documents");
    expect(diagnostics[0].from).toBeGreaterThan(source.indexOf("schema:"));
  });

  it("reports incomplete frontmatter boundaries", () => {
    expect(yamlFrontmatterDiagnostics("kind: mdbase.type\n")[0].message)
      .toBe("Type definitions need YAML frontmatter between --- markers.");
    expect(yamlFrontmatterDiagnostics("---\nkind: mdbase.type\n")[0].message)
      .toBe("Type definitions need a closing --- frontmatter marker.");
  });
});

describe("Markdown formatting", () => {
  it("wraps and unwraps selected text without losing the selection", () => {
    expect(markdownEdit("hello world", 6, 11, "bold")).toEqual({
      insert: "**world**",
      from: 6,
      to: 11,
      anchor: 8,
      head: 13
    });
    expect(markdownEdit("hello **world**", 8, 13, "bold")).toEqual({
      insert: "world",
      from: 6,
      to: 15,
      anchor: 6,
      head: 11
    });
  });

  it("places the selection in the useful part of inserted syntax", () => {
    expect(markdownEdit("Ada", 0, 3, "link")).toEqual({
      insert: "[Ada](https://)",
      from: 0,
      to: 3,
      anchor: 6,
      head: 14
    });
    expect(markdownEdit("", 0, 0, "code")).toEqual({
      insert: "`code`",
      from: 0,
      to: 0,
      anchor: 1,
      head: 5
    });
  });
});

describe("object link completion", () => {
  const suggestions: LinkSuggestion[] = [
    { path: "People/ada.md", title: "Ada Lovelace", aliases: ["Ada"], types: ["person"] },
    { path: "Notes/ada.md", title: "Ada notes", types: ["note"] }
  ];
  const types = ["note", "person"];

  it("turns an @ selection into a portable wikilink", () => {
    const result = complete("Talk to @Ada");

    expect(result?.from).toBe(8);
    expect(result?.options).toMatchObject([
      { label: "Ada", detail: "Ada Lovelace · person · People/ada.md", apply: "[[People/ada]]" },
      { label: "Ada notes", detail: "note · Notes/ada.md", apply: "[[Notes/ada|Ada notes]]" }
    ]);
  });

  it("limits @/type/query to records of a declared mdbase type", () => {
    expect(complete("@/person/ada")?.options).toMatchObject([
      { label: "Ada", apply: "[[People/ada]]" }
    ]);
  });

  it("offers declared mdbase types from @/", () => {
    expect(complete("@/per")?.options).toMatchObject([
      { label: "/person", detail: "Filter links by type", type: "type" }
    ]);
    expect(complete("@/contact")?.options).toEqual([]);
  });

  it("keeps [[ completion and ignores email addresses", () => {
    expect(complete("See [[Ada")?.options[0]).toMatchObject({ label: "Ada", apply: "People/ada]]" });
    expect(complete("hello@example.com")).toBeNull();
  });

  function complete(doc: string) {
    const state = EditorState.create({ doc });
    return linkCompletion(new CompletionContext(state, doc.length, false), suggestions, types);
  }
});

describe("internal link previews", () => {
  const suggestions: LinkSuggestion[] = [
    { path: "People/ada.md", title: "Ada Lovelace", aliases: ["Ada"], types: ["person"] },
    { path: "Projects/Engine.md", title: "Analytical Engine", types: ["project"] }
  ];

  it("resolves wiki and Markdown links while ignoring external URLs", () => {
    const wiki = "See [[People/ada|Ada]].";
    const markdown = "Read [the engine](Projects/Engine.md).";
    const external = "Visit [mdbase](https://mdbase.dev).";

    expect(internalLinkPathAt(wiki, wiki.indexOf("Ada"), suggestions, "Notes/Today.md"))
      .toBe("People/ada.md");
    expect(internalLinkPathAt(markdown, markdown.indexOf("engine"), suggestions, "Notes/Today.md"))
      .toBe("Projects/Engine.md");
    expect(internalLinkPathAt(external, external.indexOf("mdbase"), suggestions, "Notes/Today.md"))
      .toBeUndefined();
  });
});
