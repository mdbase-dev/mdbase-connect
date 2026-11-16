import { markdownLanguage } from "@codemirror/lang-markdown";
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
  it("finds the same references after each edit as a fresh parse does", () => {
    let source = Array.from({ length: 60 }, (_, index) => `## Part ${index}\n\nSee [[Note ${index}]] and ![[image-${index}.png]].\n\n\`\`\`\n[[not a link]]\n\`\`\`\n`).join("\n");
    let seed = 7;
    const random = (limit: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % limit; };
    const inserts = ["x", "[[", "]]", "\n", "```\n", "![[new.png]]\n", "[label](target.md)", ""];
    for (let step = 0; step < 120; step++) {
      const at = random(source.length + 1);
      source = source.slice(0, at) + inserts[random(inserts.length)] + source.slice(at + random(4));
      expect(markdownReferences(source)).toEqual(markdownReferences(source, markdownLanguage.parser.parse(source)));
    }
  });

  it("walks a note's text once for every reader of it", () => {
    const source = "Intro ![[Plan]] and [link](a.md).";
    const first = markdownReferences(source);
    expect(markdownReferences(source)).toBe(first);
    const edited = `${source} ![[More]]`;
    expect(markdownReferences(edited)).not.toBe(first);
    expect(markdownReferences(edited).map((reference) => reference.target)).toEqual(["Plan", "a.md", "More"]);
  });
});
