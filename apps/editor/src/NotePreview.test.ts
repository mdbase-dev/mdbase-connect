import { act, renderHook, waitFor } from "@testing-library/react";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import { describe, expect, it } from "vitest";
import type { CollectionGateway, NoteSummary } from "./model";
import { notePreviewExcerpt, previewProperties, useNotePreview } from "./NotePreview";

describe("note previews", () => {
  it("finds the first useful paragraph and removes Markdown markers", () => {
    expect(notePreviewExcerpt([
      "# Ada Lovelace",
      "",
      "Worked with **Charles Babbage** on the [[Analytical Engine|engine]].",
      "",
      "A later paragraph."
    ].join("\n"), "Ada Lovelace")).toBe(
      "Worked with Charles Babbage on the engine."
    );
  });

  it("ignores fenced code and clips long prose at a word boundary", () => {
    const body = "```ts\nconst hidden = true;\n```\n\n"
      + "A deliberately long preview sentence with enough words to require clipping.";
    expect(notePreviewExcerpt(body, "", 42)).toBe(
      "A deliberately long preview sentence with…"
    );
  });

  it("keeps only compact, useful scalar properties", () => {
    expect(previewProperties({
      title: "A note",
      status: "draft",
      priority: 2,
      published: false,
      aliases: ["Draft"],
      nested: { ignored: true },
      extra: "not shown"
    })).toEqual([
      ["status", "draft"],
      ["priority", "2"],
      ["published", "false"]
    ]);
  });

  it("opens and dismisses a delayed preview intent", async () => {
    const note = {
      path: "Notes/Ada.md",
      body: "A useful preview.",
      frontmatter: {},
      effective_frontmatter: { title: "Ada" },
      types: ["person"],
      file: { path: "Notes/Ada.md" }
    } as NoteSummary;
    const { result } = renderHook(() => useNotePreview({} as CollectionGateway, [note], [personType]));

    act(() => result.current.request(
      note.path,
      { left: 1, right: 2, top: 3, bottom: 4 },
      "sidebar"
    ));
    await waitFor(() => expect(result.current.preview?.path).toBe(note.path), { timeout: 1_000 });
    act(() => result.current.dismiss());
    expect(result.current.preview).toBeUndefined();
  });
});

const personType: CollectionTypeDescriptor = {
  name: "person",
  definition: {},
  collection: { display: { name_field: "title" } },
  schema: { type: "object", properties: { title: { type: "string" } } },
  extensions: {}
};
