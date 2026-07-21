import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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

  it("creates a note and exposes collection-wide navigation", async () => {
    const gateway = new DemoCollectionGateway(4);
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    await screen.findByRole("heading", { name: "Writing" });
    await user.click(screen.getByRole("button", { name: "New note" }));
    const title = await screen.findByRole("textbox", { name: "Title" });
    await user.type(title, "A useful note");
    expect(screen.getByRole("textbox", { name: "Path" })).toHaveValue("Notes/A useful note.md");
    await user.selectOptions(screen.getByRole("combobox", { name: "Type" }), "note");
    await user.click(screen.getByRole("button", { name: "Create note" }));
    expect(await screen.findByDisplayValue("A useful note")).toBeInTheDocument();
    await waitFor(async () => expect((await gateway.list()).length).toBe(5));
    const created = await gateway.read("Notes/A useful note.md");
    expect(created.raw_frontmatter?.title).toBe("A useful note");
    expect(created.body).toBe("");
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
    render(<App gateway={gateway} />);

    expect(await screen.findByRole("textbox", { name: "Note title" })).toHaveValue("The shape of useful tools");
    expect(screen.getByText("1 of 12 notes")).toBeInTheDocument();
    expect(gateway.listCalls).toBe(1);
    gateway.releaseList();
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

  it("opens only the latest selected note after saving the current note", async () => {
    const gateway = new SlowUpdateGateway();
    const user = userEvent.setup();
    render(<App gateway={gateway} />);

    const body = await screen.findByRole("textbox", { name: "Note body" });
    gateway.readPaths.length = 0;
    await user.type(body, "\nPending change.");
    await gateway.updateStarted;

    const second = screen.getByRole("option", { name: /Garden notes 2/ });
    const third = screen.getByRole("option", { name: /A quiet interface 3/ });
    await user.click(second);
    expect(second).toHaveAttribute("aria-busy", "true");
    expect(second).toHaveTextContent("Saving current note");
    await user.click(third);
    expect(second).not.toHaveAttribute("aria-busy");
    expect(third).toHaveAttribute("aria-busy", "true");

    gateway.releaseUpdate();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("A quiet interface 3"));
    expect(gateway.readPaths).not.toContain("Journal/garden-notes-2.md");
    expect(gateway.readPaths.at(-1)).toBe("Projects/a-quiet-interface-3.md");
  });

  it("renders an explicit full-access explanation before authorization", async () => {
    const gateway = new DemoCollectionGateway(1);
    const disconnected = Object.create(gateway) as CollectionGateway;
    disconnected.connection = () => null;
    render(<App gateway={disconnected} />);
    expect(await screen.findByText(/view, create, edit, move, validate, and delete/i)).toBeInTheDocument();
  });
});

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
  private release?: () => void;
  listCalls = 0;

  override async list(onProgress?: (progress: NoteListProgress) => void): Promise<NoteSummary[]> {
    this.listCalls += 1;
    const notes = await super.list();
    onProgress?.({ notes: notes.slice(0, 1), complete: false, total: notes.length });
    await new Promise<void>((resolve) => { this.release = resolve; });
    onProgress?.({ notes, complete: true, total: notes.length });
    return notes;
  }

  releaseList() {
    this.release?.();
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
  readonly updateStarted = new Promise<void>((resolve) => { this.markStarted = resolve; });
  readPaths: string[] = [];

  constructor() {
    super(3);
  }

  override async read(path: string): Promise<NoteDocument> {
    this.readPaths.push(path);
    return super.read(path);
  }

  override async update(input: Parameters<DemoCollectionGateway["update"]>[0]): Promise<NoteDocument> {
    this.markStarted?.();
    await new Promise<void>((resolve) => { this.release = resolve; });
    return super.update(input);
  }

  releaseUpdate() {
    this.release?.();
  }
}
