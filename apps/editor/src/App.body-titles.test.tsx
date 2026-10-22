import { render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { App } from "./App";
import { DemoCollectionGateway } from "./demo-gateway";
import type { NoteContentRequest, NoteIndexRequest, NoteSummary } from "./model";

vi.mock("./CodeEditor", () => ({
  CodeEditor: ({ value, label }: { value: string; label: string }) =>
    <textarea aria-label={label} value={value} readOnly />
}));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 76,
    getVirtualItems: () => Array.from({ length: Math.min(count, 20) }, (_, index) =>
      ({ index, start: index * 76, size: 76 }))
  })
}));

it("loads readable names for metadata-only UUID rows without opening them or saving a title", async () => {
  const path = "annotations/ann_45007168-741e-4bf3-abfd-5b2a831c15af.md";
  const body = "> A recognisable passage.\n\nA separate comment.\n";
  class MetadataGateway extends DemoCollectionGateway {
    sourcePath = "";
    summary(note: NoteSummary): NoteSummary {
      return note.path === this.sourcePath
        ? { ...note, path, types: [], frontmatter: {}, effectiveFrontmatter: {}, file: { ...note.file, path } }
        : note;
    }
    async list(options: NoteIndexRequest = {}) {
      const result = await super.list({ signal: options.signal });
      this.sourcePath = result.notes[1]!.path;
      return { ...result, notes: result.notes.map(note => ({ ...this.summary(note), body: undefined })) };
    }
    async hydrateContent(options: NoteContentRequest = {}) {
      const result = await super.hydrateContent({ signal: options.signal });
      return { ...result, notes: result.notes.map(note => ({ ...this.summary(note),
        body: note.path === this.sourcePath ? body : note.body })) };
    }
  }
  const gateway = new MetadataGateway(2);
  const hydrate = vi.spyOn(gateway, "hydrateContent");
  const read = vi.spyOn(gateway, "read");
  const update = vi.spyOn(gateway, "update");
  const updateProperties = vi.spyOn(gateway, "updateProperties");
  const { unmount } = render(<App gateway={gateway} />);
  try {
    expect(await screen.findByRole("option", { name: /A recognisable passage\./ })).toBeInTheDocument();
    await waitFor(() => expect(hydrate).toHaveBeenCalledOnce());
    expect(read.mock.calls.some(([requestedPath]) => requestedPath === path)).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect(updateProperties).not.toHaveBeenCalled();
  } finally { unmount(); }
});
