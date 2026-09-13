import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { DemoCollectionGateway } from "./demo-gateway";
import type { CreateNoteInput } from "./model";

vi.mock("./CodeEditor", () => ({ CodeEditor: () => null }));
vi.mock("./MarkdownNoteEditor", () => ({
  MarkdownNoteEditor: ({ draft, onTitleChange, onBodyChange, onCreateLink }: {
    draft: { title: string; body: string };
    onTitleChange(value: string): void;
    onBodyChange(value: string): void;
    onCreateLink(target: string, label: string | undefined, format: "wikilink"): void;
  }) => <>
    <input aria-label="Note title" value={draft.title} onChange={(event) => onTitleChange(event.target.value)} />
    <textarea aria-label="Note body" value={draft.body} onChange={(event) => onBodyChange(event.target.value)} />
    <button onClick={() => onCreateLink("Linked.md", "Linked", "wikilink")}>Create linked note</button>
  </>
}));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 76,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 76, size: 76 }))
  })
}));

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function harness() {
  const gateway = new DemoCollectionGateway(3);
  const { notes } = await gateway.list();
  const first = notes[0]!;
  const second = notes[1]!;
  const third = notes[2]!;
  const read = vi.spyOn(gateway, "read");
  const list = vi.spyOn(gateway, "list");
  const describeCollection = vi.spyOn(gateway, "describe");
  const listFiles = vi.spyOn(gateway, "listFiles");
  render(<App gateway={gateway} />);
  await screen.findByDisplayValue("The shape of useful tools");
  await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThanOrEqual(3));
  const select = (name: RegExp) => fireEvent.click(screen.getByRole("option", { name }));
  return { gateway, first, second, third, read, list, describeCollection, listFiles, select };
}

describe("note navigation ownership and recovery", () => {
  it("retries the first note directly when no document has opened yet", async () => {
    const gateway = new DemoCollectionGateway(1);
    const read = vi.spyOn(gateway, "read").mockRejectedValueOnce(new Error("First read failed"));
    const list = vi.spyOn(gateway, "list");
    const describeCollection = vi.spyOn(gateway, "describe");
    render(<App gateway={gateway} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("First read failed");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByDisplayValue("The shape of useful tools");
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1]).toEqual(read.mock.calls[0]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(describeCollection).toHaveBeenCalledTimes(1);
  });

  it("keeps the active document mounted on a failed read and retries only the requested note", async () => {
    const { gateway, first, second, read, list, describeCollection, listFiles, select } = await harness();
    const originalRead = DemoCollectionGateway.prototype.read.bind(gateway);
    const gate = deferred();
    read.mockImplementationOnce(async (path) => { await gate.promise; return originalRead(path); });
    const title = screen.getByRole("textbox", { name: "Note title" });
    const body = screen.getByRole("textbox", { name: "Note body" });
    const before = { list: list.mock.calls.length, describe: describeCollection.mock.calls.length, files: listFiles.mock.calls.length };
    select(/Garden notes 2/);
    expect(screen.getByRole("textbox", { name: "Note title" })).toBe(title);
    expect(screen.getByRole("textbox", { name: "Note body" })).toBe(body);
    expect(screen.getByText(`Opening “${second.path}”…`)).toHaveAttribute("role", "status");
    await act(async () => gate.reject(new Error("Temporary read failure")));
    const retry = await screen.findByRole("button", { name: "Retry note" });
    expect(screen.getByRole("textbox", { name: "Note title" })).toBe(title);
    expect(screen.getByRole("option", { name: /The shape of useful tools/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: /Garden notes 2/ })).toHaveAttribute("aria-selected", "false");
    expect(localStorage.getItem("mdbase-editor:last-note")).toBe(first.path);
    fireEvent.click(retry);
    await screen.findByDisplayValue("Garden notes 2");
    expect(read.mock.calls.map(([path]) => path)).toEqual([first.path, second.path, second.path]);
    expect(list).toHaveBeenCalledTimes(before.list);
    expect(describeCollection).toHaveBeenCalledTimes(before.describe);
    expect(listFiles).toHaveBeenCalledTimes(before.files);
    expect(screen.queryByRole("button", { name: "Retry note" })).not.toBeInTheDocument();
  });

  it("saves edits made to the retained document while the next note is loading", async () => {
    const { gateway, first, read, select } = await harness();
    const originalRead = DemoCollectionGateway.prototype.read.bind(gateway);
    const gate = deferred();
    read.mockImplementationOnce(async (path) => { await gate.promise; return originalRead(path); });
    const update = vi.spyOn(gateway, "update");
    select(/Garden notes 2/);
    fireEvent.change(screen.getByRole("textbox", { name: "Note body" }), { target: { value: "Typed during navigation" } });
    await act(async () => gate.resolve());
    await screen.findByDisplayValue("Garden notes 2");
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ path: first.path, body: "Typed during navigation" })));
    expect((await originalRead(first.path)).body).toContain("Typed during navigation");
  });

  it("does not surface a stale read failure after a newer note has opened", async () => {
    const { gateway, read, select } = await harness();
    const originalRead = DemoCollectionGateway.prototype.read.bind(gateway);
    const gate = deferred();
    read.mockImplementationOnce(async (path) => { await gate.promise; return originalRead(path); });
    select(/Garden notes 2/);
    select(/A quiet interface 3/);
    await screen.findByDisplayValue("A quiet interface 3");
    await act(async () => gate.reject(new Error("Obsolete failure")));
    expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("A quiet interface 3");
    expect(screen.queryByText(/Obsolete failure/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry note" })).not.toBeInTheDocument();
  });

  it.each(["success", "failure"] as const)("ignores a pending read's %s after navigation to a file", async (outcome) => {
    const { gateway, read, select } = await harness();
    const originalRead = DemoCollectionGateway.prototype.read.bind(gateway);
    const gate = deferred();
    read.mockImplementationOnce(async (path) => { await gate.promise; return originalRead(path); });
    select(/Garden notes 2/);
    const file = screen.getAllByRole("option").find((row) => row.classList.contains("file-row"))!;
    fireEvent.click(file);
    await act(async () => outcome === "success" ? gate.resolve() : gate.reject(new Error("Obsolete failure")));
    await waitFor(() => expect(file).toHaveAttribute("aria-selected", "true"));
    expect(screen.queryByDisplayValue("Garden notes 2")).not.toBeInTheDocument();
    expect(screen.queryByText(/Obsolete failure/)).not.toBeInTheDocument();
  });

  it.each([true, false])("does not let slow linked creation replace newer navigation (cached=%s)", async (cached) => {
    const { gateway, first, select } = await harness();
    if (cached) {
      select(/A quiet interface 3/);
      await screen.findByDisplayValue("A quiet interface 3");
      select(/The shape of useful tools/);
      await screen.findByDisplayValue("The shape of useful tools");
    }
    const gate = deferred();
    const originalCreate = gateway.create.bind(gateway);
    vi.spyOn(gateway, "create").mockImplementation(async (input: CreateNoteInput) => { await gate.promise; return originalCreate(input); });
    fireEvent.click(screen.getByRole("button", { name: "Create linked note" }));
    select(/A quiet interface 3/);
    await screen.findByDisplayValue("A quiet interface 3");
    await act(async () => gate.resolve());
    await screen.findByRole("option", { name: /Linked/ });
    expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("A quiet interface 3");
    expect(within(screen.getByRole("group", { name: "Note history" })).getByRole("button", { name: "Back in note history" })).toHaveAttribute("title", expect.stringContaining(first.path));
  });

  it("does not perform fallback navigation when a stale linked creation fails", async () => {
    const { gateway, read, select } = await harness();
    const gate = deferred();
    vi.spyOn(gateway, "create").mockImplementation(async () => { await gate.promise; throw new Error("Create failed"); });
    fireEvent.click(screen.getByRole("button", { name: "Create linked note" }));
    select(/A quiet interface 3/);
    await screen.findByDisplayValue("A quiet interface 3");
    const reads = read.mock.calls.length;
    await act(async () => gate.resolve());
    await screen.findByText(/Couldn’t create “Notes\/Linked.md”/);
    expect(read).toHaveBeenCalledTimes(reads);
    expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("A quiet interface 3");
  });

  it("still adopts a created link when it remains the latest navigation", async () => {
    const { gateway } = await harness();
    const created = vi.spyOn(gateway, "create");
    fireEvent.click(screen.getByRole("button", { name: "Create linked note" }));
    await screen.findByDisplayValue("Linked");
    expect(created).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("mdbase-editor:last-note")).toBe("Notes/Linked.md");
  });
});
