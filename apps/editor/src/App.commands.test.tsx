import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { App } from "./App";
import { DemoCollectionGateway } from "./demo-gateway";

vi.mock("./CodeEditor", () => ({ CodeEditor: ({ value, onChange, label, footer }: { value: string; onChange?: (value: string) => void; label: string; footer?: ReactNode }) => <><textarea aria-label={label} value={value} onChange={(event) => onChange?.(event.target.value)} />{footer}</> }));
vi.mock("@tanstack/react-virtual", () => ({ useVirtualizer: ({ count }: { count: number }) => ({ getTotalSize: () => count * 76, getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 76, size: 76 })) }) }));

async function runCommand(query: string) {
  fireEvent.keyDown(window, { key: "P", ctrlKey: true, shiftKey: true });
  const input = await screen.findByRole("combobox", { name: "Find a note or action" });
  expect(input).toHaveValue(">");
  fireEvent.change(input, { target: { value: `>${query}` } });
  fireEvent.keyDown(input, { key: "Enter" });
}

describe("workspace commands", () => {
  it("enters focus from commands, hides sidebars and properties, preserves layout, and persists until Escape", async () => {
    const user = userEvent.setup();
    render(<App gateway={new DemoCollectionGateway(4)} />);
    const body = await screen.findByRole("textbox", { name: "Note body" });
    await user.click(screen.getByRole("button", { name: "Note properties" }));
    await screen.findByRole("complementary", { name: "Note properties" });
    await runCommand("focus mode");
    expect(screen.queryByRole("region", { name: "Notes and files" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Note properties" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Note body" })).toBe(body);
    expect(JSON.parse(localStorage.getItem("mdbase-editor:preferences")!)).toMatchObject({ focusMode: true });
    // Escape belongs to an open dialog first, not focus mode.
    fireEvent.keyDown(window, { key: "P", ctrlKey: true });
    expect(screen.getByRole("combobox", { name: "Find a note or action" })).toHaveValue("");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Exit focus mode" })).toBeInTheDocument();
    fireEvent.keyDown(body, { key: "Escape" });
    expect(screen.getByRole("region", { name: "Notes and files" })).toBeInTheDocument();
    expect(await screen.findByRole("complementary", { name: "Note properties" })).toBeInTheDocument();
    fireEvent.keyDown(body, { key: "F", metaKey: true, shiftKey: true });
    expect(screen.getByRole("button", { name: "Exit focus mode" })).toBeInTheDocument();
  });

  it("pins notes in the list and quick open using the shared menu/command action", async () => {
    const user = userEvent.setup();
    render(<App gateway={new DemoCollectionGateway(4)} />);
    await screen.findByRole("textbox", { name: "Note body" });
    await runCommand("pin");
    expect(screen.getByText("Pinned")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "More note actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Unpin" }));
    expect(screen.queryByText("Pinned")).not.toBeInTheDocument();
    await runCommand("open settings");
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    await runCommand("switch theme");
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Color theme" })).toHaveTextContent("Light"));
    await runCommand("switch theme");
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Color theme" })).toHaveTextContent("Dark"));
  });

  it("finds mentions from the index without reads, links with a revision, and undoes without changing properties", async () => {
    const user = userEvent.setup();
    const gateway = new DemoCollectionGateway(4);
    const original = await gateway.read("Journal/garden-notes-2.md");
    const source = await gateway.update(original, { body: "# Garden notes 2\n\nI like The shape of useful tools. And the shape of useful tools." });
    const read = vi.spyOn(gateway, "read"), update = vi.spyOn(gateway, "update");
    localStorage.setItem("mdbase-editor:last-note", "Notes/the-shape-of-useful-tools.md");
    render(<App gateway={gateway} />);
    await screen.findByRole("textbox", { name: "Note body" });
    const disclosure = await screen.findByText("Unlinked mentions (1)");
    expect(disclosure.closest("details")).not.toHaveAttribute("open");
    await user.click(disclosure);
    expect(read).toHaveBeenCalledTimes(1);
    const link = screen.getByRole("button", { name: "Link mention in Garden notes 2" });
    await user.click(link);
    const undo = await screen.findByRole("button", { name: "Undo" });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ path: source.path, revision: source.revision }), expect.objectContaining({ body: expect.stringContaining("[[Notes/the-shape-of-useful-tools|The shape of useful tools]]") }));
    const linked = await gateway.read(source.path);
    expect(linked.frontmatter).toEqual(source.frontmatter);
    expect(linked.body).toContain("And the shape of useful tools.");
    await user.click(undo);
    await screen.findByText("Restored unlinked mention.");
    expect((await gateway.read(source.path)).body).toBe(source.body);
    expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("The shape of useful tools");
  });

  it("refuses a stale indexed occurrence and reports a remote revision conflict without overwriting", async () => {
    const user = userEvent.setup();
    const gateway = new DemoCollectionGateway(3);
    const original = await gateway.read("Journal/garden-notes-2.md");
    const source = await gateway.update(original, { body: "# Garden notes 2\n\nThe shape of useful tools." });
    localStorage.setItem("mdbase-editor:last-note", "Notes/the-shape-of-useful-tools.md");
    render(<App gateway={gateway} />);
    await screen.findByRole("textbox", { name: "Note body" });
    await user.click(await screen.findByText("Unlinked mentions (1)"));
    // The indexed text is older than the document fetched for the Link action.
    await gateway.update(source, { body: "# Garden notes 2\n\nA newer text: The shape of useful tools." });
    await user.click(screen.getByRole("button", { name: "Link mention in Garden notes 2" }));
    await screen.findByText(/Couldn’t link that mention.*That note changed/);
    expect((await gateway.read(source.path)).body).toContain("A newer text:");
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("rejects an intervening remote revision instead of overwriting the source", async () => {
    const user = userEvent.setup();
    const gateway = new DemoCollectionGateway(3);
    const original = await gateway.read("Journal/garden-notes-2.md");
    const source = await gateway.update(original, { body: "# Garden notes 2\n\nThe shape of useful tools." });
    const write = gateway.update.bind(gateway);
    localStorage.setItem("mdbase-editor:last-note", "Notes/the-shape-of-useful-tools.md");
    render(<App gateway={gateway} />);
    await screen.findByRole("textbox", { name: "Note body" });
    await user.click(await screen.findByText("Unlinked mentions (1)"));
    vi.spyOn(gateway, "update").mockImplementationOnce(async (base, change) => {
      await write(base, { body: `${base.body}\nA remote edit.` });
      return write(base, change);
    });
    await user.click(screen.getByRole("button", { name: "Link mention in Garden notes 2" }));
    await screen.findByText(/Couldn’t link that mention/);
    const current = await gateway.read(source.path);
    expect(current.body).toContain("A remote edit.");
    expect(current.body).not.toContain("[[Notes/");
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("does not undo over edits made in the source after linking", async () => {
    const user = userEvent.setup();
    const gateway = new DemoCollectionGateway(3);
    const original = await gateway.read("Journal/garden-notes-2.md");
    await gateway.update(original, { body: "# Garden notes 2\n\nThe shape of useful tools." });
    localStorage.setItem("mdbase-editor:last-note", "Notes/the-shape-of-useful-tools.md");
    render(<App gateway={gateway} />);
    await screen.findByRole("textbox", { name: "Note body" });
    await user.click(await screen.findByText("Unlinked mentions (1)"));
    await user.click(screen.getByRole("button", { name: "Link mention in Garden notes 2" }));
    await screen.findByRole("button", { name: "Undo" });
    await user.click(screen.getByRole("option", { name: /Garden notes 2/ }));
    const body = await screen.findByRole("textbox", { name: "Note body" });
    fireEvent.change(body, { target: { value: `${(body as HTMLTextAreaElement).value}\nA newer local edit.` } });
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByText(/Couldn’t undo that change.*That note changed after linking/);
    expect((await gateway.read(original.path)).body).toContain("A newer local edit.");
  });

  it("exposes selected-note commands through the same bulk actions and shared Undo", async () => {
    const user = userEvent.setup();
    const gateway = new DemoCollectionGateway(4);
    render(<App gateway={gateway} />);
    await screen.findByRole("textbox", { name: "Note body" });
    fireEvent.click(screen.getByRole("option", { name: /Garden notes 2/ }), { ctrlKey: true });
    expect(screen.getByRole("group", { name: "Selected notes" })).toHaveTextContent("2 selected");
    fireEvent.keyDown(window, { key: "P", ctrlKey: true, shiftKey: true });
    const dialog = screen.getByRole("dialog", { name: "Quick open" });
    for (const label of ["Move to…", "Delete", "Add tag", "Remove tag", "Clear selection"]) expect(within(dialog).getByRole("option", { name: new RegExp(`^${label}`) })).toBeInTheDocument();
    expect(within(dialog).queryByRole("option", { name: /^Set property/ })).not.toBeInTheDocument();
    const input = within(dialog).getByRole("combobox");
    fireEvent.change(input, { target: { value: ">add tag" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await user.type(await screen.findByRole("textbox", { name: "Tag" }), "command-test");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByRole("button", { name: "Undo" });
    for (const path of ["Notes/the-shape-of-useful-tools.md", "Journal/garden-notes-2.md"]) expect((await gateway.read(path)).frontmatter.tags).toContain("command-test");
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByText("Restored selected notes.");
    await runCommand("move selected");
    expect(await screen.findByRole("dialog", { name: "Move 2 notes" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await runCommand("clear selection");
    expect(screen.queryByRole("group", { name: "Selected notes" })).not.toBeInTheDocument();
  });

  it("creates in the active note's folder and uses registry labels for the note commands", async () => {
    render(<App gateway={new DemoCollectionGateway(3)} />);
    await screen.findByRole("textbox", { name: "Note body" });
    fireEvent.keyDown(window, { key: "P", ctrlKey: true, shiftKey: true });
    const dialog = screen.getByRole("dialog", { name: "Quick open" });
    for (const label of ["Rename", "Move to…", "Duplicate", "Copy link", "Copy path", "Delete", "Pin", "Note properties", "Document outline", "Switch theme", "Toggle Vim key bindings", "Open Types", "Open Settings", "Open Connect", "Switch collection"]) {
      expect(within(dialog).getByRole("option", { name: new RegExp(`^${label}`) })).toBeInTheDocument();
    }
    const input = within(dialog).getByRole("combobox");
    fireEvent.change(input, { target: { value: ">new note in current folder" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue(""));
    expect(screen.getByLabelText("Suggested path")).toHaveTextContent("Notes/");
  });
});
