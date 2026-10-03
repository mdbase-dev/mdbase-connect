import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContextMenu } from "./ContextMenu";

describe("ContextMenu", () => {
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
});
