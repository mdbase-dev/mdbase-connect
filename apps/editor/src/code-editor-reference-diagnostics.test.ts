import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { LinkTargets } from "./collection-links";
import { diagnosticsForReferences, MISSING_REFERENCE_CLASS } from "./code-editor-reference-diagnostics";
import type { LinkSuggestion } from "./links";
import type { NoteSummary } from "./model";
import { linkTargets } from "./test/link-targets";

let view: EditorView | undefined;
afterEach(() => { view?.destroy(); view = undefined; });

const suggestions: LinkSuggestion[] = [
  { path: "People/ada.md", title: "Ada Lovelace", aliases: ["Countess"] },
  { path: "Notes/project.md", title: "Project" },
  { path: "Archive/project.md", title: "Old project" }
];

function open(doc: string) {
  view = new EditorView({ doc, extensions: [markdown({ base: markdownLanguage })] });
  return view;
}

describe("reference diagnostics", () => {
  it("offers a path for a link written as a title or alias, keeping what it showed", async () => {
    const editor = open("Met [[Countess]] and ![[Ada Lovelace#Work]].");
    const diagnostics = await diagnosticsForReferences(editor, linkTargets("Notes/today.md"), suggestions, []);
    expect(diagnostics.map(({ message, markClass }) => [message, markClass])).toEqual([
      ["No note or file matches “Countess”.", MISSING_REFERENCE_CLASS],
      ["No note or file matches “Ada Lovelace”.", MISSING_REFERENCE_CLASS]
    ]);
    expect(diagnostics.map(({ actions }) => actions?.map(({ name }) => name))).toEqual([
      ["Link to Ada Lovelace"],
      ["Link to Ada Lovelace"]
    ]);
    const [alias, embed] = diagnostics;
    embed.actions![0].apply(editor, embed.from, embed.to);
    alias.actions![0].apply(editor, alias.from, alias.to);
    expect(editor.state.doc.toString()).toBe("Met [[People/ada|Countess]] and ![[People/ada#Work]].");
  });

  it("lists the notes an ambiguous link could mean as fixes", async () => {
    const editor = open("See [[project]].");
    const targets = linkTargets("Notes/today.md", {
      "[[project]]": { kind: "ambiguous", candidates: ["Archive/project.md", "Notes/project.md"] }
    });
    const [diagnostic] = await diagnosticsForReferences(editor, targets, suggestions, []);
    expect(diagnostic.message).toBe("2 notes match “project”. Use a path to disambiguate it.");
    expect(diagnostic.actions?.map(({ name }) => name)).toEqual(["Link to Old project", "Link to Project"]);
    diagnostic.actions![1].apply(editor, diagnostic.from, diagnostic.to);
    expect(editor.state.doc.toString()).toBe("See [[Notes/project]].");
  });

  it("checks sections in the note the collection resolved", async () => {
    const editor = open("[[Ada#Work]] [[Ada#Play]] [[#Here]]\n\n# Here");
    const targets = linkTargets("Notes/today.md", {
      "[[Ada#Work]]": { kind: "note", path: "People/ada.md" },
      "[[Ada#Play]]": { kind: "note", path: "People/ada.md" }
    });
    const notes = [{ path: "People/ada.md", body: "# Ada\n\n## Work\n" }] as NoteSummary[];
    expect((await diagnosticsForReferences(editor, targets, suggestions, notes)).map(({ message }) => message))
      .toEqual(["“Ada Lovelace” has no “Play” section or block."]);
  });

  it("reports nothing it could not check", async () => {
    const editor = open("[[Countess]]");
    const failing = new LinkTargets({ resolveLinks: async () => { throw new Error("offline"); } }, "Notes/today.md");
    expect(await diagnosticsForReferences(editor, failing, suggestions, [])).toEqual([]);
    expect(await diagnosticsForReferences(editor, undefined, suggestions, [])).toEqual([]);
  });
});
