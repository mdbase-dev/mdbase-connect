import { fireEvent, render, screen } from "./test/locale";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NoteList } from "./NoteList";
import type { NoteSummary } from "./model";
import { defaultNoteSort } from "./note-sort";
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
  it("draws a declared type icon in the type chip and none for notes without a type", async () => {
    const task: NoteSummary = { path: "tasks/write.md", frontmatter: {}, effectiveFrontmatter: {}, types: ["task"], body: "", file: {} };
    const plain: NoteSummary = { path: "notes/plain.md", frontmatter: {}, effectiveFrontmatter: {}, types: [], body: "", file: {} };
    const noop = () => {};
    render(<NoteList
      entries={[task, plain].map((note) => ({ kind: "note" as const, path: note.path, note }))}
      noteCount={2} fileCount={0} statuses={new Map()}
      types={[{ name: "task", schema: {}, extensions: {}, collection: { display: { icon: "check-circle" } } }]}
      search="" searchQuery="" searchContexts={new Map()} sort={defaultNoteSort} sortFields={[]}
      collectionName="Test" loading={false} structureLoading={false} filesLoading={false}
      searchPending={false}
      onSearch={noop} onSort={noop} onClearScope={noop}
      onRetryStructure={noop} onRetrySearch={noop} onRetryContent={noop} onRetryFiles={noop} onSelect={noop}
      onSelectFile={noop} onCollections={noop}
    />);
    const [taskRow, plainRow] = screen.getAllByRole("option");
    expect(await vi.waitFor(() => taskRow.querySelector(".note-type-badge .note-type-icon .ph-check-circle") ?? Promise.reject(new Error("icon pending")))).toBeTruthy();
    expect(plainRow.querySelector(".note-type-icon, .note-type-badge")).toBeNull();
  });

  it("keeps undated rows aligned, names empty notes and types readably, and offers title-only rows", () => {
    const undated: NoteSummary = { path: "Views/archive.md", frontmatter: {}, effectiveFrontmatter: {}, types: ["obsidian_base"], body: "", file: {} };
    const unloaded: NoteSummary = { path: "Views/later.md", frontmatter: {}, effectiveFrontmatter: {}, types: [], file: { mtime: "2026-01-01T12:00:00Z" } };
    const notes = [undated, unloaded];
    const noop = () => {};
    const onCompact = vi.fn();
    const props = {
      entries: notes.map((note) => ({ kind: "note" as const, path: note.path, note })),
      noteCount: notes.length, fileCount: 0, types: [], statuses: new Map(),
      search: "", searchQuery: "", searchContexts: new Map(), sort: defaultNoteSort, sortFields: [],
      collectionName: "Test", loading: false, structureLoading: false, filesLoading: false,
      searchPending: false,
      onSearch: noop, onSort: noop, onClearScope: noop,
      onRetryStructure: noop, onRetrySearch: noop, onRetryContent: noop, onRetryFiles: noop, onSelect: noop,
      onSelectFile: noop, onCollections: noop, onCompact
    };
    const view = render(<NoteList {...props} />);
    const [archive, later] = screen.getAllByRole("option");
    expect(archive.querySelector("time")).toBeNull();
    expect(archive).toHaveTextContent("No additional text");
    expect(archive.querySelector(".note-type-badge")).toHaveTextContent("Obsidian base");
    expect(archive.querySelector(".note-type-badge")).toHaveAttribute("title", "Type: obsidian_base");
    // A body still loading renders a quiet fixed-height placeholder rather than claiming empty text.
    expect(later).not.toHaveTextContent("No additional text");
    expect(later.querySelector(".note-excerpt-placeholder")).toHaveAttribute("aria-hidden", "true");
    expect(archive.querySelector(".note-excerpt-placeholder")).toBeNull();

    // Once the body arrives, the placeholder becomes the real excerpt inside the same detail slot.
    const loaded: NoteSummary = { ...unloaded, body: "# later\n\nOpening paragraph here." };
    view.rerender(<NoteList {...props} entries={[undated, loaded].map((note) => ({ kind: "note" as const, path: note.path, note }))} />);
    const loadedRow = screen.getAllByRole("option")[1];
    expect(loadedRow.querySelector(".note-excerpt-placeholder")).toBeNull();
    expect(loadedRow.querySelector(".note-excerpt")).toHaveTextContent("Opening paragraph here.");

    fireEvent.click(screen.getByRole("button", { name: "View options" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Compact" }));
    expect(onCompact).toHaveBeenCalledWith(true);

    view.rerender(<NoteList {...props} compact />);
    const compactRow = screen.getAllByRole("option")[0];
    expect(compactRow).toHaveTextContent(/^archive$/);
    expect(compactRow.querySelector(".note-detail, .note-excerpt, .note-type-badge")).toBeNull();
  });

  it("reveals the open note again on search return even when its identity has not changed", () => {
    const notes = Array.from({ length: 40 }, (_, index): NoteSummary => ({ path: `Notes/${index}.md`, frontmatter: {}, effectiveFrontmatter: {}, types: [], body: "", file: { mtime: "2026-01-01T12:00:00Z" } }));
    const noop = () => {};
    const onSelection = vi.fn();
    const props = {
      entries: notes.map((note) => ({ kind: "note" as const, path: note.path, note })),
      noteCount: notes.length, fileCount: 0, types: [], selectedPath: notes[35].path, statuses: new Map(),
      search: "", searchQuery: "", searchContexts: new Map(), sort: defaultNoteSort, sortFields: [],
      collectionName: "Test", loading: false, structureLoading: false, filesLoading: false,
      searchPending: false,
      onSearch: noop, onSort: noop, onClearScope: noop,
      onRetryStructure: noop, onRetrySearch: noop, onRetryContent: noop, onRetryFiles: noop, onSelect: vi.fn(),
      onSelection, onSelectFile: noop, onCollections: noop
    };
    const view = render(<NoteList {...props} />);
    viewport.scrollToIndex.mockClear();
    const input = screen.getByRole("combobox", { name: "Search notes and files" });
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onSelection).toHaveBeenLastCalledWith({ paths: [notes[35].path], anchor: notes[35].path, focus: notes[35].path });
    expect(viewport.scrollToIndex).toHaveBeenCalledWith(36, { align: "auto" });
    expect(screen.getByRole("listbox")).toHaveFocus();
    expect(props.onSelect).not.toHaveBeenCalled();
    view.rerender(<NoteList {...props} entries={[props.entries[35]]} searchQuery="garden" />);
    fireEvent.keyDown(input, { key: "Escape" });
    viewport.scrollToIndex.mockClear();
    view.rerender(<NoteList {...props} />);
    expect(viewport.scrollToIndex).toHaveBeenCalledWith(36, { align: "auto" });
  });

  it("retains timestamps through a save and does not scroll on a save-driven reorder", () => {
    const first: NoteSummary = { path: "Notes/one.md", frontmatter: {}, effectiveFrontmatter: {}, types: [], body: "One", file: { mtime: "2026-01-01T12:00:00Z" } };
    const second = { ...first, path: "Notes/two.md" };
    const notes = [first, second];
    const noop = () => {};
    const peek = vi.fn();
    const props = {
      entries: notes.map((note) => ({ kind: "note" as const, path: note.path, note })),
      noteCount: 2, fileCount: 0, types: [], selectedPath: first.path, statuses: new Map(),
      search: "", searchQuery: "", searchContexts: new Map(), sort: defaultNoteSort, sortFields: [],
      collectionName: "Test", loading: false, structureLoading: false, filesLoading: false,
      searchPending: false,
      onSearch: noop, onSort: noop, onClearScope: noop,
      onRetryStructure: noop, onRetrySearch: noop, onRetryContent: noop, onRetryFiles: noop, onSelect: vi.fn(),
      onSelectFile: noop, onPeek: peek, onCollections: noop
    };
    const view = render(<NoteList {...props} />);
    const list = screen.getByRole("listbox");
    fireEvent.keyDown(list, { key: "j" });
    expect(props.onSelect).toHaveBeenLastCalledWith(second.path, { keyboard: true });
    props.onSelect.mockClear();
    fireEvent.keyDown(list, { key: "j", ctrlKey: true });
    fireEvent.keyDown(list, { key: "j", altKey: true });
    fireEvent.keyDown(list, { key: "j", shiftKey: true });
    fireEvent.keyDown(list, { key: "j", isComposing: true });
    expect(props.onSelect).not.toHaveBeenCalled();
    view.rerender(<NoteList {...props} selectedPath={second.path} />);
    fireEvent.keyDown(list, { key: "k" });
    expect(props.onSelect).toHaveBeenLastCalledWith(first.path, { keyboard: true });
    viewport.scrollToIndex.mockClear();
    view.rerender(<NoteList {...props} />);
    fireEvent.keyDown(screen.getByRole("listbox"), { key: " " });
    expect(peek).toHaveBeenCalledWith(first.path);
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
  it("steps over attachments while a peek is open", () => {
    const note = (path: string): NoteSummary => ({ path, frontmatter: {}, effectiveFrontmatter: {}, types: [], body: "", file: { mtime: "2026-01-01T12:00:00Z" } });
    const first = note("Notes/one.md");
    const second = note("Notes/two.md");
    const noop = () => {};
    const props = {
      entries: [
        { kind: "note" as const, path: first.path, note: first },
        { kind: "file" as const, path: "Files/paper.pdf", file: { path: "Files/paper.pdf", name: "paper.pdf", folder: "Files", size: 1, mtime: "", mediaType: "application/pdf", mediaClass: "pdf" } },
        { kind: "note" as const, path: second.path, note: second }
      ] as never,
      noteCount: 2, fileCount: 1, types: [], selectedPath: first.path, statuses: new Map(),
      search: "", searchQuery: "", searchContexts: new Map(), sort: defaultNoteSort, sortFields: [],
      collectionName: "Test", loading: false, structureLoading: false, filesLoading: false,
      searchPending: false,
      onSearch: noop, onSort: noop, onClearScope: noop,
      onRetryStructure: noop, onRetrySearch: noop, onRetryContent: noop, onRetryFiles: noop, onSelect: vi.fn(),
      onSelectFile: vi.fn(), onCollections: noop
    };
    render(<NoteList {...props} peek={<p>Peek</p>} peekTitle="One" />);
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "j" });
    expect(props.onSelect).toHaveBeenLastCalledWith(second.path, { keyboard: true });
    expect(props.onSelectFile).not.toHaveBeenCalled();
  });

  it("lists notes that are not saved yet above the collection's notes, and offers a type for a new one", () => {
    const note: NoteSummary = { path: "Notes/one.md", frontmatter: {}, effectiveFrontmatter: {}, types: [], body: "", file: { mtime: "2026-01-01T12:00:00Z" } };
    const noop = () => {};
    const openDraft = vi.fn(), create = vi.fn(), createOfType = vi.fn();
    const list = (drafts: Array<{ id: string; title: string; selected: boolean; status: string }>) => <NoteList
      entries={[{ kind: "note" as const, path: note.path, note }] as never}
      noteCount={1} fileCount={0} types={[]} selectedPath={undefined} statuses={new Map()}
      search="" searchQuery="" searchContexts={new Map()} sort={defaultNoteSort} sortFields={[]}
      collectionName="Test" loading={false} structureLoading={false} filesLoading={false}
      searchPending={false}
      onSearch={noop} onSort={noop} onClearScope={noop}
      onRetryStructure={noop} onRetrySearch={noop} onRetryContent={noop} onRetryFiles={noop} onSelect={noop}
      onSelectFile={noop} onCollections={noop}
      drafts={drafts} onOpenDraft={openDraft} onCreate={create} onCreateOfType={createOfType}
    />;
    const view = render(list([
      { id: "a", title: "", selected: true, status: "Not saved yet" },
      { id: "b", title: "Planning", selected: false, status: "Needs attention" }
    ]));
    const drafts = screen.getByRole("group", { name: "Notes not saved yet" });
    const [untitled, planning] = Array.from(drafts.querySelectorAll("button"));
    expect(untitled).toHaveTextContent("Untitled");
    expect(untitled).toHaveTextContent("Not saved yet");
    expect(untitled).toHaveAttribute("aria-current", "true");
    expect(planning).toHaveTextContent("Planning");
    expect(planning).toHaveTextContent("Needs attention");
    expect(planning).not.toHaveAttribute("aria-current");
    fireEvent.click(planning);
    expect(openDraft).toHaveBeenCalledWith("b");

    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    fireEvent.click(screen.getByRole("button", { name: "New note of type…" }));
    expect(create).toHaveBeenCalledOnce();
    expect(createOfType).toHaveBeenCalledOnce();

    view.rerender(list([]));
    expect(screen.queryByRole("group", { name: "Notes not saved yet" })).not.toBeInTheDocument();
  });

  it("names note and file entries by the text they show", () => {
    const note: NoteSummary = { path: "Notes/one.md", frontmatter: {}, effectiveFrontmatter: {}, types: [], body: "", file: { mtime: "2026-01-01T12:00:00Z" } };
    const noop = () => {};
    render(<NoteList
      entries={[
        { kind: "note" as const, path: note.path, note },
        { kind: "file" as const, path: "Files/paper.pdf", file: { path: "Files/paper.pdf", name: "paper.pdf", folder: "Files", size: 1, mtime: "", mediaType: "application/pdf", mediaClass: "pdf" } }
      ] as never}
      noteCount={1} fileCount={1} types={[]} selectedPath={note.path} statuses={new Map()}
      search="" searchQuery="" searchContexts={new Map()} sort={defaultNoteSort} sortFields={[]}
      collectionName="Test" loading={false} structureLoading={false} filesLoading={false}
      searchPending={false}
      onSearch={noop} onSort={noop} onClearScope={noop}
      onRetryStructure={noop} onRetrySearch={noop} onRetryContent={noop} onRetryFiles={noop} onSelect={noop}
      onSelectFile={noop} onCollections={noop}
    />);
    // WCAG 2.5.3 Label in Name: each entry's accessible name contains its visible text.
    const visibleText = (node: Node): string => node.nodeType === Node.TEXT_NODE ? node.textContent ?? ""
      : node instanceof Element && node.getAttribute("aria-hidden") === "true" ? "" : [...node.childNodes].map(visibleText).join("");
    const options = screen.getAllByRole("option");
    expect(options.map(visibleText)).toEqual([expect.stringMatching(/^one/), expect.stringMatching(/^paper\.pdf/)]);
    for (const option of options) {
      expect(option).toHaveAccessibleName(new RegExp(visibleText(option).replace(/\s+/g, " ").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("keeps partial-load failures visible and retryable instead of claiming complete results", () => {
    const retry = vi.fn();
    const noop = () => {};
    const props = {
      entries: [], noteCount: 400, fileCount: 0, types: [], statuses: new Map(),
      search: "", searchQuery: "", searchContexts: new Map(), sort: { key: "path", direction: "asc" } as const, sortFields: [],
      collectionName: "Test", loading: false, structureLoading: false, filesLoading: false,
      structureError: "Third page unavailable", searchPending: false,
      onSearch: noop, onSort: noop, onClearScope: noop,
      onRetryStructure: retry, onRetrySearch: vi.fn(), onRetryContent: vi.fn(), onRetryFiles: noop, onSelect: noop,
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
      structureError={undefined} searchError="Search unavailable" />);
    expect(screen.getByText("0 found so far · incomplete")).toBeInTheDocument();
    expect(screen.getByText("Search is incomplete.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry search" }));
    expect(props.onRetrySearch).toHaveBeenCalledOnce();
    view.rerender(<NoteList {...props} search="needle" searchQuery="needle" noteCount={0} structureError={undefined} searchPending />);
    expect(screen.getAllByText("Searching")).toHaveLength(2);
    expect(screen.queryByText("No notes or files found.")).not.toBeInTheDocument();
    // A failed load of note text (for titles taken from it) is not a search failure.
    view.rerender(<NoteList {...props} structureError={undefined} contentError="Body download failed" />);
    expect(screen.queryByText(/incomplete/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry notes" }));
    expect(props.onRetryContent).toHaveBeenCalledOnce();
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
      search: "needle", searchQuery: "needle", searchContexts, sort: { key: "path", direction: "asc" } as const, sortFields: [],
      collectionName: "Test", loading: false, structureLoading: false, filesLoading: false,
      searchPending: false,
      onSearch: noop, onSort: noop, onClearScope: noop,
      onRetryStructure: noop, onRetrySearch: noop, onRetryContent: noop, onRetryFiles: noop, onSelect: noop, onSelectFile: noop,
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

describe("NoteList touch selection", () => {
  it("starts selecting from a held note, then taps add and remove notes without opening them", () => {
    const notes = ["Notes/one.md", "Notes/two.md"].map((path): NoteSummary => ({ path, frontmatter: {}, effectiveFrontmatter: {}, types: [], body: "", file: { mtime: "2026-01-01T12:00:00Z" } }));
    const noop = () => {};
    const coarse = vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ matches: query === "(pointer: coarse)", media: query, addEventListener: noop, removeEventListener: noop } as unknown as MediaQueryList));
    const props = {
      entries: notes.map((note) => ({ kind: "note" as const, path: note.path, note })),
      noteCount: 2, fileCount: 0, types: [], selectedPath: undefined, statuses: new Map(),
      search: "", searchQuery: "", searchContexts: new Map(), sort: defaultNoteSort, sortFields: [],
      collectionName: "Test", loading: false, structureLoading: false, filesLoading: false,
      searchPending: false,
      onSearch: noop, onSort: noop, onClearScope: noop,
      onRetryStructure: noop, onRetrySearch: noop, onRetryContent: noop, onRetryFiles: noop, onSelect: vi.fn(),
      onSelection: vi.fn(), onStartSelecting: vi.fn(), onSelectFile: noop, onCollections: noop,
      noteActions: () => []
    };
    const view = render(<NoteList {...props} />);
    fireEvent.contextMenu(screen.getAllByRole("option")[0]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Select" }));
    expect(props.onSelection).toHaveBeenLastCalledWith({ paths: ["Notes/one.md"], anchor: "Notes/one.md", focus: "Notes/one.md" });
    expect(props.onStartSelecting).toHaveBeenCalledOnce();

    view.rerender(<NoteList {...props} selecting selection={{ paths: ["Notes/one.md"], anchor: "Notes/one.md", focus: "Notes/one.md" }} />);
    fireEvent.click(screen.getAllByRole("option")[1]);
    expect(props.onSelection).toHaveBeenLastCalledWith({ paths: ["Notes/one.md", "Notes/two.md"], anchor: "Notes/one.md", focus: "Notes/two.md" });
    fireEvent.click(screen.getAllByRole("option")[0]);
    expect(props.onSelection).toHaveBeenLastCalledWith({ paths: [], anchor: "Notes/one.md", focus: "Notes/one.md" });
    expect(props.onSelect).not.toHaveBeenCalled();
    coarse.mockRestore();
  });

  it("opens in a new tab on Ctrl/Cmd-click when single-selected, and toggles when multi-selecting", () => {
    const notes = ["Notes/one.md", "Notes/two.md", "Notes/three.md"].map((path): NoteSummary => ({ path, frontmatter: {}, effectiveFrontmatter: {}, types: [], body: "", file: { mtime: "2026-01-01T12:00:00Z" } }));
    const noop = () => {};
    const onOpenInNewTab = vi.fn();
    const onSelection = vi.fn();
    const onSelect = vi.fn();
    const props = {
      entries: notes.map((note) => ({ kind: "note" as const, path: note.path, note })),
      noteCount: 3, fileCount: 0, types: [], selectedPath: notes[0].path, statuses: new Map(),
      search: "", searchQuery: "", searchContexts: new Map(), sort: defaultNoteSort, sortFields: [],
      collectionName: "Test", loading: false, structureLoading: false, filesLoading: false,
      searchPending: false,
      onSearch: noop, onSort: noop, onClearScope: noop,
      onRetryStructure: noop, onRetrySearch: noop, onRetryContent: noop, onRetryFiles: noop,
      onSelect, onSelection, onOpenInNewTab, onSelectFile: noop, onCollections: noop
    };
    const view = render(<NoteList {...props} />);
    fireEvent.click(screen.getAllByRole("option")[1], { ctrlKey: true });
    expect(onOpenInNewTab).toHaveBeenLastCalledWith("Notes/two.md");
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole("option")[2], { metaKey: true });
    expect(onOpenInNewTab).toHaveBeenLastCalledWith("Notes/three.md");
    expect(onOpenInNewTab).toHaveBeenCalledTimes(2);

    // Once multiple notes are selected, Ctrl/Cmd-click toggles items in the selection instead.
    view.rerender(<NoteList {...props} selection={{ paths: ["Notes/one.md", "Notes/two.md"], anchor: "Notes/one.md", focus: "Notes/two.md" }} />);
    fireEvent.click(screen.getAllByRole("option")[2], { ctrlKey: true });
    expect(onOpenInNewTab).toHaveBeenCalledTimes(2);
    expect(onSelection).toHaveBeenLastCalledWith({ paths: ["Notes/one.md", "Notes/two.md", "Notes/three.md"], anchor: "Notes/one.md", focus: "Notes/three.md" });
  });
});

describe("NoteList direct file upload and drag-and-drop", () => {
  it("exposes Upload files in the New menu, empty state, and accepts dropped files", () => {
    const noop = () => {};
    const onCreate = vi.fn();
    const onCreateOfType = vi.fn();
    const onUploadFiles = vi.fn();
    const onDropFiles = vi.fn();
    render(<NoteList
      entries={[]}
      noteCount={0} fileCount={0} types={[]} statuses={new Map()}
      search="" searchQuery="" searchContexts={new Map()} sort={defaultNoteSort} sortFields={[]}
      collectionName="All notes" loading={false} structureLoading={false} filesLoading={false}
      searchPending={false}
      onSearch={noop} onSort={noop} onClearScope={noop}
      onRetryStructure={noop} onRetrySearch={noop} onRetryContent={noop} onRetryFiles={noop}
      onSelect={noop} onSelectFile={noop} onCollections={noop}
      onCreate={onCreate} onCreateOfType={onCreateOfType}
      onUploadFiles={onUploadFiles} onDropFiles={onDropFiles}
    />);

    // Empty state offers both Create the first note and Upload files.
    fireEvent.click(screen.getByRole("button", { name: "Upload files" }));
    expect(onUploadFiles).toHaveBeenCalledTimes(1);

    // New menu offers both New note of type… and Upload files….
    fireEvent.click(screen.getByRole("button", { name: "New menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Upload files…" }));
    expect(onUploadFiles).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "New menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New note of type…" }));
    expect(onCreateOfType).toHaveBeenCalledTimes(1);

    // Drag-and-drop external files onto the list uploads them directly.
    const list = screen.getByRole("listbox", { name: "Collection notes and files" });
    const file = new File(["hello"], "report.pdf", { type: "application/pdf" });
    const dataTransfer = { types: ["Files"], files: [file], dropEffect: "none" };
    fireEvent.dragOver(list, { dataTransfer });
    expect(list).toHaveClass("is-file-drag-over");
    fireEvent.drop(list, { dataTransfer });
    expect(onDropFiles).toHaveBeenCalledWith([file]);
    expect(list).not.toHaveClass("is-file-drag-over");

    // Internal note drags are ignored by the external file drop zone.
    onDropFiles.mockClear();
    const internal = { types: ["Files", "application/x-mdbase-note-paths"], files: [file], dropEffect: "none" };
    fireEvent.dragOver(list, { dataTransfer: internal });
    expect(list).not.toHaveClass("is-file-drag-over");
    fireEvent.drop(list, { dataTransfer: internal });
    expect(onDropFiles).not.toHaveBeenCalled();
  });
});
