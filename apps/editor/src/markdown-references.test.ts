import { describe, expect, it } from "vitest";
import { markdownReferenceAt, markdownReferences } from "./markdown-references";

describe("Markdown references", () => {
  it("parses links and embeds with aliases and anchors", () => {
    const source = [
      "See [[People/Ada#Work|Ada at work]].",
      "",
      "![[Notes/Plan#Next steps]]",
      "",
      "![Diagram](../Assets/map.svg#page=2)"
    ].join("\n");

    expect(markdownReferences(source).map(({ from: _from, to: _to, ...reference }) => reference)).toEqual([
      {
        target: "People/Ada",
        label: "Ada at work",
        anchor: "Work",
        kind: "link",
        format: "wikilink",
        block: false
      },
      {
        target: "Notes/Plan",
        anchor: "Next steps",
        kind: "embed",
        format: "wikilink",
        block: true
      },
      {
        target: "../Assets/map.svg",
        label: "Diagram",
        anchor: "page=2",
        kind: "embed",
        format: "markdown",
        block: true
      }
    ]);
  });

  it("ignores reference examples inside inline and fenced code", () => {
    const source = [
      "`[[Inline/example]]`",
      "```md",
      "![[Fenced/example]]",
      "```",
      "[[Actual/note]]"
    ].join("\n");

    expect(markdownReferences(source).map((reference) => reference.target)).toEqual(["Actual/note"]);
    expect(markdownReferenceAt(source, source.indexOf("Inline"), "link")).toBeUndefined();
    expect(markdownReferenceAt(source, source.indexOf("Actual"), "link")?.target).toBe("Actual/note");
  });

  it("supports same-note section transclusions", () => {
    expect(markdownReferences("![[#Decisions]]")[0]).toMatchObject({
      target: "",
      anchor: "Decisions",
      kind: "embed",
      block: true
    });
  });
});
