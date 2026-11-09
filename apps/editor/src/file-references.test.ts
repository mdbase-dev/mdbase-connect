import { describe, expect, it } from "vitest";
import { fileReferences } from "./file-references";
import { linkTargets } from "./test/link-targets";
import type { CollectionFile } from "./model";

const files = [
  file("Photos/cat photo.png", "1", "image"),
  file("Notes/diagram.svg", "2", "image"),
  file("Documents/paper.pdf", "3", "pdf"),
  file("Archive/paper.pdf", "4", "pdf")
];

describe("file references", () => {
  it("parses wiki and Markdown embeds while ignoring code", async () => {
    const source = [
      "![[Photos/cat photo.png|Cat]]",
      "![Diagram](diagram.svg)",
      "`![[Documents/paper.pdf]]`",
      "```md",
      "![[Documents/paper.pdf]]",
      "```"
    ].join("\n");
    const targets = linkTargets("Notes/today.md", {
      "![[Photos/cat photo.png|Cat]]": { kind: "file", path: "Photos/cat photo.png" },
      "![Diagram](diagram.svg)": { kind: "file", path: "Notes/diagram.svg" }
    });
    expect(fileReferences(source, files, targets).map(({ raw }) => raw)).toEqual([
      "![[Photos/cat photo.png|Cat]]",
      "![Diagram](diagram.svg)"
    ]);
    await targets.resolveAll(fileReferences(source, files, targets).map(({ raw }) => raw));
    const references = fileReferences(source, files, targets);
    expect(references.map(({ target, label, format, block, file }) => ({ target, label, format, block, path: file?.path }))).toEqual([
      { target: "Photos/cat photo.png", label: "Cat", format: "wikilink", block: true, path: "Photos/cat photo.png" },
      { target: "diagram.svg", label: "Diagram", format: "markdown", block: true, path: "Notes/diagram.svg" }
    ]);
  });

  it("attaches only files the collection resolves the embed to", async () => {
    const source = "![[paper.pdf]]\n\n![[Target]]\n\n![[gone.png]]";
    const targets = linkTargets("Notes/today.md", {
      "![[paper.pdf]]": { kind: "ambiguous", candidates: ["Archive/paper.pdf", "Documents/paper.pdf"] },
      "![[Target]]": { kind: "note", path: "Target.md" }
    });
    await targets.resolveAll(fileReferences(source, files, targets).map(({ raw }) => raw));
    expect(fileReferences(source, files, targets).map(({ file }) => file)).toEqual([undefined, undefined, undefined]);
  });
});

function file(path: string, id: string, mediaClass: CollectionFile["mediaClass"]): CollectionFile {
  return {
    fileId: `00000000-0000-4000-8000-${id.padStart(12, "0")}`,
    path,
    revision: `r${id}`,
    contentDigest: `sha256:${id.padStart(64, "0")}`,
    size: 10,
    mediaClass: mediaClass,
    modifiedAt: "2026-08-07T00:00:00Z"
  };
}
