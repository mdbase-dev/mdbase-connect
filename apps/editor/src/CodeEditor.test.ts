import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { lineSeparatorFor, linkCompletion, markdownEdit, mentionScope, restoreLineSeparators } from "./CodeEditor";
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
