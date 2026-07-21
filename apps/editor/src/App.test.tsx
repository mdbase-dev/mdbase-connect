import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CollectionChange, JsonObject } from "@mdbase/connect";
import { App } from "./App";
import { DemoCollectionGateway } from "./demo-gateway";
import type { CollectionGateway, NoteDocument, NoteListProgress, NoteSummary } from "./model";

vi.mock("./CodeEditor", () => ({
  CodeEditor: ({ value, onChange, label }: { value: string; onChange?: (value: string) => void; label: string }) =>
    <textarea aria-label={label} value={value} onChange={(event) => onChange?.(event.target.value)} />
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 76,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 76, size: 76 }))
  })
}));

describe("mdbase editor", () => {
  it("collapses, restores, and resizes both navigation sidebars", async () => {
    const user = userEvent.setup();
    render(<App gateway={new DemoCollectionGateway(12)} />);

    await screen.findByRole("heading", { name: "Writing" });
    const collectionRail = screen.getByRole("complementary", { name: "Collection navigation" });
    expect(within(collectionRail).getByRole("status", { name: "Collection connected" })).toHaveTextContent("Connected");
    expect(within(collectionRail).getByRole("button", { name: "Disconnect collection" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hide collections sidebar" }));
    expect(screen.queryByRole("complementary", { name: "Collection navigation" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show collections sidebar" }));
    expect(screen.getByRole("complementary", { name: "Collection navigation" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Hide notes sidebar" }));
    expect(screen.queryByRole("region", { name: "Notes" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show notes sidebar" }));
    expect(screen.getByRole("region", { name: "Notes" })).toBeInTheDocument();

    const collectionResize = screen.getByRole("separator", { name: "Resize collections sidebar" });
    collectionResize.focus();
    await user.keyboard("{ArrowRight}");
    expect(collectionResize).toHaveAttribute("aria-valuenow", "184");
    expect(JSON.parse(localStorage.getItem("mdbase-editor:layout") ?? "null")).toMatchObject({
      collectionWidth: 184,
      collectionCollapsed: false,
      listCollapsed: false
    });
  });

  it("opens a collection, selects a note, and autosaves body changes", async () => {
    const gateway = new DemoCollectionGateway(12);
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    expect(await screen.findByRole("heading", { name: "Writing" })).toBeInTheDocument();
    const body = await screen.findByRole("textbox", { name: "Note body" });
    await user.type(body, "\nA saved sentence.");
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument(), { timeout: 2_000 });

    const first = (await gateway.list())[0];
    const saved = await gateway.read(first.path);
    expect(saved.body).toContain("A saved sentence.");
  });

  it("refreshes an open note when it changes through the connector", async () => {
    const gateway = new RemoteChangeGateway();
    render(<App gateway={gateway} />);

    expect(await screen.findByRole("textbox", { name: "Note title" })).toHaveValue("The shape of useful tools");
    await gateway.watchStarted;
    await gateway.modifyRemotely();

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Changed on another device"));
    expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue("The remote version is current.\n");
  });

  it("preserves local edits when a remote change arrives", async () => {
    const gateway = new RemoteChangeGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    const body = await screen.findByRole("textbox", { name: "Note body" });
    await gateway.watchStarted;
    await user.type(body, "\nA local sentence.");
    await gateway.modifyRemotely();

    expect(await screen.findByRole("alert")).toHaveTextContent("changed elsewhere");
    expect((body as HTMLTextAreaElement).value).toContain("A local sentence.");
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(gateway.updateCalls).toBe(0);

    await user.click(screen.getByRole("button", { name: "Keep my edits" }));
    await waitFor(() => expect(gateway.updateCalls).toBe(1));
    expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("The shape of useful tools");
    expect((body as HTMLTextAreaElement).value).toContain("A local sentence.");
  });

  it("creates a note and exposes collection-wide navigation", async () => {
    const gateway = new DemoCollectionGateway(4);
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await screen.findByRole("heading", { name: "Writing" });
    await user.click(screen.getByRole("button", { name: "New note" }));
    const title = await screen.findByRole("textbox", { name: "Title" });
    await user.type(title, "A useful note");
    expect(screen.getByRole("textbox", { name: "Path" })).toHaveValue("A useful note.md");
    await user.selectOptions(screen.getByRole("combobox", { name: "Type" }), "note");
    expect(screen.getByRole("textbox", { name: "Path" })).toHaveValue("Notes/A useful note.md");
    await user.click(screen.getByRole("button", { name: "Create note" }));
    expect(await screen.findByDisplayValue("A useful note")).toBeInTheDocument();
    await waitFor(async () => expect((await gateway.list()).length).toBe(5));
    const created = await gateway.read("Notes/A useful note.md");
    expect(created.raw_frontmatter?.title).toBe("A useful note");
    expect(created.body).toBe("");
  });

  it("creates untyped notes at the collection root", async () => {
    const gateway = new DemoCollectionGateway(2);
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await screen.findByRole("heading", { name: "Writing" });
    await user.click(screen.getByRole("button", { name: "New note" }));
    await user.type(await screen.findByRole("textbox", { name: "Title" }), "Root note");
    expect(screen.getByRole("textbox", { name: "Path" })).toHaveValue("Root note.md");
    await user.click(screen.getByRole("button", { name: "Create note" }));

    expect(await screen.findByDisplayValue("Root note")).toBeInTheDocument();
    expect((await gateway.read("Root note.md")).types).toEqual([]);
  });

  it("collapses collection facets, filters notes, and follows backlinks", async () => {
    const user = userEvent.setup();
    render(<App gateway={new DemoCollectionGateway(12)} />);

    await screen.findByRole("heading", { name: "Writing" });
    const folders = screen.getByRole("group", { name: "Folders" });
    const foldersToggle = within(folders).getByRole("button", { name: "Folders" });
    expect(foldersToggle).toHaveAttribute("aria-expanded", "true");
    await user.click(foldersToggle);
    expect(foldersToggle).toHaveAttribute("aria-expanded", "false");
    expect(within(folders).queryByRole("button", { name: /Archive/ })).not.toBeInTheDocument();
    await user.click(foldersToggle);
    await user.click(within(folders).getByRole("button", { name: /Archive/ }));
    expect(screen.getByRole("heading", { name: "Archive" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(2);

    const tags = screen.getByRole("group", { name: "Tags" });
    await user.click(within(tags).getByRole("button", { name: "Tags" }));
    await user.click(within(tags).getByRole("button", { name: /#ideas/ }));
    expect(screen.getByRole("heading", { name: "#ideas" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(4);

    const types = screen.getByRole("group", { name: "Types" });
    await user.click(within(types).getByRole("button", { name: "Types" }));
    await user.click(within(types).getByRole("button", { name: /note/ }));
    expect(screen.getByRole("heading", { name: "note" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);

    const collection = screen.getByRole("complementary", { name: "Collection navigation" });
    await user.click(within(collection).getAllByRole("button", { name: /^Notes/ })[0]);
    await user.click(screen.getByText("The shape of useful tools", { selector: ".note-title" }));
    await user.click(screen.getByRole("button", { name: "Backlinks" }));
    const backlinks = screen.getByRole("complementary", { name: "Backlinks" });
    expect(within(backlinks).getByText("1 note link here")).toBeInTheDocument();
    await user.click(within(backlinks).getByRole("button", { name: /Garden notes 2/ }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2"));
  });

  it("keeps the note frame stable while a note is loading", async () => {
    const gateway = new SlowReadGateway();
    render(<App gateway={gateway} />);

    const loading = await screen.findByLabelText("Loading note");
    expect(loading).toHaveAttribute("aria-busy", "true");
    gateway.releaseRead();
    expect(await screen.findByRole("textbox", { name: "Note title" })).toHaveValue("The shape of useful tools");
    expect(screen.queryByLabelText("Loading note")).not.toBeInTheDocument();
  });

  it("shows the collection-shaped opening state while metadata is loading", async () => {
    const gateway = new SlowDescriptionGateway();
    render(<App gateway={gateway} />);

    const opening = await screen.findByLabelText("Opening collection");
    expect(opening).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Reading its notes and types")).toBeInTheDocument();
    gateway.releaseDescription();
    expect(await screen.findByRole("heading", { name: "Writing" })).toBeInTheDocument();
  });

  it("opens the first note after the first page while the remaining index loads", async () => {
    const gateway = new ProgressiveListGateway(12);
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    expect(await screen.findByRole("textbox", { name: "Note title" })).toHaveValue("The shape of useful tools");
    expect(screen.getByText("1 of 12 notes")).toBeInTheDocument();
    const folderNavigation = screen.getByRole("group", { name: "Folders" });
    expect(folderNavigation).toHaveAttribute("aria-busy", "true");
    expect(within(folderNavigation).getByRole("status")).toHaveTextContent("Loading");
    expect(within(folderNavigation).getByLabelText("1 or more notes in Notes")).toHaveTextContent("1+");
    expect(gateway.listCalls).toBe(1);

    gateway.releaseStructure();
    expect(await screen.findByText("12 notes · indexing search")).toBeInTheDocument();
    expect(folderNavigation).toHaveAttribute("aria-busy", "false");
    expect(within(folderNavigation).queryByRole("status")).not.toBeInTheDocument();
    expect(within(folderNavigation).getByLabelText("3 notes in Notes")).toHaveTextContent("3");

    await user.type(screen.getByRole("textbox", { name: "Search every note" }), "Record 3 remains");
    expect(await screen.findByText("Searching")).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /A quiet interface 3/ })).not.toBeInTheDocument();
    gateway.releaseContent();
    expect(await screen.findByRole("option", { name: /A quiet interface 3/ })).toBeInTheDocument();
    await user.clear(screen.getByRole("textbox", { name: "Search every note" }));
    expect(await screen.findByText("12 notes")).toBeInTheDocument();
    expect(gateway.listCalls).toBe(1);
  });

  it("uses the create response without re-listing or re-reading the new note", async () => {
    const gateway = new CountingGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await screen.findByRole("heading", { name: "Writing" });
    const listCalls = gateway.listCalls;
    const readCalls = gateway.readCalls;
    await user.click(screen.getByRole("button", { name: "New note" }));
    await user.type(await screen.findByRole("textbox", { name: "Title" }), "Fast note");
    await user.click(screen.getByRole("button", { name: "Create note" }));

    expect(await screen.findByDisplayValue("Fast note")).toBeInTheDocument();
    expect(gateway.createCalls).toBe(1);
    expect(gateway.listCalls).toBe(listCalls);
    expect(gateway.readCalls).toBe(readCalls);
  });

  it("searches note content in the loaded index without another query or watcher", async () => {
    const gateway = new CountingGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await screen.findByRole("heading", { name: "Writing" });
    const listCalls = gateway.listCalls;
    await user.type(screen.getByRole("textbox", { name: "Search every note" }), "Record 3 remains");

    expect(await screen.findByRole("option", { name: /A quiet interface 3/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Garden notes 2/ })).not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(gateway.listCalls).toBe(listCalls);
    expect(gateway.watchCalls).toBe(1);
  });

  it("opens other notes while the current note saves in the background", async () => {
    const gateway = new SlowUpdateGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    const body = await screen.findByRole("textbox", { name: "Note body" });
    gateway.readPaths.length = 0;
    await user.type(body, "\nPending change.");
    await gateway.updateStarted;

    const first = screen.getByRole("option", { name: /The shape of useful tools/ });
    const second = screen.getByRole("option", { name: /Garden notes 2/ });
    await user.click(second);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2"));
    expect(first).toHaveAttribute("aria-busy", "true");
    expect(first).toHaveTextContent("Saving");

    const third = screen.getByRole("option", { name: /A quiet interface 3/ });
    await user.click(third);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("A quiet interface 3"));

    gateway.releaseUpdate();
    await waitFor(() => expect(first).not.toHaveAttribute("aria-busy"));
    expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("A quiet interface 3");
    expect(gateway.readPaths).toContain("Journal/garden-notes-2.md");
    expect(gateway.readPaths.at(-1)).toBe("Projects/a-quiet-interface-3.md");
    expect((await gateway.read("Notes/the-shape-of-useful-tools.md")).body).toContain("Pending change.");
  });

  it("saves a second note while the first note is still saving", async () => {
    const gateway = new SlowUpdateGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await user.type(await screen.findByRole("textbox", { name: "Note body" }), "\nFirst note change.");
    await gateway.updateStarted;
    await user.click(screen.getByRole("option", { name: /Garden notes 2/ }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2"));
    await user.type(screen.getByRole("textbox", { name: "Note body" }), "\nSecond note change.");

    await waitFor(async () => {
      expect((await gateway.read("Journal/garden-notes-2.md")).body).toContain("Second note change.");
    }, { timeout: 2_000 });
    expect((await gateway.read("Notes/the-shape-of-useful-tools.md")).body).not.toContain("First note change.");

    gateway.releaseUpdate();
    await waitFor(async () => {
      expect((await gateway.read("Notes/the-shape-of-useful-tools.md")).body).toContain("First note change.");
    });
  });

  it("reopens the cached draft while its background save is still running", async () => {
    const gateway = new SlowUpdateGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    const body = await screen.findByRole("textbox", { name: "Note body" });
    await user.type(body, "\nStill here.");
    await gateway.updateStarted;
    const readsBeforeNavigation = gateway.readPaths.length;
    await user.click(screen.getByRole("option", { name: /Garden notes 2/ }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2"));
    await user.click(screen.getByRole("option", { name: /The shape of useful tools/ }));

    expect((screen.getByRole("textbox", { name: "Note body" }) as HTMLTextAreaElement).value).toContain("Still here.");
    expect(gateway.readPaths.length).toBe(readsBeforeNavigation + 1);
    gateway.releaseUpdate();
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
    expect((screen.getByRole("textbox", { name: "Note body" }) as HTMLTextAreaElement).value).toContain("Still here.");
  });

  it("keeps a background save failure attached to its note", async () => {
    const gateway = new FailingUpdateGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await user.type(await screen.findByRole("textbox", { name: "Note body" }), "\nUnsaved sentence.");
    await gateway.updateStarted;
    await user.click(screen.getByRole("option", { name: /Garden notes 2/ }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2"));
    gateway.failUpdate();

    expect(await screen.findByText(/Couldn’t save “The shape of useful tools”/)).toBeInTheDocument();
    const failed = screen.getByRole("option", { name: /The shape of useful tools.*Save failed/ });
    await user.click(failed);
    expect((screen.getByRole("textbox", { name: "Note body" }) as HTMLTextAreaElement).value).toContain("Unsaved sentence.");
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
  });

  it("orders property updates behind a note save without blocking navigation", async () => {
    const gateway = new SlowUpdateGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await user.type(await screen.findByRole("textbox", { name: "Note body" }), "\nBefore properties.");
    await gateway.updateStarted;
    await user.click(screen.getByRole("button", { name: "Note properties" }));
    await user.click(screen.getByRole("button", { name: "Add property" }));
    await user.type(screen.getByRole("combobox", { name: "Name" }), "status");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.type(screen.getByRole("textbox", { name: "status value" }), "draft");
    await user.click(screen.getByRole("button", { name: "Save properties" }));
    expect(screen.queryByRole("complementary", { name: "Note properties" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: /Garden notes 2/ }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2"));
    expect(gateway.events).not.toContain("properties");
    gateway.releaseUpdate();

    await waitFor(() => expect(gateway.events).toContain("properties"));
    expect(gateway.events.indexOf("save:end")).toBeLessThan(gateway.events.indexOf("properties"));
    expect((await gateway.read("Notes/the-shape-of-useful-tools.md")).raw_frontmatter?.status).toBe("draft");
    expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2");
  });

  it("orders rename behind a note save without returning to that note", async () => {
    const gateway = new SlowUpdateGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await user.type(await screen.findByRole("textbox", { name: "Note body" }), "\nBefore rename.");
    await gateway.updateStarted;
    await user.click(screen.getByRole("button", { name: "Notes/the-shape-of-useful-tools.md" }));
    const path = screen.getByRole("textbox", { name: "Markdown path" });
    await user.clear(path);
    await user.type(path, "Notes/renamed-in-background.md{Enter}");
    await user.click(screen.getByRole("option", { name: /Garden notes 2/ }));

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2"));
    expect(gateway.events).not.toContain("rename");
    gateway.releaseUpdate();
    await waitFor(() => expect(gateway.events).toContain("rename"));
    expect(gateway.events.indexOf("save:end")).toBeLessThan(gateway.events.indexOf("rename"));
    expect((await gateway.list()).some((note) => note.path === "Notes/renamed-in-background.md")).toBe(true);
    expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2");
  });

  it("orders validation behind a note save without blocking navigation", async () => {
    const gateway = new SlowUpdateGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await user.type(await screen.findByRole("textbox", { name: "Note body" }), "\nBefore validation.");
    await gateway.updateStarted;
    await user.click(screen.getByRole("button", { name: "Check note" }));
    await user.click(screen.getByRole("option", { name: /Garden notes 2/ }));

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2"));
    expect(gateway.events).not.toContain("validate");
    gateway.releaseUpdate();
    await waitFor(() => expect(gateway.events).toContain("validate"));
    expect(gateway.events.indexOf("save:end")).toBeLessThan(gateway.events.indexOf("validate"));
    expect(screen.queryByText("No validation issues.")).not.toBeInTheDocument();
  });

  it("leaves a deleted note immediately and deletes it after its active save", async () => {
    const gateway = new SlowUpdateGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await user.type(await screen.findByRole("textbox", { name: "Note body" }), "\nDiscard with note.");
    await gateway.updateStarted;
    await user.click(screen.getByRole("button", { name: "Delete note" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2"));
    expect(gateway.events).not.toContain("delete");
    const deleting = screen.getByRole("option", { name: /The shape of useful tools.*Deleting/ });
    expect(deleting).toHaveAttribute("aria-busy", "true");
    expect(deleting).toHaveAttribute("aria-disabled", "true");
    await user.click(deleting);
    expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2");
    gateway.releaseUpdate();

    await waitFor(() => expect(gateway.events).toContain("delete"));
    expect(gateway.events.indexOf("save:end")).toBeLessThan(gateway.events.indexOf("delete"));
    await waitFor(() => expect(screen.queryByRole("option", { name: /The shape of useful tools/ })).not.toBeInTheDocument());
    expect((await gateway.list()).some((note) => note.path === "Notes/the-shape-of-useful-tools.md")).toBe(false);
  });

  it("renders an explicit full-access explanation before authorization", async () => {
    const gateway = new DemoCollectionGateway(1);
    const disconnected = Object.create(gateway) as CollectionGateway;
    disconnected.connection = () => null;
    render(<App gateway={disconnected} />);
    expect(await screen.findByText(/view, create, edit, move, validate, and delete/i)).toBeInTheDocument();
  });
});

class RemoteChangeGateway extends DemoCollectionGateway {
  private remote?: NoteDocument;
  private listener?: (change?: CollectionChange) => void;
  private markWatching?: () => void;
  readonly watchStarted = new Promise<void>((resolve) => { this.markWatching = resolve; });
  updateCalls = 0;

  constructor() {
    super(3);
  }

  override async list(onProgress?: (progress: NoteListProgress) => void): Promise<NoteSummary[]> {
    if (!this.remote) return super.list(onProgress);
    const notes = await super.list();
    const { revision: _revision, raw_frontmatter: _rawFrontmatter, ...summary } = this.remote;
    const updated = notes.map((note) => note.path === summary.path ? structuredClone(summary) : note);
    onProgress?.({ notes: updated, structureComplete: true, complete: true, total: updated.length });
    return updated;
  }

  override async read(path: string): Promise<NoteDocument> {
    if (this.remote?.path === path) return structuredClone(this.remote);
    return super.read(path);
  }

  override async update(input: Parameters<DemoCollectionGateway["update"]>[0]): Promise<NoteDocument> {
    this.updateCalls += 1;
    if (!this.remote || this.remote.path !== input.path) return super.update(input);
    if (this.remote.revision !== input.revision) throw new Error("This note changed elsewhere. Reload it before saving.");
    this.remote = {
      ...this.remote,
      body: `# ${input.title}\n\n${input.body}`,
      revision: "remote-saved"
    };
    return structuredClone(this.remote);
  }

  override async watch(onChange: (change?: CollectionChange) => void, signal: AbortSignal): Promise<void> {
    this.listener = onChange;
    this.markWatching?.();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    this.listener = undefined;
  }

  async modifyRemotely() {
    const current = await super.read("Notes/the-shape-of-useful-tools.md");
    this.remote = {
      ...current,
      body: "# Changed on another device\n\nThe remote version is current.\n",
      revision: "remote-2",
      file: current.file ? { ...current.file, mtime: new Date().toISOString() } : undefined
    };
    this.listener?.({
      cursor: 2,
      type: "mdbase.record.modified",
      occurred_at: new Date().toISOString(),
      payload: { path: current.path, types: current.types }
    });
  }
}

class SlowReadGateway extends DemoCollectionGateway {
  private release?: () => void;

  constructor() {
    super(1);
  }

  override async read(path: string): Promise<NoteDocument> {
    await new Promise<void>((resolve) => { this.release = resolve; });
    return super.read(path);
  }

  releaseRead() {
    this.release?.();
  }
}

class SlowDescriptionGateway extends DemoCollectionGateway {
  private release?: () => void;

  constructor() {
    super(2);
  }

  override async describe() {
    await new Promise<void>((resolve) => { this.release = resolve; });
    return super.describe();
  }

  releaseDescription() {
    this.release?.();
  }
}

class ProgressiveListGateway extends DemoCollectionGateway {
  private releaseStructurePage?: () => void;
  private releaseContentPage?: () => void;
  listCalls = 0;

  override async list(onProgress?: (progress: NoteListProgress) => void): Promise<NoteSummary[]> {
    this.listCalls += 1;
    const notes = await super.list();
    const structure = notes.map(({ body: _body, ...note }) => note);
    onProgress?.({ notes: structure.slice(0, 1), structureComplete: false, complete: false, total: notes.length });
    await new Promise<void>((resolve) => { this.releaseStructurePage = resolve; });
    onProgress?.({ notes: structure, structureComplete: true, complete: false, total: notes.length });
    await new Promise<void>((resolve) => { this.releaseContentPage = resolve; });
    onProgress?.({ notes, structureComplete: true, complete: true, total: notes.length });
    return notes;
  }

  releaseStructure() {
    this.releaseStructurePage?.();
  }

  releaseContent() {
    this.releaseContentPage?.();
  }
}

class CountingGateway extends DemoCollectionGateway {
  listCalls = 0;
  readCalls = 0;
  createCalls = 0;
  watchCalls = 0;

  constructor() {
    super(3);
  }

  override async list(onProgress?: (progress: NoteListProgress) => void): Promise<NoteSummary[]> {
    this.listCalls += 1;
    return super.list(onProgress);
  }

  override async read(path: string): Promise<NoteDocument> {
    this.readCalls += 1;
    return super.read(path);
  }

  override async create(input: Parameters<DemoCollectionGateway["create"]>[0]): Promise<NoteDocument> {
    this.createCalls += 1;
    return super.create(input);
  }

  override async watch(_onChange: () => void, signal: AbortSignal): Promise<void> {
    this.watchCalls += 1;
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  }
}

class SlowUpdateGateway extends DemoCollectionGateway {
  private release?: () => void;
  private markStarted?: () => void;
  private readonly blockedUpdate = new Promise<void>((resolve) => { this.release = resolve; });
  readonly updateStarted = new Promise<void>((resolve) => { this.markStarted = resolve; });
  readPaths: string[] = [];
  events: string[] = [];

  constructor() {
    super(3);
  }

  override async read(path: string): Promise<NoteDocument> {
    this.readPaths.push(path);
    return super.read(path);
  }

  override async update(input: Parameters<DemoCollectionGateway["update"]>[0]): Promise<NoteDocument> {
    this.events.push("save:start");
    if (input.path === "Notes/the-shape-of-useful-tools.md") {
      this.markStarted?.();
      await this.blockedUpdate;
    }
    const updated = await super.update(input);
    this.events.push("save:end");
    return updated;
  }

  override async updateProperties(path: string, patch: JsonObject, revision: string): Promise<NoteDocument> {
    this.events.push("properties");
    return super.updateProperties(path, patch, revision);
  }

  override async rename(from: string, to: string, revision: string): Promise<NoteDocument> {
    this.events.push("rename");
    return super.rename(from, to, revision);
  }

  override async validate(): Promise<[]> {
    this.events.push("validate");
    return [];
  }

  override async delete(path: string, revision: string): Promise<void> {
    this.events.push("delete");
    return super.delete(path, revision);
  }

  releaseUpdate() {
    this.release?.();
  }
}

class FailingUpdateGateway extends DemoCollectionGateway {
  private fail?: () => void;
  private markStarted?: () => void;
  readonly updateStarted = new Promise<void>((resolve) => { this.markStarted = resolve; });

  constructor() {
    super(3);
  }

  override async update(): Promise<NoteDocument> {
    this.markStarted?.();
    await new Promise<void>((resolve) => { this.fail = resolve; });
    throw new Error("The relay could not save this note.");
  }

  failUpdate() {
    this.fail?.();
  }
}
