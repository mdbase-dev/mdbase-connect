import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NoteList } from "./NoteList";
import type { NoteSummary } from "./model";
import { buildNoteSearchIndex, searchNoteResults } from "./note-search";

// Supply a deterministic viewport, independent of jsdom layout measurements.
const viewport = vi.hoisted(() => ({ start: 0 }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 76,
    getVirtualItems: () => Array.from({ length: 20 }, (_, offset) => ({
      index: viewport.start + offset, start: (viewport.start + offset) * 76, size: 76
    }))
  })
}));

describe("NoteList search presentation", () => {
  it("accesses contexts only for virtual rows while retaining the full count", () => {
    viewport.start = 0;
    const notes: NoteSummary[] = Array.from({ length: 10_000 }, (_, i) => ({
      path: `Notes/${String(i).padStart(4, "0")}.md`, frontmatter: {},
      effectiveFrontmatter: {}, types: [], body: "needle body",
      file: { path: `Notes/${String(i).padStart(4, "0")}.md`, name: `${i}.md`, folder: "Notes", size: 11, mtime: "" }
    }));
    const index = buildNoteSearchIndex(notes);
    const accessed: string[] = [];
    for (const entry of index) Object.defineProperty(entry, "bodyText", {
      get: () => { accessed.push(entry.note.path); return "needle body"; }
    });
    const results = searchNoteResults(index, "needle");
    const searchContexts = new Map(results.map((result) => [result.note.path, result]));
    const noop = () => {};
    const props = {
      entries: notes.map((note) => ({ kind: "note" as const, path: note.path, note })),
      noteCount: notes.length, fileCount: 0, types: [], statuses: new Map(),
      search: "needle", searchQuery: "needle", searchContexts, sort: "path-asc" as const,
      collectionName: "Test", loading: false, structureLoading: false, filesLoading: false,
      contentIndexing: false, contentLoaded: notes.length,
      onSearch: noop, onSort: noop, onClearScope: noop, onQuickOpen: noop,
      onRetryContent: noop, onRetryFiles: noop, onSelect: noop, onSelectFile: noop,
      onPreview: noop, onDismissPreview: noop, onCreate: noop, onCollections: noop
    };
    const view = render(<NoteList {...props} />);
    expect(screen.getByText(`${(10_000).toLocaleString()} found · relevance`)).toBeInTheDocument();
    // The first virtual row is the folder header.
    expect(screen.getAllByRole("option")).toHaveLength(19);
    expect(accessed).toEqual(notes.slice(0, 19).map((note) => note.path));
    viewport.start = 9001;
    view.rerender(<NoteList {...props} />);
    expect(screen.getAllByRole("option")).toHaveLength(20);
    expect(accessed.slice(19)).toEqual(notes.slice(9000, 9020).map((note) => note.path));
    view.rerender(<NoteList {...props} />);
    expect(accessed).toHaveLength(39);
  });
});
