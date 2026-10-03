import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NoteList } from "./NoteList";
import type { NoteSummary } from "./model";
import { buildNoteSearchIndex, searchNoteResults } from "./note-search";

// Supply a deterministic viewport, independent of jsdom layout measurements.
const viewport = vi.hoisted(() => ({ start: 0, scrollToIndex: vi.fn() }));
beforeEach(() => { viewport.start = 0; viewport.scrollToIndex.mockClear(); });
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 76,
    scrollToIndex: viewport.scrollToIndex,
    getVirtualItems: () => Array.from({ length: Math.min(20, count - viewport.start) }, (_, offset) => ({
      index: viewport.start + offset, start: (viewport.start + offset) * 76, size: 76
    }))
  })
}));

describe("NoteList search presentation", () => {
  it("retains timestamps through a save and does not scroll on a save-driven reorder", () => {
    const first: NoteSummary = { path: "Notes/one.md", frontmatter: {}, effectiveFrontmatter: {}, types: [], body: "One", file: { mtime: "2026-01-01T12:00:00Z" } };
    const second = { ...first, path: "Notes/two.md" };
    const notes = [first, second];
    const noop = () => {};
    const props = {
      entries: notes.map((note) => ({ kind: "note" as const, path: note.path, note })),
      noteCount: 2, fileCount: 0, types: [], selectedPath: first.path, statuses: new Map(),
      search: "", searchQuery: "", searchContexts: new Map(), sort: "modified-desc" as const,
      collectionName: "Test", loading: false, structureLoading: false, filesLoading: false,
      contentIndexing: false, contentLoaded: 2,
      onSearch: noop, onSort: noop, onClearScope: noop, onQuickOpen: noop,
      onRetryStructure: noop, onRetryContent: noop, onRetryFiles: noop, onSelect: noop,
      onSelectFile: noop, onPreview: noop, onDismissPreview: noop, onCollections: noop
    };
    const view = render(<NoteList {...props} />);
    const row = screen.getAllByRole("option")[0];
    const timestamp = row.querySelector("time")!.textContent;
    expect(viewport.scrollToIndex).toHaveBeenCalledOnce();
    view.rerender(<NoteList {...props} statuses={new Map([[first.path, { tone: "busy", busy: true }]])} />);
    expect(row.querySelector("time")).toHaveTextContent(timestamp!);
    expect(row).toHaveAttribute("aria-busy", "true");
    const saved = { ...first, file: { ...first.file, mtime: "2026-01-02T12:00:00Z" } };
    view.rerender(<NoteList {...props} entries={[{ kind: "note", path: first.path, note: saved }, props.entries[1]]} />);
    expect(row.querySelector("time")!.textContent).not.toBe(timestamp);
    expect(row).not.toHaveAttribute("aria-busy");
    const updated = { ...second, file: { ...second.file, mtime: "2026-02-02T12:00:00Z" } };
    view.rerender(<NoteList {...props} entries={[{ kind: "note", path: second.path, note: updated }, props.entries[0]]} />);
    expect(viewport.scrollToIndex).toHaveBeenCalledOnce();
    view.rerender(<NoteList {...props} selectedPath={second.path} />);
    expect(viewport.scrollToIndex).toHaveBeenCalledTimes(2);
  });
  it("keeps partial-load failures visible and retryable instead of claiming complete results", () => {
    const retry = vi.fn();
    const noop = () => {};
    const props = {
      entries: [], noteCount: 400, fileCount: 0, types: [], statuses: new Map(),
      search: "", searchQuery: "", searchContexts: new Map(), sort: "path-asc" as const,
      collectionName: "Test", loading: false, structureLoading: false, filesLoading: false,
      structureError: "Third page unavailable", contentIndexing: false, contentLoaded: 0,
      onSearch: noop, onSort: noop, onClearScope: noop, onQuickOpen: noop,
      onRetryStructure: retry, onRetryContent: noop, onRetryFiles: noop, onSelect: noop,
      onSelectFile: noop, onCollections: noop, onCreate: noop
    };
    const view = render(<NoteList {...props} />);
    expect(screen.getByText("400 notes loaded · incomplete")).toBeInTheDocument();
    expect(screen.queryByText("This collection is empty.")).not.toBeInTheDocument();
    expect(screen.queryByText("Create the first note")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry notes" }));
    expect(retry).toHaveBeenCalledOnce();
    view.rerender(<NoteList {...props} search="needle" searchQuery="needle" noteCount={0} />);
    expect(screen.getByText("0 found so far · incomplete")).toBeInTheDocument();
    expect(screen.queryByText("No notes or files found.")).not.toBeInTheDocument();
    view.rerender(<NoteList {...props} search="needle" searchQuery="needle" noteCount={0}
      structureError={undefined} contentError="Body download failed" />);
    expect(screen.getByText("0 found so far · incomplete")).toBeInTheDocument();
    expect(screen.getByText("Search is incomplete.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry search" })).toBeInTheDocument();
    view.rerender(<NoteList {...props} structureError={undefined} />);
    expect(screen.queryByRole("button", { name: "Retry notes" })).not.toBeInTheDocument();
    expect(screen.queryByText(/incomplete/)).not.toBeInTheDocument();
  });

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
      onRetryStructure: noop, onRetryContent: noop, onRetryFiles: noop, onSelect: noop, onSelectFile: noop,
      onCreate: noop, onCollections: noop
    };
    const view = render(<NoteList {...props} />);
    expect(screen.getByText(`${(10_000).toLocaleString()} found · relevance`)).toBeInTheDocument();
    // Relevance results are ungrouped, so every virtual row is a result.
    expect(screen.getAllByRole("option")).toHaveLength(20);
    expect(accessed).toEqual(notes.slice(0, 20).map((note) => note.path));
    viewport.start = 9001;
    view.rerender(<NoteList {...props} />);
    expect(screen.getAllByRole("option")).toHaveLength(20);
    expect(accessed.slice(20)).toEqual(notes.slice(9001, 9021).map((note) => note.path));
    view.rerender(<NoteList {...props} />);
    expect(accessed).toHaveLength(40);
  });
});
