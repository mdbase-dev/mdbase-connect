// @vitest-environment-options {"url": "https://editor.mdbase.dev/"}
import { act, fireEvent, render, screen, waitFor, within } from "./test/locale";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SdkEditorRoot } from "./SdkEditorRoot";
import { closeNativeFixtures, unsyncedFixture } from "./test/native-fixture";

vi.mock("./CodeEditor", () => ({
  CodeEditor: ({ header, value, onChange, label, readOnly, footer }: { header?: ReactNode; value: string; onChange?: (value: string) => void; label: string; readOnly?: boolean; footer?: ReactNode }) =>
    <>{header}<textarea aria-label={label} readOnly={readOnly} value={value} onChange={(event) => onChange?.(event.target.value)} />{footer}</>
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 76,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 76, size: 76 }))
  })
}));

afterEach(() => { closeNativeFixtures(); });

const SAVED_ONLY = "Saved only in this browser";

describe("work before connecting", () => {
  it("continues without connecting into the editor, saved only in this browser, and offers to connect once there is work", async () => {
    const h = await unsyncedFixture("signed_out", (replica) => replica.seed({ path: "draft.md", body: "# Draft\n\nFirst thoughts\n" }));
    const { container } = render(<SdkEditorRoot sdk={h.mdbase} />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue without connecting" }));
    await waitFor(() => expect(h.calls("openUnsynced")).toHaveLength(1));

    // The editor opens over the unsynced collection and never claims to be connected.
    const status = await screen.findByRole("status", { name: SAVED_ONLY }, { timeout: 10_000 });
    expect(status).toHaveTextContent(SAVED_ONLY);
    expect(screen.queryByRole("status", { name: "Collection connected" })).toBeNull();
    // Nothing saved yet: no prompt to connect.
    expect(container.querySelector(".mdbase-collections-unsynced")).toBeNull();

    // The editor opens into the note, as it does in any collection.
    const body = await screen.findByRole("textbox", { name: "Note body" });
    expect(body).toHaveValue("First thoughts\n");
    fireEvent.change(body, { target: { value: "First thoughts, revised\n" } });
    await waitFor(async () => expect((await h.unsynced.client.find({ path: "draft.md" }, { body: true }))?.body).toBe("# Draft\n\nFirst thoughts, revised\n"), { timeout: 10_000 });

    // The SDK marks the work once something is saved; the gate then shows one quiet line.
    act(() => h.markWork());
    const line = container.querySelector<HTMLElement>(".mdbase-collections-unsynced");
    if (!line) throw new Error("No saved-only line");
    expect(line).toHaveTextContent(SAVED_ONLY);
    fireEvent.click(within(line).getByRole("button", { name: "Connect to sync your work" }));
    await waitFor(() => expect(h.calls("authorize")).toHaveLength(1));
  }, 30_000);

  it("offers to bring the work in once a collection is open, and brings it in", async () => {
    const h = await unsyncedFixture("ready", (replica) => replica.seed({ path: "idea.md", body: "# Before connecting\n\nKept in the browser\n" }));
    act(() => h.markWork());
    render(<SdkEditorRoot sdk={h.mdbase} />);
    expect(await screen.findByText("You have work that isn't in Notes yet.", undefined, { timeout: 10_000 })).toBeInTheDocument();
    expect(await screen.findByRole("status", { name: "Collection connected" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Bring it in" }));
    await waitFor(() => expect(h.calls("transferUnsynced")).toHaveLength(1));
    // The record keeps its path in the open collection, and the editor lists it.
    await waitFor(async () => expect(await h.notes.client.find({ path: "idea.md" })).not.toBeNull());
    expect(await screen.findByText("Your work is now in Notes.")).toBeInTheDocument();
    expect(await screen.findByText("idea", undefined, { timeout: 10_000 })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Bring it in" })).toBeNull());
  });

  it("discards the work only after the person confirms", async () => {
    const h = await unsyncedFixture("ready", (replica) => replica.seed({ path: "scratch.md", body: "Scratch\n" }));
    act(() => h.markWork());
    render(<SdkEditorRoot sdk={h.mdbase} />);
    fireEvent.click(await screen.findByRole("button", { name: "Discard…" }, { timeout: 10_000 }));
    expect(h.calls("discardUnsynced")).toHaveLength(0);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(h.calls("discardUnsynced")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText("You have work that isn't in Notes yet.")).toBeNull());
  });
});
