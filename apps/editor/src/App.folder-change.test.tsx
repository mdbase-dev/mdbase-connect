import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { chooseOption } from "./test/select";
import { DemoCollectionGateway } from "./demo-gateway";
import type { MutationOperationOptions, NoteDocument } from "./model";

vi.mock("./CodeEditor", () => ({ CodeEditor: ({ value, onChange, label }: { value: string; onChange?: (value: string) => void; label: string }) => <textarea aria-label={label} value={value} onChange={(event) => onChange?.(event.target.value)} /> }));
vi.mock("@tanstack/react-virtual", () => ({ useVirtualizer: ({ count }: { count: number }) => ({ getTotalSize: () => count * 76, getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 76, size: 76 })) }) }));

async function renameFolder(user: ReturnType<typeof userEvent.setup>, folder: string, name: string) {
  const folders = await screen.findByRole("group", { name: "Folders" });
  const row = await within(folders).findByRole("button", { name: new RegExp(`^Show notes in ${folder},`) });
  row.focus(); fireEvent.keyDown(row, { key: "F2" });
  const dialog = screen.getByRole("dialog", { name: new RegExp(`Rename ‘${folder}’`) });
  await user.clear(within(dialog).getByRole("textbox", { name: "Folder name" }));
  await user.type(within(dialog).getByRole("textbox", { name: "Folder name" }), name);
  await user.click(within(dialog).getByRole("button", { name: "Review changes" }));
  return dialog;
}

describe("collection-wide folder changes", () => {
  it("F2 reviews note and reference counts once, renames with revisions and rewrites links", async () => {
    const user = userEvent.setup();
    const gateway = new DemoCollectionGateway(12);
    const rename = vi.spyOn(gateway, "rename"), preflight = vi.spyOn(gateway, "preflightRename");
    render(<App gateway={gateway} />);
    await screen.findByRole("textbox", { name: "Note title" });
    const dialog = await renameFolder(user, "Notes", "Writing notes");
    await waitFor(() => expect(dialog).toHaveAccessibleName("Rename ‘Notes’ and move 3 notes and update 1 link?"));
    expect(rename).not.toHaveBeenCalled(); expect(preflight).toHaveBeenCalledTimes(3);
    await user.click(within(dialog).getByRole("button", { name: "Rename folder" }));
    await waitFor(() => expect(dialog).toHaveTextContent("3 notes moved. Links were updated."));
    expect(rename).toHaveBeenCalledTimes(3);
    for (const call of rename.mock.calls) { expect(call[2]).toBeTruthy(); expect(call[3]).toBe(true); }
    expect((await gateway.read("Journal/garden-notes-2.md")).body).toContain("Writing notes/the-shape-of-useful-tools");
    expect(screen.getByTitle("Rename Markdown path")).toHaveTextContent("Writing notes/the-shape-of-useful-tools.md");
  });

  it("provides keyboard Move to and preserves subfolders", async () => {
    const user = userEvent.setup();
    const gateway = new DemoCollectionGateway(3);
    await gateway.create({ path: "Journal/2026/day.md", title: "Day", body: "", properties: {} });
    render(<App gateway={gateway} />);
    await screen.findByRole("textbox", { name: "Note title" });
    const row = screen.getByRole("button", { name: /^Show notes in Journal,/ });
    row.focus(); fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    await user.click(screen.getByRole("menuitem", { name: "Move to…" }));
    const dialog = screen.getByRole("dialog", { name: "Move ‘Journal’" });
    await chooseOption(user, within(dialog).getByRole("combobox", { name: "Destination folder" }), "Notes");
    await user.click(within(dialog).getByRole("button", { name: "Review changes" }));
    await waitFor(() => expect(dialog).toHaveAccessibleName("Move 2 notes?"));
    await user.click(within(dialog).getByRole("button", { name: "Move folder" }));
    await waitFor(() => expect(dialog).toHaveTextContent("2 notes moved."));
    expect((await gateway.read("Notes/Journal/2026/day.md")).path).toBe("Notes/Journal/2026/day.md");
  });

  it("reports partial failures, retaining successful moves without rolling them back", async () => {
    class FailingGateway extends DemoCollectionGateway {
      override async rename(from: string, to: string, revision: string, updateRefs = true, options: MutationOperationOptions = {}): Promise<NoteDocument> {
        if (from.includes("garden-notes")) throw new Error("Permission changed for this note.");
        return super.rename(from, to, revision, updateRefs, options);
      }
    }
    const user = userEvent.setup(), gateway = new FailingGateway(12);
    render(<App gateway={gateway} />);
    await screen.findByRole("textbox", { name: "Note title" });
    const dialog = await renameFolder(user, "Journal", "Daily");
    await within(dialog).findByRole("button", { name: "Rename folder" });
    await user.click(within(dialog).getByRole("button", { name: "Rename folder" }));
    await waitFor(() => expect(dialog).toHaveTextContent("2 notes moved. 1 note could not be confirmed as moved"));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Journal/garden-notes-2.md: Permission changed");
    expect((await gateway.read("Daily/questions-worth-keeping-7.md")).path).toBe("Daily/questions-worth-keeping-7.md");
    expect((await gateway.read("Journal/garden-notes-2.md")).path).toBe("Journal/garden-notes-2.md");
  });

  it("blocks attachment folders with an embed-safety explanation before writing", async () => {
    const user = userEvent.setup(), gateway = new DemoCollectionGateway(3), rename = vi.spyOn(gateway, "rename");
    render(<App gateway={gateway} />);
    await screen.findByRole("textbox", { name: "Note title" });
    const dialog = await renameFolder(user, "Assets", "Images");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("cannot yet preserve embedded file references");
    expect(rename).not.toHaveBeenCalled();
  });
});
