import { act, render, renderHook, screen, waitFor } from "./test/locale";
import type { CollectionTypeDescriptor } from "@mdbase-dev/connect";
import { describe, expect, it, vi } from "vitest";
import type { CollectionGateway, NoteSummary } from "./model";
import { NotePeekBody, notePreviewExcerpt, previewProperties, useNotePreview } from "./NotePreview";

describe("note previews", () => {
  it("reports a failed peek read and accepts subsequently indexed content", async () => {
    const gateway = { read: vi.fn().mockRejectedValue(new Error("Unavailable")) } as unknown as CollectionGateway;
    const view = render(<NotePeekBody path="note.md" title="Note" gateway={gateway} />);
    await screen.findByText("Preview unavailable.");
    expect(gateway.read).toHaveBeenCalledOnce();
    view.rerender(<NotePeekBody path="note.md" title="Note" source="Indexed [[Other|content]]" gateway={gateway} />);
    expect(screen.queryByText("Preview unavailable.")).not.toBeInTheDocument();
    expect(screen.getByRole("region")).toHaveTextContent("Indexed content");
  });
  it("sizes the peek to a failed read after an empty note", async () => {
    const gateway = { read: vi.fn().mockRejectedValue(new Error("Unavailable")) } as unknown as CollectionGateway;
    const view = render(<NotePeekBody path="empty.md" title="Empty" source="" gateway={gateway} />);
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: 40 } as DOMRect);
    view.rerender(<NotePeekBody path="missing.md" title="Missing" gateway={gateway} />);
    const message = await screen.findByText("Preview unavailable.");
    await waitFor(() => expect(message.closest<HTMLElement>(".note-peek-pages")?.style.height).toBe("40px"));
    rect.mockRestore();
  });

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
      effectiveFrontmatter: { title: "Ada" },
      types: ["person"],
      file: { path: "Notes/Ada.md" }
    } as NoteSummary;
    const { result } = renderHook(() => useNotePreview({} as CollectionGateway, [note], [personType]));

    act(() => result.current.request(
      note.path,
      { left: 1, right: 2, top: 3, bottom: 4 },
      "editor"
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
