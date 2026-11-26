import { CompletionContext, type Completion, type CompletionResult } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  internalLinkAt,
  lineSeparatorFor,
  linkCompletion,
  markdownEdit,
  mentionScope,
  restoreLineSeparators,
  yamlFrontmatterDiagnostics
} from "./CodeEditor";
import type { CreateLinkedRecord, LinkCreation } from "./LinkPropertyEditor";
import type { LinkSuggestion } from "./links";
import type { CollectionFile, NoteSummary } from "./model";
import { linkTargets } from "./test/link-targets";

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

  it("offers to make the record being linked to, as each type it could be", () => {
    const made: Array<[string | undefined, string]> = [];
    const create: CreateLinkedRecord = (type, title, creation) => {
      made.push([type, title]);
      creation.link({ path: `People/${title}.md`, title });
    };
    const doc = "Ask [[Grace  Hopper";
    const view = new EditorView({ state: EditorState.create({ doc }), parent: document.body });
    const result = linkCompletion(new CompletionContext(view.state, doc.length, false), suggestions, ["person", "project"], undefined, [], [], [], undefined, create) as CompletionResult;
    expect(result.options.map((option) => option.label)).toEqual([
      "New note “Grace Hopper”", "New person “Grace Hopper”", "New project “Grace Hopper”"
    ]);
    expect(result.options[1]).toMatchObject({ type: "create" });

    (result.options[1]!.apply as (view: EditorView, completion: Completion, from: number, to: number) => void)(view, result.options[1]!, result.from, result.to!);
    expect(made).toEqual([["person", "Grace Hopper"]]);
    expect(view.state.doc.toString()).toBe("Ask [[People/Grace Hopper]]");
    view.destroy();
  });

  it("makes only the asked-for type from @/type/, and nothing a match already names", () => {
    const create: CreateLinkedRecord = (_type, title, creation) => creation.link({ path: `People/${title}.md`, title });
    const options = (doc: string) => (linkCompletion(new CompletionContext(EditorState.create({ doc }), doc.length, false), suggestions, types, undefined, [], [], [], undefined, create) as CompletionResult).options.map((option) => option.label);
    expect(options("@/person/Grace")).toEqual(["New person “Grace”"]);
    // The collection's own "note" type is what "New note" means there.
    expect(options("@Grace")).toEqual(["New note “Grace”", "New person “Grace”"]);
    expect(options("@Ada")).toEqual(["Ada", "Ada notes"]);
    expect(options("![[Grace")).toEqual([]);
    expect(options("[[Ada#Gra")).toEqual([]);
  });

  it("keeps the typed text until a record that needs a form is made, then links it there", () => {
    const doc = "@Grace";
    const view = new EditorView({ state: EditorState.create({ doc }), parent: document.body });
    let pending: LinkCreation | undefined;
    const result = linkCompletion(new CompletionContext(view.state, doc.length, false), suggestions, ["person"], undefined, [], [], [], undefined, (_type, _title, creation) => { pending = creation; }) as CompletionResult;
    (result.options[0]!.apply as (view: EditorView, completion: Completion, from: number, to: number) => void)(view, result.options[0]!, result.from, result.to!);
    expect(view.state.doc.toString()).toBe("@Grace");

    pending!.link({ path: "People/Grace.md", title: "Grace" });
    expect(view.state.doc.toString()).toBe("[[People/Grace]]");

    // Once the editor has gone there is nowhere to write a link, and nothing to open a form beside.
    view.destroy();
    expect(pending!.anchor()).toBeUndefined();
    expect(() => pending!.link({ path: "People/Grace.md", title: "Grace" })).not.toThrow();
  });

  it("replaces the link's closing brackets already after the caret", () => {
    const doc = "See [[Ada]]";
    const result = linkCompletion(new CompletionContext(EditorState.create({ doc }), doc.indexOf("]]"), false), suggestions, types) as CompletionResult;
    expect(result).toMatchObject({ from: doc.indexOf("Ada"), to: doc.length });
    expect(result.options[0]).toMatchObject({ apply: "People/ada]]" });
  });

  it("completes note and file transclusions", () => {
    const files: CollectionFile[] = [{
      fileId: "00000000-0000-4000-8000-000000000001",
      path: "Documents/paper.pdf",
      revision: "pdf-1",
      contentDigest: `sha256:${"1".repeat(64)}`,
      size: 10,
      mediaClass: "pdf",
      modifiedAt: "2026-08-15T00:00:00Z"
    }];
    expect(complete("Embed ![[pap", files)?.options).toMatchObject([
      { label: "paper.pdf", detail: "Transclude file · Documents/paper.pdf", apply: "Documents/paper.pdf]]" }
    ]);
  });

  it("completes heading and block anchors of the note the collection resolves", async () => {
    const notes = [{
      path: "People/ada.md",
      frontmatter: {},
      effectiveFrontmatter: { title: "Ada Lovelace" },
      types: ["person"],
      file: {},
      body: "# Ada Lovelace\n\n## Work\n\nAnalytical engine. ^engine"
    }] as NoteSummary[];
    const targets = linkTargets("Notes/today.md", { "[[People/ada]]": { kind: "note", path: "People/ada.md" } });
    expect((await resolveCompletion("![[People/ada#", notes, targets))?.options).toMatchObject([
      { label: "Ada Lovelace", detail: "Section in note", apply: "Ada Lovelace]]" },
      { label: "Work", detail: "Section in note", apply: "Work]]" },
      { label: "^engine", detail: "Block · Analytical engine.", apply: "^engine]]" }
    ]);
  });

  /** Completions that need no answer from the collection arrive at once. */
  function complete(doc: string, files: CollectionFile[] = []) {
    const state = EditorState.create({ doc });
    return linkCompletion(new CompletionContext(state, doc.length, false), suggestions, types, undefined, [], files) as CompletionResult | null;
  }

  function resolveCompletion(doc: string, notes: NoteSummary[], targets: ReturnType<typeof linkTargets>) {
    const state = EditorState.create({ doc });
    return linkCompletion(new CompletionContext(state, doc.length, false), suggestions, types, undefined, [], [], notes, targets);
  }
});

describe("internal link previews", () => {
  it("asks the collection about the link as written, never an external URL", () => {
    const wiki = "See [[Ada]].";
    const markdown = "Read [the engine](Projects/Engine.md).";
    const external = "Visit [mdbase](https://mdbase.dev).";
    expect(internalLinkAt(wiki, wiki.indexOf("Ada"))).toEqual({ raw: "[[Ada]]" });
    expect(internalLinkAt(markdown, markdown.indexOf("engine"))).toEqual({ raw: "[the engine](Projects/Engine.md)" });
    expect(internalLinkAt(external, external.indexOf("mdbase"))).toBeUndefined();
    expect(internalLinkAt(wiki, 0)).toBeUndefined();
  });
});
