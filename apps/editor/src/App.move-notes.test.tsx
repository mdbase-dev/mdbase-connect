import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { DemoCollectionGateway } from "./demo-gateway";

vi.mock("./CollectionRail", () => ({ CollectionRail: ({ onMoveNotes }: { onMoveNotes?: (paths: string[], folder: string) => void }) => <button onClick={() => onMoveNotes?.(["Notes/the-shape-of-useful-tools.md", "Journal/garden-notes-2.md"], "Archive")}>Drop notes</button> }));
vi.mock("./CodeEditor", () => ({ CodeEditor: ({ value, label }: { value: string; label: string }) => <textarea aria-label={label} value={value} readOnly /> }));
vi.mock("@tanstack/react-virtual", () => ({ useVirtualizer: ({ count }: { count: number }) => ({ getTotalSize: () => count * 76, getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 76, size: 76 })) }) }));

describe("Rail move command", () => {
  it("moves multiple records using fresh revisions after earlier link rewrites, and undoes all paths", async () => {
    const gateway = new DemoCollectionGateway(3);
    const rename = vi.spyOn(gateway, "rename");
    render(<App gateway={gateway} />);
    await screen.findByRole("textbox", { name: "Note body" });
    fireEvent.click(screen.getByRole("option", { name: /Garden notes 2/ }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Garden notes 2"));
    fireEvent.click(screen.getByRole("button", { name: "Drop notes" }));
    await screen.findByText(/Moved 2 notes/);
    expect(rename).toHaveBeenCalledTimes(2);
    expect(rename.mock.calls.every((call) => call[3] === true)).toBe(true);
    expect((await gateway.read("Archive/garden-notes-2.md")).body).toContain("Archive/the-shape-of-useful-tools");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(rename).toHaveBeenCalledTimes(4));
    await screen.findByText("Restored note paths.");
    expect((await gateway.read("Journal/garden-notes-2.md")).body).toContain("Notes/the-shape-of-useful-tools");
    expect(rename.mock.calls.every((call) => call[3] === true)).toBe(true);
  });

  it("keeps a successful partial move undoable when the next destination collides", async () => {
    const gateway = new DemoCollectionGateway(3);
    await gateway.create({ path: "Archive/garden-notes-2.md", title: "Existing", body: "Do not replace", properties: {} });
    render(<App gateway={gateway} />);
    await screen.findByRole("textbox", { name: "Note body" });
    fireEvent.click(screen.getByRole("button", { name: "Drop notes" }));
    await screen.findByText(/Moved 1 note/);
    expect(await screen.findByText(/already uses that path/i)).toBeInTheDocument();
    expect((await gateway.read("Archive/garden-notes-2.md")).body).toContain("Do not replace");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByText("Restored note paths.");
    expect(await gateway.read("Notes/the-shape-of-useful-tools.md")).toBeDefined();
  });
});
