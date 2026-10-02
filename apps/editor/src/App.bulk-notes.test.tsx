import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { App } from "./App";
import { DemoCollectionGateway } from "./demo-gateway";
import { NOTE_PATHS_MIME } from "./note-drag";
import { loadPinnedNotes } from "./note-list-view";
import { chooseOption } from "./test/select";

vi.mock("./CodeEditor", () => ({ CodeEditor: ({ value, onChange, label, footer }: { value: string; onChange?: (value: string) => void; label: string; footer?: ReactNode }) => <><textarea aria-label={label} value={value} onChange={(event) => onChange?.(event.target.value)} />{footer}</> }));
vi.mock("@tanstack/react-virtual", () => ({ useVirtualizer: ({ count }: { count: number }) => ({
  getTotalSize: () => count * 76,
  getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 76, size: 76 }))
}) }));

const first = "Notes/the-shape-of-useful-tools.md";
const second = "Journal/garden-notes-2.md";
async function selectPair() {
  await screen.findByRole("textbox", { name: "Note body" });
  fireEvent.click(screen.getByRole("option", { name: /Garden notes 2/ }), { ctrlKey: true });
  expect(screen.getByText("2 selected")).toBeInTheDocument();
}
async function selectionAction(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "Selection actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name }));
}

describe("bulk notes", () => {
  it("keeps the anchor open, exposes listbox selection, keyboard range/select all/clear and drag payload", async () => {
    render(<App gateway={new DemoCollectionGateway(5)} />);
    await selectPair();
    const list = screen.getByRole("listbox", { name: "Collection notes and files" });
    expect(list).toHaveAttribute("aria-multiselectable", "true");
    expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("The shape of useful tools");
    expect(screen.getAllByRole("option", { selected: true })).toHaveLength(2);
    const setData = vi.fn();
    fireEvent.dragStart(screen.getByRole("option", { name: /Garden notes 2/ }), { dataTransfer: { setData } });
    expect(setData).toHaveBeenCalledWith(NOTE_PATHS_MIME, JSON.stringify([first, second]));
    fireEvent.keyDown(list, { key: "ArrowDown", shiftKey: true });
    expect(screen.getByText("3 selected")).toBeInTheDocument();
    fireEvent.keyDown(list, { key: "ArrowUp", shiftKey: true });
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    fireEvent.keyDown(list, { key: "a", metaKey: true });
    expect(screen.getByText("5 selected")).toBeInTheDocument();
    fireEvent.keyDown(list, { key: "Escape" });
    expect(screen.queryAllByRole("option", { selected: true })).toHaveLength(0);
    expect(screen.queryByText(/\d+ selected/)).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("The shape of useful tools");
    fireEvent.click(screen.getByRole("option", { name: /A quiet interface 3/ }), { shiftKey: true });
    expect(screen.getByText("3 selected")).toBeInTheDocument();
  });

  it("deletes from the selected row context menu and one Undo restores the whole batch", async () => {
    const gateway = new DemoCollectionGateway(4);
    const originals = await Promise.all([gateway.read(first), gateway.read(second)]);
    render(<App gateway={gateway} />);
    await selectPair();
    fireEvent.contextMenu(screen.getByRole("option", { name: /Garden notes 2/ }));
    const menu = screen.getByRole("menu", { name: /note actions$/ });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Move to…", "Add tag", "Remove tag", "Set property", "Delete"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete" }));
    const undo = await screen.findByRole("button", { name: "Undo" });
    expect(undo.closest('[role="status"]')).toHaveTextContent("Deleted 2 notes");
    expect((await gateway.list()).notes).toHaveLength(2);
    fireEvent.click(undo);
    await waitFor(async () => expect((await gateway.list()).notes).toHaveLength(4));
    for (const original of originals) {
      const restored = await gateway.read(original.path);
      expect(restored.frontmatter).toEqual(original.frontmatter);
      expect(restored.body).toEqual(original.body);
    }
  });

  it("adds and removes tags with one revision-aware Undo and preserves all other fields and body", async () => {
    const user = userEvent.setup();
    const gateway = new DemoCollectionGateway(4);
    const originals = await Promise.all([gateway.read(first), gateway.read(second)]);
    render(<App gateway={gateway} />);
    await selectPair();
    await selectionAction("Add tag");
    await user.type(await screen.findByRole("textbox", { name: "Tag" }), "batch");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByRole("button", { name: "Undo" });
    for (const original of originals) {
      const next = await gateway.read(original.path);
      expect(next.frontmatter.tags).toContain("batch");
      expect(next.body).toEqual(original.body);
    }
    await selectionAction("Remove tag");
    await user.type(await screen.findByRole("textbox", { name: "Tag" }), "batch");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(async () => expect((await gateway.read(second)).frontmatter.tags).not.toContain("batch"));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(async () => expect((await gateway.read(second)).frontmatter.tags).toContain("batch"));
  });

  it("sets only declared shared properties using the existing schema control and undoes both notes", async () => {
    const user = userEvent.setup();
    const gateway = new DemoCollectionGateway(8);
    const paths = ["Reading/reading-list-4.md", "Projects/the-shape-of-useful-tools-8.md"];
    const originals = await Promise.all(paths.map((path) => gateway.read(path)));
    render(<App gateway={gateway} />);
    await selectPair();
    fireEvent.click(screen.getByRole("button", { name: "Selection actions" }));
    // Untyped notes cannot receive arbitrary schema fields.
    expect(screen.getByRole("menuitem", { name: "Set property" })).toBeDisabled();
    await user.keyboard("{Escape}");
    fireEvent.keyDown(screen.getByRole("listbox", { name: "Collection notes and files" }), { key: "Escape" });
    fireEvent.click(screen.getByRole("option", { name: /Reading list 4/ }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Reading list 4"));
    fireEvent.click(screen.getByRole("option", { name: /The shape of useful tools 8/ }), { metaKey: true });
    await selectionAction("Set property");
    const panel = await screen.findByRole("form", { name: "Set property" });
    await chooseOption(user, within(panel).getByRole("combobox", { name: "Property" }), "title");
    await user.type(within(panel).getByRole("textbox", { name: "title" }), "Shared title");
    fireEvent.click(within(panel).getByRole("button", { name: "Apply" }));
    await screen.findByRole("button", { name: "Undo" });
    for (const path of paths) expect((await gateway.read(path)).frontmatter.title).toBe("Shared title");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(async () => expect((await gateway.read(paths[1])).frontmatter).toEqual(originals[1].frontmatter));
    expect((await gateway.read(paths[0])).frontmatter).toEqual(originals[0].frontmatter);
  });

  it("reports partial write failure, undoes successes, and doesn't overwrite a later revision", async () => {
    const user = userEvent.setup();
    const gateway = new DemoCollectionGateway(4);
    const update = gateway.updateDocument.bind(gateway);
    vi.spyOn(gateway, "updateDocument").mockImplementation((path, source, revision) => {
      if (path === second) return Promise.reject(new Error("Remote conflict"));
      return update(path, source, revision);
    });
    render(<App gateway={gateway} />);
    await selectPair(); await selectionAction("Add tag");
    await user.type(await screen.findByRole("textbox", { name: "Tag" }), "batch");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    const undo = await screen.findByRole("button", { name: "Undo" });
    expect(undo.closest('[role="status"]')).toHaveTextContent("Updated 1 note. 1 couldn’t be changed");
    const changed = await gateway.read(first);
    await update(first, "---\ntags: [later]\n---\n# External change", changed.revision);
    fireEvent.click(undo);
    await screen.findByText(/Restored 0 notes. 1 couldn’t be changed/);
    expect((await gateway.read(first)).frontmatter.tags).toEqual(["later"]);
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("keeps only failed Undo items for retry, without replaying successful restores", async () => {
    const gateway = new DemoCollectionGateway(4);
    render(<App gateway={gateway} />); await selectPair(); await selectionAction("Delete");
    const undo = await screen.findByRole("button", { name: "Undo" });
    const restore = gateway.restore.bind(gateway);
    let fail = true;
    const spy = vi.spyOn(gateway, "restore").mockImplementation((document) => document.path === first && fail ? Promise.reject(new Error("Temporarily offline")) : restore(document));
    fireEvent.click(undo);
    await screen.findByText(/Restored 1 note. 1 couldn’t be changed/);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(async () => expect((await gateway.list()).notes).toHaveLength(4));
    expect(spy.mock.calls.filter(([document]) => document.path === second)).toHaveLength(1);
  });

  it("pins without writing files, excludes pins from search and folder groups, and restores on remount", async () => {
    const gateway = new DemoCollectionGateway(4);
    const write = vi.spyOn(gateway, "updateDocument");
    const view = render(<App gateway={gateway} />);
    await screen.findByRole("textbox", { name: "Note body" });
    fireEvent.contextMenu(screen.getByRole("option", { name: /Garden notes 2/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin" }));
    expect(screen.getByText("Pinned")).toBeInTheDocument();
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("Garden notes 2");
    expect(loadPinnedNotes((await gateway.describe()).collectionId)).toEqual([second]);
    expect(write).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox", { name: "Search notes and files" }), { target: { value: "Garden" } });
    await waitFor(() => expect(screen.queryByText("Pinned")).not.toBeInTheDocument());
    view.unmount();
    render(<App gateway={gateway} />);
    await screen.findByText("Pinned");
    fireEvent.contextMenu(screen.getByRole("option", { name: /Garden notes 2/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Unpin" }));
    expect(screen.queryByText("Pinned")).not.toBeInTheDocument();
  });
});
