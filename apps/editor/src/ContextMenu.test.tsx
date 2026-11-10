import { act, fireEvent, render, screen, waitFor } from "./test/locale";
import { describe, expect, it, vi } from "vitest";
import { ContextMenu } from "./ContextMenu";

describe("ContextMenu", () => {
  it("uses the shared top-layer menu at the pointer and closes on outside press", () => {
    render(<ContextMenu label="Note actions" showTrigger={false} items={[
      { label: "Copy path", icon: null, onSelect: vi.fn() }
    ]}><button>Note row</button></ContextMenu>);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Note row" }), { clientX: 120, clientY: 160 });
    const menu = screen.getByRole("menu", { name: "Note actions" });
    expect(menu).toHaveAttribute("popover", "manual");
    expect(menu).toHaveClass("mdbase-overlay", "mdbase-menu");
    expect(menu).toHaveStyle({ left: "120px", top: "160px" });
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
  it("disables unavailable actions, skips them in keyboard navigation, and restores focus on Escape", async () => {
    const unavailable = vi.fn();
    render(<ContextMenu label="Note actions" showTrigger={false} items={[
      { label: "Rename", icon: null, disabled: true, onSelect: unavailable },
      { label: "Copy link", icon: null, onSelect: vi.fn() },
      { label: "Delete", icon: null, disabled: true, onSelect: unavailable },
      { label: "Copy path", icon: null, onSelect: vi.fn() }
    ]}><button>Note row</button></ContextMenu>);
    const row = screen.getByRole("button", { name: "Note row" });
    row.focus();
    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    const menu = screen.getByRole("menu", { name: "Note actions" });
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Copy link" })).toHaveFocus());
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Copy path" })).toHaveFocus();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(unavailable).not.toHaveBeenCalled();
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(row).toHaveFocus());
  });
  it("opens on a touch long-press without opening the row, and ignores scrolls and mouse holds", () => {
    vi.useFakeTimers();
    const open = vi.fn();
    render(<ContextMenu label="Note actions" showTrigger={false} items={[
      { label: "Copy path", icon: null, onSelect: vi.fn() }
    ]}><button onClick={open}>Note row</button></ContextMenu>);
    const row = screen.getByRole("button", { name: "Note row" });
    fireEvent.pointerDown(row, { pointerType: "mouse", clientX: 10, clientY: 10 });
    act(() => { vi.advanceTimersByTime(600); });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.pointerDown(row, { pointerType: "touch", clientX: 10, clientY: 10 });
    fireEvent.pointerMove(row, { pointerType: "touch", clientX: 10, clientY: 40 });
    act(() => { vi.advanceTimersByTime(600); });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.pointerDown(row, { pointerType: "touch", clientX: 30, clientY: 50 });
    act(() => { vi.advanceTimersByTime(600); });
    expect(screen.getByRole("menu", { name: "Note actions" })).toHaveStyle({ left: "30px", top: "50px" });
    fireEvent.pointerUp(row, { pointerType: "touch" });
    fireEvent.click(row);
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(row);
    expect(open).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
