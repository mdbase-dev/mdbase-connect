import { describe, expect, it } from "vitest";
import { fileReferences, resolveFileReference } from "./file-references";
import type { CollectionFile } from "./model";

const files = [
  file("Photos/cat photo.png", "1", "image"),
  file("Notes/diagram.svg", "2", "image"),
  file("Documents/paper.pdf", "3", "pdf"),
  file("Archive/paper.pdf", "4", "pdf")
];

describe("file references", () => {
  it("parses wiki and Markdown embeds while ignoring code", () => {
    const source = [
      "![[Photos/cat photo.png|Cat]]",
      "![Diagram](diagram.svg)",
      "`![[Documents/paper.pdf]]`",
      "```md",
      "![[Documents/paper.pdf]]",
      "```"
    ].join("\n");
    const references = fileReferences(source, files, "Notes/today.md");
    expect(references.map(({ target, label, format, block, file }) => ({ target, label, format, block, path: file?.path }))).toEqual([
      { target: "Photos/cat photo.png", label: "Cat", format: "wikilink", block: true, path: "Photos/cat photo.png" },
      { target: "diagram.svg", label: "Diagram", format: "markdown", block: true, path: "Notes/diagram.svg" }
    ]);
  });

  it("decodes URLs, rejects traversal, and leaves ambiguous basenames unresolved", () => {
    expect(resolveFileReference("../Photos/cat%20photo.png", "markdown", files, "Notes/today.md")?.path).toBe("Photos/cat photo.png");
    expect(resolveFileReference("../../cat.png", "markdown", files, "Notes/today.md")).toBeUndefined();
    expect(resolveFileReference("paper.pdf", "wikilink", files, "Notes/today.md")).toBeUndefined();
    expect(resolveFileReference("https://example.com/cat.png", "markdown", files, "Notes/today.md")).toBeUndefined();
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
