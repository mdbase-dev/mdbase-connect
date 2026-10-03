import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { App } from "./App";
import { DemoCollectionGateway } from "./demo-gateway";
import { NOTE_PATHS_MIME } from "./note-list-view";
import { chooseOption } from "./test/select";

vi.mock("./CodeEditor", () => ({
  CodeEditor: ({ value, onChange, label, footer }: { value: string; onChange?: (value: string) => void; label: string; footer?: ReactNode }) => <><textarea aria-label={label} value={value} onChange={(event) => onChange?.(event.target.value)} />{footer}</>
}));
vi.mock("@tanstack/react-virtual", () => ({ useVirtualizer: ({ count }: { count: number }) => ({
  getTotalSize: () => count * 76,
  getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 76, size: 76 }))
}) }));

async function openRowMenu(name = /Garden notes 2/) {
  const row = await screen.findByRole("option", { name });
  fireEvent.contextMenu(row, { clientX: 100, clientY: 100 });
  return screen.findByRole("menu", { name: /note actions$/ });
}

describe("Note actions", () => {
  it("uses the same actions in the row menu and toolbar, copies durable links and paths without opening the row", async () => {
    const user = userEvent.setup();
    const gateway = new DemoCollectionGateway(4);
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: write } });
    render(<App gateway={gateway} />);
    await screen.findByRole("textbox", { name: "Note body" });
    const menu = await openRowMenu();
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Rename", "Move to…", "Duplicate", "Copy link", "Copy path", "Pin", "Delete"]);
    await user.click(within(menu).getByRole("menuitem", { name: "Copy link" }));
    expect(write).toHaveBeenCalledWith("[[Journal/garden-notes-2]]");
    expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("The shape of useful tools");
    await user.click(within(await openRowMenu()).getByRole("menuitem", { name: "Copy path" }));
    expect(write).toHaveBeenCalledWith("Journal/garden-notes-2.md");
    await user.click(screen.getByRole("button", { name: "More note actions" }));
    for (const name of ["Rename", "Move to…", "Duplicate", "Copy link", "Copy path", "Delete", "Document outline", "Linked from", "Keyboard shortcuts"]) expect(screen.getByRole("menuitem", { name })).toBeInTheDocument();
  });

  it("duplicates the full record at a fresh sibling path", async () => {
    const gateway = new DemoCollectionGateway(3);
    const original = await gateway.read("Journal/garden-notes-2.md");
    const user = userEvent.setup();
    render(<App gateway={gateway} />);
    await screen.findByRole("textbox", { name: "Note body" });
    await user.click(within(await openRowMenu()).getByRole("menuitem", { name: "Duplicate" }));
    await screen.findByRole("button", { name: "Journal/garden-notes-2 copy.md" });
    const duplicate = await gateway.read("Journal/garden-notes-2 copy.md");
    expect(duplicate.frontmatter).toEqual(original.frontmatter);
    expect(duplicate.body).toBe(original.body);
    await user.click(screen.getByRole("button", { name: "More note actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    await screen.findByRole("button", { name: "Journal/garden-notes-2 copy copy.md" });
  });

  it("deletes a background row without confirmation and Undo recreates its exact frontmatter and body", async () => {
    const gateway = new DemoCollectionGateway(4);
    const original = await gateway.read("Journal/garden-notes-2.md");
    const user = userEvent.setup();
    render(<App gateway={gateway} />);
    await screen.findByRole("textbox", { name: "Note body" });
    await user.click(within(await openRowMenu()).getByRole("menuitem", { name: "Delete" }));
    const undo = await screen.findByRole("button", { name: "Undo" });
    expect(undo.closest('[role="status"]')).toHaveTextContent("Deleted");
    expect(screen.queryByText("Delete this note?")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("The shape of useful tools");
    expect((await gateway.list()).notes.some((note) => note.path === original.path)).toBe(false);
    await user.click(undo);
    await screen.findByRole("option", { name: /Garden notes 2/ });
    const restored = await gateway.read(original.path);
    expect(restored.frontmatter).toEqual(original.frontmatter);
    expect(restored.body).toBe(original.body);
  });

  it("moves a note with revision checks, updates incoming links, and Undo renames back with links", async () => {
    const gateway = new DemoCollectionGateway(4);
    const rename = vi.spyOn(gateway, "rename");
    const user = userEvent.setup();
    render(<App gateway={gateway} />);
    await screen.findByRole("textbox", { name: "Note body" });
    await user.click(screen.getByRole("button", { name: "More note actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Move to…" }));
    const dialog = screen.getByRole("dialog", { name: "Move note" });
    await chooseOption(user, within(dialog).getByRole("combobox", { name: "Destination folder" }), "Projects");
    await user.click(within(dialog).getByRole("button", { name: "Move" }));
    await screen.findByRole("button", { name: "Projects/the-shape-of-useful-tools.md" });
    expect(rename).toHaveBeenCalledWith("Notes/the-shape-of-useful-tools.md", "Projects/the-shape-of-useful-tools.md", expect.any(String), true, expect.any(Object));
    expect((await gateway.read("Journal/garden-notes-2.md")).body).toContain("Projects/the-shape-of-useful-tools");
    expect(screen.getByText(/Also updated links in 1 note/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByRole("button", { name: "Notes/the-shape-of-useful-tools.md" });
    expect((await gateway.read("Journal/garden-notes-2.md")).body).toContain("Notes/the-shape-of-useful-tools");
    expect(rename.mock.calls.at(-1)?.[3]).toBe(true);
  });

  it("supports list context-menu keys, F2, delete chord, and drag payload without hover previews", async () => {
    const user = userEvent.setup();
    render(<App gateway={new DemoCollectionGateway(4)} />);
    const row = await screen.findByRole("option", { name: /The shape of useful tools/ });
    await screen.findByRole("textbox", { name: "Note body" });
    const list = screen.getByRole("listbox", { name: "Collection notes and files" });
    list.focus();
    fireEvent.keyDown(list, { key: "F10", shiftKey: true });
    expect(await screen.findByRole("menu", { name: /note actions$/ })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    fireEvent.keyDown(list, { key: "ContextMenu" });
    expect(await screen.findByRole("menu", { name: /note actions$/ })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    fireEvent.keyDown(list, { key: "F2" });
    expect(await screen.findByRole("textbox", { name: "Markdown path" })).toHaveValue("Notes/the-shape-of-useful-tools.md");
    const setData = vi.fn();
    fireEvent.dragStart(row, { dataTransfer: { setData } });
    expect(setData).toHaveBeenCalledWith(NOTE_PATHS_MIME, '["Notes/the-shape-of-useful-tools.md"]');
    fireEvent.mouseOver(row);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    list.focus();
    fireEvent.keyDown(list, { key: "Backspace", ctrlKey: true });
    await screen.findByRole("button", { name: "Undo" });
    await waitFor(() => expect(screen.queryByRole("option", { name: /The shape of useful tools/ })).not.toBeInTheDocument());
  });

  it("opens outline and shortcuts from More, and does not open shortcuts while typing", async () => {
    const user = userEvent.setup();
    const gateway = new DemoCollectionGateway(2);
    const note = await gateway.read("Notes/the-shape-of-useful-tools.md");
    await gateway.updateDocument(note.path, "# Title\n\n## First heading\n\nText", note.revision);
    render(<App gateway={gateway} />);
    const body = await screen.findByRole("textbox", { name: "Note body" });
    fireEvent.keyDown(body, { key: "?" });
    expect(screen.queryByRole("dialog", { name: "Shortcuts" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "More note actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Document outline" }));
    const outline = screen.getByRole("dialog", { name: "Document outline" });
    expect(within(outline).getByRole("button", { name: /First heading/ })).toBeInTheDocument();
    await user.click(within(outline).getByRole("button", { name: /First heading/ }));
    expect(screen.queryByRole("dialog", { name: "Document outline" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "More note actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Keyboard shortcuts" }));
    expect(screen.getByRole("dialog", { name: "Shortcuts" })).toBeInTheDocument();
  });
});
